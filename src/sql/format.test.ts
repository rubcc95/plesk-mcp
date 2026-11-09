import { describe, expect, it } from "vitest";
import { AppError } from "../util/errors.js";
import {
  decodeCursor,
  encodeCursor,
  filterByLike,
  paginate,
  parseMysqlTsv
} from "./format.js";

describe("parseMysqlTsv", () => {
  it("parsea cabecera, filas y escapes de mysql --batch --raw", () => {
    const stdout = [
      "id\tname\tnote",
      "1\tAlice\tline1\\nline2",
      "2\t\tNULL",
      "3\ta\\tb\tc\\\\d",
      ""
    ].join("\n");

    const parsed = parseMysqlTsv(stdout);

    expect(parsed.columns).toEqual(["id", "name", "note"]);
    expect(parsed.rows).toEqual([
      { id: "1", name: "Alice", note: "line1\nline2" },
      { id: "2", name: "", note: null },
      { id: "3", name: "a\tb", note: "c\\d" }
    ]);
  });

  it("devuelve vacío si no hay salida", () => {
    expect(parseMysqlTsv("")).toEqual({ columns: [], rows: [] });
  });

  it("tolera finales de línea CRLF", () => {
    const parsed = parseMysqlTsv("a\tb\r\n1\t2\r\n");
    expect(parsed.rows).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("filterByLike", () => {
  const values = [
    "users",
    "user_logs",
    "UserRoles",
    "accounts",
    "userXlogs"
  ];

  it("aplica % sin distinguir mayúsculas", () => {
    expect(filterByLike(values, "user%")).toEqual([
      "users",
      "user_logs",
      "UserRoles",
      "userXlogs"
    ]);
  });

  it("aplica _ como un carácter", () => {
    expect(filterByLike(values, "user_")).toEqual(["users"]);
    expect(filterByLike(["ab", "abc", "abcd"], "ab_")).toEqual(["abc"]);
    expect(filterByLike(["ab", "abc", "abcd"], "ab__")).toEqual(["abcd"]);
  });

  it("permite escapar comodines con backslash", () => {
    expect(filterByLike(values, "user\\_logs")).toEqual(["user_logs"]);
    expect(filterByLike(values, "user\\%logs")).toEqual([]);
  });

  it("devuelve todo sin patrón", () => {
    expect(filterByLike(values)).toEqual(values);
    expect(filterByLike(values, "")).toEqual(values);
  });
});

describe("cursores y paginación", () => {
  it("codifica y decodifica el offset", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor("")).toBe(0);
  });

  it("rechaza cursores inválidos", () => {
    try {
      decodeCursor("esto-no-es-un-cursor");
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("SQL_CURSOR_INVALID");
    }
  });

  it("pagina por cursor y marca truncamiento", () => {
    const items = [1, 2, 3, 4, 5];

    const first = paginate(items, 2);
    expect(first.items).toEqual([1, 2]);
    expect(first.truncated).toBe(true);

    const second = paginate(items, 2, first.nextCursor ?? undefined);
    expect(second.items).toEqual([3, 4]);
    expect(second.truncated).toBe(true);

    const third = paginate(items, 2, second.nextCursor ?? undefined);
    expect(third.items).toEqual([5]);
    expect(third.nextCursor).toBeNull();
    expect(third.truncated).toBe(false);
  });

  it("devuelve vacío si el cursor supera la lista", () => {
    const page = paginate([1, 2], 2, encodeCursor(10));
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
