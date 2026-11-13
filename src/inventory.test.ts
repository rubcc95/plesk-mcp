import { describe, expect, it } from "vitest";
import { buildInventory, inventoryMarkdown } from "./inventory.js";
import type { PleskClient, PleskDomain } from "./plesk/client.js";

const HANDLERS_XML =
  '<?xml version="1.0"?><packet version="1.6.9.0"><php-handler><get>' +
  "<result><status>ok</status><id>plesk-php83-fpm</id><full-version>8.3.36</full-version></result>" +
  "<result><status>ok</status><id>plesk-php74-fpm</id><full-version>7.4.33</full-version></result>" +
  "</get></php-handler></packet>";

function webspaceXml(entries: Array<{ name: string; handler: string }>): string {
  const results = entries
    .map(
      (entry) =>
        `<result><status>ok</status><filter-id>${entry.name}</filter-id><id>1</id><data><gen_info><name>${entry.name}</name></gen_info><hosting><vrt_hst><property><name>php_handler_id</name><value>${entry.handler}</value></property></vrt_hst></hosting></data></result>`
    )
    .join("");

  return `<?xml version="1.0"?><packet version="1.6.9.0"><webspace><get>${results}</get></webspace></packet>`;
}

function siteXml(name: string, handler: string): string {
  return (
    `<?xml version="1.0"?><packet version="1.6.9.0"><site><get><result><status>ok</status>` +
    `<filter-id>${name}</filter-id><id>7</id><data><gen_info><name>${name}</name></gen_info>` +
    `<hosting><vrt_hst><property><name>php_handler_id</name><value>${handler}</value></property></vrt_hst></hosting>` +
    `</data></result></get></site></packet>`
  );
}

function fakeClient(
  domains: PleskDomain[],
  siteHandlers: Record<string, string> = {}
): PleskClient {
  return {
    listDomains: async () => domains,
    xmlCall: async (packet: string) => {
      if (packet.includes("php-handler")) return HANDLERS_XML;
      if (packet.includes("webspace")) {
        return webspaceXml(
          domains
            .filter((domain) => !domain.base_domain_id)
            .map((domain) => ({ name: domain.name, handler: "plesk-php83-fpm" }))
        );
      }
      const match = /<name>([^<]+)<\/name>/.exec(packet);
      const name = match?.[1] ?? "";
      const handler = siteHandlers[name] ?? "plesk-php83-fpm";
      return siteXml(name, handler);
    }
  } as unknown as PleskClient;
}

const domains: PleskDomain[] = [
  { id: 1, name: "uno.es", base_domain_id: 0, aliases: ["alias.es"] },
  { id: 2, name: "dos.es", base_domain_id: 0, aliases: [] },
  { id: 3, name: "sub.dos.es", base_domain_id: 2, aliases: [] }
];

describe("buildInventory", () => {
  it("resolves every host, including subdomains and aliases", async () => {
    const result = await buildInventory(
      "adw1",
      fakeClient(domains, { "sub.dos.es": "plesk-php74-fpm" })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.inventory.hosts).toHaveLength(3);
    expect(result.inventory.hosts.map((host) => host.name)).toEqual([
      "uno.es",
      "dos.es",
      "sub.dos.es"
    ]);
    expect(result.inventory.hosts[0]?.type).toBe("domain");
    expect(result.inventory.hosts[2]?.type).toBe("subdomain");
    expect(result.inventory.hosts[2]?.phpVersion).toBe("7.4.33");
    expect(result.inventory.aliases).toEqual([
      { name: "alias.es", parent: "uno.es", parentId: 1 }
    ]);
    expect(result.apiTotal).toBe(3);
  });

  it("fails when a handler is not installed", async () => {
    const client = {
      listDomains: async () => [domains[0]!],
      xmlCall: async (packet: string) => {
        if (packet.includes("php-handler")) return HANDLERS_XML;
        return webspaceXml([{ name: "uno.es", handler: "plesk-php99-fpm" }]);
      }
    } as unknown as PleskClient;

    const result = await buildInventory("adw1", client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([
      {
        name: "uno.es",
        problem: 'Handler "plesk-php99-fpm" is not installed on the server'
      }
    ]);
  });

  it("renders a Markdown table with the census counts", async () => {
    const result = await buildInventory("adw1", fakeClient(domains));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const markdown = inventoryMarkdown(result.inventory, result.apiTotal);
    expect(markdown).toContain("Dominios revisados: 3");
    expect(markdown).toContain("Total API: 3");
    expect(markdown).toContain("| uno.es | 8.3.36 |");
    expect(markdown).toContain("Alias: 1");
  });
});
