import { z } from "zod";
import { runTool } from "../util/result.js";
import type { ToolContext } from "./context.js";
import type { ToolRegistrar } from "./policy.js";

export function registerLogTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "logs",
    { safety: "read" },
    {
      title: "Buscar en logs del dominio",
      description:
        "Busca un patrón en los logs del dominio (error, access o node) y devuelve las coincidencias.",
      inputSchema: {
        server: z
          .string()
          .optional()
          .describe("Nombre del servidor; si se omite, usa el defecto"),
        domain: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Dominio de la suscripción; si se omite y el servidor tiene uno solo, se autodetecta"
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
