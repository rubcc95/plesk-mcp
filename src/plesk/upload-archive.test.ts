import { describe, expect, it } from "vitest";
import type { PleskClient, PleskDomain } from "./client.js";
import type { ExecAccess } from "./exec-access.js";
import { prepareArchiveTarget } from "./upload-archive.js";

describe("prepareArchiveTarget con shell ajeno", () => {
  it("deja el archivo en el dominio destino aunque el shell sea de otro", async () => {
    const target: PleskDomain = {
      id: 1,
      name: "main.com",
      hosting_type: "virtual",
      www_root: "/var/www/vhosts/main/httpdocs"
    };
    const executor: PleskDomain = {
      id: 2,
      name: "alt.com",
      hosting_type: "virtual",
      www_root: "/var/www/vhosts/alt/httpdocs"
    };
    const access: ExecAccess = {
      target,
      domain: executor,
      home: "/var/www/vhosts/main",
      foreign: true,
      exec: async (command) => ({
        code: 0,
        stdout: command[0] === "tar" ? "tar 1.0" : "",
        stderr: ""
      })
    };

    const result = await prepareArchiveTarget(
      {} as PleskClient,
      "/httpdocs",
      true,
      access
    );

    expect(result.foreign).toBe(true);
    expect(result.execDomain.name).toBe("alt.com");
    expect(result.realRemoteDir).toBe("/var/www/vhosts/main/httpdocs");
    expect(
      result.realPath.startsWith("/var/www/vhosts/main/.plesk-mcp-tmp/")
    ).toBe(true);
  });
});
