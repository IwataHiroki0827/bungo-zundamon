import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  type BatchManifest,
  type PreparedWorkAcceptanceEvidence,
  type Sha256,
  type WorkId,
} from './batch.ts';
import { canonicalJson } from './artifacts.ts';
import {
  isMintedF005ApprovedBatchContext,
  type F005ApprovedBatchContext,
} from './f005-context.ts';
import {
  flushF005ArtifactDirectory,
  isMintedF005NativeCapacityBackend,
  readF005NativeCapacityJournalFile,
} from './f005-native-guard.ts';
import {
  assertSafeWorkspaceFileCapability,
  closeSafeWorkspaceFile,
  deleteSafeWorkspaceFile,
  renameSafeWorkspaceFile,
  resolveSafeWorkspaceFile,
  snapshotSafeWorkspaceFileCapability,
  type F005NativeFileIdentity,
} from './f005-source.ts';
import type { V040Baseline } from './f005-foundation.ts';

const WORK_IDS = ['000799', '001076', '001104'] as const;
const MANIFEST_PATH = 'content/batches/F005/batch.json';
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*[\\:\0])[\p{L}\p{N}._/-]+$/u;
const PREVIEW_ARTIFACT_KINDS = [
  'content-build',
  'content-staging',
  'dist',
  'f001-content-invariant-report',
  'f001-dist-invariant-report',
] as const;
const EVIDENCE_KINDS = ['source', 'review', 'audio', 'license', 'notice', 'artwork'] as const;
const previews = new WeakSet<object>();
const preparedValues = new WeakSet<object>();
const promotedValues = new WeakSet<object>();
const recorders = new WeakSet<object>();
const execFileAsync = promisify(execFile);
const CURRENT_PROCESS_START_EPOCH_MS =
  Math.floor(Date.now() - process.uptime() * 1000);
/**
 * CHG-F005-074: process開始時刻の問い合わせ待ち時間。
 * 失敗の実体はpowershell.exeの起動待ちであり、負荷が下がれば通る。
 * 段階的に延ばして再試行する。
 */
const PROCESS_START_IDENTITY_TIMEOUTS_MS = Object.freeze([5_000, 15_000, 30_000]);

export type F005AcceptanceErrorCode =
  | 'F005_PREVIEW_INVALID'
  | 'F005_ACCEPTANCE_PREPARE_INVALID'
  | 'F005_ACCEPTANCE_TRANSACTION_INVALID'
  | 'F005_ACCEPTANCE_RECOVERY_CONFLICT';

export class F005AcceptanceError extends Error {
  constructor(
    readonly code: F005AcceptanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F005AcceptanceError';
  }
}

function fail(code: F005AcceptanceErrorCode, message: string, cause?: unknown): never {
  throw new F005AcceptanceError(code, message, cause === undefined ? undefined : { cause });
}

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function exactDataObject(
  value: unknown,
  keys: readonly string[],
  code: F005AcceptanceErrorCode,
  label: string,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label}はplain data objectではありません`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || descriptor.get || descriptor.set) {
      fail(code, `${label}.${key}にaccessorは使用できません`);
    }
  }
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'));
  const expected = [...keys].sort((a, b) => a.localeCompare(b, 'en'));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label}のexact schemaが一致しません`);
  }
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function isInside(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) fail('F005_ACCEPTANCE_PREPARE_INVALID', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe root');
  } catch (error) {
    return fail('F005_ACCEPTANCE_PREPARE_INVALID', 'workspace実体を検証できません', error);
  }
  return root;
}

async function readSafeFile(
  root: string,
  relativePath: string,
  code: F005AcceptanceErrorCode = 'F005_ACCEPTANCE_PREPARE_INVALID',
): Promise<Uint8Array> {
  if (!SAFE_PATH.test(relativePath)) fail(code, 'unsafe relative pathです');
  const target = join(root, ...relativePath.split('/'));
  if (!isInside(root, target)) fail(code, 'pathがworkspace外です');
  try {
    let cursor = root;
    for (const part of relative(root, target).split(sep)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) fail(code, 'pathにlink/reparseがあります');
    }
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      await realpath(target) !== target) {
      fail(code, 'canonical regular fileではありません');
    }
    const handle = await open(target, 'r');
    try {
      const during = await handle.stat();
      if (!during.isFile() || during.nlink !== 1 ||
        during.dev !== before.dev || during.ino !== before.ino ||
        during.size !== before.size || during.mtimeMs !== before.mtimeMs) {
        fail(code, 'artifact identityがread前に変化しました');
      }
      const bytes = new Uint8Array(await handle.readFile());
      const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(target)]);
      if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1 ||
        afterHandle.dev !== during.dev || afterHandle.ino !== during.ino ||
        afterHandle.size !== during.size || afterHandle.mtimeMs !== during.mtimeMs ||
        afterPath.dev !== during.dev || afterPath.ino !== during.ino ||
        afterPath.size !== during.size || afterPath.mtimeMs !== during.mtimeMs) {
        fail(code, 'artifact identityがread中に変化しました');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof F005AcceptanceError) throw error;
    return fail(code, 'canonical artifact実体を検証できません', error);
  }
}

export type F005AcceptancePhase = 'preview' | 'accept';
export type F005AcceptanceMutationKind = 'create' | 'rename' | 'delete';

export interface F005AcceptanceMutationNotice {
  readonly noticeId: Sha256;
  readonly sequence: number;
  readonly phase: F005AcceptancePhase;
  readonly phaseInstanceId: Sha256;
  readonly kind: F005AcceptanceMutationKind;
  readonly path: string;
  readonly targetPath: string | null;
  readonly sha256: Sha256 | null;
  readonly bytes: number;
}

export interface F005AcceptanceMutationObservation {
  readonly noticeId: Sha256;
  readonly sessionNonce: Sha256;
  readonly sequence: number;
  readonly workerPid: number;
  readonly matchedEtw: true;
}

export interface F005AcceptanceCapacityBackend {
  beginPhase(phase: F005AcceptancePhase, workId: WorkId | null, phaseInstanceId: Sha256): Promise<void>;
  observeMutation(notice: F005AcceptanceMutationNotice): Promise<F005AcceptanceMutationObservation>;
  endPhase(phase: F005AcceptancePhase, phaseInstanceId: Sha256): Promise<void>;
}

export interface F005AcceptanceCapacityRecorder {
  readonly __brand: 'F005AcceptanceCapacityRecorder';
  readonly journalId: Sha256;
  readonly owner: string;
  readonly sessionNonce: Sha256;
  readonly workerPid: number;
  beginPhase(phase: F005AcceptancePhase, workId: WorkId | null, phaseInstanceId: Sha256): Promise<void>;
  observeMutation(notice: F005AcceptanceMutationNotice): Promise<void>;
  endPhase(phase: F005AcceptancePhase, phaseInstanceId: Sha256): Promise<void>;
}

/**
 * 認証済みnative backendをclone不能なphase recorderへ包む。
 * backendはnotice対応ETWを返せない場合、必ずrejectしなければならない。
 */
export function createF005AcceptanceCapacityRecorder(
  identity: { readonly journalId: Sha256; readonly owner: string; readonly sessionNonce: Sha256; readonly workerPid: number },
  backend: F005AcceptanceCapacityBackend,
): F005AcceptanceCapacityRecorder {
  if (process.env.NODE_ENV !== 'test' && !isMintedF005NativeCapacityBackend(backend)) {
    fail(
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      'productionではmint済みnative ETW capacity backendが必要です',
    );
  }
  exactDataObject(identity, ['journalId', 'owner', 'sessionNonce', 'workerPid'],
    'F005_ACCEPTANCE_TRANSACTION_INVALID', 'recorder identity');
  exactDataObject(backend, ['beginPhase', 'observeMutation', 'endPhase'],
    'F005_ACCEPTANCE_TRANSACTION_INVALID', 'recorder backend');
  if (!SHA256.test(identity.journalId) || !SHA256.test(identity.sessionNonce) || !identity.owner.trim() ||
    !Number.isSafeInteger(identity.workerPid) || identity.workerPid <= 0 ||
    typeof backend.beginPhase !== 'function' || typeof backend.observeMutation !== 'function' ||
    typeof backend.endPhase !== 'function') {
    fail('F005_ACCEPTANCE_TX_RECORDER_SHAPE' as F005AcceptanceErrorCode, 'recorder identity/backendが不正です');
  }
  const observeMutation = async (notice: F005AcceptanceMutationNotice): Promise<void> => {
    const observation = await backend.observeMutation(notice);
    exactDataObject(observation, ['noticeId', 'sessionNonce', 'sequence', 'workerPid', 'matchedEtw'],
      'F005_ACCEPTANCE_TRANSACTION_INVALID', 'ETW observation');
    if (observation.noticeId !== notice.noticeId || observation.sessionNonce !== identity.sessionNonce ||
      observation.sequence !== notice.sequence || observation.workerPid !== identity.workerPid ||
      observation.matchedEtw !== true) {
      fail('F005_ACCEPTANCE_TX_OBSERVATION_MATCH' as F005AcceptanceErrorCode, 'noticeと認証済みETW観測が一致しません');
    }
  };
  const recorder = freezeDeep({
    __brand: 'F005AcceptanceCapacityRecorder' as const,
    ...identity,
    beginPhase: backend.beginPhase.bind(backend),
    observeMutation,
    endPhase: backend.endPhase.bind(backend),
  });
  recorders.add(recorder);
  return recorder;
}

export interface F005WorkFile {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly sha256: Sha256;
  readonly bytes: number;
  readonly configHash: Sha256;
}

export interface F005AcceptedWork {
  readonly mode: 'accepted';
  readonly workId: WorkId;
  readonly files: readonly F005WorkFile[];
}

export interface F005StagedWork {
  readonly mode: 'staged';
  readonly workId: WorkId;
  readonly files: readonly F005WorkFile[];
}

export type F005PreviewArtifactKind = typeof PREVIEW_ARTIFACT_KINDS[number];
export type F005EvidenceKind = typeof EVIDENCE_KINDS[number];

export interface F005ArtifactRef<Kind extends string> {
  readonly kind: Kind;
  readonly path: string;
  readonly sha256: Sha256;
}

export interface F005PreviewArtifacts {
  readonly workspaceRoot: string;
  readonly previewRoot: string;
  readonly contentBuild: F005ArtifactRef<'content-build'>;
  readonly contentStaging: F005ArtifactRef<'content-staging'>;
  readonly dist: F005ArtifactRef<'dist'>;
  readonly f001ContentInvariantReport: F005ArtifactRef<'f001-content-invariant-report'>;
  readonly f001DistInvariantReport: F005ArtifactRef<'f001-dist-invariant-report'>;
}

export interface F005WorkPreview {
  readonly __brand: 'F005WorkPreview';
  readonly mode: 'work-preview';
  readonly workId: WorkId;
  readonly acceptedWorkIds: readonly WorkId[];
  readonly contextSha256: Sha256;
  readonly baselineDescriptorSha256: Sha256;
  readonly recorderJournalId: Sha256;
  readonly recorderOwner: string;
  readonly phaseInstanceId: Sha256;
  readonly previewRoot: string;
  readonly files: readonly (F005WorkFile & { readonly previewPath: string; readonly ownerWorkId: WorkId })[];
  readonly artifacts: F005PreviewArtifacts;
  readonly previewSha256: Sha256;
}

function contextDigest(context: F005ApprovedBatchContext): Sha256 {
  return sha(canonicalJson({
    candidate: context.candidate,
    definition: context.definition,
    policy: context.policy,
  }));
}

function assertContext(context: F005ApprovedBatchContext, code: F005AcceptanceErrorCode): void {
  if (!isMintedF005ApprovedBatchContext(context) || context.candidate?.batchId !== 'F005' ||
    canonicalJson(context.definition?.workIds) !== canonicalJson(WORK_IDS)) {
    fail(code, 'mint済みF005 contextが必要です');
  }
}

interface F005FormalArtifactEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly kind: F005PreviewArtifactKind | F005EvidenceKind;
  readonly workId: WorkId;
  readonly previewSha256?: Sha256;
  readonly payload: unknown;
}

async function verifyFormalArtifact<Kind extends F005PreviewArtifactKind | F005EvidenceKind>(
  root: string,
  ref: F005ArtifactRef<Kind>,
  expectedKind: Kind,
  workId: WorkId,
  previewSha256: Sha256 | null,
  code: F005AcceptanceErrorCode,
  label: string,
): Promise<F005ArtifactRef<Kind>> {
  exactDataObject(ref, ['kind', 'path', 'sha256'], code, `${label} ref`);
  if (ref.kind !== expectedKind || !SAFE_PATH.test(ref.path) || !ref.path.endsWith('.json') ||
    !SHA256.test(ref.sha256)) {
    fail(code, `${label} refのkind/path/SHAが不正です`);
  }
  const bytes = await readSafeFile(root, ref.path, code);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(code, `${label} JSONが不正です`, error);
  }
  const keys = previewSha256 === null
    ? ['schemaVersion', 'kind', 'workId', 'payload']
    : ['schemaVersion', 'kind', 'workId', 'previewSha256', 'payload'];
  exactDataObject(value, keys, code, label);
  const artifact = value as unknown as F005FormalArtifactEnvelope;
  if (artifact.schemaVersion !== '1.0.0' || artifact.kind !== expectedKind ||
    artifact.workId !== workId || canonicalJson(artifact) !== text ||
    sha(bytes) !== ref.sha256 ||
    (previewSha256 !== null && artifact.previewSha256 !== previewSha256)) {
    fail(code, `${label}のschema/work/preview/SHA bindingが一致しません`);
  }
  return freezeDeep({ kind: expectedKind, path: ref.path, sha256: ref.sha256 });
}

function previewArtifactRefs(
  artifacts: F005PreviewArtifacts,
): readonly [F005PreviewArtifactKind, F005ArtifactRef<F005PreviewArtifactKind>][] {
  return [
    ['content-build', artifacts.contentBuild],
    ['content-staging', artifacts.contentStaging],
    ['dist', artifacts.dist],
    ['f001-content-invariant-report', artifacts.f001ContentInvariantReport],
    ['f001-dist-invariant-report', artifacts.f001DistInvariantReport],
  ];
}

async function verifyWorkFile(
  file: F005WorkFile,
  workId: WorkId,
  mode: 'accepted' | 'staged',
  workspaceRoot: string,
): Promise<Uint8Array> {
  exactDataObject(file, ['sourcePath', 'targetPath', 'sha256', 'bytes', 'configHash'],
    'F005_PREVIEW_INVALID', `${mode} work file`);
  const expectedPrefix = `content/batches/F005/accepted-audio/${workId}/`;
  if (!isAbsolute(file.sourcePath) || !isInside(workspaceRoot, file.sourcePath) || !SAFE_PATH.test(file.targetPath) ||
    !file.targetPath.startsWith(expectedPrefix) || !file.targetPath.endsWith('.wav') ||
    !SHA256.test(file.sha256) || !SHA256.test(file.configHash) ||
    !Number.isSafeInteger(file.bytes) || file.bytes <= 44) {
    fail('F005_PREVIEW_INVALID', `${mode} work file bindingが不正です`);
  }
  const source = resolve(file.sourcePath);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(source) !== source) {
    fail('F005_PREVIEW_INVALID', `${mode} work sourceがregular fileではありません`);
  }
  const bytes = new Uint8Array(await readFile(source));
  if (bytes.byteLength !== file.bytes || sha(bytes) !== file.sha256) {
    fail('F005_PREVIEW_INVALID', `${mode} work sourceのSHA/bytesが一致しません`);
  }
  return bytes;
}

function assertRecorder(recorder: F005AcceptanceCapacityRecorder): void {
  if (!recorders.has(recorder) || recorder.__brand !== 'F005AcceptanceCapacityRecorder') {
    fail('F005_ACCEPTANCE_TX_RECORDER_MINT' as F005AcceptanceErrorCode, 'mint済みcapacity recorderが必要です');
  }
}

function notifier(
  recorder: F005AcceptanceCapacityRecorder,
  phase: F005AcceptancePhase,
  phaseInstanceId: Sha256,
): (kind: F005AcceptanceMutationKind, path: string, target: string | null, bytes: number, digest: Sha256 | null) => Promise<void> {
  let sequence = 0;
  return async (kind, path, targetPath, bytes, digest) => {
    sequence += 1;
    const noticeId = sha(`${phaseInstanceId}\0${sequence}\0${kind}\0${path}\0${targetPath ?? ''}`);
    await recorder.observeMutation(freezeDeep({
      noticeId,
      sequence,
      phase,
      phaseInstanceId,
      kind,
      path,
      targetPath,
      sha256: digest,
      bytes,
    }));
  };
}

/**
 * 先行acceptedと現在のstaged 1件だけから、非破壊previewを作る。
 * @des DES-F005-006 DES-F005-007 @fun FUN-F005-020 @ut UT-F005-020
 */
export async function prepareF005WorkPreview(
  context: F005ApprovedBatchContext,
  baseline: V040Baseline,
  acceptedWorks: readonly F005AcceptedWork[],
  stagedWork: F005StagedWork,
  artifacts: F005PreviewArtifacts,
  capacityRecorder: F005AcceptanceCapacityRecorder,
): Promise<F005WorkPreview> {
  assertContext(context, 'F005_PREVIEW_INVALID');
  assertRecorder(capacityRecorder);
  if (!baseline || baseline.__brand !== 'V040Baseline' || !SHA256.test(baseline.descriptorSha256) ||
    !Object.isFrozen(baseline) || !Array.isArray(acceptedWorks)) {
    fail('F005_PREVIEW_INVALID', 'baseline/accepted worksが不正です');
  }
  exactDataObject(stagedWork, ['mode', 'workId', 'files'], 'F005_PREVIEW_INVALID', 'stagedWork');
  exactDataObject(artifacts, [
    'workspaceRoot', 'previewRoot', 'contentBuild', 'contentStaging', 'dist',
    'f001ContentInvariantReport', 'f001DistInvariantReport',
  ], 'F005_PREVIEW_INVALID', 'preview artifacts');
  if (stagedWork.mode !== 'staged' || !WORK_IDS.includes(stagedWork.workId as typeof WORK_IDS[number]) ||
    !isAbsolute(artifacts.workspaceRoot) || !isAbsolute(artifacts.previewRoot) ||
    !isInside(resolve(artifacts.workspaceRoot), resolve(artifacts.previewRoot)) ||
    !relative(resolve(artifacts.workspaceRoot), resolve(artifacts.previewRoot))
      .replace(/\\/gu, '/').startsWith('.cache/f005-preview/')) {
    fail('F005_PREVIEW_INVALID', 'staged work/artifact bindingが不正です');
  }
  const id = stagedWork.workId as WorkId;
  const workspaceRoot = resolve(artifacts.workspaceRoot);
  const artifactRefs = previewArtifactRefs(artifacts);
  if (new Set(artifactRefs.map(([, ref]) => ref.path)).size !== PREVIEW_ARTIFACT_KINDS.length) {
    fail('F005_PREVIEW_INVALID', 'preview artifact pathが重複しています');
  }
  const verifiedArtifactRefs = await Promise.all(artifactRefs.map(([kind, ref]) =>
    verifyFormalArtifact(
      workspaceRoot,
      ref,
      kind,
      id,
      null,
      'F005_PREVIEW_INVALID',
      `preview artifact ${kind}`,
    )));
  const verifiedArtifacts: F005PreviewArtifacts = freezeDeep({
    workspaceRoot,
    previewRoot: resolve(artifacts.previewRoot),
    contentBuild: verifiedArtifactRefs[0] as F005ArtifactRef<'content-build'>,
    contentStaging: verifiedArtifactRefs[1] as F005ArtifactRef<'content-staging'>,
    dist: verifiedArtifactRefs[2] as F005ArtifactRef<'dist'>,
    f001ContentInvariantReport:
      verifiedArtifactRefs[3] as F005ArtifactRef<'f001-content-invariant-report'>,
    f001DistInvariantReport:
      verifiedArtifactRefs[4] as F005ArtifactRef<'f001-dist-invariant-report'>,
  });
  const stagedIndex = WORK_IDS.indexOf(stagedWork.workId as typeof WORK_IDS[number]);
  if (acceptedWorks.length !== stagedIndex || acceptedWorks.some((work, index) => {
    exactDataObject(work, ['mode', 'workId', 'files'], 'F005_PREVIEW_INVALID', `acceptedWorks[${index}]`);
    return work.mode !== 'accepted' || work.workId !== WORK_IDS[index];
  })) {
    fail('F005_PREVIEW_INVALID', 'accepted 0/1/2＋staged 1のmanifest順ではありません');
  }
  const all: readonly {
    readonly workId: WorkId;
    readonly mode: 'accepted' | 'staged';
    readonly files: readonly F005WorkFile[];
  }[] = [
    ...acceptedWorks.map((work) => ({ workId: work.workId, mode: work.mode, files: work.files })),
    { workId: stagedWork.workId, mode: stagedWork.mode, files: stagedWork.files },
  ];
  if (all.some((work) => !Array.isArray(work.files) || work.files.length === 0) ||
    new Set(all.flatMap((work) => work.files.map((file) => file.targetPath))).size !==
      all.reduce((sum, work) => sum + work.files.length, 0)) {
    fail('F005_PREVIEW_INVALID', 'preview fileが欠損または重複しています');
  }
  const sourceFiles: Array<{ workId: WorkId; file: F005WorkFile; bytes: Uint8Array }> = [];
  for (const work of all) {
    for (const file of work.files) {
      sourceFiles.push({
        workId: work.workId,
        file,
        bytes: await verifyWorkFile(file, work.workId, work.mode, workspaceRoot),
      });
    }
  }
  const previewRoot = verifiedArtifacts.previewRoot;
  const previewSeed = {
    contextSha256: contextDigest(context),
    baselineDescriptorSha256: baseline.descriptorSha256,
    acceptedWorkIds: acceptedWorks.map((work) => work.workId),
    workId: stagedWork.workId,
    files: sourceFiles.map(({ workId, file }) => ({ workId, ...file })),
    artifacts: verifiedArtifacts,
  };
  const phaseInstanceId = sha(canonicalJson(previewSeed));
  const notice = notifier(capacityRecorder, 'preview', phaseInstanceId);
  const created: string[] = [];
  let rootCreated = false;
  await capacityRecorder.beginPhase('preview', stagedWork.workId, phaseInstanceId);
  try {
    await mkdir(previewRoot, { recursive: false });
    rootCreated = true;
    await notice('create', previewRoot, null, 0, null);
    const files = [];
    for (const [index, item] of sourceFiles.entries()) {
      const previewPath = join(previewRoot, `${String(index).padStart(4, '0')}-${basename(item.file.targetPath)}`);
      await writeFile(previewPath, item.bytes, { flag: 'wx' });
      created.push(previewPath);
      await notice('create', previewPath, null, item.bytes.byteLength, item.file.sha256);
      files.push(freezeDeep({ ...item.file, previewPath, ownerWorkId: item.workId }));
    }
    await capacityRecorder.endPhase('preview', phaseInstanceId);
    const payload = {
      mode: 'work-preview' as const,
      workId: stagedWork.workId,
      acceptedWorkIds: acceptedWorks.map((work) => work.workId),
      contextSha256: previewSeed.contextSha256,
      baselineDescriptorSha256: baseline.descriptorSha256 as Sha256,
      recorderJournalId: capacityRecorder.journalId,
      recorderOwner: capacityRecorder.owner,
      phaseInstanceId,
      previewRoot,
      files,
      artifacts: verifiedArtifacts,
    };
    const preview = freezeDeep({
      __brand: 'F005WorkPreview' as const,
      ...payload,
      previewSha256: sha(canonicalJson(payload)),
    });
    previews.add(preview);
    return preview;
  } catch (error) {
    for (const path of created.reverse()) {
      try {
        await rm(path, { force: true });
        await notice('delete', path, null, 0, null);
      } catch {
        // ETW/cleanup失敗時もphaseを閉じない。
      }
    }
    if (rootCreated) {
      try {
        await rmdir(previewRoot);
        await notice('delete', previewRoot, null, 0, null);
      } catch {
        // fail-closed
      }
    }
    if (error instanceof F005AcceptanceError) throw error;
    return fail('F005_PREVIEW_INVALID', 'preview phaseを完了できません', error);
  }
}

export type F005EvidenceRef = F005ArtifactRef<F005EvidenceKind>;

export interface PreparedF005WorkAcceptance {
  readonly __brand: 'PreparedF005WorkAcceptance';
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly contextSha256: Sha256;
  readonly previewSha256: Sha256;
  readonly recorderJournalId: Sha256;
  readonly recorderOwner: string;
  readonly previewArtifacts: F005PreviewArtifacts;
  readonly evidenceRefs: readonly F005EvidenceRef[];
  readonly operations: readonly {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly sha256: Sha256;
    readonly bytes: number;
    readonly configHash: Sha256;
  }[];
  readonly transitionEvidence: Omit<
    PreparedWorkAcceptanceEvidence,
    'acceptedAt' | 'acceptedBy' | 'actualCapacityReportSha'
  >;
  readonly preparedSha256: Sha256;
}

async function readManifest(root: string): Promise<BatchManifest> {
  const bytes = await readSafeFile(root, MANIFEST_PATH);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail('F005_ACCEPTANCE_PREPARE_INVALID', 'manifest JSONが不正です', error);
  }
  const checked = validateBatchManifest(value);
  if (!checked.ok || checked.value.batchId !== 'F005' || canonicalJson(checked.value) !== text) {
    fail('F005_ACCEPTANCE_PREPARE_INVALID', 'canonical F005 manifestではありません');
  }
  return checked.value;
}

function assertWorkOrder(manifest: BatchManifest, workId: WorkId): void {
  const index = manifest.workIds.indexOf(workId);
  const current = manifest.workProgress[index];
  if (canonicalJson(manifest.workIds) !== canonicalJson(WORK_IDS) || index < 0 || current?.status !== 'voiced' ||
    manifest.workProgress.slice(0, index).some((work) => work.status !== 'accepted') ||
    manifest.workProgress.slice(index + 1).some((work) => work.status === 'accepted')) {
    fail('F005_ACCEPTANCE_PREPARE_INVALID', 'manifest順の先行accepted＋現在voiced条件を満たしません');
  }
}

/**
 * canonical evidenceを再読込するだけで、後続accept tupleをmintする。
 * @des DES-F005-006 @fun FUN-F005-021 @ut UT-F005-021
 */
export async function prepareF005WorkAcceptance(
  workspace: string,
  context: F005ApprovedBatchContext,
  workId: WorkId | string,
  evidenceRefs: readonly F005EvidenceRef[],
  preview: F005WorkPreview,
  capacityRecorder: F005AcceptanceCapacityRecorder,
): Promise<PreparedF005WorkAcceptance> {
  const root = await verifiedWorkspace(workspace);
  assertContext(context, 'F005_ACCEPTANCE_PREPARE_INVALID');
  assertRecorder(capacityRecorder);
  if (!WORK_IDS.includes(workId as typeof WORK_IDS[number]) || !previews.has(preview) ||
    preview.mode !== 'work-preview' || preview.workId !== workId ||
    preview.contextSha256 !== contextDigest(context) ||
    preview.recorderJournalId !== capacityRecorder.journalId ||
    preview.recorderOwner !== capacityRecorder.owner ||
    preview.previewSha256 !== sha(canonicalJson({
      mode: preview.mode,
      workId: preview.workId,
      acceptedWorkIds: preview.acceptedWorkIds,
      contextSha256: preview.contextSha256,
      baselineDescriptorSha256: preview.baselineDescriptorSha256,
      recorderJournalId: preview.recorderJournalId,
      recorderOwner: preview.recorderOwner,
      phaseInstanceId: preview.phaseInstanceId,
      previewRoot: preview.previewRoot,
      files: preview.files,
      artifacts: preview.artifacts,
    })) ||
    !Array.isArray(evidenceRefs) || evidenceRefs.length !== EVIDENCE_KINDS.length) {
    fail('F005_ACCEPTANCE_PREPARE_INVALID', 'work/context/preview/recorder bindingが一致しません');
  }
  const id = workId as WorkId;
  const manifest = await readManifest(root);
  assertWorkOrder(manifest, id);
  await Promise.all(previewArtifactRefs(preview.artifacts).map(([kind, ref]) =>
    verifyFormalArtifact(
      root,
      ref,
      kind,
      id,
      null,
      'F005_ACCEPTANCE_PREPARE_INVALID',
      `preview artifact ${kind}`,
    )));
  const verifiedByKind = new Map<F005EvidenceKind, F005EvidenceRef>();
  const refPrefix = `content/batches/F005/work-artifacts/${id}/`;
  const seenPaths = new Set<string>();
  for (const [index, ref] of evidenceRefs.entries()) {
    exactDataObject(ref, ['kind', 'path', 'sha256'],
      'F005_ACCEPTANCE_PREPARE_INVALID', `evidenceRefs[${index}]`);
    if (!SAFE_PATH.test(ref.path) || !ref.path.startsWith(refPrefix) || !ref.path.endsWith('.json') ||
      !EVIDENCE_KINDS.includes(ref.kind) || !SHA256.test(ref.sha256) ||
      seenPaths.has(ref.path) || verifiedByKind.has(ref.kind)) {
      fail('F005_ACCEPTANCE_PREPARE_INVALID', 'evidence refがallowlist外または重複です');
    }
    const verified = await verifyFormalArtifact(
      root,
      ref,
      ref.kind,
      id,
      preview.previewSha256,
      'F005_ACCEPTANCE_PREPARE_INVALID',
      `acceptance evidence ${ref.kind}`,
    ) as F005EvidenceRef;
    seenPaths.add(ref.path);
    verifiedByKind.set(ref.kind, verified);
  }
  if (EVIDENCE_KINDS.some((kind) => !verifiedByKind.has(kind))) {
    fail('F005_ACCEPTANCE_PREPARE_INVALID', '必須acceptance evidence集合が揃っていません');
  }
  const verifiedRefs = EVIDENCE_KINDS.map((kind) => verifiedByKind.get(kind)!);
  const currentFiles = preview.files.filter((file) => file.ownerWorkId === id);
  if (currentFiles.length === 0) fail('F005_ACCEPTANCE_PREPARE_INVALID', 'current workのpreview fileがありません');
  for (const file of currentFiles) {
    if (!isInside(root, file.previewPath) || !isInside(root, preview.previewRoot)) {
      fail('F005_ACCEPTANCE_PREPARE_INVALID', 'previewがworkspace外です');
    }
    const bytes = new Uint8Array(await readFile(file.previewPath));
    if (bytes.byteLength !== file.bytes || sha(bytes) !== file.sha256) {
      fail('F005_ACCEPTANCE_PREPARE_INVALID', 'preview fileがprepare前に変化しました');
    }
  }
  const expectedManifestSha = hashBatchManifest(manifest);
  const acceptedSources = currentFiles.map((file) => freezeDeep({
    path: file.targetPath as PreparedWorkAcceptanceEvidence['acceptedSources'][number]['path'],
    sha256: file.sha256,
    bytes: file.bytes,
    configHash: file.configHash,
  }));
  const preTreeDigest = sha(canonicalJson(preview.files
    .filter((file) => file.ownerWorkId !== id)
    .map((file) => ({ path: file.targetPath, sha256: file.sha256, bytes: file.bytes }))));
  const postTreeDigest = sha(canonicalJson(preview.files
    .map((file) => ({ path: file.targetPath, sha256: file.sha256, bytes: file.bytes }))));
  const operations = currentFiles.map((file) => freezeDeep({
    sourcePath: file.previewPath,
    targetPath: file.targetPath,
    sha256: file.sha256,
    bytes: file.bytes,
    configHash: file.configHash,
  }));
  const transitionEvidence: PreparedF005WorkAcceptance['transitionEvidence'] = freezeDeep({
    kind: 'accepted' as const,
    batchId: 'F005' as PreparedWorkAcceptanceEvidence['batchId'],
    workId: id,
    expectedManifestSha,
    acceptedSources,
    preTreeDigest,
    postTreeDigest,
    contentBuildSha: preview.artifacts.contentBuild.sha256,
    contentStagingSha: preview.artifacts.contentStaging.sha256,
    distSha: preview.artifacts.dist.sha256,
    f001ContentInvariantReportSha: preview.artifacts.f001ContentInvariantReport.sha256,
    f001DistInvariantReportSha: preview.artifacts.f001DistInvariantReport.sha256,
    journalId: capacityRecorder.journalId,
  });
  const payload = {
    workId: id,
    expectedManifestSha,
    contextSha256: preview.contextSha256,
    previewSha256: preview.previewSha256,
    recorderJournalId: capacityRecorder.journalId,
    recorderOwner: capacityRecorder.owner,
    previewArtifacts: preview.artifacts,
    evidenceRefs: verifiedRefs,
    operations,
    transitionEvidence,
  };
  const prepared: PreparedF005WorkAcceptance = freezeDeep({
    __brand: 'PreparedF005WorkAcceptance' as const,
    ...payload,
    preparedSha256: sha(canonicalJson(payload)),
  });
  preparedValues.add(prepared);
  return prepared;
}

type AcceptanceJournalPhase =
  | 'prepared'
  | 'artifacts-committed'
  | 'capacity-measured'
  | 'manifest-committed'
  | 'closed';

interface WorkAcceptanceJournalV3 {
  readonly schemaVersion: 3;
  readonly owner: string;
  readonly workId: WorkId;
  readonly candidateSha256: Sha256;
  readonly recorderJournalId: Sha256;
  readonly phase: AcceptanceJournalPhase;
  readonly previousPhaseJournalSha256: Sha256 | null;
  readonly journalSha256: Sha256;
  readonly expectedManifestSha256: Sha256;
  readonly nextManifestSha256: Sha256 | null;
  readonly manifestPath: string;
  readonly manifestBackupPath: string;
  readonly manifestNextPath: string;
  readonly entries: readonly {
    readonly path: string;
    readonly oldSha256: Sha256 | null;
    readonly newSha256: Sha256;
    readonly stagedPath: string;
    readonly backupPath: string | null;
  }[];
  readonly evidenceRefs: readonly { readonly path: string; readonly sha256: Sha256 }[];
  readonly capacityJournalPath: string;
  readonly capacityJournalSha256: Sha256 | null;
  readonly actualCapacityReportPath: string;
  readonly actualCapacityReportSha256: Sha256 | null;
}

const JOURNAL_KEYS = [
  'schemaVersion', 'owner', 'workId', 'candidateSha256', 'recorderJournalId',
  'phase', 'previousPhaseJournalSha256', 'journalSha256',
  'expectedManifestSha256', 'nextManifestSha256',
  'manifestPath', 'manifestBackupPath', 'manifestNextPath',
  'entries', 'evidenceRefs', 'capacityJournalPath', 'capacityJournalSha256',
  'actualCapacityReportPath', 'actualCapacityReportSha256',
] as const;
const JOURNAL_PHASES = [
  'prepared', 'artifacts-committed', 'capacity-measured', 'manifest-committed', 'closed',
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fileSha(path: string): Promise<Sha256 | null> {
  if (!await exists(path)) return null;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) {
    fail('F005_ACCEPTANCE_TX_TX_PATH' as F005AcceptanceErrorCode, 'transaction pathがregular fileではありません');
  }
  return sha(new Uint8Array(await readFile(path)));
}

async function nativeRenameTargetAbsent(
  root: string,
  sourceRelativePath: string,
  targetRelativePath: string,
  expectedSourceSha256: Sha256,
  code: F005AcceptanceErrorCode,
  expectedNativeIdentity: F005NativeFileIdentity,
): Promise<F005NativeFileIdentity> {
  if (!SAFE_PATH.test(sourceRelativePath) || !SAFE_PATH.test(targetRelativePath) ||
    sourceRelativePath === targetRelativePath || !SHA256.test(expectedSourceSha256)) {
    fail(code, 'native rename tupleが不正です');
  }
  let capability: Awaited<ReturnType<typeof resolveSafeWorkspaceFile>> | undefined;
  let renamedNativeIdentity: F005NativeFileIdentity | undefined;
  try {
    capability = await resolveSafeWorkspaceFile(
      root,
      sourceRelativePath,
      'rename-source',
      expectedNativeIdentity,
    );
    await assertSafeWorkspaceFileCapability(capability);
    const snapshot = snapshotSafeWorkspaceFileCapability(capability);
    if (snapshot.contentSha256 !== expectedSourceSha256 ||
      snapshot.nativeIdentity !== expectedNativeIdentity) {
      fail(code, 'native rename source SHAがexpected CASと一致しません');
    }
    renamedNativeIdentity = snapshot.nativeIdentity;
    await renameSafeWorkspaceFile(
      capability,
      targetRelativePath,
      snapshot.nativeIdentity,
    );
  } catch (error) {
    if (error instanceof F005AcceptanceError) throw error;
    return fail(code, 'native target-absent rename CASに失敗しました', error);
  } finally {
    if (capability !== undefined) {
      await closeSafeWorkspaceFile(capability).catch(() => undefined);
    }
  }
  const sourceDirectory = dirname(join(root, ...sourceRelativePath.split('/')));
  const targetDirectory = dirname(join(root, ...targetRelativePath.split('/')));
  await syncDirectory(root, sourceDirectory, code);
  if (targetDirectory !== sourceDirectory) {
    await syncDirectory(root, targetDirectory, code);
  }
  if (await fileSha(join(root, ...targetRelativePath.split('/'))) !== expectedSourceSha256 ||
    await fileSha(join(root, ...sourceRelativePath.split('/'))) !== null) {
    fail(code, 'native rename post-read tupleが一致しません');
  }
  if (!renamedNativeIdentity) {
    fail(code, 'native rename確定identityがありません');
  }
  await snapshotNativeFileIdentity(
    root,
    targetRelativePath,
    expectedSourceSha256,
    (await readSafeFile(root, targetRelativePath, code)).byteLength,
    code,
    renamedNativeIdentity,
  );
  return renamedNativeIdentity;
}

async function nativeDeleteExact(
  root: string,
  relativePath: string,
  expectedSha256: Sha256,
  code: F005AcceptanceErrorCode,
  expectedNativeIdentity: F005NativeFileIdentity,
): Promise<void> {
  if (!SAFE_PATH.test(relativePath) || !SHA256.test(expectedSha256)) {
    fail(code, 'native delete tupleが不正です');
  }
  let capability: Awaited<ReturnType<typeof resolveSafeWorkspaceFile>> | undefined;
  try {
    capability = await resolveSafeWorkspaceFile(
      root,
      relativePath,
      'delete-source',
      expectedNativeIdentity,
    );
    await assertSafeWorkspaceFileCapability(capability);
    const snapshot = snapshotSafeWorkspaceFileCapability(capability);
    if (snapshot.contentSha256 !== expectedSha256 ||
      snapshot.nativeIdentity !== expectedNativeIdentity) {
      fail(code, 'native delete source SHAがexpected identityと一致しません');
    }
    await deleteSafeWorkspaceFile(capability, snapshot.nativeIdentity);
  } catch (error) {
    if (error instanceof F005AcceptanceError) throw error;
    return fail(code, 'held native exact identity deleteに失敗しました', error);
  } finally {
    if (capability !== undefined) {
      await closeSafeWorkspaceFile(capability).catch(() => undefined);
    }
  }
  const path = join(root, ...relativePath.split('/'));
  await syncDirectory(root, dirname(path), code);
  if (await fileSha(path) !== null) {
    fail(code, 'native delete後のcanonical pathがexpected-absentではありません');
  }
}

async function snapshotNativeFileIdentity(
  root: string,
  relativePath: string,
  expectedSha256: Sha256,
  expectedBytes: number,
  code: F005AcceptanceErrorCode,
  expectedNativeIdentity?: F005NativeFileIdentity,
): Promise<F005NativeFileIdentity> {
  let capability: Awaited<ReturnType<typeof resolveSafeWorkspaceFile>> | undefined;
  try {
    capability = await resolveSafeWorkspaceFile(
      root,
      relativePath,
      'read',
      expectedNativeIdentity,
    );
    await assertSafeWorkspaceFileCapability(capability);
    const snapshot = snapshotSafeWorkspaceFileCapability(capability);
    if (snapshot.relativePosixPath !== relativePath ||
      snapshot.contentSha256 !== expectedSha256 ||
      snapshot.byteLength !== expectedBytes ||
      (expectedNativeIdentity !== undefined &&
        snapshot.nativeIdentity !== expectedNativeIdentity)) {
      fail(code, 'native identity snapshotのpath/SHA/bytesが一致しません');
    }
    return snapshot.nativeIdentity;
  } catch (error) {
    if (error instanceof F005AcceptanceError) throw error;
    return fail(code, 'native identity snapshotに失敗しました', error);
  } finally {
    if (capability !== undefined) {
      await closeSafeWorkspaceFile(capability).catch(() => undefined);
    }
  }
}

async function nativeRenameCurrentTargetAbsent(
  root: string,
  sourceRelativePath: string,
  targetRelativePath: string,
  expectedSourceSha256: Sha256,
  code: F005AcceptanceErrorCode,
): Promise<F005NativeFileIdentity> {
  const bytes = await readSafeFile(root, sourceRelativePath, code);
  if (sha(bytes) !== expectedSourceSha256) {
    fail(code, 'rename pre-snapshot source SHAが一致しません');
  }
  const expectedNativeIdentity = await snapshotNativeFileIdentity(
    root,
    sourceRelativePath,
    expectedSourceSha256,
    bytes.byteLength,
    code,
  );
  return nativeRenameTargetAbsent(
    root,
    sourceRelativePath,
    targetRelativePath,
    expectedSourceSha256,
    code,
    expectedNativeIdentity,
  );
}

async function mutationNativeIdentity(
  root: string,
  relativePath: string,
  expectedSha256: Sha256,
  code: F005AcceptanceErrorCode,
  plannedIdentities?: ReadonlyMap<string, F005NativeFileIdentity>,
): Promise<F005NativeFileIdentity> {
  const direct = plannedIdentities?.get(relativePath);
  if (direct) return direct;
  if (plannedIdentities) {
    const prefix =
      `${dirname(relativePath).replace(/\\/gu, '/')}/.${basename(relativePath)}.`;
    for (const [candidate, identity] of plannedIdentities) {
      if (candidate.startsWith(prefix) && candidate.endsWith('.tmp')) return identity;
    }
  }
  const bytes = await readSafeFile(root, relativePath, code);
  if (sha(bytes) !== expectedSha256) {
    fail(code, 'mutation sourceのcurrent SHAが一致しません');
  }
  return snapshotNativeFileIdentity(
    root,
    relativePath,
    expectedSha256,
    bytes.byteLength,
    code,
  );
}

async function syncDirectory(
  root: string,
  path: string,
  // CHG-F005-072: 汎用既定codeだと停止理由が特定できないため専用codeにする。
  code: F005AcceptanceErrorCode = 'F005_ACCEPTANCE_TX_DIR_SYNC' as F005AcceptanceErrorCode,
): Promise<void> {
  try {
    await flushF005ArtifactDirectory(root, resolve(path));
  } catch (error) {
    return fail(code, 'pinned native directory FlushFileBuffersに失敗しました', error);
  }
}

interface CanonicalDurableTemp {
  readonly relativePath: string;
  readonly path: string;
  readonly sha256: Sha256;
  readonly bytes: Uint8Array;
  readonly text: string;
}

function durableTempName(path: string, contentSha256: Sha256): string {
  return `.${basename(path)}.${contentSha256}.tmp`;
}

async function findCanonicalDurableTemp(
  root: string,
  path: string,
  code: F005AcceptanceErrorCode,
): Promise<CanonicalDurableTemp | null> {
  const parent = dirname(path);
  const prefix = `.${basename(path)}.`;
  const candidates = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (candidates.length > 1) {
    fail(code, `${basename(path)} canonical tempが複数あります`);
  }
  const candidate = candidates[0];
  if (!candidate) return null;
  const matched = new RegExp(
    `^\\.${basename(path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.([0-9a-f]{64})\\.tmp$`,
    'u',
  ).exec(candidate.name);
  if (!matched || !candidate.isFile() || candidate.isSymbolicLink()) {
    fail(code, `${basename(path)} canonical temp名/種別が不正です`);
  }
  const temporary = join(parent, candidate.name);
  const relativePath = workspaceRelative(root, temporary);
  const bytes = await readSafeFile(root, relativePath, code);
  const actualSha256 = sha(bytes);
  if (actualSha256 !== matched[1]) {
    fail(code, `${basename(path)} canonical temp filename SHAが実体と一致しません`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return fail(code, `${basename(path)} canonical tempがUTF-8ではありません`, error);
  }
  return {
    relativePath,
    path: temporary,
    sha256: actualSha256,
    bytes,
    text,
  };
}

async function discardCanonicalDurableTemp(
  root: string,
  temporary: CanonicalDurableTemp,
  targetPath: string | null,
  code: F005AcceptanceErrorCode,
  expectedNativeIdentity: F005NativeFileIdentity,
): Promise<void> {
  const trashDirectory = join(root, '.cache', 'recovery-trash', 'f005');
  const missing: string[] = [];
  let cursor = trashDirectory;
  while (cursor !== root && !await exists(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  if (!isInside(root, cursor)) fail(code, 'recovery trash parentがworkspace外です');
  for (const directory of missing.reverse()) {
    await mkdir(directory, { recursive: false });
    await syncDirectory(root, dirname(directory), code);
    await syncDirectory(root, directory, code);
  }
  const trashInfo = await lstat(trashDirectory);
  if (!trashInfo.isDirectory() || trashInfo.isSymbolicLink() ||
    await realpath(trashDirectory) !== trashDirectory) {
    fail(code, 'recovery trash directoryがcanonicalではありません');
  }
  const discardRelativePath =
    `.cache/recovery-trash/f005/discard-${sha(temporary.relativePath)}` +
    `-${temporary.sha256}-${randomUUID()}.tmp`;
  const renamedNativeIdentity = await nativeRenameTargetAbsent(
    root,
    temporary.relativePath,
    discardRelativePath,
    temporary.sha256,
    code,
    expectedNativeIdentity,
  );
  await nativeDeleteExact(
    root,
    discardRelativePath,
    temporary.sha256,
    code,
    renamedNativeIdentity,
  );
  if (targetPath !== null) {
    await syncDirectory(root, dirname(targetPath), code);
    const targetBytes = await readSafeFile(root, workspaceRelative(root, targetPath), code);
    if (sha(targetBytes) !== temporary.sha256) {
      fail(code, 'identical target durability再確立後のSHAが一致しません');
    }
  }
}

interface F005RecoveryTrashPlanEntry {
  readonly relativePath: string;
  readonly sha256: Sha256;
  readonly nativeIdentity: F005NativeFileIdentity;
}

async function preScanF005RecoveryTrash(
  root: string,
  code: F005AcceptanceErrorCode,
): Promise<readonly F005RecoveryTrashPlanEntry[]> {
  const directory = join(root, '.cache', 'recovery-trash', 'f005');
  if (!await exists(directory)) return [];
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
    await realpath(directory) !== directory) {
    fail(code, 'recovery trash directoryがcanonicalではありません');
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (entries.length > 128) {
    fail(code, 'recovery trashが保持上限128件を超えています');
  }
  const plan: F005RecoveryTrashPlanEntry[] = [];
  for (const entry of entries) {
    const matched = /^discard-[0-9a-f]{64}-([0-9a-f]{64})-[0-9a-f-]{36}\.tmp$/u
      .exec(entry.name);
    if (!matched || !entry.isFile() || entry.isSymbolicLink()) {
      fail(code, `未知recovery trashがあります: ${entry.name}`);
    }
    const relativePath = `.cache/recovery-trash/f005/${entry.name}`;
    const bytes = await readSafeFile(root, relativePath, code);
    if (sha(bytes) !== matched[1]) {
      fail(code, `recovery trash filename SHAが実体と一致しません: ${entry.name}`);
    }
    plan.push({
      relativePath,
      sha256: matched[1] as Sha256,
      nativeIdentity: await snapshotNativeFileIdentity(
        root,
        relativePath,
        matched[1] as Sha256,
        bytes.byteLength,
        code,
      ),
    });
  }
  return plan;
}

async function cleanupF005RecoveryTrash(
  root: string,
  plan: readonly F005RecoveryTrashPlanEntry[],
  code: F005AcceptanceErrorCode,
): Promise<void> {
  for (const entry of plan) {
    await nativeDeleteExact(
      root,
      entry.relativePath,
      entry.sha256,
      code,
      entry.nativeIdentity,
    );
  }
}

async function recoverCanonicalDurableTemp(
  root: string,
  path: string,
  validate: (temporary: CanonicalDurableTemp) => void | Promise<void>,
  code: F005AcceptanceErrorCode,
  expectedNativeIdentities?: ReadonlyMap<string, F005NativeFileIdentity>,
): Promise<'none' | 'promoted' | 'discarded'> {
  const temporary = await findCanonicalDurableTemp(root, path, code);
  if (!temporary) return 'none';
  await validate(temporary);
  let expectedNativeIdentity = expectedNativeIdentities?.get(temporary.relativePath);
  if (expectedNativeIdentities && !expectedNativeIdentity) {
    fail(code, `${basename(path)} tempのpre-scan native identityがありません`);
  }
  expectedNativeIdentity ??= await snapshotNativeFileIdentity(
    root,
    temporary.relativePath,
    temporary.sha256,
    temporary.bytes.byteLength,
    code,
  );
  const targetSha256 = await fileSha(path);
  if (targetSha256 === null) {
    await nativeRenameTargetAbsent(
      root,
      temporary.relativePath,
      workspaceRelative(root, path),
      temporary.sha256,
      code,
      expectedNativeIdentity,
    );
    return 'promoted';
  }
  if (targetSha256 !== temporary.sha256) {
    fail(code, `${basename(path)} targetとcanonical tempが競合しています`);
  }
  const targetBytes = await readSafeFile(root, workspaceRelative(root, path), code);
  const targetText = new TextDecoder('utf-8', { fatal: true }).decode(targetBytes);
  if (targetText !== temporary.text) {
    fail(code, `${basename(path)} targetとcanonical temp bytesが一致しません`);
  }
  await discardCanonicalDurableTemp(
    root,
    temporary,
    path,
    code,
    expectedNativeIdentity,
  );
  return 'discarded';
}

async function writeDurableExclusive(
  root: string,
  path: string,
  text: string,
  afterFileSync?: () => void | Promise<void>,
  code: F005AcceptanceErrorCode = 'F005_ACCEPTANCE_TX_DURABLE_WRITE' as F005AcceptanceErrorCode,
): Promise<void> {
  const expectedSha256 = sha(text);
  const temporary = join(dirname(path), durableTempName(path, expectedSha256));
  await recoverCanonicalDurableTemp(
    root,
    path,
    (candidate) => {
      if (candidate.text !== text || candidate.sha256 !== expectedSha256) {
        fail(code, `${basename(path)} canonical temp bytesがexpected値と一致しません`);
      }
    },
    code,
  );
  const existingSha256 = await fileSha(path);
  if (existingSha256 !== null) {
    if (existingSha256 !== expectedSha256) {
      fail(code, `${basename(path)} durable targetがexpected値と競合しています`);
    }
    await syncDirectory(root, dirname(path), code);
    const existing = await readSafeFile(root, workspaceRelative(root, path), code);
    if (new TextDecoder('utf-8', { fatal: true }).decode(existing) !== text) {
      fail(code, 'durable target canonical bytesが一致しません');
    }
    return;
  }
  let created = false;
  try {
    const handle = await open(temporary, 'wx');
    created = true;
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await afterFileSync?.();
    } finally {
      await handle.close();
    }
    await nativeRenameCurrentTargetAbsent(
      root,
      workspaceRelative(root, temporary),
      workspaceRelative(root, path),
      expectedSha256,
      code,
    );
  } finally {
    if (created && await exists(temporary)) {
      const owned = await findCanonicalDurableTemp(root, path, code);
      if (owned?.path !== temporary || owned.sha256 !== expectedSha256 || owned.text !== text) {
        fail(code, 'cleanup対象canonical temp identityが変化しました');
      }
      const ownedNativeIdentity = await snapshotNativeFileIdentity(
        root,
        owned.relativePath,
        owned.sha256,
        owned.bytes.byteLength,
        code,
      );
      await discardCanonicalDurableTemp(
        root,
        owned,
        null,
        code,
        ownedNativeIdentity,
      );
    }
  }
  const bytes = await readSafeFile(root, workspaceRelative(root, path), code);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== text) {
    fail(code, 'durable write post-read bytesが一致しません');
  }
}

function workspaceRelative(root: string, target: string): string {
  const value = relative(root, resolve(target)).replace(/\\/gu, '/');
  if (!SAFE_PATH.test(value) || !isInside(root, target)) {
    fail('F005_ACCEPTANCE_TX_RELATIVE_PATH' as F005AcceptanceErrorCode, 'workspace相対pathへ正規化できません');
  }
  return value;
}

function canonicalTransactionPaths(root: string, workId: WorkId, journalId: Sha256) {
  const journalDirectory =
    `.cache/transactions/f005-promote/${workId}-${journalId}`;
  return {
    journalDirectory,
    directory: join(root, ...journalDirectory.split('/')),
    manifestPath: MANIFEST_PATH,
    manifestBackupPath: `${journalDirectory}/manifest-old.json`,
    manifestNextPath: `${journalDirectory}/manifest-next.json`,
    transitionEvidencePath: `${journalDirectory}/transition-evidence.json`,
    capacityJournalPath: `.cache/f005-capacity/${journalId}.json`,
    actualCapacityReportPath:
      `content/batches/F005/capacity-actual/${workId}/${journalId}.json`,
    lockPath: `.cache/locks/f005-accept-${workId}.lock`,
  };
}

function journalCore(value: WorkAcceptanceJournalV3): Omit<WorkAcceptanceJournalV3, 'journalSha256'> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'journalSha256'),
  ) as unknown as Omit<WorkAcceptanceJournalV3, 'journalSha256'>;
}

function journalPhaseBase(
  value: WorkAcceptanceJournalV3,
): Omit<WorkAcceptanceJournalV3, 'phase' | 'previousPhaseJournalSha256' | 'journalSha256'> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      !['phase', 'previousPhaseJournalSha256', 'journalSha256'].includes(key)),
  ) as unknown as Omit<
    WorkAcceptanceJournalV3,
    'phase' | 'previousPhaseJournalSha256' | 'journalSha256'
  >;
}

function sealJournalPhase(
  base: Omit<
    WorkAcceptanceJournalV3,
    'phase' | 'previousPhaseJournalSha256' | 'journalSha256'
  >,
  phase: AcceptanceJournalPhase,
  previousPhaseWholeFileSha256: Sha256 | null,
): WorkAcceptanceJournalV3 {
  const core = { ...base, phase, previousPhaseJournalSha256: previousPhaseWholeFileSha256 };
  return freezeDeep({
    ...core,
    journalSha256: sha(canonicalJson(core)),
  }) as WorkAcceptanceJournalV3;
}

function validateWorkAcceptanceJournalV3(
  value: unknown,
  text: string,
  expectedPhase: AcceptanceJournalPhase,
  expectedPreviousWholeFileSha: Sha256 | null,
  root: string,
  directory: string,
): WorkAcceptanceJournalV3 {
  exactDataObject(
    value,
    JOURNAL_KEYS,
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    `${expectedPhase} journal`,
  );
  const journal = value as WorkAcceptanceJournalV3;
  if (canonicalJson(journal) !== text || journal.schemaVersion !== 3 ||
    journal.phase !== expectedPhase ||
    journal.previousPhaseJournalSha256 !== expectedPreviousWholeFileSha ||
    !journal.owner.trim() || !WORK_IDS.includes(journal.workId as typeof WORK_IDS[number]) ||
    !SHA256.test(journal.candidateSha256) || !SHA256.test(journal.recorderJournalId) ||
    !SHA256.test(journal.expectedManifestSha256) ||
    journal.journalSha256 !== sha(canonicalJson(journalCore(journal)))) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${expectedPhase} journal seal/schemaが不正です`);
  }
  const paths = canonicalTransactionPaths(root, journal.workId, journal.recorderJournalId);
  if (resolve(directory) !== paths.directory ||
    journal.manifestPath !== paths.manifestPath ||
    journal.manifestBackupPath !== paths.manifestBackupPath ||
    journal.manifestNextPath !== paths.manifestNextPath ||
    journal.capacityJournalPath !== paths.capacityJournalPath ||
    journal.actualCapacityReportPath !== paths.actualCapacityReportPath) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${expectedPhase} canonical pathが不正です`);
  }
  const hasMeasuredCapacity = JOURNAL_PHASES.indexOf(expectedPhase) >=
    JOURNAL_PHASES.indexOf('capacity-measured');
  if (hasMeasuredCapacity
    ? !SHA256.test(journal.nextManifestSha256 ?? '') ||
      !SHA256.test(journal.capacityJournalSha256 ?? '') ||
      !SHA256.test(journal.actualCapacityReportSha256 ?? '')
    : journal.nextManifestSha256 !== null ||
      journal.capacityJournalSha256 !== null ||
      journal.actualCapacityReportSha256 !== null) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${expectedPhase} nullable fieldが不正です`);
  }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0 ||
    !Array.isArray(journal.evidenceRefs) || journal.evidenceRefs.length === 0) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${expectedPhase} entries/evidenceRefsが不正です`);
  }
  const seenPaths = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    exactDataObject(
      entry,
      ['path', 'oldSha256', 'newSha256', 'stagedPath', 'backupPath'],
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      `${expectedPhase}.entries[${index}]`,
    );
    if (!SAFE_PATH.test(entry.path) || !SAFE_PATH.test(entry.stagedPath) ||
      !SHA256.test(entry.newSha256) || seenPaths.has(entry.path) ||
      (entry.oldSha256 === null
        ? entry.backupPath !== null
        : !SHA256.test(entry.oldSha256) || entry.backupPath === null ||
          !SAFE_PATH.test(entry.backupPath))) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${expectedPhase} entry tupleが不正です`);
    }
    seenPaths.add(entry.path);
  }
  const seenEvidence = new Set<string>();
  for (const [index, ref] of journal.evidenceRefs.entries()) {
    exactDataObject(
      ref,
      ['path', 'sha256'],
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      `${expectedPhase}.evidenceRefs[${index}]`,
    );
    if (!SAFE_PATH.test(ref.path) || !SHA256.test(ref.sha256) || seenEvidence.has(ref.path)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${expectedPhase} evidence refが不正です`);
    }
    seenEvidence.add(ref.path);
  }
  return journal;
}

async function readJournalPhase(
  root: string,
  directory: string,
  phase: AcceptanceJournalPhase,
  previousWholeFileSha: Sha256 | null,
): Promise<{ journal: WorkAcceptanceJournalV3; text: string; wholeFileSha256: Sha256 } | null> {
  const path = join(directory, `${phase}.json`);
  if (!await exists(path)) return null;
  await syncDirectory(root, dirname(path), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
  const relativePath = workspaceRelative(root, path);
  const bytes = await readSafeFile(root, relativePath, 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `${phase} journal JSONが不正です`, error);
  }
  return {
    journal: validateWorkAcceptanceJournalV3(
      value,
      text,
      phase,
      previousWholeFileSha,
      root,
      directory,
    ),
    text,
    wholeFileSha256: sha(bytes),
  };
}

async function ensureDirectoryNoticed(
  root: string,
  directory: string,
  notice: ReturnType<typeof notifier>,
): Promise<void> {
  if (!isInside(root, directory)) fail('F005_ACCEPTANCE_TX_DIRECTORY_SCOPE' as F005AcceptanceErrorCode, 'directoryがworkspace外です');
  const missing: string[] = [];
  let cursor = resolve(directory);
  while (cursor !== root && !await exists(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  if (!isInside(root, cursor)) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'directory parentがworkspace外です');
  if (await exists(cursor)) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'directory parentが実directoryではありません');
    }
  }
  for (const path of missing.reverse()) {
    await mkdir(path, { recursive: false });
    await syncDirectory(root, dirname(path));
    await syncDirectory(root, path);
    await notice('create', path, null, 0, null);
  }
}

export interface F005AcceptOptions {
  readonly now?: () => string;
  readonly afterPhase?: (phase: AcceptanceJournalPhase) => void | Promise<void>;
  readonly actualCapacityReportSha?: Sha256;
}

export interface PromotedF005WorkAcceptance {
  readonly __brand: 'PromotedF005WorkAcceptance';
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly recorderJournalId: Sha256;
  readonly recorderOwner: string;
  readonly preparedSha256: Sha256;
  readonly candidateSha256: Sha256;
  readonly transitionEvidence: PreparedF005WorkAcceptance['transitionEvidence'];
  readonly journalPath: string;
  readonly promotionSha256: Sha256;
}

export interface F005ActualCapacityReportRef {
  readonly kind: 'actual-capacity-report';
  readonly path: string;
  readonly sha256: Sha256;
  readonly candidateSha256: Sha256;
  readonly journalId: Sha256;
  readonly journalSha256: Sha256;
}

/**
 * 音声実体だけをnative監視中に昇格し、live manifestはvoicedのまま保つ。
 * actual容量はaccept phaseを含むjournal close後にしか確定しないため、accepted CASは
 * finalizeF005WorkAcceptanceへ分離する。
 * @des DES-F005-006 @fun FUN-F005-022 @ut UT-F005-022
 */
export async function stageF005WorkAcceptance(
  workspace: string,
  prepared: PreparedF005WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  capacityRecorder: F005AcceptanceCapacityRecorder,
  candidateSha256: Sha256 = prepared.contextSha256,
  options: {
    readonly afterPhase?: (
      phase: 'prepared' | 'artifacts-committed'
    ) => void | Promise<void>;
    readonly afterTransactionDirectory?: () => void | Promise<void>;
    readonly beforeArtifactRename?: (index: number) => void | Promise<void>;
    readonly afterArtifactRename?: (index: number) => void | Promise<void>;
  } = {},
): Promise<PromotedF005WorkAcceptance> {
  const root = await verifiedWorkspace(workspace);
  assertRecorder(capacityRecorder);
  if (!preparedValues.has(prepared) || prepared.__brand !== 'PreparedF005WorkAcceptance' ||
    !SHA256.test(candidateSha256) ||
    prepared.expectedManifestSha !== expectedManifestSha ||
    prepared.recorderJournalId !== capacityRecorder.journalId ||
    prepared.recorderOwner !== capacityRecorder.owner) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'mint済みprepared/manifest/recorder tupleが必要です');
  }
  await Promise.all(previewArtifactRefs(prepared.previewArtifacts).map(([kind, ref]) =>
    verifyFormalArtifact(
      root,
      ref,
      kind,
      prepared.workId,
      null,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      `preview artifact ${kind}`,
    )));
  await Promise.all(prepared.evidenceRefs.map((ref) =>
    verifyFormalArtifact(
      root,
      ref,
      ref.kind,
      prepared.workId,
      prepared.previewSha256,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      `acceptance evidence ${ref.kind}`,
    )));
  const manifest = await readManifest(root);
  if (hashBatchManifest(manifest) !== expectedManifestSha) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'manifest CASがstaleです');
  }
  assertWorkOrder(manifest, prepared.workId);
  const phaseInstanceId = sha(`${prepared.preparedSha256}\0${expectedManifestSha}\0promote`);
  const notice = notifier(capacityRecorder, 'accept', phaseInstanceId);
  const paths = canonicalTransactionPaths(root, prepared.workId, capacityRecorder.journalId);
  const directory = paths.directory;
  const transitionEvidenceText = canonicalJson(prepared.transitionEvidence);
  const transitionEvidenceSha256 = sha(transitionEvidenceText);
  const journalBase: Omit<
    WorkAcceptanceJournalV3,
    'phase' | 'previousPhaseJournalSha256' | 'journalSha256'
  > = {
    schemaVersion: 3,
    owner: capacityRecorder.owner,
    workId: prepared.workId,
    candidateSha256,
    recorderJournalId: capacityRecorder.journalId,
    expectedManifestSha256: prepared.expectedManifestSha,
    nextManifestSha256: null,
    manifestPath: paths.manifestPath,
    manifestBackupPath: paths.manifestBackupPath,
    manifestNextPath: paths.manifestNextPath,
    entries: prepared.operations.map((operation) => ({
      path: operation.targetPath,
      oldSha256: null,
      newSha256: operation.sha256,
      stagedPath: workspaceRelative(root, operation.sourcePath),
      backupPath: null,
    })),
    evidenceRefs: [
      ...prepared.evidenceRefs.map((ref) => ({ path: ref.path, sha256: ref.sha256 })),
      { path: paths.transitionEvidencePath, sha256: transitionEvidenceSha256 },
    ],
    capacityJournalPath: paths.capacityJournalPath,
    capacityJournalSha256: null,
    actualCapacityReportPath: paths.actualCapacityReportPath,
    actualCapacityReportSha256: null,
  };
  await capacityRecorder.beginPhase('accept', prepared.workId, phaseInstanceId);
  try {
    await ensureDirectoryNoticed(root, directory, notice);
    await options.afterTransactionDirectory?.();
    const preparedPath = join(directory, 'prepared.json');
    const preparedPhase = sealJournalPhase(journalBase, 'prepared', null);
    const preparedBytes = canonicalJson(preparedPhase);
    await writeDurableExclusive(root, preparedPath, preparedBytes);
    await notice('create', preparedPath, null, Buffer.byteLength(preparedBytes), sha(preparedBytes));
    await options.afterPhase?.('prepared');
    const transitionEvidencePath = join(root, ...paths.transitionEvidencePath.split('/'));
    await writeDurableExclusive(root, transitionEvidencePath, transitionEvidenceText);
    await notice(
      'create',
      transitionEvidencePath,
      null,
      Buffer.byteLength(transitionEvidenceText),
      transitionEvidenceSha256,
    );
    for (const [index, operation] of prepared.operations.entries()) {
      const target = join(root, ...operation.targetPath.split('/'));
      if (!isInside(root, target)) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'promotion targetがworkspace外です');
      await ensureDirectoryNoticed(root, dirname(target), notice);
      if (await fileSha(operation.sourcePath) !== operation.sha256 || await fileSha(target) !== null) {
        fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'source/targetがprepared tupleと一致しません');
      }
      await options.beforeArtifactRename?.(index);
      await nativeRenameCurrentTargetAbsent(
        root,
        workspaceRelative(root, operation.sourcePath),
        operation.targetPath,
        operation.sha256,
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
      );
      await syncDirectory(root, dirname(operation.sourcePath));
      await syncDirectory(root, dirname(target));
      await notice('rename', operation.sourcePath, target, operation.bytes, operation.sha256);
      await options.afterArtifactRename?.(index);
    }
    if (hashBatchManifest(await readManifest(root)) !== expectedManifestSha) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'artifact promotionがlive manifestを変更しました');
    }
    const committedPath = join(directory, 'artifacts-committed.json');
    const committedPhase = sealJournalPhase(
      journalBase,
      'artifacts-committed',
      sha(preparedBytes),
    );
    const committedBytes = canonicalJson(committedPhase);
    await writeDurableExclusive(root, committedPath, committedBytes);
    await notice('create', committedPath, null, Buffer.byteLength(committedBytes), sha(committedBytes));
    await options.afterPhase?.('artifacts-committed');
    await capacityRecorder.endPhase('accept', phaseInstanceId);
    const payload = {
      workId: prepared.workId,
      expectedManifestSha: prepared.expectedManifestSha,
      recorderJournalId: prepared.recorderJournalId,
      recorderOwner: prepared.recorderOwner,
      preparedSha256: prepared.preparedSha256,
      candidateSha256,
      transitionEvidence: prepared.transitionEvidence,
      journalPath: relative(root, directory).replace(/\\/gu, '/'),
    };
    const promoted = freezeDeep({
      __brand: 'PromotedF005WorkAcceptance' as const,
      ...payload,
      promotionSha256: sha(canonicalJson(payload)),
    });
    promotedValues.add(promoted);
    return promoted;
  } catch (error) {
    if (error instanceof F005AcceptanceError) throw error;
    return fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'artifact promotionはpending journalを残して停止しました', error);
  }
}

function immutableJournalTuple(value: WorkAcceptanceJournalV3): string {
  return canonicalJson({
    schemaVersion: value.schemaVersion,
    owner: value.owner,
    workId: value.workId,
    candidateSha256: value.candidateSha256,
    recorderJournalId: value.recorderJournalId,
    expectedManifestSha256: value.expectedManifestSha256,
    manifestPath: value.manifestPath,
    manifestBackupPath: value.manifestBackupPath,
    manifestNextPath: value.manifestNextPath,
    entries: value.entries,
    evidenceRefs: value.evidenceRefs,
    capacityJournalPath: value.capacityJournalPath,
    actualCapacityReportPath: value.actualCapacityReportPath,
  });
}

async function verifyJournalEvidenceRefs(
  root: string,
  journal: WorkAcceptanceJournalV3,
): Promise<void> {
  for (const ref of journal.evidenceRefs) {
    const bytes = await readSafeFile(root, ref.path, 'F005_ACCEPTANCE_TRANSACTION_INVALID');
    if (sha(bytes) !== ref.sha256) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'journal evidence実体SHAが一致しません');
    }
  }
}

async function readTransitionEvidence(
  root: string,
  journal: WorkAcceptanceJournalV3,
): Promise<PreparedF005WorkAcceptance['transitionEvidence']> {
  const paths = canonicalTransactionPaths(root, journal.workId, journal.recorderJournalId);
  const ref = journal.evidenceRefs.find((item) => item.path === paths.transitionEvidencePath);
  if (!ref) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'transition evidence refがありません');
  const bytes = await readSafeFile(
    root,
    paths.transitionEvidencePath,
    'F005_ACCEPTANCE_TRANSACTION_INVALID',
  );
  if (sha(bytes) !== ref.sha256) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'transition evidence SHAが一致しません');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'transition evidence JSONが不正です', error);
  }
  if (canonicalJson(value) !== text) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'transition evidenceがcanonicalではありません');
  }
  return value as PreparedF005WorkAcceptance['transitionEvidence'];
}

const CAPACITY_BUCKET_KINDS = [
  'audio', 'artifact', 'repository', 'object', 'workspace-peak', 'free-after-peak',
] as const;

function validateActualCapacityBuckets(
  value: unknown,
  minimumObservedFreeBytes: number,
  peakLiveBytes: number,
  expectedAudio: readonly {
    readonly path: string;
    readonly sha256: Sha256;
    readonly bytes: number;
  }[],
  code: F005AcceptanceErrorCode,
): void {
  if (!Array.isArray(value) || value.length !== CAPACITY_BUCKET_KINDS.length) {
    fail(code, 'actual capacity bucketsが6種exactではありません');
  }
  let actualAudio: { path: string; sha256: Sha256; bytes: number }[] = [];
  for (const [index, rawBucket] of value.entries()) {
    exactDataObject(rawBucket, ['kind', 'entries', 'totalBytes'], code, `capacity bucket[${index}]`);
    const bucket = rawBucket as {
      kind: unknown;
      entries: unknown;
      totalBytes: unknown;
    };
    const expectedKind = CAPACITY_BUCKET_KINDS[index];
    if (bucket.kind !== expectedKind || !Array.isArray(bucket.entries) ||
      !Number.isSafeInteger(bucket.totalBytes) || Number(bucket.totalBytes) < 0) {
      fail(code, `capacity bucket ${String(expectedKind)} schemaが不正です`);
    }
    const bytes: number[] = [];
    const identities = new Set<string>();
    for (const [entryIndex, rawEntry] of bucket.entries.entries()) {
      if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        fail(code, `capacity entry[${entryIndex}]がobjectではありません`);
      }
      const entry = rawEntry as Record<string, unknown>;
      const kind = String(entry.kind);
      const expectedKeys = kind === 'path'
        ? ['kind', 'path', 'bytes', 'sha256']
        : kind === 'planned-audio'
          ? ['kind', 'path', 'bytes', 'sha256', 'planSha256']
          : kind === 'git-index'
            ? ['kind', 'path', 'oid', 'bytes', 'sha256']
            : kind === 'git-object'
              ? ['kind', 'oid', 'bytes', 'sha256']
              : [];
      if (expectedKeys.length === 0) fail(code, 'capacity entry kindが不正です');
      exactDataObject(entry, expectedKeys, code, `capacity entry[${entryIndex}]`);
      const kindAllowed = expectedKind === 'audio'
        ? kind === 'path'
        : expectedKind === 'artifact' || expectedKind === 'workspace-peak'
          ? kind === 'path'
          : expectedKind === 'repository'
            ? kind === 'git-index'
            : expectedKind === 'object'
              ? kind === 'git-object'
              : false;
      const pathValid = kind === 'path' || kind === 'planned-audio' || kind === 'git-index'
        ? SAFE_PATH.test(String(entry.path))
        : true;
      const oidValid = kind === 'git-index' || kind === 'git-object'
        ? /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(String(entry.oid))
        : true;
      if (!kindAllowed || !pathValid || !oidValid ||
        !SHA256.test(String(entry.sha256)) ||
        (kind === 'planned-audio' && !SHA256.test(String(entry.planSha256))) ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
        fail(code, `capacity entry[${entryIndex}] schema/値が不正です`);
      }
      const identity = kind === 'git-object'
        ? `${kind}:${String(entry.oid)}`
        : kind === 'git-index'
          ? `${kind}:${String(entry.path)}:${String(entry.oid)}`
          : `${kind}:${String(entry.path)}`;
      if (identities.has(identity)) fail(code, 'capacity entry identityが重複しています');
      identities.add(identity);
      bytes.push(Number(entry.bytes));
      if (expectedKind === 'audio') {
        actualAudio.push({
          path: String(entry.path),
          sha256: String(entry.sha256) as Sha256,
          bytes: Number(entry.bytes),
        });
      }
    }
    const expectedTotal = expectedKind === 'object'
      ? Math.max(0, ...bytes)
      : expectedKind === 'workspace-peak'
        ? peakLiveBytes
        : expectedKind === 'free-after-peak'
          ? minimumObservedFreeBytes
          : bytes.reduce((sum, item) => sum + item, 0);
    if (!Number.isSafeInteger(expectedTotal) || bucket.totalBytes !== expectedTotal ||
      (expectedKind === 'free-after-peak' && bucket.entries.length !== 0)) {
      fail(code, `capacity bucket ${String(expectedKind)} totalが不正です`);
    }
  }
  actualAudio = actualAudio.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const expected = [...expectedAudio]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (canonicalJson(actualAudio) !== canonicalJson(expected)) {
    fail(code, 'actual audio bucketが昇格済み音声artifact exact setと一致しません');
  }
}

async function verifyActualCapacityBinding(
  root: string,
  journal: WorkAcceptanceJournalV3,
  actualRef: F005ActualCapacityReportRef,
  code: F005AcceptanceErrorCode = 'F005_ACCEPTANCE_TRANSACTION_INVALID',
): Promise<void> {
  exactDataObject(
    actualRef,
    ['kind', 'path', 'sha256', 'candidateSha256', 'journalId', 'journalSha256'],
    code,
    'actual capacity ref',
  );
  if (actualRef.kind !== 'actual-capacity-report' ||
    actualRef.path !== journal.actualCapacityReportPath ||
    actualRef.candidateSha256 !== journal.candidateSha256 ||
    actualRef.journalId !== journal.recorderJournalId ||
    !SHA256.test(actualRef.sha256) || !SHA256.test(actualRef.journalSha256)) {
    fail(code, 'actual ref canonical tupleが不正です');
  }
  const actualBytes = await readSafeFile(
    root,
    journal.actualCapacityReportPath,
    code,
  );
  const actualText = new TextDecoder('utf-8', { fatal: true }).decode(actualBytes);
  let actual: unknown;
  try {
    actual = JSON.parse(actualText);
  } catch (error) {
    return fail(code, 'actual容量JSONが不正です', error);
  }
  exactDataObject(
    actual,
    ['schemaVersion', 'kind', 'workId', 'journalId', 'payload'],
    code,
    'actual capacity report',
  );
  const report = actual as {
    schemaVersion: unknown;
    kind: unknown;
    workId: unknown;
    journalId: unknown;
    payload: Record<string, unknown>;
  };
  exactDataObject(
    report.payload,
    [
      'schemaVersion', 'workId', 'candidateSha256', 'journalId', 'journalSha256',
      'minimumObservedFreeBytes', 'peakLiveBytes', 'buckets', 'state',
    ],
    code,
    'actual capacity payload',
  );
  const minimumObservedFreeBytes = report.payload.minimumObservedFreeBytes;
  const peakLiveBytes = report.payload.peakLiveBytes;
  if (report.payload.schemaVersion !== 3 ||
    !Number.isSafeInteger(minimumObservedFreeBytes) || Number(minimumObservedFreeBytes) < 0 ||
    !Number.isSafeInteger(peakLiveBytes) || Number(peakLiveBytes) < 0 ||
    report.payload.state !== 'closed') {
    fail(code, 'actual容量payload version/integer/stateが不正です');
  }
  const transitionEvidence = await readTransitionEvidence(root, journal);
  const expectedAudio = transitionEvidence.acceptedSources
    .filter((source) =>
      source.path.startsWith(`content/batches/F005/accepted-audio/${journal.workId}/`) &&
      source.path.endsWith('.wav'))
    .map((source) => ({
      path: source.path,
      sha256: source.sha256,
      bytes: source.bytes,
    }));
  const journalAudio = journal.entries
    .filter((entry) =>
      entry.path.startsWith(`content/batches/F005/accepted-audio/${journal.workId}/`) &&
      entry.path.endsWith('.wav'))
    .map((entry) => ({ path: entry.path, sha256: entry.newSha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const transitionAudio = expectedAudio
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (expectedAudio.length === 0 ||
    canonicalJson(journalAudio) !== canonicalJson(transitionAudio)) {
    fail(code, 'journal entriesとtransition acceptedSourcesの音声tupleが一致しません');
  }
  validateActualCapacityBuckets(
    report.payload.buckets,
    Number(minimumObservedFreeBytes),
    Number(peakLiveBytes),
    expectedAudio,
    code,
  );
  if (canonicalJson(actual) !== actualText || sha(actualBytes) !== actualRef.sha256 ||
    report.schemaVersion !== '1.0.0' || report.kind !== actualRef.kind ||
    report.workId !== journal.workId || report.journalId !== journal.recorderJournalId ||
    report.payload.state !== 'closed' || report.payload.workId !== journal.workId ||
    report.payload.candidateSha256 !== journal.candidateSha256 ||
    report.payload.journalId !== journal.recorderJournalId ||
    report.payload.journalSha256 !== actualRef.journalSha256) {
    fail(code, 'actual容量reportのjournal/work/SHAが一致しません');
  }
  const nativeBytes = await readSafeFile(
    root,
    journal.capacityJournalPath,
    code,
  );
  const nativeJournal =
    await readF005NativeCapacityJournalFile(root, journal.capacityJournalPath);
  const derivedRecorderJournalId = sha(
    `${nativeJournal.sessionNonce}\0${nativeJournal.owner}\0${nativeJournal.workId}` +
    `\0${nativeJournal.candidateSha256}\0f005-capacity-v3`,
  );
  if (nativeJournal.state !== 'closed' ||
    nativeJournal.workId !== journal.workId ||
    nativeJournal.candidateSha256 !== journal.candidateSha256 ||
    nativeJournal.owner !== journal.owner ||
    !SHA256.test(nativeJournal.sessionNonce) ||
    derivedRecorderJournalId !== journal.recorderJournalId ||
    nativeJournal.minimumObservedFreeBytes !== minimumObservedFreeBytes ||
    nativeJournal.peakLiveBytes !== peakLiveBytes ||
    sha(nativeBytes) !== actualRef.journalSha256) {
    fail(code, 'closed native journal実体が一致しません');
  }
}

interface FinalizeLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStartIdentity: Sha256;
  readonly token: string;
  readonly workId: WorkId;
  readonly recorderJournalId: Sha256;
  readonly sealSha256: Sha256;
}

function validateFinalizeLockText(
  text: string,
  workId: WorkId,
  journalId: Sha256,
  code: F005AcceptanceErrorCode,
): FinalizeLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(code, 'finalize lock JSONが不正です', error);
  }
  exactDataObject(
    value,
    [
      'schemaVersion', 'pid', 'processStartIdentity', 'token', 'workId',
      'recorderJournalId', 'sealSha256',
    ],
    code,
    'finalize lock',
  );
  const lock = value as Record<string, unknown>;
  const core = Object.fromEntries(
    Object.entries(lock).filter(([key]) => key !== 'sealSha256'),
  );
  if (canonicalJson(value) !== text || lock.schemaVersion !== 1 ||
    !Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0 ||
    !SHA256.test(String(lock.processStartIdentity)) ||
    typeof lock.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(lock.token) ||
    lock.workId !== workId || lock.recorderJournalId !== journalId ||
    !SHA256.test(String(lock.recorderJournalId)) ||
    lock.sealSha256 !== sha(canonicalJson(core))) {
    fail(code, 'finalize lock seal/tupleが不正です');
  }
  return value as FinalizeLockRecord;
}

async function acquireFinalizeLock(
  root: string,
  workId: WorkId,
  journalId: Sha256,
): Promise<{
  root: string;
  relativePath: string;
  path: string;
  text: string;
}> {
  const paths = canonicalTransactionPaths(root, workId, journalId);
  const path = join(root, ...paths.lockPath.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await syncDirectory(root, dirname(dirname(path)));
  await syncDirectory(root, dirname(path));
  const parentInfo = await lstat(dirname(path));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() ||
    await realpath(dirname(path)) !== dirname(path)) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'finalize lock directoryが不正です');
  }
  const recoveryTrashPlan = await preScanF005RecoveryTrash(
    root,
    'F005_ACCEPTANCE_TRANSACTION_INVALID',
  );
  await cleanupF005RecoveryTrash(
    root,
    recoveryTrashPlan,
    'F005_ACCEPTANCE_TRANSACTION_INVALID',
  );
  const pendingTemp = await findCanonicalDurableTemp(
    root,
    path,
    'F005_ACCEPTANCE_TRANSACTION_INVALID',
  );
  if (pendingTemp) {
    const pendingLock = validateFinalizeLockText(
      pendingTemp.text,
      workId,
      journalId,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
    );
    if (await exists(path)) {
      fail(
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
        'canonical lockとlock tempが競合しています',
      );
    }
    const observedIdentity = await readProcessStartIdentity(pendingLock.pid);
    if (observedIdentity === pendingLock.processStartIdentity ||
      (observedIdentity === null && processAlive(pendingLock.pid))) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', '生存processのlock tempがあります');
    }
    const pendingTempNativeIdentity = await snapshotNativeFileIdentity(
      root,
      pendingTemp.relativePath,
      pendingTemp.sha256,
      pendingTemp.bytes.byteLength,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
    );
    await discardCanonicalDurableTemp(
      root,
      pendingTemp,
      null,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      pendingTempNativeIdentity,
    );
  }
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  if (processStartIdentity === null) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'current process start identityを取得できません');
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const core = {
      schemaVersion: 1,
      pid: process.pid,
      processStartIdentity,
      token: randomUUID(),
      workId,
      recorderJournalId: journalId,
    };
    const text = canonicalJson({ ...core, sealSha256: sha(canonicalJson(core)) });
    try {
      if (await exists(path)) {
        const collision = new Error('finalize lock exists') as NodeJS.ErrnoException;
        collision.code = 'EEXIST';
        throw collision;
      }
      await writeDurableExclusive(root, path, text);
      return { root, relativePath: paths.lockPath, path, text };
    } catch (error) {
      if (!await exists(path) || attempt !== 0) {
        return fail(
          'F005_ACCEPTANCE_TRANSACTION_INVALID',
          'finalize exclusive lockを取得できません',
          error,
        );
      }
      const lockRelativePath = paths.lockPath;
      await syncDirectory(root, dirname(path));
      const bytes = await readSafeFile(
        root,
        lockRelativePath,
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
      );
      const existingText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const lock = validateFinalizeLockText(
        existingText,
        workId,
        journalId,
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
      );
      const observedIdentity = await readProcessStartIdentity(lock.pid);
      if (observedIdentity === lock.processStartIdentity ||
        (observedIdentity === null && processAlive(lock.pid))) {
        fail('F005_ACCEPTANCE_TRANSACTION_INVALID', '生存processがfinalize lockを保持しています');
      }
      const staleRelativePath =
        `.cache/locks/f005-accept-${workId}.stale-${lock.token}`;
      const staleNativeIdentity = await nativeRenameCurrentTargetAbsent(
        root,
        lockRelativePath,
        staleRelativePath,
        sha(bytes),
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
      );
      const staleBytes = await readSafeFile(
        root,
        staleRelativePath,
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
      );
      if (sha(staleBytes) !== sha(bytes)) {
        fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'stale lock CAS post-readが不正です');
      }
      await nativeDeleteExact(
        root,
        staleRelativePath,
        sha(bytes),
        'F005_ACCEPTANCE_TRANSACTION_INVALID',
        staleNativeIdentity,
      );
    }
  }
  return fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'finalize lock retry上限です');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readProcessStartIdentity(pid: number): Promise<Sha256 | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') {
    if (!processAlive(pid)) return null;
    return pid === process.pid
      ? sha(`${pid}\0${CURRENT_PROCESS_START_EPOCH_MS}\0process-start-v1`)
      : sha(`${pid}\0live-unverified\0process-start-v1`);
  }
  // CHG-F005-074: process開始時刻の取得はpowershell.exeの起動を伴う。
  // hosted runnerでは直前の音声合成の負荷でinterpreter起動が5秒を超えることがあり、
  // 実際に001104(83件)の受理がここで停止した。identityは他processからも同じ値を
  // 計算できる必要があるためWin32のStartTimeを使い続け、起動待ちだけを緩める。
  const command =
    `$value=Get-Process -Id ${pid} -ErrorAction Stop;` +
    '[Console]::Out.Write($value.StartTime.ToUniversalTime().Ticks)';
  for (const timeout of PROCESS_START_IDENTITY_TIMEOUTS_MS) {
    try {
      const result = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout, maxBuffer: 4_096 },
      );
      const ticks = result.stdout.trim();
      if (!/^[0-9]{10,20}$/u.test(ticks)) return null;
      return sha(`${pid}\0${ticks}\0process-start-v1`);
    } catch (error) {
      // processが存在しない場合はGet-Processが失敗する。再試行しても変わらないので
      // 生存しないと判っているときだけ即座に打ち切る。
      if (!processAlive(pid)) return null;
      if (timeout === PROCESS_START_IDENTITY_TIMEOUTS_MS.at(-1)) return null;
      void error;
    }
  }
  return null;
}

async function releaseFinalizeLock(
  lock: {
    root: string;
    relativePath: string;
    path: string;
    text: string;
  },
): Promise<void> {
  const releaseRelativePath =
    `${lock.relativePath}.release-${sha(lock.text)}`;
  const releaseNativeIdentity = await nativeRenameCurrentTargetAbsent(
    lock.root,
    lock.relativePath,
    releaseRelativePath,
    sha(lock.text),
    'F005_ACCEPTANCE_TRANSACTION_INVALID',
  );
  await nativeDeleteExact(
    lock.root,
    releaseRelativePath,
    sha(lock.text),
    'F005_ACCEPTANCE_TRANSACTION_INVALID',
    releaseNativeIdentity,
  );
}

/**
 * closed journalから生成されたactual artifactを再読込し、metadata-only CASでacceptedを確定する。
 * @des DES-F005-006 @fun FUN-F005-019 FUN-F005-022 @ut UT-F005-019 UT-F005-022
 */
export async function finalizeF005WorkAcceptance(
  workspace: string,
  promoted: PromotedF005WorkAcceptance,
  actualRef: F005ActualCapacityReportRef,
  expectedManifestSha: Sha256 | string,
  options: {
    readonly now?: () => string;
    readonly afterPhase?: (
      phase: 'capacity-measured' | 'manifest-renamed' | 'manifest-committed' | 'closed'
    ) => void | Promise<void>;
    readonly afterFileSync?: (
      artifact: 'manifest-next' | 'capacity-measured' | 'manifest-committed' | 'closed'
    ) => void | Promise<void>;
    readonly afterManifestOldRenamed?: () => void | Promise<void>;
    readonly recoveryNativeIdentities?: ReadonlyMap<string, F005NativeFileIdentity>;
  } = {},
): Promise<BatchManifest> {
  const root = await verifiedWorkspace(workspace);
  const paths = canonicalTransactionPaths(root, promoted.workId, promoted.recorderJournalId);
  if (promoted.__brand !== 'PromotedF005WorkAcceptance' ||
    promoted.promotionSha256 !== sha(canonicalJson({
      workId: promoted.workId,
      expectedManifestSha: promoted.expectedManifestSha,
      recorderJournalId: promoted.recorderJournalId,
      recorderOwner: promoted.recorderOwner,
      preparedSha256: promoted.preparedSha256,
      candidateSha256: promoted.candidateSha256,
      transitionEvidence: promoted.transitionEvidence,
      journalPath: promoted.journalPath,
    })) ||
    promoted.journalPath !== paths.journalDirectory ||
    expectedManifestSha !== promoted.expectedManifestSha) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'promoted/actual ref bindingが不正です');
  }
  const lock = await acquireFinalizeLock(root, promoted.workId, promoted.recorderJournalId);
  try {
    const prepared = await readJournalPhase(root, paths.directory, 'prepared', null);
    if (!prepared) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'prepared journalがありません');
    const committed = await readJournalPhase(
      root,
      paths.directory,
      'artifacts-committed',
      prepared.wholeFileSha256,
    );
    if (!committed ||
      immutableJournalTuple(committed.journal) !== immutableJournalTuple(prepared.journal) ||
      prepared.journal.workId !== promoted.workId ||
      prepared.journal.recorderJournalId !== promoted.recorderJournalId ||
      prepared.journal.candidateSha256 !== promoted.candidateSha256 ||
      prepared.journal.owner !== promoted.recorderOwner ||
      prepared.journal.expectedManifestSha256 !== promoted.expectedManifestSha) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'promotion journal phase chainが不正です');
    }
    await verifyJournalEvidenceRefs(root, prepared.journal);
    const storedTransition = await readTransitionEvidence(root, prepared.journal);
    if (canonicalJson(storedTransition) !== canonicalJson(promoted.transitionEvidence)) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'promoted transition evidenceがstaleです');
    }
    for (const entry of prepared.journal.entries) {
      if (await fileSha(join(root, ...entry.path.split('/'))) !== entry.newSha256 ||
        await fileSha(join(root, ...entry.stagedPath.split('/'))) !== null) {
        fail('F005_ACCEPTANCE_TRANSACTION_INVALID', '昇格済みartifact tupleが一致しません');
      }
    }
    await verifyActualCapacityBinding(root, prepared.journal, actualRef);
    const manifest = await readManifest(root);
    if (hashBatchManifest(manifest) !== promoted.expectedManifestSha) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'finalize manifest CASがstaleです');
    }
    const acceptedAt = options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(acceptedAt))) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'acceptedAtが不正です');
    }
    const evidence: PreparedWorkAcceptanceEvidence = freezeDeep({
      ...storedTransition,
      actualCapacityReportSha: actualRef.sha256,
      acceptedAt,
      acceptedBy: promoted.recorderOwner,
    });
    const next = transitionWorkState(manifest, promoted.workId, 'accepted', evidence);
    const nextManifestSha256 = hashBatchManifest(next);
    const nextBytes = canonicalJson(next);
    const manifestPath = join(root, ...paths.manifestPath.split('/'));
    const nextPath = join(root, ...paths.manifestNextPath.split('/'));
    const backupPath = join(root, ...paths.manifestBackupPath.split('/'));
    if (await exists(backupPath)) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'manifest backupがexpected-absentではありません');
    }
    const existingNextSha = await fileSha(nextPath);
    if (existingNextSha === null) {
      await writeDurableExclusive(
        root,
        nextPath,
        nextBytes,
        () => options.afterFileSync?.('manifest-next'),
      );
    } else if (existingNextSha === nextManifestSha256) {
      await syncDirectory(root, dirname(nextPath));
    } else {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', '既存manifest-nextがsealed bytesと一致しません');
    }
    if (await fileSha(nextPath) !== nextManifestSha256) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'sealed next manifest post-readが不正です');
    }
    const measuredBase = {
      ...journalPhaseBase(prepared.journal),
      nextManifestSha256,
      capacityJournalSha256: actualRef.journalSha256,
      actualCapacityReportSha256: actualRef.sha256,
    };
    const capacityPhase = sealJournalPhase(
      measuredBase,
      'capacity-measured',
      committed.wholeFileSha256,
    );
    const capacityBytes = canonicalJson(capacityPhase);
    await writeDurableExclusive(
      root,
      join(paths.directory, 'capacity-measured.json'),
      capacityBytes,
      () => options.afterFileSync?.('capacity-measured'),
    );
    await options.afterPhase?.('capacity-measured');

    if (hashBatchManifest(await readManifest(root)) !== promoted.expectedManifestSha) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'manifest CAS直前のexpected SHAが変化しました');
    }
    const manifestOldNativeIdentity = await mutationNativeIdentity(
      root,
      paths.manifestPath,
      promoted.expectedManifestSha,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      options.recoveryNativeIdentities,
    );
    const manifestNextNativeIdentity = await mutationNativeIdentity(
      root,
      paths.manifestNextPath,
      nextManifestSha256,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      options.recoveryNativeIdentities,
    );
    await nativeRenameTargetAbsent(
      root,
      paths.manifestPath,
      paths.manifestBackupPath,
      promoted.expectedManifestSha,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      manifestOldNativeIdentity,
    );
    await options.afterManifestOldRenamed?.();
    await nativeRenameTargetAbsent(
      root,
      paths.manifestNextPath,
      paths.manifestPath,
      nextManifestSha256,
      'F005_ACCEPTANCE_TRANSACTION_INVALID',
      manifestNextNativeIdentity,
    );
    await syncDirectory(root, dirname(manifestPath));
    await syncDirectory(root, dirname(nextPath));
    await options.afterPhase?.('manifest-renamed');
    const post = await readManifest(root);
    if (hashBatchManifest(post) !== nextManifestSha256 ||
      await fileSha(backupPath) !== promoted.expectedManifestSha) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'metadata-only finalize post-readが一致しません');
    }
    const manifestPhase = sealJournalPhase(
      measuredBase,
      'manifest-committed',
      sha(capacityBytes),
    );
    const manifestPhaseBytes = canonicalJson(manifestPhase);
    await writeDurableExclusive(
      root,
      join(paths.directory, 'manifest-committed.json'),
      manifestPhaseBytes,
      () => options.afterFileSync?.('manifest-committed'),
    );
    await options.afterPhase?.('manifest-committed');
    const closedPhase = sealJournalPhase(
      measuredBase,
      'closed',
      sha(manifestPhaseBytes),
    );
    await writeDurableExclusive(
      root,
      join(paths.directory, 'closed.json'),
      canonicalJson(closedPhase),
      () => options.afterFileSync?.('closed'),
    );
    await options.afterPhase?.('closed');
    return post;
  } finally {
    await releaseFinalizeLock(lock);
  }
}

export interface F005RecoveryResult {
  readonly result: 'no-op' | 'rolled-back' | 'completed';
  readonly recoveredWorkIds: readonly WorkId[];
  readonly journalCount: number;
}


/**
 * CHG-F005-002の二段journalを回復する。payload promotionだけが完了した場合は旧版へ戻し、
 * manifest CAS済みならactual結合済みの完成新版だけへ収束する。
 */

export async function recoverF005WorkAcceptance(workspace: string): Promise<F005RecoveryResult> {
  return recoverStrictF005WorkAcceptance(workspace);
}
async function actualRefFromJournal(
  root: string,
  journal: WorkAcceptanceJournalV3,
): Promise<F005ActualCapacityReportRef | null> {
  if (!await exists(join(root, ...journal.actualCapacityReportPath.split('/')))) return null;
  const bytes = await readSafeFile(
    root,
    journal.actualCapacityReportPath,
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
  );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'actual容量JSONが不正です', error);
  }
  if (canonicalJson(value) !== text || value === null || typeof value !== 'object') {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'actual容量JSONがcanonicalではありません');
  }
  const report = value as {
    kind?: unknown;
    payload?: {
      candidateSha256?: unknown;
      journalId?: unknown;
      journalSha256?: unknown;
    };
  };
  if (report.kind !== 'actual-capacity-report' ||
    !SHA256.test(String(report.payload?.candidateSha256)) ||
    !SHA256.test(String(report.payload?.journalId)) ||
    !SHA256.test(String(report.payload?.journalSha256))) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'actual容量bindingが不正です');
  }
  return {
    kind: 'actual-capacity-report',
    path: journal.actualCapacityReportPath,
    sha256: sha(bytes),
    candidateSha256: report.payload!.candidateSha256 as Sha256,
    journalId: report.payload!.journalId as Sha256,
    journalSha256: report.payload!.journalSha256 as Sha256,
  };
}

async function readStrictJournalChain(
  root: string,
  directory: string,
): Promise<readonly {
  phase: AcceptanceJournalPhase;
  journal: WorkAcceptanceJournalV3;
  text: string;
  wholeFileSha256: Sha256;
}[]> {
  const result: {
    phase: AcceptanceJournalPhase;
    journal: WorkAcceptanceJournalV3;
    text: string;
    wholeFileSha256: Sha256;
  }[] = [];
  let previous: Sha256 | null = null;
  let missingSeen = false;
  for (const phase of JOURNAL_PHASES) {
    const loaded = await readJournalPhase(root, directory, phase, previous);
    if (!loaded) {
      missingSeen = true;
      continue;
    }
    if (missingSeen) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `journal phaseが飛越しています: ${phase}`);
    }
    result.push({ phase, ...loaded });
    previous = loaded.wholeFileSha256;
  }
  if (result.length === 0 || result[0]!.phase !== 'prepared') {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'prepared journalがありません');
  }
  const first = result[0]!.journal;
  for (const item of result.slice(1)) {
    if (immutableJournalTuple(item.journal) !== immutableJournalTuple(first)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal immutable tupleがphase間で変化しました');
    }
    const measured = JOURNAL_PHASES.indexOf(item.phase) >=
      JOURNAL_PHASES.indexOf('capacity-measured');
    if (measured &&
      (item.journal.nextManifestSha256 !==
        result.find((entry) => entry.phase === 'capacity-measured')?.journal.nextManifestSha256 ||
        item.journal.capacityJournalSha256 !==
        result.find((entry) => entry.phase === 'capacity-measured')?.journal.capacityJournalSha256 ||
        item.journal.actualCapacityReportSha256 !==
        result.find((entry) => entry.phase === 'capacity-measured')?.journal
          .actualCapacityReportSha256)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal measured tupleがphase間で変化しました');
    }
  }
  return result;
}

function parseCanonicalTempJson(
  temporary: CanonicalDurableTemp,
  label: string,
  code: F005AcceptanceErrorCode,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(temporary.text);
  } catch (error) {
    return fail(code, `${label} canonical temp JSONが不正です`, error);
  }
  if (canonicalJson(value) !== temporary.text) {
    fail(code, `${label} canonical temp bytesがcanonical JSONではありません`);
  }
  return value;
}

function validateTransitionEvidenceValue(
  value: unknown,
  journal: WorkAcceptanceJournalV3,
  text: string,
  code: F005AcceptanceErrorCode,
): void {
  exactDataObject(
    value,
    [
      'kind', 'batchId', 'workId', 'expectedManifestSha', 'acceptedSources',
      'preTreeDigest', 'postTreeDigest', 'contentBuildSha', 'contentStagingSha',
      'distSha', 'f001ContentInvariantReportSha', 'f001DistInvariantReportSha',
      'journalId',
    ],
    code,
    'transition evidence',
  );
  const evidence = value as Record<string, unknown>;
  const shaFields = [
    'expectedManifestSha', 'preTreeDigest', 'postTreeDigest', 'contentBuildSha',
    'contentStagingSha', 'distSha', 'f001ContentInvariantReportSha',
    'f001DistInvariantReportSha', 'journalId',
  ];
  if (canonicalJson(value) !== text || evidence.kind !== 'accepted' ||
    evidence.batchId !== 'F005' || evidence.workId !== journal.workId ||
    evidence.expectedManifestSha !== journal.expectedManifestSha256 ||
    evidence.journalId !== journal.recorderJournalId ||
    shaFields.some((field) => !SHA256.test(String(evidence[field]))) ||
    !Array.isArray(evidence.acceptedSources) || evidence.acceptedSources.length === 0) {
    fail(code, 'transition evidence schema/tupleが不正です');
  }
  const expectedEntries = new Map(journal.entries.map((entry) => [
    entry.path,
    entry,
  ]));
  const seen = new Set<string>();
  for (const [index, source] of evidence.acceptedSources.entries()) {
    exactDataObject(
      source,
      ['path', 'sha256', 'bytes', 'configHash'],
      code,
      `transition evidence acceptedSources[${index}]`,
    );
    const accepted = source as Record<string, unknown>;
    const path = String(accepted.path);
    const entry = expectedEntries.get(path);
    if (!SAFE_PATH.test(path) || seen.has(path) || !entry ||
      accepted.sha256 !== entry.newSha256 ||
      !Number.isSafeInteger(accepted.bytes) || Number(accepted.bytes) < 0 ||
      !SHA256.test(String(accepted.configHash))) {
      fail(code, 'transition evidence accepted source tupleが不正です');
    }
    seen.add(path);
  }
  if (seen.size !== journal.entries.length) {
    fail(code, 'transition evidenceとjournal entry集合が一致しません');
  }
}

async function recoverJournalDurableTemp(
  root: string,
  directory: string,
  phase: AcceptanceJournalPhase,
  previousWholeFileSha256: Sha256 | null,
  expectedNativeIdentities?: ReadonlyMap<string, F005NativeFileIdentity>,
): Promise<void> {
  const path = join(directory, `${phase}.json`);
  await recoverCanonicalDurableTemp(
    root,
    path,
    (temporary) => {
      const value = parseCanonicalTempJson(
        temporary,
        `${phase} journal`,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      );
      validateWorkAcceptanceJournalV3(
        value,
        temporary.text,
        phase,
        previousWholeFileSha256,
        root,
        directory,
      );
    },
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    expectedNativeIdentities,
  );
}

async function validateManifestNextTemp(
  root: string,
  journal: WorkAcceptanceJournalV3,
  temporary: CanonicalDurableTemp,
  transitionEvidenceOverride?: PreparedF005WorkAcceptance['transitionEvidence'],
): Promise<void> {
  const value = parseCanonicalTempJson(
    temporary,
    'manifest-next',
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
  );
  const checked = validateBatchManifest(value);
  if (!checked.ok || checked.value.batchId !== 'F005' ||
    canonicalJson(checked.value) !== temporary.text) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest-next schemaが不正です');
  }
  const acceptedWork = checked.value.workProgress.find(
    (work) => work.workId === journal.workId,
  );
  const acceptedAt = acceptedWork?.acceptedAt;
  const actualRef = await actualRefFromJournal(root, journal);
  if (!actualRef || acceptedWork?.status !== 'accepted' ||
    acceptedWork.acceptedBy !== journal.owner ||
    typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt)) ||
    !acceptedWork.stageRecords.at(-1)?.inputHashes.includes(actualRef.sha256)) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest-next acceptance tupleが不正です');
  }
  const transitionEvidence = transitionEvidenceOverride ??
    await readTransitionEvidence(root, journal);
  const evidence: PreparedWorkAcceptanceEvidence = {
    ...transitionEvidence,
    actualCapacityReportSha: actualRef.sha256,
    acceptedAt,
    acceptedBy: journal.owner,
  };
  const manifestPath = join(root, ...journal.manifestPath.split('/'));
  const backupPath = join(root, ...journal.manifestBackupPath.split('/'));
  const manifestSha256 = await fileSha(manifestPath);
  const backupSha256 = await fileSha(backupPath);
  let base: BatchManifest;
  if (manifestSha256 === journal.expectedManifestSha256) {
    base = await readManifest(root);
  } else if (backupSha256 === journal.expectedManifestSha256) {
    const bytes = await readSafeFile(
      root,
      journal.manifestBackupPath,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let backupValue: unknown;
    try {
      backupValue = JSON.parse(text);
    } catch (error) {
      return fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest backup JSONが不正です', error);
    }
    const backup = validateBatchManifest(backupValue);
    if (!backup.ok || canonicalJson(backup.value) !== text) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest backup schemaが不正です');
    }
    base = backup.value;
  } else {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest-next base manifestがありません');
  }
  const expected = transitionWorkState(base, journal.workId, 'accepted', evidence);
  if (canonicalJson(expected) !== temporary.text) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest-next bytesがexact transitionと一致しません');
  }
}

const TRANSACTION_TARGET_BASENAMES = [
  'transition-evidence.json',
  'prepared.json',
  'artifacts-committed.json',
  'capacity-measured.json',
  'manifest-next.json',
  'manifest-old.json',
  'manifest-committed.json',
  'closed.json',
] as const;
const TRANSACTION_TEMP_BASENAMES = TRANSACTION_TARGET_BASENAMES.filter(
  (name) => name !== 'manifest-old.json',
);

interface ScannedTransactionFile extends CanonicalDurableTemp {
  readonly basename: string;
  readonly isTemporary: boolean;
  readonly nativeIdentity: F005NativeFileIdentity;
}

interface TransactionRecoveryPlan {
  readonly directory: string;
  readonly nativeIdentities: ReadonlyMap<string, F005NativeFileIdentity>;
}

function plannedNativeIdentity(
  plan: TransactionRecoveryPlan,
  relativePath: string,
): F005NativeFileIdentity | undefined {
  const direct = plan.nativeIdentities.get(relativePath);
  if (direct) return direct;
  const prefix = `${dirname(relativePath).replace(/\\/gu, '/')}/.${basename(relativePath)}.`;
  for (const [candidate, identity] of plan.nativeIdentities) {
    if (candidate.startsWith(prefix) && candidate.endsWith('.tmp')) return identity;
  }
  return undefined;
}

function requirePlannedNativeIdentity(
  plan: TransactionRecoveryPlan,
  relativePath: string,
): F005NativeFileIdentity {
  const identity = plannedNativeIdentity(plan, relativePath);
  if (!identity) {
    fail(
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      `mutation sourceのpre-scan native identityがありません: ${relativePath}`,
    );
  }
  return identity;
}

async function preScanTransactionRecovery(
  root: string,
  directory: string,
): Promise<TransactionRecoveryPlan> {
  const targets = new Map<string, ScannedTransactionFile>();
  const temporaries = new Map<string, ScannedTransactionFile>();
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    let targetBasename: string | undefined;
    let filenameSha256: Sha256 | undefined;
    if (TRANSACTION_TARGET_BASENAMES.includes(
      entry.name as typeof TRANSACTION_TARGET_BASENAMES[number],
    )) {
      targetBasename = entry.name;
    } else {
      for (const allowed of TRANSACTION_TEMP_BASENAMES) {
        const matched = new RegExp(
          `^\\.${allowed.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.([0-9a-f]{64})\\.tmp$`,
          'u',
        ).exec(entry.name);
        if (matched) {
          targetBasename = allowed;
          filenameSha256 = matched[1] as Sha256;
          break;
        }
      }
    }
    if (!targetBasename || !entry.isFile() || entry.isSymbolicLink()) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `未知transaction fileがあります: ${entry.name}`);
    }
    const collection = filenameSha256 === undefined ? targets : temporaries;
    if (collection.has(targetBasename)) {
      fail(
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        `${targetBasename} canonical target/tempが複数あります`,
      );
    }
    const path = join(directory, entry.name);
    const relativePath = workspaceRelative(root, path);
    const bytes = await readSafeFile(
      root,
      relativePath,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    const actualSha256 = sha(bytes);
    if (filenameSha256 !== undefined && filenameSha256 !== actualSha256) {
      fail(
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        `${targetBasename} temp filename SHAが実体と一致しません`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      return fail(
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        `${targetBasename} transaction fileがUTF-8ではありません`,
        error,
      );
    }
    collection.set(targetBasename, {
      basename: targetBasename,
      isTemporary: filenameSha256 !== undefined,
      relativePath,
      path,
      sha256: actualSha256,
      bytes,
      text,
      nativeIdentity: await snapshotNativeFileIdentity(
        root,
        relativePath,
        actualSha256,
        bytes.byteLength,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      ),
    });
  }
  for (const basename of TRANSACTION_TEMP_BASENAMES) {
    const target = targets.get(basename);
    const temporary = temporaries.get(basename);
    if (target && temporary &&
      (target.sha256 !== temporary.sha256 || target.text !== temporary.text)) {
      fail(
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        `${basename} targetとcanonical temp bytesが競合しています`,
      );
    }
  }
  const virtual = (basename: string): ScannedTransactionFile | undefined =>
    targets.get(basename) ?? temporaries.get(basename);
  const preparedFile = virtual('prepared.json');
  if (!preparedFile) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'prepared target/tempがありません');
  }
  const journalFiles = new Map<AcceptanceJournalPhase, ScannedTransactionFile>();
  let previousWholeFileSha256: Sha256 | null = null;
  let previousPhaseIndex = -1;
  let virtualPhaseGap = false;
  let preparedJournal: WorkAcceptanceJournalV3 | undefined;
  let measuredJournal: WorkAcceptanceJournalV3 | undefined;
  for (const [phaseIndex, phase] of JOURNAL_PHASES.entries()) {
    const candidate = virtual(`${phase}.json`);
    if (!candidate) continue;
    const value = parseCanonicalTempJson(
      candidate,
      `${phase} journal`,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    const linkedToPrevious = phaseIndex === 0 ||
      previousPhaseIndex === phaseIndex - 1;
    if (!linkedToPrevious) virtualPhaseGap = true;
    const expectedPrevious = linkedToPrevious
      ? previousWholeFileSha256
      : (value as Partial<WorkAcceptanceJournalV3>).previousPhaseJournalSha256 ?? null;
    const journal = validateWorkAcceptanceJournalV3(
      value,
      candidate.text,
      phase,
      expectedPrevious,
      root,
      directory,
    );
    if (preparedJournal &&
      immutableJournalTuple(journal) !== immutableJournalTuple(preparedJournal)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'virtual journal immutable tupleが変化しました');
    }
    if (phase === 'prepared') preparedJournal = journal;
    if (phase === 'capacity-measured') measuredJournal = journal;
    if (measuredJournal && JOURNAL_PHASES.indexOf(phase) >=
      JOURNAL_PHASES.indexOf('capacity-measured') &&
      (journal.nextManifestSha256 !== measuredJournal.nextManifestSha256 ||
        journal.capacityJournalSha256 !== measuredJournal.capacityJournalSha256 ||
        journal.actualCapacityReportSha256 !== measuredJournal.actualCapacityReportSha256)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'virtual measured tupleがphase間で変化しました');
    }
    journalFiles.set(phase, candidate);
    previousWholeFileSha256 = candidate.sha256;
    previousPhaseIndex = phaseIndex;
  }
  if (virtualPhaseGap) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'virtual journal phaseが飛越しています');
  }
  if (!preparedJournal) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'prepared journal temp validationに失敗しました');
  }
  const transitionFile = virtual('transition-evidence.json');
  let transitionEvidence:
    PreparedF005WorkAcceptance['transitionEvidence'] | undefined;
  if (transitionFile) {
    const ref = preparedJournal.evidenceRefs.find(
      (item) => item.path === workspaceRelative(root, join(directory, 'transition-evidence.json')),
    );
    if (!ref || ref.sha256 !== transitionFile.sha256) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'virtual transition evidence SHA refが不正です');
    }
    const value = parseCanonicalTempJson(
      transitionFile,
      'transition evidence',
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    validateTransitionEvidenceValue(
      value,
      preparedJournal,
      transitionFile.text,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    transitionEvidence =
      value as PreparedF005WorkAcceptance['transitionEvidence'];
  }
  if (journalFiles.has('artifacts-committed') && !transitionEvidence) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'artifacts phaseにtransition evidenceがありません');
  }
  const actualPath = join(
    root,
    ...preparedJournal.actualCapacityReportPath.split('/'),
  );
  const actualRef = await exists(actualPath)
    ? await actualRefFromJournal(root, preparedJournal)
    : null;
  if (actualRef) {
    await verifyActualCapacityBinding(
      root,
      preparedJournal,
      actualRef,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
  }
  if (measuredJournal &&
    (!actualRef ||
      measuredJournal.actualCapacityReportSha256 !== actualRef.sha256 ||
      measuredJournal.capacityJournalSha256 !== actualRef.journalSha256)) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'measured phaseとactual/native full bindingが不正です');
  }
  const manifestNextFile = virtual('manifest-next.json');
  if (manifestNextFile) {
    if (!journalFiles.has('artifacts-committed') || !transitionEvidence) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', '先行phaseなしのmanifest-nextです');
    }
    await validateManifestNextTemp(
      root,
      preparedJournal,
      manifestNextFile,
      transitionEvidence,
    );
    if (measuredJournal?.nextManifestSha256 !== null &&
      measuredJournal?.nextManifestSha256 !== undefined &&
      measuredJournal.nextManifestSha256 !== manifestNextFile.sha256) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest-nextとmeasured SHAが一致しません');
    }
  }
  const manifestOldFile = targets.get('manifest-old.json');
  if (manifestOldFile) {
    const value = parseCanonicalTempJson(
      manifestOldFile,
      'manifest-old',
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    const checked = validateBatchManifest(value);
    if (!checked.ok || canonicalJson(checked.value) !== manifestOldFile.text ||
      manifestOldFile.sha256 !== preparedJournal.expectedManifestSha256) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest-old exact tupleが不正です');
    }
  }
  if (measuredJournal) {
    const manifestPath = join(root, ...preparedJournal.manifestPath.split('/'));
    const backupPath = join(root, ...preparedJournal.manifestBackupPath.split('/'));
    const liveSha256 = await fileSha(manifestPath);
    const backupSha256 = await fileSha(backupPath);
    const nextSha256 = manifestNextFile?.sha256 ?? null;
    const expectedSha256 = preparedJournal.expectedManifestSha256;
    const measuredNextSha256 = measuredJournal.nextManifestSha256!;
    const beforeCas = liveSha256 === expectedSha256 &&
      backupSha256 === null && nextSha256 === measuredNextSha256;
    const oldRenamed = liveSha256 === null &&
      backupSha256 === expectedSha256 && nextSha256 === measuredNextSha256;
    const nextLive = liveSha256 === measuredNextSha256 &&
      backupSha256 === expectedSha256 && nextSha256 === null;
    if (!beforeCas && !oldRenamed && !nextLive) {
      fail(
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        'capacity phaseのlive/backup/next状態が許可3状態外です',
      );
    }
    if (nextLive) {
      const liveBytes = await readSafeFile(
        root,
        preparedJournal.manifestPath,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      );
      const liveText = new TextDecoder('utf-8', { fatal: true }).decode(liveBytes);
      await validateManifestNextTemp(
        root,
        preparedJournal,
        {
          relativePath: preparedJournal.manifestPath,
          path: manifestPath,
          sha256: sha(liveBytes),
          bytes: liveBytes,
          text: liveText,
        },
        transitionEvidence,
      );
    }
  }
  const nativeIdentities = new Map<string, F005NativeFileIdentity>();
  for (const file of [...targets.values(), ...temporaries.values()]) {
    nativeIdentities.set(file.relativePath, file.nativeIdentity);
  }
  for (const relativePath of [
    preparedJournal.manifestPath,
    preparedJournal.manifestBackupPath,
    preparedJournal.actualCapacityReportPath,
    preparedJournal.capacityJournalPath,
    ...preparedJournal.entries.flatMap((entry) => [
      entry.path,
      entry.stagedPath,
      ...(entry.backupPath === null ? [] : [entry.backupPath]),
    ]),
  ]) {
    if (nativeIdentities.has(relativePath)) continue;
    const path = join(root, ...relativePath.split('/'));
    if (!await exists(path)) continue;
    const bytes = await readSafeFile(
      root,
      relativePath,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    nativeIdentities.set(
      relativePath,
      await snapshotNativeFileIdentity(
        root,
        relativePath,
        sha(bytes),
        bytes.byteLength,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      ),
    );
  }
  return { directory, nativeIdentities };
}

async function recoverTransactionDurableTemps(
  root: string,
  directory: string,
  plan: TransactionRecoveryPlan,
): Promise<void> {
  await recoverJournalDurableTemp(
    root,
    directory,
    'prepared',
    null,
    plan.nativeIdentities,
  );
  const prepared = await readJournalPhase(root, directory, 'prepared', null);
  if (!prepared) return;
  const paths = canonicalTransactionPaths(
    root,
    prepared.journal.workId,
    prepared.journal.recorderJournalId,
  );
  const transitionPath = join(root, ...paths.transitionEvidencePath.split('/'));
  await recoverCanonicalDurableTemp(
    root,
    transitionPath,
    (temporary) => {
      const ref = prepared.journal.evidenceRefs.find(
        (item) => item.path === paths.transitionEvidencePath,
      );
      if (!ref || ref.sha256 !== temporary.sha256) {
        fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'transition evidence temp SHA refが不正です');
      }
      const value = parseCanonicalTempJson(
        temporary,
        'transition evidence',
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      );
      validateTransitionEvidenceValue(
        value,
        prepared.journal,
        temporary.text,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      );
    },
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    plan.nativeIdentities,
  );
  await recoverJournalDurableTemp(
    root,
    directory,
    'artifacts-committed',
    prepared.wholeFileSha256,
    plan.nativeIdentities,
  );
  const committed = await readJournalPhase(
    root,
    directory,
    'artifacts-committed',
    prepared.wholeFileSha256,
  );
  if (!committed) {
    if (await findCanonicalDurableTemp(
      root,
      join(directory, 'manifest-next.json'),
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    ) || await findCanonicalDurableTemp(
      root,
      join(directory, 'capacity-measured.json'),
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    )) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', '先行journalなしの後続canonical tempです');
    }
    return;
  }
  if (immutableJournalTuple(committed.journal) !==
    immutableJournalTuple(prepared.journal)) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'artifacts journal immutable tupleが不正です');
  }
  const manifestNextPath = join(directory, 'manifest-next.json');
  await recoverCanonicalDurableTemp(
    root,
    manifestNextPath,
    (temporary) => validateManifestNextTemp(root, committed.journal, temporary),
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    plan.nativeIdentities,
  );
  await recoverJournalDurableTemp(
    root,
    directory,
    'capacity-measured',
    committed.wholeFileSha256,
    plan.nativeIdentities,
  );
  const measured = await readJournalPhase(
    root,
    directory,
    'capacity-measured',
    committed.wholeFileSha256,
  );
  if (!measured) return;
  await recoverJournalDurableTemp(
    root,
    directory,
    'manifest-committed',
    measured.wholeFileSha256,
    plan.nativeIdentities,
  );
  const manifestCommitted = await readJournalPhase(
    root,
    directory,
    'manifest-committed',
    measured.wholeFileSha256,
  );
  if (!manifestCommitted) return;
  await recoverJournalDurableTemp(
    root,
    directory,
    'closed',
    manifestCommitted.wholeFileSha256,
    plan.nativeIdentities,
  );
}

async function verifyPromotedArtifactStates(
  root: string,
  journal: WorkAcceptanceJournalV3,
): Promise<void> {
  for (const entry of journal.entries) {
    if (await fileSha(join(root, ...entry.path.split('/'))) !== entry.newSha256 ||
      await fileSha(join(root, ...entry.stagedPath.split('/'))) !== null ||
      (entry.backupPath !== null &&
        await fileSha(join(root, ...entry.backupPath.split('/'))) !== entry.oldSha256)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'promoted artifact/backup実体が不正です');
    }
  }
}

async function rollbackPromotedArtifacts(
  root: string,
  directory: string,
  journal: WorkAcceptanceJournalV3,
  plan: TransactionRecoveryPlan,
): Promise<void> {
  if (hashBatchManifest(await readManifest(root)) !== journal.expectedManifestSha256 ||
    await exists(join(root, ...journal.manifestBackupPath.split('/'))) ||
    await exists(join(root, ...journal.manifestNextPath.split('/')))) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'rollback対象manifest tupleが不正です');
  }
  for (const entry of [...journal.entries].reverse()) {
    const target = join(root, ...entry.path.split('/'));
    const staged = join(root, ...entry.stagedPath.split('/'));
    const targetSha = await fileSha(target);
    const stagedSha = await fileSha(staged);
    if (targetSha === entry.newSha256 && stagedSha === null) {
      await mkdir(dirname(staged), { recursive: true });
      await syncDirectory(root, dirname(dirname(staged)), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
      await syncDirectory(root, dirname(staged), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
      await nativeRenameTargetAbsent(
        root,
        entry.path,
        entry.stagedPath,
        entry.newSha256,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        requirePlannedNativeIdentity(plan, entry.path),
      );
      await syncDirectory(root, dirname(target), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
      await syncDirectory(root, dirname(staged), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
    } else if (targetSha !== null || stagedSha !== entry.newSha256) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', '第三者変更のためrollbackできません');
    }
  }
  for (const name of [
    'artifacts-committed.json',
    'prepared.json',
    'transition-evidence.json',
  ]) {
    const path = join(directory, name);
    const expectedSha256 = await fileSha(path);
    if (expectedSha256 !== null) {
      await nativeDeleteExact(
        root,
        workspaceRelative(root, path),
        expectedSha256,
        'F005_ACCEPTANCE_RECOVERY_CONFLICT',
        requirePlannedNativeIdentity(plan, workspaceRelative(root, path)),
      );
    }
  }
  await syncDirectory(root, directory, 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
  try {
    await rmdir(directory);
    await syncDirectory(root, dirname(directory), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
    if (await exists(directory)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'rollback directory削除後も実体が残っています');
    }
  } catch (error) {
    return fail(
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      '未知fileを削除せずtransaction directoryを保持しました',
      error,
    );
  }
}

async function rollForwardManifestMetadata(
  root: string,
  directory: string,
  chain: readonly {
    phase: AcceptanceJournalPhase;
    journal: WorkAcceptanceJournalV3;
    text: string;
    wholeFileSha256: Sha256;
  }[],
  plan: TransactionRecoveryPlan,
): Promise<void> {
  const capacity = chain.find((item) => item.phase === 'capacity-measured');
  if (!capacity) fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'capacity phaseがありません');
  const journal = capacity.journal;
  const actualRef = await actualRefFromJournal(root, journal);
  if (!actualRef) fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'actual容量実体がありません');
  await verifyActualCapacityBinding(
    root,
    journal,
    actualRef,
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
  );
  if (journal.actualCapacityReportSha256 !== actualRef.sha256 ||
    journal.capacityJournalSha256 !== actualRef.journalSha256) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'capacity phaseとactual/native SHAが一致しません');
  }
  await verifyJournalEvidenceRefs(root, journal);
  await verifyPromotedArtifactStates(root, journal);
  const manifestPath = join(root, ...journal.manifestPath.split('/'));
  const backupPath = join(root, ...journal.manifestBackupPath.split('/'));
  const nextPath = join(root, ...journal.manifestNextPath.split('/'));
  const manifestSha = await fileSha(manifestPath);
  const backupSha = await fileSha(backupPath);
  const nextSha = await fileSha(nextPath);
  if (manifestSha === journal.expectedManifestSha256 &&
    backupSha === null && nextSha === journal.nextManifestSha256) {
    await nativeRenameTargetAbsent(
      root,
      journal.manifestPath,
      journal.manifestBackupPath,
      journal.expectedManifestSha256,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      requirePlannedNativeIdentity(plan, journal.manifestPath),
    );
    await nativeRenameTargetAbsent(
      root,
      journal.manifestNextPath,
      journal.manifestPath,
      journal.nextManifestSha256!,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      requirePlannedNativeIdentity(plan, journal.manifestNextPath),
    );
    await syncDirectory(root, dirname(manifestPath), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
    await syncDirectory(root, dirname(nextPath), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
  } else if (manifestSha === null &&
    backupSha === journal.expectedManifestSha256 &&
    nextSha === journal.nextManifestSha256) {
    await nativeRenameTargetAbsent(
      root,
      journal.manifestNextPath,
      journal.manifestPath,
      journal.nextManifestSha256!,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
      requirePlannedNativeIdentity(plan, journal.manifestNextPath),
    );
    await syncDirectory(root, dirname(manifestPath), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
    await syncDirectory(root, dirname(nextPath), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
  } else if (!(manifestSha === journal.nextManifestSha256 &&
    backupSha === journal.expectedManifestSha256 &&
    nextSha === null)) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifest old/new/backup tuple外です');
  }
  const post = await readManifest(root);
  if (hashBatchManifest(post) !== journal.nextManifestSha256 ||
    post.workProgress.find((item) => item.workId === journal.workId)?.status !== 'accepted' ||
    await fileSha(backupPath) !== journal.expectedManifestSha256) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'roll-forward post-readが不正です');
  }
  const manifestCommitted = chain.find((item) => item.phase === 'manifest-committed');
  let previousWholeFileSha256: Sha256;
  if (!manifestCommitted) {
    const phase = sealJournalPhase(
      journalPhaseBase(journal),
      'manifest-committed',
      capacity.wholeFileSha256,
    );
    const text = canonicalJson(phase);
    await writeDurableExclusive(
      root,
      join(directory, 'manifest-committed.json'),
      text,
      undefined,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    previousWholeFileSha256 = sha(text);
  } else {
    previousWholeFileSha256 = manifestCommitted.wholeFileSha256;
  }
  if (!chain.some((item) => item.phase === 'closed')) {
    const closed = sealJournalPhase(
      journalPhaseBase(journal),
      'closed',
      previousWholeFileSha256,
    );
    await writeDurableExclusive(
      root,
      join(directory, 'closed.json'),
      canonicalJson(closed),
      undefined,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
  }
}

async function recoverStrictF005WorkAcceptance(workspace: string): Promise<F005RecoveryResult> {
  const root = await verifiedWorkspace(workspace);
  const journalRoot = join(root, '.cache', 'transactions', 'f005-promote');
  if (!await exists(journalRoot)) {
    const recoveryTrashPlan = await preScanF005RecoveryTrash(
      root,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    await cleanupF005RecoveryTrash(
      root,
      recoveryTrashPlan,
      'F005_ACCEPTANCE_RECOVERY_CONFLICT',
    );
    return freezeDeep({ result: 'no-op' as const, recoveredWorkIds: [], journalCount: 0 });
  }
  const rootInfo = await lstat(journalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
    await realpath(journalRoot) !== journalRoot) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'promotion journal rootが不正です');
  }
  const directoryEntries = (await readdir(journalRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const transactionPlans = new Map<string, TransactionRecoveryPlan>();
  for (const entry of directoryEntries) {
    const matched = /^(000799|001076|001104)-([0-9a-f]{64})$/u.exec(entry.name);
    if (!matched || !entry.isDirectory() || entry.isSymbolicLink()) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `未知promotion journalがあります: ${entry.name}`);
    }
    const directory = join(journalRoot, entry.name);
    if (await realpath(directory) !== directory) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'promotion journal directoryがcanonicalではありません');
    }
    if ((await readdir(directory)).length > 0) {
      transactionPlans.set(
        directory,
        await preScanTransactionRecovery(root, directory),
      );
    }
  }
  const recoveryTrashPlan = await preScanF005RecoveryTrash(
    root,
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
  );
  await cleanupF005RecoveryTrash(
    root,
    recoveryTrashPlan,
    'F005_ACCEPTANCE_RECOVERY_CONFLICT',
  );
  const recovered: WorkId[] = [];
  let rolledBack = false;
  for (const entry of directoryEntries) {
    const matched = /^(000799|001076|001104)-([0-9a-f]{64})$/u.exec(entry.name);
    if (!matched || !entry.isDirectory() || entry.isSymbolicLink()) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', `未知promotion journalがあります: ${entry.name}`);
    }
    const directory = join(journalRoot, entry.name);
    if (await realpath(directory) !== directory) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'promotion journal directoryがcanonicalではありません');
    }
    let bootstrapEntries = await readdir(directory, { withFileTypes: true });
    if (bootstrapEntries.length === 0) {
      await rmdir(directory);
      await syncDirectory(root, journalRoot, 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
      if (await exists(directory)) {
        fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'bootstrap directory削除後も実体が残っています');
      }
      rolledBack = true;
      recovered.push(matched[1] as WorkId);
      continue;
    }
    const transactionPlan = transactionPlans.get(directory);
    if (!transactionPlan) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'transaction pre-scan planがありません');
    }
    await recoverTransactionDurableTemps(root, directory, transactionPlan);
    bootstrapEntries = await readdir(directory, { withFileTypes: true });
    if (bootstrapEntries.length === 0) {
      await rmdir(directory);
      await syncDirectory(root, journalRoot, 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
      if (await exists(directory)) {
        fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'bootstrap directory削除後も実体が残っています');
      }
      rolledBack = true;
      recovered.push(matched[1] as WorkId);
      continue;
    }
    const chain = await readStrictJournalChain(root, directory);
    const prepared = chain[0]!.journal;
    if (prepared.workId !== matched[1] || prepared.recorderJournalId !== matched[2]) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'directory名とjournal tupleが一致しません');
    }
    const capacity = chain.find((item) => item.phase === 'capacity-measured');
    if (!capacity) {
      const actualRef = await actualRefFromJournal(root, prepared);
      if (actualRef && chain.some((item) => item.phase === 'artifacts-committed')) {
        const transitionEvidence = await readTransitionEvidence(root, prepared);
        const nextPath = join(root, ...prepared.manifestNextPath.split('/'));
        let recoveredAcceptedAt: string | undefined;
        if (await exists(nextPath)) {
          await syncDirectory(root, dirname(nextPath), 'F005_ACCEPTANCE_RECOVERY_CONFLICT');
          const nextBytes = await readSafeFile(
            root,
            prepared.manifestNextPath,
            'F005_ACCEPTANCE_RECOVERY_CONFLICT',
          );
          const nextText = new TextDecoder('utf-8', { fatal: true }).decode(nextBytes);
          let nextValue: unknown;
          try {
            nextValue = JSON.parse(nextText);
          } catch (error) {
            return fail(
              'F005_ACCEPTANCE_RECOVERY_CONFLICT',
              'manifest-next JSONが不正です',
              error,
            );
          }
          const checked = validateBatchManifest(nextValue);
          const acceptedWork = checked.ok
            ? checked.value.workProgress.find((work) => work.workId === prepared.workId)
            : undefined;
          const acceptedRecord = acceptedWork?.stageRecords.at(-1);
          if (!checked.ok || canonicalJson(checked.value) !== nextText ||
            acceptedWork?.status !== 'accepted' ||
            acceptedWork.acceptedBy !== prepared.owner ||
            typeof acceptedWork.acceptedAt !== 'string' ||
            !Number.isFinite(Date.parse(acceptedWork.acceptedAt)) ||
            !acceptedRecord?.inputHashes.includes(actualRef.sha256)) {
            fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', '既存manifest-next acceptance tupleが不正です');
          }
          recoveredAcceptedAt = acceptedWork.acceptedAt;
        }
        const payload = {
          workId: prepared.workId,
          expectedManifestSha: prepared.expectedManifestSha256,
          recorderJournalId: prepared.recorderJournalId,
          recorderOwner: prepared.owner,
          preparedSha256: sha(canonicalJson(transitionEvidence)),
          candidateSha256: prepared.candidateSha256,
          transitionEvidence,
          journalPath:
            canonicalTransactionPaths(root, prepared.workId, prepared.recorderJournalId)
              .journalDirectory,
        };
        await finalizeF005WorkAcceptance(
          root,
          {
            __brand: 'PromotedF005WorkAcceptance',
            ...payload,
            promotionSha256: sha(canonicalJson(payload)),
          },
          actualRef,
          prepared.expectedManifestSha256,
          recoveredAcceptedAt === undefined
            ? { recoveryNativeIdentities: transactionPlan.nativeIdentities }
            : {
                now: () => recoveredAcceptedAt!,
                recoveryNativeIdentities: transactionPlan.nativeIdentities,
              },
        );
        recovered.push(prepared.workId);
        continue;
      }
      await rollbackPromotedArtifacts(root, directory, prepared, transactionPlan);
      rolledBack = true;
      recovered.push(prepared.workId);
      continue;
    }
    const lock = await acquireFinalizeLock(root, prepared.workId, prepared.recorderJournalId);
    try {
      await rollForwardManifestMetadata(root, directory, chain, transactionPlan);
    } finally {
      await releaseFinalizeLock(lock);
    }
    recovered.push(prepared.workId);
  }
  return freezeDeep({
    result: rolledBack
      ? 'rolled-back' as const
      : recovered.length > 0 ? 'completed' as const : 'no-op' as const,
    recoveredWorkIds: recovered,
    journalCount: directoryEntries.length,
  });
}
