import { z } from "zod";
import { asArray, pick } from "../plesk/xml.js";
import { runTool } from "../util/result.js";
import type { ToolContext } from "./context.js";
import type { ToolRegistrar } from "./policy.js";

const serverField = z
  .string()
  .optional()
  .describe("Server name; if omitted, the default is used");

export function registerDomainTools(
  registrar: ToolRegistrar,
  ctx: ToolContext
): void {
  registrar.registerTool(
    "domains_list",
    { safety: "read", idempotent: true },
    {
      title: "List domains",
      description:
        "Lists every domain and subdomain of a Plesk server, with its id, hosting type, document root and aliases. Not paginated: returns the full census.",
      inputSchema: {
        server: serverField,
        includeAliases: z
          .boolean()
          .optional()
          .describe("Include the aliases of each domain (default true)")
      }
    },
    async ({ server: serverName, includeAliases }) =>
      runTool(async () => {
        const runtime = ctx.registry.resolve(serverName);
        const domains = await runtime.client.listDomains();
        const withAliases = includeAliases ?? true;

        const entries = domains.map((domain) => ({
          id: domain.id,
          name: domain.name,
          asciiName: domain.ascii_name ?? domain.name,
          type: domain.base_domain_id ? "subdomain" : "domain",
          baseDomainId: domain.base_domain_id ?? 0,
          hostingType: domain.hosting_type ?? null,
          wwwRoot: domain.www_root ?? null,
          aliases: withAliases ? aliasNames(domain.aliases) : []
        }));

        const aliases = withAliases
          ? entries.flatMap((entry) =>
              entry.aliases.map((alias) => ({
                name: alias,
                parent: entry.name,
                parentId: entry.id
              }))
            )
          : [];

        return {
          server: runtime.name,
          total: entries.length,
          aliasesTotal: aliases.length,
          domains: entries,
          aliases
        };
      })
  );
}

function aliasNames(value: unknown): string[] {
  const names: string[] = [];
  for (const entry of asArray(value)) {
    const name =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null
          ? pick(entry, "name")
          : undefined;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}
