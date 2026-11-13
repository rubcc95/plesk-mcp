import { z } from "zod";
import { AppError } from "../util/errors.js";
import { redactText } from "../util/redact.js";
import { runTool } from "../util/result.js";
import type { ToolContext } from "./context.js";
import { elicitConfirmation, type ToolRegistrar } from "./policy.js";

/** Plesk CLI commands this tool is allowed to reach. */
const ALLOWED_IDS = new Set([
  "client",
  "database",
  "dns",
  "domain",
  "extension",
  "ip",
  "php_handler",
  "site",
  "subdomain",
  "webspace"
]);

/** Flags that never modify the server. */
const READ_FLAGS = new Set([
  "--help",
  "--info",
  "--list",
  "--show",
  "--version",
  "-h",
  "-i",
  "-l",
  "-v"
]);

const EXTENSION_READ_FLAGS = new Set(["--info", "--list", "--status"]);

export function registerCliTool(
  registrar: ToolRegistrar,
  ctx: ToolContext
): void {
  registrar.registerTool(
    "plesk_cli",
    {
      safety: "dynamic",
      destructive: true,
      summarize: (args) => {
        const id = String(args.id ?? "?");
        const params = Array.isArray(args.params)
          ? args.params.map((param) => String(param)).join(" ")
          : "";
        return `Run "plesk bin ${id} ${params}" on the panel as root`;
      },
      authorize: async (args, server) => {
        const id = typeof args.id === "string" ? args.id : "";
        const params = Array.isArray(args.params)
          ? args.params.map((param) => String(param))
          : [];

        if (!ALLOWED_IDS.has(id)) {
          throw new AppError(
            "CLI_COMMAND_NOT_ALLOWED",
            `Plesk CLI command not allowed: ${id || "(empty)"}`,
            { hint: `Allowed: ${[...ALLOWED_IDS].join(", ")}` }
          );
        }

        if (isReadOnlyCall(id, params)) return;

        if (ctx.accessMode === "confirm") {
          await elicitConfirmation(
            server,
            `Confirm operation in production:\n\nRun "plesk bin ${id} ${params.join(" ")}"`,
            {
              tool: "plesk_cli",
              rejectedMessage: 'The user rejected "plesk_cli"',
              rejectedHint: "Nothing on the server has been modified."
            }
          );
          return;
        }

        if (process.env.PLESK_MCP_ALLOW_CLI_WRITE !== "1") {
          throw new AppError(
            "CLI_WRITE_BLOCKED",
            `"plesk bin ${id} ${params.join(" ")}" may modify the server`,
            {
              hint: "This call is not read-only. Set PLESK_MCP_ALLOW_CLI_WRITE=1 to allow write commands, or use a read-only flag such as --info/--list."
            }
          );
        }
      }
    },
    {
      title: "Plesk CLI",
      description:
        "Runs a Plesk CLI command on the panel (POST /api/v2/cli/{id}/call), for example plesk bin domain --info example.com. Read-only flags (--info, --list, --version, --show, --help) run directly; anything else requires confirmation or PLESK_MCP_ALLOW_CLI_WRITE=1.",
      inputSchema: {
        server: z
          .string()
          .optional()
          .describe("Server name; if omitted, the default is used"),
        id: z
          .string()
          .min(1)
          .describe(
            `CLI command id: ${[...ALLOWED_IDS].join(", ")}`
          ),
        params: z
          .array(z.string())
          .default([])
          .describe(
            "Arguments passed to the CLI command, for example [\"--info\", \"example.com\"]"
          )
      }
    },
    async ({ server: serverName, id, params }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const result = await runtime.client.cliCall(id, params);

        return {
          server: runtime.name,
          id,
          params,
          code: result.code,
          stdout: redactText(result.stdout ?? ""),
          stderr: redactText(result.stderr ?? ""),
          message: result.message ? redactText(result.message) : undefined
        };
      })
  );
}

/** A call is read-only when every meaningful flag is a read flag. */
export function isReadOnlyCall(id: string, params: string[]): boolean {
  const flags = params.filter((param) => param.startsWith("-"));
  if (flags.length === 0) return false;

  if (flags.every((flag) => READ_FLAGS.has(flag))) return true;

  return id === "extension" && flags.every((flag) => EXTENSION_READ_FLAGS.has(flag));
}
