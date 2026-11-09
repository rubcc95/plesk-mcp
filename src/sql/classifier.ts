import sqlParser from "node-sql-parser";
import { AppError } from "../util/errors.js";

const { Parser } = sqlParser;

export type SqlVerdict = "read" | "write" | "ddl" | "admin" | "unknown";

export interface ClassifiedSql {
  verdict: SqlVerdict;
  statements: number;
  reasons: string[];
}

const parser = new Parser();

const SEVERITY: Record<SqlVerdict, number> = {
  read: 0,
  write: 1,
  ddl: 2,
  admin: 3,
  unknown: 4
};

interface Guard {
  pattern: RegExp;
  verdict: SqlVerdict;
  reason: string;
}

/**
 * Lexical guards applied in addition to the parser. They cover constructs that
 * the AST may classify as read but that write, or statements the MySQL
 * parser does not understand (FLUSH, KILL, REVOKE...).
 */
const GUARDS: Guard[] = [
  {
    pattern: /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,
    verdict: "admin",
    reason: "INTO OUTFILE/DUMPFILE writes files on the server"
  },
  {
    pattern: /\bLOAD_FILE\s*\(/i,
    verdict: "admin",
    reason: "LOAD_FILE() reads files from the server"
  },
  {
    pattern: /\bFOR\s+UPDATE\b/i,
    verdict: "write",
    reason: "FOR UPDATE locks rows"
  },
  {
    pattern: /\bLOCK\s+IN\s+SHARE\s+MODE\b/i,
    verdict: "write",
    reason: "LOCK IN SHARE MODE locks rows"
  },
  {
    pattern: /^\s*LOAD\s+DATA\b/i,
    verdict: "admin",
    reason: "LOAD DATA imports data"
  },
  {
    pattern: /^\s*CALL\b/i,
    verdict: "admin",
    reason: "CALL runs procedures"
  },
  {
    pattern: /^\s*SET\b/i,
    verdict: "admin",
    reason: "SET modifies variables or the session"
  },
  {
    pattern: /^\s*GRANT\b/i,
    verdict: "admin",
    reason: "GRANT modifies permissions"
  },
  {
    pattern: /^\s*REVOKE\b/i,
    verdict: "admin",
    reason: "REVOKE modifies permissions"
  },
  {
    pattern: /^\s*LOCK\s+TABLES\b/i,
    verdict: "admin",
    reason: "LOCK TABLES locks tables"
  },
  {
    pattern: /^\s*UNLOCK\s+TABLES\b/i,
    verdict: "admin",
    reason: "UNLOCK TABLES releases locks"
  },
  {
    pattern: /^\s*FLUSH\b/i,
    verdict: "admin",
    reason: "FLUSH modifies the server state"
  },
  {
    pattern: /^\s*KILL\b/i,
    verdict: "admin",
    reason: "KILL terminates connections or queries"
  },
  {
    pattern: /^\s*USE\b/i,
    verdict: "admin",
    reason: "USE changes the session database"
  },
  {
    pattern: /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i,
    verdict: "admin",
    reason: "Transaction statement"
  },
  {
    pattern: /^\s*(?:OPTIMIZE|ANALYZE|REPAIR|CHECK)\b/i,
    verdict: "admin",
    reason: "Table maintenance"
  },
  {
    pattern: /^\s*EXPLAIN\s+ANALYZE\b/i,
    verdict: "write",
    reason: "EXPLAIN ANALYZE runs the query"
  }
];

/**
 * Classifies a complete SQL script. Any unrecognized statement is treated as
 * `unknown` (fail-closed: the write policy applies).
 */
export function classifySql(sql: string): ClassifiedSql {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw new AppError("SQL_EMPTY", "The SQL is empty", {
      hint: "Provide at least one SQL statement."
    });
  }

  const reasons: string[] = [];
  let verdict: SqlVerdict = "read";

  const guardResult = classifyGuards(statements);
  reasons.push(...guardResult.reasons);

  let parsed: unknown[] | null = null;
  try {
    const ast = parser.astify(sql, { database: "MySQL" });
    parsed = Array.isArray(ast) ? ast : [ast];
  } catch (error) {
    parsed = null;
    reasons.push(
      `Could not parse the SQL: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (parsed === null) {
    // If the parser fails, the lexical guards can still rescue the statement
    // (FLUSH, KILL, REVOKE...). Without guards, it is treated as unknown.
    verdict = guardResult.verdict ?? "unknown";
  } else {
    for (const node of parsed) {
      const nodeResult = classifyNode(node);
      reasons.push(nodeResult.reason);
      verdict = maxVerdict(verdict, nodeResult.verdict);
    }
    if (guardResult.verdict) {
      verdict = maxVerdict(verdict, guardResult.verdict);
    }
  }

  return {
    verdict,
    statements: statements.length,
    reasons: unique(reasons)
  };
}

function classifyGuards(statements: string[]): {
  verdict: SqlVerdict | null;
  reasons: string[];
} {
  let verdict: SqlVerdict | null = null;
  const reasons: string[] = [];

  for (const statement of statements) {
    for (const guard of GUARDS) {
      if (!guard.pattern.test(statement)) continue;
      verdict = verdict === null ? guard.verdict : maxVerdict(verdict, guard.verdict);
      reasons.push(guard.reason);
    }
  }

  return { verdict, reasons };
}

function classifyNode(node: unknown): { verdict: SqlVerdict; reason: string } {
  const type =
    node && typeof node === "object" && "type" in node
      ? String((node as { type?: unknown }).type ?? "").toLowerCase()
      : "";

  switch (type) {
    case "select":
    case "show":
    case "desc":
    case "describe":
    case "explain":
      return { verdict: "read", reason: `Read statement (${type})` };
    case "insert":
    case "update":
    case "delete":
    case "replace":
      return { verdict: "write", reason: `Write statement (${type})` };
    case "create":
    case "alter":
    case "drop":
    case "truncate":
    case "rename":
      return { verdict: "ddl", reason: `DDL statement (${type})` };
    case "grant":
    case "revoke":
    case "set":
    case "call":
    case "use":
    case "lock":
    case "unlock":
    case "flush":
    case "kill":
    case "transaction":
    case "load_data":
    case "optimize":
    case "analyze":
    case "repair":
    case "check":
      return { verdict: "admin", reason: `Administrative statement (${type})` };
    default:
      return {
        verdict: "unknown",
        reason: type
          ? `Unrecognized statement (${type})`
          : "Unrecognized statement"
      };
  }
}

function maxVerdict(left: SqlVerdict, right: SqlVerdict): SqlVerdict {
  return SEVERITY[right] > SEVERITY[left] ? right : left;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Splits a script into statements without breaking strings, identifiers or
 * comments. Used to count statements and apply guards individually.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      current += char;
      index += 1;

      while (index < sql.length) {
        const inner = sql[index];
        current += inner;

        if (inner === "\\" && quote !== "`" && index + 1 < sql.length) {
          current += sql[index + 1];
          index += 2;
          continue;
        }

        index += 1;

        if (inner === quote) {
          // Doubled quote inside the string/identifier ('' or "" or ``).
          if (sql[index] === quote) {
            current += sql[index];
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (
      char === "-" &&
      next === "-" &&
      (sql[index + 2] === undefined || /\s/.test(sql[index + 2]))
    ) {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "#") {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      ) {
        index += 1;
      }
      if (index < sql.length) {
        index += 2;
      }
      continue;
    }

    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}
