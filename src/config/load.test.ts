import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRegistry } from "./load.js";

const originalCwd = process.cwd();
const originalGlobal = process.env.PLESK_GLOBAL_CONFIG;
const originalProjectRoot = process.env.PLESK_PROJECT_ROOT;
const cleanup: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalGlobal === undefined) {
    delete process.env.PLESK_GLOBAL_CONFIG;
  } else {
    process.env.PLESK_GLOBAL_CONFIG = originalGlobal;
  }
  if (originalProjectRoot === undefined) {
    delete process.env.PLESK_PROJECT_ROOT;
  } else {
    process.env.PLESK_PROJECT_ROOT = originalProjectRoot;
  }
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(global: unknown, local: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plesk-mcp-load-"));
  cleanup.push(root);
  const globalPath = path.join(root, "global.json");
  const localDir = path.join(root, ".plesk");
  await mkdir(localDir, { recursive: true });
  await writeFile(globalPath, JSON.stringify(global), "utf8");
  await writeFile(path.join(localDir, "config.json"), JSON.stringify(local), "utf8");
  process.env.PLESK_GLOBAL_CONFIG = globalPath;
  process.chdir(root);
  return root;
}

const server = (name: string, url = `https://${name}.example.com:8443`) => ({
  name,
  url,
  auth: { mode: "apiKey", apiKey: "secret" }
});

const database = (name: string, host: string) => ({
  name,
  host,
  user: "root",
  password: "secret"
});

describe("loadRegistry", () => {
  it("merges servers and local databases by name, with the local one winning", async () => {
    await makeProject(
      {
        defaultServer: "prod",
        servers: [server("prod"), server("shared")],
        localDatabases: [database("local-mysql-1", "10.0.0.1")]
      },
      {
        servers: [{ ...server("shared"), url: "https://local.example.com:8443" }],
        localDatabases: [database("local-mysql-2", "10.0.0.2")]
      }
    );

    const loaded = await loadRegistry();

    expect(loaded.servers.map((entry) => entry.name)).toEqual(["prod", "shared"]);
    expect(loaded.servers.find((entry) => entry.name === "shared")?.url).toBe(
      "https://local.example.com:8443"
    );
    expect(loaded.servers.find((entry) => entry.name === "shared")?.source).toBe(
      "local"
    );
    expect(loaded.localDatabases.map((entry) => entry.name)).toEqual([
      "local-mysql-1",
      "local-mysql-2"
    ]);
    expect(loaded.defaultServer).toBe("prod");
  });

  it("allows configuring only local databases without Plesk servers", async () => {
    await makeProject({}, { localDatabases: [database("local-mysql-1", "10.0.0.1")] });

    const loaded = await loadRegistry();

    expect(loaded.servers).toEqual([]);
    expect(loaded.defaultServer).toBeNull();
    expect(loaded.defaultSource).toBe("none");
    expect(loaded.localDatabases).toHaveLength(1);
  });

  it("rejects the same name in servers and localDatabases", async () => {
    await makeProject(
      {},
      {
        servers: [server("local-mysql-1")],
        localDatabases: [database("local-mysql-1", "10.0.0.1")]
      }
    );

    await expect(loadRegistry()).rejects.toMatchObject({
      code: "DUPLICATE_TARGET_NAME"
    });
  });

  it("rejects a defaultServer that does not exist", async () => {
    await makeProject({ defaultServer: "missing", servers: [server("prod")] }, {});

    await expect(loadRegistry()).rejects.toMatchObject({
      code: "DEFAULT_SERVER_NOT_FOUND"
    });
  });

  it("resolves the local config from PLESK_PROJECT_ROOT", async () => {
    const root = await makeProject(
      {},
      { servers: [server("from-env-root")] }
    );
    const otherCwd = await mkdtemp(path.join(os.tmpdir(), "plesk-mcp-cwd-"));
    cleanup.push(otherCwd);
    process.chdir(otherCwd);
    process.env.PLESK_PROJECT_ROOT = root;

    const loaded = await loadRegistry();

    expect(loaded.projectRoot).toBe(root);
    expect(loaded.localConfigPath).toBe(path.join(root, ".plesk", "config.json"));
    expect(loaded.servers.map((entry) => entry.name)).toEqual(["from-env-root"]);
  });
});
