import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.js";

describe("parseEnvFile", () => {
  it("parses keys, values, comments and export", () => {
    const entries = parseEnvFile(
      [
        "\uFEFF# comment",
        "",
        "API_URL=https://example.com",
        "export TOKEN=abc123",
        "WITH_SPACES = value with spaces ",
        'DOUBLE="line\\nwith break"',
        "SINGLE='literal # not a comment'",
        "INLINE=value # comment",
        "EMPTY="
      ].join("\r\n")
    );

    expect(entries).toEqual([
      { key: "API_URL", value: "https://example.com", line: 3 },
      { key: "TOKEN", value: "abc123", line: 4 },
      { key: "WITH_SPACES", value: "value with spaces", line: 5 },
      { key: "DOUBLE", value: "line\nwith break", line: 6 },
      { key: "SINGLE", value: "literal # not a comment", line: 7 },
      { key: "INLINE", value: "value", line: 8 },
      { key: "EMPTY", value: "", line: 9 }
    ]);
  });

  it("fails without including the line contents", () => {
    expect(() => parseEnvFile("OK=1\nNOT_VALID\n")).toThrowError(
      /line 2/i
    );

    let error: unknown;
    try {
      parseEnvFile("OK=1\n1SECRET=super-secret\n");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("super-secret");
    expect(String(error)).not.toContain("1SECRET");
  });

  it("rejects duplicate keys", () => {
    expect(() => parseEnvFile("A=1\nB=2\nA=3\n")).toThrowError(/line 3/i);
  });

  it("rejects empty files", () => {
    expect(() => parseEnvFile("# only comments\n\n")).toThrowError(
      /does not contain/
    );
  });
});
