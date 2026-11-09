import { z } from "zod";
import { toRealPath } from "../plesk/archive.js";
import { resolveExecAccess } from "../plesk/exec-access.js";
import { AppError } from "../util/errors.js";
import { redactText } from "../util/redact.js";
import { runTool } from "../util/result.js";
import type { ToolContext } from "./context.js";
import { listArg, textArg, type ToolRegistrar } from "./policy.js";

const INSTALLERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "composer",
  "bundle",
  "pip",
  "pip3"
]);

export function registerDepsTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "deps_install",
    {
      safety: "write",
      destructive: true,
      summarize: (args) => {
        const command = listArg(args, "command")
          .map((part) => String(part))
          .join(" ");
        const cwd = textArg(args, "cwd", "");
        return `Run "${command}"${cwd ? ` in ${cwd}` : ""}`;
      }
    },
    {
      title: "Install dependencies",
      description:
        "Runs an install command (npm, pnpm, yarn, composer, bundle, pip, pip3). This is not a free-form shell.",
      inputSchema: {
        server: z
          .string()
          .optional()
          .describe("Server name; if omitted, the default is used"),
        domain: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Subscription domain; if omitted and the server has only one, it is auto-detected"
          ),
        command: z.array(z.string().min(1)).min(1),
        cwd: z.string().optional()
      }
    },
    async ({ server: serverName, domain: domainName, command, cwd }) =>
      runTool(async () => {
        const executable = command[0];
        if (!executable || !INSTALLERS.has(executable)) {
          throw new AppError(
            "INSTALL_COMMAND_NOT_ALLOWED",
            `Install command not allowed: ${executable ?? "(empty)"}`,
            { hint: `Allowed: ${[...INSTALLERS].join(", ")}` }
          );
        }

        const runtime = ctx.registry.resolve(serverName);
        const domain = await runtime.client.resolveDomain(domainName);
        const client = runtime.client.scopedTo(domain);
        const name = runtime.name;
        const access = await resolveExecAccess(client, {
          baseRest: cwd ?? "/",
          need: "write"
        });
        const realCwd = cwd ? toRealPath(access.home, cwd) : undefined;
        const result = await access.exec(command, realCwd);
        if (result.code !== 0) {
          throw new AppError(
            "INSTALL_FAILED",
            redactText(
              result.stderr ||
                result.message ||
                `The install command finished with code ${result.code}`
            ),
            { hint: `Server: ${name}. Command: ${command.join(" ")}` }
          );
        }

        return {
          server: name,
          domain: domain.name,
          command,
          cwd: realCwd ?? null,
          execDomain: access.domain.name,
          foreignExecDomain: access.foreign,
          code: result.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? ""
        };
      })
  );
}
