import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { joinRemotePath } from "../config/paths.js";
import { sha256File } from "../util/hash.js";
import { AppError, PleskHttpError } from "../util/errors.js";
import { mapPool } from "../util/pool.js";
import { redactText } from "../util/redact.js";
import { withRetry } from "../util/retry.js";
import type { PleskClient } from "./client.js";
import {
  clearExecAccessCache,
  resolveExecAccess,
  type ExecAccess
} from "./exec-access.js";
import {
  cleanupRemoteArchive,
  pickTempDir,
  resolveExecPaths,
  resolveTarBinary,
  toRealPath
} from "./archive.js";
import { ensureRemoteDir, remoteExists } from "./fs-util.js";
import {
  buildLocalPlan,
  collectLocalTree,
  localPlanSummary,
  type LocalPlan,
  type ResolvedLocalEntry
} from "./local-tree.js";
import { uploadFile } from "./upload-file.js";

const TRANSFER_CONCURRENCY = 4;

export interface UploadArchiveOptions {
  client: PleskClient;
  projectRoot: string;
  entries: ResolvedLocalEntry[];
  remoteDir: string;
  exclude: string[];
  overwrite: boolean;
  chunkSizeMb: number;
  keepEmptyDirs: boolean;
}

export interface ArchiveTarget {
  home: string;
  prefix: string;
  tarBinary: string;
  tempDirRest: string;
  restPath: string;
  realPath: string;
  realRemoteDir: string;
  execDomain: { id: number; name: string };
  foreign: boolean;
  access: ExecAccess;
}

export async function planUpload(
  options: UploadArchiveOptions
): Promise<LocalPlan> {
  const tree = await collectLocalTree(options.entries, {
    exclude: options.exclude
  });

  return buildLocalPlan(tree);
}

/** Resolves exec, tar, and the remote temporary path before uploading anything. */
export async function prepareArchiveTarget(
  client: PleskClient,
  remoteDir: string,
  dryRun = false,
  accessOverride?: ExecAccess
): Promise<ArchiveTarget> {
  const probeBase = dryRun ? "/" : remoteDir;
  const access =
    accessOverride ??
    (await resolveExecAccess(client, {
      baseRest: probeBase,
      need: "write"
    }));
  const execPaths = await resolveExecPaths(client, probeBase, access);
  const tarBinary = await resolveTarBinary(client, access);
  const tempDirRest = dryRun
    ? "/.plesk-mcp-tmp"
    : await pickTempDir(client, remoteDir);
  const restPath = path.posix.join(
    tempDirRest,
    dryRun ? "<uuid>.tar.gz" : `${randomUUID()}.tar.gz`
  );

  return {
    home: execPaths.home,
    prefix: execPaths.prefix,
    tarBinary,
    tempDirRest,
    restPath,
    // The upload always lands on the target domain (fs API), even if the
    // shell that extracts belongs to another domain.
    realPath: toRealPath(execPaths.prefix, restPath),
    realRemoteDir: toRealPath(execPaths.prefix, remoteDir),
    execDomain: { id: access.domain.id, name: access.domain.name },
    foreign: access.foreign,
    access
  };
}

export function buildExtractArgs(options: {
  tarBinary: string;
  realArchivePath: string;
  realRemoteDir: string;
  overwrite: boolean;
}): string[] {
  const args = [
    options.tarBinary,
    "-xzf",
    options.realArchivePath,
    "-C",
    options.realRemoteDir,
    "--no-same-owner"
  ];
  if (!options.overwrite) args.push("--skip-old-files");
  return args;
}

export async function createLocalArchive(
  plan: LocalPlan,
  options: UploadArchiveOptions
): Promise<{ localArchive: string; bytes: number; sha256: string }> {
  const entries = [
    ...plan.directories.map((directory) => directory.relative),
    ...plan.files.map((file) => file.relative)
  ];
  if (entries.length === 0) {
    throw new AppError(
      "UPLOAD_EMPTY",
      "There are no files or directories to upload after applying the filters"
    );
  }

  const localArchive = path.join(
    options.projectRoot,
    ".plesk",
    "tmp",
    `${randomUUID()}.tar.gz`
  );

  await mkdir(path.dirname(localArchive), { recursive: true });

  try {
    await tar.c(
      {
        file: localArchive,
        cwd: plan.base,
        gzip: true,
        portable: true,
        noDirRecurse: true
      },
      entries
    );
  } catch (error) {
    await rm(localArchive, { force: true }).catch(() => undefined);
    throw new AppError(
      "UPLOAD_ARCHIVE_FAILED",
      "Could not create the local tar.gz archive",
      { cause: error }
    );
  }

  const info = await stat(localArchive);
  return {
    localArchive,
    bytes: info.size,
    sha256: await sha256File(localArchive)
  };
}

/** Creates the tar.gz, uploads it, and extracts it on the server. */
export async function uploadArchive(options: UploadArchiveOptions) {
  const startedAt = Date.now();
  const plan = await planUpload(options);
  await withRetry(() => ensureRemoteDir(options.client, options.remoteDir));
  const target = await prepareArchiveTarget(
    options.client,
    options.remoteDir
  );
  const warnings = [...plan.warnings];
  let local: { localArchive: string; bytes: number; sha256: string } | null =
    null;

  try {
    local = await createLocalArchive(plan, options);
    await withRetry(() =>
      uploadFile(options.client, local!.localArchive, target.restPath, {
        chunkSizeMb: options.chunkSizeMb,
        overwrite: true
      })
    );

    const command = buildExtractArgs({
      tarBinary: target.tarBinary,
      realArchivePath: target.realPath,
      realRemoteDir: target.realRemoteDir,
      overwrite: options.overwrite
    });

    const result = await withRetry(() =>
      target.access.exec(command, undefined, null).catch((error) => {
        if (
          error instanceof PleskHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          clearExecAccessCache(options.client);
          throw new AppError(
            "EXEC_UNAVAILABLE",
            "The server does not allow running commands (exec)",
            {
              cause: error,
              hint: "File-by-file upload over REST will be used."
            }
          );
        }
        throw error;
      })
    );

    if (result.code !== 0) {
      if (target.foreign) {
        throw new AppError(
          "EXEC_UNAVAILABLE",
          `tar failed with code ${result.code} while extracting as ${target.execDomain.name}`,
          {
            hint:
              redactText(result.stderr || result.message || "") ||
              "The alternate domain could not write to the destination; file-by-file upload will be used."
          }
        );
      }
      throw new AppError(
        "UPLOAD_EXTRACT_FAILED",
        `tar failed with code ${result.code} while extracting into ${options.remoteDir}`,
        { hint: redactText(result.stderr || result.message || "") || undefined }
      );
    }

    const detail = redactText(result.stderr || "").trim();
    if (detail) warnings.push(detail);
    if (target.foreign) {
      warnings.push(
        `Extraction run as domain ${target.execDomain.name}; check the owner of the created files.`
      );
    }

    const skipped = options.overwrite
      ? 0
      : await countExistingRemoteFiles(
          options.client,
          options.remoteDir,
          plan.files.map((file) => file.remoteRelative)
        );

    return {
      mode: "archive" as const,
      base: plan.base,
      files: plan.files.length,
      directories: plan.directories.length,
      bytes: plan.totalBytes,
      archiveBytes: local.bytes,
      sha256: local.sha256,
      remoteDir: options.remoteDir,
      execDomain: target.execDomain.name,
      skipped,
      warnings,
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    await cleanupRemoteArchive(options.client, target);
    if (local) {
      await rm(local.localArchive, { force: true }).catch(() => undefined);
    }
  }
}

/** Uploads file by file in parallel over REST, without a shell. */
export async function uploadWalk(options: UploadArchiveOptions) {
  const startedAt = Date.now();
  const plan = await planUpload(options);
  await withRetry(() => ensureRemoteDir(options.client, options.remoteDir));

  if (options.keepEmptyDirs) {
    const directories = [...new Set(
      plan.directories
        .map((directory) => directory.remoteRelative)
        .filter((relative) => relative.length > 0)
    )].sort((left, right) => left.split("/").length - right.split("/").length);

    for (const relative of directories) {
      await withRetry(() =>
        ensureRemoteDir(
          options.client,
          joinRemotePath(options.remoteDir, relative)
        )
      );
    }
  }

  let uploaded = 0;
  let uploadedBytes = 0;
  let skipped = 0;

  await mapPool(
    plan.files,
    TRANSFER_CONCURRENCY,
    async (file) => {
      const remote = joinRemotePath(options.remoteDir, file.remoteRelative);

      if (
        !options.overwrite &&
        (await withRetry(() => remoteExists(options.client, remote)))
      ) {
        skipped += 1;
        return;
      }

      const result = await withRetry(() =>
        uploadFile(options.client, file.absolute, remote, {
          chunkSizeMb: options.chunkSizeMb,
          overwrite: true
        })
      );
      uploaded += 1;
      uploadedBytes += result.bytes;
    }
  );

  return {
    mode: "walk" as const,
    base: plan.base,
    files: plan.files.length,
    directories: plan.directories.length,
    totalBytes: plan.totalBytes,
    uploaded,
    uploadedBytes,
    skipped,
    warnings: plan.warnings,
    elapsedMs: Date.now() - startedAt
  };
}

export function uploadPlanSummary(plan: LocalPlan) {
  return localPlanSummary(plan);
}

async function countExistingRemoteFiles(
  client: PleskClient,
  remoteDir: string,
  relatives: string[]
): Promise<number> {
  const found = await mapPool(relatives, TRANSFER_CONCURRENCY, async (relative) => {
    if (!relative) return false;
    return withRetry(() =>
      remoteExists(client, joinRemotePath(remoteDir, relative))
    );
  });
  return found.filter(Boolean).length;
}
