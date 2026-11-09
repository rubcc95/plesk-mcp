import { z } from "zod";
import type { ToolContext } from "../tools/context.js";
import type { ToolPolicy, ToolRegistrar } from "../tools/policy.js";
import { AppError } from "../util/errors.js";
import { runTool } from "../util/result.js";
import { classifySql, type ClassifiedSql } from "./classifier.js";
import { resolveSqlTarget } from "./targets.js";

const serverField = z
  .string()
  .min(1)
  .optional()
  .describe("Name of a Plesk server from the `servers` array");

const pcField = z
  .string()
  .min(1)
  .optional()
  .describe("Name of a local database from the `localDatabases` array");

const maxRowsField = z
  .number()
  .int()
  .min(1)
  .max(10000)
  .optional()
  .describe("Maximum rows returned per query (default 1000, max 10000)");

const timeoutField = z
  .number()
  .int()
  .min(1)
  .max(300000)
  .optional()
  .describe("Execution timeout in milliseconds (default 30000, max 300000)");

const limitField = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe("Maximum databases per page (default 100, max 500)");

const cursorField = z
  .string()
  .optional()
  .describe("Pagination cursor returned in `nextCursor`");

const objectTypeField = z
  .enum(["schema", "table", "view", "column", "index", "procedure", "function"])
  .describe("Type of object to search for");

const detailLevelField = z
  .enum(["names", "summary", "full"])
  .optional()
  .describe(
    "Detail level: names (name only), summary (summarized data, default) or full (entire row)"
  );

const readPolicy: ToolPolicy = { safety: "read" };

interface ExecuteSqlArgs {
  server?: string;
  pc?: string;
  database: string;
  sql: string;
  max_rows?: number;
  timeout_ms?: number;
}

type ExpectedVerdict = "read" | "write";

/**
 * Each SQL tool only accepts its own statement type. The split exists so the
 * client can grant different permissions to read and write (for example,
 * Plan denies `execute_sql_write` and Build asks the question).
 */
function assertVerdict(classified: ClassifiedSql, expected: ExpectedVerdict): void {
  const matches =
    expected === "read" ? classified.verdict === "read" : classified.verdict !== "read";
  if (matches) return;

  const tool = expected === "read" ? "execute_sql" : "execute_sql_write";
  const other = expected === "read" ? "execute_sql_write" : "execute_sql";
  throw new AppError(
    "SQL_TOOL_MISMATCH",
    `"${tool}" does not accept a statement with verdict "${classified.verdict}"`,
    { hint: `Use "${other}" for this statement.` }
  );
}

/** Shared body for `execute_sql` and `execute_sql_write`. */
function executeSql(ctx: ToolContext, args: ExecuteSqlArgs, expected: ExpectedVerdict) {
  return runTool(async () => {
    const classified = classifySql(args.sql);
    assertVerdict(classified, expected);

    const target = resolveSqlTarget(ctx, args);
    const maxRows = clamp(args.max_rows ?? 1000, 1, 10000);
    const timeoutMs = clamp(args.timeout_ms ?? 30000, 1, 300000);
    const started = Date.now();

    const result = await target.execute(args.database, args.sql, {
      maxRows,
      timeoutMs
    });

    return {
      target: { kind: target.kind, name: target.name },
      database: args.database,
      verdict: classified.verdict,
      statements: classified.statements,
      results: result.results,
      durationMs: Date.now() - started
    };
  });
}

export function registerSqlTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "execute_sql",
    readPolicy,
    {
      title: "Query SQL (read-only)",
      description:
        "Runs read-only SQL on a Plesk server (`server`) or a local database (`pc`): SELECT, SHOW, DESCRIBE and EXPLAIN. If the statement writes, returns `SQL_TOOL_MISMATCH`; use `execute_sql_write` for those. Returns the rows and truncates to `max_rows`.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        database: z.string().min(1).describe("Database to run against"),
        sql: z.string().min(1).describe("Read SQL statement"),
        max_rows: maxRowsField,
        timeout_ms: timeoutField
      }
    },
    async (args) => executeSql(ctx, args, "read")
  );

  registrar.registerTool(
    "execute_sql_write",
    {
      safety: "write",
      destructive: true,
      summarize: (args) => {
        const target = args.server
          ? `server "${String(args.server)}"`
          : `pc "${String(args.pc ?? "")}"`;
        return `Write SQL on ${target}, database ${String(
          args.database ?? "?"
        )}`;
      }
    },
    {
      title: "Run SQL (write)",
      description:
        "Runs SQL that modifies data or structure on a Plesk server (`server`) or a local database (`pc`): INSERT, UPDATE, DELETE, DDL and administrative statements. If the statement is read-only, returns `SQL_TOOL_MISMATCH`; use `execute_sql` to query.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        database: z.string().min(1).describe("Database to run against"),
        sql: z.string().min(1).describe("Write or DDL SQL statement"),
        timeout_ms: timeoutField
      }
    },
    async (args) => executeSql(ctx, args, "write")
  );

  registrar.registerTool(
    "list_databases",
    readPolicy,
    {
      title: "List databases",
      description:
        "Lists the databases on a Plesk server (`server`) or a local database (`pc`). This is a read-only operation, with a LIKE filter (`pattern`) and cursor-based pagination.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        pattern: z
          .string()
          .optional()
          .describe("SQL LIKE pattern to filter names (for example `prefix%`)"),
        include_system: z
          .boolean()
          .optional()
          .describe(
            "Include system databases (information_schema, mysql, performance_schema, sys)"
          ),
        limit: limitField,
        cursor: cursorField
      }
    },
    async (args) =>
      runTool(async () => {
        const target = resolveSqlTarget(ctx, args);
        const list = await target.listDatabases({
          pattern: args.pattern,
          includeSystem: args.include_system === true,
          limit: clamp(args.limit ?? 100, 1, 500),
          cursor: args.cursor
        });

        return {
          target: { kind: target.kind, name: target.name },
          ...list
        };
      })
  );

  registrar.registerTool(
    "search_objects",
    readPolicy,
    {
      title: "Search database objects",
      description:
        "Searches schemas, tables, views, columns, indexes, procedures or functions on a Plesk server (`server`) or a local database (`pc`). This is a read-only operation. `database` is required except for `object_type=schema`; `table` is required for columns and indexes.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        database: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Database to inspect (required except for object_type=schema)"
          ),
        object_type: objectTypeField,
        pattern: z
          .string()
          .optional()
          .describe("SQL LIKE pattern for the object name (default `%`)"),
        table: z
          .string()
          .min(1)
          .optional()
          .describe("Table to search columns or indexes in"),
        detail_level: detailLevelField,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum objects returned (default 100, max 1000)")
      }
    },
    async (args) =>
      runTool(async () => {
        if (args.object_type !== "schema" && !args.database) {
          throw new AppError(
            "SQL_DATABASE_REQUIRED",
            "`database` is required for this object type",
            { hint: "Only `object_type=schema` can omit `database`." }
          );
        }

        const target = resolveSqlTarget(ctx, args);
        const result = await target.searchObjects({
          database: args.database,
          objectType: args.object_type,
          pattern: args.pattern,
          table: args.table,
          detailLevel: args.detail_level ?? "summary",
          limit: clamp(args.limit ?? 100, 1, 1000)
        });

        return {
          target: { kind: target.kind, name: target.name },
          database: args.database ?? null,
          ...result
        };
      })
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
