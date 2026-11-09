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
  it("parses header, rows and escapes from mysql --batch --raw", () => {
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

  it("returns empty when there is no output", () => {
    expect(parseMysqlTsv("")).toEqual({ columns: [], rows: [] });
  });

  it("tolerates CRLF line endings", () => {
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

  it("applies % case-insensitively", () => {
    expect(filterByLike(values, "user%")).toEqual([
      "users",
      "user_logs",
      "UserRoles",
      "userXlogs"
    ]);
  });

  it("applies _ as a single character", () => {
    expect(filterByLike(values, "user_")).toEqual(["users"]);
    expect(filterByLike(["ab", "abc", "abcd"], "ab_")).toEqual(["abc"]);
    expect(filterByLike(["ab", "abc", "abcd"], "ab__")).toEqual(["abcd"]);
  });

  it("allows escaping wildcards with a backslash", () => {
    expect(filterByLike(values, "user\\_logs")).toEqual(["user_logs"]);
    expect(filterByLike(values, "user\\%logs")).toEqual([]);
  });

  it("returns everything without a pattern", () => {
    expect(filterByLike(values)).toEqual(values);
    expect(filterByLike(values, "")).toEqual(values);
  });
});

describe("cursors and pagination", () => {
  it("encodes and decodes the offset", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor("")).toBe(0);
  });

  it("rejects invalid cursors", () => {
    try {
      decodeCursor("this-is-not-a-cursor");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("SQL_CURSOR_INVALID");
    }
  });

  it("paginates by cursor and flags truncation", () => {
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

  it("returns empty if the cursor is past the end of the list", () => {
    const page = paginate([1, 2], 2, encodeCursor(10));
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
