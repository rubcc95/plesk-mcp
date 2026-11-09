import { AppError, PleskHttpError } from "../util/errors.js";
import { redactText } from "../util/redact.js";
import {
  subscriptionRoot,
  type PleskClient,
  type PleskDomain,
  type PleskExecResult
} from "./client.js";

/** Timeout por sondeo de shell (como el dashboard: 8 s). */
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CANDIDATES = 25;
const CACHE_TTL_MS = 5 * 60_000;

export type ExecNeed = "read" | "write";

/** Acceso shell resuelto para operar sobre una ruta de la suscripción destino. */
export interface ExecAccess {
  /** Dominio configurado (dueño de los ficheros y de la API fs). */
  target: PleskDomain;
  /** Dominio que ejecuta los comandos (puede ser distinto). */
  domain: PleskDomain;
  /** Raíz real de la suscripción destino. */
  home: string;
  /** true si el shell pertenece a otro dominio/suscripción. */
  foreign: boolean;
  exec(
    command: string[],
    cwd?: string,
    timeoutMs?: number | null
  ): Promise<PleskExecResult>;
}

export interface ExecAccessOptions {
  /** Ruta remota relativa a la suscripción destino (p. ej. `/httpdocs`). */
  baseRest: string;
  need?: ExecNeed;
  probeTimeoutMs?: number;
  maxCandidates?: number;
}

interface CachedAccess {
  domainId: number;
  domainName: string;
  expiresAt: number;
}

interface ShellStatus {
  hasShell: boolean;
  expiresAt: number;
}

const accessCache = new WeakMap<PleskClient, Map<string, CachedAccess>>();
const shellStatusCache = new WeakMap<PleskClient, Map<number, ShellStatus>>();
const commandExecutionDisabled = new WeakMap<PleskClient, boolean>();

/**
 * Busca un shell utilizable para leer/escribir una ruta del dominio destino.
 *
 * Orden de candidatos:
 * 1. Dominio seleccionado por la tool (caso normal).
 * 2. Dominios de la misma suscripción (addon/subdominios: mismo usuario).
 * 3. Resto de dominios con hosting físico.
 */
export async function resolveExecAccess(
  client: PleskClient,
  options: ExecAccessOptions
): Promise<ExecAccess> {
  const target = await client.resolveDomain();
  const home = subscriptionRoot(target);
  if (!home) {
    throw new AppError(
      "EXEC_PATH_MAPPING_FAILED",
      `No se pudo determinar la raíz real del dominio ${target.name}`,
      { hint: "Revisa www_root del dominio en Plesk." }
    );
  }

  const need = options.need ?? "read";
  const realBase = toRealPath(home, normalizeRest(options.baseRest));
  const key = `${target.id}|${need}|${realBase}`;
  const cache = getCache(client);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const domain = await findDomain(client, cached.domainId, cached.domainName);
    if (domain) {
      return buildAccess(client, target, domain, home);
    }
    cache.delete(key);
  }

  const domains = await listDomainsSafe(client);
  const candidates = orderCandidates(domains, target, home);
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probed: string[] = [];

  for (const domain of candidates.slice(0, max)) {
    probed.push(domain.name);
    if (!(await hasShell(client, domain, timeout))) continue;
    if (!(await canAccess(client, domain, realBase, need, timeout))) continue;

    cache.set(key, {
      domainId: domain.id,
      domainName: domain.name,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
    return buildAccess(client, target, domain, home);
  }

  throw new AppError(
    "EXEC_UNAVAILABLE",
    "Ningún dominio del servidor permite ejecutar comandos para esta ruta",
    {
      hint:
        (commandExecutionDisabled.get(client)
          ? "La ejecución de comandos está deshabilitada en la extensión REST de Plesk. "
          : "") +
        `Se probaron ${probed.length} dominio(s). Activa el acceso SSH (shell /bin/bash) en alguna suscripción o usa el modo walk.`
    }
  );
}

/** Busca un dominio con shell, sin comprobar rutas concretas (para doctor). */
export async function discoverShellDomain(
  client: PleskClient,
  options: { probeTimeoutMs?: number; maxCandidates?: number } = {}
): Promise<ExecAccess | null> {
  const target = await client.resolveDomain();
  const home = subscriptionRoot(target) ?? "/";
  const domains = await listDomainsSafe(client);
  const candidates = orderCandidates(domains, target, home);
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  for (const domain of candidates.slice(0, max)) {
    if (await hasShell(client, domain, timeout)) {
      return buildAccess(client, target, domain, home);
    }
  }
  return null;
}

/** Shell de cualquier dominio, sin depender de una suscripción concreta. */
export interface ShellAccess {
  domain: PleskDomain;
  exec(command: string[], timeoutMs?: number | null): Promise<PleskExecResult>;
}

/**
 * Busca cualquier dominio con shell que además cumpla `require` (por ejemplo,
 * que tenga el cliente `mysql`). No comprueba rutas ni suscripciones: sirve
 * para tareas globales del servidor, como ejecutar SQL.
 */
export async function findShellDomain(
  client: PleskClient,
  options: {
    probeTimeoutMs?: number;
    maxCandidates?: number;
    require?: (access: ShellAccess) => Promise<boolean>;
  } = {}
): Promise<ShellAccess | null> {
  const domains = await listDomainsSafe(client);
  const candidates = domains
    .filter((domain) => !domain.hosting_type || domain.hosting_type === "virtual")
    .sort((left, right) => left.name.localeCompare(right.name));
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  for (const domain of candidates.slice(0, max)) {
    if (!(await hasShell(client, domain, timeout))) continue;

    const access: ShellAccess = {
      domain,
      exec: (command, timeoutMs) =>
        client.execOn(domain.id, command, undefined, timeoutMs)
    };

    if (options.require && !(await options.require(access))) continue;
    return access;
  }

  return null;
}

/** Invalida la caché de un cliente (tras un fallo de shell inesperado). */
export function clearExecAccessCache(client: PleskClient): void {
  accessCache.delete(client);
  shellStatusCache.delete(client);
  commandExecutionDisabled.delete(client);
}

function buildAccess(
  client: PleskClient,
  target: PleskDomain,
  domain: PleskDomain,
  home: string
): ExecAccess {
  return {
    target,
    domain,
    home,
    foreign: domain.id !== target.id,
    exec: (command, cwd, timeoutMs) =>
      client.execOn(domain.id, command, cwd, timeoutMs)
  };
}

async function hasShell(
  client: PleskClient,
  domain: PleskDomain,
  timeoutMs: number
): Promise<boolean> {
  if (commandExecutionDisabled.get(client)) return false;

  const statuses = getShellStatuses(client);
  const cached = statuses.get(domain.id);
  if (cached && cached.expiresAt > Date.now()) return cached.hasShell;

  try {
    const result = await client.execOn(
      domain.id,
      ["whoami"],
      undefined,
      timeoutMs
    );
    const hasShell = result.code === 0 && (result.stdout ?? "").trim() !== "";
    statuses.set(domain.id, {
      hasShell,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
    return hasShell;
  } catch (error) {
    if (error instanceof PleskHttpError) {
      if (isCommandExecutionDisabled(error)) {
        commandExecutionDisabled.set(client, true);
        throw new AppError(
          "EXEC_UNAVAILABLE",
          "La ejecución de comandos está deshabilitada en Plesk",
          {
            hint:
              "Actívala en la configuración de la extensión REST (domainCommandExecutionEnabled) o usa el modo walk."
          }
        );
      }
      // 403/404 por dominio sin shell, sin hosting o borrado: se prueba el siguiente.
      if (error.status === 401) throw error;
      statuses.set(domain.id, {
        hasShell: false,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      return false;
    }
    if (error instanceof AppError && error.code === "PLESK_UNREACHABLE") {
      throw error;
    }
    return false;
  }
}

async function canAccess(
  client: PleskClient,
  domain: PleskDomain,
  realPath: string,
  need: ExecNeed,
  timeoutMs: number
): Promise<boolean> {
  const checks = [
    ["test", "-e", realPath],
    ["test", need === "write" ? "-w" : "-r", realPath]
  ];

  for (const command of checks) {
    try {
      const result = await client.execOn(
        domain.id,
        command,
        undefined,
        timeoutMs
      );
      if (result.code !== 0) return false;
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === "PLESK_UNREACHABLE"
      ) {
        throw error;
      }
      return false;
    }
  }
  return true;
}

async function findDomain(
  client: PleskClient,
  id: number,
  name: string
): Promise<PleskDomain | null> {
  const domains = await listDomainsSafe(client);
  return (
    domains.find((domain) => domain.id === id) ??
    domains.find((domain) => domain.name === name) ??
    null
  );
}

/**
 * Lista dominios sin romper la operación si la API key no puede listarlos
 * (por ejemplo, una key de cliente restringida). Los errores de red sí suben.
 */
async function listDomainsSafe(client: PleskClient): Promise<PleskDomain[]> {
  try {
    return await client.listDomains();
  } catch (error) {
    if (error instanceof AppError && error.code === "PLESK_UNREACHABLE") {
      throw error;
    }
    return [];
  }
}

function orderCandidates(
  domains: PleskDomain[],
  target: PleskDomain,
  targetHome: string
): PleskDomain[] {
  const byId = new Map<number, PleskDomain>();
  for (const domain of domains) {
    if (domain.hosting_type && domain.hosting_type !== "virtual") continue;
    byId.set(domain.id, domain);
  }
  byId.set(target.id, target);

  const rank = (domain: PleskDomain): number => {
    if (domain.id === target.id) return 1;
    if (subscriptionRoot(domain) === targetHome) return 2;
    return 3;
  };

  return [...byId.values()].sort(
    (left, right) =>
      rank(left) - rank(right) || left.name.localeCompare(right.name)
  );
}

function isCommandExecutionDisabled(error: PleskHttpError): boolean {
  const text = redactText(`${error.message} ${error.body ?? ""}`).toLowerCase();
  return text.includes("command execution is disabled");
}

function getCache(client: PleskClient): Map<string, CachedAccess> {
  const existing = accessCache.get(client);
  if (existing) return existing;
  const created = new Map<string, CachedAccess>();
  accessCache.set(client, created);
  return created;
}

function getShellStatuses(client: PleskClient): Map<number, ShellStatus> {
  const existing = shellStatusCache.get(client);
  if (existing) return existing;
  const created = new Map<number, ShellStatus>();
  shellStatusCache.set(client, created);
  return created;
}

function normalizeRest(base: string): string {
  if (base.startsWith("/var/www/vhosts/")) return base;
  const clean = base.replace(/\\/g, "/");
  return clean.startsWith("/") ? clean : `/${clean}`;
}

function toRealPath(home: string, rest: string): string {
  if (
    rest.startsWith("/var/www/vhosts/") ||
    /^[A-Za-z]:[\\/]/.test(rest)
  ) {
    return rest;
  }
  const prefix = home === "/" ? "" : home.replace(/\/+$/, "");
  if (!prefix) return rest;
  return rest === "/" ? prefix : `${prefix}${rest}`;
}
