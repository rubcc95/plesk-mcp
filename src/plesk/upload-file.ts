import { stat } from "node:fs/promises";
import path from "node:path";
import type { PleskClient } from "./client.js";
import { deleteRemoteIfExists, ensureRemoteDir } from "./fs-util.js";
import { readChunks } from "../util/chunk.js";
import { sha256File } from "../util/hash.js";

export interface UploadOptions {
  chunkSizeMb: number;
  mode?: string;
  overwrite: boolean;
}

export interface UploadResult {
  local: string;
  remote: string;
  bytes: number;
  sha256: string;
}

export async function uploadFile(
  client: PleskClient,
  local: string,
  remote: string,
  options: UploadOptions
): Promise<UploadResult> {
  await ensureRemoteDir(client, path.posix.dirname(remote));

  const info = await stat(local);
  const sha256 = await sha256File(local);
  const temp = `${remote}.upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunkSize = Math.max(1, Math.floor(options.chunkSizeMb * 1024 * 1024));

  try {
    let first = true;
    for await (const chunk of readChunks(local, chunkSize)) {
      if (first) {
        await client.fsWrite(temp, chunk);
        first = false;
      } else {
        await client.fsAppend(temp, chunk);
      }
    }
    if (first) {
      await client.fsWrite(temp, Buffer.alloc(0));
    }
  } catch (error) {
    await client.fsDelete(temp, false).catch(() => undefined);
    throw error;
  }

  try {
    await client.fsMove(temp, remote, true);
  } catch (error) {
    if (!options.overwrite) {
      await client.fsDelete(temp, false).catch(() => undefined);
      throw error;
    }
    await deleteRemoteIfExists(client, remote, true);
    await client.fsMove(temp, remote, true);
  }

  if (options.mode) await client.fsChmod(remote, options.mode);

  return { local, remote, bytes: info.size, sha256 };
}
