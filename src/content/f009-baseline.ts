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
const DESCRIPTOR_PATH = 'content/baselines/F009-v0.8.0.json';
const DESCRIPTOR_SHA256 = 'd36d6d78387fa73e488260e2a6d8a560d50f0a083a8ce94e253bb3327ae39964';

/**
 * v0.8.0固定pins。値はF008公開証跡(RELEASE-F008.md／F008-approval.json／F008-deployment.json)から
 * 実測して転記した固定値であり、候補checkoutの現行publicから再導出しない。
 * @des DES-F009-002 @fun FUN-F009-002
 */
export const F009_V080_PINS = Object.freeze({
  releaseCommit: 'bddf37c7d25ff57fb6ecde9d6bc8a1f06139f197',
  tag: 'v0.8.0',
  catalogSha256: 'b46bfd5dd78d0ac6b343a2ee202acec901dc1394e8752df3129de2f3dc66e5cc',
  distSha256: '842042cfc8683fa7aa1d7e4aa3e38034b6d90360b093b7d4a536f75afbafc330',
  artifactDigest: 'c7ec3229764bcb3e1c9ea221b96efcababb7ead44b62666771b27b37c0877c04',
} as const);

export type PublishedV080Pins = Readonly<typeof F009_V080_PINS>;

interface PublishedV080Descriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.8.0';
  readonly releaseCommit: string;
  readonly tag: 'v0.8.0';
  readonly catalogSha256: string;
  readonly publicTreeOid: string;
  readonly distSha256: string;
  readonly counts: {
    readonly authors: 7;
    readonly works: 24;
    readonly dialogues: 1199;
    readonly audioAssets: 1182;
    readonly batches: 8;
  };
  readonly trackedPublic: { readonly files: 1234; readonly bytes: 506613803 };
  readonly production: {
    readonly runId: '32647228172';
    readonly artifactId: '9495528656';
    readonly artifactDigest: string;
  };
  readonly control: {
    readonly commit: string;
    readonly manifestPath: 'content/batches/F008/batch.json';
    readonly manifestSha256: string;
    readonly releaseEvidencePath: 'docs/evidence/release/RELEASE-F008.md';
    readonly releaseEvidenceSha256: string;
    readonly approvalEvidencePath: 'docs/evidence/release/F008-approval.json';
    readonly approvalEvidenceSha256: string;
    readonly deploymentEvidencePath: 'docs/evidence/release/F008-deployment.json';
    readonly deploymentEvidenceSha256: string;
  };
}

export interface PublishedV080GitFile {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly bytes: number;
  readonly path: string;
}

export interface PublishedV080Baseline {
  readonly __brand: 'PublishedV080Baseline';
  readonly pins: PublishedV080Pins;
  readonly catalog: CatalogV2;
  readonly publicFiles: readonly PublishedV080GitFile[];
  readonly descriptorSha256: string;
  readonly controlManifest: Readonly<Record<string, unknown>>;
}

const publishedBaselines = new WeakSet<object>();

export interface PublishedV080GitAdapter {
  resolveCommit(workspace: string, ref: string): Promise<string>;
  resolvePublicTreeOid(workspace: string, commit: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly PublishedV080GitFile[]>;
  readObject(workspace: string, commit: string, path: string): Promise<Uint8Array>;
}

export interface PublishedV080LoadOptions {
  readonly git?: PublishedV080GitAdapter;
}

export class PublishedV080BaselineError extends Error {
  readonly code = 'F009_PUBLISHED_BASELINE_MISMATCH';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishedV080BaselineError';
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
  if (!isAbsolute(workspace)) throw new PublishedV080BaselineError('workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch (error) {
    throw new PublishedV080BaselineError('workspace実体が安全なdirectoryではありません', { cause: error });
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
    throw new PublishedV080BaselineError('固定Git objectを読めません', { cause: error });
  }
}

export const nodePublishedV080GitAdapter: PublishedV080GitAdapter = Object.freeze({
  async resolveCommit(workspace: string, ref: string) {
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const raw = new TextDecoder().decode(await gitBuffer(workspace, ['ls-tree', '-r', '-l', '-z', commit, '--', 'public']));
    return raw.split('\0').filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\tpublic\/(.+)$/u.exec(entry);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new PublishedV080BaselineError('固定public tree entryが不正です');
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
      throw new PublishedV080BaselineError('固定Git object refが不正です');
    }
    return gitBuffer(workspace, ['show', `${commit}:${path}`]);
  },
  async resolvePublicTreeOid(workspace: string, commit: string) {
    if (!OID.test(commit)) throw new PublishedV080BaselineError('固定Git object refが不正です');
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${commit}:public`])).trim();
  },
});

function assertPins(pins: PublishedV080Pins): void {
  if (!isRecord(pins) ||
    !exactKeys(pins, ['releaseCommit', 'tag', 'catalogSha256', 'distSha256', 'artifactDigest']) ||
    Object.entries(F009_V080_PINS).some(([key, value]) => pins[key as keyof PublishedV080Pins] !== value)) {
    throw new PublishedV080BaselineError('v0.8.0固定pinsがexact値と一致しません');
  }
}

function assertDescriptor(value: unknown, raw: string): asserts value is PublishedV080Descriptor {
  if (!isRecord(value) || raw !== canonicalJson(value) || sha256(raw) !== DESCRIPTOR_SHA256 ||
    !exactKeys(value, [
      'catalogSha256', 'publicTreeOid', 'control', 'counts', 'distSha256',
      'production', 'release', 'releaseCommit', 'schemaVersion', 'tag', 'trackedPublic',
    ]) ||
    value.schemaVersion !== '1.0.0' || value.release !== 'v0.8.0' ||
    value.releaseCommit !== F009_V080_PINS.releaseCommit || value.tag !== F009_V080_PINS.tag ||
    value.catalogSha256 !== F009_V080_PINS.catalogSha256 ||
    value.distSha256 !== F009_V080_PINS.distSha256 ||
    !OID.test(String(value.publicTreeOid)) ||
    !isRecord(value.counts) ||
    !exactKeys(value.counts, ['audioAssets', 'authors', 'batches', 'dialogues', 'works']) ||
    value.counts.authors !== 7 || value.counts.works !== 24 || value.counts.dialogues !== 1199 ||
    value.counts.audioAssets !== 1182 || value.counts.batches !== 8 ||
    !isRecord(value.trackedPublic) || !exactKeys(value.trackedPublic, ['bytes', 'files']) ||
    value.trackedPublic.files !== 1234 || value.trackedPublic.bytes !== 506613803 ||
    !isRecord(value.production) ||
    !exactKeys(value.production, ['artifactDigest', 'artifactId', 'runId']) ||
    value.production.artifactDigest !== F009_V080_PINS.artifactDigest ||
    value.production.artifactId !== '9495528656' || value.production.runId !== '32647228172' ||
    !isRecord(value.control) ||
    !exactKeys(value.control, [
      'approvalEvidencePath', 'approvalEvidenceSha256', 'commit', 'deploymentEvidencePath',
      'deploymentEvidenceSha256', 'manifestPath', 'manifestSha256', 'releaseEvidencePath',
      'releaseEvidenceSha256',
    ]) ||
    value.control.manifestPath !== 'content/batches/F008/batch.json' ||
    value.control.releaseEvidencePath !== 'docs/evidence/release/RELEASE-F008.md' ||
    value.control.approvalEvidencePath !== 'docs/evidence/release/F008-approval.json' ||
    value.control.deploymentEvidencePath !== 'docs/evidence/release/F008-deployment.json' ||
    !SHA256.test(String(value.control.manifestSha256)) ||
    !SHA256.test(String(value.control.releaseEvidenceSha256)) ||
    !SHA256.test(String(value.control.approvalEvidenceSha256)) ||
    !SHA256.test(String(value.control.deploymentEvidenceSha256)) ||
    !OID.test(String(value.control.commit)) || value.control.commit === value.releaseCommit) {
    throw new PublishedV080BaselineError('v0.8.0 baseline descriptorが不正です');
  }
}

function assertCatalog(catalog: unknown): asserts catalog is CatalogV2 {
  if (!isRecord(catalog) || catalog.schemaVersion !== '2.0.0' ||
    !Array.isArray(catalog.authors) || catalog.authors.length !== 7 ||
    !Array.isArray(catalog.works) || catalog.works.length !== 24 ||
    !Array.isArray(catalog.audioAssets) || catalog.audioAssets.length !== 1182 ||
    !Array.isArray(catalog.batches) || catalog.batches.length !== 8 ||
    catalog.authors.some((author) => isRecord(author) && author.authorId === '000096') ||
    catalog.works.reduce((count, work) =>
      count + (isRecord(work) && Array.isArray(work.dialogues) ? work.dialogues.length : Number.NaN), 0) !== 1199) {
    throw new PublishedV080BaselineError('v0.8.0 Catalog projectionが不正です');
  }
}

function assertControlEvidence(
  descriptor: PublishedV080Descriptor,
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
    throw new PublishedV080BaselineError('v0.8.0 release/control証跡tupleが一致しません');
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
 * F008公開時点(v0.8.0)のrelease payloadとpostrelease controlを、候補checkoutの現行publicから
 * 再導出せず、固定Git objectと固定hashのbaseline descriptorから復元する。
 * @des DES-F009-002 @fun FUN-F009-002
 */
export async function loadPublishedV080Baseline(
  workspace: string,
  pins: PublishedV080Pins = F009_V080_PINS,
  options: PublishedV080LoadOptions = {},
): Promise<PublishedV080Baseline> {
  assertPins(pins);
  const root = await verifiedWorkspace(workspace);
  const descriptorPath = join(root, ...DESCRIPTOR_PATH.split('/'));
  let descriptorRaw: string;
  try {
    const info = await lstat(descriptorPath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(descriptorPath) !== descriptorPath) throw new Error('unsafe');
    descriptorRaw = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    throw new PublishedV080BaselineError('baseline descriptorを安全に読めません', { cause: error });
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorRaw) as unknown;
  } catch (error) {
    throw new PublishedV080BaselineError('baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptorValue, descriptorRaw);
  const descriptor = descriptorValue;
  const git = options.git ?? nodePublishedV080GitAdapter;

  const [releaseCommit, tagCommit, controlCommit] = await Promise.all([
    git.resolveCommit(root, descriptor.releaseCommit),
    git.resolveCommit(root, descriptor.tag),
    git.resolveCommit(root, descriptor.control.commit),
  ]);
  if (releaseCommit !== descriptor.releaseCommit || tagCommit !== descriptor.releaseCommit ||
    controlCommit !== descriptor.control.commit || releaseCommit === controlCommit) {
    throw new PublishedV080BaselineError('release/tag/control commit identityが一致しません');
  }

  const publicTreeOid = await git.resolvePublicTreeOid(root, releaseCommit);
  if (publicTreeOid !== descriptor.publicTreeOid) {
    throw new PublishedV080BaselineError('release public Git tree oidが一致しません');
  }

  const publicFiles = await git.listPublicTree(root, releaseCommit);
  const publicBytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (publicFiles.length !== descriptor.trackedPublic.files || publicBytes !== descriptor.trackedPublic.bytes ||
    publicFiles.some((file) => !OID.test(file.oid) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
    throw new PublishedV080BaselineError('release public Git tree tupleが一致しません');
  }
  const catalogFile = publicFiles.find((file) => file.path === 'content/catalog.json');
  if (!catalogFile) {
    throw new PublishedV080BaselineError('release public treeにcontent/catalog.jsonがありません');
  }
  const catalogBytes = await git.readObject(root, releaseCommit, 'public/content/catalog.json');
  if (catalogBytes.byteLength !== catalogFile.bytes || sha256(catalogBytes) !== descriptor.catalogSha256) {
    throw new PublishedV080BaselineError('release content/catalog.json SHAが一致しません');
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
    throw new PublishedV080BaselineError('control evidence SHAが一致しません');
  }

  let catalog: unknown;
  let controlManifest: unknown;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
    controlManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch (error) {
    throw new PublishedV080BaselineError('release/control JSONが不正です', { cause: error });
  }
  assertCatalog(catalog);
  if (!isRecord(controlManifest) || controlManifest.batchId !== 'F008' || controlManifest.feature !== 'F008') {
    throw new PublishedV080BaselineError('F008 control manifestが不正です');
  }
  assertControlEvidence(
    descriptor,
    new TextDecoder().decode(releaseEvidenceBytes),
    new TextDecoder().decode(approvalEvidenceBytes),
    new TextDecoder().decode(deploymentEvidenceBytes),
  );

  const baseline = deepFreeze({
    __brand: 'PublishedV080Baseline' as const,
    pins: { ...F009_V080_PINS },
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
 * @des DES-F009-002 @fun FUN-F009-003
 */
export function isMintedPublishedV080Baseline(value: unknown): value is PublishedV080Baseline {
  return isRecord(value) && publishedBaselines.has(value) && value.__brand === 'PublishedV080Baseline';
}
