import { AppError } from "../util/errors.js";

export interface EnvEntry {
  key: string;
  value: string;
  line: number;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses a `.env` file without exposing its contents.
 * Supports `KEY=value`, `#` comments, `export KEY=value` and single or double quotes.
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const seen = new Map<string, number>();
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const body = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const separator = body.indexOf("=");
    if (separator === -1) throw invalidLine(line);

    const key = body.slice(0, separator).trim();
    if (!KEY_RE.test(key)) throw invalidLine(line);

    const value = parseValue(body.slice(separator + 1).trim(), line);

    const previousLine = seen.get(key);
    if (previousLine !== undefined) {
      throw new AppError(
        "ENV_FILE_DUPLICATE_KEY",
        `Line ${line} repeats a variable already defined on line ${previousLine}`,
        { hint: "Each variable must appear only once in the file." }
      );
    }

    seen.set(key, line);
    entries.push({ key, value, line });
  }

  if (entries.length === 0) {
    throw new AppError(
      "ENV_FILE_EMPTY",
      "The .env file does not contain any environment variables",
      { hint: "Expected format: KEY=value" }
    );
  }

  return entries;
}

function parseValue(raw: string, line: number): string {
  if (raw.startsWith('"')) return parseDoubleQuoted(raw, line);

  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    if (end === -1) throw invalidLine(line);
    assertOnlyCommentAfter(raw.slice(end + 1), line);
    return raw.slice(1, end);
  }

  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
}

function parseDoubleQuoted(raw: string, line: number): string {
  let value = "";

  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index] as string;

    if (char === "\\") {
      index += 1;
      const escaped = raw[index];
      if (escaped === undefined) throw invalidLine(line);
      value +=
        escaped === "n"
          ? "\n"
          : escaped === "r"
            ? "\r"
            : escaped === "t"
              ? "\t"
              : escaped;
      continue;
    }

    if (char === '"') {
      assertOnlyCommentAfter(raw.slice(index + 1), line);
      return value;
    }

    value += char;
  }

  throw invalidLine(line);
}

function assertOnlyCommentAfter(rest: string, line: number): void {
  const trimmed = rest.trim();
  if (trimmed && !trimmed.startsWith("#")) throw invalidLine(line);
}

function invalidLine(line: number): AppError {
  return new AppError(
    "ENV_FILE_INVALID",
    `Line ${line} of the .env file is not valid`,
    { hint: "Expected format: KEY=value. Comments start with #." }
  );
}
