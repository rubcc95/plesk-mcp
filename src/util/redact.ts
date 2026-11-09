const SECRET_KEY =
  /(^|[_-])(api[_-]?key|password|passwd|secret|token|authorization|passphrase)($|[_-])/i;

/** Redacta valores sensibles en objetos de configuracion o respuestas. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? "***" : redact(child);
    }
    return result;
  }
  return value;
}

/** Redacta secretos que aparezcan dentro de un texto libre. */
export function redactText(text: string): string {
  return text
    .replace(/(X-API-Key\s*:\s*)\S+/gi, "$1***")
    .replace(/(Authorization\s*:\s*)\S+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/]+):([^@\s/]+)@/gi, "$1:***@");
}
