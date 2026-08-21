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
const DESCRIPTOR_PATH = 'content/baselines/F006-v0.5.0.json';
const DESCRIPTOR_SHA256 = 'bea6efaf22c9b9bf8ec62c71404c43d4fae825f1be34083e3ab58a420af53146';

/**
 * v0.5.0固定pins。値はF005公開証跡（RELEASE-F005.md／F005-approval.json／F005-deployment.json）から
 * 実測して転記した固定値であり、候補checkoutの現行publicから再導出しない。
 */
export const F006_V050_PINS = Object.freeze({
  releaseCommit: '9293852043f2cb76544598d8e23989e49aa2af95',
  tag: 'v0.5.0',
  catalogSha256: '20338c968177ed5fb7494da7234b89007fdbca3bbfbbca8bb9150cb55f21f361',
  distSha256: '668460423c77d116dc694d9428eede4454ae43bc78c790dcdc2709091d0ffbde',
  artifactDigest: 'b00b21b44e2cc150d81ed9df57740610887cd9fc95db7124296b3f4609cc7c2e',
} as const);

export type PublishedV050Pins = Readonly<typeof F006_V050_PINS>;

interface PublishedV050Descriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.5.0';
  readonly releaseCommit: string;
  readonly tag: 'v0.5.0';
  readonly catalogSha256: string;
  readonly publicTreeOid: string;
  readonly distSha256: string;
  readonly counts: {
    readonly authors: 4;
    readonly works: 15;
    readonly dialogues: 877;
    readonly audioAssets: 861;
    readonly batches: 5;
  };
  readonly trackedPublic: { readonly files: 898; readonly bytes: 284091244 };
  readonly production: {
    readonly runId: '32432910266';
    readonly artifactId: '9429844733';
    readonly artifactDigest: string;
  };
  readonly control: {
    readonly commit: string;
    readonly manifestPath: 'content/batches/F005/batch.json';
    readonly manifestSha256: string;
    readonly releaseEvidencePath: 'docs/evidence/release/RELEASE-F005.md';
    readonly releaseEvidenceSha256: string;
    readonly approvalEvidencePath: 'docs/evidence/release/F005-approval.json';
    readonly approvalEvidenceSha256: string;
    readonly deploymentEvidencePath: 'docs/evidence/release/F005-deployment.json';
    readonly deploymentEvidenceSha256: string;
  };
}

export interface PublishedV050GitFile {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly bytes: number;
  readonly path: string;
}

export interface PublishedV050Baseline {
  readonly __brand: 'PublishedV050Baseline';
  readonly pins: PublishedV050Pins;
  readonly catalog: CatalogV2;
  readonly publicFiles: readonly PublishedV050GitFile[];
  readonly descriptorSha256: string;
  readonly controlManifest: Readonly<Record<string, unknown>>;
}

const publishedBaselines = new WeakSet<object>();

export interface PublishedV050GitAdapter {
  resolveCommit(workspace: string, ref: string): Promise<string>;
  resolvePublicTreeOid(workspace: string, commit: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly PublishedV050GitFile[]>;
  readObject(workspace: string, commit: string, path: string): Promise<Uint8Array>;
}

export interface PublishedV050LoadOptions {
  readonly git?: PublishedV050GitAdapter;
}

export class PublishedV050BaselineError extends Error {
  readonly code = 'F006_PUBLISHED_BASELINE_MISMATCH';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishedV050BaselineError';
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
  if (!isAbsolute(workspace)) throw new PublishedV050BaselineError('workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch (error) {
    throw new PublishedV050BaselineError('workspace実体が安全なdirectoryではありません', { cause: error });
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
    throw new PublishedV050BaselineError('固定Git objectを読めません', { cause: error });
  }
}

export const nodePublishedV050GitAdapter: PublishedV050GitAdapter = Object.freeze({
  async resolveCommit(workspace: string, ref: string) {
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const raw = new TextDecoder().decode(await gitBuffer(workspace, ['ls-tree', '-r', '-l', '-z', commit, '--', 'public']));
    return raw.split('\0').filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\tpublic\/(.+)$/u.exec(entry);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new PublishedV050BaselineError('固定public tree entryが不正です');
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
      throw new PublishedV050BaselineError('固定Git object refが不正です');
    }
    return gitBuffer(workspace, ['show', `${commit}:${path}`]);
  },
  async resolvePublicTreeOid(workspace: string, commit: string) {
    if (!OID.test(commit)) throw new PublishedV050BaselineError('固定Git object refが不正です');
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${commit}:public`])).trim();
  },
});

function assertPins(pins: PublishedV050Pins): void {
  if (!isRecord(pins) ||
    !exactKeys(pins, ['releaseCommit', 'tag', 'catalogSha256', 'distSha256', 'artifactDigest']) ||
    Object.entries(F006_V050_PINS).some(([key, value]) => pins[key as keyof PublishedV050Pins] !== value)) {
    throw new PublishedV050BaselineError('v0.5.0固定pinsがexact値と一致しません');
  }
}

function assertDescriptor(value: unknown, raw: string): asserts value is PublishedV050Descriptor {
  if (!isRecord(value) || raw !== canonicalJson(value) || sha256(raw) !== DESCRIPTOR_SHA256 ||
    !exactKeys(value, [
      'catalogSha256', 'publicTreeOid', 'control', 'counts', 'distSha256',
      'production', 'release', 'releaseCommit', 'schemaVersion', 'tag', 'trackedPublic',
    ]) ||
    value.schemaVersion !== '1.0.0' || value.release !== 'v0.5.0' ||
    value.releaseCommit !== F006_V050_PINS.releaseCommit || value.tag !== F006_V050_PINS.tag ||
    value.catalogSha256 !== F006_V050_PINS.catalogSha256 ||
    value.distSha256 !== F006_V050_PINS.distSha256 ||
    !OID.test(String(value.publicTreeOid)) ||
    !isRecord(value.counts) ||
    !exactKeys(value.counts, ['audioAssets', 'authors', 'batches', 'dialogues', 'works']) ||
    value.counts.authors !== 4 || value.counts.works !== 15 || value.counts.dialogues !== 877 ||
    value.counts.audioAssets !== 861 || value.counts.batches !== 5 ||
    !isRecord(value.trackedPublic) || !exactKeys(value.trackedPublic, ['bytes', 'files']) ||
    value.trackedPublic.files !== 898 || value.trackedPublic.bytes !== 284091244 ||
    !isRecord(value.production) ||
    !exactKeys(value.production, ['artifactDigest', 'artifactId', 'runId']) ||
    value.production.artifactDigest !== F006_V050_PINS.artifactDigest ||
    value.production.artifactId !== '9429844733' || value.production.runId !== '32432910266' ||
    !isRecord(value.control) ||
    !exactKeys(value.control, [
      'approvalEvidencePath', 'approvalEvidenceSha256', 'commit', 'deploymentEvidencePath',
      'deploymentEvidenceSha256', 'manifestPath', 'manifestSha256', 'releaseEvidencePath',
      'releaseEvidenceSha256',
    ]) ||
    value.control.manifestPath !== 'content/batches/F005/batch.json' ||
    value.control.releaseEvidencePath !== 'docs/evidence/release/RELEASE-F005.md' ||
    value.control.approvalEvidencePath !== 'docs/evidence/release/F005-approval.json' ||
    value.control.deploymentEvidencePath !== 'docs/evidence/release/F005-deployment.json' ||
    !SHA256.test(String(value.control.manifestSha256)) ||
    !SHA256.test(String(value.control.releaseEvidenceSha256)) ||
    !SHA256.test(String(value.control.approvalEvidenceSha256)) ||
    !SHA256.test(String(value.control.deploymentEvidenceSha256)) ||
    !OID.test(String(value.control.commit)) || value.control.commit === value.releaseCommit) {
    throw new PublishedV050BaselineError('v0.5.0 baseline descriptorが不正です');
  }
}

function assertCatalog(catalog: unknown): asserts catalog is CatalogV2 {
  if (!isRecord(catalog) || catalog.schemaVersion !== '2.0.0' ||
    !Array.isArray(catalog.authors) || catalog.authors.length !== 4 ||
    !Array.isArray(catalog.works) || catalog.works.length !== 15 ||
    !Array.isArray(catalog.audioAssets) || catalog.audioAssets.length !== 861 ||
    !Array.isArray(catalog.batches) || catalog.batches.length !== 5 ||
    catalog.authors.some((author) => isRecord(author) && author.authorId === '000119') ||
    catalog.works.reduce((count, work) =>
      count + (isRecord(work) && Array.isArray(work.dialogues) ? work.dialogues.length : Number.NaN), 0) !== 877) {
    throw new PublishedV050BaselineError('v0.5.0 Catalog projectionが不正です');
  }
}

function assertControlEvidence(
  descriptor: PublishedV050Descriptor,
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
    throw new PublishedV050BaselineError('v0.5.0 release/control証跡tupleが一致しません');
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
 * F005公開時点(v0.5.0)のrelease payloadとpostrelease controlを、候補checkoutの現行publicから
 * 再導出せず、固定Git objectと固定hashのbaseline descriptorから復元する。
 * @des DES-F006-002 @fun FUN-F006-002
 */
export async function loadPublishedV050Baseline(
  workspace: string,
  pins: PublishedV050Pins = F006_V050_PINS,
  options: PublishedV050LoadOptions = {},
): Promise<PublishedV050Baseline> {
  assertPins(pins);
  const root = await verifiedWorkspace(workspace);
  const descriptorPath = join(root, ...DESCRIPTOR_PATH.split('/'));
  let descriptorRaw: string;
  try {
    const info = await lstat(descriptorPath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(descriptorPath) !== descriptorPath) throw new Error('unsafe');
    descriptorRaw = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    throw new PublishedV050BaselineError('baseline descriptorを安全に読めません', { cause: error });
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorRaw) as unknown;
  } catch (error) {
    throw new PublishedV050BaselineError('baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptorValue, descriptorRaw);
  const descriptor = descriptorValue;
  const git = options.git ?? nodePublishedV050GitAdapter;

  const [releaseCommit, tagCommit, controlCommit] = await Promise.all([
    git.resolveCommit(root, descriptor.releaseCommit),
    git.resolveCommit(root, descriptor.tag),
    git.resolveCommit(root, descriptor.control.commit),
  ]);
  if (releaseCommit !== descriptor.releaseCommit || tagCommit !== descriptor.releaseCommit ||
    controlCommit !== descriptor.control.commit || releaseCommit === controlCommit) {
    throw new PublishedV050BaselineError('release/tag/control commit identityが一致しません');
  }

  const publicTreeOid = await git.resolvePublicTreeOid(root, releaseCommit);
  if (publicTreeOid !== descriptor.publicTreeOid) {
    throw new PublishedV050BaselineError('release public Git tree oidが一致しません');
  }

  const publicFiles = await git.listPublicTree(root, releaseCommit);
  const publicBytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (publicFiles.length !== descriptor.trackedPublic.files || publicBytes !== descriptor.trackedPublic.bytes ||
    publicFiles.some((file) => !OID.test(file.oid) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
    throw new PublishedV050BaselineError('release public Git tree tupleが一致しません');
  }
  const catalogFile = publicFiles.find((file) => file.path === 'content/catalog.json');
  if (!catalogFile) {
    throw new PublishedV050BaselineError('release public treeにcontent/catalog.jsonがありません');
  }
  const catalogBytes = await git.readObject(root, releaseCommit, 'public/content/catalog.json');
  if (catalogBytes.byteLength !== catalogFile.bytes || sha256(catalogBytes) !== descriptor.catalogSha256) {
    throw new PublishedV050BaselineError('release content/catalog.json SHAが一致しません');
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
    throw new PublishedV050BaselineError('control evidence SHAが一致しません');
  }

  let catalog: unknown;
  let controlManifest: unknown;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
    controlManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch (error) {
    throw new PublishedV050BaselineError('release/control JSONが不正です', { cause: error });
  }
  assertCatalog(catalog);
  if (!isRecord(controlManifest) || controlManifest.batchId !== 'F005' || controlManifest.feature !== 'F005') {
    throw new PublishedV050BaselineError('F005 control manifestが不正です');
  }
  assertControlEvidence(
    descriptor,
    new TextDecoder().decode(releaseEvidenceBytes),
    new TextDecoder().decode(approvalEvidenceBytes),
    new TextDecoder().decode(deploymentEvidenceBytes),
  );

  const baseline = deepFreeze({
    __brand: 'PublishedV050Baseline' as const,
    pins: { ...F006_V050_PINS },
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
 * @des DES-F006-002 @fun FUN-F006-003
 */
export function isMintedPublishedV050Baseline(value: unknown): value is PublishedV050Baseline {
  return isRecord(value) && publishedBaselines.has(value) && value.__brand === 'PublishedV050Baseline';
}
