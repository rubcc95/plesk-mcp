import { describe, expect, it } from "vitest";
import {
  assertReadOnlyPacket,
  buildPacket,
  hostingProperties,
  parseXmlResponse
} from "./xml.js";

describe("assertReadOnlyPacket", () => {
  it("accepts a packet with a single get operator", () => {
    const packet = buildPacket("site", "<filter/><dataset><gen_info/></dataset>");
    expect(assertReadOnlyPacket(packet)).toEqual(["site"]);
  });

  it("accepts several get operators", () => {
    const packet =
      '<?xml version="1.0"?><packet version="1.6.9.0"><site><get><filter/></get></site><php-handler><get><filter/></get></php-handler></packet>';
    expect(assertReadOnlyPacket(packet)).toEqual(["site", "php-handler"]);
  });

  it("rejects write operators", () => {
    const packet =
      '<?xml version="1.0"?><packet version="1.6.9.0"><site><del><filter><name>x.es</name></filter></del></site></packet>';
    expect(() => assertReadOnlyPacket(packet)).toThrowError(/only allows <get>/);
  });

  it("rejects mixed read and write operators", () => {
    const packet =
      '<?xml version="1.0"?><packet version="1.6.9.0"><site><get><filter/></get><set><filter/></set></site></packet>';
    expect(() => assertReadOnlyPacket(packet)).toThrowError(/only allows <get>/);
  });

  it("rejects malformed XML", () => {
    expect(() => assertReadOnlyPacket("<packet><site>")).toThrowError(
      /not well formed/
    );
  });

  it("rejects a packet without a packet root", () => {
    expect(() =>
      assertReadOnlyPacket('<?xml version="1.0"?><site><get><filter/></get></site>')
    ).toThrowError(/<packet> root/);
  });

  it("rejects empty packets", () => {
    expect(() => assertReadOnlyPacket("   ")).toThrowError(/empty/i);
  });

  it("rejects oversized packets", () => {
    const packet = buildPacket("site", `<filter>${"a".repeat(70 * 1024)}</filter>`);
    expect(() => assertReadOnlyPacket(packet)).toThrowError(/exceeds/);
  });
});

describe("parseXmlResponse", () => {
  it("parses results and keeps them as arrays", () => {
    const body =
      '<?xml version="1.0"?><packet version="1.6.9.0"><php-handler><get><result><status>ok</status><id>plesk-php74-fpm</id><full-version>7.4.33</full-version></result></get></php-handler></packet>';
    const response = parseXmlResponse(body, ["php-handler"]);
    const get = (response.packet["php-handler"] as Record<string, unknown>)["get"] as Record<string, unknown>;
    expect(Array.isArray(get.result)).toBe(true);
  });

  it("turns Plesk errors into AppError", () => {
    const body =
      '<?xml version="1.0"?><packet version="1.6.9.0"><system><status>error</status><errcode>1014</errcode><errtext>Parser error</errtext></system></packet>';
    expect(() => parseXmlResponse(body, ["site"])).toThrowError(/Parser error/);
  });
});

describe("hostingProperties", () => {
  it("reads property lists from a hosting dataset", () => {
    const result = {
      data: {
        hosting: {
          vrt_hst: {
            property: [
              { name: "php", value: "true" },
              { name: "php_handler_id", value: "plesk-php83-fpm" }
            ]
          }
        }
      }
    };
    expect(hostingProperties(result)).toEqual({
      php: "true",
      php_handler_id: "plesk-php83-fpm"
    });
  });
});
