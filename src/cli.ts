import { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadRegistry,
  materializeServer,
  registrySummary,
  resolveGlobalConfigPath,
  resolveLocalConfigPath,
  resolveProjectRoot,
  type LoadedRegistry
} from "./config/load.js";
import { PleskClient } from "./plesk/client.js";
import type { ExecAccess } from "./plesk/exec-access.js";
import { discoverShellDomain, resolveExecAccess } from "./plesk/exec-access.js";
import { asAppError } from "./util/errors.js";

const VERSION = __PKG_VERSION__;
const EMPTY_REGISTRY = { servers: [], localDatabases: [] };

const program = new Command()
  .name("plesk-mcp")
  .description("Prepares and checks the plesk-mcp configuration")
  .version(VERSION)
  .option("--global-config <path>", "alternative path to the global config");

program
  .command("init")
  .description("Creates the local or global config")
  .option("-f, --force", "overwrites the file if it already exists")
  .option("-g, --global", "creates the global config")
  .action(async (options: { force?: boolean; global?: boolean }) => {
    if (options.global) {
      await initFile(resolveGlobalConfigPath(), options.force ?? false, true);
    } else {
      await initFile(resolveLocalConfigPath(), options.force ?? false, false);
    }
  });

program
  .command("doctor")
  .description("Checks authentication, domain, files, exec, and tar")
  .option("-s, --server <name>", "name of the server to check")
  .option("-d, --domain <name>", "domain to check")
  .action(async (options: { server?: string; domain?: string }) => {
    await doctor(
      program.opts().globalConfig as string | undefined,
      options.server,
      options.domain
    );
  });

program
  .command("servers")
  .description("Lists the Plesk servers and local databases")
  .action(async () => {
    const loaded = await loadRegistry(program.opts().globalConfig as string | undefined);
    printSummary(loaded);
  });

program
  .command("project-info")
  .description("Shows the configuration without secrets")
  .action(async () => {
    const loaded = await loadRegistry(program.opts().globalConfig as string | undefined);
    printSummary(loaded);
  });

/** CLI entry point. It does not run when the module is imported. */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (error) {
    const appError = asAppError(error);
    console.error(`${appError.code}: ${appError.message}`);
    if (appError.hint) console.error(`Hint: ${appError.hint}`);
    process.exitCode = 1;
  }
}

async function initFile(filePath: string, force: boolean, global: boolean): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  if (force || !existsSync(filePath)) {
    await writeFile(filePath, `${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`, "utf8");
  }

  if (!global) await ensureGitignore(resolveProjectRoot());

  console.log(`${global ? "Global config" : "Local config"}: ${filePath}`);
  console.log("");
  console.log("Add Plesk servers inside `servers`:");
  console.log(
    JSON.stringify(
      {
        defaultServer: "prod-example",
        servers: [
          {
            name: "prod-example",
            url: "https://plesk.example.com:8443",
            auth: {
              mode: "apiKey",
              apiKey: "env:PLESK_API_KEY"
            },
            dbUser: "db_admin",
            dbPass: "env:PLESK_DB_PASS"
          }
        ]
      },
      null,
      2
    )
  );
  console.log("");
  console.log("And local databases inside `localDatabases`:");
  console.log(
    JSON.stringify(
      {
        localDatabases: [
          {
            name: "local-mysql-1",
            host: "192.168.1.50",
            port: 3306,
            user: "root",
            password: "env:MYSQL_BALLENA_PASSWORD"
          }
        ]
      },
      null,
      2
    )
  );
}

async function doctor(
  globalExplicit?: string,
  serverName?: string,
  domainName?: string
): Promise<void> {
  const loaded = await loadRegistry(globalExplicit);
  printSummary(loaded);

  const selected = serverName ?? loaded.defaultServer;
  const entry = loaded.servers.find((server) => server.name === selected);
  if (!entry || !selected) {
    console.error(`Server "${selected ?? "(none)"}" does not exist`);
    process.exitCode = 1;
    return;
  }

  const baseClient = new PleskClient(materializeServer(entry));
  const domain = await baseClient.resolveDomain(domainName).catch((error) => {
    const appError = asAppError(error);
    console.error(`${appError.code}: ${appError.message}`);
    return null;
  });
  if (!domain) {
    process.exitCode = 1;
    return;
  }
  const client = baseClient.scopedTo(domain);
  const checks: Array<{ name: string; ok: boolean; message: string; hint?: string }> = [
    {
      name: "config",
      ok: true,
      message: `server: ${entry.name} (${entry.source}) | domain: ${domain.name} | default: ${loaded.defaultServer ?? "(none)"} (${loaded.defaultSource}) | db: ${entry.dbUser ? "yes" : "no"}`
    }
  ];

  await addCheck(checks, "server", async () => {
    const info = await client.getServerInfo();
    return `Plesk ${info.panel_version ?? "?"} (${info.platform ?? "?"})`;
  });

  await addCheck(checks, "domain", async () => {
    const domain = await client.resolveDomain();
    return `${domain.name} (id ${domain.id})`;
  });

  await addCheck(checks, "files", async () => {
    await client.fsList("/");
    return "fs/list works on /";
  });

  await addCheck(checks, "db", async () => {
    if (!entry.dbUser || !entry.dbPass) {
      throw new Error("The server does not have dbUser/dbPass configured");
    }
    return "MySQL credentials configured (validated when SQL is executed)";
  });

  let shell: ExecAccess | null = null;
  await addCheck(checks, "exec", async () => {
    shell = await discoverShellDomain(client);
    if (!shell) {
      throw new Error(
        "No domain has a shell. Enable SSH access (shell /bin/bash) on some subscription."
      );
    }
    const result = await shell.exec(["whoami"]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.message || `code ${result.code}`);
    }
    const user = (result.stdout ?? "").trim() || "whoami with no output";
    return `${user} (domain ${shell.domain.name}${shell.foreign ? ", alternate" : ""})`;
  });

  await addCheck(checks, "tar", async () => {
    if (!shell) {
      throw new Error("No shell available to check tar");
    }
    const result = await shell.exec(["tar", "--version"]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.message || `code ${result.code}`);
    }
    return (result.stdout ?? "").split(/\r?\n/)[0]?.trim() || "tar available";
  });

  await addCheck(checks, "execPaths", async () => {
    const access = await resolveExecAccess(client, {
      baseRest: "/",
      need: "read"
    });
    return `${access.domain.name}${access.foreign ? " (alternate)" : ""} accesses ${access.home}`;
  });

  for (const check of checks) {
    console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name.padEnd(8)} ${check.message}`);
    if (!check.ok && check.hint) console.log(`     Hint: ${check.hint}`);
  }

  const healthy = checks.every((check) => check.ok);
  if (!healthy) process.exitCode = 1;
}

async function addCheck(
  checks: Array<{ name: string; ok: boolean; message: string; hint?: string }>,
  name: string,
  fn: () => Promise<string>
): Promise<void> {
  try {
    checks.push({ name, ok: true, message: await fn() });
  } catch (error) {
    const appError = asAppError(error);
    checks.push({
      name,
      ok: false,
      message: appError.message,
      hint: appError.hint
    });
  }
}

function printSummary(loaded: LoadedRegistry): void {
  const summary = registrySummary(loaded);
  console.log(`Global:  ${summary.paths.globalConfig}${summary.paths.globalConfigFound ? "" : " (does not exist)"}`);
  console.log(`Local:   ${summary.paths.localConfig}${summary.paths.localConfigFound ? "" : " (does not exist)"}`);
  console.log(
    `Default: ${summary.defaultServer ?? "(none)"} (${summary.defaultSource})`
  );
  console.log("Servers:");
  for (const server of summary.servers) {
    console.log(
      `  ${server.default ? "*" : " "} ${server.name}  ${server.url}  db:${server.hasDb ? "yes" : "no"}  [${server.source}]`
    );
  }
  if (summary.localDatabases.length > 0) {
    console.log("Local databases:");
    for (const database of summary.localDatabases) {
      console.log(
        `    ${database.name}  ${database.host}:${database.port}  [${database.source}]`
      );
    }
  }
}

async function ensureGitignore(root: string): Promise<void> {
  const filePath = path.join(root, ".gitignore");
  const required = [".plesk/config.json", ".plesk/audit.jsonl"];
  let content = "";

  try {
    content = await readFile(filePath, "utf8");
  } catch {
    content = "";
  }

  const missing = required.filter((line) => !content.split(/\r?\n/).includes(line));
  if (missing.length === 0) return;

  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(filePath, `${content}${prefix}${missing.join("\n")}\n`, "utf8");
}
