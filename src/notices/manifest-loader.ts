import { validateReleaseNotices } from './release-notices';
import type { ArtworkProvenanceManifest, LicenseManifest } from './types';

const MAX_NOTICE_BYTES = 262_144;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/i;

export interface ValidatedNoticeBundle {
  readonly license: LicenseManifest;
  readonly artwork: ArtworkProvenanceManifest;
}

async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_NOTICE_BYTES) {
      throw new Error('notice-load-size-error');
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_NOTICE_BYTES) throw new Error('notice-load-size-error');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_NOTICE_BYTES) {
        await reader.cancel();
        throw new Error('notice-load-size-error');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error('notice-load-size-error');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error('notice-load-http-error');
  if (!JSON_MEDIA_TYPE.test(response.headers.get('Content-Type') ?? '')) {
    throw new Error('notice-load-media-type-error');
  }
  const bytes = await readBoundedBytes(response);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error('notice-load-format-error');
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  }
  return value;
}

/** @des DES-F001-012 DES-F001-013 DES-F001-015 @fun FUN-F001-026 FUN-F001-038 */
export async function loadReleaseNoticeBundle(
  baseUrl: URL,
  now: Date,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ValidatedNoticeBundle> {
  const base = new URL(baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
  if (typeof location !== 'undefined' && base.origin !== location.origin) {
    throw new Error('notice-load-origin-error');
  }
  const request = async <T>(path: string): Promise<T> => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error('notice-load-path-error');
    }
    try {
      return await readJson<T>(await fetcher(url, {
        signal,
        credentials: 'same-origin',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      }));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('notice-load-')) throw error;
      throw new Error(signal?.aborted ? 'notice-load-aborted' : 'notice-load-network-error', { cause: error });
    }
  };

  const [license, artwork] = await Promise.all([
    request<LicenseManifest>('content/licenses.json'),
    request<ArtworkProvenanceManifest>('content/artwork-provenance.json'),
  ]);
  const validated = validateReleaseNotices(license, artwork, now);
  if (!validated.ok) throw new Error('notice-validation-error');
  return Object.freeze({ license: validated.value, artwork: freezeDeep(artwork) });
}
