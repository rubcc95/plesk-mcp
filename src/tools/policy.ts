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
 * `confirm`: every write tool asks for human confirmation via elicitation.
 * `full`: no confirmation. Used in clients that already apply their own
 * permission dialog (OpenCode with `ask`) or in tests.
 */
export type AccessMode = "confirm" | "full";
export type ToolSafety = "read" | "write" | "dynamic";

export interface ToolPolicy {
  safety: ToolSafety;
  /** Only applies to write or dynamic tools. */
  destructive?: boolean;
  idempotent?: boolean;
  /** Human-readable, secret-free summary shown on confirmation. */
  summarize?: (args: Record<string, unknown>) => string;
  /**
   * Tool-specific authorization for a dynamic tool (for example, based on the SQL).
   * It runs before the callback and its error is returned as the result.
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
    `[plesk-mcp] invalid PLESK_MCP_ACCESS (${raw}); falling back to confirm for safety`
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
  const detail = policy.summarize?.(args) ?? `${tool} will modify the server.`;
  await elicitConfirmation(server, `Confirm operation in production:\n\n${detail}`, {
    tool,
    unsupportedMessage: `The client does not support elicitation and "${tool}" modifies the server`,
    hint:
      "Use a client with elicitation or start the MCP with PLESK_MCP_ACCESS=full if the client already asks for confirmation on its own.",
    rejectedMessage: `The user rejected "${tool}"`,
    rejectedHint: "Nothing on the server has been modified."
  });
}

/** Confirmation form reusable by static and dynamic tools. */
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
        `The client does not support elicitation${options.tool ? ` and "${options.tool}"` : ""}`,
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
          title: "Confirm",
          description: "Check the box to run the operation.",
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
          `The client does not support elicitation${options.tool ? ` and "${options.tool}"` : ""}`,
        { hint: options.hint }
      );
    }
    throw appError;
  }

  if (result.action !== "accept" || result.content?.confirm !== true) {
    throw new AppError(
      "CONFIRM_REJECTED",
      options.rejectedMessage ??
        `The user rejected the operation${options.tool ? ` "${options.tool}"` : ""}`,
      { hint: options.rejectedHint ?? "Nothing has been modified." }
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
