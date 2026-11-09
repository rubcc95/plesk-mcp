import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "../util/errors.js";
import {
  LocalDatabaseSchema,
  RegistrySchema,
  ServerSchema,
  type LocalDatabaseConfig,
  type ServerConfig
} from "./schema.js";

export const GLOBAL_CONFIG_ENV = "PLESK_GLOBAL_CONFIG";
export const LOCAL_CONFIG_PATH = ".plesk/config.json";
export const DEFAULT_GLOBAL_CONFIG_PATH = ".config/plesk-mcp/config.json";

export interface ServerEntry extends ServerConfig {
  source: "global" | "local";
}

export interface LocalDatabaseEntry extends LocalDatabaseConfig {
  source: "global" | "local";
}

export interface LoadedRegistry {
  servers: ServerEntry[];
  localDatabases: LocalDatabaseEntry[];
  defaultServer: string | null;
  defaultSource: "local" | "global" | "first" | "none";
  globalConfigPath: string;
  globalConfigFound: boolean;
  localConfigPath: string;
  localConfigFound: boolean;
  projectRoot: string;
}

export function resolveGlobalConfigPath(explicit?: string): string {
  const value =
    explicit ??
    process.env[GLOBAL_CONFIG_ENV] ??
    path.join(os.homedir(), DEFAULT_GLOBAL_CONFIG_PATH);
  return resolvePath(value);
}

export function resolveLocalConfigPath(): string {
  return path.resolve(process.cwd(), LOCAL_CONFIG_PATH);
}

/**
 * Carga los servidores Plesk y las bases de datos locales del config global y
 * del local. Mismo formato en ambos; se unen por nombre y gana el local.
 */
export async function loadRegistry(
  globalExplicit?: string
): Promise<LoadedRegistry> {
  const globalConfigPath = resolveGlobalConfigPath(globalExplicit);
  const localConfigPath = resolveLocalConfigPath();

  const [globalRaw, localRaw] = await Promise.all([
    readConfig(globalConfigPath, "GLOBAL"),
    readConfig(localConfigPath, "LOCAL")
  ]);

  if (globalRaw === null && localRaw === null) {
    throw new AppError(
      "CONFIG_NOT_FOUND",
      `No existe ni el config global (${globalConfigPath}) ni el local (${localConfigPath})`,
      {
        hint:
          "Crea .plesk/config.json con `plesk-project init` o el global con `plesk-project init --global`."
      }
    );
  }

  const global = parseRegistry(globalRaw, globalConfigPath, "GLOBAL");
  const local = parseRegistry(localRaw, localConfigPath, "LOCAL");

  const serversByName = new Map<string, ServerEntry>();
  for (const server of global.servers) {
    serversByName.set(server.name, { ...server, source: "global" });
  }
  for (const server of local.servers) {
    serversByName.set(server.name, { ...server, source: "local" });
  }

  const databasesByName = new Map<string, LocalDatabaseEntry>();
  for (const database of global.localDatabases) {
    databasesByName.set(database.name, { ...database, source: "global" });
  }
  for (const database of local.localDatabases) {
    databasesByName.set(database.name, { ...database, source: "local" });
  }

  const servers = [...serversByName.values()];
  const localDatabases = [...databasesByName.values()];

  if (servers.length === 0 && localDatabases.length === 0) {
    throw new AppError(
      "CONFIG_EMPTY",
      "La configuración no contiene ningún servidor Plesk ni base de datos local",
      {
        hint: `Añade servidores o localDatabases a ${globalConfigPath} o ${localConfigPath}.`
      }
    );
  }

  const duplicate = localDatabases.find((database) => serversByName.has(database.name));
  if (duplicate) {
    throw new AppError(
      "DUPLICATE_TARGET_NAME",
      `"${duplicate.name}" está definido a la vez en servers y en localDatabases`,
      {
        hint: "Usa nombres distintos para no confundir `server` con `pc` en las tools SQL."
      }
    );
  }

  const explicitDefault = local.defaultServer ?? global.defaultServer;
  if (explicitDefault && !serversByName.has(explicitDefault)) {
    throw new AppError(
      "DEFAULT_SERVER_NOT_FOUND",
      `defaultServer apunta a "${explicitDefault}", que no existe`,
      { hint: `Servidores disponibles: ${servers.map((server) => server.name).join(", ") || "(ninguno)"}` }
    );
  }

  const defaultServer = explicitDefault ?? servers[0]?.name ?? null;
  const defaultSource = local.defaultServer
    ? "local"
    : global.defaultServer
      ? "global"
      : servers.length > 0
        ? "first"
        : "none";

  return {
    servers,
    localDatabases,
    defaultServer,
    defaultSource,
    globalConfigPath,
    globalConfigFound: globalRaw !== null,
    localConfigPath,
    localConfigFound: localRaw !== null,
    projectRoot: process.cwd()
  };
}

/** Resuelve `env:VAR` y valida un servidor concreto al usarlo. */
export function materializeServer(entry: ServerEntry): ServerConfig {
  const resolved = resolveEnvRefs(stripSource(entry));
  const result = ServerSchema.safeParse(resolved);
  if (!result.success) {
    throw new AppError(
      "SERVER_INVALID",
      `Servidor "${entry.name}" inválido: ${formatIssues(result.error.issues)}`
    );
  }
  return result.data;
}

/** Resuelve `env:VAR` y valida una base de datos local al usarla. */
export function materializeLocalDatabase(
  entry: LocalDatabaseEntry
): LocalDatabaseConfig {
  const resolved = resolveEnvRefs(stripLocalSource(entry));
  const result = LocalDatabaseSchema.safeParse(resolved);
  if (!result.success) {
    throw new AppError(
      "LOCAL_DATABASE_INVALID",
      `Base de datos local "${entry.name}" inválida: ${formatIssues(result.error.issues)}`
    );
  }
  return result.data;
}

/** Resumen sin secretos para `project_info` y `servers_list`. */
export function registrySummary(loaded: LoadedRegistry) {
  return {
    defaultServer: loaded.defaultServer,
    defaultSource: loaded.defaultSource,
    servers: loaded.servers.map((server) => ({
      name: server.name,
      url: server.url,
      source: server.source,
      default: server.name === loaded.defaultServer,
      hasDb: Boolean(server.dbUser && server.dbPass)
    })),
    localDatabases: loaded.localDatabases.map((database) => ({
      name: database.name,
      host: database.host,
      port: database.port,
      source: database.source
    })),
    paths: {
      globalConfig: loaded.globalConfigPath,
      globalConfigFound: loaded.globalConfigFound,
      localConfig: loaded.localConfigPath,
      localConfigFound: loaded.localConfigFound
    }
  };
}

function parseRegistry(
  raw: unknown,
  filePath: string,
  kind: "GLOBAL" | "LOCAL"
): RegistryConfigLike {
  if (raw === null) return { servers: [], localDatabases: [] };

  if (Array.isArray(raw)) {
    const arrayResult = ServerSchema.array().safeParse(raw);
    if (!arrayResult.success) {
      throw new AppError(
        "CONFIG_INVALID",
        `${kind === "GLOBAL" ? "Config global" : "Config local"} inválido (${filePath}): ${formatIssues(arrayResult.error.issues)}`
      );
    }
    return { servers: arrayResult.data, localDatabases: [] };
  }

  const result = RegistrySchema.safeParse(raw);
  if (!result.success) {
    throw new AppError(
      "CONFIG_INVALID",
      `${kind === "GLOBAL" ? "Config global" : "Config local"} inválido (${filePath}): ${formatIssues(result.error.issues)}`
    );
  }
  return result.data;
}

async function readConfig(
  filePath: string,
  kind: "GLOBAL" | "LOCAL"
): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new AppError(`${kind}_CONFIG_READ`, `No se pudo leer ${filePath}`, {
      cause: error
    });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError(`${kind}_CONFIG_INVALID_JSON`, `JSON inválido en ${filePath}`, {
      cause: error
    });
  }
}

function stripSource(entry: ServerEntry): Omit<ServerEntry, "source"> {
  const { source: _source, ...server } = entry;
  return server;
}

function stripLocalSource(
  entry: LocalDatabaseEntry
): Omit<LocalDatabaseEntry, "source"> {
  const { source: _source, ...database } = entry;
  return database;
}

function resolveEnvRefs(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("env:")) {
    const name = value.slice(4).trim();
    if (!name) {
      throw new AppError("CONFIG_ENV_MISSING", "Referencia env: vacía en la configuración");
    }
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new AppError(
        "CONFIG_ENV_MISSING",
        `Falta la variable de entorno ${name}`,
        { hint: `Define ${name} antes de arrancar el MCP.` }
      );
    }
    return envValue;
  }

  if (Array.isArray(value)) return value.map(resolveEnvRefs);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveEnvRefs(child)])
    );
  }

  return value;
}

function resolvePath(value: string): string {
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(process.cwd(), expanded);
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
    .join("; ");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

type RegistryConfigLike = {
  defaultServer?: string;
  servers: ServerConfig[];
  localDatabases: LocalDatabaseConfig[];
};
