const SHA256 = /^[a-f0-9]{64}$/u;
const AUTHOR_ID = /^\d{6}$/u;
const BATCH_ID = /^F\d{3}$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9._/-]+$/u;

export interface ArtworkCreditManifest {
  readonly authorId: string;
  readonly batchId: string;
  readonly manifestId: string;
  readonly provenanceRef: string;
  readonly provenanceSha256: string;
  /** SHA検証済み原本manifestからloaderが付与する表示用credit。集約JSON自体には保存しない。 */
  readonly credit?: string;
  readonly output: {
    readonly path: string;
    readonly sha256: string;
  };
}

export interface ArtworkProvenanceBundle {
  readonly schemaVersion: '1.0.0';
  readonly artworks: readonly ArtworkCreditManifest[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function expectedProvenanceRef(batchId: string): string {
  return batchId === 'F001'
    ? 'content/artwork-provenance.json'
    : `content/artwork-provenance/${batchId}.json`;
}

/** 公開用集約manifestは補完せず、危険path・欠損・重複をすべて拒否する。 */
export function validateArtworkProvenanceBundle(value: unknown): ArtworkProvenanceBundle {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'artworks']) ||
    value.schemaVersion !== '1.0.0' || !Array.isArray(value.artworks) ||
    value.artworks.length === 0 || value.artworks.length > 1_000) {
    throw new Error('notice-artwork-bundle-schema-error');
  }
  const authorIds = new Set<string>();
  const batchIds = new Set<string>();
  const manifestIds = new Set<string>();
  const paths = new Set<string>();
  const refs = new Set<string>();
  const artworks = value.artworks.map((unknownEntry): ArtworkCreditManifest => {
    if (!isRecord(unknownEntry) ||
      !hasExactKeys(unknownEntry, ['authorId', 'batchId', 'manifestId', 'provenanceRef', 'provenanceSha256', 'output']) ||
      typeof unknownEntry.authorId !== 'string' || !AUTHOR_ID.test(unknownEntry.authorId) ||
      typeof unknownEntry.batchId !== 'string' || !BATCH_ID.test(unknownEntry.batchId) ||
      typeof unknownEntry.manifestId !== 'string' || unknownEntry.manifestId.trim() !== unknownEntry.manifestId ||
      unknownEntry.manifestId.length === 0 || unknownEntry.manifestId.length > 200 ||
      typeof unknownEntry.provenanceRef !== 'string' || !SAFE_PATH.test(unknownEntry.provenanceRef) ||
      unknownEntry.provenanceRef !== expectedProvenanceRef(unknownEntry.batchId) ||
      typeof unknownEntry.provenanceSha256 !== 'string' || !SHA256.test(unknownEntry.provenanceSha256) ||
      !isRecord(unknownEntry.output) || !hasExactKeys(unknownEntry.output, ['path', 'sha256']) ||
      typeof unknownEntry.output.path !== 'string' || !SAFE_PATH.test(unknownEntry.output.path) ||
      !unknownEntry.output.path.startsWith('artwork/') || !unknownEntry.output.path.endsWith('.png') ||
      typeof unknownEntry.output.sha256 !== 'string' || !SHA256.test(unknownEntry.output.sha256)) {
      throw new Error('notice-artwork-bundle-schema-error');
    }
    if (authorIds.has(unknownEntry.authorId) || batchIds.has(unknownEntry.batchId) ||
      manifestIds.has(unknownEntry.manifestId) || paths.has(unknownEntry.output.path) ||
      refs.has(unknownEntry.provenanceRef)) {
      throw new Error('notice-artwork-bundle-duplicate-error');
    }
    authorIds.add(unknownEntry.authorId);
    batchIds.add(unknownEntry.batchId);
    manifestIds.add(unknownEntry.manifestId);
    paths.add(unknownEntry.output.path);
    refs.add(unknownEntry.provenanceRef);
    return {
      authorId: unknownEntry.authorId,
      batchId: unknownEntry.batchId,
      manifestId: unknownEntry.manifestId,
      provenanceRef: unknownEntry.provenanceRef,
      provenanceSha256: unknownEntry.provenanceSha256,
      output: { path: unknownEntry.output.path, sha256: unknownEntry.output.sha256 },
    };
  });
  return { schemaVersion: '1.0.0', artworks };
}

export function assertArtworkProvenanceMatches(
  entry: ArtworkCreditManifest,
  rawManifest: unknown,
): void {
  if (!isRecord(rawManifest) || rawManifest.manifestId !== entry.manifestId || !isRecord(rawManifest.output)) {
    throw new Error('notice-artwork-provenance-mismatch');
  }
  const outputPath = rawManifest.output.path ?? rawManifest.output.publicPath;
  if (outputPath !== entry.output.path || rawManifest.output.sha256 !== entry.output.sha256) {
    throw new Error('notice-artwork-provenance-mismatch');
  }
  if (entry.batchId === 'F001') {
    if ('authorId' in rawManifest || 'batchId' in rawManifest) {
      if (rawManifest.authorId !== entry.authorId || rawManifest.batchId !== entry.batchId) {
        throw new Error('notice-artwork-provenance-mismatch');
      }
    }
    return;
  }
  if (rawManifest.authorId !== entry.authorId || rawManifest.batchId !== entry.batchId) {
    throw new Error('notice-artwork-provenance-mismatch');
  }
}

export function artworkCreditFromProvenance(entry: ArtworkCreditManifest, rawManifest: unknown): string | undefined {
  if (!isRecord(rawManifest)) return undefined;
  if (typeof rawManifest.credit === 'string' && rawManifest.credit.trim() === rawManifest.credit &&
    rawManifest.credit.length > 0 && rawManifest.credit.length <= 500) {
    return rawManifest.credit;
  }
  if (entry.batchId !== 'F001') throw new Error('notice-artwork-provenance-mismatch');
  return undefined;
}
