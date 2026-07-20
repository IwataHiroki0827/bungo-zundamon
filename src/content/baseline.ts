import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import type { F001BaselineBundle, F001ContentInvariantReport, IntegratedFile } from './batch-public.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';
import type { Catalog, CatalogV2 } from './processing.ts';
import type { PagesDistPreview } from './pages-preview.ts';

export interface F001Baseline {
  readonly baselineSha256: Sha256;
  readonly catalog: Readonly<Pick<CatalogV2, 'authors' | 'works' | 'audioAssets'>>;
  readonly files: readonly IntegratedFile[];
}

export interface F001BaselineDocument {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.1.0';
  readonly commit: '2733b5fd368e847a01708724511f993f5e1b2484';
  readonly catalogSha256: '5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1';
  readonly syntheticBatch: CatalogV2['batches'][number];
  readonly catalog: Readonly<Pick<CatalogV2, 'authors' | 'works' | 'audioAssets' | 'candidateCounts' | 'creditsRef'>>;
  readonly files: readonly IntegratedFile[];
  readonly baselineSha256: Sha256;
}

const F001_RELEASE = 'v0.1.0';
const F001_COMMIT = '2733b5fd368e847a01708724511f993f5e1b2484';
const F001_CATALOG_SHA = '5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1';
const F001_EXPECTED_BASELINE_SHA = '722b88affbc84a3e1250bcc1e2e6d538957a02d94483b706bb55609483b9fbc9';
const F001_PUBLISHED_AT = '2026-07-19T23:19:54+09:00';
const F001_EVIDENCE_SHA = 'b1a06647bef14d452e3bf7b0a285765338cf188a5fa2675145a4e6be1777708d';

export interface VerifiedF001DistInvariantReport {
  readonly result: 'pass';
  readonly distSha256: Sha256;
  readonly contentBuildSha256: Sha256;
  readonly baselineSha256: Sha256;
  readonly reportSha256: Sha256;
}

export class F001InvariantError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F001InvariantError';
  }
}

function sha(bytes: Uint8Array | string): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

function safePath(path: string): path is WorkspaceRelativePath {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function safeRoot(path: string, code: string): Promise<string> {
  if (!isAbsolute(path)) throw new F001InvariantError(code, 'rootは絶対pathが必要です');
  const root = resolve(path);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe root');
  } catch (error) {
    throw new F001InvariantError(code, 'root実体が安全なdirectoryではありません', { cause: error });
  }
  return root;
}

function baselineDigest(document: Omit<F001BaselineDocument, 'baselineSha256'>): Sha256 {
  return sha(canonicalJson(document));
}

function assertBaselineAllowlist(document: F001BaselineDocument): void {
  const keys = ['baselineSha256', 'catalog', 'catalogSha256', 'commit', 'files', 'release', 'schemaVersion', 'syntheticBatch'];
  if (Object.keys(document).sort((a, b) => a.localeCompare(b, 'en')).join('\0') !== keys.join('\0') ||
    document.schemaVersion !== '1.0.0' || document.release !== F001_RELEASE || document.commit !== F001_COMMIT ||
    document.catalogSha256 !== F001_CATALOG_SHA || document.syntheticBatch.batchId !== 'F001' ||
    document.syntheticBatch.status !== 'published' || document.syntheticBatch.feature !== 'F001') {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'F001 baseline identity/schemaが不正です');
  }
  const payload = { ...document } as unknown as Record<string, unknown>;
  delete payload.baselineSha256;
  if (document.baselineSha256 !== F001_EXPECTED_BASELINE_SHA ||
    baselineDigest(payload as unknown as Omit<F001BaselineDocument, 'baselineSha256'>) !== document.baselineSha256) {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'F001 baseline hashが一致しません');
  }
  if (F001_EVIDENCE_SHA !== sha(compactCanonical({ commit: F001_COMMIT, catalogSha256: F001_CATALOG_SHA }))) {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'F001 release evidenceが固定commit/catalogと一致しません');
  }
  const expectedPaths = new Set<string>();
  for (const file of document.files) {
    if (!safePath(file.path) || expectedPaths.has(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !(
        file.path === '.nojekyll' || file.path === document.catalog.creditsRef || file.path === 'content/artwork-provenance.json' ||
        file.path === 'content/provenance.json' || document.catalog.authors.some((author) => author.artwork.path === file.path) ||
        (/^audio\/F001\/[a-f0-9]{64}\.wav$/u.test(file.path) && document.catalog.audioAssets.some((asset) => asset.path === file.path))
      )) throw new F001InvariantError('F001_ITEM_MUTATED', `F001 allowlist fileが不正です: ${file.path}`);
    expectedPaths.add(file.path);
  }
  const required = new Set([
    '.nojekyll', document.catalog.creditsRef, 'content/artwork-provenance.json', 'content/provenance.json',
    ...document.catalog.authors.map((author) => author.artwork.path), ...document.catalog.audioAssets.map((asset) => asset.path),
  ]);
  if (expectedPaths.size !== required.size || [...required].some((path) => !expectedPaths.has(path))) {
    throw new F001InvariantError('F001_ITEM_MISSING', 'F001 allowlist file集合が不完全です');
  }
  const baseline: F001Baseline = { baselineSha256: document.baselineSha256, catalog: document.catalog, files: document.files };
  assertCatalogF001({ ...document.catalog, schemaVersion: '2.0.0', batches: [document.syntheticBatch] } as CatalogV2, baseline, 'F001_POSTBUILD');
}

function compactCanonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(normalize);
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en')).map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

async function reconstructF001FromRawCatalog(root: string, bytes: Uint8Array): Promise<{
  catalog: F001BaselineDocument['catalog']; syntheticBatch: F001BaselineDocument['syntheticBatch'];
}> {
  let source: Catalog;
  try { source = JSON.parse(new TextDecoder().decode(bytes)) as Catalog; } catch (error) {
    throw new F001InvariantError('F001_ITEM_MUTATED', '固定raw Catalog v1 JSONが不正です', { cause: error });
  }
  if (source.schemaVersion !== '1.0.0' || !source.author || source.author.authorId !== '000879' ||
    !Array.isArray(source.works) || source.works.length !== 3 || source.works.reduce((sum, work) => sum + work.dialogues.length, 0) !== 59 ||
    !Array.isArray(source.audioAssets) || source.audioAssets.length !== 57) {
    throw new F001InvariantError('F001_ITEM_MUTATED', '固定raw Catalog v1の3作品59台詞/57音声契約が不正です');
  }
  const [artworkBytes, provenanceBytes] = await Promise.all([
    readAsset(root, source.author.artwork.path, 'F001_ASSET_MISSING', 'F001_SOURCE_ROOT_UNSAFE'),
    readAsset(root, 'content/provenance.json', 'F001_PROVENANCE_MISSING', 'F001_SOURCE_ROOT_UNSAFE'),
  ]);
  const author = {
    ...source.author,
    artwork: { ...source.author.artwork, sha256: sha(artworkBytes) },
    introducedByBatchId: 'F001',
    identitySha256: sha(compactCanonical({
      authorId: source.author.authorId, name: source.author.name,
      originalName: source.author.originalName, slug: source.author.slug,
    })),
  };
  const provenanceSha256 = sha(provenanceBytes);
  const works = source.works.map((work) => ({
    ...work, authorId: source.author.authorId, batchId: 'F001',
    source: { ...work.source, provenancePath: 'content/provenance.json', provenanceSha256 },
    dialogues: work.dialogues.map((dialogue) => ({ ...dialogue, workId: work.workId })),
  }));
  const audioAssets = source.audioAssets.map((asset) => ({ ...asset, batchId: 'F001' }));
  const counts = { ...source.candidateCounts };
  return {
    catalog: {
      authors: [author], works, audioAssets,
      candidateCounts: { ...counts, byBatch: { F001: counts } }, creditsRef: source.creditsRef,
    },
    syntheticBatch: {
      batchId: 'F001', feature: 'F001', status: 'published', authorId: source.author.authorId,
      workIds: works.map((work) => work.workId), acceptedAt: F001_PUBLISHED_AT, publishedAt: F001_PUBLISHED_AT,
      evidenceSha256: F001_EVIDENCE_SHA,
    },
  };
}

/** @des DES-F002-003 DES-F002-006 DES-F002-016 @fun FUN-F002-005 */
export async function loadAndVerifyF001Baseline(
  sourceRoot: string,
  baselinePath: string,
  rawCatalogPath: string,
): Promise<F001BaselineBundle> {
  const root = await safeRoot(sourceRoot, 'F001_SOURCE_ROOT_UNSAFE');
  if (!isAbsolute(baselinePath)) throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'baseline pathは絶対pathが必要です');
  const baselineFile = resolve(baselinePath);
  let raw: string;
  try {
    const info = await lstat(baselineFile);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(baselineFile) !== baselineFile) throw new Error('unsafe baseline');
    raw = await readFile(baselineFile, 'utf8');
  } catch (error) {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'baseline file実体が不正です', { cause: error });
  }
  let document: F001BaselineDocument;
  try { document = JSON.parse(raw) as F001BaselineDocument; } catch (error) {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'baseline JSONが不正です', { cause: error });
  }
  if (canonicalJson(document) !== raw) throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', 'baseline JSONがcanonicalではありません');
  assertBaselineAllowlist(document);
  if (!isAbsolute(rawCatalogPath)) {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', '固定raw catalog pathは絶対pathが必要です');
  }
  const rawCatalogFile = resolve(rawCatalogPath);
  let catalogBytes: Uint8Array;
  try {
    const info = await lstat(rawCatalogFile);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(rawCatalogFile) !== rawCatalogFile) throw new Error('unsafe raw catalog');
    catalogBytes = new Uint8Array(await readFile(rawCatalogFile));
  } catch (error) {
    throw new F001InvariantError('F001_BASELINE_IDENTITY_INVALID', '固定raw catalog snapshot実体が不正です', { cause: error });
  }
  if (sha(catalogBytes) !== F001_CATALOG_SHA) {
    throw new F001InvariantError('F001_ITEM_MUTATED', '固定raw catalog snapshot SHAが一致しません');
  }
  const reconstructed = await reconstructF001FromRawCatalog(root, catalogBytes);
  if (canonicalJson(reconstructed.catalog) !== canonicalJson(document.catalog) ||
    canonicalJson(reconstructed.syntheticBatch) !== canonicalJson(document.syntheticBatch)) {
    throw new F001InvariantError('F001_ITEM_MUTATED', 'raw Catalog v1からの決定的F001写像がbaseline payloadと一致しません');
  }
  for (const file of document.files) {
    const missingCode = file.path.startsWith('content/provenance') ? 'F001_PROVENANCE_MISSING' : 'F001_ASSET_MISSING';
    const mismatchCode = file.path.startsWith('content/provenance') ? 'F001_PROVENANCE_HASH_MISMATCH' : 'F001_ASSET_HASH_MISMATCH';
    const bytes = await readAsset(root, file.path, missingCode, 'F001_SOURCE_ROOT_UNSAFE');
    if (bytes.byteLength !== file.bytes || sha(bytes) !== file.sha256) {
      throw new F001InvariantError(mismatchCode, `F001 source実体がbaselineと一致しません: ${file.path}`);
    }
  }
  return Object.freeze({
    sourceRoot: root,
    files: Object.freeze(document.files.map((file) => Object.freeze({ ...file }))),
    catalog: Object.freeze({ ...document.catalog, batches: [] }),
    syntheticBatch: Object.freeze({ ...document.syntheticBatch }),
    baselineSha256: document.baselineSha256,
  });
}

async function readAsset(root: string, path: string, missingCode: string, unsafeCode: string): Promise<Uint8Array> {
  if (!safePath(path)) throw new F001InvariantError(unsafeCode, `公開pathが不正です: ${path}`);
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) throw new F001InvariantError(unsafeCode, 'assetがroot外です');
  let cursor = root;
  try {
    for (const part of relation.split(sep)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new F001InvariantError(unsafeCode, `asset pathにreparseがあります: ${path}`);
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new F001InvariantError(unsafeCode, `assetがregular fileではありません: ${path}`);
    return new Uint8Array(await readFile(target));
  } catch (error) {
    if (error instanceof F001InvariantError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new F001InvariantError(missingCode, `assetがありません: ${path}`);
    throw new F001InvariantError(unsafeCode, `assetを安全に読めません: ${path}`, { cause: error });
  }
}

async function treeDigest(root: string, unsafeCode: string): Promise<Sha256> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (directory: string, logical: string): Promise<void> => {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new F001InvariantError(unsafeCode, 'treeにreparseがあります');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      const child = logical ? `${logical}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, child);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push({ path: child, bytes: new Uint8Array(await readFile(path)) });
      else throw new F001InvariantError(unsafeCode, `treeにregular file以外があります: ${child}`);
    }
  };
  await walk(root, '');
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  return digest.digest('hex') as Sha256;
}

async function treePaths(root: string, unsafeCode: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const walk = async (directory: string, logical: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = logical ? `${logical}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), child);
      else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(child);
      else throw new F001InvariantError(unsafeCode, `treeにregular file以外があります: ${child}`);
    }
  };
  await walk(root, '');
  return paths;
}

function assertCatalogF001(catalog: CatalogV2, baseline: F001Baseline, prefix: 'F001_POSTBUILD' | 'F001_DIST'): void {
  const expectedAuthor = baseline.catalog.authors[0];
  if (!expectedAuthor || baseline.catalog.authors.length !== 1 || baseline.catalog.works.length !== 3 ||
    baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0) !== 59) {
    throw new F001InvariantError(`${prefix}_ITEM_MUTATED`, '固定F001 baselineの3作品59台詞契約が不正です');
  }
  const author = catalog.authors.find((item) => item.authorId === expectedAuthor.authorId);
  if (!author) throw new F001InvariantError(`${prefix}_ITEM_MISSING`, 'F001作者がありません');
  if (canonicalJson(author) !== canonicalJson(expectedAuthor)) throw new F001InvariantError(`${prefix}_ITEM_MUTATED`, 'F001作者identityが変化しています');
  const expectedWorkIds = new Set(baseline.catalog.works.map((work) => work.workId));
  const actualF001Works = catalog.works.filter((work) => work.batchId === 'F001');
  if (actualF001Works.length !== expectedWorkIds.size || actualF001Works.some((work) => !expectedWorkIds.has(work.workId))) {
    throw new F001InvariantError(`${prefix}_ITEM_MUTATED`, 'F001作品集合が変化しています');
  }
  for (const expected of baseline.catalog.works) {
    const actual = catalog.works.find((work) => work.workId === expected.workId);
    if (!actual) throw new F001InvariantError(`${prefix}_ITEM_MISSING`, `F001作品がありません: ${expected.workId}`);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new F001InvariantError(`${prefix}_ITEM_MUTATED`, `F001作品が変化しています: ${expected.workId}`);
  }
  for (const expected of baseline.catalog.audioAssets) {
    const actual = catalog.audioAssets.find((asset) => asset.audioId === expected.audioId);
    if (!actual) throw new F001InvariantError(`${prefix}_ITEM_MISSING`, `F001音声項目がありません: ${expected.audioId}`);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new F001InvariantError(`${prefix}_ITEM_MUTATED`, `F001音声項目が変化しています: ${expected.audioId}`);
  }
  const expectedAudioIds = new Set(baseline.catalog.audioAssets.map((asset) => asset.audioId));
  const actualF001Audio = catalog.audioAssets.filter((asset) => asset.batchId === 'F001');
  if (actualF001Audio.length !== expectedAudioIds.size || actualF001Audio.some((asset) => !expectedAudioIds.has(asset.audioId))) {
    throw new F001InvariantError(`${prefix}_ITEM_MUTATED`, 'F001音声集合が変化しています');
  }
}

async function assertBaselineAssets(root: string, baseline: F001Baseline, prefix: 'F001_POSTBUILD' | 'F001_DIST'): Promise<void> {
  for (const expected of baseline.files) {
    if (expected.path === 'content/catalog.json') continue;
    const bytes = await readAsset(root, expected.path, `${prefix}_ASSET_MISSING`, `${prefix}_${prefix === 'F001_DIST' ? 'PATH_UNSAFE' : 'STAGING_UNSAFE'}`);
    if (bytes.byteLength !== expected.bytes || sha(bytes) !== expected.sha256) {
      throw new F001InvariantError(`${prefix}_ASSET_HASH_MISMATCH`, `F001 assetがbaselineと一致しません: ${expected.path}`);
    }
  }
}

/** @des DES-F002-003 DES-F002-006 DES-F002-016 @fun FUN-F002-038 */
export async function verifyF001Invariant(
  catalog: CatalogV2,
  stagingRoot: string,
  baseline: F001Baseline,
): Promise<F001ContentInvariantReport> {
  const root = await safeRoot(stagingRoot, 'F001_POSTBUILD_STAGING_UNSAFE');
  assertCatalogF001(catalog, baseline, 'F001_POSTBUILD');
  await assertBaselineAssets(root, baseline, 'F001_POSTBUILD');
  const stagingSha256 = await treeDigest(root, 'F001_POSTBUILD_STAGING_UNSAFE');
  return Object.freeze({ result: 'pass', buildSha256: stagingSha256, stagingSha256, baselineSha256: baseline.baselineSha256 });
}

/** @des DES-F002-003 DES-F002-006 DES-F002-011 DES-F002-015 DES-F002-016 @fun FUN-F002-040 */
export async function verifyF001DistInvariant(
  pages: PagesDistPreview,
  baseline: F001Baseline,
  content: F001ContentInvariantReport,
): Promise<VerifiedF001DistInvariantReport> {
  if (content.result !== 'pass' || content.buildSha256 !== pages.contentBuildSha256 || content.stagingSha256 !== pages.contentBuildSha256 ||
    content.baselineSha256 !== baseline.baselineSha256) {
    throw new F001InvariantError('F001_DIST_CONTENT_REPORT_MISMATCH', 'content invariantとdist入力tupleが一致しません');
  }
  const root = await safeRoot(pages.outputRoot, 'F001_DIST_PATH_UNSAFE');
  const actualDigest = await treeDigest(root, 'F001_DIST_PATH_UNSAFE');
  if (actualDigest !== pages.distSha256) throw new F001InvariantError('F001_DIST_DIGEST_MISMATCH', 'dist digestがpreviewと一致しません');
  const metadataPaths = new Set<string>();
  for (const file of pages.files) {
    if (metadataPaths.has(file.path)) throw new F001InvariantError('F001_DIST_DIGEST_MISMATCH', 'dist preview fileが重複しています');
    metadataPaths.add(file.path);
    const bytes = await readAsset(root, file.path, 'F001_DIST_ASSET_MISSING', 'F001_DIST_PATH_UNSAFE');
    if (bytes.byteLength !== file.bytes || sha(bytes) !== file.sha256) {
      throw new F001InvariantError('F001_DIST_DIGEST_MISMATCH', `dist preview metadataが実体と一致しません: ${file.path}`);
    }
  }
  const physicalPaths = await treePaths(root, 'F001_DIST_PATH_UNSAFE');
  if (metadataPaths.size !== physicalPaths.length || physicalPaths.some((path) => !metadataPaths.has(path))) {
    throw new F001InvariantError('F001_DIST_DIGEST_MISMATCH', 'dist preview file集合が完全distと一致しません');
  }
  const catalogBytes = await readAsset(root, 'content/catalog.json', 'F001_DIST_ASSET_MISSING', 'F001_DIST_PATH_UNSAFE');
  let catalog: CatalogV2;
  try { catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as CatalogV2; } catch (error) {
    throw new F001InvariantError('F001_DIST_ITEM_MUTATED', 'dist catalog JSONが不正です', { cause: error });
  }
  assertCatalogF001(catalog, baseline, 'F001_DIST');
  await assertBaselineAssets(root, baseline, 'F001_DIST');
  const report = {
    result: 'pass' as const,
    distSha256: pages.distSha256,
    contentBuildSha256: pages.contentBuildSha256,
    baselineSha256: baseline.baselineSha256,
  };
  return Object.freeze({ ...report, reportSha256: sha(canonicalJson(report)) });
}
