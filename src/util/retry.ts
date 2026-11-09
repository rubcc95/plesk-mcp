import { setTimeout as sleep } from "node:timers/promises";
import { AppError, PleskHttpError } from "./errors.js";

const RETRYABLE_CODES = new Set([
  "PLESK_UNREACHABLE",
  "PLESK_DOWNLOAD_FAILED",
  "PLESK_EMPTY_RESPONSE"
]);

/** HTTP codes that will not be fixed by retrying. */
const PERMANENT_HTTP_STATUS = new Set([400, 401, 403, 404, 405, 409, 422]);

/** Network errors that do not depend on a temporary outage. */
const PERMANENT_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EROFS",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);

/** Retries only transient errors: network, timeout, 5xx, and 429. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PleskHttpError) {
    if (PERMANENT_HTTP_STATUS.has(error.status)) return false;
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof AppError) {
    if (hasPermanentCause(error)) return false;
    return RETRYABLE_CODES.has(error.code);
  }
  return false;
}

function hasPermanentCause(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);

    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && PERMANENT_NETWORK_CODES.has(code)) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Runs `fn`, retrying transient errors forever.
 * Permanent errors (auth, data, DNS, TLS) propagate immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 20));
      await sleep(delay);
      attempt += 1;
    }
  }
}
