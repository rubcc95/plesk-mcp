import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, fetch } from "undici";
import type { ServerConfig } from "../config/schema.js";
import { AppError, PleskHttpError } from "../util/errors.js";
import { redactText } from "../util/redact.js";

export interface PleskServerInfo {
  platform?: string;
  hostname?: string;
  panel_version?: string;
  [key: string]: unknown;
}

export interface PleskDomain {
  id: number;
  name: string;
  hosting_type?: string;
  www_root?: string;
  [key: string]: unknown;
}

export interface PleskExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export interface PleskCliResult {
  code: number;
  stdout?: string;
  stderr?: string;
  message?: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  /** `null` disables the timeout for that request. */
  timeoutMs?: number | null;
}

/**
 * Minimal Plesk REST API client.
 * It knows nothing about tools or project configuration: only transport and endpoints.
 */
export class PleskClient {
  private readonly baseUrl: string;
  private readonly agent: Agent;
  private domainPromise?: Promise<PleskDomain>;
  private domainsPromise?: Promise<PleskDomain[]>;
  private readonly domainsByName = new Map<string, Promise<PleskDomain>>();
  private readonly scopedClients = new Map<number, PleskClient>();

  constructor(
    private readonly server: ServerConfig,
    private readonly fixedDomain?: PleskDomain,
    agent?: Agent
  ) {
    this.baseUrl = server.url.replace(/\/+$/, "");
    this.agent =
      agent ??
      new Agent({
        connect: { rejectUnauthorized: server.verifyTls },
        // No transport timeouts: fast requests are still bounded
        // by AbortSignal and transfers run to completion.
        headersTimeout: 0,
        bodyTimeout: 0
      });
  }

  /** View of the client that works against another domain (same transport). */
  scopedTo(domain: PleskDomain): PleskClient {
    const cached = this.scopedClients.get(domain.id);
    if (cached) return cached;
    const client = new PleskClient(this.server, domain, this.agent);
    this.scopedClients.set(domain.id, client);
    return client;
  }

  /** Materialized server configuration (with no already-resolved secrets). */
  get serverConfig(): ServerConfig {
    return this.server;
  }

  /** Plesk server information. */
  async getServerInfo(): Promise<PleskServerInfo> {
    return this.json<PleskServerInfo>("/api/v2/server");
  }

  /**
   * Resolves a domain by name. If none is given and the server has only
   * one, it returns it; if there are several, the tool must pass `domain`.
   */
  async resolveDomain(name?: string): Promise<PleskDomain> {
    if (this.fixedDomain) return this.fixedDomain;

    if (name) {
      const cached = this.domainsByName.get(name);
      if (cached) return cached;
      const promise = this.findDomainByName(name);
      this.domainsByName.set(name, promise);
      return promise;
    }

    this.domainPromise ??= this.loadDefaultDomain();
    return this.domainPromise;
  }

  /** Lists all domains visible with the API key. */
  async listDomains(): Promise<PleskDomain[]> {
    this.domainsPromise ??= this.loadDomains();
    return this.domainsPromise;
  }

  async exec(
    command: string[],
    cwd?: string,
    timeoutMs?: number | null
  ): Promise<PleskExecResult> {
    const domain = await this.resolveDomain();
    return this.execOn(domain.id, command, cwd, timeoutMs);
  }

  /** Runs a command as the system user of a specific domain. */
  async execOn(
    domainId: number,
    command: string[],
    cwd?: string,
    timeoutMs?: number | null
  ): Promise<PleskExecResult> {
    const finalCommand = cwd ? withCwd(command, cwd) : command;
    const result = await this.json<PleskExecResult>(
      `/api/v2/domains/${domainId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: finalCommand }),
        timeoutMs
      }
    );
    return {
      ...result,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  }

  async cliCall(id: string, params: string[], env?: Record<string, string>): Promise<PleskCliResult> {
    const result = await this.json<PleskCliResult>(
      `/api/v2/cli/${encodeURIComponent(id)}/call`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(env ? { params, env } : { params })
      }
    );
    return {
      ...result,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  }

  async fsList(remotePath: string): Promise<unknown> {
    const domain = await this.resolveDomain();
    return this.json(
      `/api/v2/domains/${domain.id}/fs/list?${queryPath(this.apiPath(domain, remotePath))}`
    );
  }

  async fsStat(remotePath: string): Promise<unknown> {
    const domain = await this.resolveDomain();
    return this.json(
      `/api/v2/domains/${domain.id}/fs?${queryPath(this.apiPath(domain, remotePath))}`
    );
  }

  async fsRead(remotePath: string): Promise<Buffer> {
    const domain = await this.resolveDomain();
    const response = await this.request(
      `/api/v2/domains/${domain.id}/fs/content?${queryPath(this.apiPath(domain, remotePath))}`
    );
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Downloads a remote file directly to disk without loading it entirely into memory.
   * If it fails midway, it removes the partial file.
   */
  async fsDownloadToFile(
    remotePath: string,
    localPath: string,
    timeoutMs: number | null = null
  ): Promise<{ bytes: number }> {
    const domain = await this.resolveDomain();
    const response = await this.request(
      `/api/v2/domains/${domain.id}/fs/content?${queryPath(this.apiPath(domain, remotePath))}`,
      { timeoutMs }
    );

    const body = response.body;
    if (!body) {
      throw new AppError(
        "PLESK_EMPTY_RESPONSE",
        `Plesk returned an empty response while downloading ${remotePath}`
      );
    }

    try {
      await pipeline(
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(localPath)
      );
    } catch (error) {
      await rm(localPath, { force: true }).catch(() => undefined);
      throw new AppError(
        "PLESK_DOWNLOAD_FAILED",
        `Could not download ${remotePath} to ${localPath}`,
        { cause: error }
      );
    }

    const info = await stat(localPath);
    return { bytes: info.size };
  }

  async fsWrite(remotePath: string, content: Uint8Array): Promise<void> {
    const domain = await this.resolveDomain();
    await this.request(
      `/api/v2/domains/${domain.id}/fs/content?${queryPath(this.apiPath(domain, remotePath))}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: content,
        timeoutMs: null
      }
    );
  }

  async fsAppend(remotePath: string, content: Uint8Array): Promise<void> {
    const domain = await this.resolveDomain();
    await this.request(
      `/api/v2/domains/${domain.id}/fs/content?${queryPath(this.apiPath(domain, remotePath))}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/octet-stream" },
        body: content,
        timeoutMs: null
      }
    );
  }

  async fsMkdir(remotePath: string): Promise<unknown> {
    const domain = await this.resolveDomain();
    const query = queryPath(this.apiPath(domain, remotePath));
    return this.json(`/api/v2/domains/${domain.id}/fs/mkdir?${query}`, {
      method: "POST"
    });
  }

  async fsMove(source: string, destination: string, overwrite = false): Promise<unknown> {
    const domain = await this.resolveDomain();
    return this.json(`/api/v2/domains/${domain.id}/fs/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: this.apiPath(domain, source),
        destination: this.apiPath(domain, destination),
        overwrite
      })
    });
  }

  async fsCopy(source: string, destination: string, overwrite = false): Promise<unknown> {
    const domain = await this.resolveDomain();
    return this.json(`/api/v2/domains/${domain.id}/fs/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: this.apiPath(domain, source),
        destination: this.apiPath(domain, destination),
        overwrite
      })
    });
  }

  async fsDelete(remotePath: string, recursive = false): Promise<void> {
    const domain = await this.resolveDomain();
    const query = `${queryPath(this.apiPath(domain, remotePath))}&recursive=${recursive ? "true" : "false"}`;
    await this.request(`/api/v2/domains/${domain.id}/fs?${query}`, {
      method: "DELETE"
    });
  }

  async fsChmod(remotePath: string, mode: string, recursive = false): Promise<unknown> {
    const domain = await this.resolveDomain();
    const query = queryPath(this.apiPath(domain, remotePath));
    return this.json(`/api/v2/domains/${domain.id}/fs/chmod?${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
  }

  async getLogs(params: {
    type?: string;
    pattern?: string;
    lines?: number;
  }): Promise<unknown> {
    const domain = await this.resolveDomain();
    const query = new URLSearchParams();
    if (params.type) query.set("type", params.type);
    if (params.pattern) query.set("pattern", params.pattern);
    if (params.lines) query.set("lines", String(params.lines));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.json(`/api/v2/domains/${domain.id}/logs${suffix}`);
  }

  /**
   * Plesk's fs API resolves relative paths against the document root.
   * The MCP uses absolute virtual paths (`/httpdocs/...`), so we translate
   * them to the subscription's real home. Paths that are already real are left as is.
   */
  private apiPath(domain: PleskDomain, remotePath: string): string {
    if (!remotePath.startsWith("/")) return remotePath;
    if (
      remotePath.startsWith("/var/www/vhosts/") ||
      /^[A-Za-z]:[\\/]/.test(remotePath)
    ) {
      return remotePath;
    }

    const home = subscriptionRoot(domain);
    if (!home) return remotePath;
    return remotePath === "/" ? home : `${home}${remotePath}`;
  }

  private async loadDomains(): Promise<PleskDomain[]> {
    const result = await this.json<PleskDomain[] | { data?: PleskDomain[] }>(
      "/api/v2/domains"
    );
    return Array.isArray(result) ? result : (result.data ?? []);
  }

  private async findDomainByName(name: string): Promise<PleskDomain> {
    const domains = await this.listDomains();
    const match = domains.find((domain) => domain.name === name);
    if (match) return match;

    throw new AppError(
      "PLESK_DOMAIN_NOT_FOUND",
      `Domain "${name}" was not found on the server`,
      {
        hint: `Available domains: ${domains
          .slice(0, 10)
          .map((domain) => domain.name)
          .join(", ")}`
      }
    );
  }

  private async loadDefaultDomain(): Promise<PleskDomain> {
    const domains = await this.listDomains();

    if (domains.length === 1 && domains[0]) return domains[0];

    if (domains.length === 0) {
      throw new AppError(
        "PLESK_DOMAIN_NOT_FOUND",
        "The server has no domains accessible with this API key"
      );
    }

    throw new AppError(
      "PLESK_DOMAIN_REQUIRED",
      "The server has several domains and the tool did not receive domain",
      {
        hint: `Pass "domain" in the tool. Domains: ${domains
          .slice(0, 10)
          .map((domain) => domain.name)
          .join(", ")}`
      }
    );
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    return (await response.json()) as T;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers
    };

    if (this.server.auth.mode === "apiKey") {
      headers["X-API-Key"] = this.server.auth.apiKey;
    } else {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.server.auth.username}:${this.server.auth.password}`
      ).toString("base64")}`;
    }

    const timeoutMs =
      options.timeoutMs === undefined ? this.server.timeoutMs : options.timeoutMs;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body ?? null,
        dispatcher: this.agent,
        signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new AppError(
        "PLESK_UNREACHABLE",
        `Could not connect to Plesk at ${this.baseUrl}`,
        { cause: error, hint: "Check the URL, port 8443, and the network/VPN." }
      );
    }

    if (!response.ok) {
      const body = redactText(await response.text());
      let message = `Plesk returned HTTP ${response.status} ${response.statusText}`;
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // The body was not JSON; the HTTP message is kept.
      }
      throw new PleskHttpError(response.status, message, body.slice(0, 2_000));
    }

    return response;
  }
}

function queryPath(remotePath: string): string {
  return new URLSearchParams({ path: remotePath }).toString();
}

/** Real subscription root (system user home). */
export function subscriptionRoot(domain: PleskDomain): string | undefined {
  const root =
    typeof domain.www_root === "string"
      ? domain.www_root.replace(/\\/g, "/")
      : "";
  const match = /^(\/var\/www\/vhosts\/[^/]+)/.exec(root);
  if (match?.[1]) return match[1];
  if (domain.name) return `/var/www/vhosts/${domain.name}`;
  return undefined;
}

function withCwd(command: string[], cwd: string): string[] {
  const quotedCwd = shellQuote(cwd);
  const quotedCommand = command.map(shellQuote).join(" ");
  return ["bash", "-lc", `cd ${quotedCwd} && exec ${quotedCommand}`];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
