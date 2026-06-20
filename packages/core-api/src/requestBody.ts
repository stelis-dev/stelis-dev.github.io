/**
 * Shared HTTP body-size limits for Host HTTP endpoints.
 *
 * These limits sit above protocol-level validation such as MAX_TX_KIND_BYTES.
 * They prevent hosts from buffering arbitrarily large JSON request bodies before
 * route handlers can run their own semantic checks.
 */

/** `/prepare` accepts base64 txKindBytes plus a small JSON envelope. */
export const MAX_PREPARE_REQUEST_BODY_BYTES = 96 * 1024;

/** `/sponsor` carries txBytes, userSignature, and receiptId. */
export const MAX_SPONSOR_REQUEST_BODY_BYTES = 128 * 1024;

/** Small JSON payloads (auth, config, promotion actions). */
export const MAX_SMALL_REQUEST_BODY_BYTES = 32 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(
    public readonly limitBytes: number,
    public readonly actualBytes?: number,
  ) {
    super(`Request body exceeds ${limitBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export class RequestBodyParseError extends Error {
  constructor(message = 'Invalid JSON body') {
    super(message);
    this.name = 'RequestBodyParseError';
  }
}

function parseContentLength(value: string): number {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    throw new RequestBodyParseError('Invalid Content-Length header');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new RequestBodyParseError('Invalid Content-Length header');
  }
  return parsed;
}

/**
 * Reads a JSON request body with an explicit byte cap.
 *
 * - Uses Content-Length as an early guard when present.
 * - Enforces the same cap while streaming so a false/missing header cannot bypass it.
 * - Returns `{}` for an empty body so callers can keep their existing missing-field checks.
 */
export async function readJsonBodyWithLimit<T>(request: Request, maxBytes: number): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`readJsonBodyWithLimit: maxBytes must be a positive safe integer`);
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const parsedLength = parseContentLength(contentLength);
    if (parsedLength > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes, parsedLength);
    }
  }

  if (!request.body) {
    return {} as T;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Best-effort cleanup only.
      }
      throw new RequestBodyTooLargeError(maxBytes, totalBytes);
    }
    chunks.push(value);
  }

  if (totalBytes === 0) {
    return {} as T;
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch {
    throw new RequestBodyParseError();
  }
}
