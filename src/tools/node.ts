import { readFile } from "node:fs/promises";
import { z } from "zod";
import { assertLocalFile } from "../config/paths.js";
import type { PleskCliResult } from "../plesk/client.js";
import { AppError } from "../util/errors.js";
import { redactText } from "../util/redact.js";
import { runTool } from "../util/result.js";
import type { ServerRuntime, ToolContext } from "./context.js";
import { parseEnvFile } from "./env-file.js";
import { textArg, type ToolPolicy, type ToolRegistrar } from "./policy.js";

const serverField = z
  .string()
  .optional()
  .describe("Server name; if omitted, the default is used");

const updateSchema = {
  server: serverField,
  domain: z.string().optional(),
  appRoot: z.string().optional(),
  startupFile: z.string().optional(),
  nodeVersion: z.string().optional(),
  appMode: z.enum(["production", "development"]).optional(),
  packageManager: z.enum(["npm", "pnpm", "yarn"]).optional(),
  documentRoot: z.string().optional()
};

const readPolicy: ToolPolicy = { safety: "read" };

export function registerNodeTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "node_list",
    readPolicy,
    {
      title: "List Node.js applications",
      description: "Lists the Node.js applications managed by Plesk.",
      inputSchema: { server: serverField }
    },
    async ({ server: serverName }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.node.list();
        ensureOk(result, "node_list");
        return cliResult(result);
      })
  );

  registrar.registerTool(
    "node_info",
    readPolicy,
    {
      title: "Node.js application information",
      description: "Returns the Node.js application configuration for the domain.",
      inputSchema: {
        server: serverField,
        domain: z.string().optional()
      }
    },
    async ({ server: serverName, domain }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.node.info(await domainFor(runtime, domain));
        ensureOk(result, "node_info");
        return cliResult(result);
      })
  );

  registrar.registerTool(
    "node_configure",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Configure the Node.js application for domain ${textArg(args, "domain", "(default)")}`
    },
    {
      title: "Configure a Node.js application",
      description:
        "Auto-configures the application when no options are given; if options are passed, updates the specified settings.",
      inputSchema: updateSchema
    },
    async (options) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(options.server);
        const domain = await domainFor(runtime, options.domain);
        const hasOptions = Object.entries(options).some(
          ([key, value]) =>
            key !== "server" && key !== "domain" && value !== undefined
        );
        const result = hasOptions
          ? await runtime.node.update(domain, options)
          : await runtime.node.autoConfigure(domain);
        ensureOk(result, "node_configure");
        return { domain, ...cliResult(result) };
      })
  );

  registrar.registerTool(
    "node_update",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Update the Node.js settings for domain ${textArg(args, "domain", "(default)")}`
    },
    {
      title: "Update Node.js settings",
      description:
        "Updates app root, startup file, Node version, mode, package manager or document root.",
      inputSchema: updateSchema
    },
    async (options) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(options.server);
        const domain = await domainFor(runtime, options.domain);
        const result = await runtime.node.update(domain, options);
        ensureOk(result, "node_update");
        return { domain, ...cliResult(result) };
      })
  );

  registrar.registerTool(
    "node_env_list",
    readPolicy,
    {
      title: "List environment variables",
      description:
        "Lists only the names of the application's environment variables. Never returns values.",
      inputSchema: {
        server: serverField,
        domain: z.string().optional()
      }
    },
    async ({ server: serverName, domain }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.node.envList(await domainFor(runtime, domain));
        ensureOk(result, "node_env_list");
        const names = parseEnvNames(result.stdout ?? "");
        return {
          names,
          note:
            names.length === 0
              ? "Could not parse names; check node_info or the Plesk output."
              : undefined
        };
      })
  );

  registrar.registerTool(
    "node_env_set",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Import environment variables from ${textArg(args, "file")} into domain ${textArg(args, "domain", "(default)")}`
    },
    {
      title: "Import environment variables from a .env",
      description:
        "Reads a local .env file and writes its variables to the Node.js application. Variables are always stored as secret in Plesk. Never returns names or values.",
      inputSchema: {
        server: serverField,
        file: z
          .string()
          .min(1)
          .describe("Local path of the .env file, inside the project"),
        domain: z.string().optional()
      }
    },
    async ({ server: serverName, file, domain }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const resolvedDomain = await domainFor(runtime, domain);
        const local = await assertLocalFile(ctx.projectRoot, file);
        const entries = parseEnvFile(await readFile(local, "utf8"));

        for (const [index, entry] of entries.entries()) {
          const result = await runtime.node.envSet(
            resolvedDomain,
            entry.key,
            entry.value,
            true
          );
          if (result.code === 0) continue;
          throw new AppError(
            "NODE_ENV_SET_FAILED",
            `Could not write the variable from line ${entry.line} (${index + 1} of ${entries.length}); Plesk returned code ${result.code}`,
            {
              hint: "The remaining variables were not written. Check the error in Plesk or `plesk ext nodejs --help` on the server."
            }
          );
        }

        return {
          domain: resolvedDomain,
          variables: entries.length,
          secret: true,
          updated: true,
          hint: "Restart the application to apply the variables (node_restart)."
        };
      })
  );

  registrar.registerTool(
    "node_env_unset",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Remove environment variable ${textArg(args, "key")}`
    },
    {
      title: "Remove an environment variable",
      description: "Removes an environment variable from the application.",
      inputSchema: {
        server: serverField,
        key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        domain: z.string().optional()
      }
    },
    async ({ server: serverName, key, domain }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.node.envUnset(await domainFor(runtime, domain), key);
        ensureOk(result, "node_env_unset");
        return { key, removed: true };
      })
  );

  registrar.registerTool(
    "node_install",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Install Node.js dependencies for domain ${textArg(args, "domain", "(default)")}`
    },
    {
      title: "Install Node.js dependencies",
      description:
        "Runs dependency installation with the application's Node version and package manager.",
      inputSchema: {
        server: serverField,
        domain: z.string().optional()
      }
    },
    async ({ server: serverName, domain }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.node.install(await domainFor(runtime, domain));
        ensureOk(result, "node_install");
        return cliResult(result);
      })
  );

  registrar.registerTool(
    "node_run_script",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Run the "${textArg(args, "script")}" script of the Node.js project`
    },
    {
      title: "Run a package.json script",
      description: "Runs a script from the Node.js project.",
      inputSchema: {
        server: serverField,
        script: z.string().min(1),
        domain: z.string().optional()
      }
    },
    async ({ server: serverName, script, domain }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.node.runScript(await domainFor(runtime, domain), script);
        ensureOk(result, "node_run_script");
        return { script, ...cliResult(result) };
      })
  );

  for (const action of ["restart", "start", "stop", "status"] as const) {
    const policy: ToolPolicy =
      action === "status"
        ? readPolicy
        : {
            safety: "write",
            destructive: true,
            summarize: (args) =>
              `Run ${action} for the Node.js application on domain ${textArg(args, "domain", "(default)")}`
          };

    registrar.registerTool(
      `node_${action}`,
      policy,
      {
        title: `Node.js: ${action}`,
        description: `Runs ${action} on the domain's Node.js application.`,
        inputSchema: {
          server: serverField,
          domain: z.string().optional()
        }
      },
      async ({ server: serverName, domain }) =>
        runTool(async () => {
          const runtime = ctx.registry.resolve(serverName);
          const result = await runtime.node[action](await domainFor(runtime, domain));
          ensureOk(result, `node_${action}`);
          return { action, ...cliResult(result) };
        })
    );
  }
}

async function domainFor(
  runtime: ServerRuntime,
  domain?: string
): Promise<string> {
  const resolved = await runtime.client.resolveDomain(domain);
  return resolved.name;
}

function ensureOk(result: PleskCliResult, action: string): void {
  if (result.code === 0) return;
  throw new AppError(
    "NODE_CLI_FAILED",
    redactText(
      result.stderr || result.message || `${action} finished with code ${result.code}`
    ),
    {
      hint: "Check `plesk ext nodejs --help` on the server and the adapter flags."
    }
  );
}

function cliResult(result: PleskCliResult) {
  return {
    code: result.code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function parseEnvNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}
