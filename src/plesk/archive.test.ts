import { describe, expect, it } from "vitest";
import { AppError } from "../util/errors.js";
import type { PleskClient, PleskDomain } from "./client.js";
import type { ExecAccess } from "./exec-access.js";
import {
  archiveEntries,
  buildTarArgs,
  findArchiveBase,
  findUnsafeEntries,
  isExecFallbackError,
  planArchive,
  resolveExecPaths,
  toRealPath,
  validateExcludePatterns,
  type ArchiveEntryInfo
} from "./archive.js";

describe("findArchiveBase", () => {
  it("uses the parent of a directory", () => {
    expect(findArchiveBase(["/httpdocs/assets"])).toBe("/httpdocs");
  });

  it("uses the parent of a file", () => {
    expect(findArchiveBase(["/httpdocs/index.php"])).toBe("/httpdocs");
  });

  it("computes the common ancestor", () => {
    expect(
      findArchiveBase(["/httpdocs/assets", "/httpdocs/index.php"])
    ).toBe("/httpdocs");
    expect(findArchiveBase(["/httpdocs", "/private/app"])).toBe("/");
  });
});

describe("archiveEntries", () => {
  it("keeps the directory name", () => {
    expect(archiveEntries(["/httpdocs/assets"], "/httpdocs")).toEqual(["assets"]);
  });

  it("mixes files and directories", () => {
    expect(
      archiveEntries(
        ["/httpdocs/assets", "/httpdocs/index.php"],
        "/httpdocs"
      )
    ).toEqual(["assets", "index.php"]);
  });

  it("removes entries contained in another", () => {
    expect(
      archiveEntries(["/httpdocs", "/httpdocs/assets"], "/")
    ).toEqual(["httpdocs"]);
  });
});

describe("validateExcludePatterns", () => {
  it("accepts normal patterns", () => {
    expect(validateExcludePatterns(["node_modules", "*.log", ".git"])).toEqual([
      "node_modules",
      "*.log",
      ".git"
    ]);
  });

  it("rejects spaces and shell metacharacters", () => {
    expect(() => validateExcludePatterns(["foo bar"])).toThrow();
    expect(() => validateExcludePatterns(["foo;rm"])).toThrow();
    expect(() => validateExcludePatterns(["--checkpoint-action=exec"])).toThrow();
  });
});

describe("buildTarArgs", () => {
  it("places options before the separator", () => {
    expect(
      buildTarArgs({
        tarBinary: "tar",
        archiveRealPath: "/home/domain/.tmp/a.tar.gz",
        baseRealPath: "/home/domain/httpdocs",
        entries: ["assets", "index.php"],
        excludes: ["node_modules", "*.log"]
      })
    ).toEqual([
      "tar",
      "-czf",
      "/home/domain/.tmp/a.tar.gz",
      "-C",
      "/home/domain/httpdocs",
      "--exclude=node_modules",
      "--exclude=*.log",
      "--",
      "assets",
      "index.php"
    ]);
  });
});

describe("toRealPath", () => {
  it("prefixes the subscription home", () => {
    expect(toRealPath("/var/www/vhosts/example", "/httpdocs")).toBe(
      "/var/www/vhosts/example/httpdocs"
    );
    expect(toRealPath("", "/httpdocs")).toBe("/httpdocs");
    expect(toRealPath("/var/www/vhosts/example", "/")).toBe(
      "/var/www/vhosts/example"
    );
  });
});

describe("resolveExecPaths", () => {
  it("uses HOME when available", async () => {
    const client = {
      exec: async (command: string[]) => {
        if (command[0] === "printenv") {
          return { code: 0, stdout: "/var/www/vhosts/example\n", stderr: "" };
        }
        if (command[0] === "test") {
          return { code: command[2] === "/var/www/vhosts/example/private" ? 0 : 1 };
        }
        return { code: 1 };
      }
    } as unknown as PleskClient;

    await expect(resolveExecPaths(client, "/private")).resolves.toEqual({
      home: "/var/www/vhosts/example",
      prefix: "/var/www/vhosts/example"
    });
  });

  it("falls back to pwd if HOME is not available", async () => {
    const client = {
      exec: async (command: string[]) => {
        if (command[0] === "printenv") {
          return { code: 1 };
        }
        if (command[0] === "pwd") {
          return { code: 0, stdout: "/var/www/vhosts/example\n", stderr: "" };
        }
        if (command[0] === "test") {
          return { code: command[2] === "/var/www/vhosts/example/httpdocs" ? 0 : 1 };
        }
        return { code: 1 };
      }
    } as unknown as PleskClient;

    await expect(resolveExecPaths(client, "/httpdocs")).resolves.toEqual({
      home: "/var/www/vhosts/example",
      prefix: "/var/www/vhosts/example"
    });
  });
});

describe("isExecFallbackError", () => {
  it("only flags exec/tar errors", () => {
    expect(isExecFallbackError(new AppError("EXEC_UNAVAILABLE", "x"))).toBe(true);
    expect(isExecFallbackError(new AppError("TAR_UNAVAILABLE", "x"))).toBe(true);
    expect(isExecFallbackError(new AppError("TAR_FAILED", "x"))).toBe(false);
    expect(isExecFallbackError(new Error("x"))).toBe(false);
  });
});

describe("planArchive with a foreign shell", () => {
  it("hosts the tar in the home of the executing domain", async () => {
    const target: PleskDomain = {
      id: 1,
      name: "main.com",
      hosting_type: "virtual",
      www_root: "/var/www/vhosts/main/httpdocs"
    };
    const executor: PleskDomain = {
      id: 2,
      name: "alt.com",
      hosting_type: "virtual",
      www_root: "/var/www/vhosts/alt/httpdocs"
    };
    const access: ExecAccess = {
      target,
      domain: executor,
      home: "/var/www/vhosts/main",
      foreign: true,
      exec: async (command) => ({
        code: 0,
        stdout: command[0] === "tar" ? "tar 1.0" : "",
        stderr: ""
      })
    };
    const client = {} as PleskClient;

    const plan = await planArchive({
      client,
      base: "/httpdocs",
      entries: ["index.php"],
      excludes: [],
      dryRun: true,
      access
    });

    expect(plan.foreign).toBe(true);
    expect(plan.execDomain.name).toBe("alt.com");
    expect(plan.home).toBe("/var/www/vhosts/main");
    expect(plan.realPath.startsWith("/var/www/vhosts/alt/.plesk-mcp-tmp/")).toBe(
      true
    );
    expect(plan.command).toContain("/var/www/vhosts/main/httpdocs");
  });
});

describe("findUnsafeEntries", () => {
  const entry = (
    entryPath: string,
    extra: Partial<ArchiveEntryInfo> = {}
  ): ArchiveEntryInfo => ({ path: entryPath, type: "File", ...extra });

  it("accepts normal paths", () => {
    expect(findUnsafeEntries([entry("assets/app.js"), entry("index.php")])).toEqual(
      []
    );
  });

  it("rejects traversal and absolute paths", () => {
    expect(findUnsafeEntries([entry("../secret")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("/etc/passwd")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("assets/../../secret")])).toHaveLength(1);
  });

  it("rejects invalid Windows names", () => {
    expect(findUnsafeEntries([entry("assets/a:b.txt")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("CON.txt")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("archive.")])).toHaveLength(1);
  });

  it("rejects links that escape the destination", () => {
    expect(
      findUnsafeEntries([
        entry("assets/link", { linkpath: "../../outside", type: "SymbolicLink" })
      ])
    ).toHaveLength(1);
    expect(
      findUnsafeEntries([
        entry("assets/link", { linkpath: "app.js", type: "SymbolicLink" })
      ])
    ).toEqual([]);
  });
});
