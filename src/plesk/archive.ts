import { randomUUID } from "node:crypto";
import { mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { AppError, PleskHttpError } from "../util/errors.js";
import { mapPool } from "../util/pool.js";
import { redactText } from "../util/redact.js";
import type { PleskClient } from "./client.js";
import { subscriptionRoot } from "./client.js";
import {
  clearExecAccessCache,
  resolveExecAccess,
  type ExecAccess
} from "./exec-access.js";
import { deleteRemoteIfExists, ensureRemoteDir, remoteExists } from "./fs-util.js";

const DEFAULT_TEMP_DIR = "/.plesk-mcp-tmp";
const EXCLUDE_PATTERN = /^[A-Za-z0-9._*?\[\]/-]+$/;
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export interface ExecPaths {
  home: string;
  prefix: string;
}

export interface ArchivePlanOptions {
  client: PleskClient;
  base: string;
  entries: string[];
  excludes: string[];
  dryRun?: boolean;
  access?: ExecAccess;
}

export interface ArchivePlan {
  /** Real root of the target subscription (system user home). */
  home: string;
  prefix: string;
  tarBinary: string;
  tempDirRest: string;
  restPath: string;
  realPath: string;
  command: string[];
  /** Domain whose shell is used. */
  execDomain: { id: number; name: string };
  foreign: boolean;
}

export interface RemoteArchive extends ArchivePlan {
  warnings: string[];
  bytes: number;
  /** Client for the domain hosting the file (the same one unless a foreign shell is used). */
  stagingClient: PleskClient;
}

export interface ArchiveEntryInfo {
  path: string;
  linkpath?: string;
  type?: string;
}

/**
 * Common ancestor of the parent directories of the given paths.
 * Example: ["/httpdocs/assets", "/httpdocs/index.php"] -> "/httpdocs".
 */
export function findArchiveBase(remotePaths: string[]): string {
  if (remotePaths.length === 0) {
    throw new AppError("ARCHIVE_NO_PATHS", "No remote path was provided");
  }

  let base = path.posix.dirname(remotePaths[0]!);
  for (const remotePath of remotePaths.slice(1)) {
    base = commonAncestor(base, path.posix.dirname(remotePath));
  }
  return base;
}

/** Paths relative to the base, without entries duplicated by nesting. */
export function archiveEntries(remotePaths: string[], base: string): string[] {
  const entries = unique(
    remotePaths.map((remotePath) => {
      const relative =
        base === "/" ? remotePath.replace(/^\/+/, "") : remotePath.slice(base.length + 1);
      if (!relative) {
        throw new AppError(
          "ARCHIVE_INVALID_ENTRY",
          `Path ${remotePath} is not relative to base ${base}`
        );
      }
      return relative;
    })
  );

  return entries.filter(
    (entry) =>
      !entries.some((other) => other !== entry && entry.startsWith(`${other}/`))
  );
}

export function validateExcludePatterns(patterns: string[]): string[] {
  return patterns.map((pattern) => {
    const value = pattern.trim();
    if (!value) {
      throw new AppError("ARCHIVE_EXCLUDE_INVALID", "An exclude pattern is empty");
    }
    if (value.startsWith("-") || !EXCLUDE_PATTERN.test(value)) {
      throw new AppError(
        "ARCHIVE_EXCLUDE_INVALID",
        `Invalid exclude pattern: ${pattern}`,
        { hint: "Only letters, numbers, and the characters . _ * ? [ ] / - are allowed" }
      );
    }
    if (value.length > 200) {
      throw new AppError(
        "ARCHIVE_EXCLUDE_INVALID",
        `Exclude pattern too long: ${pattern}`
      );
    }
    return value;
  });
}

/** Builds the tar command with a fixed binary and already validated arguments. */
export function buildTarArgs(options: {
  tarBinary: string;
  archiveRealPath: string;
  baseRealPath: string;
  entries: string[];
  excludes: string[];
}): string[] {
  const args = [
    options.tarBinary,
    "-czf",
    options.archiveRealPath,
    "-C",
    options.baseRealPath
  ];
  for (const exclude of options.excludes) args.push(`--exclude=${exclude}`);
  args.push("--", ...options.entries);
  return args;
}

/**
 * Translates a Plesk fs API path (relative to the subscription root)
 * to the real path seen by exec. Plesk runs commands in the subscription
 * user's home, so the usual prefix is /var/www/vhosts/<domain>.
 */
export async function resolveExecPaths(
  client: PleskClient,
  baseRest: string,
  access?: ExecAccess
): Promise<ExecPaths> {
  if (access) {
    const home = access.home;
    const target = toRealPath(home, baseRest);
    const exists = await access
      .exec(["test", "-e", target], undefined, null)
      .then((result) => result.code === 0)
      .catch(() => false);
    if (exists) {
      return { home, prefix: home === "/" ? "" : home.replace(/\/+$/, "") };
    }
  }

  const home = await resolveExecHome(client);
  const candidates = unique([
    toRealPath(home === "/" ? "" : home, baseRest),
    baseRest
  ]);

  for (const candidate of candidates) {
    if (await execPathExists(client, candidate)) {
      const prefix = prefixFor(candidate, baseRest);
      if (prefix !== null) return { home, prefix };
    }
  }

  const cwdResult = await client
    .exec(["pwd", "-P"], baseRest, null)
    .catch(() => null);
  if (cwdResult?.code === 0) {
    const realBase = lastLine(cwdResult.stdout ?? "");
    const prefix = prefixFor(realBase, baseRest);
    if (prefix !== null) return { home, prefix };
  }

  throw new AppError(
    "EXEC_PATH_MAPPING_FAILED",
    `Could not translate remote path ${baseRest} to a server path`,
    {
      hint: "Use doctor to check that exec works and that the path exists."
    }
  );
}

async function resolveExecHome(client: PleskClient): Promise<string> {
  const envResult = await client
    .exec(["printenv", "HOME"], undefined, null)
    .catch(() => null);
  const envHome =
    envResult?.code === 0 ? lastLine(envResult.stdout ?? "") : "";
  if (envHome.startsWith("/")) {
    return envHome.replace(/\/+$/, "") || "/";
  }

  let result;
  try {
    result = await client.exec(["pwd", "-P"], undefined, null);
  } catch (error) {
    if (
      error instanceof PleskHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new AppError(
        "EXEC_UNAVAILABLE",
        "The server does not allow running commands (exec)",
        {
          cause: error,
          hint:
            "Bulk download needs exec and tar. Subscriptions with a chrooted shell or no shell do not allow it; run doctor to check."
        }
      );
    }
    throw error;
  }

  if (result.code !== 0) {
    throw new AppError(
      "EXEC_UNAVAILABLE",
      "The server does not allow running commands (exec)",
      {
        hint:
          redactText(result.stderr || result.message || "") ||
          "Subscriptions with a chrooted shell or no shell do not allow exec."
      }
    );
  }

  const home = lastLine(result.stdout ?? "");
  if (!home.startsWith("/")) {
    throw new AppError(
      "EXEC_UNAVAILABLE",
      `exec returned an unexpected working directory: ${home || "(empty)"}`
    );
  }
  return home.replace(/\/+$/, "") || "/";
}

async function execPathExists(
  client: PleskClient,
  target: string
): Promise<boolean> {
  const result = await client
    .exec(["test", "-e", target], undefined, null)
    .catch(() => null);
  return result?.code === 0;
}

/** true if the path is already a real server path (not virtual to the subscription). */
export function isRealRemotePath(remotePath: string): boolean {
  return (
    remotePath.startsWith("/var/www/vhosts/") || /^[A-Za-z]:[\\/]/.test(remotePath)
  );
}

/**
 * Translates a Plesk fs API path (relative to the subscription root) to the
 * real path seen by exec. Paths that are already real are returned untouched,
 * so translating twice is harmless.
 */
export function toRealPath(prefix: string, restPath: string): string {
  if (isRealRemotePath(restPath)) return restPath;
  const cleanPrefix = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  if (!cleanPrefix) return restPath;
  return restPath === "/" ? cleanPrefix : `${cleanPrefix}${restPath}`;
}

function prefixFor(candidate: string, baseRest: string): string | null {
  if (baseRest === "/") {
    return candidate === "/" ? "" : candidate.replace(/\/+$/, "");
  }
  if (!candidate.endsWith(baseRest)) return null;
  const prefix = candidate.slice(0, candidate.length - baseRest.length);
  if (!prefix) {
    // An empty prefix only makes sense when the base is already a real path;
    // for a virtual base it would drop the subscription root from every
    // derived path (for example the temporary archive).
    return isRealRemotePath(baseRest) ? "" : null;
  }
  if (!prefix.startsWith("/")) return null;
  return prefix.replace(/\/+$/, "");
}

const tarBinaries = new WeakMap<PleskClient, Map<number, string>>();

export async function resolveTarBinary(
  client: PleskClient,
  access?: ExecAccess
): Promise<string> {
  const cacheKey = access?.domain.id ?? -1;
  let byDomain = tarBinaries.get(client);
  if (!byDomain) {
    byDomain = new Map<number, string>();
    tarBinaries.set(client, byDomain);
  }
  const cached = byDomain.get(cacheKey);
  if (cached) return cached;

  const run = (command: string[]) =>
    access ? access.exec(command, undefined, null) : client.exec(command, undefined, null);

  for (const candidate of ["tar", "/bin/tar", "/usr/bin/tar"]) {
    const result = await run([candidate, "--version"]).catch(() => null);
    if (result?.code === 0) {
      byDomain.set(cacheKey, candidate);
      return candidate;
    }
  }

  throw new AppError(
    "TAR_UNAVAILABLE",
    "The tar binary was not found on the server",
    { hint: "Bulk download needs tar (GNU tar) available to the subscription." }
  );
}

export async function planArchive(options: ArchivePlanOptions): Promise<ArchivePlan> {
  const { client, base, entries, excludes } = options;
  if (entries.length === 0) {
    throw new AppError("ARCHIVE_NO_ENTRIES", "There are no files or directories to package");
  }

  const access =
    options.access ??
    (await resolveExecAccess(client, { baseRest: base, need: "read" }));
  const execPaths = await resolveExecPaths(client, base, access);
  const tarBinary = await resolveTarBinary(client, access);
  const execHome = subscriptionRoot(access.domain) ?? access.home;
  const stagingClient =
    !options.dryRun && access.foreign
      ? client.scopedTo(access.domain)
      : client;
  const stagingBase = access.foreign ? "/" : base;
  const tempDirRest = options.dryRun
    ? DEFAULT_TEMP_DIR
    : await pickTempDir(stagingClient, stagingBase);
  const restPath = path.posix.join(
    tempDirRest,
    options.dryRun ? "<uuid>.tar.gz" : `${randomUUID()}.tar.gz`
  );
  const realPath = toRealPath(execHome, restPath);
  const baseRealPath = toRealPath(execPaths.prefix, base);

  return {
    home: execPaths.home,
    prefix: execPaths.prefix,
    tarBinary,
    tempDirRest,
    restPath,
    realPath,
    command: buildTarArgs({
      tarBinary,
      archiveRealPath: realPath,
      baseRealPath,
      entries,
      excludes
    }),
    execDomain: { id: access.domain.id, name: access.domain.name },
    foreign: access.foreign
  };
}

export async function createRemoteArchive(
  options: ArchivePlanOptions
): Promise<RemoteArchive> {
  const access =
    options.access ??
    (await resolveExecAccess(options.client, {
      baseRest: options.base,
      need: "read"
    }));
  const plan = await planArchive({ ...options, dryRun: false, access });
  const stagingClient = access.foreign
    ? options.client.scopedTo(access.domain)
    : options.client;
  const warnings: string[] = [];

  try {
    const result = await access.exec(plan.command, undefined, null);
    const exists = await remoteExists(stagingClient, plan.restPath).catch(
      () => false
    );

    if (result.code !== 0) {
      if (result.code === 1 && exists) {
        const detail = redactText(result.stderr || result.message || "").trim();
        warnings.push(
          `tar exited with code 1; the archive was created anyway${detail ? `: ${detail}` : ""}`
        );
      } else {
        if (plan.foreign) {
          throw new AppError(
            "EXEC_UNAVAILABLE",
            `tar failed with code ${result.code} using the shell of ${plan.execDomain.name}`,
            {
              hint:
                redactText(result.stderr || result.message || "") ||
                "The alternate domain could not package the target path; walk will be used."
            }
          );
        }
        throw new AppError(
          "TAR_FAILED",
          `tar failed with code ${result.code}`,
          { hint: redactText(result.stderr || result.message || "") || undefined }
        );
      }
    }

    if (!exists) {
      throw new AppError(
        "ARCHIVE_NOT_CREATED",
        `The remote archive ${plan.restPath} was not created`,
        { hint: redactText(result.stderr || result.message || "") || undefined }
      );
    }

    const info = await stagingClient.fsStat(plan.restPath);
    return { ...plan, warnings, bytes: extractSize(info) ?? 0, stagingClient };
  } catch (error) {
    await cleanupRemoteArchive(stagingClient, plan);
    if (
      error instanceof PleskHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      clearExecAccessCache(options.client);
      throw new AppError(
        "EXEC_UNAVAILABLE",
        "The server does not allow running commands (exec)",
        { cause: error, hint: "Use mode=walk or check the subscription shell." }
      );
    }
    throw error;
  }
}

export async function pickTempDir(
  client: PleskClient,
  base: string
): Promise<string> {
  const candidates = unique([
    DEFAULT_TEMP_DIR,
    path.posix.join(base === "/" ? "/" : base, ".plesk-mcp-tmp")
  ]);

  for (const candidate of candidates) {
    try {
      await ensureRemoteDir(client, candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new AppError(
    "ARCHIVE_TEMP_DIR_FAILED",
    "Could not create a temporary directory on the server",
    { hint: "Check write permissions on the subscription root." }
  );
}

/** Reads the archive's entry list without extracting it. */
export async function listArchiveEntries(
  archivePath: string
): Promise<ArchiveEntryInfo[]> {
  const entries: ArchiveEntryInfo[] = [];
  try {
    await tar.t({
      file: archivePath,
      onentry: (entry) => {
        entries.push({
          path: entry.path,
          linkpath: entry.linkpath,
          type: entry.type
        });
      }
    });
  } catch (error) {
    throw new AppError("ARCHIVE_LIST_FAILED", `Could not read ${archivePath}`, {
      cause: error
    });
  }
  return entries;
}

/** Returns the unsafe entries for a local extraction. */
export function findUnsafeEntries(entries: ArchiveEntryInfo[]): string[] {
  const unsafe: string[] = [];
  for (const entry of entries) {
    const reason = unsafeReason(entry);
    if (reason) unsafe.push(`${entry.path} (${reason})`);
  }
  return unsafe;
}

function unsafeReason(entry: ArchiveEntryInfo): string | null {
  const name = entry.path.replace(/\\/g, "/");
  if (path.posix.isAbsolute(name)) return "absolute path";

  const segments = name.split("/").filter((segment) => segment.length > 0);
  if (segments.includes("..")) return "contains ..";

  for (const segment of segments) {
    if (WINDOWS_INVALID.test(segment)) return "invalid Windows name";
    if (/[. ]$/.test(segment)) return "ends in a dot or space (invalid on Windows)";
    if (WINDOWS_RESERVED.test(segment)) return "reserved Windows name";
  }

  if (entry.linkpath) {
    const link = entry.linkpath.replace(/\\/g, "/");
    if (path.posix.isAbsolute(link)) return "absolute link";
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(name), link)
    );
    if (resolved === ".." || resolved.startsWith("../")) {
      return "link outside the destination";
    }
  }

  return null;
}

/** Errors that allow falling back to REST mode without a shell. */
const FALLBACK_CODES = new Set([
  "EXEC_UNAVAILABLE",
  "EXEC_PATH_MAPPING_FAILED",
  "TAR_UNAVAILABLE",
  "UPLOAD_ARCHIVE_NOT_UPLOADED"
]);

export function isExecFallbackError(error: unknown): boolean {
  return error instanceof AppError && FALLBACK_CODES.has(error.code);
}

/** Extracts the archive locally, validating all entries first. */
export async function extractArchive(options: {
  archivePath: string;
  localDir: string;
  overwrite: boolean;
}): Promise<{ entries: number; skipped: number }> {
  const entries = await listArchiveEntries(options.archivePath);
  const unsafe = findUnsafeEntries(entries);
  if (unsafe.length > 0) {
    throw new AppError(
      "ARCHIVE_UNSAFE_ENTRIES",
      `The archive contains paths that are unsafe for Windows (${unsafe.length})`,
      {
        hint: `Examples: ${unsafe.slice(0, 10).join(", ")}. Exclude those paths or download them file by file.`
      }
    );
  }

  await mkdir(options.localDir, { recursive: true });

  const skipped = options.overwrite
    ? 0
    : await countExistingTargets(entries, options.localDir);

  let count = 0;
  try {
    await tar.x({
      file: options.archivePath,
      cwd: options.localDir,
      keep: !options.overwrite,
      onentry: (entry) => {
        if (entry.type !== "Directory") count += 1;
      }
    });
  } catch (error) {
    throw new AppError(
      "EXTRACT_FAILED",
      `Could not extract the archive into ${options.localDir}`,
      { cause: error }
    );
  }

  return { entries: count, skipped };
}

async function countExistingTargets(
  entries: ArchiveEntryInfo[],
  localDir: string
): Promise<number> {
  const root = path.resolve(localDir);
  const targets = entries
    .filter((entry) => entry.type !== "Directory")
    .map((entry) => entry.path.split("/").filter(Boolean).join("/"))
    .filter((relative) => relative.length > 0);

  const found = await mapPool(targets, 8, async (relative) => {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) return false;
    const info = await stat(full).catch(() => null);
    return info?.isFile() === true;
  });

  return found.filter(Boolean).length;
}

/**
 * Deletes the remote temporary archive. The temporary directory is left in
 * place: it is shared by concurrent transfers and removing it can make another
 * in-flight upload lose its staging path.
 */
export async function cleanupRemoteArchive(
  client: PleskClient,
  archive: Pick<RemoteArchive, "restPath" | "tempDirRest"> & {
    stagingClient?: PleskClient;
  }
): Promise<void> {
  const target = archive.stagingClient ?? client;
  await deleteRemoteIfExists(target, archive.restPath, false).catch(() => undefined);
}

/** Deletes a local file if it exists. */
export async function removeLocalFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

function commonAncestor(a: string, b: string): string {
  if (a === "/" || b === "/") return "/";
  const aParts = a.split("/").filter(Boolean);
  const bParts = b.split("/").filter(Boolean);
  const shared: string[] = [];
  for (let index = 0; index < Math.min(aParts.length, bParts.length); index += 1) {
    const part = aParts[index];
    if (part !== bParts[index]) break;
    shared.push(part!);
  }
  return shared.length > 0 ? `/${shared.join("/")}` : "/";
}

function lastLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractSize(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (record.size !== undefined) return extractSize(record.size);
  if (record.data !== undefined) return extractSize(record.data);
  if (record.stat !== undefined) return extractSize(record.stat);
  if (record.file !== undefined) return extractSize(record.file);
  return null;
}
