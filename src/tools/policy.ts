import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type {
  ElicitRequestFormParams,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import { AppError, asAppError } from "../util/errors.js";
import { fromError, toCallToolResult } from "../util/result.js";

export const ACCESS_ENV = "PLESK_MCP_ACCESS";

/**
 * `confirm`: toda tool de escritura pide confirmación humana por elicitation.
 * `full`: no pide confirmación. Se usa en clientes que ya aplican su propio
 * diálogo de permisos (OpenCode con `ask`) o en tests.
 */
export type AccessMode = "confirm" | "full";
export type ToolSafety = "read" | "write" | "dynamic";

export interface ToolPolicy {
  safety: ToolSafety;
  /** Solo aplica a tools de escritura o dinámicas. */
  destructive?: boolean;
  idempotent?: boolean;
  /** Resumen legible y sin secretos que se muestra al confirmar. */
  summarize?: (args: Record<string, unknown>) => string;
  /**
   * Autorización propia de una tool dinámica (por ejemplo, según el SQL).
   * Se ejecuta antes del callback y su error se devuelve como resultado.
   */
  authorize?: (
    args: Record<string, unknown>,
    server: McpServer
  ) => Promise<void>;
}

export interface ToolRegistrar {
  readonly accessMode: AccessMode;
  registerTool<InputArgs extends ZodRawShapeCompat | undefined = undefined>(
    name: string,
    policy: ToolPolicy,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>
  ): void;
}

export function resolveAccessMode(raw = process.env[ACCESS_ENV]): AccessMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "confirm" || value === "write") return "confirm";
  if (
    value === "full" ||
    value === "client" ||
    value === "off" ||
    value === "none"
  ) {
    return "full";
  }

  console.error(
    `[plesk-mcp] PLESK_MCP_ACCESS inválido (${raw}); se usa confirm por seguridad`
  );
  return "confirm";
}

export function createToolRegistrar(
  server: McpServer,
  accessMode: AccessMode
): ToolRegistrar {
  return {
    accessMode,
    registerTool(name, policy, config, cb) {
      const inputSchema: ZodRawShapeCompat | undefined = config.inputSchema;
      const annotations: ToolAnnotations = {
        ...(config.annotations ?? {}),
        readOnlyHint: policy.safety === "read",
        destructiveHint:
          policy.safety === "read" ? false : (policy.destructive ?? true),
        idempotentHint: policy.idempotent ?? policy.safety === "read",
        openWorldHint: true
      };

      const guarded: ToolCallback<typeof inputSchema> = async (args, extra) => {
        const values = (args ?? {}) as Record<string, unknown>;

        if (policy.safety === "dynamic" && policy.authorize) {
          try {
            await policy.authorize(values, server);
          } catch (error) {
            return toCallToolResult(fromError(error));
          }
        }

        if (
          policy.safety === "write" &&
          accessMode === "confirm" &&
          !isDryRun(values)
        ) {
          try {
            await requestConfirmation(server, name, policy, values);
          } catch (error) {
            return toCallToolResult(fromError(error));
          }
        }

        return cb(args as never, extra);
      };

      server.registerTool(
        name,
        {
          title: config.title,
          description: config.description,
          inputSchema,
          annotations,
          _meta: config._meta
        } as never,
        guarded as never
      );
    }
  };
}

function isDryRun(args: Record<string, unknown>): boolean {
  return args.dry_run === true;
}

async function requestConfirmation(
  server: McpServer,
  tool: string,
  policy: ToolPolicy,
  args: Record<string, unknown>
): Promise<void> {
  const detail = policy.summarize?.(args) ?? `${tool} va a modificar el servidor.`;
  await elicitConfirmation(server, `Confirmar operación en producción:\n\n${detail}`, {
    tool,
    unsupportedMessage: `El cliente no soporta elicitation y "${tool}" modifica el servidor`,
    hint:
      "Usa un cliente con elicitation o arranca el MCP con PLESK_MCP_ACCESS=full si el cliente ya pide confirmación por su cuenta.",
    rejectedMessage: `El usuario rechazó "${tool}"`,
    rejectedHint: "No se ha modificado nada en el servidor."
  });
}

/** Formulario de confirmación reutilizable por tools estáticas y dinámicas. */
export async function elicitConfirmation(
  server: McpServer,
  message: string,
  options: {
    tool?: string;
    unsupportedMessage?: string;
    hint?: string;
    rejectedMessage?: string;
    rejectedHint?: string;
  } = {}
): Promise<void> {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    throw new AppError(
      "CONFIRMATION_UNSUPPORTED",
      options.unsupportedMessage ??
        `El cliente no soporta elicitation${options.tool ? ` y "${options.tool}"` : ""}`,
      { hint: options.hint }
    );
  }

  const params: ElicitRequestFormParams = {
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Confirmar",
          description: "Marca la casilla para ejecutar la operación.",
          default: false
        }
      },
      required: ["confirm"]
    }
  };

  let result;
  try {
    result = await server.server.elicitInput(params);
  } catch (error) {
    const appError = asAppError(error);
    if (/does not support (form )?elicitation/i.test(appError.message)) {
      throw new AppError(
        "CONFIRMATION_UNSUPPORTED",
        options.unsupportedMessage ??
          `El cliente no soporta elicitation${options.tool ? ` y "${options.tool}"` : ""}`,
        { hint: options.hint }
      );
    }
    throw appError;
  }

  if (result.action !== "accept" || result.content?.confirm !== true) {
    throw new AppError(
      "CONFIRM_REJECTED",
      options.rejectedMessage ??
        `El usuario rechazó la operación${options.tool ? ` "${options.tool}"` : ""}`,
      { hint: options.rejectedHint ?? "No se ha modificado nada." }
    );
  }
}

export function textArg(
  args: Record<string, unknown>,
  key: string,
  fallback = "?"
): string {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function listArg(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key];
  return Array.isArray(value) ? value : [];
}
