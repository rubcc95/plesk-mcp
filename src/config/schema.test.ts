import { describe, expect, it } from "vitest";
import { LocalDatabaseSchema, ServerSchema } from "./schema.js";

const baseServer = {
  name: "test",
  url: "https://plesk.example.com:8443",
  auth: { mode: "apiKey", apiKey: "secret" }
} as const;

describe("ServerSchema.timeoutMs", () => {
  it("desactiva el timeout cuando el campo no se define", () => {
    const result = ServerSchema.parse(baseServer);
    expect(result.timeoutMs).toBeNull();
  });

  it("acepta null de forma explícita", () => {
    const result = ServerSchema.parse({ ...baseServer, timeoutMs: null });
    expect(result.timeoutMs).toBeNull();
  });

  it("conserva un timeout positivo", () => {
    const result = ServerSchema.parse({ ...baseServer, timeoutMs: 5_000 });
    expect(result.timeoutMs).toBe(5_000);
  });

  it("rechaza valores no positivos", () => {
    expect(ServerSchema.safeParse({ ...baseServer, timeoutMs: 0 }).success).toBe(false);
    expect(ServerSchema.safeParse({ ...baseServer, timeoutMs: -1 }).success).toBe(false);
  });
});

describe("ServerSchema DB", () => {
  it("acepta dbUser y dbPass juntos", () => {
    const result = ServerSchema.safeParse({
      ...baseServer,
      dbUser: "db_admin",
      dbPass: "secret"
    });
    expect(result.success).toBe(true);
  });

  it("rechaza dbUser sin dbPass", () => {
    expect(
      ServerSchema.safeParse({ ...baseServer, dbUser: "db_admin" }).success
    ).toBe(false);
  });

  it("rechaza dbPass sin dbUser", () => {
    expect(
      ServerSchema.safeParse({ ...baseServer, dbPass: "secret" }).success
    ).toBe(false);
  });

  it("ya no acepta domain en el servidor", () => {
    const result = ServerSchema.parse({ ...baseServer, domain: "example.com" });
    expect("domain" in result).toBe(false);
  });
});

describe("LocalDatabaseSchema", () => {
  it("aplica puerto y ssl por defecto", () => {
    const result = LocalDatabaseSchema.parse({
      name: "ballena",
      host: "192.168.1.50",
      user: "root",
      password: "secret"
    });
    expect(result.port).toBe(3306);
    expect(result.ssl).toBe(false);
  });
});
