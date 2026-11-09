import { z } from "zod";
import { runTool } from "../util/result.js";
import type { ToolContext } from "./context.js";
import type { ToolRegistrar } from "./policy.js";

export function registerLogTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "logs",
    { safety: "read" },
    {
      title: "Search domain logs",
      description:
        "Searches for a pattern in the domain logs (error, access or node) and returns the matches.",
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
        type: z.enum(["error", "access", "node"]).optional(),
        pattern: z.string().optional(),
        lines: z.number().int().min(1).max(2000).optional()
      }
    },
    async ({ server: serverName, domain: domainName, ...params }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const domain = await runtime.client.resolveDomain(domainName);
        const client = runtime.client.scopedTo(domain);
        const result = await client.getLogs(params);
        return { domain: domain.name, params, result };
      })
  );
}
