import { AppError, PleskHttpError } from "../util/errors.js";
import { redactText } from "../util/redact.js";
import {
  subscriptionRoot,
  type PleskClient,
  type PleskDomain,
  type PleskExecResult
} from "./client.js";

/** Timeout per shell probe (like the dashboard: 8 s). */
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CANDIDATES = 25;
const CACHE_TTL_MS = 5 * 60_000;

export type ExecNeed = "read" | "write";

/** Resolved shell access for operating on a path in the target subscription. */
export interface ExecAccess {
  /** Configured domain (owner of the files and of the fs API). */
  target: PleskDomain;
  /** Domain that runs the commands (may be different). */
  domain: PleskDomain;
  /** Real root of the target subscription. */
  home: string;
  /** true if the shell belongs to another domain/subscription. */
  foreign: boolean;
  exec(
    command: string[],
    cwd?: string,
    timeoutMs?: number | null
  ): Promise<PleskExecResult>;
}

export interface ExecAccessOptions {
  /** Remote path relative to the target subscription (e.g. `/httpdocs`). */
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
 * Finds a usable shell to read/write a path in the target domain.
 *
 * Candidate order:
 * 1. Domain selected by the tool (the normal case).
 * 2. Domains in the same subscription (addon/subdomains: same user).
 * 3. Remaining domains with physical hosting.
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
      `Could not determine the real root of domain ${target.name}`,
      { hint: "Check the domain's www_root in Plesk." }
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
    "No domain on the server allows running commands for this path",
    {
      hint:
        (commandExecutionDisabled.get(client)
          ? "Command execution is disabled in the Plesk REST extension. "
          : "") +
        `Probed ${probed.length} domain(s). Enable SSH access (shell /bin/bash) on a subscription or use walk mode.`
    }
  );
}

/** Finds a domain with a shell without checking specific paths (for doctor). */
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

/** Shell from any domain, without depending on a specific subscription. */
export interface ShellAccess {
  domain: PleskDomain;
  exec(command: string[], timeoutMs?: number | null): Promise<PleskExecResult>;
}

/**
 * Finds any domain with a shell that also satisfies `require` (for example,
 * having the `mysql` client). It does not check paths or subscriptions: it is
 * meant for global server tasks, such as running SQL.
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

/** Invalidates a client's cache (after an unexpected shell failure). */
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
          "Command execution is disabled in Plesk",
          {
            hint:
              "Enable it in the REST extension settings (domainCommandExecutionEnabled) or use walk mode."
          }
        );
      }
      // 403/404 for a domain without a shell, without hosting, or deleted: try the next one.
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
 * Lists domains without breaking the operation if the API key cannot list them
 * (for example, a restricted customer key). Network errors do propagate.
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
