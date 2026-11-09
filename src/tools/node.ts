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
  .describe("Nombre del servidor; si se omite, usa el defecto");

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
      title: "Listar aplicaciones Node.js",
      description: "Lista las aplicaciones Node.js gestionadas por Plesk.",
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
      title: "Información de una aplicación Node.js",
      description: "Devuelve la configuración de la aplicación Node.js del dominio.",
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
        `Configurar la aplicación Node.js del dominio ${textArg(args, "domain", "(por defecto)")}`
    },
    {
      title: "Configurar una aplicación Node.js",
      description:
        "Auto-configura la aplicación si no hay opciones; si se pasan opciones, actualiza los ajustes indicados.",
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
        `Actualizar los ajustes Node.js del dominio ${textArg(args, "domain", "(por defecto)")}`
    },
    {
      title: "Actualizar ajustes de Node.js",
      description:
        "Actualiza app root, startup file, versión de Node, modo, package manager o document root.",
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
      title: "Listar variables de entorno",
      description:
        "Lista solo los nombres de las variables de entorno de la aplicación. Nunca devuelve valores.",
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
              ? "No se pudieron parsear nombres; revisa node_info o la salida de Plesk."
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
        `Importar variables de entorno desde ${textArg(args, "file")} en el dominio ${textArg(args, "domain", "(por defecto)")}`
    },
    {
      title: "Importar variables de entorno desde un .env",
      description:
        "Lee un archivo .env local y escribe sus variables en la aplicación Node.js. Las variables se guardan siempre como secretas en Plesk. Nunca devuelve nombres ni valores.",
      inputSchema: {
        server: serverField,
        file: z
          .string()
          .min(1)
          .describe("Ruta local del archivo .env, dentro del proyecto"),
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
            `No se pudo escribir la variable de la línea ${entry.line} (${index + 1} de ${entries.length}); Plesk devolvió el código ${result.code}`,
            {
              hint: "No se han escrito las variables restantes. Revisa el error en Plesk o `plesk ext nodejs --help` en el servidor."
            }
          );
        }

        return {
          domain: resolvedDomain,
          variables: entries.length,
          secret: true,
          updated: true,
          hint: "Reinicia la aplicación para aplicar las variables (node_restart)."
        };
      })
  );

  registrar.registerTool(
    "node_env_unset",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Eliminar la variable de entorno ${textArg(args, "key")}`
    },
    {
      title: "Eliminar una variable de entorno",
      description: "Elimina una variable de entorno de la aplicación.",
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
        `Instalar dependencias Node.js en el dominio ${textArg(args, "domain", "(por defecto)")}`
    },
    {
      title: "Instalar dependencias de Node.js",
      description:
        "Ejecuta la instalación de dependencias con la versión de Node y el package manager de la aplicación.",
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
        `Ejecutar el script "${textArg(args, "script")}" del proyecto Node.js`
    },
    {
      title: "Ejecutar un script de package.json",
      description: "Ejecuta un script del proyecto Node.js.",
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
              `Ejecutar ${action} de la aplicación Node.js del dominio ${textArg(args, "domain", "(por defecto)")}`
          };

    registrar.registerTool(
      `node_${action}`,
      policy,
      {
        title: `Node.js: ${action}`,
        description: `Ejecuta ${action} sobre la aplicación Node.js del dominio.`,
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
      result.stderr || result.message || `${action} terminó con código ${result.code}`
    ),
    {
      hint: "Revisa `plesk ext nodejs --help` en el servidor y los flags del adaptador."
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
