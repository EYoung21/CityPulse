import { describe, expect, it } from "vitest";
import {
  readBoundedJsonResponse,
  readBoundedResponseBytes,
  readBoundedTextResponse,
  UpstreamResponseError,
} from "@/lib/upstream-response";

describe("bounded upstream JSON", () => {
  it("parses a response within the limit", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), 64),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects declared and streamed oversize responses", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response("{}", { headers: { "content-length": "65" } }),
        64,
      ),
    ).rejects.toBeInstanceOf(UpstreamResponseError);

    await expect(
      readBoundedJsonResponse(new Response("x".repeat(65)), 64),
    ).rejects.toThrow("too large");
  });

  it("rejects invalid UTF-8 and JSON", async () => {
    await expect(
      readBoundedJsonResponse(new Response(new Uint8Array([0xff])), 64),
    ).rejects.toThrow("UTF-8");
    await expect(
      readBoundedJsonResponse(new Response("not json"), 64),
    ).rejects.toThrow("invalid JSON");
  });

  it("bounds binary and text responses with the same streamed checks", async () => {
    await expect(
      readBoundedResponseBytes(new Response(new Uint8Array([1, 2, 3])), 3),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(readBoundedTextResponse(new Response("hello"), 5)).resolves.toBe("hello");
    await expect(readBoundedTextResponse(new Response("hello!"), 5)).rejects.toThrow("too large");
    await expect(readBoundedResponseBytes(new Response(""), -1)).rejects.toBeInstanceOf(RangeError);
  });
});
