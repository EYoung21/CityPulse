export class RequestBodyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new RequestBodyError("Invalid Content-Length", 400);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestBodyError("Invalid Content-Length", 400);
  }
  return parsed;
}

/** Read a request stream without ever buffering more than `maxBytes`. */
export async function readBodyBytes(
  request: Request,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyError("Request body too large", 413);
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Request body too large");
        throw new RequestBodyError("Request body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readBodyText(
  request: Request,
  maxBytes: number
): Promise<string> {
  const bytes = await readBodyBytes(request, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError("Request body is not valid UTF-8", 400);
  }
}

export async function readJsonBody<T>(
  request: Request,
  maxBytes: number
): Promise<T> {
  const text = await readBodyText(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RequestBodyError("Invalid JSON", 400);
  }
}
