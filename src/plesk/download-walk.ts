import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../util/errors.js";
import { mapPool } from "../util/pool.js";
import { withRetry } from "../util/retry.js";
import type { PleskClient } from "./client.js";
import {
  buildWalkPlan,
  walkRemote,
  type WalkPlan
} from "./remote-tree.js";

const TRANSFER_CONCURRENCY = 4;

export interface WalkDownloadOptions {
  client: PleskClient;
  remotePaths: string[];
  base: string;
  localDir: string;
  exclude: string[];
  overwrite: boolean;
  keepEmptyDirs: boolean;
}

export interface WalkDownloadResult {
  files: number;
  directories: number;
  totalBytes: number;
  downloaded: number;
  downloadedBytes: number;
  skipped: number;
  warnings: string[];
  elapsedMs: number;
}

export function walkPlanSummary(plan: WalkPlan): {
  files: number;
  directories: number;
  bytes: number;
  sample: Array<{ remote: string; local: string }>;
  warnings: string[];
} {
  return {
    files: plan.files.length,
    directories: plan.directories.length,
    bytes: plan.totalBytes,
    sample: plan.files.slice(0, 50).map((file) => ({
      remote: file.remote,
      local: file.localRelative
    })),
    warnings: plan.warnings
  };
}

/** Computes which files would be downloaded without writing anything locally. */
export async function planWalk(
  options: WalkDownloadOptions
): Promise<WalkPlan> {
  const tree = await walkRemote(options.client, options.remotePaths, {
    base: options.base,
    exclude: options.exclude
  });

  return buildWalkPlan(tree);
}

/** Downloads file by file in parallel using the REST API. */
export async function downloadWalk(
  options: WalkDownloadOptions
): Promise<WalkDownloadResult> {
  const startedAt = Date.now();
  const plan = await planWalk(options);
  const localDir = path.resolve(options.localDir);

  if (options.keepEmptyDirs) {
    for (const directory of plan.directories) {
      await mkdir(localTarget(localDir, directory.localRelative), {
        recursive: true
      });
    }
  }

  let downloaded = 0;
  let downloadedBytes = 0;
  let skipped = 0;

  await mapPool(plan.files, TRANSFER_CONCURRENCY, async (file) => {
    const local = localTarget(localDir, file.localRelative);

    if (!options.overwrite) {
      const existing = await stat(local).catch(() => null);
      if (existing?.isFile()) {
        skipped += 1;
        return;
      }
    }

    await mkdir(path.dirname(local), { recursive: true });
    const result = await withRetry(() =>
      options.client.fsDownloadToFile(file.remote, local)
    );
    downloaded += 1;
    downloadedBytes += result.bytes;
  });

  return {
    files: plan.files.length,
    directories: plan.directories.length,
    totalBytes: plan.totalBytes,
    downloaded,
    downloadedBytes,
    skipped,
    warnings: plan.warnings,
    elapsedMs: Date.now() - startedAt
  };
}

function localTarget(localDir: string, relative: string): string {
  const target = path.resolve(localDir, relative);
  if (target !== localDir && !target.startsWith(`${localDir}${path.sep}`)) {
    throw new AppError(
      "LOCAL_PATH_OUTSIDE_PROJECT",
      `The computed local path falls outside the destination: ${target}`
    );
  }
  return target;
}
