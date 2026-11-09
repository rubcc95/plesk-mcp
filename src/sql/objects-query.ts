import { escape } from "mysql2";
import { AppError } from "../util/errors.js";
import type {
  SearchObjectsOptions,
  SqlObject,
  SqlObjectType
} from "./targets.js";

/**
 * Construye la consulta contra `information_schema` para `search_objects`.
 * Devuelve como máximo `limit + 1` filas para poder detectar truncamiento.
 */
export function buildSearchObjectsQuery(options: SearchObjectsOptions): string {
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit)));
  const fetch = limit + 1;
  const pattern = escape(options.pattern ?? "%");
  const detail = options.detailLevel;

  switch (options.objectType) {
    case "schema": {
      const columns = pickColumns(
        detail,
        "SCHEMA_NAME AS name",
        "SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS character_set, DEFAULT_COLLATION_NAME AS collation"
      );
      return `SELECT ${columns} FROM information_schema.schemata WHERE SCHEMA_NAME LIKE ${pattern} ORDER BY SCHEMA_NAME LIMIT ${fetch}`;
    }
    case "table":
    case "view": {
      const database = requireDatabase(options);
      const type = options.objectType === "table" ? "BASE TABLE" : "VIEW";
      const columns = pickColumns(
        detail,
        "TABLE_NAME AS name",
        "TABLE_NAME AS name, TABLE_TYPE AS table_type, ENGINE AS engine, TABLE_ROWS AS table_rows, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment"
      );
      return `SELECT ${columns} FROM information_schema.tables WHERE TABLE_SCHEMA = ${escape(database)} AND TABLE_TYPE = ${escape(type)} AND TABLE_NAME LIKE ${pattern} ORDER BY TABLE_NAME LIMIT ${fetch}`;
    }
    case "column": {
      const database = requireDatabase(options);
      const table = requireTable(options);
      const columns = pickColumns(
        detail,
        "COLUMN_NAME AS name",
        "COLUMN_NAME AS name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COLUMN_KEY AS column_key, EXTRA AS extra, CHARACTER_SET_NAME AS character_set, COLLATION_NAME AS collation"
      );
      return `SELECT ${columns} FROM information_schema.columns WHERE TABLE_SCHEMA = ${escape(database)} AND TABLE_NAME = ${escape(table)} AND COLUMN_NAME LIKE ${pattern} ORDER BY ORDINAL_POSITION LIMIT ${fetch}`;
    }
    case "index": {
      const database = requireDatabase(options);
      const table = requireTable(options);
      const where = `TABLE_SCHEMA = ${escape(database)} AND TABLE_NAME = ${escape(table)} AND INDEX_NAME LIKE ${pattern}`;

      if (detail === "full") {
        return `SELECT * FROM information_schema.statistics WHERE ${where} ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT ${fetch}`;
      }

      const columns =
        detail === "names"
          ? "DISTINCT INDEX_NAME AS name"
          : "INDEX_NAME AS name, TABLE_NAME AS table_name, NON_UNIQUE AS non_unique, INDEX_TYPE AS index_type, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns";
      const groupBy =
        detail === "names"
          ? ""
          : " GROUP BY INDEX_NAME, TABLE_NAME, NON_UNIQUE, INDEX_TYPE";

      return `SELECT ${columns} FROM information_schema.statistics WHERE ${where}${groupBy} ORDER BY INDEX_NAME LIMIT ${fetch}`;
    }
    case "procedure":
    case "function": {
      const database = requireDatabase(options);
      const type = options.objectType === "procedure" ? "PROCEDURE" : "FUNCTION";
      const columns = pickColumns(
        detail,
        "ROUTINE_NAME AS name",
        "ROUTINE_NAME AS name, ROUTINE_TYPE AS routine_type, DATA_TYPE AS data_type, DTD_IDENTIFIER AS dtd_identifier, SECURITY_TYPE AS security_type, CREATED AS created, LAST_ALTERED AS last_altered"
      );
      return `SELECT ${columns} FROM information_schema.routines WHERE ROUTINE_SCHEMA = ${escape(database)} AND ROUTINE_TYPE = ${escape(type)} AND ROUTINE_NAME LIKE ${pattern} ORDER BY ROUTINE_NAME LIMIT ${fetch}`;
    }
    default:
      throw new AppError(
        "SQL_OBJECT_TYPE_INVALID",
        `Tipo de objeto SQL no soportado: ${String(options.objectType)}`
      );
  }
}

/** Convierte filas de `information_schema` en objetos limpios para la tool. */
export function rowsToObjects(
  rows: Array<Record<string, string | null>>,
  options: SearchObjectsOptions
): SqlObject[] {
  return rows.map((row) => {
    if (options.detailLevel === "names") {
      return { name: row.name ?? null };
    }
    return { ...row };
  });
}

export function objectTypeSupported(value: string): value is SqlObjectType {
  return (
    value === "schema" ||
    value === "table" ||
    value === "view" ||
    value === "column" ||
    value === "index" ||
    value === "procedure" ||
    value === "function"
  );
}

function pickColumns(
  detail: SearchObjectsOptions["detailLevel"],
  names: string,
  summary: string
): string {
  if (detail === "full") return "*";
  if (detail === "names") return names;
  return summary;
}

function requireDatabase(options: SearchObjectsOptions): string {
  if (!options.database || options.database.trim() === "") {
    throw new AppError(
      "SQL_DATABASE_REQUIRED",
      `La búsqueda de ${options.objectType} requiere indicar \`database\``,
      { hint: "Solo `object_type=schema` puede omitir la base de datos." }
    );
  }
  return options.database;
}

function requireTable(options: SearchObjectsOptions): string {
  if (!options.table || options.table.trim() === "") {
    throw new AppError(
      "SQL_TABLE_REQUIRED",
      `La búsqueda de ${options.objectType} requiere indicar \`table\``,
      { hint: "Indica la tabla para columnas e índices." }
    );
  }
  return options.table;
}
