import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolRegistrar, resolveAccessMode } from "./policy.js";

type ElicitReply = ElicitResult | (() => ElicitResult);

async function createPeer(
  mode: "confirm" | "full",
  reply?: ElicitReply
) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const registrar = createToolRegistrar(server, mode);
  let mutations = 0;
  let elicitations = 0;

  registrar.registerTool(
    "mutate",
    {
      safety: "write",
      destructive: true,
      summarize: () => "Change something on the server"
    },
    {
      title: "Mutate",
      inputSchema: {
        value: z.string(),
        dry_run: z.boolean().optional()
      }
    },
    async ({ value }) => {
      mutations += 1;
      return { content: [{ type: "text" as const, text: value }] };
    }
  );

  registrar.registerTool(
    "inspect",
    { safety: "read" },
    { title: "Inspect", inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] })
  );

  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: reply ? { elicitation: { form: {} } } : {} }
  );

  if (reply) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitations += 1;
      return typeof reply === "function" ? reply() : reply;
    });
  }

  await client.connect(clientTransport);

  return {
    client,
    mutations: () => mutations,
    elicitations: () => elicitations
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item
        ? String(item.text)
        : ""
    )
    .join("\n");
}

describe("resolveAccessMode", () => {
  it("uses confirm by default and accepts aliases", () => {
    expect(resolveAccessMode(undefined)).toBe("confirm");
    expect(resolveAccessMode("")).toBe("confirm");
    expect(resolveAccessMode("write")).toBe("confirm");
    expect(resolveAccessMode("full")).toBe("full");
    expect(resolveAccessMode("client")).toBe("full");
  });

  it("falls back to confirm on an invalid value", () => {
    expect(resolveAccessMode("something-else")).toBe("confirm");
  });
});

describe("createToolRegistrar", () => {
  it("runs without elicitation in full mode", async () => {
    const peer = await createPeer("full");
    const result = await peer.client.callTool({
      name: "mutate",
      arguments: { value: "done" }
    });

    expect(result.isError).toBeFalsy();
    expect(peer.mutations()).toBe(1);
    expect(peer.elicitations()).toBe(0);
  });

  it("requires elicitation in confirm mode if the client supports it", async () => {
    const peer = await createPeer("confirm", {
      action: "accept",
      content: { confirm: true }
    });
    const result = await peer.client.callTool({
      name: "mutate",
      arguments: { value: "done" }
    });

    expect(result.isError).toBeFalsy();
    expect(peer.mutations()).toBe(1);
    expect(peer.elicitations()).toBe(1);
  });

  it("does not run if the user does not check the box", async () => {
    const peer = await createPeer("confirm", {
      action: "accept",
      content: { confirm: false }
    });
    const result = await peer.client.callTool({
      name: "mutate",
      arguments: { value: "no" }
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("CONFIRM_REJECTED");
    expect(peer.mutations()).toBe(0);
  });

  it("does not run if a client without elicitation calls a write", async () => {
    const peer = await createPeer("confirm");
    const result = await peer.client.callTool({
      name: "mutate",
      arguments: { value: "no" }
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("CONFIRMATION_UNSUPPORTED");
    expect(peer.mutations()).toBe(0);
  });

  it("dry_run does not ask for confirmation", async () => {
    const peer = await createPeer("confirm", {
      action: "accept",
      content: { confirm: true }
    });
    const result = await peer.client.callTool({
      name: "mutate",
      arguments: { value: "plan", dry_run: true }
    });

    expect(result.isError).toBeFalsy();
    expect(peer.elicitations()).toBe(0);
    expect(peer.mutations()).toBe(1);
  });

  it("publishes annotations for writes", async () => {
    const peer = await createPeer("confirm");
    const { tools } = await peer.client.listTools();

    const write = tools.find((tool) => tool.name === "mutate");
    const read = tools.find((tool) => tool.name === "inspect");

    expect(write?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true
    });
    expect(read?.annotations).toMatchObject({ readOnlyHint: true });
  });
});
