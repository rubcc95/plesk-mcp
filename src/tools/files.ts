import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  resolveLocalPath,
  resolveRemotePath
} from "../config/paths.js";
import {
  archiveEntries,
  cleanupRemoteArchive,
  createRemoteArchive,
  extractArchive,
  findArchiveBase,
  isExecFallbackError,
  planArchive,
  validateExcludePatterns
} from "../plesk/archive.js";
import {
  downloadWalk,
  planWalk,
  walkPlanSummary
} from "../plesk/download-walk.js";
import { resolveLocalEntry } from "../plesk/local-tree.js";
import {
  buildExtractArgs,
  planUpload,
  prepareArchiveTarget,
  uploadArchive,
  uploadPlanSummary,
  uploadWalk,
  type UploadArchiveOptions
} from "../plesk/upload-archive.js";
import { remotePathKind } from "../plesk/remote-tree.js";
import type { PleskClient } from "../plesk/client.js";
import {
  ensureRemoteDir,
  remoteExists
} from "../plesk/fs-util.js";
import { AppError, asAppError } from "../util/errors.js";
import { sha256Buffer, sha256File } from "../util/hash.js";
import { withRetry } from "../util/retry.js";
import { runTool } from "../util/result.js";
import { uploadFile } from "../plesk/upload-file.js";
import type { ToolContext } from "./context.js";
import {
  listArg,
  textArg,
  type ToolPolicy,
  type ToolRegistrar
} from "./policy.js";

const MAX_READ_BYTES = 10 * 1024 * 1024;
const DEFAULT_CHUNK_MB = 4;

const serverField = z
  .string()
  .optional()
  .describe("Server name; if omitted, the default is used");

const domainField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Subscription domain; if omitted and the server has only one, it is auto-detected"
  );

const readPolicy: ToolPolicy = { safety: "read" };

async function scoped(
  ctx: ToolContext,
  serverName?: string,
  domainName?: string
) {
  const runtime = ctx.registry.resolve(serverName);
  const domain = await runtime.client.resolveDomain(domainName);
  return { runtime, domain, client: runtime.client.scopedTo(domain) };
}

export function registerFileTools(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    "file_list",
    readPolicy,
    {
      title: "List remote files",
      description:
        "Lists the contents of an absolute Plesk directory, for example /httpdocs.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1).describe("Absolute path, for example /httpdocs"),
        recursive: z.boolean().optional(),
        maxDepth: z.number().int().min(1).max(5).optional()
      }
    },
    async ({ server: serverName, domain: domainName, path: input, recursive, maxDepth }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const root = resolveRemotePath(input);
        if (!recursive) {
          return { domain: domain.name, path: root, entries: await client.fsList(root) };
        }
        return {
          domain: domain.name,
          path: root,
          entries: await listTree(client, root, maxDepth ?? 2)
        };
      })
  );

  registrar.registerTool(
    "file_stat",
    readPolicy,
    {
      title: "Metadata of a remote file",
      description: "Returns size, type, permissions and modification date.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1)
      }
    },
    async ({ server: serverName, domain: domainName, path: input }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const remote = resolveRemotePath(input);
        return { domain: domain.name, path: remote, stat: await client.fsStat(remote) };
      })
  );

  registrar.registerTool(
    "file_read",
    readPolicy,
    {
      title: "Read a remote file",
      description:
        "Reads a text file (utf8) or binary file (base64). Size is limited to avoid filling the context.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1),
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z.number().int().positive().max(MAX_READ_BYTES).optional()
      }
    },
    async ({ server: serverName, domain: domainName, path: input, encoding, maxBytes }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const remote = resolveRemotePath(input);
        const limit = maxBytes ?? 1024 * 1024;
        const buffer = await client.fsRead(remote);
        if (buffer.length > limit) {
          throw new AppError(
            "FILE_TOO_LARGE",
            `The file is ${buffer.length} bytes and the limit is ${limit}`,
            { hint: "Increase maxBytes or use file_download." }
          );
        }
        const selected = encoding ?? "utf8";
        return {
          domain: domain.name,
          path: remote,
          bytes: buffer.length,
          encoding: selected,
          content:
            selected === "base64" ? buffer.toString("base64") : buffer.toString("utf8")
        };
      })
  );

  registrar.registerTool(
    "file_write",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Write ${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes to ${textArg(args, "path")}`
    },
    {
      title: "Write a remote file",
      description:
        "Writes text or base64 content to an absolute remote path. Creates parent directories by default.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        createDirs: z.boolean().optional(),
        mode: z.string().regex(/^[0-7]{3,4}$/).optional()
      }
    },
    async ({ server: serverName, domain: domainName, path: input, content, encoding, createDirs, mode }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const remote = resolveRemotePath(input);
        if (createDirs !== false) {
          await ensureRemoteDir(client, path.posix.dirname(remote));
        }
        const buffer =
          encoding === "base64"
            ? Buffer.from(content, "base64")
            : Buffer.from(content, "utf8");
        await client.fsWrite(remote, buffer);
        if (mode) await client.fsChmod(remote, mode);
        return {
          domain: domain.name,
          path: remote,
          bytes: buffer.length,
          sha256: sha256Buffer(buffer)
        };
      })
  );

  registrar.registerTool(
    "file_upload",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Upload ${listArg(args, "local_paths").length} local path(s) to ${textArg(args, "remote")}${
          args.overwrite === false ? " without overwriting" : ""
        }`
    },
    {
      title: "Upload local files or directories",
      description:
        "Uploads one or more local paths. A single file is uploaded directly in chunks to the given remote path. Multiple files or any directory use the remote directory and transfer with tar.gz, with a parallel REST fallback when there is no shell.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        local_paths: z
          .array(z.string().min(1))
          .min(1)
          .describe("Local project paths; may be files or directories"),
        remote: z
          .string()
          .min(1)
          .describe(
            "With a single file, the exact remote file path; otherwise, the absolute remote directory"
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe("false: files that already exist on the server are skipped"),
        chunk_size_mb: z.number().positive().max(50).optional(),
        mode: z
          .string()
          .regex(/^[0-7]{3,4}$/)
          .optional()
          .describe("Permissions for the direct upload of a single file"),
        exclude: z
          .array(z.string().min(1))
          .optional()
          .describe("Exclude patterns, for example node_modules or *.map"),
        keep_empty_dirs: z.boolean().optional(),
        dry_run: z.boolean().optional()
      }
    },
    async (input) =>
      runTool(async () => {
        const startedAt = Date.now();
        const { runtime, client, domain } = await scoped(
          ctx,
          input.server,
          input.domain
        );
        const name = runtime.name;
        const entries = await Promise.all(
          input.local_paths.map((localPath) =>
            resolveLocalEntry(ctx.projectRoot, localPath)
          )
        );
        const remote = resolveRemotePath(input.remote);
        const overwrite = input.overwrite ?? true;
        const chunkSizeMb = input.chunk_size_mb ?? DEFAULT_CHUNK_MB;
        const isDirect = entries.length === 1 && entries[0]?.type === "file";

        if (input.mode && !isDirect) {
          throw new AppError(
            "MODE_NOT_SUPPORTED",
            "mode only applies to the direct upload of a single file",
            { hint: "Remove mode or upload the file separately." }
          );
        }

        if (isDirect) {
          const entry = entries[0]!;
          const info = await stat(entry.absolute);
          const baseMeta = {
            server: name,
            domain: domain.name,
            localPaths: input.local_paths,
            remotePath: remote
          };

          if (input.dry_run) {
            return {
              dryRun: true,
              mode: "direct",
              fallbackReason: null,
              ...baseMeta,
              bytes: info.size,
              overwrite
            };
          }

          if (!overwrite && (await withRetry(() => remoteExists(client, remote)))) {
            return {
              ...baseMeta,
              mode: "direct",
              fallbackReason: null,
              uploaded: 0,
              skipped: 1,
              elapsedMs: Date.now() - startedAt
            };
          }

          const result = await withRetry(() =>
            uploadFile(client, entry.absolute, remote, {
              chunkSizeMb,
              mode: input.mode,
              overwrite
            })
          );

          return {
            ...baseMeta,
            mode: "direct",
            fallbackReason: null,
            ...result,
            elapsedMs: Date.now() - startedAt
          };
        }

        const remoteDir = remote;
        const options: UploadArchiveOptions = {
          client,
          projectRoot: ctx.projectRoot,
          entries,
          remoteDir,
          exclude: validateExcludePatterns(input.exclude ?? []),
          overwrite,
          chunkSizeMb,
          keepEmptyDirs: input.keep_empty_dirs ?? true
        };

        const baseMeta = {
          server: name,
          domain: domain.name,
          localPaths: input.local_paths,
          remoteDir
        };

        if (input.dry_run) {
          const plan = await planUpload(options);
          const summary = uploadPlanSummary(plan);

          const walkPlan = (fallbackReason: string | null) => ({
            dryRun: true,
            mode: "walk",
            fallbackReason,
            ...baseMeta,
            base: plan.base,
            ...summary
          });

          const archivePlan = async (fallbackReason: string | null) => {
            const target = await prepareArchiveTarget(client, remoteDir, true);
            return {
              dryRun: true,
              mode: "archive",
              fallbackReason,
              ...baseMeta,
              base: plan.base,
              ...summary,
              exec: {
                home: target.home,
                prefix: target.prefix,
                tar: target.tarBinary,
                domain: target.execDomain.name,
                foreign: target.foreign
              },
              extractCommand: buildExtractArgs({
                tarBinary: target.tarBinary,
                realArchivePath: target.realPath,
                realRemoteDir: target.realRemoteDir,
                overwrite
              })
            };
          };

          try {
            return await archivePlan(null);
          } catch (error) {
            if (!isExecFallbackError(error)) throw error;
            return walkPlan(asAppError(error).code);
          }
        }

        const finish = <T extends object>(
          result: T,
          fallbackReason: string | null
        ) => ({
          ...baseMeta,
          ...result,
          fallbackReason,
          elapsedMs: Date.now() - startedAt
        });

        try {
          return finish(await uploadArchive(options), null);
        } catch (error) {
          if (!isExecFallbackError(error)) throw error;
          return finish(await uploadWalk(options), asAppError(error).code);
        }
      })
  );

  registrar.registerTool(
    "file_download",
    readPolicy,
    {
      title: "Download remote files or directories",
      description:
        "Downloads one or more remote paths. A single file is downloaded directly to the given local path. Multiple files or any directory use the local directory and transfer with tar.gz, with a parallel REST fallback when there is no shell.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        remote_paths: z
          .array(z.string().min(1))
          .min(1)
          .describe("Absolute remote paths; may be files or directories"),
        local: z
          .string()
          .min(1)
          .describe(
            "With a single remote file, the exact local file path; otherwise, the local directory"
          ),
        exclude: z
          .array(z.string().min(1))
          .optional()
          .describe("Exclude patterns, for example node_modules or *.log"),
        overwrite: z
          .boolean()
          .optional()
          .describe("false: existing files are skipped"),
        keep_empty_dirs: z.boolean().optional(),
        dry_run: z.boolean().optional()
      }
    },
    async (input) =>
      runTool(async () => {
        const startedAt = Date.now();
        const { runtime, client, domain } = await scoped(
          ctx,
          input.server,
          input.domain
        );
        const name = runtime.name;
        const remotePaths = input.remote_paths.map((remote) =>
          resolveRemotePath(remote)
        );

        for (const remote of remotePaths) {
          const exists = await withRetry(() =>
            remoteExists(client, remote)
          );
          if (!exists) {
            throw new AppError(
              "REMOTE_NOT_FOUND",
              `Remote path ${remote} does not exist`,
              { hint: "Check the path with file_list or file_stat." }
            );
          }
        }

        const overwrite = input.overwrite ?? true;
        const singleRemote = remotePaths.length === 1 ? remotePaths[0]! : null;
        const isDirect =
          singleRemote !== null &&
          (await withRetry(() => remotePathKind(client, singleRemote))) ===
            "file";

        if (isDirect) {
          const local = resolveLocalPath(ctx.projectRoot, input.local);
          const baseMeta = {
            server: name,
            domain: domain.name,
            remotePath: singleRemote,
            local
          };

          if (input.dry_run) {
            return {
              dryRun: true,
              mode: "direct",
              fallbackReason: null,
              ...baseMeta,
              overwrite
            };
          }

          if (!overwrite) {
            const existing = await stat(local).catch(() => null);
            if (existing?.isFile()) {
              return {
                ...baseMeta,
                mode: "direct",
                fallbackReason: null,
                downloaded: 0,
                skipped: 1,
                elapsedMs: Date.now() - startedAt
              };
            }
          }

          await mkdir(path.dirname(local), { recursive: true });
          const downloaded = await withRetry(() =>
            client.fsDownloadToFile(singleRemote, local)
          );

          return {
            ...baseMeta,
            mode: "direct",
            fallbackReason: null,
            bytes: downloaded.bytes,
            sha256: await sha256File(local),
            elapsedMs: Date.now() - startedAt
          };
        }

        const base = findArchiveBase(remotePaths);
        const getEntries = () => archiveEntries(remotePaths, base);
        const excludes = validateExcludePatterns(input.exclude ?? []);
        const localDir = resolveLocalPath(ctx.projectRoot, input.local);

        const walkOptions = {
          client,
          remotePaths,
          base,
          localDir,
          exclude: excludes,
          overwrite,
          keepEmptyDirs: input.keep_empty_dirs ?? true
        };

        const runArchiveDryRun = async (fallbackReason: string | null) => {
          const entries = getEntries();
          const plan = await planArchive({
            client,
            base,
            entries,
            excludes,
            dryRun: true
          });
          return {
            dryRun: true,
            mode: "archive",
            fallbackReason,
            server: name,
            domain: domain.name,
            remotePaths,
            base,
            entries,
            exclude: excludes,
            exec: {
              home: plan.home,
              prefix: plan.prefix,
              tar: plan.tarBinary,
              domain: plan.execDomain.name,
              foreign: plan.foreign
            },
            command: plan.command
          };
        };

        const runWalkDryRun = async (fallbackReason: string | null) => {
          const plan = await planWalk(walkOptions);
          return {
            dryRun: true,
            mode: "walk",
            fallbackReason,
            server: name,
            domain: domain.name,
            remotePaths,
            base,
            localDir,
            exclude: excludes,
            ...walkPlanSummary(plan)
          };
        };

        if (input.dry_run) {
          try {
            return await runArchiveDryRun(null);
          } catch (error) {
            if (!isExecFallbackError(error)) throw error;
            return runWalkDryRun(asAppError(error).code);
          }
        }

        const runArchive = async (fallbackReason: string | null) => {
          const entries = getEntries();
          const archive = await withRetry(() =>
            createRemoteArchive({
              client,
              base,
              entries,
              excludes
            })
          );

          const localArchive = path.join(
            ctx.projectRoot,
            ".plesk",
            "tmp",
            `${randomUUID()}.tar.gz`
          );

          try {
            await mkdir(path.dirname(localArchive), { recursive: true });
            const downloaded = await withRetry(() =>
              archive.stagingClient.fsDownloadToFile(archive.restPath, localArchive)
            );
            const extracted = await extractArchive({
              archivePath: localArchive,
              localDir,
              overwrite
            });

            const warnings = [...archive.warnings];
            if (archive.foreign) {
              warnings.push(
                `Packaging was run as domain ${archive.execDomain.name}.`
              );
            }

            return {
              mode: "archive",
              fallbackReason,
              server: name,
              domain: domain.name,
              remotePaths,
              base,
              localDir,
              execDomain: archive.execDomain.name,
              archiveBytes: downloaded.bytes,
              archiveServerBytes: archive.bytes,
              extractedEntries: Math.max(extracted.entries - extracted.skipped, 0),
              skippedEntries: extracted.skipped,
              warnings,
              elapsedMs: Date.now() - startedAt
            };
          } finally {
            await rm(localArchive, { force: true }).catch(() => undefined);
            await cleanupRemoteArchive(archive.stagingClient, archive);
          }
        };

        const runWalk = async (fallbackReason: string | null) => {
          const result = await downloadWalk(walkOptions);
          return {
            mode: "walk",
            fallbackReason,
            server: name,
            domain: domain.name,
            remotePaths,
            base,
            localDir,
            exclude: excludes,
            ...result,
            elapsedMs: Date.now() - startedAt
          };
        };

        try {
          return await runArchive(null);
        } catch (error) {
          if (!isExecFallbackError(error)) throw error;
          return runWalk(asAppError(error).code);
        }
      })
  );

  registrar.registerTool(
    "file_mkdir",
    {
      safety: "write",
      destructive: false,
      idempotent: true,
      summarize: (args) => `Create directory ${textArg(args, "path")}`
    },
    {
      title: "Create a remote directory",
      description: "Creates an absolute directory in Plesk.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1),
        recursive: z.boolean().optional()
      }
    },
    async ({ server: serverName, domain: domainName, path: input, recursive }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const remote = resolveRemotePath(input);
        if (recursive === false) {
          await client.fsMkdir(remote);
        } else {
          await ensureRemoteDir(client, remote);
        }
        return { domain: domain.name, path: remote };
      })
  );

  registrar.registerTool(
    "file_move",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Move ${textArg(args, "from")} to ${textArg(args, "to")}`
    },
    {
      title: "Move or rename",
      description: "Moves a remote file or directory.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional()
      }
    },
    async ({ server: serverName, domain: domainName, from, to, overwrite }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const source = resolveRemotePath(from);
        const destination = resolveRemotePath(to);
        await ensureRemoteDir(client, path.posix.dirname(destination));
        await client.fsMove(source, destination, overwrite ?? false);
        return { domain: domain.name, from: source, to: destination };
      })
  );

  registrar.registerTool(
    "file_copy",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Copy ${textArg(args, "from")} to ${textArg(args, "to")}`
    },
    {
      title: "Copy",
      description: "Copies a remote file or directory.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional()
      }
    },
    async ({ server: serverName, domain: domainName, from, to, overwrite }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const source = resolveRemotePath(from);
        const destination = resolveRemotePath(to);
        await ensureRemoteDir(client, path.posix.dirname(destination));
        await client.fsCopy(source, destination, overwrite ?? false);
        return { domain: domain.name, from: source, to: destination };
      })
  );

  registrar.registerTool(
    "file_delete",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Delete ${textArg(args, "path")}${args.recursive === true ? " (recursive)" : ""}`
    },
    {
      title: "Delete",
      description: "Deletes a remote file or directory.",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1),
        recursive: z.boolean().optional()
      }
    },
    async ({ server: serverName, domain: domainName, path: input, recursive }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const remote = resolveRemotePath(input);
        await client.fsDelete(remote, recursive ?? false);
        return { domain: domain.name, path: remote, deleted: true };
      })
  );

  registrar.registerTool(
    "file_chmod",
    {
      safety: "write",
      destructive: true,
      summarize: (args) =>
        `Change permissions of ${textArg(args, "path")} to ${textArg(args, "mode")}`
    },
    {
      title: "Change permissions",
      description: "Changes permissions of a remote file or directory (Linux).",
      inputSchema: {
        server: serverField,
        domain: domainField,
        path: z.string().min(1),
        mode: z.string().regex(/^[0-7]{3,4}$/),
        recursive: z.boolean().optional()
      }
    },
    async ({ server: serverName, domain: domainName, path: input, mode, recursive }) =>
      runTool(async () => {
        const { client, domain } = await scoped(ctx, serverName, domainName);
        const remote = resolveRemotePath(input);
        await client.fsChmod(remote, mode, recursive ?? false);
        return { domain: domain.name, path: remote, mode };
      })
  );
}

async function listTree(
  client: PleskClient,
  remote: string,
  maxDepth: number
): Promise<unknown[]> {
  const result: unknown[] = [];

  const walk = async (current: string, depth: number): Promise<void> => {
    const listing = await client.fsList(current);
    const entries = extractEntries(listing);
    for (const entry of entries) {
      result.push(entry);
      if (depth >= maxDepth) continue;
      const name = entryName(entry);
      if (!name || !isDirectoryEntry(entry)) continue;
      await walk(`${current === "/" ? "" : current}/${name}`, depth + 1);
    }
  };

  await walk(remote, 1);
  return result;
}

function extractEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    if (Array.isArray(value.entries)) return value.entries;
    if (Array.isArray(value.data)) return value.data;
  }
  return [];
}

function entryName(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  if (typeof entry.name === "string") return entry.name;
  if (typeof entry.path === "string") return path.posix.basename(entry.path);
  return undefined;
}

function isDirectoryEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return (
    entry.type === "directory" ||
    entry.type === "dir" ||
    entry.isDirectory === true ||
    entry.is_dir === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
