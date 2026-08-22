import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson } from './artifacts.ts';
import type { CatalogV2 } from './processing.ts';

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40}$/u;
const DESCRIPTOR_PATH = 'content/baselines/F007-v0.6.0.json';
const DESCRIPTOR_SHA256 = 'a0d1ce95880455f8ea8ecebda10d9f860cf606316621dac4c81cf68a8df315b0';

/**
 * v0.6.0固定pins。値はF006公開証跡(RELEASE-F006.md／F006-approval.json／F006-deployment.json)から
 * 実測して転記した固定値であり、候補checkoutの現行publicから再導出しない。
 * @des DES-F007-002 @fun FUN-F007-002
 */
export const F007_V060_PINS = Object.freeze({
  releaseCommit: '166556111de642770916c6397931ca4b61c786d9',
  tag: 'v0.6.0',
  catalogSha256: '7e362d767e7936af41b42e027b491c44d838e259cd92d0baf9bdc2bf14cf5967',
  distSha256: 'de440fbf1f6dccaa79ce369e470d8fe9ce322e68912ac9968d9f97e336ef14e9',
  artifactDigest: '327e392a6d0a2e62bd9e29f7a7dabd769d8f5678c5f57a8052709d8dae57a8d5',
} as const);

export type PublishedV060Pins = Readonly<typeof F007_V060_PINS>;

interface PublishedV060Descriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.6.0';
  readonly releaseCommit: string;
  readonly tag: 'v0.6.0';
  readonly catalogSha256: string;
  readonly publicTreeOid: string;
  readonly distSha256: string;
  readonly counts: {
    readonly authors: 5;
    readonly works: 18;
    readonly dialogues: 939;
    readonly audioAssets: 923;
    readonly batches: 6;
  };
  readonly trackedPublic: { readonly files: 965; readonly bytes: 304615300 };
  readonly production: {
    readonly runId: '32556527623';
    readonly artifactId: '9471657617';
    readonly artifactDigest: string;
  };
  readonly control: {
    readonly commit: string;
    readonly manifestPath: 'content/batches/F006/batch.json';
    readonly manifestSha256: string;
    readonly releaseEvidencePath: 'docs/evidence/release/RELEASE-F006.md';
    readonly releaseEvidenceSha256: string;
    readonly approvalEvidencePath: 'docs/evidence/release/F006-approval.json';
    readonly approvalEvidenceSha256: string;
    readonly deploymentEvidencePath: 'docs/evidence/release/F006-deployment.json';
    readonly deploymentEvidenceSha256: string;
  };
}

export interface PublishedV060GitFile {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly bytes: number;
  readonly path: string;
}

export interface PublishedV060Baseline {
  readonly __brand: 'PublishedV060Baseline';
  readonly pins: PublishedV060Pins;
  readonly catalog: CatalogV2;
  readonly publicFiles: readonly PublishedV060GitFile[];
  readonly descriptorSha256: string;
  readonly controlManifest: Readonly<Record<string, unknown>>;
}

const publishedBaselines = new WeakSet<object>();

export interface PublishedV060GitAdapter {
  resolveCommit(workspace: string, ref: string): Promise<string>;
  resolvePublicTreeOid(workspace: string, commit: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly PublishedV060GitFile[]>;
  readObject(workspace: string, commit: string, path: string): Promise<Uint8Array>;
}

export interface PublishedV060LoadOptions {
  readonly git?: PublishedV060GitAdapter;
}

export class PublishedV060BaselineError extends Error {
  readonly code = 'F007_PUBLISHED_BASELINE_MISMATCH';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishedV060BaselineError';
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new PublishedV060BaselineError('workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch (error) {
    throw new PublishedV060BaselineError('workspace実体が安全なdirectoryではありません', { cause: error });
  }
  return root;
}

async function gitBuffer(workspace: string, args: readonly string[]): Promise<Uint8Array> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return new Uint8Array(stdout);
  } catch (error) {
    throw new PublishedV060BaselineError('固定Git objectを読めません', { cause: error });
  }
}

export const nodePublishedV060GitAdapter: PublishedV060GitAdapter = Object.freeze({
  async resolveCommit(workspace: string, ref: string) {
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const raw = new TextDecoder().decode(await gitBuffer(workspace, ['ls-tree', '-r', '-l', '-z', commit, '--', 'public']));
    return raw.split('\0').filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\tpublic\/(.+)$/u.exec(entry);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new PublishedV060BaselineError('固定public tree entryが不正です');
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
    if (!OID.test(commit) || path.length === 0 || path.includes('\\') || path.includes('..') || path.startsWith('/')) {
      throw new PublishedV060BaselineError('固定Git object refが不正です');
    }
    return gitBuffer(workspace, ['show', `${commit}:${path}`]);
  },
  async resolvePublicTreeOid(workspace: string, commit: string) {
    if (!OID.test(commit)) throw new PublishedV060BaselineError('固定Git object refが不正です');
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${commit}:public`])).trim();
  },
});

function assertPins(pins: PublishedV060Pins): void {
  if (!isRecord(pins) ||
    !exactKeys(pins, ['releaseCommit', 'tag', 'catalogSha256', 'distSha256', 'artifactDigest']) ||
    Object.entries(F007_V060_PINS).some(([key, value]) => pins[key as keyof PublishedV060Pins] !== value)) {
    throw new PublishedV060BaselineError('v0.6.0固定pinsがexact値と一致しません');
  }
}

function assertDescriptor(value: unknown, raw: string): asserts value is PublishedV060Descriptor {
  if (!isRecord(value) || raw !== canonicalJson(value) || sha256(raw) !== DESCRIPTOR_SHA256 ||
    !exactKeys(value, [
      'catalogSha256', 'publicTreeOid', 'control', 'counts', 'distSha256',
      'production', 'release', 'releaseCommit', 'schemaVersion', 'tag', 'trackedPublic',
    ]) ||
    value.schemaVersion !== '1.0.0' || value.release !== 'v0.6.0' ||
    value.releaseCommit !== F007_V060_PINS.releaseCommit || value.tag !== F007_V060_PINS.tag ||
    value.catalogSha256 !== F007_V060_PINS.catalogSha256 ||
    value.distSha256 !== F007_V060_PINS.distSha256 ||
    !OID.test(String(value.publicTreeOid)) ||
    !isRecord(value.counts) ||
    !exactKeys(value.counts, ['audioAssets', 'authors', 'batches', 'dialogues', 'works']) ||
    value.counts.authors !== 5 || value.counts.works !== 18 || value.counts.dialogues !== 939 ||
    value.counts.audioAssets !== 923 || value.counts.batches !== 6 ||
    !isRecord(value.trackedPublic) || !exactKeys(value.trackedPublic, ['bytes', 'files']) ||
    value.trackedPublic.files !== 965 || value.trackedPublic.bytes !== 304615300 ||
    !isRecord(value.production) ||
    !exactKeys(value.production, ['artifactDigest', 'artifactId', 'runId']) ||
    value.production.artifactDigest !== F007_V060_PINS.artifactDigest ||
    value.production.artifactId !== '9471657617' || value.production.runId !== '32556527623' ||
    !isRecord(value.control) ||
    !exactKeys(value.control, [
      'approvalEvidencePath', 'approvalEvidenceSha256', 'commit', 'deploymentEvidencePath',
      'deploymentEvidenceSha256', 'manifestPath', 'manifestSha256', 'releaseEvidencePath',
      'releaseEvidenceSha256',
    ]) ||
    value.control.manifestPath !== 'content/batches/F006/batch.json' ||
    value.control.releaseEvidencePath !== 'docs/evidence/release/RELEASE-F006.md' ||
    value.control.approvalEvidencePath !== 'docs/evidence/release/F006-approval.json' ||
    value.control.deploymentEvidencePath !== 'docs/evidence/release/F006-deployment.json' ||
    !SHA256.test(String(value.control.manifestSha256)) ||
    !SHA256.test(String(value.control.releaseEvidenceSha256)) ||
    !SHA256.test(String(value.control.approvalEvidenceSha256)) ||
    !SHA256.test(String(value.control.deploymentEvidenceSha256)) ||
    !OID.test(String(value.control.commit)) || value.control.commit === value.releaseCommit) {
    throw new PublishedV060BaselineError('v0.6.0 baseline descriptorが不正です');
  }
}

function assertCatalog(catalog: unknown): asserts catalog is CatalogV2 {
  if (!isRecord(catalog) || catalog.schemaVersion !== '2.0.0' ||
    !Array.isArray(catalog.authors) || catalog.authors.length !== 5 ||
    !Array.isArray(catalog.works) || catalog.works.length !== 18 ||
    !Array.isArray(catalog.audioAssets) || catalog.audioAssets.length !== 923 ||
    !Array.isArray(catalog.batches) || catalog.batches.length !== 6 ||
    catalog.authors.some((author) => isRecord(author) && author.authorId === '000129') ||
    catalog.works.reduce((count, work) =>
      count + (isRecord(work) && Array.isArray(work.dialogues) ? work.dialogues.length : Number.NaN), 0) !== 939) {
    throw new PublishedV060BaselineError('v0.6.0 Catalog projectionが不正です');
  }
}

function assertControlEvidence(
  descriptor: PublishedV060Descriptor,
  releaseEvidence: string,
  approvalEvidence: string,
  deploymentEvidence: string,
): void {
  const combined = `${releaseEvidence}\n${approvalEvidence}\n${deploymentEvidence}`;
  const required = [
    descriptor.releaseCommit,
    descriptor.tag,
    descriptor.catalogSha256,
    descriptor.distSha256,
    descriptor.production.artifactDigest,
    descriptor.production.artifactId,
    descriptor.production.runId,
  ];
  if (required.some((item) => !combined.includes(item))) {
    throw new PublishedV060BaselineError('v0.6.0 release/control証跡tupleが一致しません');
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * F006公開時点(v0.6.0)のrelease payloadとpostrelease controlを、候補checkoutの現行publicから
 * 再導出せず、固定Git objectと固定hashのbaseline descriptorから復元する。
 * @des DES-F007-002 @fun FUN-F007-002
 */
export async function loadPublishedV060Baseline(
  workspace: string,
  pins: PublishedV060Pins = F007_V060_PINS,
  options: PublishedV060LoadOptions = {},
): Promise<PublishedV060Baseline> {
  assertPins(pins);
  const root = await verifiedWorkspace(workspace);
  const descriptorPath = join(root, ...DESCRIPTOR_PATH.split('/'));
  let descriptorRaw: string;
  try {
    const info = await lstat(descriptorPath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(descriptorPath) !== descriptorPath) throw new Error('unsafe');
    descriptorRaw = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    throw new PublishedV060BaselineError('baseline descriptorを安全に読めません', { cause: error });
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorRaw) as unknown;
  } catch (error) {
    throw new PublishedV060BaselineError('baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptorValue, descriptorRaw);
  const descriptor = descriptorValue;
  const git = options.git ?? nodePublishedV060GitAdapter;

  const [releaseCommit, tagCommit, controlCommit] = await Promise.all([
    git.resolveCommit(root, descriptor.releaseCommit),
    git.resolveCommit(root, descriptor.tag),
    git.resolveCommit(root, descriptor.control.commit),
  ]);
  if (releaseCommit !== descriptor.releaseCommit || tagCommit !== descriptor.releaseCommit ||
    controlCommit !== descriptor.control.commit || releaseCommit === controlCommit) {
    throw new PublishedV060BaselineError('release/tag/control commit identityが一致しません');
  }

  const publicTreeOid = await git.resolvePublicTreeOid(root, releaseCommit);
  if (publicTreeOid !== descriptor.publicTreeOid) {
    throw new PublishedV060BaselineError('release public Git tree oidが一致しません');
  }

  const publicFiles = await git.listPublicTree(root, releaseCommit);
  const publicBytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (publicFiles.length !== descriptor.trackedPublic.files || publicBytes !== descriptor.trackedPublic.bytes ||
    publicFiles.some((file) => !OID.test(file.oid) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
    throw new PublishedV060BaselineError('release public Git tree tupleが一致しません');
  }
  const catalogFile = publicFiles.find((file) => file.path === 'content/catalog.json');
  if (!catalogFile) {
    throw new PublishedV060BaselineError('release public treeにcontent/catalog.jsonがありません');
  }
  const catalogBytes = await git.readObject(root, releaseCommit, 'public/content/catalog.json');
  if (catalogBytes.byteLength !== catalogFile.bytes || sha256(catalogBytes) !== descriptor.catalogSha256) {
    throw new PublishedV060BaselineError('release content/catalog.json SHAが一致しません');
  }

  const [manifestBytes, releaseEvidenceBytes, approvalEvidenceBytes, deploymentEvidenceBytes] = await Promise.all([
    git.readObject(root, controlCommit, descriptor.control.manifestPath),
    git.readObject(root, controlCommit, descriptor.control.releaseEvidencePath),
    git.readObject(root, controlCommit, descriptor.control.approvalEvidencePath),
    git.readObject(root, controlCommit, descriptor.control.deploymentEvidencePath),
  ]);
  if (sha256(manifestBytes) !== descriptor.control.manifestSha256 ||
    sha256(releaseEvidenceBytes) !== descriptor.control.releaseEvidenceSha256 ||
    sha256(approvalEvidenceBytes) !== descriptor.control.approvalEvidenceSha256 ||
    sha256(deploymentEvidenceBytes) !== descriptor.control.deploymentEvidenceSha256) {
    throw new PublishedV060BaselineError('control evidence SHAが一致しません');
  }

  let catalog: unknown;
  let controlManifest: unknown;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
    controlManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch (error) {
    throw new PublishedV060BaselineError('release/control JSONが不正です', { cause: error });
  }
  assertCatalog(catalog);
  if (!isRecord(controlManifest) || controlManifest.batchId !== 'F006' || controlManifest.feature !== 'F006') {
    throw new PublishedV060BaselineError('F006 control manifestが不正です');
  }
  assertControlEvidence(
    descriptor,
    new TextDecoder().decode(releaseEvidenceBytes),
    new TextDecoder().decode(approvalEvidenceBytes),
    new TextDecoder().decode(deploymentEvidenceBytes),
  );

  const baseline = deepFreeze({
    __brand: 'PublishedV060Baseline' as const,
    pins: { ...F007_V060_PINS },
    catalog,
    publicFiles: publicFiles.map((file) => ({ ...file })),
    descriptorSha256: DESCRIPTOR_SHA256,
    controlManifest,
  });
  publishedBaselines.add(baseline);
  return baseline;
}

/**
 * work preview・統合tree・distの各段階で同一固定bundleを再検証するためのbrand検査。
 * @des DES-F007-002 @fun FUN-F007-003
 */
export function isMintedPublishedV060Baseline(value: unknown): value is PublishedV060Baseline {
  return isRecord(value) && publishedBaselines.has(value) && value.__brand === 'PublishedV060Baseline';
}
