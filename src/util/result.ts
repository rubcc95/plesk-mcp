import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asAppError } from "./errors.js";

export interface ToolError {
  code: string;
  message: string;
  hint?: string;
}

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string, hint?: string): ToolResult<never> {
  return { ok: false, error: { code, message, hint } };
}

export function fromError(error: unknown): ToolResult<never> {
  const appError = asAppError(error);
  return fail(appError.code, appError.message, appError.hint);
}

/** Convierte el resultado de una tool al formato que espera MCP. */
export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: !result.ok
  };
}

/** Ejecuta una tool capturando errores y devolviendo siempre JSON estable. */
export async function runTool<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return toCallToolResult(ok(await fn()));
  } catch (error) {
    return toCallToolResult(fromError(error));
  }
}
