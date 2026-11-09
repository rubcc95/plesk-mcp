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
      title: "List servers and local databases",
      description:
        "Lists the Plesk servers and local databases registered in the global and local config, with their source and which one is the default. Does not include secrets.",
      inputSchema: {}
    },
    async () => toCallToolResult(ok(registrySummary(ctx.loaded)))
  );

  registrar.registerTool(
    "project_info",
    readPolicy,
    {
      title: "Configuration information",
      description:
        "Returns config paths, the default server, the access mode, Plesk servers and local databases. Does not include secrets.",
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
      title: "Check Plesk access",
      description:
        "Checks authentication, domain, file access, exec and tar. If `server` is given, uses it; otherwise, the default server.",
      inputSchema: {
        server: z.string().optional().describe("Server name"),
        domain: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Domain to check; if omitted and the server has only one, it is auto-detected"
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

/** When there is no config, the MCP starts and explains the error. */
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
        description: "No configuration is loaded. Returns the configuration error.",
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
        `server: ${runtime.name} (${runtime.source})`,
        `domain: ${domainName}`,
        `default: ${ctx.loaded.defaultServer ?? "(none)"} (${ctx.loaded.defaultSource})`,
        `global: ${ctx.loaded.globalConfigPath}${ctx.loaded.globalConfigFound ? "" : " (does not exist)"}`,
        `local: ${ctx.loaded.localConfigPath}${ctx.loaded.localConfigFound ? "" : " (does not exist)"}`
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
    return "fs/list works on /";
  });

  await addCheck(checks, "db", async () => {
    if (!runtime.server.dbUser || !runtime.server.dbPass) {
      throw new Error("The server has no dbUser/dbPass configured");
    }
    const target = resolveSqlTarget(ctx, { server: runtime.name });
    const list = await target.listDatabases({ includeSystem: true, limit: 1 });
    return `MySQL responds; ${list.databases.length} database(s) visible on the first page`;
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
    const user = (result.stdout ?? "").trim() || "whoami returned no output";
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
