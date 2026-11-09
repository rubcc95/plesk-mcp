import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../util/errors.js";

/**
 * Normalizes a remote Plesk path.
 * It must be absolute inside the subscription (`/httpdocs/...`).
 * It rejects `..` and null bytes.
 */
export function resolveRemotePath(input: string): string {
  const raw = input.replace(/\\/g, "/").replace(/\0/g, "");

  if (!raw.startsWith("/")) {
    throw new AppError(
      "REMOTE_PATH_NOT_ABSOLUTE",
      `The remote path must be absolute: ${input}`,
      { hint: "Example: /httpdocs/index.php" }
    );
  }

  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new AppError(
      "REMOTE_PATH_TRAVERSAL",
      `The remote path cannot contain '..': ${input}`
    );
  }

  return path.posix.normalize(`/${segments.join("/")}`);
}

/** Joins a base remote path with a relative path, disallowing escapes. */
export function joinRemotePath(base: string, relative: string): string {
  return resolveRemotePath(
    path.posix.join(resolveRemotePath(base), relative.replace(/\\/g, "/"))
  );
}

/** Resolves a local path against the project root and rejects escapes. */
export function resolveLocalPath(projectRoot: string, input: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);

  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new AppError(
      "LOCAL_PATH_OUTSIDE_PROJECT",
      `The local path ${input} falls outside the project`,
      { hint: `Local paths must be inside ${root}.` }
    );
  }

  return absolute;
}

/** Checks that it exists and, if it is a link, that its target is still inside the project. */
export async function assertLocalFile(
  projectRoot: string,
  input: string
): Promise<string> {
  const absolute = resolveLocalPath(projectRoot, input);
  const info = await stat(absolute).catch(() => null);
  if (!info) {
    throw new AppError("LOCAL_NOT_FOUND", `The local file does not exist: ${absolute}`);
  }
  if (!info.isFile()) {
    throw new AppError("LOCAL_NOT_FILE", `The local path is not a file: ${absolute}`);
  }

  const real = await realpath(absolute);
  const rootReal = await realpath(projectRoot);
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
    throw new AppError(
      "LOCAL_PATH_OUTSIDE_PROJECT",
      `The real file ${real} falls outside the project`,
      { hint: "Check for symbolic links." }
    );
  }

  return real;
}
