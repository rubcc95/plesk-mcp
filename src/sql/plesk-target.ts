import type { PleskClient, PleskExecResult } from "../plesk/client.js";
import { shellQuote } from "../plesk/client.js";
import {
  findShellDomain,
  type ShellAccess
} from "../plesk/exec-access.js";
import type { ServerRuntime } from "../tools/context.js";
import { AppError } from "../util/errors.js";
import { redactText } from "../util/redact.js";
import { classifySql } from "./classifier.js";
import {
  filterByLike,
  paginate,
  parseMysqlTsv
} from "./format.js";
import {
  buildSearchObjectsQuery,
  rowsToObjects
} from "./objects-query.js";
import type {
  SearchObjectsOptions,
  SqlDatabaseList,
  SqlExecutionResult,
  SqlObjectList,
  SqlQueryResult,
  SqlTarget
} from "./targets.js";

const SYSTEM_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys"
]);

const LIST_TIMEOUT_MS = 30_000;

const shellCache = new WeakMap<PleskClient, Promise<ShellAccess>>();

export class PleskSqlTarget implements SqlTarget {
  readonly kind = "server" as const;
  readonly name: string;

  constructor(private readonly runtime: ServerRuntime) {
    this.name = runtime.name;
  }

  async execute(
    database: string,
    sql: string,
    options: { maxRows: number; timeoutMs: number }
  ): Promise<SqlExecutionResult> {
    const classified = classifySql(sql);
    const result = await this.run(database, sql, options.timeoutMs);
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = result.code;

    if (classified.statements > 1) {
      return {
        results: [{ type: "raw", raw: stdout, truncated: false }],
        stdout,
        stderr: stderr || undefined,
        exitCode,
        truncated: false
      };
    }

    if (classified.verdict !== "read") {
      const affectedRows = parseAffectedRows(stdout);
      return {
        results: [
          {
            type: "write",
            ...(affectedRows === null ? {} : { affectedRows }),
            raw: stdout || undefined,
            truncated: false
          }
        ],
        stdout,
        stderr: stderr || undefined,
        exitCode,
        truncated: false
      };
    }

    const parsed = parseMysqlTsv(stdout);
    return {
      results: [rowsResult(parsed.columns, parsed.rows, options.maxRows)],
      truncated: parsed.rows.length > options.maxRows
    };
  }

  async listDatabases(options: {
    pattern?: string;
    includeSystem: boolean;
    limit: number;
    cursor?: string;
  }): Promise<SqlDatabaseList> {
    const result = await this.run("", "SHOW DATABASES", LIST_TIMEOUT_MS);
    const parsed = parseMysqlTsv(result.stdout ?? "");
    const column = parsed.columns[0];
    const values = parsed.rows
      .map((row) => (column ? row[column] : Object.values(row)[0]))
      .filter((value): value is string => typeof value === "string")
      .filter(
        (value) => options.includeSystem || !SYSTEM_DATABASES.has(value.toLowerCase())
      );

    const filtered = filterByLike(values, options.pattern).sort((left, right) =>
      left.localeCompare(right)
    );

    const page = paginate(filtered, options.limit, options.cursor);
    return {
      databases: page.items,
      nextCursor: page.nextCursor,
      truncated: page.truncated
    };
  }

  async searchObjects(options: SearchObjectsOptions): Promise<SqlObjectList> {
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit)));
    const sql = buildSearchObjectsQuery({ ...options, limit });
    const result = await this.run(
      options.database ?? "",
      sql,
      LIST_TIMEOUT_MS
    );
    const parsed = parseMysqlTsv(result.stdout ?? "");
    const objects = rowsToObjects(parsed.rows, options);
    const truncated = parsed.rows.length > limit;

    return {
      objects: truncated ? objects.slice(0, limit) : objects,
      truncated
    };
  }

  private async run(
    database: string,
    sql: string,
    timeoutMs: number
  ): Promise<PleskExecResult> {
    const { dbUser, dbPass } = this.runtime.server;
    if (!dbUser || !dbPass) {
      throw new AppError(
        "DB_CREDENTIALS_MISSING",
        `El servidor "${this.name}" no tiene dbUser/dbPass configurados`,
        {
          hint: "Añade dbUser y dbPass al servidor en la configuración para poder ejecutar SQL."
        }
      );
    }

    const access = await getShell(this.runtime);
    const script = buildScript(dbUser, dbPass, database, sql);
    const result = await access.exec(["bash", "-lc", script], timeoutMs);

    if (result.code !== 0) {
      const detail =
        redactText(
          result.stderr || result.message || result.stdout || ""
        ).trim() || `mysql terminó con código ${result.code}`;
      throw new AppError("SQL_EXEC_FAILED", detail, {
        hint: `Plesk devolvió código ${result.code}`
      });
    }

    return result;
  }
}

async function getShell(runtime: ServerRuntime): Promise<ShellAccess> {
  const cached = shellCache.get(runtime.client);
  if (cached) return cached;

  const promise = findShellDomain(runtime.client, {
    require: async (access) => {
      const result = await access.exec(
        ["bash", "-lc", "command -v mysql || command -v mariadb"],
        8000
      );
      return result.code === 0 && (result.stdout ?? "").trim() !== "";
    }
  }).then((access) => {
    if (!access) {
      throw new AppError(
        "DB_EXEC_UNAVAILABLE",
        "Ningún dominio del servidor permite ejecutar mysql",
        {
          hint:
            "Activa SSH/shell en algún dominio y comprueba que mysql o mariadb estén instalados."
        }
      );
    }
    return access;
  });

  shellCache.set(runtime.client, promise);
  return promise;
}

function buildScript(
  user: string,
  password: string,
  database: string,
  sql: string
): string {
  const databaseArg = database ? ` -D ${shellQuote(database)}` : "";
  const command = [
    '"$MYSQL_BIN"',
    '--defaults-extra-file="$f"',
    databaseArg.trim(),
    "--batch",
    "--default-character-set=utf8mb4",
    "-e",
    shellQuote(sql)
  ]
    .filter((part) => part !== "")
    .join(" ");

  return [
    "set -e",
    "umask 077",
    "f=$(mktemp)",
    `trap 'rm -f "$f"' EXIT`,
    `printf '[client]\\nuser=%s\\npassword=%s\\n' ${shellQuote(user)} ${shellQuote(
      password
    )} > "$f"`,
    'MYSQL_BIN="$(command -v mysql || command -v mariadb)"',
    '[ -n "$MYSQL_BIN" ] || { echo "mysql/mariadb no encontrado" >&2; exit 127; }',
    command
  ].join("\n");
}

function parseAffectedRows(stdout: string): number | null {
  const match = /\b(\d+)\s+rows?\s+affected\b/i.exec(stdout);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function rowsResult(
  columns: string[],
  rows: Array<Record<string, string | null>>,
  maxRows: number
): SqlQueryResult {
  const truncated = rows.length > maxRows;
  return {
    type: "rows",
    columns,
    rows: truncated ? rows.slice(0, maxRows) : rows,
    truncated
  };
}
