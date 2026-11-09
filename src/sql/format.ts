import { AppError } from "../util/errors.js";

export interface MysqlTsv {
  columns: string[];
  rows: Array<Record<string, string | null>>;
}

/**
 * Parsea la salida de `mysql --batch --raw`: cabecera y filas separadas por
 * tabuladores, con `\t`, `\n`, `\r`, `\0` y `\\` escapados.
 */
export function parseMysqlTsv(stdout: string): MysqlTsv {
  const text = stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { columns: [], rows: [] };

  const columns = lines[0].split("\t").map((column) => unescapeField(column));
  const rows: Array<Record<string, string | null>> = [];

  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    const row: Record<string, string | null> = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = normalizeValue(fields[index]);
    }
    rows.push(row);
  }

  return { columns, rows };
}

function normalizeValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw === "NULL") return null;
  return unescapeField(raw);
}

function unescapeField(value: string): string {
  if (!value.includes("\\")) return value;

  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\" || index + 1 >= value.length) {
      result += char;
      continue;
    }

    const escaped = value[index + 1];
    switch (escaped) {
      case "n":
        result += "\n";
        break;
      case "t":
        result += "\t";
        break;
      case "r":
        result += "\r";
        break;
      case "0":
        result += "\0";
        break;
      case "\\":
        result += "\\";
        break;
      default:
        // MySQL conserva el carácter tras la barra en escapes desconocidos.
        result += escaped;
        break;
    }
    index += 1;
  }
  return result;
}

/**
 * Filtra valores con semántica SQL LIKE: `%` comodín de cualquier longitud,
 * `_` un carácter, `\` escapa el siguiente. Insensible a mayúsculas como
 * MySQL con la colación por defecto.
 */
export function filterByLike(values: string[], pattern?: string): string[] {
  if (pattern === undefined || pattern === "") return [...values];
  const regex = likeToRegExp(pattern);
  return values.filter((value) => regex.test(value));
}

function likeToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      source += escapeRegExp(pattern[index + 1]);
      index += 1;
      continue;
    }
    if (char === "%") {
      source += "[\\s\\S]*";
      continue;
    }
    if (char === "_") {
      source += "[\\s\\S]";
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64");
}

export function decodeCursor(cursor?: string): number {
  if (cursor === undefined || cursor === "") return 0;

  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed &&
      typeof parsed === "object" &&
      "o" in parsed &&
      typeof (parsed as { o?: unknown }).o === "number" &&
      Number.isInteger((parsed as { o: number }).o) &&
      (parsed as { o: number }).o >= 0
    ) {
      return (parsed as { o: number }).o;
    }
  } catch {
    // Se traduce a error estable más abajo.
  }

  throw new AppError("SQL_CURSOR_INVALID", "El cursor de paginación no es válido", {
    hint: "Usa el `nextCursor` devuelto por la llamada anterior."
  });
}

export function paginate<T>(
  items: T[],
  limit: number,
  cursor?: string
): { items: T[]; nextCursor: string | null; truncated: boolean } {
  const safeLimit = Math.max(1, Math.floor(limit));
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + safeLimit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;

  return {
    items: page,
    nextCursor,
    truncated: nextCursor !== null
  };
}
