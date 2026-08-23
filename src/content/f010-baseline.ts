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
const DESCRIPTOR_PATH = 'content/baselines/F010-v0.9.0.json';
const DESCRIPTOR_SHA256 = '8cb8fe566380e82e833f39b04bff54151b155e0c88edb1a21d5f77f868c8e746';

/**
 * v0.9.0固定pins。値はF009公開証跡(RELEASE-F009.md／F009-approval.json／F009-deployment.json)から
 * 実測して転記した固定値であり、候補checkoutの現行publicから再導出しない。
 * @des DES-F010-002 @fun FUN-F010-002
 */
export const F010_V090_PINS = Object.freeze({
  releaseCommit: '5327f12767d02a0da44856018ada5b6c63db6adc',
  tag: 'v0.9.0',
  catalogSha256: 'da8f51748206d057c28636bfe78cb04b7e723e2b43965cd0ecf2cbc690f14bca',
  distSha256: '6f5a826bf7b95b9908c26f8a58739b0f3817ab6419013c9e452b5dfe3128ea93',
  artifactDigest: '66cb15e4579007bb44488fb8cbbc7e51f1ad93cb3503254f5ada54cee41ee4ee',
} as const);

export type PublishedV090Pins = Readonly<typeof F010_V090_PINS>;

interface PublishedV090Descriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.9.0';
  readonly releaseCommit: string;
  readonly tag: 'v0.9.0';
  readonly catalogSha256: string;
  readonly publicTreeOid: string;
  readonly distSha256: string;
  readonly counts: {
    readonly authors: 8;
    readonly works: 27;
    readonly dialogues: 1226;
    readonly audioAssets: 1209;
    readonly batches: 9;
  };
  readonly trackedPublic: { readonly files: 1266; readonly bytes: 535134024 };
  readonly production: {
    readonly runId: '32659045364';
    readonly artifactId: '9498451724';
    readonly artifactDigest: string;
  };
  readonly control: {
    readonly commit: string;
    readonly manifestPath: 'content/batches/F009/batch.json';
    readonly manifestSha256: string;
    readonly releaseEvidencePath: 'docs/evidence/release/RELEASE-F009.md';
    readonly releaseEvidenceSha256: string;
    readonly approvalEvidencePath: 'docs/evidence/release/F009-approval.json';
    readonly approvalEvidenceSha256: string;
    readonly deploymentEvidencePath: 'docs/evidence/release/F009-deployment.json';
    readonly deploymentEvidenceSha256: string;
  };
}

export interface PublishedV090GitFile {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly bytes: number;
  readonly path: string;
}

export interface PublishedV090Baseline {
  readonly __brand: 'PublishedV090Baseline';
  readonly pins: PublishedV090Pins;
  readonly catalog: CatalogV2;
  readonly publicFiles: readonly PublishedV090GitFile[];
  readonly descriptorSha256: string;
  readonly controlManifest: Readonly<Record<string, unknown>>;
}

const publishedBaselines = new WeakSet<object>();

export interface PublishedV090GitAdapter {
  resolveCommit(workspace: string, ref: string): Promise<string>;
  resolvePublicTreeOid(workspace: string, commit: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly PublishedV090GitFile[]>;
  readObject(workspace: string, commit: string, path: string): Promise<Uint8Array>;
}

export interface PublishedV090LoadOptions {
  readonly git?: PublishedV090GitAdapter;
}

export class PublishedV090BaselineError extends Error {
  readonly code = 'F010_PUBLISHED_BASELINE_MISMATCH';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishedV090BaselineError';
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
  if (!isAbsolute(workspace)) throw new PublishedV090BaselineError('workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch (error) {
    throw new PublishedV090BaselineError('workspace実体が安全なdirectoryではありません', { cause: error });
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
    throw new PublishedV090BaselineError('固定Git objectを読めません', { cause: error });
  }
}

export const nodePublishedV090GitAdapter: PublishedV090GitAdapter = Object.freeze({
  async resolveCommit(workspace: string, ref: string) {
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const raw = new TextDecoder().decode(await gitBuffer(workspace, ['ls-tree', '-r', '-l', '-z', commit, '--', 'public']));
    return raw.split('\0').filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\tpublic\/(.+)$/u.exec(entry);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new PublishedV090BaselineError('固定public tree entryが不正です');
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
      throw new PublishedV090BaselineError('固定Git object refが不正です');
    }
    return gitBuffer(workspace, ['show', `${commit}:${path}`]);
  },
  async resolvePublicTreeOid(workspace: string, commit: string) {
    if (!OID.test(commit)) throw new PublishedV090BaselineError('固定Git object refが不正です');
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${commit}:public`])).trim();
  },
});

function assertPins(pins: PublishedV090Pins): void {
  if (!isRecord(pins) ||
    !exactKeys(pins, ['releaseCommit', 'tag', 'catalogSha256', 'distSha256', 'artifactDigest']) ||
    Object.entries(F010_V090_PINS).some(([key, value]) => pins[key as keyof PublishedV090Pins] !== value)) {
    throw new PublishedV090BaselineError('v0.9.0固定pinsがexact値と一致しません');
  }
}

function assertDescriptor(value: unknown, raw: string): asserts value is PublishedV090Descriptor {
  if (!isRecord(value) || raw !== canonicalJson(value) || sha256(raw) !== DESCRIPTOR_SHA256 ||
    !exactKeys(value, [
      'catalogSha256', 'publicTreeOid', 'control', 'counts', 'distSha256',
      'production', 'release', 'releaseCommit', 'schemaVersion', 'tag', 'trackedPublic',
    ]) ||
    value.schemaVersion !== '1.0.0' || value.release !== 'v0.9.0' ||
    value.releaseCommit !== F010_V090_PINS.releaseCommit || value.tag !== F010_V090_PINS.tag ||
    value.catalogSha256 !== F010_V090_PINS.catalogSha256 ||
    value.distSha256 !== F010_V090_PINS.distSha256 ||
    !OID.test(String(value.publicTreeOid)) ||
    !isRecord(value.counts) ||
    !exactKeys(value.counts, ['audioAssets', 'authors', 'batches', 'dialogues', 'works']) ||
    value.counts.authors !== 8 || value.counts.works !== 27 || value.counts.dialogues !== 1226 ||
    value.counts.audioAssets !== 1209 || value.counts.batches !== 9 ||
    !isRecord(value.trackedPublic) || !exactKeys(value.trackedPublic, ['bytes', 'files']) ||
    value.trackedPublic.files !== 1266 || value.trackedPublic.bytes !== 535134024 ||
    !isRecord(value.production) ||
    !exactKeys(value.production, ['artifactDigest', 'artifactId', 'runId']) ||
    value.production.artifactDigest !== F010_V090_PINS.artifactDigest ||
    value.production.artifactId !== '9498451724' || value.production.runId !== '32659045364' ||
    !isRecord(value.control) ||
    !exactKeys(value.control, [
      'approvalEvidencePath', 'approvalEvidenceSha256', 'commit', 'deploymentEvidencePath',
      'deploymentEvidenceSha256', 'manifestPath', 'manifestSha256', 'releaseEvidencePath',
      'releaseEvidenceSha256',
    ]) ||
    value.control.manifestPath !== 'content/batches/F009/batch.json' ||
    value.control.releaseEvidencePath !== 'docs/evidence/release/RELEASE-F009.md' ||
    value.control.approvalEvidencePath !== 'docs/evidence/release/F009-approval.json' ||
    value.control.deploymentEvidencePath !== 'docs/evidence/release/F009-deployment.json' ||
    !SHA256.test(String(value.control.manifestSha256)) ||
    !SHA256.test(String(value.control.releaseEvidenceSha256)) ||
    !SHA256.test(String(value.control.approvalEvidenceSha256)) ||
    !SHA256.test(String(value.control.deploymentEvidenceSha256)) ||
    !OID.test(String(value.control.commit)) || value.control.commit === value.releaseCommit) {
    throw new PublishedV090BaselineError('v0.9.0 baseline descriptorが不正です');
  }
}

function assertCatalog(catalog: unknown): asserts catalog is CatalogV2 {
  if (!isRecord(catalog) || catalog.schemaVersion !== '2.0.0' ||
    !Array.isArray(catalog.authors) || catalog.authors.length !== 8 ||
    !Array.isArray(catalog.works) || catalog.works.length !== 27 ||
    !Array.isArray(catalog.audioAssets) || catalog.audioAssets.length !== 1209 ||
    !Array.isArray(catalog.batches) || catalog.batches.length !== 9 ||
    catalog.authors.some((author) => isRecord(author) && author.authorId === '000074') ||
    catalog.works.reduce((count, work) =>
      count + (isRecord(work) && Array.isArray(work.dialogues) ? work.dialogues.length : Number.NaN), 0) !== 1226) {
    throw new PublishedV090BaselineError('v0.9.0 Catalog projectionが不正です');
  }
}

function assertControlEvidence(
  descriptor: PublishedV090Descriptor,
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
    throw new PublishedV090BaselineError('v0.9.0 release/control証跡tupleが一致しません');
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
 * F009公開時点(v0.9.0)のrelease payloadとpostrelease controlを、候補checkoutの現行publicから
 * 再導出せず、固定Git objectと固定hashのbaseline descriptorから復元する。
 * @des DES-F010-002 @fun FUN-F010-002
 */
export async function loadPublishedV090Baseline(
  workspace: string,
  pins: PublishedV090Pins = F010_V090_PINS,
  options: PublishedV090LoadOptions = {},
): Promise<PublishedV090Baseline> {
  assertPins(pins);
  const root = await verifiedWorkspace(workspace);
  const descriptorPath = join(root, ...DESCRIPTOR_PATH.split('/'));
  let descriptorRaw: string;
  try {
    const info = await lstat(descriptorPath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(descriptorPath) !== descriptorPath) throw new Error('unsafe');
    descriptorRaw = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    throw new PublishedV090BaselineError('baseline descriptorを安全に読めません', { cause: error });
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorRaw) as unknown;
  } catch (error) {
    throw new PublishedV090BaselineError('baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptorValue, descriptorRaw);
  const descriptor = descriptorValue;
  const git = options.git ?? nodePublishedV090GitAdapter;

  const [releaseCommit, tagCommit, controlCommit] = await Promise.all([
    git.resolveCommit(root, descriptor.releaseCommit),
    git.resolveCommit(root, descriptor.tag),
    git.resolveCommit(root, descriptor.control.commit),
  ]);
  if (releaseCommit !== descriptor.releaseCommit || tagCommit !== descriptor.releaseCommit ||
    controlCommit !== descriptor.control.commit || releaseCommit === controlCommit) {
    throw new PublishedV090BaselineError('release/tag/control commit identityが一致しません');
  }

  const publicTreeOid = await git.resolvePublicTreeOid(root, releaseCommit);
  if (publicTreeOid !== descriptor.publicTreeOid) {
    throw new PublishedV090BaselineError('release public Git tree oidが一致しません');
  }

  const publicFiles = await git.listPublicTree(root, releaseCommit);
  const publicBytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (publicFiles.length !== descriptor.trackedPublic.files || publicBytes !== descriptor.trackedPublic.bytes ||
    publicFiles.some((file) => !OID.test(file.oid) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
    throw new PublishedV090BaselineError('release public Git tree tupleが一致しません');
  }
  const catalogFile = publicFiles.find((file) => file.path === 'content/catalog.json');
  if (!catalogFile) {
    throw new PublishedV090BaselineError('release public treeにcontent/catalog.jsonがありません');
  }
  const catalogBytes = await git.readObject(root, releaseCommit, 'public/content/catalog.json');
  if (catalogBytes.byteLength !== catalogFile.bytes || sha256(catalogBytes) !== descriptor.catalogSha256) {
    throw new PublishedV090BaselineError('release content/catalog.json SHAが一致しません');
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
    throw new PublishedV090BaselineError('control evidence SHAが一致しません');
  }

  let catalog: unknown;
  let controlManifest: unknown;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
    controlManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch (error) {
    throw new PublishedV090BaselineError('release/control JSONが不正です', { cause: error });
  }
  assertCatalog(catalog);
  if (!isRecord(controlManifest) || controlManifest.batchId !== 'F009' || controlManifest.feature !== 'F009') {
    throw new PublishedV090BaselineError('F009 control manifestが不正です');
  }
  assertControlEvidence(
    descriptor,
    new TextDecoder().decode(releaseEvidenceBytes),
    new TextDecoder().decode(approvalEvidenceBytes),
    new TextDecoder().decode(deploymentEvidenceBytes),
  );

  const baseline = deepFreeze({
    __brand: 'PublishedV090Baseline' as const,
    pins: { ...F010_V090_PINS },
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
 * @des DES-F010-002 @fun FUN-F010-003
 */
export function isMintedPublishedV090Baseline(value: unknown): value is PublishedV090Baseline {
  return isRecord(value) && publishedBaselines.has(value) && value.__brand === 'PublishedV090Baseline';
}
