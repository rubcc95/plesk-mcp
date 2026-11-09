import { describe, expect, it } from "vitest";
import { AppError } from "../util/errors.js";
import { classifySql } from "./classifier.js";

describe("classifySql", () => {
  it("classifies SELECT and WITH ... SELECT as read", () => {
    expect(classifySql("SELECT * FROM users").verdict).toBe("read");
    expect(
      classifySql("WITH recent AS (SELECT 1) SELECT * FROM recent").verdict
    ).toBe("read");
    expect(classifySql("SHOW DATABASES").verdict).toBe("read");
    expect(classifySql("DESCRIBE users").verdict).toBe("read");
    expect(classifySql("EXPLAIN SELECT 1").verdict).toBe("read");
  });

  it("classifies INSERT/UPDATE/DELETE/REPLACE as write", () => {
    expect(classifySql("INSERT INTO t VALUES (1)").verdict).toBe("write");
    expect(classifySql("UPDATE t SET a = 1").verdict).toBe("write");
    expect(classifySql("DELETE FROM t").verdict).toBe("write");
    expect(classifySql("REPLACE INTO t VALUES (1)").verdict).toBe("write");
  });

  it("classifies DDL", () => {
    expect(classifySql("CREATE TABLE t (a int)").verdict).toBe("ddl");
    expect(classifySql("ALTER TABLE t ADD b int").verdict).toBe("ddl");
    expect(classifySql("DROP TABLE t").verdict).toBe("ddl");
    expect(classifySql("TRUNCATE TABLE t").verdict).toBe("ddl");
  });

  it("returns the most restrictive verdict in multi-statement input", () => {
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

  it("does not count comments or semicolons inside strings", () => {
    expect(classifySql("SELECT 1; -- end").statements).toBe(1);
    expect(classifySql("SELECT ';' AS x").statements).toBe(1);
    expect(classifySql("SELECT `a;b` FROM t").statements).toBe(1);
  });

  it("escalates dangerous reads via lexical guards", () => {
    expect(
      classifySql("SELECT * FROM t INTO OUTFILE '/tmp/x'").verdict
    ).toBe("admin");
    expect(classifySql("SELECT * FROM t FOR UPDATE").verdict).toBe("write");
    expect(classifySql("SELECT * FROM t LOCK IN SHARE MODE").verdict).toBe(
      "write"
    );
  });

  it("classifies administrative statements", () => {
    expect(classifySql("CALL do_something()").verdict).toBe("admin");
    expect(classifySql("SET @a = 1").verdict).toBe("admin");
    expect(classifySql("GRANT SELECT ON *.* TO u").verdict).toBe("admin");
    expect(classifySql("REVOKE SELECT ON *.* FROM u").verdict).toBe("admin");
    expect(classifySql("FLUSH PRIVILEGES").verdict).toBe("admin");
    expect(classifySql("KILL 42").verdict).toBe("admin");
    expect(classifySql("START TRANSACTION").verdict).toBe("admin");
  });

  it("treats parse errors as unknown", () => {
    const result = classifySql("THIS IS NOT SQL");
    expect(result.verdict).toBe("unknown");
    expect(result.statements).toBe(1);
  });

  it("throws SQL_EMPTY on empty SQL", () => {
    for (const sql of ["", "   ", "\n\t "]) {
      try {
        classifySql(sql);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("SQL_EMPTY");
      }
    }
  });
});
