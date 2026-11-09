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
  /** Raíz real de la suscripción destino (home del usuario de sistema). */
  home: string;
  prefix: string;
  tarBinary: string;
  tempDirRest: string;
  restPath: string;
  realPath: string;
  command: string[];
  /** Dominio cuyo shell se usa. */
  execDomain: { id: number; name: string };
  foreign: boolean;
}

export interface RemoteArchive extends ArchivePlan {
  warnings: string[];
  bytes: number;
  /** Cliente contra el dominio que aloja el archivo (el mismo salvo shell ajeno). */
  stagingClient: PleskClient;
}

export interface ArchiveEntryInfo {
  path: string;
  linkpath?: string;
  type?: string;
}

/**
 * Ancestro común de los directorios padre de las rutas indicadas.
 * Ejemplo: ["/httpdocs/assets", "/httpdocs/index.php"] -> "/httpdocs".
 */
export function findArchiveBase(remotePaths: string[]): string {
  if (remotePaths.length === 0) {
    throw new AppError("ARCHIVE_NO_PATHS", "No se indicó ninguna ruta remota");
  }

  let base = path.posix.dirname(remotePaths[0]!);
  for (const remotePath of remotePaths.slice(1)) {
    base = commonAncestor(base, path.posix.dirname(remotePath));
  }
  return base;
}

/** Rutas relativas a la base, sin entradas duplicadas por anidamiento. */
export function archiveEntries(remotePaths: string[], base: string): string[] {
  const entries = unique(
    remotePaths.map((remotePath) => {
      const relative =
        base === "/" ? remotePath.replace(/^\/+/, "") : remotePath.slice(base.length + 1);
      if (!relative) {
        throw new AppError(
          "ARCHIVE_INVALID_ENTRY",
          `La ruta ${remotePath} no es relativa a la base ${base}`
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
      throw new AppError("ARCHIVE_EXCLUDE_INVALID", "Un patrón de exclusión está vacío");
    }
    if (value.startsWith("-") || !EXCLUDE_PATTERN.test(value)) {
      throw new AppError(
        "ARCHIVE_EXCLUDE_INVALID",
        `Patrón de exclusión no válido: ${pattern}`,
        { hint: "Solo se permiten letras, números y los caracteres . _ * ? [ ] / -" }
      );
    }
    if (value.length > 200) {
      throw new AppError(
        "ARCHIVE_EXCLUDE_INVALID",
        `Patrón de exclusión demasiado largo: ${pattern}`
      );
    }
    return value;
  });
}

/** Construye el comando tar con binario fijo y argumentos ya validados. */
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
 * Traduce una ruta de la API fs de Plesk (relativa a la raíz de la suscripción)
 * a la ruta real que ve exec. Plesk ejecuta los comandos en el home del usuario
 * de la suscripción, así que el prefijo habitual es /var/www/vhosts/<dominio>.
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
    `No se pudo traducir la ruta remota ${baseRest} a una ruta del servidor`,
    {
      hint: "Comprueba con doctor que exec funciona y que la ruta existe."
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
        "El servidor no permite ejecutar comandos (exec)",
        {
          cause: error,
          hint:
            "La descarga masiva necesita exec y tar. Las suscripciones con shell chrooted o sin shell no lo permiten; ejecuta doctor para comprobarlo."
        }
      );
    }
    throw error;
  }

  if (result.code !== 0) {
    throw new AppError(
      "EXEC_UNAVAILABLE",
      "El servidor no permite ejecutar comandos (exec)",
      {
        hint:
          redactText(result.stderr || result.message || "") ||
          "Las suscripciones con shell chrooted o sin shell no permiten exec."
      }
    );
  }

  const home = lastLine(result.stdout ?? "");
  if (!home.startsWith("/")) {
    throw new AppError(
      "EXEC_UNAVAILABLE",
      `exec devolvió un directorio de trabajo inesperado: ${home || "(vacío)"}`
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

export function toRealPath(prefix: string, restPath: string): string {
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
  if (!prefix) return "";
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
    "No se encontró el binario tar en el servidor",
    { hint: "La descarga masiva necesita tar (GNU tar) disponible para la suscripción." }
  );
}

export async function planArchive(options: ArchivePlanOptions): Promise<ArchivePlan> {
  const { client, base, entries, excludes } = options;
  if (entries.length === 0) {
    throw new AppError("ARCHIVE_NO_ENTRIES", "No hay ficheros ni directorios que empaquetar");
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
          `tar terminó con código 1; el archivo se creó igualmente${detail ? `: ${detail}` : ""}`
        );
      } else {
        if (plan.foreign) {
          throw new AppError(
            "EXEC_UNAVAILABLE",
            `tar falló con código ${result.code} usando el shell de ${plan.execDomain.name}`,
            {
              hint:
                redactText(result.stderr || result.message || "") ||
                "El dominio alternativo no pudo empaquetar la ruta destino; se usará walk."
            }
          );
        }
        throw new AppError(
          "TAR_FAILED",
          `tar falló con código ${result.code}`,
          { hint: redactText(result.stderr || result.message || "") || undefined }
        );
      }
    }

    if (!exists) {
      throw new AppError(
        "ARCHIVE_NOT_CREATED",
        `No se creó el archivo remoto ${plan.restPath}`,
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
        "El servidor no permite ejecutar comandos (exec)",
        { cause: error, hint: "Usa mode=walk o revisa el shell de la suscripción." }
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
      // Se prueba el siguiente candidato.
    }
  }

  throw new AppError(
    "ARCHIVE_TEMP_DIR_FAILED",
    "No se pudo crear un directorio temporal en el servidor",
    { hint: "Comprueba permisos de escritura en la raíz de la suscripción." }
  );
}

/** Lee la lista de entradas del archivo sin extraerlo. */
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
    throw new AppError("ARCHIVE_LIST_FAILED", `No se pudo leer ${archivePath}`, {
      cause: error
    });
  }
  return entries;
}

/** Devuelve las entradas inseguras para una extracción local. */
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
  if (path.posix.isAbsolute(name)) return "ruta absoluta";

  const segments = name.split("/").filter((segment) => segment.length > 0);
  if (segments.includes("..")) return "contiene ..";

  for (const segment of segments) {
    if (WINDOWS_INVALID.test(segment)) return "nombre inválido en Windows";
    if (/[. ]$/.test(segment)) return "termina en punto o espacio (inválido en Windows)";
    if (WINDOWS_RESERVED.test(segment)) return "nombre reservado en Windows";
  }

  if (entry.linkpath) {
    const link = entry.linkpath.replace(/\\/g, "/");
    if (path.posix.isAbsolute(link)) return "enlace absoluto";
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(name), link)
    );
    if (resolved === ".." || resolved.startsWith("../")) {
      return "enlace fuera del destino";
    }
  }

  return null;
}

/** Errores que permiten caer al modo REST sin shell. */
const FALLBACK_CODES = new Set([
  "EXEC_UNAVAILABLE",
  "EXEC_PATH_MAPPING_FAILED",
  "TAR_UNAVAILABLE"
]);

export function isExecFallbackError(error: unknown): boolean {
  return error instanceof AppError && FALLBACK_CODES.has(error.code);
}

/** Extrae el archivo en local, validando antes todas las entradas. */
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
      `El archivo contiene rutas no seguras para Windows (${unsafe.length})`,
      {
        hint: `Ejemplos: ${unsafe.slice(0, 10).join(", ")}. Excluye esas rutas o descárgalas fichero a fichero.`
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
      `No se pudo extraer el archivo en ${options.localDir}`,
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

/** Borra el archivo temporal remoto y su directorio si queda vacío. */
export async function cleanupRemoteArchive(
  client: PleskClient,
  archive: Pick<RemoteArchive, "restPath" | "tempDirRest"> & {
    stagingClient?: PleskClient;
  }
): Promise<void> {
  const target = archive.stagingClient ?? client;
  await deleteRemoteIfExists(target, archive.restPath, false).catch(() => undefined);
  if (archive.tempDirRest === DEFAULT_TEMP_DIR) {
    await deleteRemoteIfExists(target, archive.tempDirRest, false).catch(
      () => undefined
    );
  }
}

/** Borra un archivo local si existe. */
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
