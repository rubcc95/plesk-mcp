import path from "node:path";
import picomatch from "picomatch";
import { AppError } from "../util/errors.js";
import { withRetry } from "../util/retry.js";
import { joinRemotePath } from "../config/paths.js";
import type { PleskClient } from "./client.js";

export type RemoteEntryType = "file" | "directory" | "symlink" | "unknown";

export interface RemoteEntry {
  name: string;
  path: string;
  type: RemoteEntryType;
  size: number | null;
}

export interface RemoteFile {
  remote: string;
  relative: string;
  size: number | null;
}

export interface RemoteDirectory {
  remote: string;
  relative: string;
}

export interface RemoteTree {
  files: RemoteFile[];
  directories: RemoteDirectory[];
  totalBytes: number;
  warnings: string[];
}

export interface WalkOptions {
  base: string;
  exclude: string[];
}

export interface WalkPlanFile extends RemoteFile {
  localRelative: string;
}

export interface WalkPlanDirectory extends RemoteDirectory {
  localRelative: string;
}

export interface WalkPlan {
  files: WalkPlanFile[];
  directories: WalkPlanDirectory[];
  totalBytes: number;
  warnings: string[];
}

const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Extracts the entries array from the different shapes returned by fs/list. */
export function parseEntries(value: unknown): RemoteEntry[] {
  return extractArray(value)
    .map(parseEntry)
    .filter((entry): entry is RemoteEntry => entry !== null);
}

export function parseEntry(value: unknown): RemoteEntry | null {
  if (!isRecord(value)) return null;

  const rawPath = typeof value.path === "string" ? value.path : undefined;
  const name =
    typeof value.name === "string" && value.name
      ? value.name
      : rawPath
        ? path.posix.basename(rawPath)
        : undefined;
  if (!name) return null;

  const typeRaw =
    typeof value.type === "string" ? value.type.toLowerCase() : undefined;
  const isDirectory =
    value.isDirectory === true ||
    value.is_dir === true ||
    typeRaw === "directory" ||
    typeRaw === "dir";
  const isSymlink =
    value.isSymlink === true ||
    value.is_symlink === true ||
    typeRaw === "symlink" ||
    typeRaw === "link";
  const isFile =
    value.isFile === true ||
    value.is_file === true ||
    typeRaw === "file";

  const type: RemoteEntryType = isSymlink
    ? "symlink"
    : isDirectory
      ? "directory"
      : isFile
        ? "file"
        : "unknown";

  return {
    name,
    path: rawPath ?? name,
    type,
    size: parseSize(value.size)
  };
}

/** Type of a remote path using fs/stat. */
export async function remotePathKind(
  client: PleskClient,
  remote: string
): Promise<"file" | "directory"> {
  const raw = await withRetry(() => client.fsStat(remote));
  const entry = parseEntry(raw);
  if (entry?.type === "file" || entry?.type === "directory") {
    return entry.type;
  }

  if (isRecord(raw)) {
    const typeRaw =
      typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
    if (typeRaw === "directory" || raw.isDirectory === true) return "directory";
    if (typeRaw === "file" || raw.isFile === true) return "file";
  }

  throw new AppError(
    "REMOTE_TYPE_UNKNOWN",
    `Could not determine whether ${remote} is a file or a directory`
  );
}

/** Walks the remote paths and returns files and directories. */
export async function walkRemote(
  client: PleskClient,
  roots: string[],
  options: WalkOptions
): Promise<RemoteTree> {
  const files: RemoteFile[] = [];
  const directories: RemoteDirectory[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  const matchesExclude = createExcludeMatcher(options.exclude);

  const pushFile = (file: RemoteFile): void => {
    totalBytes += file.size ?? 0;
    files.push(file);
  };

  const visit = async (
    current: string,
    currentRelative: string
  ): Promise<void> => {
    const entries = parseEntries(
      await withRetry(() => client.fsList(current))
    );

    for (const entry of entries) {
      if (!entry.name || entry.name === "." || entry.name === "..") continue;

      const remote = joinRemotePath(current, entry.name);
      const relative = joinRelative(currentRelative, entry.name);

      if (matchesExclude(relative)) continue;

      if (entry.type === "directory") {
        directories.push({ remote, relative });
        await visit(remote, relative);
        continue;
      }

      if (entry.type === "file") {
        pushFile({ remote, relative, size: entry.size });
        continue;
      }

      warnings.push(
        `Skipped ${remote}: ${entry.type === "symlink" ? "symbolic link" : "unsupported type"}`
      );
    }
  };

  for (const root of dedupeNested(roots)) {
    const relative = relativeTo(options.base, root);

    if (relative && matchesExclude(relative)) continue;

    const kind = await remotePathKind(client, root);
    if (kind === "file") {
      const stat = parseEntry(await withRetry(() => client.fsStat(root)));
      pushFile({ remote: root, relative, size: stat?.size ?? null });
      continue;
    }

    directories.push({ remote: root, relative });
    await visit(root, relative);
  }

  return { files, directories, totalBytes, warnings };
}

/** Computes the relative local path and validates names for Windows. */
export function buildWalkPlan(tree: RemoteTree): WalkPlan {
  const files = tree.files.map((file) => ({
    ...file,
    localRelative: file.relative
  }));

  const directories = tree.directories.map((directory) => ({
    ...directory,
    localRelative: directory.relative
  }));

  const unsafe = findUnsafeLocalNames([
    ...files.map((file) => file.localRelative),
    ...directories.map((directory) => directory.localRelative)
  ]);
  if (unsafe.length > 0) {
    throw new AppError(
      "WALK_UNSAFE_NAMES",
      `There are ${unsafe.length} path(s) that cannot be created on Windows`,
      {
        hint: `Examples: ${unsafe.slice(0, 10).join(", ")}. Exclude those paths or download them file by file.`
      }
    );
  }

  return {
    files,
    directories,
    totalBytes: tree.totalBytes,
    warnings: tree.warnings
  };
}

/** Names that Windows cannot create (for walk mode). */
export function findUnsafeLocalNames(paths: string[]): string[] {
  const unsafe: string[] = [];

  for (const value of paths) {
    const normalized = value.replace(/\\/g, "/");
    if (path.posix.isAbsolute(normalized)) {
      unsafe.push(`${value} (absolute path)`);
      continue;
    }

    const segments = normalized.split("/").filter(Boolean);
    if (segments.includes("..")) {
      unsafe.push(`${value} (contains ..)`);
      continue;
    }

    for (const segment of segments) {
      if (WINDOWS_INVALID.test(segment)) {
        unsafe.push(`${value} (invalid character)`);
        break;
      }
      if (/[. ]$/.test(segment)) {
        unsafe.push(`${value} (ends with a dot or space)`);
        break;
      }
      if (WINDOWS_RESERVED.test(segment)) {
        unsafe.push(`${value} (reserved name)`);
        break;
      }
    }
  }

  return unsafe;
}

export function relativeTo(base: string, remote: string): string {
  if (remote === base) return "";
  return path.posix.relative(base, remote);
}

function joinRelative(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function createExcludeMatcher(
  patterns: string[]
): (relative: string) => boolean {
  if (patterns.length === 0) return () => false;

  const matchPath = picomatch(patterns, { dot: true });
  const matchBasename = picomatch(patterns, { dot: true, basename: true });

  return (relative: string) => matchPath(relative) || matchBasename(relative);
}

function dedupeNested(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  return unique.filter(
    (candidate) =>
      !unique.some(
        (other) =>
          other !== candidate && candidate.startsWith(`${other}/`)
      )
  );
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  for (const key of ["entries", "data", "items", "files"]) {
    const child = value[key];
    if (Array.isArray(child)) return child;
    if (isRecord(child)) {
      const nested = extractArray(child);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function parseSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
