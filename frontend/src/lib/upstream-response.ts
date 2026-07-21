export class UpstreamResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamResponseError";
  }
}

/** Read a response body without allowing an unbounded buffer. */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength.trim())) {
      throw new UpstreamResponseError("Upstream returned an invalid Content-Length");
    }
    const declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new UpstreamResponseError("Upstream response is too large");
    }
  }

  if (!response.body) {
    throw new UpstreamResponseError("Upstream returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Upstream response is too large");
        throw new UpstreamResponseError("Upstream response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Decode a UTF-8 response without allowing an unbounded buffer. */
export async function readBoundedTextResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UpstreamResponseError("Upstream response is not valid UTF-8");
  }
  return text;
}

/** Decode an upstream JSON response without allowing an unbounded buffer. */
export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const text = await readBoundedTextResponse(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamResponseError("Upstream returned invalid JSON");
  }
}
