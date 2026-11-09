import path from "node:path";
import { AppError, PleskHttpError } from "../util/errors.js";
import type { PleskClient } from "./client.js";

/** Comprueba si una ruta remota existe. */
export async function remoteExists(
  client: PleskClient,
  remote: string
): Promise<boolean> {
  try {
    await client.fsStat(remote);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

/** Crea un directorio remoto y todos sus padres, ignorando los que ya existen. */
export async function ensureRemoteDir(
  client: PleskClient,
  dir: string
): Promise<void> {
  if (dir === "/" || dir === ".") return;

  const parts = dir.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (await remoteExists(client, current)) continue;
    await client.fsMkdir(current);
  }
}

/** Borra una ruta remota si existe; cualquier otro error se propaga. */
export async function deleteRemoteIfExists(
  client: PleskClient,
  remote: string,
  recursive = false
): Promise<void> {
  try {
    await client.fsDelete(remote, recursive);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

/** Directorio de la ruta remota, normalizado en POSIX. */
export function remoteDirname(remote: string): string {
  return path.posix.dirname(remote);
}

export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof PleskHttpError)) return false;
  if (error.status === 404) return true;
  return (
    error.status === 400 &&
    /not found|does not exist|no such/i.test(`${error.message} ${error.body ?? ""}`)
  );
}

export function assertRemotePath(value: string): string {
  if (!value.startsWith("/")) {
    throw new AppError("REMOTE_PATH_NOT_ABSOLUTE", `La ruta debe ser absoluta: ${value}`);
  }
  return value;
}
