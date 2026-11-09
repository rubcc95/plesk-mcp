import { describe, expect, it } from "vitest";
import { AppError } from "../util/errors.js";
import { classifySql } from "./classifier.js";

describe("classifySql", () => {
  it("clasifica SELECT y WITH ... SELECT como lectura", () => {
    expect(classifySql("SELECT * FROM users").verdict).toBe("read");
    expect(
      classifySql("WITH recent AS (SELECT 1) SELECT * FROM recent").verdict
    ).toBe("read");
    expect(classifySql("SHOW DATABASES").verdict).toBe("read");
    expect(classifySql("DESCRIBE users").verdict).toBe("read");
    expect(classifySql("EXPLAIN SELECT 1").verdict).toBe("read");
  });

  it("clasifica INSERT/UPDATE/DELETE/REPLACE como escritura", () => {
    expect(classifySql("INSERT INTO t VALUES (1)").verdict).toBe("write");
    expect(classifySql("UPDATE t SET a = 1").verdict).toBe("write");
    expect(classifySql("DELETE FROM t").verdict).toBe("write");
    expect(classifySql("REPLACE INTO t VALUES (1)").verdict).toBe("write");
  });

  it("clasifica DDL", () => {
    expect(classifySql("CREATE TABLE t (a int)").verdict).toBe("ddl");
    expect(classifySql("ALTER TABLE t ADD b int").verdict).toBe("ddl");
    expect(classifySql("DROP TABLE t").verdict).toBe("ddl");
    expect(classifySql("TRUNCATE TABLE t").verdict).toBe("ddl");
  });

  it("devuelve el veredicto más restrictivo en multi-statement", () => {
    const mixed = classifySql("SELECT 1; UPDATE t SET a = 1");
    expect(mixed.verdict).toBe("write");
    expect(mixed.statements).toBe(2);

    const withDdl = classifySql("SELECT 1; DROP TABLE t");
    expect(withDdl.verdict).toBe("ddl");
    expect(withDdl.statements).toBe(2);

    const withAdmin = classifySql("UPDATE t SET a = 1; FLUSH PRIVILEGES");
    expect(withAdmin.verdict).toBe("admin");
    expect(withAdmin.statements).toBe(2);
  });

  it("no cuenta comentarios ni puntos y coma dentro de cadenas", () => {
    expect(classifySql("SELECT 1; -- fin").statements).toBe(1);
    expect(classifySql("SELECT ';' AS x").statements).toBe(1);
    expect(classifySql("SELECT `a;b` FROM t").statements).toBe(1);
  });

  it("eleva lecturas peligrosas mediante guardas léxicas", () => {
    expect(
      classifySql("SELECT * FROM t INTO OUTFILE '/tmp/x'").verdict
    ).toBe("admin");
    expect(classifySql("SELECT * FROM t FOR UPDATE").verdict).toBe("write");
    expect(classifySql("SELECT * FROM t LOCK IN SHARE MODE").verdict).toBe(
      "write"
    );
  });

  it("clasifica sentencias administrativas", () => {
    expect(classifySql("CALL do_something()").verdict).toBe("admin");
    expect(classifySql("SET @a = 1").verdict).toBe("admin");
    expect(classifySql("GRANT SELECT ON *.* TO u").verdict).toBe("admin");
    expect(classifySql("REVOKE SELECT ON *.* FROM u").verdict).toBe("admin");
    expect(classifySql("FLUSH PRIVILEGES").verdict).toBe("admin");
    expect(classifySql("KILL 42").verdict).toBe("admin");
    expect(classifySql("START TRANSACTION").verdict).toBe("admin");
  });

  it("trata los errores de parseo como unknown", () => {
    const result = classifySql("ESTO NO ES SQL");
    expect(result.verdict).toBe("unknown");
    expect(result.statements).toBe(1);
  });

  it("lanza SQL_EMPTY con SQL vacío", () => {
    for (const sql of ["", "   ", "\n\t "]) {
      try {
        classifySql(sql);
        throw new Error("debería haber lanzado");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("SQL_EMPTY");
      }
    }
  });
});
