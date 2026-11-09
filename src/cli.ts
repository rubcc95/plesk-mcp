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
  type LoadedRegistry
} from "./config/load.js";
import { PleskClient } from "./plesk/client.js";
import type { ExecAccess } from "./plesk/exec-access.js";
import { discoverShellDomain, resolveExecAccess } from "./plesk/exec-access.js";
import { asAppError } from "./util/errors.js";

const VERSION = "0.1.0";
const EMPTY_REGISTRY = { servers: [], localDatabases: [] };

const program = new Command()
  .name("plesk-project")
  .description("Prepara y comprueba la configuración de plesk-mcp")
  .version(VERSION)
  .option("--global-config <path>", "ruta alternativa al config global");

program
  .command("init")
  .description("Crea el config local o el global")
  .option("-f, --force", "sobrescribe el archivo si ya existe")
  .option("-g, --global", "crea el config global")
  .action(async (options: { force?: boolean; global?: boolean }) => {
    if (options.global) {
      await initFile(resolveGlobalConfigPath(), options.force ?? false, true);
    } else {
      await initFile(resolveLocalConfigPath(), options.force ?? false, false);
    }
  });

program
  .command("doctor")
  .description("Comprueba autenticación, dominio, ficheros, exec y tar")
  .option("-s, --server <name>", "nombre del servidor a comprobar")
  .option("-d, --domain <name>", "dominio a comprobar")
  .action(async (options: { server?: string; domain?: string }) => {
    await doctor(
      program.opts().globalConfig as string | undefined,
      options.server,
      options.domain
    );
  });

program
  .command("servers")
  .description("Lista los servidores Plesk y las bases de datos locales")
  .action(async () => {
    const loaded = await loadRegistry(program.opts().globalConfig as string | undefined);
    printSummary(loaded);
  });

program
  .command("project-info")
  .description("Muestra la configuración sin secretos")
  .action(async () => {
    const loaded = await loadRegistry(program.opts().globalConfig as string | undefined);
    printSummary(loaded);
  });

program.parseAsync(process.argv).catch((error) => {
  const appError = asAppError(error);
  console.error(`${appError.code}: ${appError.message}`);
  if (appError.hint) console.error(`Pista: ${appError.hint}`);
  process.exitCode = 1;
});

async function initFile(filePath: string, force: boolean, global: boolean): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  if (force || !existsSync(filePath)) {
    await writeFile(filePath, `${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`, "utf8");
  }

  if (!global) await ensureGitignore(process.cwd());

  console.log(`${global ? "Config global" : "Config local"}: ${filePath}`);
  console.log("");
  console.log("Añade servidores Plesk dentro de `servers`:");
  console.log(
    JSON.stringify(
      {
        defaultServer: "prod-mundopc",
        servers: [
          {
            name: "prod-mundopc",
            url: "https://plesk.ejemplo.com:8443",
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
  console.log("Y bases de datos locales dentro de `localDatabases`:");
  console.log(
    JSON.stringify(
      {
        localDatabases: [
          {
            name: "ballena",
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
    console.error(`No existe el servidor "${selected ?? "(ninguno)"}"`);
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
      message: `servidor: ${entry.name} (${entry.source}) | dominio: ${domain.name} | defecto: ${loaded.defaultServer ?? "(ninguno)"} (${loaded.defaultSource}) | db: ${entry.dbUser ? "sí" : "no"}`
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
    return "fs/list funciona en /";
  });

  await addCheck(checks, "db", async () => {
    if (!entry.dbUser || !entry.dbPass) {
      throw new Error("El servidor no tiene dbUser/dbPass configurados");
    }
    return "credenciales MySQL configuradas (se validan al ejecutar SQL)";
  });

  let shell: ExecAccess | null = null;
  await addCheck(checks, "exec", async () => {
    shell = await discoverShellDomain(client);
    if (!shell) {
      throw new Error(
        "Ningún dominio tiene shell. Activa el acceso SSH (shell /bin/bash) en alguna suscripción."
      );
    }
    const result = await shell.exec(["whoami"]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.message || `code ${result.code}`);
    }
    const user = (result.stdout ?? "").trim() || "whoami sin salida";
    return `${user} (dominio ${shell.domain.name}${shell.foreign ? ", alternativo" : ""})`;
  });

  await addCheck(checks, "tar", async () => {
    if (!shell) {
      throw new Error("No hay shell disponible para comprobar tar");
    }
    const result = await shell.exec(["tar", "--version"]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.message || `code ${result.code}`);
    }
    return (result.stdout ?? "").split(/\r?\n/)[0]?.trim() || "tar disponible";
  });

  await addCheck(checks, "execPaths", async () => {
    const access = await resolveExecAccess(client, {
      baseRest: "/",
      need: "read"
    });
    return `${access.domain.name}${access.foreign ? " (alternativo)" : ""} accede a ${access.home}`;
  });

  for (const check of checks) {
    console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name.padEnd(8)} ${check.message}`);
    if (!check.ok && check.hint) console.log(`     Pista: ${check.hint}`);
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
  console.log(`Global:  ${summary.paths.globalConfig}${summary.paths.globalConfigFound ? "" : " (no existe)"}`);
  console.log(`Local:   ${summary.paths.localConfig}${summary.paths.localConfigFound ? "" : " (no existe)"}`);
  console.log(
    `Defecto: ${summary.defaultServer ?? "(ninguno)"} (${summary.defaultSource})`
  );
  console.log("Servidores:");
  for (const server of summary.servers) {
    console.log(
      `  ${server.default ? "*" : " "} ${server.name}  ${server.url}  db:${server.hasDb ? "sí" : "no"}  [${server.source}]`
    );
  }
  if (summary.localDatabases.length > 0) {
    console.log("Bases de datos locales:");
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
