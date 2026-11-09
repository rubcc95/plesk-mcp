import {
  materializeServer,
  type LoadedRegistry,
  type ServerEntry
} from "../config/load.js";
import type { ServerConfig } from "../config/schema.js";
import { PleskClient } from "../plesk/client.js";
import { NodeAdapter } from "../plesk/node.js";
import { AppError } from "../util/errors.js";
import type { AccessMode } from "./policy.js";

export interface ServerRuntime {
  name: string;
  server: ServerConfig;
  client: PleskClient;
  node: NodeAdapter;
  source: "global" | "local";
}

export class ServerRegistry {
  private readonly cache = new Map<string, ServerRuntime>();

  constructor(private readonly loaded: LoadedRegistry) {}

  get defaultName(): string | null {
    return this.loaded.defaultServer;
  }

  list() {
    return this.loaded.servers.map((server) => ({
      name: server.name,
      url: server.url,
      source: server.source,
      default: server.name === this.loaded.defaultServer,
      hasDb: Boolean(server.dbUser && server.dbPass)
    }));
  }

  resolve(name?: string): ServerRuntime {
    const target = name ?? this.loaded.defaultServer;
    if (!target) {
      throw new AppError(
        "SERVER_NOT_FOUND",
        "No Plesk servers are configured",
        { hint: "Add servers to `servers` in the global or local config." }
      );
    }

    const entry = this.loaded.servers.find((server) => server.name === target);

    if (!entry) {
      throw new AppError(
        "SERVER_NOT_FOUND",
        `Server "${target}" does not exist`,
        {
          hint: `Available servers: ${this.loaded.servers
            .map((server) => server.name)
            .join(", ") || "(none)"}`
        }
      );
    }

    const cached = this.cache.get(entry.name);
    if (cached) return cached;

    const server = materializeServer(entry);
    const client = new PleskClient(server);
    const runtime: ServerRuntime = {
      name: entry.name,
      server,
      client,
      node: new NodeAdapter(client),
      source: entry.source
    };
    this.cache.set(entry.name, runtime);
    return runtime;
  }
}

export interface ToolContext {
  registry: ServerRegistry;
  loaded: LoadedRegistry;
  projectRoot: string;
  accessMode: AccessMode;
}

export function createToolContext(
  loaded: LoadedRegistry,
  accessMode: AccessMode
): ToolContext {
  return {
    registry: new ServerRegistry(loaded),
    loaded,
    projectRoot: loaded.projectRoot,
    accessMode
  };
}

export type { ServerEntry };
