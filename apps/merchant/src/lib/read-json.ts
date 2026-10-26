import { ApiError } from '../types';

/** Bound public JSON requests before parsing; Content-Length alone is not authoritative. */
export async function readJson(
  request: Request,
  limit = 8192,
): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > limit)
    throw ApiError.badRequest('Request body exceeds size limit');
  const reader = request.body?.getReader();
  if (!reader) throw ApiError.badRequest('JSON body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw ApiError.badRequest('Request body exceeds size limit');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw ApiError.badRequest('Invalid JSON body');
  }
}
