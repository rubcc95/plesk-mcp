export interface AppErrorOptions {
  cause?: unknown;
  hint?: string;
}

/** Error con codigo estable para que el cliente MCP pueda reaccionar. */
export class AppError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.hint = options.hint;
  }
}

export class PleskHttpError extends AppError {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string
  ) {
    const auth = status === 401 || status === 403;
    super(auth ? "PLESK_AUTH" : "PLESK_HTTP", message, {
      hint: auth
        ? "Comprueba la API key o el usuario/contraseña, y que la IP del equipo esté permitida en Plesk."
        : undefined
    });
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError("INTERNAL", error.message, { cause: error });
  }
  return new AppError("INTERNAL", String(error));
}
