import { describe, expect, it } from "vitest";
import { LocalDatabaseSchema, ServerSchema } from "./schema.js";

const baseServer = {
  name: "test",
  url: "https://plesk.example.com:8443",
  auth: { mode: "apiKey", apiKey: "secret" }
} as const;

describe("ServerSchema.timeoutMs", () => {
  it("disables the timeout when the field is not set", () => {
    const result = ServerSchema.parse(baseServer);
    expect(result.timeoutMs).toBeNull();
  });

  it("accepts null explicitly", () => {
    const result = ServerSchema.parse({ ...baseServer, timeoutMs: null });
    expect(result.timeoutMs).toBeNull();
  });

  it("keeps a positive timeout", () => {
    const result = ServerSchema.parse({ ...baseServer, timeoutMs: 5_000 });
    expect(result.timeoutMs).toBe(5_000);
  });

  it("rejects non-positive values", () => {
    expect(ServerSchema.safeParse({ ...baseServer, timeoutMs: 0 }).success).toBe(false);
    expect(ServerSchema.safeParse({ ...baseServer, timeoutMs: -1 }).success).toBe(false);
  });
});

describe("ServerSchema DB", () => {
  it("accepts dbUser and dbPass together", () => {
    const result = ServerSchema.safeParse({
      ...baseServer,
      dbUser: "db_admin",
      dbPass: "secret"
    });
    expect(result.success).toBe(true);
  });

  it("rejects dbUser without dbPass", () => {
    expect(
      ServerSchema.safeParse({ ...baseServer, dbUser: "db_admin" }).success
    ).toBe(false);
  });

  it("rejects dbPass without dbUser", () => {
    expect(
      ServerSchema.safeParse({ ...baseServer, dbPass: "secret" }).success
    ).toBe(false);
  });

  it("no longer accepts domain on the server", () => {
    const result = ServerSchema.parse({ ...baseServer, domain: "example.com" });
    expect("domain" in result).toBe(false);
  });
});

describe("LocalDatabaseSchema", () => {
  it("applies the default port and ssl", () => {
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
