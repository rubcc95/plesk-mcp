import { describe, expect, it } from "vitest";
import { isReadOnlyCall } from "./cli.js";

describe("isReadOnlyCall", () => {
  it("accepts read-only flags", () => {
    expect(isReadOnlyCall("domain", ["--info", "example.com"])).toBe(true);
    expect(isReadOnlyCall("php_handler", ["--list"])).toBe(true);
    expect(isReadOnlyCall("site", ["--version"])).toBe(true);
  });

  it("rejects commands that can modify the server", () => {
    expect(isReadOnlyCall("domain", ["--update", "example.com"])).toBe(false);
    expect(isReadOnlyCall("site", ["--del", "example.com"])).toBe(false);
    expect(isReadOnlyCall("domain", ["--info", "--remove"])).toBe(false);
    expect(isReadOnlyCall("ip", [])).toBe(false);
    expect(isReadOnlyCall("ip", ["10.0.0.1"])).toBe(false);
  });

  it("allows read-only Node extension calls only with read flags", () => {
    expect(isReadOnlyCall("extension", ["--exec", "nodejs", "--list"])).toBe(false);
    expect(isReadOnlyCall("extension", ["--list"])).toBe(true);
  });
});
