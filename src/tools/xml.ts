import { z } from "zod";
import { assertReadOnlyPacket, parseXmlResponse, MAX_PACKET_BYTES } from "../plesk/xml.js";
import { runTool } from "../util/result.js";
import type { ToolContext } from "./context.js";
import type { ToolRegistrar } from "./policy.js";

export function registerXmlTools(
  registrar: ToolRegistrar,
  ctx: ToolContext
): void {
  registrar.registerTool(
    "plesk_xml_call",
    { safety: "read", idempotent: true },
    {
      title: "Call the Plesk XML API",
      description:
        "Sends a read-only packet to the Plesk XML API (https://<panel>:8443/enterprise/control/agent.php). Only <get> operators are accepted; write operators are rejected before the request is sent. Useful for data the REST API does not expose, such as site/get (php_handler_id) and php-handler/get (full-version).",
      inputSchema: {
        server: z
          .string()
          .optional()
          .describe("Server name; if omitted, the default is used"),
        packet: z
          .string()
          .min(1)
          .describe(
            `Full XML packet, for example: <packet version="1.6.9.0"><site><get><filter/><dataset><gen_info/><hosting/></dataset></get></site></packet> (max ${MAX_PACKET_BYTES} bytes)`
          )
      }
    },
    async ({ server: serverName, packet }) =>
      runTool(async () => {
        const operators = assertReadOnlyPacket(packet);
        const runtime = ctx.registry.resolve(serverName);
        const raw = await runtime.client.xmlCall(packet);
        const response = parseXmlResponse(raw, operators);

        return {
          server: runtime.name,
          operators: response.operators,
          packet: response.packet
        };
      })
  );
}
