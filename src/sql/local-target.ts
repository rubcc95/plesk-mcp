import {
  createPool,
  type Pool
} from "mysql2/promise";
import type { FieldPacket, ResultSetHeader } from "mysql2";
import type { LocalDatabaseConfig } from "../config/schema.js";
import { AppError } from "../util/errors.js";
import { filterByLike, paginate } from "./format.js";
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

const META_DATABASE = "information_schema";
const IDLE_MS = 10 * 60_000;
const MAX_POOLS = 20;

interface PoolEntry {
  pool: Pool;
  lastUsed: number;
}

const pools = new Map<string, PoolEntry>();

export class LocalSqlTarget implements SqlTarget {
  readonly kind = "pc" as const;
  readonly name: string;

  constructor(private readonly config: LocalDatabaseConfig) {
    this.name = config.name;
  }

  async execute(
    database: string,
    sql: string,
    options: { maxRows: number; timeoutMs: number }
  ): Promise<SqlExecutionResult> {
    const pool = await this.getPool(this.config, database);

    let rows: unknown;
    let fields: unknown;
    try {
      [rows, fields] = (await pool.query({
        sql,
        timeout: options.timeoutMs
      })) as unknown as [unknown, unknown];
    } catch (error) {
      throw new AppError(
        "SQL_EXEC_FAILED",
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }

    return normalizeResult(rows, fields, options.maxRows);
  }

  async listDatabases(options: {
    pattern?: string;
    includeSystem: boolean;
    limit: number;
    cursor?: string;
  }): Promise<SqlDatabaseList> {
    const pool = await this.getPool(this.config, META_DATABASE);
    const [rows] = await pool.query("SHOW DATABASES");

    const values = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const values = Object.values(row as Record<string, unknown>);
        return typeof values[0] === "string" ? values[0] : null;
      })
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
    const pool = await this.getPool(
      this.config,
      options.database ?? META_DATABASE
    );

    const [rows] = await pool.query(sql);
    const parsed = (Array.isArray(rows) ? rows : []).map((row) =>
      normalizeRow(row as Record<string, unknown>)
    );
    const objects = rowsToObjects(parsed, options);
    const truncated = parsed.length > limit;

    return {
      objects: truncated ? objects.slice(0, limit) : objects,
      truncated
    };
  }

  private async getPool(
    config: LocalDatabaseConfig,
    database: string
  ): Promise<Pool> {
    const key = `${config.name}|${database || META_DATABASE}`;
    const now = Date.now();

    await prunePools(now);

    const existing = pools.get(key);
    if (existing) {
      existing.lastUsed = now;
      return existing.pool;
    }

    if (pools.size >= MAX_POOLS) {
      await evictOldest();
    }

    const pool = createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: database || META_DATABASE,
      ssl: config.ssl ? {} : undefined,
      multipleStatements: true,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 4
    });

    pools.set(key, { pool, lastUsed: now });
    return pool;
  }
}

async function prunePools(now: number): Promise<void> {
  for (const [key, entry] of pools) {
    if (now - entry.lastUsed <= IDLE_MS) continue;
    pools.delete(key);
    await entry.pool.end().catch(() => undefined);
  }
}

async function evictOldest(): Promise<void> {
  let oldestKey: string | null = null;
  let oldestDate = Number.POSITIVE_INFINITY;

  for (const [key, entry] of pools) {
    if (entry.lastUsed < oldestDate) {
      oldestDate = entry.lastUsed;
      oldestKey = key;
    }
  }

  if (oldestKey === null) return;
  const entry = pools.get(oldestKey);
  pools.delete(oldestKey);
  if (entry) await entry.pool.end().catch(() => undefined);
}

function normalizeResult(
  rows: unknown,
  fields: unknown,
  maxRows: number
): SqlExecutionResult {
  if (isResultSetHeader(rows)) {
    return {
      results: [headerResult(rows)],
      truncated: false
    };
  }

  if (Array.isArray(rows)) {
    if (rows.length > 0 && (Array.isArray(rows[0]) || isResultSetHeader(rows[0]))) {
      const fieldSets = Array.isArray(fields) ? fields : [];
      const results = rows.map((item, index) =>
        Array.isArray(item)
          ? rowsResult(
              item.map((row) => normalizeRow(row as Record<string, unknown>)),
              fieldSets[index],
              maxRows,
              index
            )
          : headerResult(item as ResultSetHeader, index)
      );
      return {
        results,
        truncated: results.some((result) => result.truncated === true)
      };
    }

    const parsed = rows.map((row) =>
      normalizeRow(row as Record<string, unknown>)
    );
    return {
      results: [rowsResult(parsed, fields, maxRows)],
      truncated: parsed.length > maxRows
    };
  }

  // Unexpected result (for example, a CALL that returns no rows).
  return {
    results: [{ type: "raw", raw: JSON.stringify(rows ?? null) }],
    truncated: false
  };
}

function rowsResult(
  rows: Array<Record<string, string | null>>,
  fields: unknown,
  maxRows: number,
  index?: number
): SqlQueryResult {
  const columns = fieldNames(fields, rows);
  const truncated = rows.length > maxRows;
  return {
    type: "rows",
    ...(index === undefined ? {} : { index }),
    columns,
    rows: truncated ? rows.slice(0, maxRows) : rows,
    truncated
  };
}

function headerResult(
  header: ResultSetHeader,
  index?: number
): SqlQueryResult {
  return {
    type: "write",
    ...(index === undefined ? {} : { index }),
    affectedRows: Number(header.affectedRows ?? 0),
    insertId: header.insertId,
    truncated: false
  };
}

function fieldNames(
  fields: unknown,
  rows: Array<Record<string, string | null>>
): string[] {
  if (Array.isArray(fields) && fields.length > 0) {
    return fields.map((field) =>
      field && typeof field === "object" && "name" in field
        ? String((field as FieldPacket).name)
        : ""
    );
  }
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

function isResultSetHeader(value: unknown): value is ResultSetHeader {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "affectedRows" in (value as Record<string, unknown>)
  );
}

function normalizeRow(row: Record<string, unknown>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = toCell(value);
  }
  return result;
}

function toCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Closes all pools (useful in tests and on process shutdown). */
export async function closeAllPools(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(
    entries.map((entry) => entry.pool.end().catch(() => undefined))
  );
}

process.on("exit", () => {
  for (const entry of pools.values()) {
    void entry.pool.end().catch(() => undefined);
  }
  pools.clear();
});
