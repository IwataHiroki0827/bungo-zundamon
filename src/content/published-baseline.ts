import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson } from './artifacts.ts';
import type { IntegratedFile } from './batch-public.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';
import type { CatalogV2 } from './processing.ts';
import {
  validateArtworkProvenanceBundle,
  type ArtworkProvenanceBundle,
} from '../notices/artwork-bundle.ts';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const OID_PATTERN = /^[a-f0-9]{40}$/u;
const DESCRIPTOR_SHA256 = '305ab8e6984eff15887bd8a0ac50d9ab8619abeeb0b5c3e3dea3ff6d8b5730b6';
const DESCRIPTOR_PATH = 'content/baselines/F002-v0.2.0.json';

export const F002_PUBLISHED_RELEASE = Object.freeze({
  commit: '84c985f382910216e381a96901f6fd569165a27e',
  catalogSha256: '1d001aac1d9b5e9d9d244037936048a5caae1ff2972980cc423ec3e980fe4aab',
  contentBuildSha256: '09652af7de82eb32569d280566897c8fcf0c7e033b94d607becb42172f2b02d4',
  distSha256: 'c60431bd4da3b1ba43ac71e299089f4dc8cbad563a58f3df3d2424fd952d9fde',
} as const);

export type PinnedPublishedRelease = Readonly<typeof F002_PUBLISHED_RELEASE>;

export interface PublishedBaselineFile extends IntegratedFile {
  readonly gitOid: string;
  readonly mode: '100644' | '100755';
}

export interface PublishedBaselineDescriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.2.0';
  readonly commit: PinnedPublishedRelease['commit'];
  readonly catalogSha256: PinnedPublishedRelease['catalogSha256'];
  readonly contentBuildSha256: PinnedPublishedRelease['contentBuildSha256'];
  readonly distSha256: PinnedPublishedRelease['distSha256'];
  readonly descriptorSha256: Sha256;
  readonly counts: {
    readonly authors: 2;
    readonly works: 6;
    readonly dialogues: 213;
    readonly audioAssets: 208;
    readonly files: 226;
  };
  readonly files: readonly PublishedBaselineFile[];
  readonly references: readonly WorkspaceRelativePath[];
}

export interface PublishedBaselineBundle {
  readonly release: PinnedPublishedRelease;
  readonly catalog: CatalogV2;
  readonly artworkProvenances: ArtworkProvenanceBundle;
  readonly files: readonly PublishedBaselineFile[];
  readonly references: readonly WorkspaceRelativePath[];
  readonly baselineSha256: Sha256;
}

const publishedBaselineBundles = new WeakSet<object>();

export interface GitTreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

export interface PublishedGitObjectAdapter {
  resolveCommit(workspace: string, commit: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly GitTreeEntry[]>;
  readBlob(workspace: string, oid: string): Promise<Uint8Array>;
}

export interface PublishedInvariantInput {
  readonly target: 'work-preview' | 'integrated-tree' | 'dist';
  readonly root: string;
  readonly treeSha256: Sha256;
}

export interface PublishedInvariantReport {
  readonly result: 'pass' | 'blocked';
  readonly target: PublishedInvariantInput['target'];
  readonly inputTreeSha256: Sha256;
  readonly actualTreeSha256: Sha256;
  readonly baselineSha256: Sha256;
  readonly reasonCode?: 'PUBLISHED_BASELINE_MISMATCH';
  readonly mismatches: readonly string[];
  readonly reportSha256: Sha256;
}

export interface PublishedBaselineLoadOptions {
  readonly descriptorPath?: string;
  readonly git?: PublishedGitObjectAdapter;
}

export class PublishedBaselineError extends Error {
  readonly code = 'PUBLISHED_BASELINE_MISMATCH';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishedBaselineError';
  }
}

function sha256(value: Uint8Array | string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function isSafePath(path: string): path is WorkspaceRelativePath {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new PublishedBaselineError('workspaceは絶対pathが必要です');
  const root = resolve(path);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe directory');
  } catch (error) {
    throw new PublishedBaselineError('workspace実体が安全なdirectoryではありません', { cause: error });
  }
  return root;
}

async function readSafeFile(root: string, path: string): Promise<Uint8Array> {
  if (!isSafePath(path)) throw new PublishedBaselineError(`pathが不正です: ${path}`);
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new PublishedBaselineError(`pathがworkspace外です: ${path}`);
  }
  let cursor = root;
  try {
    for (const part of relation.split(sep)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new PublishedBaselineError(`pathにreparseがあります: ${path}`);
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error('unsafe file');
    return new Uint8Array(await readFile(target));
  } catch (error) {
    if (error instanceof PublishedBaselineError) throw error;
    throw new PublishedBaselineError(`fileを安全に読めません: ${path}`, { cause: error });
  }
}

async function gitText(workspace: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new PublishedBaselineError('固定Git objectを読めません', { cause: error });
  }
}

export const nodePublishedGitObjectAdapter: PublishedGitObjectAdapter = Object.freeze({
  async resolveCommit(workspace: string, commit: string) {
    return (await gitText(workspace, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const stdout = await gitText(workspace, ['ls-tree', '-r', '-z', commit, '--', 'public']);
    return stdout.split('\0').filter(Boolean).map((record) => {
      const match = /^([0-9]{6}) blob ([a-f0-9]{40})\tpublic\/(.+)$/u.exec(record);
      if (!match?.[1] || !match[2] || !match[3]) throw new PublishedBaselineError(`Git tree entryが不正です: ${record}`);
      return Object.freeze({ mode: match[1], oid: match[2], path: match[3] });
    });
  },
  async readBlob(workspace: string, oid: string) {
    if (!OID_PATTERN.test(oid)) throw new PublishedBaselineError('Git blob OIDが不正です');
    try {
      const { stdout } = await execFileAsync('git', ['-C', workspace, 'cat-file', 'blob', oid], {
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return new Uint8Array(stdout);
    } catch (error) {
      throw new PublishedBaselineError(`固定Git blobがありません: ${oid}`, { cause: error });
    }
  },
});

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort((a, b) => a.localeCompare(b, 'en')).join('\0') === [...expected].sort((a, b) => a.localeCompare(b, 'en')).join('\0');
}

function assertPinnedRelease(value: PinnedPublishedRelease): void {
  if (!value || typeof value !== 'object' ||
    !exactKeys(value, ['catalogSha256', 'commit', 'contentBuildSha256', 'distSha256']) ||
    value.commit !== F002_PUBLISHED_RELEASE.commit ||
    value.catalogSha256 !== F002_PUBLISHED_RELEASE.catalogSha256 ||
    value.contentBuildSha256 !== F002_PUBLISHED_RELEASE.contentBuildSha256 ||
    value.distSha256 !== F002_PUBLISHED_RELEASE.distSha256) {
    throw new PublishedBaselineError('pinned F002 releaseがexact値と一致しません');
  }
}

function descriptorPayload(document: PublishedBaselineDescriptor): Omit<PublishedBaselineDescriptor, 'descriptorSha256'> {
  const payload: Record<string, unknown> = { ...document };
  Reflect.deleteProperty(payload, 'descriptorSha256');
  return payload as Omit<PublishedBaselineDescriptor, 'descriptorSha256'>;
}

function assertDescriptor(document: PublishedBaselineDescriptor, raw: string): void {
  if (canonicalJson(document) !== raw ||
    !exactKeys(document, [
      'catalogSha256', 'commit', 'contentBuildSha256', 'counts', 'descriptorSha256',
      'distSha256', 'files', 'references', 'release', 'schemaVersion',
    ]) ||
    document.schemaVersion !== '1.0.0' || document.release !== 'v0.2.0' ||
    document.commit !== F002_PUBLISHED_RELEASE.commit ||
    document.catalogSha256 !== F002_PUBLISHED_RELEASE.catalogSha256 ||
    document.contentBuildSha256 !== F002_PUBLISHED_RELEASE.contentBuildSha256 ||
    document.distSha256 !== F002_PUBLISHED_RELEASE.distSha256 ||
    document.descriptorSha256 !== DESCRIPTOR_SHA256 ||
    sha256(canonicalJson(descriptorPayload(document))) !== DESCRIPTOR_SHA256 ||
    !exactKeys(document.counts, ['audioAssets', 'authors', 'dialogues', 'files', 'works']) ||
    document.counts.authors !== 2 || document.counts.works !== 6 || document.counts.dialogues !== 213 ||
    document.counts.audioAssets !== 208 || document.counts.files !== 226 ||
    !Array.isArray(document.files) || document.files.length !== 226 || !Array.isArray(document.references)) {
    throw new PublishedBaselineError('固定baseline descriptorのidentity/hash/countが不正です');
  }
  let previous = '';
  const paths = new Set<string>();
  for (const file of document.files) {
    if (!file || typeof file !== 'object' || !exactKeys(file, ['bytes', 'gitOid', 'mode', 'path', 'sha256']) ||
      !isSafePath(file.path) || file.path.localeCompare(previous, 'en') <= 0 || paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA_PATTERN.test(file.sha256) ||
      !OID_PATTERN.test(file.gitOid) || (file.mode !== '100644' && file.mode !== '100755')) {
      throw new PublishedBaselineError('固定baseline descriptorのfile entryが不正です');
    }
    previous = file.path;
    paths.add(file.path);
  }
  previous = '';
  for (const reference of document.references) {
    if (!isSafePath(reference) || reference.localeCompare(previous, 'en') <= 0 || !paths.has(reference)) {
      throw new PublishedBaselineError('固定baseline descriptorのreferenceが不正です');
    }
    previous = reference;
  }
}

function catalogReferences(catalog: CatalogV2): WorkspaceRelativePath[] {
  const values = [
    'content/catalog.json',
    catalog.creditsRef,
    ...catalog.authors.map((author) => author.artwork.path),
    ...catalog.works.map((work) => work.source.provenancePath),
    ...catalog.audioAssets.map((asset) => asset.path),
  ];
  if (values.some((path) => !isSafePath(path))) throw new PublishedBaselineError('catalog reference pathが不正です');
  return [...new Set(values as WorkspaceRelativePath[])].sort((a, b) => a.localeCompare(b, 'en'));
}

function assertCatalog(catalog: CatalogV2, descriptor: PublishedBaselineDescriptor): void {
  const dialogues = catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0);
  if (catalog.schemaVersion !== '2.0.0' || catalog.authors.length !== descriptor.counts.authors ||
    catalog.works.length !== descriptor.counts.works || dialogues !== descriptor.counts.dialogues ||
    catalog.audioAssets.length !== descriptor.counts.audioAssets ||
    catalog.authors.some((author) => author.introducedByBatchId === 'F003') ||
    catalog.works.some((work) => work.batchId === 'F003') ||
    catalog.audioAssets.some((asset) => asset.batchId === 'F003') ||
    catalog.batches.some((batch) => batch.batchId === 'F003') ||
    canonicalJson(catalogReferences(catalog)) !== canonicalJson(descriptor.references)) {
    throw new PublishedBaselineError('固定catalogの2作者・6作品・213台詞/reference契約が不正です');
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** @des DES-F003-002 @fun FUN-F003-004 @ut UT-F003-004 */
export async function loadAndVerifyPublishedBaseline(
  workspace: string,
  pinnedRelease: PinnedPublishedRelease,
  options: PublishedBaselineLoadOptions = {},
): Promise<PublishedBaselineBundle> {
  assertPinnedRelease(pinnedRelease);
  const root = await safeDirectory(workspace);
  const descriptorPath = options.descriptorPath ?? DESCRIPTOR_PATH;
  if (!isAbsolute(descriptorPath) && descriptorPath !== DESCRIPTOR_PATH) {
    throw new PublishedBaselineError('descriptor pathは既定相対pathまたは絶対pathが必要です');
  }
  const descriptorBytes = isAbsolute(descriptorPath)
    ? await readSafeFile(await safeDirectory(resolve(descriptorPath, '..')), resolve(descriptorPath).split(sep).at(-1) ?? '')
    : await readSafeFile(root, descriptorPath);
  const raw = new TextDecoder().decode(descriptorBytes);
  let descriptor: PublishedBaselineDescriptor;
  try {
    descriptor = JSON.parse(raw) as PublishedBaselineDescriptor;
  } catch (error) {
    throw new PublishedBaselineError('固定baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptor, raw);

  const git = options.git ?? nodePublishedGitObjectAdapter;
  if (await git.resolveCommit(root, pinnedRelease.commit) !== pinnedRelease.commit) {
    throw new PublishedBaselineError('固定release commit objectが一致しません');
  }
  const tree = await git.listPublicTree(root, pinnedRelease.commit);
  if (tree.length !== descriptor.files.length) throw new PublishedBaselineError('固定public Git treeのfile数が一致しません');
  const digest = createHash('sha256');
  let catalogBytes: Uint8Array | undefined;
  let artworkProvenancesBytes: Uint8Array | undefined;
  for (let index = 0; index < descriptor.files.length; index += 1) {
    const expected = descriptor.files[index]!;
    const actual = tree[index];
    if (!actual || actual.path !== expected.path || actual.mode !== expected.mode || actual.oid !== expected.gitOid) {
      throw new PublishedBaselineError(`固定public Git tree entryが一致しません: ${expected.path}`);
    }
    const bytes = await git.readBlob(root, actual.oid);
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new PublishedBaselineError(`固定public Git blobが一致しません: ${expected.path}`);
    }
    digest.update(expected.path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes);
    if (expected.path === 'content/catalog.json') catalogBytes = bytes;
    if (expected.path === 'content/artwork-provenances.json') artworkProvenancesBytes = bytes;
  }
  if (digest.digest('hex') !== pinnedRelease.contentBuildSha256 || !catalogBytes || !artworkProvenancesBytes ||
    sha256(catalogBytes) !== pinnedRelease.catalogSha256) {
    throw new PublishedBaselineError('固定public content/catalog SHAが一致しません');
  }
  let catalog: CatalogV2;
  let artworkProvenances: ArtworkProvenanceBundle;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as CatalogV2;
    artworkProvenances = validateArtworkProvenanceBundle(
      JSON.parse(new TextDecoder().decode(artworkProvenancesBytes)) as unknown,
    );
  } catch (error) {
    throw new PublishedBaselineError('固定catalog/artwork provenance JSONが不正です', { cause: error });
  }
  assertCatalog(catalog, descriptor);
  const baseline = deepFreeze({
    release: { ...F002_PUBLISHED_RELEASE },
    catalog,
    artworkProvenances,
    files: descriptor.files.map((file) => ({ ...file })),
    references: [...descriptor.references],
    baselineSha256: descriptor.descriptorSha256,
  });
  publishedBaselineBundles.add(baseline);
  return baseline;
}

export function isMintedPublishedBaselineBundle(value: unknown): value is PublishedBaselineBundle {
  return value !== null && typeof value === 'object' && publishedBaselineBundles.has(value);
}

async function readTree(root: string): Promise<{
  readonly files: ReadonlyMap<string, IntegratedFile>;
  readonly catalogBytes?: Uint8Array;
  readonly artworkProvenancesBytes?: Uint8Array;
  readonly treeSha256: Sha256;
}> {
  const entries: Array<{ path: WorkspaceRelativePath; bytes: Uint8Array }> = [];
  const walk = async (directory: string, logical: string): Promise<void> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PublishedBaselineError('candidate treeにreparseがあります');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = logical ? `${logical}/${entry.name}` : entry.name;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, child);
      else if (entry.isFile() && !entry.isSymbolicLink() && isSafePath(child)) {
        entries.push({ path: child, bytes: new Uint8Array(await readFile(target)) });
      } else {
        throw new PublishedBaselineError(`candidate tree entryが不正です: ${child}`);
      }
    }
  };
  await walk(root, '');
  const digest = createHash('sha256');
  const files = new Map<string, IntegratedFile>();
  let catalogBytes: Uint8Array | undefined;
  let artworkProvenancesBytes: Uint8Array | undefined;
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    const file = { path: entry.path, bytes: entry.bytes.byteLength, sha256: sha256(entry.bytes) };
    files.set(entry.path, file);
    digest.update(entry.path).update('\0').update(String(entry.bytes.byteLength)).update('\0').update(entry.bytes);
    if (entry.path === 'content/catalog.json') catalogBytes = entry.bytes;
    if (entry.path === 'content/artwork-provenances.json') artworkProvenancesBytes = entry.bytes;
  }
  return { files, catalogBytes, artworkProvenancesBytes, treeSha256: digest.digest('hex') as Sha256 };
}

function catalogProjection(catalog: CatalogV2, baseline: CatalogV2): unknown {
  const authorIds = new Set(baseline.authors.map((item) => item.authorId));
  const workIds = new Set(baseline.works.map((item) => item.workId));
  const audioIds = new Set(baseline.audioAssets.map((item) => item.audioId));
  const batchIds = new Set(baseline.batches.map((item) => item.batchId));
  return {
    schemaVersion: catalog.schemaVersion,
    authors: catalog.authors.filter((item) => authorIds.has(item.authorId)),
    works: catalog.works.filter((item) => workIds.has(item.workId)),
    audioAssets: catalog.audioAssets.filter((item) => audioIds.has(item.audioId)),
    batches: catalog.batches.filter((item) => batchIds.has(item.batchId)),
    candidateCounts: {
      byBatch: Object.fromEntries([...batchIds].sort().map((id) => [id, catalog.candidateCounts.byBatch[id]])),
    },
    creditsRef: catalog.creditsRef,
  };
}

function finishReport(input: PublishedInvariantInput, actualTreeSha256: Sha256, baselineSha256: Sha256, mismatches: string[]): PublishedInvariantReport {
  const payload = {
    result: mismatches.length === 0 ? 'pass' as const : 'blocked' as const,
    target: input.target,
    inputTreeSha256: input.treeSha256,
    actualTreeSha256,
    baselineSha256,
    ...(mismatches.length === 0 ? {} : { reasonCode: 'PUBLISHED_BASELINE_MISMATCH' as const }),
    mismatches: [...mismatches].sort((a, b) => a.localeCompare(b, 'en')),
  };
  return deepFreeze({ ...payload, reportSha256: sha256(canonicalJson(payload)) });
}

/** @des DES-F003-002 @fun FUN-F003-005 @ut UT-F003-005 */
export async function verifyPublishedInvariant(
  baseline: PublishedBaselineBundle,
  candidateTreeOrDist: PublishedInvariantInput,
): Promise<PublishedInvariantReport> {
  const root = await safeDirectory(candidateTreeOrDist.root);
  const actual = await readTree(root);
  const mismatches: string[] = [];
  if (candidateTreeOrDist.treeSha256 !== actual.treeSha256) mismatches.push('INPUT_TREE_SHA_MISMATCH');
  for (const expected of baseline.files) {
    if (expected.path === 'content/catalog.json' || expected.path === 'content/artwork-provenances.json') continue;
    const file = actual.files.get(expected.path);
    if (!file) mismatches.push(`PATH_MISSING:${expected.path}`);
    else if (file.bytes !== expected.bytes || file.sha256 !== expected.sha256) mismatches.push(`FILE_MISMATCH:${expected.path}`);
  }
  if (!actual.catalogBytes) {
    mismatches.push('CATALOG_MISSING');
  } else {
    try {
      const catalog = JSON.parse(new TextDecoder().decode(actual.catalogBytes)) as CatalogV2;
      if (canonicalJson(catalogProjection(catalog, baseline.catalog)) !== canonicalJson(catalogProjection(baseline.catalog, baseline.catalog))) {
        mismatches.push('CATALOG_PROJECTION_MISMATCH');
      }
      const references = catalogReferences(catalog);
      for (const expected of baseline.references) {
        if (!references.includes(expected)) mismatches.push(`REFERENCE_MISSING:${expected}`);
      }
    } catch {
      mismatches.push('CATALOG_INVALID');
    }
  }
  if (!actual.artworkProvenancesBytes) {
    mismatches.push('ARTWORK_PROVENANCES_MISSING');
  } else {
    try {
      const actualBundle = validateArtworkProvenanceBundle(
        JSON.parse(new TextDecoder().decode(actual.artworkProvenancesBytes)) as unknown,
      );
      const actualByAuthor = new Map(actualBundle.artworks.map((entry) => [entry.authorId, entry]));
      if (baseline.artworkProvenances.artworks.some((expected) =>
        canonicalJson(actualByAuthor.get(expected.authorId)) !== canonicalJson(expected))) {
        mismatches.push('ARTWORK_PROVENANCE_PROJECTION_MISMATCH');
      }
    } catch {
      mismatches.push('ARTWORK_PROVENANCES_INVALID');
    }
  }
  return finishReport(candidateTreeOrDist, actual.treeSha256, baseline.baselineSha256, mismatches);
}
