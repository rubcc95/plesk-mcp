import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AppError } from "../util/errors.js";
import { redactText } from "../util/redact.js";

/** Packets larger than this are rejected before hitting the panel. */
export const MAX_PACKET_BYTES = 64 * 1024;

const READ_ONLY_OPERATOR = "get";
const MAX_ERROR_TEXT = 2_000;

type OrderedNode = Record<string, unknown>;

/**
 * Validates a Plesk XML API packet and guarantees it only contains
 * read-only `<get>` operators.
 *
 * Returns the operator names found in the packet.
 */
export function assertReadOnlyPacket(packet: string): string[] {
  if (typeof packet !== "string" || packet.trim() === "") {
    throw new AppError("XML_PACKET_EMPTY", "The XML packet is empty");
  }

  if (Buffer.byteLength(packet, "utf8") > MAX_PACKET_BYTES) {
    throw new AppError(
      "XML_PACKET_TOO_LARGE",
      `The XML packet exceeds ${MAX_PACKET_BYTES} bytes`
    );
  }

  const validation = XMLValidator.validate(packet);
  if (validation !== true) {
    const location = validation.err.line ? ` (line ${validation.err.line})` : "";
    throw new AppError(
      "XML_PACKET_INVALID",
      `The XML packet is not well formed${location}: ${validation.err.msg}`
    );
  }

  let tree: unknown;
  try {
    tree = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      allowBooleanAttributes: true,
      parseTagValue: false
    }).parse(packet);
  } catch (error) {
    throw new AppError("XML_PACKET_INVALID", "The XML packet could not be parsed", {
      cause: error
    });
  }

  const packetNode = findElement(tree, "packet");
  if (!packetNode) {
    throw new AppError(
      "XML_PACKET_INVALID",
      "The XML packet must have a <packet> root element"
    );
  }

  const operators = childElements(packetNode).filter(
    (node) => elementName(node) !== "#text"
  );

  if (operators.length === 0) {
    throw new AppError(
      "XML_PACKET_EMPTY",
      "The XML packet does not contain any operator"
    );
  }

  const names: string[] = [];
  for (const operator of operators) {
    const name = elementName(operator);
    if (!name) continue;

    const operations = childElements(operator)
      .map((child) => elementName(child))
      .filter((childName): childName is string => Boolean(childName) && childName !== "#text");

    if (operations.length === 0) {
      throw new AppError(
        "XML_PACKET_INVALID",
        `Operator "${name}" does not contain an operation`
      );
    }

    const unsupported = operations.find((operation) => operation !== READ_ONLY_OPERATOR);
    if (unsupported) {
      throw new AppError(
        "XML_API_READ_ONLY",
        `Operator "${name}" uses <${unsupported}>, but this tool only allows <get>`,
        {
          hint: "plesk_xml_call is read-only by design. Use plesk_cli for other operations."
        }
      );
    }

    names.push(name);
  }

  return names;
}

export interface XmlApiResponse {
  /** Operator names present in the request. */
  operators: string[];
  /** Parsed `<packet>` content. */
  packet: Record<string, unknown>;
  /** Raw response body (already redacted is not applied here). */
  raw: string;
}

/**
 * Parses a Plesk XML API response and turns `<status>error</status>`
 * blocks into stable AppErrors.
 */
export function parseXmlResponse(
  body: string,
  operators: string[]
): XmlApiResponse {
  let parsed: Record<string, unknown>;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: false,
      trimValues: true,
      isArray: (name) => name === "result" || name === "property"
    }).parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new AppError(
      "XML_RESPONSE_INVALID",
      "Plesk returned a response that is not valid XML",
      { cause: error, hint: redactText(body).slice(0, MAX_ERROR_TEXT) }
    );
  }

  const packet = (parsed.packet ?? {}) as Record<string, unknown>;
  const system = packet.system as Record<string, unknown> | undefined;

  if (system && String(system.status) === "error") {
    const errcode = String(system.errcode ?? "unknown");
    const errtext = redactText(String(system.errtext ?? "Unknown Plesk error"));
    throw new AppError(
      "PLESK_XML_ERROR",
      errtext || `Plesk XML API returned error ${errcode}`,
      { hint: `Plesk error code: ${errcode}` }
    );
  }

  return { operators, packet, raw: body };
}

function elementName(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ":@") continue;
    return key;
  }
  return null;
}

function childElements(node: OrderedNode): OrderedNode[] {
  const name = elementName(node);
  if (!name) return [];
  const value = node[name];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (child): child is OrderedNode =>
      typeof child === "object" && child !== null
  );
}

function findElement(tree: unknown, name: string): OrderedNode | null {
  if (!Array.isArray(tree)) return null;
  for (const node of tree) {
    if (typeof node !== "object" || node === null) continue;
    const candidate = node as OrderedNode;
    if (elementName(candidate) === name) return candidate;
    const nested = findElement(childElements(candidate), name);
    if (nested) return nested;
  }
  return null;
}

/** Builds a read-only packet with a fixed XML API version. */
export function buildPacket(operator: string, inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><packet version="1.6.9.0"><${operator}><get>${inner}</get></${operator}></packet>`;
}

/** Reads `<property>` lists returned by `<hosting>` datasets. */
export function hostingProperties(result: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const data = pick(result, "data");
  const hosting = pick(data, "hosting");
  const vrt = pick(hosting, "vrt_hst") ?? hosting;
  const properties = pick(vrt, "property");

  if (!Array.isArray(properties)) return out;

  for (const property of properties) {
    const name = pick(property, "name");
    const value = pick(property, "value");
    if (typeof name === "string") {
      out[name] = value === undefined || value === null ? "" : String(value);
    }
  }

  return out;
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function pick(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return record[key];
}
