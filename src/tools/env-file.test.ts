import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.js";

describe("parseEnvFile", () => {
  it("parsea claves, valores, comentarios y export", () => {
    const entries = parseEnvFile(
      [
        "\uFEFF# comentario",
        "",
        "API_URL=https://example.com",
        "export TOKEN=abc123",
        "WITH_SPACES = valor con espacios ",
        'DOUBLE="línea\\ncon salto"',
        "SINGLE='literal # no comentario'",
        "INLINE=valor # comentario",
        "EMPTY="
      ].join("\r\n")
    );

    expect(entries).toEqual([
      { key: "API_URL", value: "https://example.com", line: 3 },
      { key: "TOKEN", value: "abc123", line: 4 },
      { key: "WITH_SPACES", value: "valor con espacios", line: 5 },
      { key: "DOUBLE", value: "línea\ncon salto", line: 6 },
      { key: "SINGLE", value: "literal # no comentario", line: 7 },
      { key: "INLINE", value: "valor", line: 8 },
      { key: "EMPTY", value: "", line: 9 }
    ]);
  });

  it("falla sin incluir el contenido de la línea", () => {
    expect(() => parseEnvFile("OK=1\nNO_ES_VALIDO\n")).toThrowError(
      /línea 2/i
    );

    let error: unknown;
    try {
      parseEnvFile("OK=1\n1SECRET=super-secreto\n");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("super-secreto");
    expect(String(error)).not.toContain("1SECRET");
  });

  it("rechaza claves repetidas", () => {
    expect(() => parseEnvFile("A=1\nB=2\nA=3\n")).toThrowError(/línea 3/i);
  });

  it("rechaza archivos vacíos", () => {
    expect(() => parseEnvFile("# solo comentarios\n\n")).toThrowError(
      /no contiene variables/
    );
  });
});
