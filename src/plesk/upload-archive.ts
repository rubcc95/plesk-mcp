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

/** Resuelve exec, tar y la ruta temporal remota antes de subir nada. */
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
    // La subida siempre aterriza en el dominio destino (API fs), aunque el
    // shell que extrae sea de otro dominio.
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
      "No hay ficheros ni directorios que subir después de aplicar los filtros"
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
      "No se pudo crear el archivo tar.gz local",
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

/** Crea el tar.gz, lo sube y lo extrae en el servidor. */
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
            "El servidor no permite ejecutar comandos (exec)",
            {
              cause: error,
              hint: "Se usará la subida fichero a fichero por REST."
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
          `tar falló con código ${result.code} al extraer como ${target.execDomain.name}`,
          {
            hint:
              redactText(result.stderr || result.message || "") ||
              "El dominio alternativo no pudo escribir en el destino; se usará la subida fichero a fichero."
          }
        );
      }
      throw new AppError(
        "UPLOAD_EXTRACT_FAILED",
        `tar falló con código ${result.code} al extraer en ${options.remoteDir}`,
        { hint: redactText(result.stderr || result.message || "") || undefined }
      );
    }

    const detail = redactText(result.stderr || "").trim();
    if (detail) warnings.push(detail);
    if (target.foreign) {
      warnings.push(
        `Extracción ejecutada como el dominio ${target.execDomain.name}; revisa el propietario de los ficheros creados.`
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

/** Sube fichero a fichero en paralelo por REST, sin shell. */
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
