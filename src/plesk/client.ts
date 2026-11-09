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
  /** `null` desactiva el timeout para esa petición. */
  timeoutMs?: number | null;
}

/**
 * Cliente mínimo de la API REST de Plesk.
 * No conoce tools ni configuración de proyecto: solo transporte y endpoints.
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
        // Sin timeouts de transporte: las peticiones rápidas siguen limitadas
        // por AbortSignal y las transferencias se ejecutan hasta completar.
        headersTimeout: 0,
        bodyTimeout: 0
      });
  }

  /** Vista del cliente que trabaja contra otro dominio (mismo transporte). */
  scopedTo(domain: PleskDomain): PleskClient {
    const cached = this.scopedClients.get(domain.id);
    if (cached) return cached;
    const client = new PleskClient(this.server, domain, this.agent);
    this.scopedClients.set(domain.id, client);
    return client;
  }

  /** Configuración materializada del servidor (sin secretos resueltos ya). */
  get serverConfig(): ServerConfig {
    return this.server;
  }

  /** Información del servidor Plesk. */
  async getServerInfo(): Promise<PleskServerInfo> {
    return this.json<PleskServerInfo>("/api/v2/server");
  }

  /**
   * Resuelve un dominio por nombre. Si no se indica y el servidor solo tiene
   * uno, lo devuelve; si hay varios, exige que la tool pase `domain`.
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

  /** Lista todos los dominios visibles con la API key. */
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

  /** Ejecuta un comando como el usuario de sistema de un dominio concreto. */
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
   * Descarga un fichero remoto directamente a disco, sin cargarlo entero en memoria.
   * Si falla a mitad, elimina el fichero parcial.
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
        `Plesk devolvió una respuesta vacía al descargar ${remotePath}`
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
        `No se pudo descargar ${remotePath} a ${localPath}`,
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
   * La API fs de Plesk resuelve las rutas relativas contra el document root.
   * El MCP usa rutas virtuales absolutas (`/httpdocs/...`), así que las
   * traducimos al home real de la suscripción. Las rutas ya reales se dejan tal cual.
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
      `No se encontró el dominio "${name}" en el servidor`,
      {
        hint: `Dominios disponibles: ${domains
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
        "El servidor no tiene dominios accesibles con esta API key"
      );
    }

    throw new AppError(
      "PLESK_DOMAIN_REQUIRED",
      "El servidor tiene varios dominios y la tool no recibió domain",
      {
        hint: `Pasa "domain" en la tool. Dominios: ${domains
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
        `No se pudo conectar con Plesk en ${this.baseUrl}`,
        { cause: error, hint: "Comprueba la URL, el puerto 8443 y la red/VPN." }
      );
    }

    if (!response.ok) {
      const body = redactText(await response.text());
      let message = `Plesk respondió HTTP ${response.status} ${response.statusText}`;
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // El cuerpo no era JSON; se conserva el mensaje HTTP.
      }
      throw new PleskHttpError(response.status, message, body.slice(0, 2_000));
    }

    return response;
  }
}

function queryPath(remotePath: string): string {
  return new URLSearchParams({ path: remotePath }).toString();
}

/** Raíz real de la suscripción (home del usuario de sistema). */
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
