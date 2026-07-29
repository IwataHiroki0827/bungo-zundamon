import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
import { isMintedF005NativeCapacityBackend } from './f005-native-guard.ts';
import type { V040Baseline } from './f005-foundation.ts';

const WORK_IDS = ['000799', '001076', '001104'] as const;
const MANIFEST_PATH = 'content/batches/F005/batch.json';
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*[\\:\0])[\p{L}\p{N}._/-]+$/u;
const PREVIEW_ARTIFACT_KINDS = [
  'content-build',
  'content-staging',
  'dist',
  'actual-capacity-report',
  'f001-content-invariant-report',
  'f001-dist-invariant-report',
] as const;
const EVIDENCE_KINDS = ['source', 'review', 'audio', 'license', 'notice', 'artwork'] as const;
const previews = new WeakSet<object>();
const preparedValues = new WeakSet<object>();
const recorders = new WeakSet<object>();

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
    const info = await lstat(target);
    if (!info.isFile() || await realpath(target) !== target) {
      fail(code, 'canonical regular fileではありません');
    }
    return new Uint8Array(await readFile(target));
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
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'recorder identity/backendが不正です');
  }
  const observeMutation = async (notice: F005AcceptanceMutationNotice): Promise<void> => {
    const observation = await backend.observeMutation(notice);
    exactDataObject(observation, ['noticeId', 'sessionNonce', 'sequence', 'workerPid', 'matchedEtw'],
      'F005_ACCEPTANCE_TRANSACTION_INVALID', 'ETW observation');
    if (observation.noticeId !== notice.noticeId || observation.sessionNonce !== identity.sessionNonce ||
      observation.sequence !== notice.sequence || observation.workerPid !== identity.workerPid ||
      observation.matchedEtw !== true) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'noticeと認証済みETW観測が一致しません');
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
  readonly actualCapacityReport: F005ArtifactRef<'actual-capacity-report'>;
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
    ['actual-capacity-report', artifacts.actualCapacityReport],
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
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'mint済みcapacity recorderが必要です');
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
    'actualCapacityReport', 'f001ContentInvariantReport', 'f001DistInvariantReport',
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
    actualCapacityReport: verifiedArtifactRefs[3] as F005ArtifactRef<'actual-capacity-report'>,
    f001ContentInvariantReport:
      verifiedArtifactRefs[4] as F005ArtifactRef<'f001-content-invariant-report'>,
    f001DistInvariantReport:
      verifiedArtifactRefs[5] as F005ArtifactRef<'f001-dist-invariant-report'>,
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
  readonly transitionEvidence: Omit<PreparedWorkAcceptanceEvidence, 'acceptedAt' | 'acceptedBy'>;
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
  const transitionEvidence: Omit<PreparedWorkAcceptanceEvidence, 'acceptedAt' | 'acceptedBy'> = freezeDeep({
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
    actualCapacityReportSha: preview.artifacts.actualCapacityReport.sha256,
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

type AcceptanceJournalPhase = 'prepared' | 'artifacts-committed' | 'manifest-committed' | 'closed';

interface F005LogicalAcceptanceJournal {
  readonly schemaVersion: 1;
  readonly phase: AcceptanceJournalPhase;
  readonly owner: string;
  readonly recorderJournalId: Sha256;
  readonly phaseInstanceId: Sha256;
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly nextManifestSha: Sha256;
  readonly manifestBackupPath: string;
  readonly manifestNextPath: string;
  readonly operations: PreparedF005WorkAcceptance['operations'];
  readonly journalSha256: Sha256;
}

type F005LogicalAcceptanceJournalBase =
  Omit<F005LogicalAcceptanceJournal, 'schemaVersion' | 'phase' | 'journalSha256'>;

function journalCore(value: Omit<F005LogicalAcceptanceJournal, 'journalSha256'>): Omit<F005LogicalAcceptanceJournal, 'journalSha256'> {
  return value;
}

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
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'transaction pathがregular fileではありません');
  }
  return sha(new Uint8Array(await readFile(path)));
}

async function ensureDirectoryNoticed(
  root: string,
  directory: string,
  notice: ReturnType<typeof notifier>,
): Promise<void> {
  if (!isInside(root, directory)) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'directoryがworkspace外です');
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
    await notice('create', path, null, 0, null);
  }
}

async function writeJournalPhase(
  directory: string,
  phase: AcceptanceJournalPhase,
  base: F005LogicalAcceptanceJournalBase,
  notice: ReturnType<typeof notifier>,
): Promise<void> {
  const core = journalCore({ schemaVersion: 1, phase, ...base });
  const value = freezeDeep({ ...core, journalSha256: sha(canonicalJson(core)) });
  const path = join(directory, `${phase}.json`);
  const bytes = canonicalJson(value);
  await writeFile(path, bytes, { flag: 'wx' });
  await notice('create', path, null, Buffer.byteLength(bytes), sha(bytes));
}

export interface F005AcceptOptions {
  readonly now?: () => string;
  readonly afterPhase?: (phase: AcceptanceJournalPhase) => void | Promise<void>;
}

/**
 * staged filesとmanifestをlogical transactionで昇格し、post-read後だけphaseを閉じる。
 * @des DES-F005-006 @fun FUN-F005-022 @ut UT-F005-022
 */
export async function acceptF005Work(
  workspace: string,
  prepared: PreparedF005WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  capacityRecorder: F005AcceptanceCapacityRecorder,
  options: F005AcceptOptions = {},
): Promise<BatchManifest> {
  const root = await verifiedWorkspace(workspace);
  assertRecorder(capacityRecorder);
  if (!preparedValues.has(prepared) || prepared.__brand !== 'PreparedF005WorkAcceptance' ||
    prepared.expectedManifestSha !== expectedManifestSha ||
    prepared.recorderJournalId !== capacityRecorder.journalId ||
    prepared.recorderOwner !== capacityRecorder.owner ||
    prepared.preparedSha256 !== sha(canonicalJson({
      workId: prepared.workId,
      expectedManifestSha: prepared.expectedManifestSha,
      contextSha256: prepared.contextSha256,
      previewSha256: prepared.previewSha256,
      recorderJournalId: prepared.recorderJournalId,
      recorderOwner: prepared.recorderOwner,
      previewArtifacts: prepared.previewArtifacts,
      evidenceRefs: prepared.evidenceRefs,
      operations: prepared.operations,
      transitionEvidence: prepared.transitionEvidence,
    }))) {
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
  const acceptedAt = options.now?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(acceptedAt))) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'acceptedAtが不正です');
  const evidence: PreparedWorkAcceptanceEvidence = freezeDeep({
    ...prepared.transitionEvidence,
    acceptedAt,
    acceptedBy: capacityRecorder.owner,
  });
  let next: BatchManifest;
  try {
    next = transitionWorkState(manifest, prepared.workId, 'accepted', evidence);
  } catch (error) {
    return fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'accepted transitionを構築できません', error);
  }
  const nextManifestSha = hashBatchManifest(next);
  const phaseInstanceId = sha(`${prepared.preparedSha256}\0${nextManifestSha}\0accept`);
  const transactionDirectory = join(root, '.cache', 'transactions', 'f005-accept',
    `${prepared.workId}-${capacityRecorder.journalId}`);
  const backup = join(transactionDirectory, 'manifest-old.json');
  const manifestNext = join(transactionDirectory, 'manifest-next.json');
  const manifestPath = join(root, ...MANIFEST_PATH.split('/'));
  const notice = notifier(capacityRecorder, 'accept', phaseInstanceId);
  const journalBase = {
    owner: capacityRecorder.owner,
    recorderJournalId: capacityRecorder.journalId,
    phaseInstanceId,
    workId: prepared.workId,
    expectedManifestSha: prepared.expectedManifestSha,
    nextManifestSha,
    manifestBackupPath: relative(root, backup).replace(/\\/gu, '/'),
    manifestNextPath: relative(root, manifestNext).replace(/\\/gu, '/'),
    operations: prepared.operations,
  };
  await capacityRecorder.beginPhase('accept', prepared.workId, phaseInstanceId);
  try {
    await ensureDirectoryNoticed(root, transactionDirectory, notice);
    await writeJournalPhase(transactionDirectory, 'prepared', journalBase, notice);
    await options.afterPhase?.('prepared');
    for (const operation of prepared.operations) {
      const target = join(root, ...operation.targetPath.split('/'));
      if (!isInside(root, target)) fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'promotion targetがworkspace外です');
      await ensureDirectoryNoticed(root, dirname(target), notice);
      const sourceDigest = await fileSha(operation.sourcePath);
      const targetDigest = await fileSha(target);
      if (sourceDigest !== operation.sha256 || targetDigest !== null) {
        fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'source/targetがprepared tupleと一致しません');
      }
      await rename(operation.sourcePath, target);
      await notice('rename', operation.sourcePath, target, operation.bytes, operation.sha256);
    }
    await writeJournalPhase(transactionDirectory, 'artifacts-committed', journalBase, notice);
    await options.afterPhase?.('artifacts-committed');
    const nextBytes = canonicalJson(next);
    await writeFile(manifestNext, nextBytes, { flag: 'wx' });
    await notice('create', manifestNext, null, Buffer.byteLength(nextBytes), sha(nextBytes));
    await rename(manifestPath, backup);
    await notice('rename', manifestPath, backup, Buffer.byteLength(canonicalJson(manifest)), expectedManifestSha as Sha256);
    await rename(manifestNext, manifestPath);
    await notice('rename', manifestNext, manifestPath, Buffer.byteLength(nextBytes), nextManifestSha);
    await writeJournalPhase(transactionDirectory, 'manifest-committed', journalBase, notice);
    await options.afterPhase?.('manifest-committed');
    const postManifest = await readManifest(root);
    if (hashBatchManifest(postManifest) !== nextManifestSha) {
      fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'manifest post-readが一致しません');
    }
    for (const operation of prepared.operations) {
      if (await fileSha(join(root, ...operation.targetPath.split('/'))) !== operation.sha256) {
        fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'artifact post-readが一致しません');
      }
    }
    await writeJournalPhase(transactionDirectory, 'closed', journalBase, notice);
    await options.afterPhase?.('closed');
    await capacityRecorder.endPhase('accept', phaseInstanceId);
    return postManifest;
  } catch (error) {
    if (error instanceof F005AcceptanceError) throw error;
    return fail('F005_ACCEPTANCE_TRANSACTION_INVALID', 'accept transactionはpending journalを残して停止しました', error);
  }
}

export interface F005RecoveryResult {
  readonly result: 'no-op' | 'rolled-back' | 'completed';
  readonly recoveredWorkIds: readonly WorkId[];
  readonly journalCount: number;
}

function parseJournal(bytes: Uint8Array, expectedPhase: AcceptanceJournalPhase): F005LogicalAcceptanceJournal {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal JSONが不正です', error);
  }
  exactDataObject(value, [
    'schemaVersion', 'phase', 'owner', 'recorderJournalId', 'phaseInstanceId', 'workId',
    'expectedManifestSha', 'nextManifestSha', 'manifestBackupPath', 'manifestNextPath',
    'operations', 'journalSha256',
  ], 'F005_ACCEPTANCE_RECOVERY_CONFLICT', 'acceptance journal');
  const journal = value as unknown as F005LogicalAcceptanceJournal;
  const { journalSha256, ...core } = journal;
  if (journal.schemaVersion !== 1 || journal.phase !== expectedPhase || !journal.owner.trim() ||
    !SHA256.test(journal.recorderJournalId) || !SHA256.test(journal.phaseInstanceId) ||
    !WORK_IDS.includes(journal.workId as typeof WORK_IDS[number]) ||
    !SHA256.test(journal.expectedManifestSha) || !SHA256.test(journal.nextManifestSha) ||
    journalSha256 !== sha(canonicalJson(core)) || canonicalJson(journal) !== text ||
    !Array.isArray(journal.operations) || journal.operations.length === 0) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal seal/tupleが不正です');
  }
  return journal;
}

function journalBinding(journal: F005LogicalAcceptanceJournal): unknown {
  return {
    schemaVersion: journal.schemaVersion,
    owner: journal.owner,
    recorderJournalId: journal.recorderJournalId,
    phaseInstanceId: journal.phaseInstanceId,
    workId: journal.workId,
    expectedManifestSha: journal.expectedManifestSha,
    nextManifestSha: journal.nextManifestSha,
    manifestBackupPath: journal.manifestBackupPath,
    manifestNextPath: journal.manifestNextPath,
    operations: journal.operations,
  };
}

/**
 * trusted journal rootを内部列挙し、第三者値を上書きせず旧版または完成新版へ収束する。
 * @des DES-F005-006 @fun FUN-F005-023 @ut UT-F005-023
 */
export async function recoverF005WorkAcceptance(workspace: string): Promise<F005RecoveryResult> {
  const root = await verifiedWorkspace(workspace);
  const journalRoot = join(root, '.cache', 'transactions', 'f005-accept');
  if (!await exists(journalRoot)) return freezeDeep({ result: 'no-op' as const, recoveredWorkIds: [], journalCount: 0 });
  const rootInfo = await lstat(journalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'trusted journal rootが不正です');
  }
  const directories = (await readdir(journalRoot, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const recovered: WorkId[] = [];
  let rolledBack = false;
  for (const entry of directories) {
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
      !/^(000799|001076|001104)-[0-9a-f]{64}$/u.test(entry.name)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', '未知journal entryがあります');
    }
    const directory = join(journalRoot, entry.name);
    const phaseOrder: AcceptanceJournalPhase[] =
      ['prepared', 'artifacts-committed', 'manifest-committed', 'closed'];
    const present: AcceptanceJournalPhase[] = [];
    let journal: F005LogicalAcceptanceJournal | null = null;
    for (const phase of phaseOrder) {
      const path = join(directory, `${phase}.json`);
      if (!await exists(path)) continue;
      const parsed = parseJournal(new Uint8Array(await readFile(path)), phase);
      if (journal && canonicalJson(journalBinding(journal)) !== canonicalJson(journalBinding(parsed))) {
        fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal phase間tupleが一致しません');
      }
      journal = parsed;
      present.push(phase);
    }
    if (!journal || present[0] !== 'prepared' ||
      present.some((phase, index) => phase !== phaseOrder[index])) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal phaseが欠落または順序違反です');
    }
    const expectedDirectoryName = `${journal.workId}-${journal.recorderJournalId}`;
    const expectedBackup = `${relative(root, directory).replace(/\\/gu, '/')}/manifest-old.json`;
    const expectedNext = `${relative(root, directory).replace(/\\/gu, '/')}/manifest-next.json`;
    const operationTargets = new Set<string>();
    if (entry.name !== expectedDirectoryName || journal.manifestBackupPath !== expectedBackup ||
      journal.manifestNextPath !== expectedNext) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal path/owner tupleがtrusted rootと一致しません');
    }
    for (const [index, operation] of journal.operations.entries()) {
      exactDataObject(operation, ['sourcePath', 'targetPath', 'sha256', 'bytes', 'configHash'],
        'F005_ACCEPTANCE_RECOVERY_CONFLICT', `journal.operations[${index}]`);
      const targetPrefix = `content/batches/F005/accepted-audio/${journal.workId}/`;
      if (!isAbsolute(operation.sourcePath) || !isInside(root, operation.sourcePath) ||
        !SAFE_PATH.test(operation.targetPath) || !operation.targetPath.startsWith(targetPrefix) ||
        !SHA256.test(operation.sha256) || !SHA256.test(operation.configHash) ||
        !Number.isSafeInteger(operation.bytes) || operation.bytes <= 44 ||
        operationTargets.has(operation.targetPath)) {
        fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'journal operationがunsafeまたは重複です');
      }
      operationTargets.add(operation.targetPath);
    }
    const manifestPath = join(root, ...MANIFEST_PATH.split('/'));
    const backup = join(root, ...journal.manifestBackupPath.split('/'));
    const manifestNext = join(root, ...journal.manifestNextPath.split('/'));
    const manifestDigest = await fileSha(manifestPath);
    const backupDigest = await fileSha(backup);
    const manifestNextDigest = await fileSha(manifestNext);
    const targetStates = await Promise.all(journal.operations.map(async (operation) => ({
      operation,
      source: await fileSha(operation.sourcePath),
      target: await fileSha(join(root, ...operation.targetPath.split('/'))),
    })));
    if (targetStates.some(({ operation, source, target }) =>
      ![null, operation.sha256].includes(source) || ![null, operation.sha256].includes(target) ||
      source === operation.sha256 && target === operation.sha256)) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', '第三者変更または複製artifactを検出しました');
    }
    const allNew = targetStates.every(({ operation, source, target }) => source === null && target === operation.sha256);
    if (present.includes('closed')) {
      if (manifestDigest !== journal.nextManifestSha || backupDigest !== journal.expectedManifestSha ||
        manifestNextDigest !== null || !allNew) {
        fail(
          'F005_ACCEPTANCE_RECOVERY_CONFLICT',
          'closed journalのmanifest/backup/target実SHAが完成新版tupleと一致しません',
        );
      }
      const completedManifest = await readManifest(root);
      const completedWork = completedManifest.workProgress
        .find((work) => work.workId === journal.workId);
      if (hashBatchManifest(completedManifest) !== journal.nextManifestSha ||
        completedWork?.status !== 'accepted') {
        fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'closed journalのcompleted manifestが不正です');
      }
      recovered.push(journal.workId);
      continue;
    }
    if (manifestDigest === journal.nextManifestSha && allNew) {
      recovered.push(journal.workId);
      continue;
    }
    const manifestCanRollback = manifestDigest === journal.expectedManifestSha ||
      manifestDigest === null && backupDigest === journal.expectedManifestSha;
    if (!manifestCanRollback ||
      backupDigest !== null && backupDigest !== journal.expectedManifestSha ||
      manifestNextDigest !== null && manifestNextDigest !== journal.nextManifestSha ||
      manifestDigest === journal.expectedManifestSha && backupDigest !== null) {
      fail('F005_ACCEPTANCE_RECOVERY_CONFLICT', 'manifestが旧版/完成新版のどちらにも一致しません');
    }
    if (manifestDigest === null && backupDigest === journal.expectedManifestSha) {
      await rename(backup, manifestPath);
    }
    for (const { operation, source, target } of targetStates.reverse()) {
      if (source === null && target === operation.sha256) {
        await rename(join(root, ...operation.targetPath.split('/')), operation.sourcePath);
      }
    }
    await rm(directory, { recursive: true, force: false });
    rolledBack = true;
    recovered.push(journal.workId);
  }
  return freezeDeep({
    result: rolledBack ? 'rolled-back' as const : recovered.length > 0 ? 'completed' as const : 'no-op' as const,
    recoveredWorkIds: recovered,
    journalCount: directories.length,
  });
}
