import { describe, expect, it } from "vitest";
import { PleskHttpError } from "../util/errors.js";
import type { PleskClient, PleskDomain, PleskExecResult } from "./client.js";
import {
  discoverShellDomain,
  resolveExecAccess
} from "./exec-access.js";

function domain(
  id: number,
  name: string,
  wwwRoot: string
): PleskDomain {
  return {
    id,
    name,
    hosting_type: "virtual",
    www_root: wwwRoot
  };
}

type Behavior = (
  domainId: number,
  command: string[]
) => PleskExecResult | Promise<PleskExecResult>;

function fakeClient(
  domains: PleskDomain[],
  behavior: Behavior
) {
  const calls: Array<{ domainId: number; command: string[] }> = [];

  const client = {
    resolveDomain: async () => domains[0]!,
    listDomains: async () => domains,
    execOn: async (
      domainId: number,
      command: string[]
    ): Promise<PleskExecResult> => {
      calls.push({ domainId, command });
      return behavior(domainId, command);
    }
  } as unknown as PleskClient;

  return { client, calls };
}

const ok = (stdout = ""): PleskExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (): PleskExecResult => ({ code: 1, stdout: "", stderr: "" });
const noShell = () =>
  new PleskHttpError(403, "SSH access is forbidden with /bin/false shell");

describe("resolveExecAccess", () => {
  it("uses the target domain if it has a shell and access", async () => {
    const target = domain(1, "example.com", "/var/www/vhosts/example.com/httpdocs");
    const { client } = fakeClient([target], (_id, command) =>
      command[0] === "whoami" ? ok("example_user") : ok("")
    );

    const access = await resolveExecAccess(client, {
      baseRest: "/httpdocs"
    });

    expect(access.domain.name).toBe("example.com");
    expect(access.foreign).toBe(false);
    expect(access.home).toBe("/var/www/vhosts/example.com");
  });

  it("uses another domain if the configured one has no shell", async () => {
    const target = domain(1, "example.com", "/var/www/vhosts/example.com/httpdocs");
    const other = domain(2, "other.com", "/var/www/vhosts/other.com/httpdocs");
    const { client } = fakeClient([target, other], (id, command) => {
      if (id === target.id) throw noShell();
      return command[0] === "whoami" ? ok("other_user") : ok("");
    });

    const access = await resolveExecAccess(client, {
      baseRest: "/httpdocs"
    });

    expect(access.domain.name).toBe("other.com");
    expect(access.foreign).toBe(true);
  });

  it("prioritizes domains from the same subscription", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const addon = domain(2, "addon.com", "/var/www/vhosts/main/addon/httpdocs");
    const other = domain(3, "aaa.com", "/var/www/vhosts/aaa.com/httpdocs");
    const probed: number[] = [];

    const { client } = fakeClient([target, addon, other], (id, command) => {
      probed.push(id);
      if (id === target.id) throw noShell();
      return command[0] === "whoami" ? ok("user") : ok("");
    });

    const access = await resolveExecAccess(client, {
      baseRest: "/httpdocs"
    });

    expect(access.domain.name).toBe("addon.com");
    expect(probed).toContain(addon.id);
  });

  it("respects the write requirement", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const readOnly = domain(2, "read.com", "/var/www/vhosts/read.com/httpdocs");
    const writable = domain(3, "write.com", "/var/www/vhosts/write.com/httpdocs");

    const { client } = fakeClient([target, readOnly, writable], (id, command) => {
      if (id === target.id) throw noShell();
      if (command[0] !== "whoami" && command[1] === "-w") {
        return id === writable.id ? ok("") : fail();
      }
      return ok(id === target.id ? "" : "user");
    });

    const access = await resolveExecAccess(client, {
      baseRest: "/httpdocs",
      need: "write"
    });

    expect(access.domain.name).toBe("write.com");
  });

  it("throws EXEC_UNAVAILABLE if no domain works", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const { client } = fakeClient([target], () => {
      throw noShell();
    });

    await expect(
      resolveExecAccess(client, { baseRest: "/httpdocs" })
    ).rejects.toMatchObject({ code: "EXEC_UNAVAILABLE" });
  });

  it("aborts if command execution is disabled globally", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const { client } = fakeClient([target], () => {
      throw new PleskHttpError(403, "Domain command execution is disabled");
    });

    await expect(
      resolveExecAccess(client, { baseRest: "/httpdocs" })
    ).rejects.toMatchObject({ code: "EXEC_UNAVAILABLE" });
  });

  it("caches the resolved access", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const { client, calls } = fakeClient([target], (_id, command) =>
      command[0] === "whoami" ? ok("user") : ok("")
    );

    await resolveExecAccess(client, { baseRest: "/httpdocs" });
    const probes = calls.length;
    await resolveExecAccess(client, { baseRest: "/httpdocs" });

    expect(calls.length).toBe(probes);
  });
});

describe("discoverShellDomain", () => {
  it("returns the first domain with a shell", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const other = domain(2, "other.com", "/var/www/vhosts/other.com/httpdocs");
    const { client } = fakeClient([target, other], (id, command) => {
      if (id === target.id) throw noShell();
      return command[0] === "whoami" ? ok("other") : ok("");
    });

    const access = await discoverShellDomain(client);
    expect(access?.domain.name).toBe("other.com");
    expect(access?.foreign).toBe(true);
  });

  it("returns null if there is no shell", async () => {
    const target = domain(1, "main.com", "/var/www/vhosts/main/httpdocs");
    const { client } = fakeClient([target], () => {
      throw noShell();
    });

    await expect(discoverShellDomain(client)).resolves.toBeNull();
  });
});
