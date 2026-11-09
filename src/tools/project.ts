import { z } from "zod";
import { registrySummary } from "../config/load.js";
import type { PleskClient } from "../plesk/client.js";
import type { ExecAccess } from "../plesk/exec-access.js";
import { discoverShellDomain, resolveExecAccess } from "../plesk/exec-access.js";
import { resolveSqlTarget } from "../sql/targets.js";
import type { AppError } from "../util/errors.js";
import { asAppError } from "../util/errors.js";
import { fail, ok, toCallToolResult } from "../util/result.js";
import type { ServerRuntime, ToolContext } from "./context.js";
import type { ToolRegistrar } from "./policy.js";

const readPolicy = { safety: "read" as const };

interface Check {
  name: string;
  ok: boolean;
  message: string;
  hint?: string;
}

export function registerProjectTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "servers_list",
    readPolicy,
    {
      title: "Listar servidores y bases locales",
      description:
        "Lista los servidores Plesk y las bases de datos locales registrados en el config global y local, con su origen y cuál es el defecto. No incluye secretos.",
      inputSchema: {}
    },
    async () => toCallToolResult(ok(registrySummary(ctx.loaded)))
  );

  registrar.registerTool(
    "project_info",
    readPolicy,
    {
      title: "Información de configuración",
      description:
        "Devuelve las rutas de configuración, el servidor por defecto, el modo de acceso, los servidores Plesk y las bases locales. No incluye secretos.",
      inputSchema: {}
    },
    async () =>
      toCallToolResult(
        ok({
          access: ctx.accessMode,
          ...registrySummary(ctx.loaded)
        })
      )
  );

  registrar.registerTool(
    "doctor",
    readPolicy,
    {
      title: "Comprobar acceso a Plesk",
      description:
        "Comprueba autenticación, dominio, acceso a ficheros, exec y tar. Si se indica `server`, usa ese; si no, el servidor por defecto.",
      inputSchema: {
        server: z.string().optional().describe("Nombre del servidor"),
        domain: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Dominio a comprobar; si se omite y el servidor tiene uno solo, se autodetecta"
          )
      }
    },
    async ({ server, domain: domainName }) => {
      try {
        const runtime = ctx.registry.resolve(server);
        const domain = await runtime.client.resolveDomain(domainName);
        const client = runtime.client.scopedTo(domain);
        const checks = await runChecks(ctx, runtime, client, domain.name);
        const healthy = checks.every((check) => check.ok);
        return toCallToolResult(
          ok({ healthy, server: runtime.name, domain: domain.name, checks })
        );
      } catch (error) {
        const appError = asAppError(error);
        return toCallToolResult(fail(appError.code, appError.message, appError.hint));
      }
    }
  );
}

/** Cuando no hay configuración, el MCP arranca y explica el error. */
export function registerConfigErrorTools(
  registrar: ToolRegistrar,
  error: AppError
): void {
  const response = () =>
    toCallToolResult(fail(error.code, error.message, error.hint));

  for (const name of ["servers_list", "project_info", "doctor"]) {
    registrar.registerTool(
      name,
      readPolicy,
      {
        title: name,
        description: "No hay configuración cargada. Devuelve el error de configuración.",
        inputSchema: {}
      },
      async () => response()
    );
  }
}

async function runChecks(
  ctx: ToolContext,
  runtime: ServerRuntime,
  client: PleskClient,
  domainName: string
): Promise<Check[]> {
  const checks: Check[] = [
    {
      name: "config",
      ok: true,
      message: [
        `servidor: ${runtime.name} (${runtime.source})`,
        `dominio: ${domainName}`,
        `por defecto: ${ctx.loaded.defaultServer ?? "(ninguno)"} (${ctx.loaded.defaultSource})`,
        `global: ${ctx.loaded.globalConfigPath}${ctx.loaded.globalConfigFound ? "" : " (no existe)"}`,
        `local: ${ctx.loaded.localConfigPath}${ctx.loaded.localConfigFound ? "" : " (no existe)"}`
      ].join(" | ")
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
    if (!runtime.server.dbUser || !runtime.server.dbPass) {
      throw new Error("El servidor no tiene dbUser/dbPass configurados");
    }
    const target = resolveSqlTarget(ctx, { server: runtime.name });
    const list = await target.listDatabases({ includeSystem: true, limit: 1 });
    return `MySQL responde; ${list.databases.length} base(s) visibles en la primera página`;
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

  return checks;
}

async function addCheck(
  checks: Check[],
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
