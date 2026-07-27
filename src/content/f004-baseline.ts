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
const DESCRIPTOR_PATH = 'content/baselines/F004-v0.3.0.json';
const DESCRIPTOR_SHA256 = '9f8b7b4511e295f83e0d5870fadac9985b78d3ca50ea86e163e546ffdbcbdf81';

export const F004_V030_PINS = Object.freeze({
  releaseCommit: '79d12825b83459b92da58e14a32f853bae6d92d9',
  tag: 'v0.3.0',
  catalogSha256: '591b127e62e4c7686f3a47dc1476426185fe0c825e9092af892cd00e62d97769',
  contentTreeSha256: 'cd92007ecdddaa0a4c2b3ec28fac07650cc42c17fa23a9ab77bc6ce5062410ea',
  distSha256: 'c1656d8e5514ee151310109cbc6601af4515ce47ca8b214bf3a83a9aa5c3c5a6',
  artifactDigest: 'aa103dfb5e323aa1d4f78fd42a7fd6d37b393077e05a0ed89bf2f5bd811a23e5',
  artifactFiles: 495,
  artifactBytes: 164_314_350,
  controlCommit: '5a1a06a0af729e725ce962826268fd4223b88669',
  f003ManifestSha256: 'b26a06c6cbab039a91e24a95150a29d92688256ef9923d1e3b0b7f4612b45a2e',
} as const);

export type PublishedV030Pins = Readonly<typeof F004_V030_PINS>;

interface PublishedV030Descriptor {
  readonly schemaVersion: '1.0.0';
  readonly release: 'v0.3.0';
  readonly releaseCommit: string;
  readonly tag: 'v0.3.0';
  readonly catalogSha256: string;
  readonly contentTreeSha256: string;
  readonly distSha256: string;
  readonly counts: {
    readonly authors: 3;
    readonly works: 9;
    readonly dialogues: 472;
    readonly audioAssets: 463;
    readonly batches: 3;
  };
  readonly trackedPublic: {
    readonly files: 492;
    readonly bytes: 164232398;
  };
  readonly production: {
    readonly runId: '30203760729';
    readonly deploymentId: '5610537281';
    readonly artifactId: '8632449934';
    readonly artifactDigest: string;
    readonly artifactFiles: 495;
    readonly artifactBytes: 164314350;
  };
  readonly control: {
    readonly commit: string;
    readonly manifestPath: 'content/batches/F003/batch.json';
    readonly manifestSha256: string;
    readonly precheckPath: 'docs/evidence/release/RELEASE-F003-precheck.md';
    readonly precheckSha256: string;
    readonly releaseEvidencePath: 'docs/evidence/release/RELEASE-F003.md';
    readonly releaseEvidenceSha256: string;
  };
}

export interface PublishedV030GitFile {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly bytes: number;
  readonly path: string;
}

export interface PublishedV030Baseline {
  readonly __brand: 'PublishedV030Baseline';
  readonly pins: PublishedV030Pins;
  readonly catalog: CatalogV2;
  readonly publicFiles: readonly PublishedV030GitFile[];
  readonly descriptorSha256: string;
  readonly controlManifest: Readonly<Record<string, unknown>>;
}

export interface PublishedV030GitAdapter {
  resolveCommit(workspace: string, ref: string): Promise<string>;
  listPublicTree(workspace: string, commit: string): Promise<readonly PublishedV030GitFile[]>;
  readObject(workspace: string, commit: string, path: string): Promise<Uint8Array>;
}

export interface PublishedV030LoadOptions {
  readonly git?: PublishedV030GitAdapter;
}

export class PublishedV030BaselineError extends Error {
  readonly code = 'F004_BASELINE_MISMATCH';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishedV030BaselineError';
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new PublishedV030BaselineError('workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch (error) {
    throw new PublishedV030BaselineError('workspace実体が安全なdirectoryではありません', { cause: error });
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
    throw new PublishedV030BaselineError('固定Git objectを読めません', { cause: error });
  }
}

export const nodePublishedV030GitAdapter: PublishedV030GitAdapter = Object.freeze({
  async resolveCommit(workspace: string, ref: string) {
    return new TextDecoder().decode(await gitBuffer(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  },
  async listPublicTree(workspace: string, commit: string) {
    const raw = new TextDecoder().decode(await gitBuffer(workspace, ['ls-tree', '-r', '-l', '-z', commit, '--', 'public']));
    return raw.split('\0').filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\tpublic\/(.+)$/u.exec(entry);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new PublishedV030BaselineError('固定public tree entryが不正です');
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
      throw new PublishedV030BaselineError('固定Git object refが不正です');
    }
    return gitBuffer(workspace, ['show', `${commit}:${path}`]);
  },
});

function assertPins(pins: PublishedV030Pins): void {
  if (!isRecord(pins) ||
    !exactKeys(pins, [
      'releaseCommit', 'tag', 'catalogSha256', 'contentTreeSha256', 'distSha256',
      'artifactDigest', 'artifactFiles', 'artifactBytes', 'controlCommit', 'f003ManifestSha256',
    ]) ||
    Object.entries(F004_V030_PINS).some(([key, value]) => pins[key as keyof PublishedV030Pins] !== value)) {
    throw new PublishedV030BaselineError('v0.3.0固定pinsがexact値と一致しません');
  }
}

function assertDescriptor(value: unknown, raw: string): asserts value is PublishedV030Descriptor {
  if (!isRecord(value) || raw !== canonicalJson(value) || sha256(raw) !== DESCRIPTOR_SHA256 ||
    !exactKeys(value, [
      'catalogSha256', 'contentTreeSha256', 'control', 'counts', 'distSha256',
      'production', 'release', 'releaseCommit', 'schemaVersion', 'tag', 'trackedPublic',
    ]) ||
    value.schemaVersion !== '1.0.0' || value.release !== 'v0.3.0' ||
    value.releaseCommit !== F004_V030_PINS.releaseCommit || value.tag !== F004_V030_PINS.tag ||
    value.catalogSha256 !== F004_V030_PINS.catalogSha256 ||
    value.contentTreeSha256 !== F004_V030_PINS.contentTreeSha256 ||
    value.distSha256 !== F004_V030_PINS.distSha256 ||
    !isRecord(value.counts) || !exactKeys(value.counts, ['audioAssets', 'authors', 'batches', 'dialogues', 'works']) ||
    value.counts.authors !== 3 || value.counts.works !== 9 || value.counts.dialogues !== 472 ||
    value.counts.audioAssets !== 463 || value.counts.batches !== 3 ||
    !isRecord(value.trackedPublic) || !exactKeys(value.trackedPublic, ['bytes', 'files']) ||
    value.trackedPublic.files !== 492 || value.trackedPublic.bytes !== 164232398 ||
    !isRecord(value.production) ||
    !exactKeys(value.production, ['artifactBytes', 'artifactDigest', 'artifactFiles', 'artifactId', 'deploymentId', 'runId']) ||
    value.production.artifactDigest !== F004_V030_PINS.artifactDigest ||
    value.production.artifactFiles !== F004_V030_PINS.artifactFiles ||
    value.production.artifactBytes !== F004_V030_PINS.artifactBytes ||
    !isRecord(value.control) ||
    !exactKeys(value.control, [
      'commit', 'manifestPath', 'manifestSha256', 'precheckPath', 'precheckSha256',
      'releaseEvidencePath', 'releaseEvidenceSha256',
    ]) ||
    value.control.commit !== F004_V030_PINS.controlCommit ||
    value.control.manifestSha256 !== F004_V030_PINS.f003ManifestSha256 ||
    !SHA256.test(String(value.control.precheckSha256)) ||
    !SHA256.test(String(value.control.releaseEvidenceSha256))) {
    throw new PublishedV030BaselineError('v0.3.0 baseline descriptorが不正です');
  }
}

function assertCatalog(catalog: unknown): asserts catalog is CatalogV2 {
  if (!isRecord(catalog) || catalog.schemaVersion !== '2.0.0' ||
    !Array.isArray(catalog.authors) || catalog.authors.length !== 3 ||
    !Array.isArray(catalog.works) || catalog.works.length !== 9 ||
    !Array.isArray(catalog.audioAssets) || catalog.audioAssets.length !== 463 ||
    !Array.isArray(catalog.batches) || catalog.batches.length !== 3 ||
    catalog.works.reduce((count, work) =>
      count + (isRecord(work) && Array.isArray(work.dialogues) ? work.dialogues.length : Number.NaN), 0) !== 472) {
    throw new PublishedV030BaselineError('v0.3.0 Catalog projectionが不正です');
  }
}

function assertControlEvidence(descriptor: PublishedV030Descriptor, precheck: string, release: string): void {
  const requiredPrecheck = [
    descriptor.releaseCommit,
    descriptor.contentTreeSha256,
    descriptor.distSha256,
    descriptor.catalogSha256,
    `${descriptor.production.artifactFiles}ファイル`,
    '164,314,350 bytes',
  ];
  const requiredRelease = [
    descriptor.releaseCommit,
    descriptor.production.runId,
    descriptor.production.deploymentId,
    descriptor.production.artifactId,
    descriptor.production.artifactDigest,
    descriptor.distSha256,
    descriptor.catalogSha256,
    descriptor.control.manifestSha256,
  ];
  if (requiredPrecheck.some((item) => !precheck.includes(item)) ||
    requiredRelease.some((item) => !release.includes(item))) {
    throw new PublishedV030BaselineError('v0.3.0 release/control証跡tupleが一致しません');
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
 * 公開payloadのrelease objectとpublished遷移のcontrol objectを分離して固定する。
 * @des DES-F004-002 @fun FUN-F004-002 @ut UT-F004-002
 */
export async function loadPublishedV030Baseline(
  workspace: string,
  pins: PublishedV030Pins,
  options: PublishedV030LoadOptions = {},
): Promise<PublishedV030Baseline> {
  assertPins(pins);
  const root = await verifiedWorkspace(workspace);
  const descriptorPath = join(root, ...DESCRIPTOR_PATH.split('/'));
  let descriptorRaw: string;
  try {
    const info = await lstat(descriptorPath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(descriptorPath) !== descriptorPath) throw new Error('unsafe');
    descriptorRaw = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    throw new PublishedV030BaselineError('baseline descriptorを安全に読めません', { cause: error });
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorRaw) as unknown;
  } catch (error) {
    throw new PublishedV030BaselineError('baseline descriptor JSONが不正です', { cause: error });
  }
  assertDescriptor(descriptorValue, descriptorRaw);
  const descriptor = descriptorValue;
  const git = options.git ?? nodePublishedV030GitAdapter;

  const [releaseCommit, tagCommit, controlCommit] = await Promise.all([
    git.resolveCommit(root, descriptor.releaseCommit),
    git.resolveCommit(root, descriptor.tag),
    git.resolveCommit(root, descriptor.control.commit),
  ]);
  if (releaseCommit !== descriptor.releaseCommit || tagCommit !== descriptor.releaseCommit ||
    controlCommit !== descriptor.control.commit || releaseCommit === controlCommit) {
    throw new PublishedV030BaselineError('release/tag/control commit identityが一致しません');
  }

  const [publicFiles, catalogBytes, manifestBytes, precheckBytes, releaseEvidenceBytes] = await Promise.all([
    git.listPublicTree(root, releaseCommit),
    git.readObject(root, releaseCommit, 'public/content/catalog.json'),
    git.readObject(root, controlCommit, descriptor.control.manifestPath),
    git.readObject(root, controlCommit, descriptor.control.precheckPath),
    git.readObject(root, controlCommit, descriptor.control.releaseEvidencePath),
  ]);
  const publicBytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (publicFiles.length !== descriptor.trackedPublic.files || publicBytes !== descriptor.trackedPublic.bytes ||
    publicFiles.some((file) => !OID.test(file.oid) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
    throw new PublishedV030BaselineError('release public Git tree tupleが一致しません');
  }
  if (sha256(catalogBytes) !== descriptor.catalogSha256 ||
    sha256(manifestBytes) !== descriptor.control.manifestSha256 ||
    sha256(precheckBytes) !== descriptor.control.precheckSha256 ||
    sha256(releaseEvidenceBytes) !== descriptor.control.releaseEvidenceSha256) {
    throw new PublishedV030BaselineError('release/control object SHAが一致しません');
  }

  let catalog: unknown;
  let controlManifest: unknown;
  try {
    catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
    controlManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch (error) {
    throw new PublishedV030BaselineError('release/control JSONが不正です', { cause: error });
  }
  assertCatalog(catalog);
  if (!isRecord(controlManifest) || controlManifest.batchId !== 'F003' ||
    controlManifest.feature !== 'F003' || controlManifest.status !== 'published') {
    throw new PublishedV030BaselineError('F003 published control manifestが不正です');
  }
  assertControlEvidence(
    descriptor,
    new TextDecoder().decode(precheckBytes),
    new TextDecoder().decode(releaseEvidenceBytes),
  );

  return deepFreeze({
    __brand: 'PublishedV030Baseline',
    pins: { ...F004_V030_PINS },
    catalog,
    publicFiles: publicFiles.map((file) => ({ ...file })),
    descriptorSha256: DESCRIPTOR_SHA256,
    controlManifest,
  });
}
