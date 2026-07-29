import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, lstat, open, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson } from './artifacts.ts';
import {
  isMintedF005ApprovedBatchContext,
  type F005ApprovedBatchContext,
} from './f005-context.ts';
import type { CatalogV2 } from './processing.ts';

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PERSON_ID = /^[0-9]{6}$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+$/u;
const DESCRIPTOR_PATH = 'content/baselines/F005-v0.4.0.json';
const DESCRIPTOR_SHA256 = '1d4648fd83669ce3d6f9332c1b3347af788df6e8a2602c4221ac708609116f62';

export const F005_V040_PINS = Object.freeze({
  releaseCommit: 'f0a2c91effd17d1fcf75a578dad2c562ba7949c2',
  tag: 'v0.4.0',
  controlCommit: 'fc1aa7bc6cf91f8b4bac20ba5d147921bf081a6d',
  catalogSha256: '857401c774ed8dabaaf0e67d8f3e5f710a83fa1fefcd9965498590aab629f6e5',
  contentTreeSha256: '38fd2142b2c9da5a727d400b0858b0de4e426b05365f5e3bf877a6e764a5ec81',
  distSha256: 'c542f435f0adb27cd253788680b58baf102f61fbec33a91d73087bb07d40b8b9',
  artifactDigest: 'e74f65f5061746567c4df47f220159701fb28263a9c295cd269c42287514658f',
  publicFiles: 694,
  publicBytes: 229_844_709,
  distFiles: 697,
  distBytes: 229_935_951,
} as const);

export const F005_CAPACITY_LIMITS = Object.freeze({
  audioStopBytes: 104_857_600,
  artifactWarningBytes: 524_288_000,
  artifactStopBytes: 786_432_000,
  repositoryWarningBytes: 750_000_000,
  repositoryStopBytes: 1_000_000_000,
  objectStopBytes: 104_857_600,
  minimumFreeBytes: 5_368_709_120,
} as const);

export const F005_CAPACITY_ROOTS = Object.freeze({
  audio: 'public/audio/F005',
  artifact: 'dist',
  workspacePeak: '.cache',
} as const);

export const F005_RANKING_POLICY_VERSION = 'aozora-author-ranking-2022-v1' as const;

const V040_AUTHOR_IDS = new Set(['000879', '000081', '000035']);
const baselines = new WeakSet<object>();
const capacityInventories = new WeakSet<object>();
const capacityPlans = new WeakSet<object>();
const capacityPlanContexts = new WeakMap<object, F005ApprovedBatchContext>();
const verifiedAuthors = new WeakSet<object>();
const rankingEvidence = new WeakSet<object>();
const expansionPlans = new WeakSet<object>();

export interface V040GitFile {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path: string;
}

interface V040Descriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.4.0';
  readonly releaseCommit: string;
  readonly tag: 'v0.4.0';
  readonly catalogSha256: string;
  readonly contentTreeSha256: string;
  readonly counts: {
    readonly authors: 3;
    readonly works: 12;
    readonly dialogues: 674;
    readonly audioAssets: 662;
    readonly batches: 4;
  };
  readonly trackedPublic: { readonly files: 694; readonly bytes: 229844709 };
  readonly dist: { readonly files: 697; readonly bytes: 229935951; readonly sha256: string };
  readonly production: {
    readonly runId: '30390224028';
    readonly deploymentId: '5645861744';
    readonly artifactId: '8700661389';
    readonly artifactDigest: string;
    readonly artifactFiles: 697;
    readonly artifactBytes: 229935951;
  };
  readonly control: {
    readonly commit: string;
    readonly manifestPath: 'content/batches/F004/batch.json';
    readonly manifestSha256: string;
    readonly precheckPath: 'docs/evidence/release/RELEASE-F004-precheck.md';
    readonly precheckSha256: string;
    readonly releaseEvidencePath: 'docs/evidence/release/RELEASE-F004.md';
    readonly releaseEvidenceSha256: string;
  };
}

export interface V040Baseline {
  readonly __brand: 'V040Baseline';
  readonly descriptorSha256: string;
  readonly catalog: CatalogV2;
  readonly publicFiles: readonly V040GitFile[];
  readonly controlManifest: Readonly<Record<string, unknown>>;
  readonly pins: Readonly<typeof F005_V040_PINS>;
}

export interface V040GitAdapter {
  resolveCommit(workspace: string, ref: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly Omit<V040GitFile, 'sha256'>[]>;
  readObject(workspace: string, commit: string, path: string): Promise<Uint8Array>;
}

export interface V040LoadOptions {
  readonly git?: V040GitAdapter;
}

export interface V040CandidateTree {
  readonly catalog: CatalogV2;
  readonly files: readonly V040GitFile[];
}

export interface BaselineInvariantReport {
  readonly result: 'pass' | 'blocked';
  readonly baselineDescriptorSha256: string;
  readonly mismatches: readonly string[];
  readonly reportSha256: string;
}

export interface VerifiedNewAuthor {
  readonly __brand: 'VerifiedNewAuthor';
  readonly authorId: '000148';
  readonly name: 'なつめそうせき';
  readonly originalName: '夏目漱石';
  readonly slug: 'natsume-soseki';
  readonly identitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f';
}

export type CapacityEntry =
  | { readonly kind: 'path'; readonly path: string; readonly bytes: number; readonly sha256: string }
  | {
    readonly kind: 'git-index';
    readonly path: string;
    readonly oid: string;
    readonly bytes: number;
    readonly sha256: string;
  }
  | { readonly kind: 'git-object'; readonly oid: string; readonly bytes: number; readonly sha256: string };

export type CapacityMeasuredKind = 'audio' | 'artifact' | 'repository' | 'object' | 'workspace-peak';

export type F005CandidateHashClaim =
  | {
    readonly kind: 'path';
    readonly bucket: Exclude<CapacityMeasuredKind, 'object'>;
    readonly path: string;
    readonly sha256: string;
  }
  | {
    readonly kind: 'git-index';
    readonly bucket: 'repository';
    readonly path: string;
    readonly oid: string;
    readonly sha256: string;
  }
  | {
    readonly kind: 'git-object';
    readonly bucket: 'object';
    readonly oid: string;
    readonly sha256: string;
  };

export type F005CapacityInventoryEntry =
  | {
    readonly kind: 'path';
    readonly bucket: 'audio' | 'artifact' | 'workspace-peak';
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }
  | {
    readonly kind: 'git-index';
    readonly bucket: 'repository';
    readonly path: string;
    readonly oid: string;
    readonly bytes: number;
    readonly sha256: string;
  }
  | {
    readonly kind: 'git-object';
    readonly bucket: 'object';
    readonly oid: string;
    readonly bytes: number;
    readonly sha256: string;
  };

export interface F005CapacityInventory {
  readonly __brand: 'F005CapacityInventory';
  readonly candidateSha256: string;
  readonly baselineDescriptorSha256: string;
  readonly measuredAt: string;
  readonly entries: readonly F005CapacityInventoryEntry[];
  readonly inventoryDigest: string;
}

export interface F005CapacityPlan {
  readonly __brand: 'F005CapacityPlan';
  readonly candidateSha256: string;
  readonly measuredAt: string;
  readonly baselineDescriptorSha256: string;
  readonly inventoryDigest: string;
  readonly expectedClaims: readonly F005CandidateHashClaim[];
  readonly planDigest: string;
}

export interface F005CandidateHashes {
  readonly candidateSha256: string;
  readonly claims: readonly F005CandidateHashClaim[];
}

export interface CapacityBucket {
  readonly kind: 'audio' | 'artifact' | 'repository' | 'object' | 'workspace-peak' | 'free-after-peak';
  readonly entries: readonly CapacityEntry[];
  readonly totalBytes: number;
}

export interface CapacityForecastV3 {
  readonly schemaVersion: 3;
  readonly candidateSha256: string;
  readonly measuredAt: string;
  readonly buckets: readonly CapacityBucket[];
  readonly initialFreeBytes: number;
  readonly predictedPeakBytes: number;
  readonly freeAfterPeakBytes: number;
}

export type CapacityWarning = 'F005_CAPACITY_ARTIFACT_WARNING' | 'F005_CAPACITY_REPOSITORY_WARNING';

export interface CapacityThresholdInput {
  readonly audioBytes: number;
  readonly artifactBytes: number;
  readonly repositoryBytes: number;
  readonly objectBytes: number;
  readonly workspacePeakBytes: number;
  readonly initialFreeBytes: number;
}

export interface CapacityThresholdDecision {
  readonly blocked: boolean;
  readonly freeAfterPeakBytes: number;
  readonly warnings: readonly CapacityWarning[];
}

export interface RankingSource {
  readonly bytes: Uint8Array | string;
  readonly expectedSha256?: string;
}

export interface AuthorRankingEntry {
  readonly rank: number;
  readonly authorId: string;
  readonly name: string;
  readonly identitySha256: string;
  readonly score: number;
  readonly sourceRanks: readonly number[];
}

export interface AuthorRankingEvidence {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof F005_RANKING_POLICY_VERSION;
  readonly rankingXhtmlSha256: string;
  readonly extendedCsvSha256: string;
  readonly adoptedRows: 500;
  readonly formula: 'sum(views) desc, personId numeric asc';
  readonly entries: readonly AuthorRankingEntry[];
  readonly resultDigest: string;
}

export type EligibilityReason = 'rights' | 'publication' | 'dialogue-density' | 'capacity';

export type AuthorEligibility =
  | { readonly authorId: string; readonly decision: 'allow' }
  | { readonly authorId: string; readonly decision: 'exclude'; readonly reason: EligibilityReason };

export interface CompletedExpansionAuthor {
  readonly authorId: string;
  readonly identitySha256: string;
}

export interface AuthorExpansionPlanV1 {
  readonly schemaVersion: 1;
  readonly baselineAuthors: 3;
  readonly targetAdditionalAuthors: 10;
  readonly finalAuthorLimit: 13;
  readonly rankingDigest: string;
  readonly completedAuthors: readonly CompletedExpansionAuthor[];
  readonly excluded: readonly { readonly authorId: string; readonly reason: EligibilityReason }[];
  readonly addedCount: number;
  readonly remainingCount: number;
  readonly nextCandidate: AuthorRankingEntry | null;
  readonly planDigest: string;
}

export class F005FoundationError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F005FoundationError';
  }
}

export class F005CapacityError extends F005FoundationError {
  constructor(message: string, public readonly forecast: CapacityForecastV3) {
    super('F005_CAPACITY_LIMIT_EXCEEDED', message);
    this.name = 'F005CapacityError';
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new F005FoundationError('F005_CAPACITY_INTEGER_INVALID', `${name}は非負のsafe integerが必要です`);
  }
}

function assertContext(context: F005ApprovedBatchContext): void {
  const candidate = context?.candidate;
  if (!isMintedF005ApprovedBatchContext(context) ||
    context.__brand !== 'ApprovedBatchContext' || candidate?.batchId !== 'F005' ||
    context.definition?.feature !== 'F005' || context.definition.batchId !== 'F005' ||
    context.policy?.requirementApprovalSnapshot !== '18e3fa50edfe5214480a65ed2e840fe49a663ee2' ||
    context.implementationControl?.__brand !== 'VerifiedImplementationRegistryControl' ||
    canonicalJson(candidate.author) !== canonicalJson({
      authorId: '000148',
      identitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f',
      name: 'なつめそうせき',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
    })) {
    throw new F005FoundationError('F005_APPROVAL_CONTEXT_INVALID', 'F005 ApprovedBatchContextが必要です');
  }
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new F005FoundationError('F005_BASELINE_MISMATCH', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch (error) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'workspace実体が安全ではありません', { cause: error });
  }
  return root;
}

async function gitBuffer(workspace: string, args: readonly string[]): Promise<Uint8Array> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return new Uint8Array(stdout);
  } catch (error) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', '固定Git objectを読めません', { cause: error });
  }
}

export const nodeV040GitAdapter: V040GitAdapter = Object.freeze({
  async resolveCommit(workspace: string, ref: string) {
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const raw = new TextDecoder().decode(await gitBuffer(workspace, ['ls-tree', '-r', '-l', '-z', commit, '--', 'public']));
    return raw.split('\0').filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\tpublic\/(.+)$/u.exec(entry);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new F005FoundationError('F005_BASELINE_MISMATCH', 'public Git tree entryが不正です');
      }
      return Object.freeze({
        mode: match[1] as '100644' | '100755',
        oid: match[2],
        bytes: Number(match[3]),
        path: match[4],
      });
    });
  },
  async readObject(workspace: string, commit: string, path: string) {
    if (!/^[0-9a-f]{40}$/u.test(commit) || !SAFE_PATH.test(path)) {
      throw new F005FoundationError('F005_BASELINE_MISMATCH', 'Git object refが不正です');
    }
    return gitBuffer(workspace, ['show', `${commit}:${path}`]);
  },
});

function assertDescriptor(value: unknown, raw: string): asserts value is V040Descriptor {
  if (!isRecord(value) || raw !== canonicalJson(value) || sha256(raw) !== DESCRIPTOR_SHA256 ||
    value.schemaVersion !== '1.0.0' || value.release !== 'v0.4.0' ||
    value.releaseCommit !== F005_V040_PINS.releaseCommit || value.tag !== F005_V040_PINS.tag ||
    value.catalogSha256 !== F005_V040_PINS.catalogSha256 ||
    value.contentTreeSha256 !== F005_V040_PINS.contentTreeSha256 ||
    !isRecord(value.counts) || value.counts.authors !== 3 || value.counts.works !== 12 ||
    value.counts.dialogues !== 674 || value.counts.audioAssets !== 662 || value.counts.batches !== 4 ||
    !isRecord(value.trackedPublic) || value.trackedPublic.files !== F005_V040_PINS.publicFiles ||
    value.trackedPublic.bytes !== F005_V040_PINS.publicBytes ||
    !isRecord(value.dist) || value.dist.files !== F005_V040_PINS.distFiles ||
    value.dist.bytes !== F005_V040_PINS.distBytes || value.dist.sha256 !== F005_V040_PINS.distSha256 ||
    !isRecord(value.production) || value.production.artifactDigest !== F005_V040_PINS.artifactDigest ||
    value.production.artifactFiles !== F005_V040_PINS.distFiles ||
    value.production.artifactBytes !== F005_V040_PINS.distBytes ||
    !isRecord(value.control) || value.control.commit !== F005_V040_PINS.controlCommit) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'v0.4.0 descriptorが固定値と一致しません');
  }
}

function assertCatalog(value: unknown): asserts value is CatalogV2 {
  if (!isRecord(value) || value.schemaVersion !== '2.0.0' ||
    !Array.isArray(value.authors) || value.authors.length !== 3 ||
    !Array.isArray(value.works) || value.works.length !== 12 ||
    !Array.isArray(value.audioAssets) || value.audioAssets.length !== 662 ||
    !Array.isArray(value.batches) || value.batches.length !== 4 ||
    value.works.reduce((count, work) =>
      count + (isRecord(work) && Array.isArray(work.dialogues) ? work.dialogues.length : Number.NaN), 0) !== 674) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'v0.4.0 Catalog projectionが不正です');
  }
}

/**
 * v0.4.0のrelease payloadとpostrelease controlを別Git objectから固定する。
 * @des DES-F005-001 @fun FUN-F005-002
 */
export async function loadV040Baseline(
  workspace: string,
  context: F005ApprovedBatchContext,
  options: V040LoadOptions = {},
): Promise<V040Baseline> {
  assertContext(context);
  const root = await verifiedWorkspace(workspace);
  const descriptorFile = join(root, ...DESCRIPTOR_PATH.split('/'));
  let raw: string;
  try {
    const info = await lstat(descriptorFile);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(descriptorFile) !== descriptorFile) throw new Error('unsafe');
    raw = await readFile(descriptorFile, 'utf8');
  } catch (error) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'baseline descriptorを安全に読めません', { cause: error });
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptorValue, raw);
  const descriptor = descriptorValue;
  const git = options.git ?? nodeV040GitAdapter;
  const [releaseCommit, tagCommit, controlCommit] = await Promise.all([
    git.resolveCommit(root, descriptor.releaseCommit),
    git.resolveCommit(root, descriptor.tag),
    git.resolveCommit(root, descriptor.control.commit),
  ]);
  if (releaseCommit !== F005_V040_PINS.releaseCommit || tagCommit !== releaseCommit ||
    controlCommit !== F005_V040_PINS.controlCommit) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'release/tag/control identityが一致しません');
  }

  const tree = await git.listPublicTree(root, releaseCommit);
  if (tree.length !== descriptor.trackedPublic.files ||
    tree.reduce((sum, file) => sum + file.bytes, 0) !== descriptor.trackedPublic.bytes) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'public files/bytesが一致しません');
  }
  const contentDigest = createHash('sha256');
  const publicFiles: V040GitFile[] = [];
  let catalogBytes: Uint8Array | undefined;
  for (const file of tree) {
    if (!SAFE_PATH.test(file.path) || !GIT_OID.test(file.oid) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new F005FoundationError('F005_BASELINE_MISMATCH', 'public tree entryが不正です');
    }
    const bytes = await git.readObject(root, releaseCommit, `public/${file.path}`);
    if (bytes.byteLength !== file.bytes) {
      throw new F005FoundationError('F005_BASELINE_MISMATCH', `public blob bytesが一致しません: ${file.path}`);
    }
    const fileSha = sha256(bytes);
    publicFiles.push({ ...file, sha256: fileSha });
    contentDigest.update(file.path).update('\0').update(String(file.bytes)).update('\0').update(bytes);
    if (file.path === 'content/catalog.json') catalogBytes = bytes;
  }
  if (contentDigest.digest('hex') !== descriptor.contentTreeSha256 || !catalogBytes ||
    sha256(catalogBytes) !== descriptor.catalogSha256) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'public content/catalog SHAが一致しません');
  }

  const [manifestBytes, precheckBytes, releaseEvidenceBytes] = await Promise.all([
    git.readObject(root, controlCommit, descriptor.control.manifestPath),
    git.readObject(root, controlCommit, descriptor.control.precheckPath),
    git.readObject(root, controlCommit, descriptor.control.releaseEvidencePath),
  ]);
  if (sha256(manifestBytes) !== descriptor.control.manifestSha256 ||
    sha256(precheckBytes) !== descriptor.control.precheckSha256 ||
    sha256(releaseEvidenceBytes) !== descriptor.control.releaseEvidenceSha256) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'control evidence SHAが一致しません');
  }
  let catalog: unknown;
  let manifest: unknown;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch (error) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'baseline JSONが不正です', { cause: error });
  }
  assertCatalog(catalog);
  if (!isRecord(manifest) || manifest.batchId !== 'F004' || manifest.status !== 'published') {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'F004 published controlが不正です');
  }
  const releaseText = new TextDecoder().decode(releaseEvidenceBytes);
  const precheckText = new TextDecoder().decode(precheckBytes);
  const required = [
    descriptor.releaseCommit, descriptor.catalogSha256, descriptor.dist.sha256,
    descriptor.production.artifactDigest, descriptor.production.artifactId,
    descriptor.production.deploymentId, descriptor.production.runId,
  ];
  if (required.some((item) => !`${precheckText}\n${releaseText}`.includes(item))) {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'release evidence tupleが一致しません');
  }
  const baseline = freezeDeep({
    __brand: 'V040Baseline' as const,
    descriptorSha256: DESCRIPTOR_SHA256,
    catalog,
    publicFiles,
    controlManifest: manifest,
    pins: { ...F005_V040_PINS },
  });
  baselines.add(baseline);
  return baseline;
}

function baselineCatalogProjection(catalog: CatalogV2, baseline: CatalogV2): unknown {
  const authors = new Set(baseline.authors.map((entry) => entry.authorId));
  const works = new Set(baseline.works.map((entry) => entry.workId));
  const audio = new Set(baseline.audioAssets.map((entry) => entry.audioId));
  const batches = new Set(baseline.batches.map((entry) => entry.batchId));
  return {
    schemaVersion: catalog.schemaVersion,
    authors: catalog.authors.filter((entry) => authors.has(entry.authorId)),
    works: catalog.works.filter((entry) => works.has(entry.workId)),
    audioAssets: catalog.audioAssets.filter((entry) => audio.has(entry.audioId)),
    batches: catalog.batches.filter((entry) => batches.has(entry.batchId)),
    candidateCounts: {
      byBatch: Object.fromEntries([...batches].sort().map((id) => [id, catalog.candidateCounts.byBatch[id]])),
    },
    creditsRef: catalog.creditsRef,
  };
}

function isF005Addition(path: string): boolean {
  return path.startsWith('audio/F005/') || path.startsWith('data/batches/F005/') ||
    path === 'artwork/natsume-zundamon.png' ||
    path === 'content/artwork-provenance/F005.json' ||
    path.startsWith('content/batches/F005/') || path.startsWith('content/provenance/F005/');
}

function baselineCatalogReferences(catalog: CatalogV2): readonly string[] {
  const references = new Set<string>([
    catalog.creditsRef,
    ...catalog.authors.map((author) => author.artwork.path),
    ...catalog.works.map((work) => work.source.provenancePath),
    ...catalog.audioAssets.map((asset) => asset.path),
  ]);
  return [...references].sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * candidate treeの既存content/media projectionをv0.4.0とexact比較する。
 * @des DES-F005-001 @fun FUN-F005-003
 */
export function verifyV040Projection(
  context: F005ApprovedBatchContext,
  baseline: V040Baseline,
  candidateTree: V040CandidateTree,
): BaselineInvariantReport {
  assertContext(context);
  if (!baselines.has(baseline) || baseline.__brand !== 'V040Baseline') {
    throw new F005FoundationError('F005_BASELINE_MISMATCH', 'mint済みbaselineが必要です');
  }
  const mismatches: string[] = [];
  const candidateFiles = new Map<string, V040GitFile>();
  for (const file of candidateTree.files) {
    if (!SAFE_PATH.test(file.path) || candidateFiles.has(file.path) || !SHA256.test(file.sha256)) {
      mismatches.push(`UNTRACKED_OR_INVALID:${file.path}`);
    } else candidateFiles.set(file.path, file);
  }
  const baselineFiles = new Map(baseline.publicFiles.map((file) => [file.path, file]));
  for (const expected of baseline.publicFiles) {
    const actual = candidateFiles.get(expected.path);
    if (!actual) mismatches.push(`PATH_MISSING:${expected.path}`);
    else if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 ||
      actual.mode !== expected.mode) mismatches.push(`FILE_MISMATCH:${expected.path}`);
  }
  for (const path of candidateFiles.keys()) {
    if (!baselineFiles.has(path) && !isF005Addition(path)) {
      mismatches.push(`UNTRACKED_ADDITION:${path}`);
    }
  }
  for (const path of baselineCatalogReferences(baseline.catalog)) {
    const expected = baselineFiles.get(path);
    const actual = candidateFiles.get(path);
    if (!expected || !actual ||
      actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 ||
      actual.mode !== expected.mode) {
      mismatches.push(`REFERENCE_MISMATCH:${path}`);
    }
  }
  if (canonicalJson(baselineCatalogProjection(candidateTree.catalog, baseline.catalog)) !==
    canonicalJson(baselineCatalogProjection(baseline.catalog, baseline.catalog))) {
    mismatches.push('CATALOG_PROJECTION_MISMATCH');
  }
  const payload = {
    result: mismatches.length === 0 ? 'pass' as const : 'blocked' as const,
    baselineDescriptorSha256: baseline.descriptorSha256,
    mismatches: [...mismatches].sort((left, right) => left.localeCompare(right, 'en')),
  };
  return freezeDeep({ ...payload, reportSha256: sha256(canonicalJson(payload)) });
}

/**
 * baselineに存在しない夏目漱石のauthor identityをcanonical値から再計算する。
 * @des DES-F005-002 @fun FUN-F005-004
 */
export function verifyNatsumeIdentity(
  context: F005ApprovedBatchContext,
  baselineCatalog: CatalogV2,
): VerifiedNewAuthor {
  assertContext(context);
  const author = context.candidate.author;
  const core = {
    authorId: author.authorId,
    name: author.name,
    originalName: author.originalName,
    slug: author.slug,
  };
  if (sha256(canonicalJson(core)) !== author.identitySha256 ||
    baselineCatalog.authors.some((existing) =>
      existing.authorId === author.authorId || existing.name === author.name ||
      existing.originalName === author.originalName || existing.slug === author.slug ||
      existing.artwork.path === 'artwork/natsume-zundamon.png') ||
    baselineCatalog.works.some((work) => work.authorId === author.authorId)) {
    throw new F005FoundationError('F005_AUTHOR_IDENTITY_CONFLICT', '夏目漱石identityが不正または既存Catalogと衝突します');
  }
  const verified = freezeDeep({
    __brand: 'VerifiedNewAuthor' as const,
    authorId: '000148' as const,
    name: 'なつめそうせき' as const,
    originalName: '夏目漱石' as const,
    slug: 'natsume-soseki' as const,
    identitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f' as const,
  });
  verifiedAuthors.add(verified);
  return verified;
}

function total(entries: readonly CapacityEntry[], useMaximum = false): number {
  let value = 0;
  for (const entry of entries) {
    value = useMaximum ? Math.max(value, entry.bytes) : value + entry.bytes;
    if (!Number.isSafeInteger(value)) {
      throw new F005FoundationError('F005_CAPACITY_INTEGER_INVALID', '容量合計がoverflowしました');
    }
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function claimKey(claim: F005CandidateHashClaim): string {
  if (claim.kind === 'path') return `${claim.bucket}:path:${claim.path}`;
  if (claim.kind === 'git-index') return `${claim.bucket}:git-index:${claim.path}`;
  return `${claim.bucket}:git-object:${claim.oid}`;
}

function normalizeClaims(claims: readonly F005CandidateHashClaim[]): readonly F005CandidateHashClaim[] {
  if (claims.length === 0) {
    throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'capacity claimが空です');
  }
  const values = new Map<string, F005CandidateHashClaim>();
  for (const claim of claims) {
    const valid = SHA256.test(claim.sha256) && (
      claim.kind === 'path'
        ? ['audio', 'artifact', 'workspace-peak'].includes(claim.bucket) && SAFE_PATH.test(claim.path)
        : claim.kind === 'git-index'
          ? claim.bucket === 'repository' && SAFE_PATH.test(claim.path) && GIT_OID.test(claim.oid)
          : claim.kind === 'git-object' && claim.bucket === 'object' && GIT_OID.test(claim.oid)
    );
    if (!valid) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'capacity claimが不正です');
    }
    const key = claimKey(claim);
    if (values.has(key)) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', `capacity claimが重複しています: ${key}`);
    }
    values.set(key, freezeDeep({ ...claim }));
  }
  const buckets = new Set([...values.values()].map((claim) => claim.bucket));
  for (const bucket of ['audio', 'artifact', 'repository', 'object', 'workspace-peak'] as const) {
    if (!buckets.has(bucket)) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', `capacity bucketがありません: ${bucket}`);
    }
  }
  return [...values.values()].sort((left, right) => claimKey(left).localeCompare(claimKey(right), 'en'));
}

function capacityPlanPayload(
  candidateSha256: string,
  measuredAt: string,
  baselineDescriptorSha256: string,
  inventoryDigest: string,
  expectedClaims: readonly F005CandidateHashClaim[],
): string {
  return sha256(canonicalJson({
    candidateSha256,
    measuredAt,
    baselineDescriptorSha256,
    inventoryDigest,
    expectedClaims,
  }));
}

export function evaluateF005CapacityThresholds(
  input: CapacityThresholdInput,
): CapacityThresholdDecision {
  for (const [name, value] of Object.entries(input)) assertSafeInteger(value, name);
  const freeAfterPeakBytes = Math.max(0, input.initialFreeBytes - input.workspacePeakBytes);
  const warnings: CapacityWarning[] = [];
  if (input.artifactBytes >= F005_CAPACITY_LIMITS.artifactWarningBytes) {
    warnings.push('F005_CAPACITY_ARTIFACT_WARNING');
  }
  if (input.repositoryBytes >= F005_CAPACITY_LIMITS.repositoryWarningBytes) {
    warnings.push('F005_CAPACITY_REPOSITORY_WARNING');
  }
  return Object.freeze({
    blocked: input.audioBytes > F005_CAPACITY_LIMITS.audioStopBytes ||
      input.artifactBytes > F005_CAPACITY_LIMITS.artifactStopBytes ||
      input.repositoryBytes > F005_CAPACITY_LIMITS.repositoryStopBytes ||
      input.objectBytes > F005_CAPACITY_LIMITS.objectStopBytes ||
      freeAfterPeakBytes < F005_CAPACITY_LIMITS.minimumFreeBytes,
    freeAfterPeakBytes,
    warnings: Object.freeze(warnings),
  });
}

async function readSafeWorkspaceFile(root: string, relativePath: string): Promise<Uint8Array> {
  const file = join(root, ...relativePath.split('/'));
  try {
    const relation = relative(root, file);
    if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error('outside');
    }
    let current = root;
    const segments = relativePath.split('/');
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink() ||
        (index < segments.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
        throw new Error('unsafe segment');
      }
    }
    const before = await lstat(file);
    const actual = await realpath(file);
    if (actual !== file) throw new Error('unsafe realpath');
    const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const during = await handle.stat();
      if (!during.isFile() || during.nlink !== 1 ||
        during.dev !== before.dev || during.ino !== before.ino ||
        during.size !== before.size || during.mtimeMs !== before.mtimeMs) {
        throw new Error('identity changed before read');
      }
      const bytes = new Uint8Array(await handle.readFile());
      const afterHandle = await handle.stat();
      const afterPath = await lstat(file);
      if (afterHandle.dev !== during.dev || afterHandle.ino !== during.ino ||
        afterHandle.size !== during.size || afterHandle.mtimeMs !== during.mtimeMs ||
        afterPath.dev !== during.dev || afterPath.ino !== during.ino ||
        afterPath.size !== during.size || afterPath.mtimeMs !== during.mtimeMs ||
        afterPath.nlink !== 1 || afterPath.isSymbolicLink()) {
        throw new Error('identity changed during read');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new F005FoundationError(
      'F005_CAPACITY_ENTRY_INVALID',
      `workspace fileを安全に実測できません: ${relativePath}`,
      { cause: error },
    );
  }
}

async function discoverRootFiles(
  root: string,
  relativeRoot: string,
  bucket: 'audio' | 'artifact' | 'workspace-peak',
): Promise<readonly F005CapacityInventoryEntry[]> {
  const base = join(root, ...relativeRoot.split('/'));
  const paths: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const values = await readdir(directory, { withFileTypes: true });
    values.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const value of values) {
      const relativePath = `${relativeDirectory}/${value.name}`;
      if (value.isSymbolicLink()) {
        throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'canonical capacity rootにlinkがあります');
      }
      if (value.isDirectory()) await visit(join(directory, value.name), relativePath);
      else if (value.isFile()) paths.push(relativePath);
      else throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'canonical capacity rootに通常file以外があります');
    }
  };
  try {
    const info = await lstat(base);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(base) !== base) throw new Error('unsafe root');
    await visit(base, relativeRoot);
  } catch (error) {
    throw new F005FoundationError(
      'F005_CAPACITY_ENTRY_INVALID',
      `canonical capacity rootを完全列挙できません: ${relativeRoot}`,
      { cause: error },
    );
  }
  return Promise.all(paths.map(async (path) => {
    const bytes = await readSafeWorkspaceFile(root, path);
    return freezeDeep({
      kind: 'path' as const,
      bucket,
      path,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }));
}

async function readGitBlob(root: string, oid: string): Promise<Uint8Array> {
  try {
    return await gitBuffer(root, ['cat-file', 'blob', oid]);
  } catch (error) {
    throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git blobを完全列挙できません', { cause: error });
  }
}

async function discoverGitIndex(root: string): Promise<readonly F005CapacityInventoryEntry[]> {
  let raw: string;
  try {
    raw = new TextDecoder().decode(await gitBuffer(root, ['ls-files', '--stage', '-z']));
  } catch (error) {
    throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git indexを完全列挙できません', { cause: error });
  }
  const records = raw.split('\0').filter(Boolean);
  const parsed = records.map((record) => {
    const match = /^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([A-Za-z0-9._/-]+)$/u.exec(record);
    if (!match?.[1] || !match[2] || !match[3] || !SAFE_PATH.test(match[3])) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git index entryが通常file stage 0ではありません');
    }
    return { oid: match[2], path: match[3] };
  });
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.path)) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git index pathが重複しています');
    }
    seen.add(entry.path);
  }
  parsed.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const blobCache = new Map<string, Promise<Uint8Array>>();
  return mapWithConcurrency(parsed, 8, async ({ oid, path }) => {
    const promise = blobCache.get(oid) ?? readGitBlob(root, oid);
    blobCache.set(oid, promise);
    const bytes = await promise;
    return freezeDeep({
      kind: 'git-index' as const,
      bucket: 'repository' as const,
      path,
      oid,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
}

async function discoverGitObjects(root: string): Promise<readonly F005CapacityInventoryEntry[]> {
  let raw: string;
  try {
    raw = new TextDecoder().decode(await gitBuffer(root, [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype) %(objectsize)',
    ]));
  } catch (error) {
    throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git object databaseを完全列挙できません', {
      cause: error,
    });
  }
  const blobs = raw.split(/\r?\n/u).filter(Boolean).flatMap((record) => {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/u.exec(record);
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git object database entryが不正です');
    }
    if (match[2] !== 'blob') return [];
    const bytes = Number(match[3]);
    assertSafeInteger(bytes, 'gitObject.bytes');
    return [{ oid: match[1], bytes }];
  });
  blobs.sort((left, right) => left.oid.localeCompare(right.oid, 'en'));
  return mapWithConcurrency(blobs, 8, async ({ oid, bytes: expectedBytes }) => {
    const bytes = await readGitBlob(root, oid);
    if (bytes.byteLength !== expectedBytes) {
      throw new F005FoundationError('F005_CAPACITY_ENTRY_INVALID', 'Git blob sizeが列挙結果と一致しません');
    }
    return freezeDeep({
      kind: 'git-object' as const,
      bucket: 'object' as const,
      oid,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
}

function inventoryClaim(entry: F005CapacityInventoryEntry): F005CandidateHashClaim {
  if (entry.kind === 'path') {
    return freezeDeep({ kind: entry.kind, bucket: entry.bucket, path: entry.path, sha256: entry.sha256 });
  }
  if (entry.kind === 'git-index') {
    return freezeDeep({
      kind: entry.kind,
      bucket: entry.bucket,
      path: entry.path,
      oid: entry.oid,
      sha256: entry.sha256,
    });
  }
  return freezeDeep({ kind: entry.kind, bucket: entry.bucket, oid: entry.oid, sha256: entry.sha256 });
}

function contextCandidateSha256(context: F005ApprovedBatchContext): string {
  return sha256(canonicalJson({
    candidate: context.candidate,
    definition: context.definition,
    policy: context.policy,
  }));
}

/**
 * 固定canonical roots、Git index、全Git blobをcaller入力なしで完全列挙する。
 * @des DES-F005-006 @fun FUN-F005-018
 */
export async function discoverF005CapacityInventory(
  workspace: string,
  context: F005ApprovedBatchContext,
  baseline: V040Baseline,
): Promise<F005CapacityInventory> {
  assertContext(context);
  if (!baselines.has(baseline) || baseline.__brand !== 'V040Baseline') {
    throw new F005FoundationError('F005_CAPACITY_PLAN_MISMATCH', 'mint済みbaselineが必要です');
  }
  const root = await verifiedWorkspace(workspace);
  const [audio, artifact, repository, objects, workspacePeak] = await Promise.all([
    discoverRootFiles(root, F005_CAPACITY_ROOTS.audio, 'audio'),
    discoverRootFiles(root, F005_CAPACITY_ROOTS.artifact, 'artifact'),
    discoverGitIndex(root),
    discoverGitObjects(root),
    discoverRootFiles(root, F005_CAPACITY_ROOTS.workspacePeak, 'workspace-peak'),
  ]);
  const entries = freezeDeep([...audio, ...artifact, ...repository, ...objects, ...workspacePeak]);
  normalizeClaims(entries.map(inventoryClaim));
  const payload = {
    candidateSha256: contextCandidateSha256(context),
    baselineDescriptorSha256: baseline.descriptorSha256,
    entries,
  };
  const inventory = freezeDeep({
    __brand: 'F005CapacityInventory' as const,
    ...payload,
    measuredAt: new Date().toISOString(),
    inventoryDigest: sha256(canonicalJson(payload)),
  });
  capacityInventories.add(inventory);
  return inventory;
}

export function createF005CapacityPlan(
  context: F005ApprovedBatchContext,
  baseline: V040Baseline,
  inventory: F005CapacityInventory,
): F005CapacityPlan {
  assertContext(context);
  if (!baselines.has(baseline) || !capacityInventories.has(inventory) ||
    inventory.candidateSha256 !== contextCandidateSha256(context) ||
    inventory.baselineDescriptorSha256 !== baseline.descriptorSha256 ||
    inventory.inventoryDigest !== sha256(canonicalJson({
      candidateSha256: inventory.candidateSha256,
      baselineDescriptorSha256: inventory.baselineDescriptorSha256,
      entries: inventory.entries,
    }))) {
    throw new F005FoundationError('F005_CAPACITY_PLAN_MISMATCH', 'canonical inventoryからだけplanを作成できます');
  }
  const claims = normalizeClaims(inventory.entries.map(inventoryClaim));
  const payload = {
    __brand: 'F005CapacityPlan' as const,
    candidateSha256: inventory.candidateSha256,
    measuredAt: inventory.measuredAt,
    baselineDescriptorSha256: baseline.descriptorSha256,
    inventoryDigest: inventory.inventoryDigest,
    expectedClaims: claims,
    planDigest: capacityPlanPayload(
      inventory.candidateSha256,
      inventory.measuredAt,
      baseline.descriptorSha256,
      inventory.inventoryDigest,
      claims,
    ),
  };
  const plan = freezeDeep(payload);
  capacityPlans.add(plan);
  capacityPlanContexts.set(plan, context);
  return plan;
}

/**
 * workspace/Git objectを実測して6容量区分をcandidate hashへ結合する。
 * @des DES-F005-006 @fun FUN-F005-018
 */
export async function forecastF005Capacity(
  workspace: string,
  plan: F005CapacityPlan,
  baseline: V040Baseline,
  candidateHashes: F005CandidateHashes,
): Promise<CapacityForecastV3> {
  const root = await verifiedWorkspace(workspace);
  const approvedContext = capacityPlanContexts.get(plan);
  if (!baselines.has(baseline) || !capacityPlans.has(plan) ||
    !approvedContext ||
    plan.baselineDescriptorSha256 !== baseline.descriptorSha256 ||
    plan.planDigest !== capacityPlanPayload(
      plan.candidateSha256,
      plan.measuredAt,
      plan.baselineDescriptorSha256,
      plan.inventoryDigest,
      plan.expectedClaims,
    )) {
    throw new F005FoundationError('F005_CAPACITY_PLAN_MISMATCH', 'mint済みcapacity planとbaselineが必要です');
  }
  let actualClaims: readonly F005CandidateHashClaim[];
  try {
    actualClaims = normalizeClaims(candidateHashes.claims);
  } catch (error) {
    throw new F005FoundationError('F005_CAPACITY_PLAN_MISMATCH', 'candidate hash claimが不正です', { cause: error });
  }
  if (candidateHashes.candidateSha256 !== plan.candidateSha256 ||
    canonicalJson(actualClaims) !== canonicalJson(plan.expectedClaims)) {
    throw new F005FoundationError('F005_CAPACITY_PLAN_MISMATCH', 'candidate hash claimがplanと一致しません');
  }
  const currentInventory = await discoverF005CapacityInventory(root, approvedContext, baseline);
  const currentClaims = normalizeClaims(currentInventory.entries.map(inventoryClaim));
  if (currentInventory.inventoryDigest !== plan.inventoryDigest ||
    canonicalJson(currentClaims) !== canonicalJson(plan.expectedClaims)) {
    throw new F005FoundationError(
      'F005_CAPACITY_PLAN_MISMATCH',
      'canonical capacity inventoryがplan後に変化しました',
    );
  }
  const measured = currentInventory.entries.map((item) => {
    const entry: CapacityEntry = item.kind === 'path'
      ? { kind: item.kind, path: item.path, bytes: item.bytes, sha256: item.sha256 }
      : item.kind === 'git-index'
        ? {
          kind: item.kind,
          path: item.path,
          oid: item.oid,
          bytes: item.bytes,
          sha256: item.sha256,
        }
        : { kind: item.kind, oid: item.oid, bytes: item.bytes, sha256: item.sha256 };
    return { claim: inventoryClaim(item), entry: freezeDeep(entry) };
  });
  const entries = (bucket: CapacityMeasuredKind): readonly CapacityEntry[] =>
    measured.filter((item) => item.claim.bucket === bucket).map((item) => item.entry);
  const audio = entries('audio');
  const artifact = entries('artifact');
  const repository = entries('repository');
  const objects = entries('object');
  const peakEntries = entries('workspace-peak');
  const audioBytes = total(audio);
  const artifactBytes = total(artifact);
  const repositoryBytes = total(repository);
  const objectBytes = total(objects, true);
  const predictedPeakBytes = total(peakEntries);
  const filesystem = await statfs(root, { bigint: true });
  const free = filesystem.bavail * filesystem.bsize;
  if (free > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new F005FoundationError('F005_CAPACITY_INTEGER_INVALID', 'filesystem free bytesがsafe integerを超えました');
  }
  const initialFreeBytes = Number(free);
  const decision = evaluateF005CapacityThresholds({
    audioBytes,
    artifactBytes,
    repositoryBytes,
    objectBytes,
    workspacePeakBytes: predictedPeakBytes,
    initialFreeBytes,
  });
  const forecast = freezeDeep({
    schemaVersion: 3 as const,
    candidateSha256: plan.candidateSha256,
    measuredAt: plan.measuredAt,
    buckets: [
      { kind: 'audio' as const, entries: audio, totalBytes: audioBytes },
      { kind: 'artifact' as const, entries: artifact, totalBytes: artifactBytes },
      { kind: 'repository' as const, entries: repository, totalBytes: repositoryBytes },
      { kind: 'object' as const, entries: objects, totalBytes: objectBytes },
      { kind: 'workspace-peak' as const, entries: peakEntries, totalBytes: predictedPeakBytes },
      { kind: 'free-after-peak' as const, entries: [], totalBytes: decision.freeAfterPeakBytes },
    ],
    initialFreeBytes,
    predictedPeakBytes,
    freeAfterPeakBytes: decision.freeAfterPeakBytes,
  });
  if (decision.blocked) {
    throw new F005CapacityError('F005容量停止境界を超えました', forecast);
  }
  return forecast;
}

export function capacityWarnings(forecast: CapacityForecastV3): readonly CapacityWarning[] {
  const artifact = forecast.buckets.find((entry) => entry.kind === 'artifact')?.totalBytes ?? -1;
  const repository = forecast.buckets.find((entry) => entry.kind === 'repository')?.totalBytes ?? -1;
  const warnings: CapacityWarning[] = [];
  if (artifact >= F005_CAPACITY_LIMITS.artifactWarningBytes) warnings.push('F005_CAPACITY_ARTIFACT_WARNING');
  if (repository >= F005_CAPACITY_LIMITS.repositoryWarningBytes) warnings.push('F005_CAPACITY_REPOSITORY_WARNING');
  return Object.freeze(warnings);
}

function sourceBytes(source: RankingSource): Uint8Array {
  const bytes = typeof source.bytes === 'string' ? new TextEncoder().encode(source.bytes) : source.bytes;
  const digest = sha256(bytes);
  if (source.expectedSha256 !== undefined && source.expectedSha256 !== digest) {
    throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'ranking source SHAが一致しません');
  }
  return bytes;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .trim();
}

function plainCell(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' '));
}

function parseCsv(raw: string): readonly string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (quoted) {
      if (character === '"' && raw[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'CSV quoteが閉じていません');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/u, ''));
    rows.push(row);
  }
  return rows;
}

function column(headers: readonly string[], candidates: readonly string[]): number {
  const index = headers.findIndex((header) => candidates.includes(header.trim()));
  if (index < 0) throw new F005FoundationError('F005_RANKING_INPUT_INVALID', `CSV headerがありません: ${candidates[0]}`);
  return index;
}

interface RankingRow {
  readonly rank: number;
  readonly name: string;
  readonly personId?: string;
  readonly views: number;
}

function parseRankingRows(xhtml: string): readonly RankingRow[] {
  const rows: RankingRow[] = [];
  for (const match of xhtml.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/giu)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const cells = [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((cell) => plainCell(cell[1] ?? ''));
    const rankText = /\bdata-rank=["']([0-9]+)["']/iu.exec(attributes)?.[1] ?? cells[0];
    const viewsText = /\bdata-views=["']([0-9,]+)["']/iu.exec(attributes)?.[1] ?? cells.at(-1);
    if (!rankText || !viewsText || !/^[0-9]+$/u.test(rankText) || !/^[0-9,]+$/u.test(viewsText)) continue;
    const authorAttribute = /\bdata-author=["']([^"']+)["']/iu.exec(attributes)?.[1];
    const personId = /\bdata-person-id=["']([0-9]{6})["']/iu.exec(attributes)?.[1] ??
      /(?:person|person_id|personid)[_/-]?([0-9]{6})/iu.exec(body)?.[1];
    const name = decodeEntities(authorAttribute ?? cells[1] ?? '');
    const rank = Number(rankText);
    const views = Number(viewsText.replaceAll(',', ''));
    if (!Number.isSafeInteger(rank) || rank <= 0 || !Number.isSafeInteger(views) || views < 0 || name.length === 0) {
      throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'ranking行の整数または作者名が不正です');
    }
    rows.push({ rank, name, ...(personId ? { personId } : {}), views });
  }
  if (rows.length !== 500 || rows.some((row, index) => row.rank !== index + 1)) {
    throw new F005FoundationError('F005_RANKING_INPUT_INVALID', '2022上位500行がrank順に揃っていません');
  }
  return rows;
}

/**
 * 2022上位500行を拡充CSVの著者person IDへjoinし、決定的順位証跡を作る。
 * @des DES-F005-013 @fun FUN-F005-040
 */
export function computeAuthorPopularityRanking(
  rankingXhtml: RankingSource,
  extendedCsv: RankingSource,
  policyVersion: string,
): AuthorRankingEvidence {
  if (policyVersion !== F005_RANKING_POLICY_VERSION) {
    throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'ranking式versionが一致しません');
  }
  const rankingBytes = sourceBytes(rankingXhtml);
  const csvBytes = sourceBytes(extendedCsv);
  const rows = parseRankingRows(new TextDecoder('utf-8', { fatal: true }).decode(rankingBytes));
  const csv = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(csvBytes));
  const firstRow = csv[0];
  if (!firstRow) throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'CSVが空です');
  const headers = [...firstRow];
  if (headers[0]) headers[0] = headers[0].replace(/^\uFEFF/u, '');
  const idColumn = column(headers, ['人物ID', 'personId', 'person_id']);
  const nameColumn = column(headers, ['氏名', '著者名', 'name']);
  const roleColumn = column(headers, ['役割', 'role']);
  const statusColumn = column(headers, ['公開状態', '公開', 'status']);
  const people = new Map<string, { id: string; name: string }>();
  const byName = new Map<string, { id: string; name: string }>();
  const csvRows = new Set<string>();
  for (const fields of csv.slice(1)) {
    const rowIdentity = canonicalJson(fields);
    if (csvRows.has(rowIdentity)) {
      throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'CSV完全重複行があります');
    }
    csvRows.add(rowIdentity);
    const id = fields[idColumn]?.trim() ?? '';
    const name = fields[nameColumn]?.trim() ?? '';
    const role = fields[roleColumn]?.trim() ?? '';
    const status = fields[statusColumn]?.trim() ?? '';
    if (role !== '著者' || !['公開中', '公開', '1', 'true'].includes(status)) continue;
    if (!PERSON_ID.test(id) || name.length === 0) {
      throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'CSV人物ID・作者名が重複または不正です');
    }
    const existingById = people.get(id);
    const existingByName = byName.get(name);
    if ((existingById && existingById.name !== name) ||
      (existingByName && existingByName.id !== id)) {
      throw new F005FoundationError('F005_RANKING_INPUT_INVALID', 'CSV人物ID・作者名が競合しています');
    }
    if (existingById) continue;
    const person = { id, name };
    people.set(id, person);
    byName.set(name, person);
  }
  const totals = new Map<string, { name: string; score: number; ranks: number[] }>();
  for (const row of rows) {
    const person = row.personId ? people.get(row.personId) : byName.get(row.name);
    if (!person || person.name !== row.name) {
      throw new F005FoundationError('F005_RANKING_INPUT_INVALID', `ranking作者をCSVへjoinできません: ${row.name}`);
    }
    const current = totals.get(person.id) ?? { name: person.name, score: 0, ranks: [] };
    current.score += row.views;
    if (!Number.isSafeInteger(current.score)) {
      throw new F005FoundationError('F005_RANKING_INPUT_INVALID', '閲覧数合計がoverflowしました');
    }
    current.ranks.push(row.rank);
    totals.set(person.id, current);
  }
  const sorted = [...totals.entries()].sort(([leftId, left], [rightId, right]) =>
    right.score - left.score || Number(leftId) - Number(rightId));
  const entries = sorted.map(([authorId, value], index) => freezeDeep({
    rank: index + 1,
    authorId,
    name: value.name,
    identitySha256: sha256(canonicalJson({ authorId, name: value.name })),
    score: value.score,
    sourceRanks: [...value.ranks],
  }));
  const payload = {
    schemaVersion: 1 as const,
    policyVersion: F005_RANKING_POLICY_VERSION,
    rankingXhtmlSha256: sha256(rankingBytes),
    extendedCsvSha256: sha256(csvBytes),
    adoptedRows: 500 as const,
    formula: 'sum(views) desc, personId numeric asc' as const,
    entries,
  };
  const evidence = freezeDeep({ ...payload, resultDigest: sha256(canonicalJson(payload)) });
  rankingEvidence.add(evidence);
  return evidence;
}

function planPayload(plan: Omit<AuthorExpansionPlanV1, 'planDigest'>): string {
  return sha256(canonicalJson(plan));
}

export function createInitialAuthorExpansionPlan(ranking: AuthorRankingEvidence): AuthorExpansionPlanV1 {
  const natsume = ranking.entries.find((entry) => entry.authorId === '000148');
  if (!rankingEvidence.has(ranking) || !natsume) {
    throw new F005FoundationError('F005_AUTHOR_PLAN_LIMIT', 'F005順位に夏目漱石が一意に必要です');
  }
  const payload = {
    schemaVersion: 1 as const,
    baselineAuthors: 3 as const,
    targetAdditionalAuthors: 10 as const,
    finalAuthorLimit: 13 as const,
    rankingDigest: ranking.resultDigest,
    completedAuthors: [],
    excluded: [],
    addedCount: 0,
    remainingCount: 10,
    nextCandidate: natsume,
  };
  const plan = freezeDeep({ ...payload, planDigest: planPayload(payload) });
  expansionPlans.add(plan);
  return plan;
}

/**
 * 完了作者をexact 1件進め、順位を保って次のeligible作者を一意選択する。
 * @des DES-F005-013 @fun FUN-F005-041
 */
export function advanceAuthorExpansionPlan(
  currentPlan: AuthorExpansionPlanV1,
  ranking: AuthorRankingEvidence,
  completedAuthor: CompletedExpansionAuthor,
  eligibility: readonly AuthorEligibility[],
): AuthorExpansionPlanV1 {
  if (!expansionPlans.has(currentPlan) || !rankingEvidence.has(ranking) ||
    currentPlan.rankingDigest !== ranking.resultDigest ||
    currentPlan.planDigest !== planPayload({
      schemaVersion: currentPlan.schemaVersion,
      baselineAuthors: currentPlan.baselineAuthors,
      targetAdditionalAuthors: currentPlan.targetAdditionalAuthors,
      finalAuthorLimit: currentPlan.finalAuthorLimit,
      rankingDigest: currentPlan.rankingDigest,
      completedAuthors: currentPlan.completedAuthors,
      excluded: currentPlan.excluded,
      addedCount: currentPlan.addedCount,
      remainingCount: currentPlan.remainingCount,
      nextCandidate: currentPlan.nextCandidate,
    }) ||
    currentPlan.addedCount >= 10 || !currentPlan.nextCandidate ||
    completedAuthor.authorId !== currentPlan.nextCandidate.authorId ||
    completedAuthor.identitySha256 !== currentPlan.nextCandidate.identitySha256 ||
    currentPlan.completedAuthors.some((entry) =>
      entry.authorId === completedAuthor.authorId || entry.identitySha256 === completedAuthor.identitySha256)) {
    throw new F005FoundationError('F005_AUTHOR_PLAN_LIMIT', '作者planの上限・順位・identityが不正です');
  }
  const decisions = new Map<string, AuthorEligibility>();
  for (const decision of eligibility) {
    if (!PERSON_ID.test(decision.authorId) || decisions.has(decision.authorId) ||
      (decision.decision === 'exclude' && !['rights', 'publication', 'dialogue-density', 'capacity'].includes(decision.reason))) {
      throw new F005FoundationError('F005_AUTHOR_PLAN_LIMIT', 'eligibilityが不正です');
    }
    decisions.set(decision.authorId, decision);
  }
  const completedAuthors = [...currentPlan.completedAuthors, freezeDeep({ ...completedAuthor })];
  const completedIds = new Set(completedAuthors.map((entry) => entry.authorId));
  const excluded = [...currentPlan.excluded];
  let nextCandidate: AuthorRankingEntry | null = null;
  if (completedAuthors.length < 10) {
    for (const candidate of ranking.entries) {
      if (V040_AUTHOR_IDS.has(candidate.authorId) || completedIds.has(candidate.authorId) ||
        excluded.some((entry) => entry.authorId === candidate.authorId)) continue;
      const decision = decisions.get(candidate.authorId);
      if (!decision) {
        throw new F005FoundationError('F005_AUTHOR_PLAN_LIMIT', `eligibilityがありません: ${candidate.authorId}`);
      }
      if (decision.decision === 'exclude') {
        excluded.push(freezeDeep({ authorId: candidate.authorId, reason: decision.reason }));
      } else {
        nextCandidate = candidate;
        break;
      }
    }
    if (!nextCandidate) throw new F005FoundationError('F005_AUTHOR_PLAN_LIMIT', '次のeligible作者がありません');
  }
  const payload = {
    schemaVersion: 1 as const,
    baselineAuthors: 3 as const,
    targetAdditionalAuthors: 10 as const,
    finalAuthorLimit: 13 as const,
    rankingDigest: ranking.resultDigest,
    completedAuthors,
    excluded,
    addedCount: completedAuthors.length,
    remainingCount: 10 - completedAuthors.length,
    nextCandidate,
  };
  const plan = freezeDeep({ ...payload, planDigest: planPayload(payload) });
  expansionPlans.add(plan);
  return plan;
}

export function isVerifiedNewAuthor(value: unknown): value is VerifiedNewAuthor {
  return isRecord(value) && verifiedAuthors.has(value);
}
