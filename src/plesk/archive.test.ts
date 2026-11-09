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
  it("usa el padre de un directorio", () => {
    expect(findArchiveBase(["/httpdocs/assets"])).toBe("/httpdocs");
  });

  it("usa el padre de un fichero", () => {
    expect(findArchiveBase(["/httpdocs/index.php"])).toBe("/httpdocs");
  });

  it("calcula el ancestro común", () => {
    expect(
      findArchiveBase(["/httpdocs/assets", "/httpdocs/index.php"])
    ).toBe("/httpdocs");
    expect(findArchiveBase(["/httpdocs", "/private/app"])).toBe("/");
  });
});

describe("archiveEntries", () => {
  it("conserva el nombre del directorio", () => {
    expect(archiveEntries(["/httpdocs/assets"], "/httpdocs")).toEqual(["assets"]);
  });

  it("mezcla ficheros y directorios", () => {
    expect(
      archiveEntries(
        ["/httpdocs/assets", "/httpdocs/index.php"],
        "/httpdocs"
      )
    ).toEqual(["assets", "index.php"]);
  });

  it("elimina entradas contenidas en otra", () => {
    expect(
      archiveEntries(["/httpdocs", "/httpdocs/assets"], "/")
    ).toEqual(["httpdocs"]);
  });
});

describe("validateExcludePatterns", () => {
  it("acepta patrones normales", () => {
    expect(validateExcludePatterns(["node_modules", "*.log", ".git"])).toEqual([
      "node_modules",
      "*.log",
      ".git"
    ]);
  });

  it("rechaza espacios y metacaracteres de shell", () => {
    expect(() => validateExcludePatterns(["foo bar"])).toThrow();
    expect(() => validateExcludePatterns(["foo;rm"])).toThrow();
    expect(() => validateExcludePatterns(["--checkpoint-action=exec"])).toThrow();
  });
});

describe("buildTarArgs", () => {
  it("coloca las opciones antes del separador", () => {
    expect(
      buildTarArgs({
        tarBinary: "tar",
        archiveRealPath: "/home/dominio/.tmp/a.tar.gz",
        baseRealPath: "/home/dominio/httpdocs",
        entries: ["assets", "index.php"],
        excludes: ["node_modules", "*.log"]
      })
    ).toEqual([
      "tar",
      "-czf",
      "/home/dominio/.tmp/a.tar.gz",
      "-C",
      "/home/dominio/httpdocs",
      "--exclude=node_modules",
      "--exclude=*.log",
      "--",
      "assets",
      "index.php"
    ]);
  });
});

describe("toRealPath", () => {
  it("antepone el home de la suscripción", () => {
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
  it("usa HOME cuando está disponible", async () => {
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

  it("cae a pwd si HOME no está disponible", async () => {
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
  it("solo marca errores de exec/tar", () => {
    expect(isExecFallbackError(new AppError("EXEC_UNAVAILABLE", "x"))).toBe(true);
    expect(isExecFallbackError(new AppError("TAR_UNAVAILABLE", "x"))).toBe(true);
    expect(isExecFallbackError(new AppError("TAR_FAILED", "x"))).toBe(false);
    expect(isExecFallbackError(new Error("x"))).toBe(false);
  });
});

describe("planArchive con shell ajeno", () => {
  it("aloja el tar en el home del dominio que ejecuta", async () => {
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

  it("acepta rutas normales", () => {
    expect(findUnsafeEntries([entry("assets/app.js"), entry("index.php")])).toEqual(
      []
    );
  });

  it("rechaza traversal y rutas absolutas", () => {
    expect(findUnsafeEntries([entry("../secreto")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("/etc/passwd")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("assets/../../secreto")])).toHaveLength(1);
  });

  it("rechaza nombres inválidos en Windows", () => {
    expect(findUnsafeEntries([entry("assets/a:b.txt")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("CON.txt")])).toHaveLength(1);
    expect(findUnsafeEntries([entry("archivo.")])).toHaveLength(1);
  });

  it("rechaza enlaces que escapan del destino", () => {
    expect(
      findUnsafeEntries([
        entry("assets/link", { linkpath: "../../fuera", type: "SymbolicLink" })
      ])
    ).toHaveLength(1);
    expect(
      findUnsafeEntries([
        entry("assets/link", { linkpath: "app.js", type: "SymbolicLink" })
      ])
    ).toEqual([]);
  });
});
