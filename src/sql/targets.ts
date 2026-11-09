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
 * Valida el selector y comprueba que el destino existe, sin materializar
 * credenciales ni abrir conexiones. Se usa antes de aplicar la política.
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
      "Debes indicar `server` o `pc` para elegir el destino SQL",
      {
        hint: `Servidores: ${ctx.loaded.servers.map((server) => server.name).join(", ") || "(ninguno)"}. Bases locales: ${
          ctx.loaded.localDatabases.map((database) => database.name).join(", ") ||
          "(ninguna)"
        }.`
      }
    );
  }

  if (hasServer && hasPc) {
    throw new AppError(
      "TARGET_CONFLICT",
      "Indica solo uno de `server` o `pc`, no ambos",
      { hint: "`server` apunta a un Plesk y `pc` a una base de datos local." }
    );
  }

  if (hasServer) {
    const name = String(args.server);
    if (!ctx.loaded.servers.some((server) => server.name === name)) {
      throw new AppError("SERVER_NOT_FOUND", `No existe el servidor "${name}"`, {
        hint: `Servidores disponibles: ${
          ctx.loaded.servers.map((server) => server.name).join(", ") || "(ninguno)"
        }`
      });
    }
    return { kind: "server", name };
  }

  const name = String(args.pc);
  if (!ctx.loaded.localDatabases.some((database) => database.name === name)) {
    throw new AppError("PC_NOT_FOUND", `No existe la base de datos local "${name}"`, {
      hint: `Bases locales disponibles: ${
        ctx.loaded.localDatabases.map((database) => database.name).join(", ") ||
        "(ninguna)"
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
    throw new AppError("PC_NOT_FOUND", `No existe la base de datos local "${ref.name}"`);
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

