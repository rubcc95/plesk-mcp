import type { PleskClient, PleskDomain } from "./plesk/client.js";
import {
  asArray,
  assertReadOnlyPacket,
  buildPacket,
  hostingProperties,
  parseXmlResponse,
  pick
} from "./plesk/xml.js";

export interface InventoryHost {
  name: string;
  id: number;
  type: "domain" | "subdomain";
  hostingType: string | null;
  phpHandler: string | null;
  phpVersion: string | null;
}

export interface InventoryAlias {
  name: string;
  parent: string;
  parentId: number;
}

export interface Inventory {
  server: string;
  /** Hosts with their own vhost (domains + subdomains). */
  hosts: InventoryHost[];
  /** Aliases share their parent's handler, so they are not counted as hosts. */
  aliases: InventoryAlias[];
  /** Handler id to full PHP version. */
  handlers: Record<string, string>;
}

export type InventoryResult =
  | { ok: true; inventory: Inventory; apiTotal: number }
  | {
      ok: false;
      reason: string;
      missing: Array<{ name: string; problem: string }>;
      inventory: Inventory;
      apiTotal: number;
    };

/**
 * Builds the PHP inventory of a server using only read-only calls:
 * REST v2 for the domain census, XML API for handler ids and versions.
 */
export async function buildInventory(
  server: string,
  client: PleskClient
): Promise<InventoryResult> {
  const domains = await client.listDomains();
  const handlers = await fetchHandlers(client);
  const handlerByName = await fetchHandlersByDomain(client, domains);

  const hosts: InventoryHost[] = domains.map((domain) => {
    const hostingType = domain.hosting_type ?? null;
    const handler = handlerByName.get(domain.name) ?? null;
    return {
      name: domain.name,
      id: domain.id,
      type: domain.base_domain_id ? "subdomain" : "domain",
      hostingType,
      phpHandler: handler,
      phpVersion: handler ? (handlers[handler] ?? null) : null
    };
  });

  const inventory: Inventory = {
    server,
    hosts,
    aliases: collectAliases(domains),
    handlers
  };

  const missing: Array<{ name: string; problem: string }> = [];
  for (const host of hosts) {
    // Forwarding/frame domains have no hosting, so they cannot run PHP.
    if (host.hostingType && host.hostingType !== "virtual") continue;

    if (!host.phpHandler) {
      missing.push({ name: host.name, problem: "Plesk has no php_handler_id for this host" });
    } else if (!host.phpVersion) {
      missing.push({
        name: host.name,
        problem: `Handler "${host.phpHandler}" is not installed on the server`
      });
    }
  }

  if (hosts.length !== domains.length) {
    missing.push({
      name: "(census)",
      problem: `${hosts.length} hosts built from ${domains.length} domains returned by the API`
    });
  }

  if (missing.length > 0) {
    return { ok: false, reason: "incomplete inventory", missing, inventory, apiTotal: domains.length };
  }

  return { ok: true, inventory, apiTotal: domains.length };
}

async function fetchHandlers(client: PleskClient): Promise<Record<string, string>> {
  const packet = buildPacket("php-handler", "<filter/>");
  const operators = assertReadOnlyPacket(packet);
  const response = parseXmlResponse(await client.xmlCall(packet), operators);

  const get = pick(pick(response.packet, "php-handler"), "get");
  const handlers: Record<string, string> = {};

  for (const result of asArray(pick(get, "result"))) {
    const id = pick(result, "id");
    const fullVersion = pick(result, "full-version");
    if (typeof id === "string" && fullVersion !== undefined) {
      handlers[id] = String(fullVersion);
    }
  }

  return handlers;
}

async function fetchHandlersByDomain(
  client: PleskClient,
  domains: PleskDomain[]
): Promise<Map<string, string>> {
  const handlers = new Map<string, string>();

  // One call returns every hosting (subscription) with its PHP handler.
  try {
    const packet = buildPacket(
      "webspace",
      "<filter/><dataset><gen_info/><hosting/></dataset>"
    );
    const response = parseXmlResponse(
      await client.xmlCall(packet),
      assertReadOnlyPacket(packet)
    );
    const get = pick(pick(response.packet, "webspace"), "get");

    for (const result of asArray(pick(get, "result"))) {
      const name =
        (pick(result, "filter-id") as string | undefined) ??
        (pick(pick(pick(result, "data"), "gen_info"), "name") as string | undefined);
      const handler = hostingProperties(result)["php_handler_id"];
      if (typeof name === "string" && handler) handlers.set(name, handler);
    }
  } catch {
    // Fall through to per-domain site/get calls.
  }

  // Subdomains are not webspaces: query them one by one.
  for (const domain of domains) {
    if (handlers.has(domain.name)) continue;
    const handler = await fetchSiteHandler(client, domain.name);
    if (handler) handlers.set(domain.name, handler);
  }

  return handlers;
}

async function fetchSiteHandler(
  client: PleskClient,
  domainName: string
): Promise<string | null> {
  try {
    const packet = buildPacket(
      "site",
      `<filter><name>${escapeXml(domainName)}</name></filter><dataset><gen_info/><hosting/></dataset>`
    );
    const response = parseXmlResponse(
      await client.xmlCall(packet),
      assertReadOnlyPacket(packet)
    );
    const get = pick(pick(response.packet, "site"), "get");
    const result = asArray(pick(get, "result"))[0];
    return hostingProperties(result)["php_handler_id"] ?? null;
  } catch {
    return null;
  }
}

function collectAliases(domains: PleskDomain[]): InventoryAlias[] {
  const aliases: InventoryAlias[] = [];

  for (const domain of domains) {
    for (const entry of asArray(domain.aliases)) {
      const name =
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null
            ? pick(entry, "name")
            : undefined;
      if (typeof name === "string" && name.length > 0) {
        aliases.push({ name, parent: domain.name, parentId: domain.id });
      }
    }
  }

  return aliases.sort((a, b) => a.name.localeCompare(b.name));
}

/** Markdown report: one table of host and PHP version, plus the census counts. */
export function inventoryMarkdown(inventory: Inventory, apiTotal: number): string {
  const lines: string[] = [];
  lines.push(`# ${inventory.server}`, "");
  lines.push(`Dominios revisados: ${inventory.hosts.length}`);
  lines.push(`Total API: ${apiTotal}`);
  if (inventory.aliases.length > 0) {
    lines.push(`Alias: ${inventory.aliases.length} (comparten la versión de su dominio padre)`);
  }
  lines.push("", "| Dominio | Versión PHP |", "|---|---|");

  for (const host of inventory.hosts) {
    const version =
      host.phpVersion ??
      (host.hostingType && host.hostingType !== "virtual"
        ? "Sin PHP (sin alojamiento)"
        : "No determinada");
    lines.push(`| ${host.name} | ${version} |`);
  }

  lines.push("");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
