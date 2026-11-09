import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../util/errors.js";

/**
 * Normaliza una ruta remota de Plesk.
 * Debe ser absoluta dentro de la suscripción (`/httpdocs/...`).
 * Rechaza `..` y bytes nulos.
 */
export function resolveRemotePath(input: string): string {
  const raw = input.replace(/\\/g, "/").replace(/\0/g, "");

  if (!raw.startsWith("/")) {
    throw new AppError(
      "REMOTE_PATH_NOT_ABSOLUTE",
      `La ruta remota debe ser absoluta: ${input}`,
      { hint: "Ejemplo: /httpdocs/index.php" }
    );
  }

  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new AppError(
      "REMOTE_PATH_TRAVERSAL",
      `La ruta remota no puede contener '..': ${input}`
    );
  }

  return path.posix.normalize(`/${segments.join("/")}`);
}

/** Une una ruta remota base con una ruta relativa, sin permitir escapes. */
export function joinRemotePath(base: string, relative: string): string {
  return resolveRemotePath(
    path.posix.join(resolveRemotePath(base), relative.replace(/\\/g, "/"))
  );
}

/** Resuelve una ruta local contra la raíz del proyecto y rechaza escapes. */
export function resolveLocalPath(projectRoot: string, input: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);

  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new AppError(
      "LOCAL_PATH_OUTSIDE_PROJECT",
      `La ruta local ${input} queda fuera del proyecto`,
      { hint: `Las rutas locales deben estar dentro de ${root}.` }
    );
  }

  return absolute;
}

/** Comprueba que existe y, si es un enlace, que su destino sigue dentro del proyecto. */
export async function assertLocalFile(
  projectRoot: string,
  input: string
): Promise<string> {
  const absolute = resolveLocalPath(projectRoot, input);
  const info = await stat(absolute).catch(() => null);
  if (!info) {
    throw new AppError("LOCAL_NOT_FOUND", `No existe el archivo local: ${absolute}`);
  }
  if (!info.isFile()) {
    throw new AppError("LOCAL_NOT_FILE", `La ruta local no es un archivo: ${absolute}`);
  }

  const real = await realpath(absolute);
  const rootReal = await realpath(projectRoot);
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
    throw new AppError(
      "LOCAL_PATH_OUTSIDE_PROJECT",
      `El archivo real ${real} queda fuera del proyecto`,
      { hint: "Revisa enlaces simbólicos." }
    );
  }

  return real;
}
