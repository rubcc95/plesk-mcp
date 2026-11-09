import { materializeLocalDatabase } from "../config/load.js";
import type { ToolContext } from "../tools/context.js";
import { AppError } from "../util/errors.js";
import { LocalSqlTarget } from "./local-target.js";
import { PleskSqlTarget } from "./plesk-target.js";

export type SqlObjectType =
  | "schema"
  | "table"
  | "view"
  | "column"
  | "index"
  | "procedure"
  | "function";

export type SqlDetailLevel = "names" | "summary" | "full";

export interface SqlQueryResult {
  type: "rows" | "write" | "raw";
  index?: number;
  columns?: string[];
  rows?: Array<Record<string, string | null>>;
  affectedRows?: number;
  insertId?: number | string;
  raw?: string;
  truncated?: boolean;
}

export interface SqlExecutionResult {
  results: SqlQueryResult[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
}

export interface SqlDatabaseList {
  databases: string[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface SqlObject {
  name?: string | null;
  [key: string]: unknown;
}

export interface SqlObjectList {
  objects: SqlObject[];
  truncated: boolean;
}

export interface SearchObjectsOptions {
  database?: string;
  objectType: SqlObjectType;
  pattern?: string;
  table?: string;
  detailLevel: SqlDetailLevel;
  limit: number;
}

export interface SqlTarget {
  kind: "server" | "pc";
  name: string;
  execute(
    database: string,
    sql: string,
    options: { maxRows: number; timeoutMs: number }
  ): Promise<SqlExecutionResult>;
  listDatabases(options: {
    pattern?: string;
    includeSystem: boolean;
    limit: number;
    cursor?: string;
  }): Promise<SqlDatabaseList>;
  searchObjects(options: SearchObjectsOptions): Promise<SqlObjectList>;
}

export interface SqlTargetRef {
  kind: "server" | "pc";
  name: string;
}

const targetCache = new WeakMap<ToolContext, Map<string, SqlTarget>>();

/**
 * Validates the selector and checks that the target exists, without
 * materializing credentials or opening connections. Used before applying the policy.
 */
export function resolveSqlTargetRef(
  ctx: ToolContext,
  args: { server?: string; pc?: string }
): SqlTargetRef {
  const hasServer = args.server !== undefined && args.server !== null;
  const hasPc = args.pc !== undefined && args.pc !== null;

  if (!hasServer && !hasPc) {
    throw new AppError(
      "TARGET_REQUIRED",
      "You must specify `server` or `pc` to choose the SQL target",
      {
        hint: `Servers: ${ctx.loaded.servers.map((server) => server.name).join(", ") || "(none)"}. Local databases: ${
          ctx.loaded.localDatabases.map((database) => database.name).join(", ") ||
          "(none)"
        }.`
      }
    );
  }

  if (hasServer && hasPc) {
    throw new AppError(
      "TARGET_CONFLICT",
      "Specify only one of `server` or `pc`, not both",
      { hint: "`server` points to a Plesk server and `pc` to a local database." }
    );
  }

  if (hasServer) {
    const name = String(args.server);
    if (!ctx.loaded.servers.some((server) => server.name === name)) {
      throw new AppError("SERVER_NOT_FOUND", `Server "${name}" does not exist`, {
        hint: `Available servers: ${
          ctx.loaded.servers.map((server) => server.name).join(", ") || "(none)"
        }`
      });
    }
    return { kind: "server", name };
  }

  const name = String(args.pc);
  if (!ctx.loaded.localDatabases.some((database) => database.name === name)) {
    throw new AppError("PC_NOT_FOUND", `Local database "${name}" does not exist`, {
      hint: `Available local databases: ${
        ctx.loaded.localDatabases.map((database) => database.name).join(", ") ||
        "(none)"
      }`
    });
  }
  return { kind: "pc", name };
}

export function resolveSqlTarget(
  ctx: ToolContext,
  args: { server?: string; pc?: string }
): SqlTarget {
  const ref = resolveSqlTargetRef(ctx, args);
  const key = `${ref.kind}:${ref.name}`;
  const cache = getCache(ctx);

  const cached = cache.get(key);
  if (cached) return cached;

  if (ref.kind === "server") {
    const runtime = ctx.registry.resolve(ref.name);
    const target = new PleskSqlTarget(runtime);
    cache.set(key, target);
    return target;
  }

  const entry = ctx.loaded.localDatabases.find(
    (database) => database.name === ref.name
  );
  if (!entry) {
    throw new AppError("PC_NOT_FOUND", `Local database "${ref.name}" does not exist`);
  }

  const config = materializeLocalDatabase(entry);
  const target = new LocalSqlTarget(config);
  cache.set(key, target);
  return target;
}

function getCache(ctx: ToolContext): Map<string, SqlTarget> {
  const existing = targetCache.get(ctx);
  if (existing) return existing;
  const created = new Map<string, SqlTarget>();
  targetCache.set(ctx, created);
  return created;
}

