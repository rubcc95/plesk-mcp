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
  .describe("Nombre de un servidor Plesk del array `servers`");

const pcField = z
  .string()
  .min(1)
  .optional()
  .describe("Nombre de una base de datos local del array `localDatabases`");

const maxRowsField = z
  .number()
  .int()
  .min(1)
  .max(10000)
  .optional()
  .describe("Máximo de filas devueltas por consulta (por defecto 1000, máx. 10000)");

const timeoutField = z
  .number()
  .int()
  .min(1)
  .max(300000)
  .optional()
  .describe("Timeout de ejecución en milisegundos (por defecto 30000, máx. 300000)");

const limitField = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe("Máximo de bases de datos por página (por defecto 100, máx. 500)");

const cursorField = z
  .string()
  .optional()
  .describe("Cursor de paginación devuelto en `nextCursor`");

const objectTypeField = z
  .enum(["schema", "table", "view", "column", "index", "procedure", "function"])
  .describe("Tipo de objeto a buscar");

const detailLevelField = z
  .enum(["names", "summary", "full"])
  .optional()
  .describe(
    "Nivel de detalle: names (solo nombre), summary (datos resumidos, por defecto) o full (fila completa)"
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
 * Cada tool SQL solo acepta su tipo de sentencia. El split existe para que el
 * cliente pueda dar permisos distintos a lectura y escritura (por ejemplo,
 * Plan deniega `execute_sql_write` y Build la pregunta).
 */
function assertVerdict(classified: ClassifiedSql, expected: ExpectedVerdict): void {
  const matches =
    expected === "read" ? classified.verdict === "read" : classified.verdict !== "read";
  if (matches) return;

  const tool = expected === "read" ? "execute_sql" : "execute_sql_write";
  const other = expected === "read" ? "execute_sql_write" : "execute_sql";
  throw new AppError(
    "SQL_TOOL_MISMATCH",
    `"${tool}" no admite una sentencia con veredicto "${classified.verdict}"`,
    { hint: `Usa "${other}" para esta sentencia.` }
  );
}

/** Cuerpo compartido por `execute_sql` y `execute_sql_write`. */
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
      title: "Consultar SQL (solo lectura)",
      description:
        "Ejecuta SQL de solo lectura en un servidor Plesk (`server`) o en una base local (`pc`): SELECT, SHOW, DESCRIBE y EXPLAIN. Si la sentencia escribe, devuelve `SQL_TOOL_MISMATCH`; para esas usa `execute_sql_write`. Devuelve las filas y trunca a `max_rows`.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        database: z.string().min(1).describe("Base de datos sobre la que ejecutar"),
        sql: z.string().min(1).describe("Sentencia SQL de lectura"),
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
          ? `servidor "${String(args.server)}"`
          : `pc "${String(args.pc ?? "")}"`;
        return `Escribir SQL en ${target}, base de datos ${String(
          args.database ?? "?"
        )}`;
      }
    },
    {
      title: "Ejecutar SQL (escritura)",
      description:
        "Ejecuta SQL que modifica datos o estructura en un servidor Plesk (`server`) o en una base local (`pc`): INSERT, UPDATE, DELETE, DDL y sentencias administrativas. Si la sentencia es de lectura, devuelve `SQL_TOOL_MISMATCH`; para consultar usa `execute_sql`.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        database: z.string().min(1).describe("Base de datos sobre la que ejecutar"),
        sql: z.string().min(1).describe("Sentencia SQL de escritura o DDL"),
        timeout_ms: timeoutField
      }
    },
    async (args) => executeSql(ctx, args, "write")
  );

  registrar.registerTool(
    "list_databases",
    readPolicy,
    {
      title: "Listar bases de datos",
      description:
        "Lista las bases de datos de un servidor Plesk (`server`) o de una base local (`pc`). Es una operación de solo lectura, con filtro LIKE (`pattern`) y paginación por cursor.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        pattern: z
          .string()
          .optional()
          .describe("Patrón SQL LIKE para filtrar nombres (por ejemplo `prefijo%`)"),
        include_system: z
          .boolean()
          .optional()
          .describe(
            "Incluye bases de datos del sistema (information_schema, mysql, performance_schema, sys)"
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
      title: "Buscar objetos de base de datos",
      description:
        "Busca esquemas, tablas, vistas, columnas, índices, procedimientos o funciones en un servidor Plesk (`server`) o en una base local (`pc`). Es una operación de solo lectura. `database` es obligatoria salvo para `object_type=schema`; `table` es obligatoria para columnas e índices.",
      inputSchema: {
        server: serverField,
        pc: pcField,
        database: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Base de datos a inspeccionar (obligatoria salvo para object_type=schema)"
          ),
        object_type: objectTypeField,
        pattern: z
          .string()
          .optional()
          .describe("Patrón SQL LIKE para el nombre del objeto (por defecto `%`)"),
        table: z
          .string()
          .min(1)
          .optional()
          .describe("Tabla para buscar columnas o índices"),
        detail_level: detailLevelField,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Máximo de objetos devueltos (por defecto 100, máx. 1000)")
      }
    },
    async (args) =>
      runTool(async () => {
        if (args.object_type !== "schema" && !args.database) {
          throw new AppError(
            "SQL_DATABASE_REQUIRED",
            "`database` es obligatoria para este tipo de objeto",
            { hint: "Solo `object_type=schema` puede omitir `database`." }
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
