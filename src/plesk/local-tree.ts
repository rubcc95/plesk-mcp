import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { resolveLocalPath } from "../config/paths.js";
import { AppError } from "../util/errors.js";

export interface LocalEntry {
  absolute: string;
  relative: string;
  size: number | null;
}

export interface LocalTree {
  base: string;
  files: LocalEntry[];
  directories: LocalEntry[];
  totalBytes: number;
  warnings: string[];
}

export interface LocalWalkOptions {
  exclude: string[];
}

export interface LocalPlanFile extends LocalEntry {
  remoteRelative: string;
}

export interface LocalPlanDirectory extends LocalEntry {
  remoteRelative: string;
}

export interface LocalPlan {
  base: string;
  files: LocalPlanFile[];
  directories: LocalPlanDirectory[];
  totalBytes: number;
  warnings: string[];
}

export interface ResolvedLocalEntry {
  absolute: string;
  type: "file" | "directory";
}

/** Resuelve una ruta local existente y comprueba que sigue dentro del proyecto. */
export async function resolveLocalEntry(
  projectRoot: string,
  input: string
): Promise<ResolvedLocalEntry> {
  const absolute = resolveLocalPath(projectRoot, input);
  const info = await stat(absolute).catch(() => null);
  if (!info) {
    throw new AppError("LOCAL_NOT_FOUND", `No existe la ruta local: ${absolute}`);
  }

  const real = await realpath(absolute);
  const rootReal = await realpath(projectRoot);
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
    throw new AppError(
      "LOCAL_PATH_OUTSIDE_PROJECT",
      `La ruta real ${real} queda fuera del proyecto`,
      { hint: "Revisa enlaces simbólicos." }
    );
  }

  if (info.isFile()) return { absolute: real, type: "file" };
  if (info.isDirectory()) return { absolute: real, type: "directory" };

  throw new AppError(
    "LOCAL_NOT_SUPPORTED",
    `La ruta local no es un fichero ni un directorio: ${real}`
  );
}

/** Ancestro común de los directorios padre de las rutas locales. */
export function findLocalBase(paths: string[]): string {
  if (paths.length === 0) {
    throw new AppError("UPLOAD_NO_PATHS", "No se indicó ninguna ruta local");
  }

  const parents = paths.map((item) => path.dirname(item));
  let base = parents[0]!;
  for (const parent of parents.slice(1)) {
    base = commonAncestor(base, parent);
  }
  return base;
}

/** Recorre las rutas locales y devuelve ficheros y directorios. */
export async function collectLocalTree(
  entries: ResolvedLocalEntry[],
  options: LocalWalkOptions
): Promise<LocalTree> {
  const files: LocalEntry[] = [];
  const directories: LocalEntry[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  const base = findLocalBase(entries.map((entry) => entry.absolute));
  const matchesExclude = createExcludeMatcher(options.exclude);

  const pushFile = (file: LocalEntry): void => {
    totalBytes += file.size ?? 0;
    files.push(file);
  };

  const visit = async (
    current: string,
    currentRelative: string
  ): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });

    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = currentRelative
        ? `${currentRelative}/${child.name}`
        : child.name;

      if (matchesExclude(relative)) continue;

      if (child.isSymbolicLink()) {
        warnings.push(`Se omitió el enlace simbólico ${relative}`);
        continue;
      }

      if (child.isDirectory()) {
        directories.push({ absolute, relative, size: null });
        await visit(absolute, relative);
        continue;
      }

      if (child.isFile()) {
        const info = await lstat(absolute).catch(() => null);
        if (!info) {
          warnings.push(`No se pudo leer ${relative}`);
          continue;
        }
        pushFile({ absolute, relative, size: info.size });
        continue;
      }

      warnings.push(`Se omitió ${relative}: tipo no soportado`);
    }
  };

  for (const entry of entries) {
    const relative = relativeTo(base, entry.absolute);
    if (relative && matchesExclude(relative)) continue;

    if (entry.type === "file") {
      const info = await lstat(entry.absolute);
      pushFile({ absolute: entry.absolute, relative, size: info.size });
      continue;
    }

    directories.push({ absolute: entry.absolute, relative, size: null });
    await visit(entry.absolute, relative);
  }

  return { base, files, directories, totalBytes, warnings };
}

/** Calcula la ruta remota relativa de cada entrada local. */
export function buildLocalPlan(tree: LocalTree): LocalPlan {
  return {
    base: tree.base,
    files: tree.files.map((file) => ({
      ...file,
      remoteRelative: file.relative
    })),
    directories: tree.directories.map((directory) => ({
      ...directory,
      remoteRelative: directory.relative
    })),
    totalBytes: tree.totalBytes,
    warnings: tree.warnings
  };
}

export function localPlanSummary(plan: LocalPlan): {
  files: number;
  directories: number;
  bytes: number;
  sample: Array<{ local: string; remote: string }>;
} {
  return {
    files: plan.files.length,
    directories: plan.directories.length,
    bytes: plan.totalBytes,
    sample: plan.files.slice(0, 50).map((file) => ({
      local: file.relative,
      remote: file.remoteRelative
    }))
  };
}

function relativeTo(base: string, absolute: string): string {
  return path.relative(base, absolute).split(path.sep).join("/");
}

function createExcludeMatcher(
  patterns: string[]
): (relative: string) => boolean {
  if (patterns.length === 0) return () => false;

  const matchPath = picomatch(patterns, { dot: true });
  const matchBasename = picomatch(patterns, { dot: true, basename: true });

  return (relative: string) => matchPath(relative) || matchBasename(relative);
}

function commonAncestor(a: string, b: string): string {
  if (path.parse(a).root !== path.parse(b).root) {
    throw new AppError(
      "UPLOAD_DIFFERENT_ROOTS",
      "Las rutas locales están en unidades distintas"
    );
  }

  let candidate = a;
  while (true) {
    const relative = path.relative(candidate, b);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}
