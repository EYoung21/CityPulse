import { describe, expect, it } from "vitest";
import { readBodyBytes, readJsonBody } from "@/lib/server-body";

describe("bounded server request bodies", () => {
  it("parses JSON within the limit", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });

    await expect(readJsonBody<{ ok: boolean }>(request, 1024)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects an oversized declared length before reading", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-length": "1001" },
      body: "small",
    });

    await expect(readBodyBytes(request, 1000)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("counts streamed bodies when Content-Length is absent", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(401));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      duplex: "half",
      body: stream,
    } as RequestInit & { duplex: "half" });

    await expect(readBodyBytes(request, 1000)).rejects.toMatchObject({
      status: 413,
    });
  });
});
