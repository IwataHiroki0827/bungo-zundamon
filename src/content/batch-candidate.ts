import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import {
  type BatchApprovalGateRefs,
  type BatchAuthor,
  type BatchId,
  type BatchManifest,
  createNextBatchTemplate,
  type Sha256,
  type WorkspaceRelativePath,
} from './batch.ts';
import {
  canonicalJson,
  fingerprintArtifact,
  writeJsonArtifactAtomic,
} from './artifacts.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const BATCH_ID = /^F\d{3}$/u;
const AUTHOR_ID = /^\d{6}$/u;
const WORK_ID = /^\d{6}$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))[A-Za-z0-9._/-]+$/u;
const APPROVAL_PROJECTION_FIELDS = [
  'id',
  'type',
  'status',
  'target',
  'target_mode',
  'answer',
  'approved_at',
] as const;

type CandidateFailureCode =
  | 'CANDIDATE_REGISTRY_INVALID'
  | 'CANDIDATE_DUPLICATE'
  | 'CANDIDATE_PATH_UNSAFE'
  | 'CANDIDATE_APPROVAL_INVALID'
  | 'CANDIDATE_APPROVAL_CONFLICT';

export class BatchCandidateError extends Error {
  constructor(
    public readonly code: CandidateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'BatchCandidateError';
  }
}

export interface BatchCandidateRegistryWork {
  readonly workId: string;
  readonly title: string;
  readonly order: number;
  readonly cardUrl: string;
  readonly xhtmlUrl: string;
}

export interface ApprovalBindingDocument {
  readonly path: WorkspaceRelativePath;
  readonly sha256: Sha256;
}

export interface CandidateApprovalBinding {
  readonly queueId: string;
  readonly approvalItemSha256: Sha256;
  readonly documents: readonly ApprovalBindingDocument[];
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
}

export interface ApprovedBatchCandidateDefinition {
  readonly batchId: string;
  readonly feature: string;
  readonly author: BatchAuthor;
  readonly works: readonly BatchCandidateRegistryWork[];
  readonly approvalBinding: CandidateApprovalBinding;
}

export interface BatchCandidateRegistry {
  readonly schemaVersion: '1.0.0';
  readonly candidates: readonly ApprovedBatchCandidateDefinition[];
}

export interface VerifiedClosedApproval {
  readonly __brand: 'VerifiedClosedApproval';
  readonly queueId: string;
  readonly queueSha256: Sha256;
  readonly approvalItemSha256: Sha256;
  readonly feature: string;
  readonly target: WorkspaceRelativePath;
  readonly documents: readonly ApprovalBindingDocument[];
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
}

export type CandidateValidationResult =
  | { readonly ok: true; readonly value: BatchCandidateRegistry }
  | { readonly ok: false; readonly code: CandidateFailureCode; readonly message: string };

export interface BindingEvidenceLocator {
  readonly path: WorkspaceRelativePath;
  readonly sha256: Sha256;
}

interface ApprovalBindingEvidence {
  readonly schemaVersion: '1.0.0';
  readonly feature: string;
  readonly queueId: string;
  readonly queuePath: 'queue.yaml';
  readonly queueSha256AtMigration: Sha256;
  readonly approvalProjectionFields: readonly string[];
  readonly approvalItemSha256: Sha256;
  readonly documents: readonly ApprovalBindingDocument[];
  readonly changes: readonly {
    readonly id: string;
    readonly level: string;
    readonly status: string;
  }[];
  readonly migratedAt: string;
}

function hash(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
}

function isSha(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256.test(value);
}

function isSafePath(value: unknown): value is WorkspaceRelativePath {
  return typeof value === 'string' && SAFE_PATH.test(value) &&
    value.split('/').every((component) => component !== '' && component !== '.' && component !== '..');
}

function canonicalHttps(value: unknown, kind: 'card' | 'xhtml'): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.aozora.gr.jp' || url.port ||
      url.username || url.password || url.search || url.hash) return false;
    return kind === 'card'
      ? /^\/cards\/\d{6}\/card\d+\.html$/u.test(url.pathname)
      : /^\/cards\/\d{6}\/files\/[A-Za-z0-9_-]+\.html$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function authorIdentity(author: Omit<BatchAuthor, 'identitySha256'>): Sha256 {
  return hash(canonicalJson(author));
}

function validateAuthor(value: unknown): value is BatchAuthor {
  if (!isRecord(value) ||
    !exactKeys(value, ['authorId', 'name', 'originalName', 'slug', 'identitySha256']) ||
    typeof value.authorId !== 'string' || !AUTHOR_ID.test(value.authorId) ||
    !isText(value.name) || !isText(value.originalName) ||
    typeof value.slug !== 'string' || !SLUG.test(value.slug) || !isSha(value.identitySha256)) return false;
  return value.identitySha256 === authorIdentity({
    authorId: value.authorId,
    name: value.name,
    originalName: value.originalName,
    slug: value.slug,
  });
}

function validateDocuments(value: unknown): value is readonly ApprovalBindingDocument[] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const paths = new Set<string>();
  for (const document of value) {
    if (!isRecord(document) || !exactKeys(document, ['path', 'sha256']) ||
      !isSafePath(document.path) || !isSha(document.sha256) || paths.has(document.path)) return false;
    paths.add(document.path);
  }
  return paths.has('docs/srs/SRS-F003.md') && paths.has('docs/tests/qt/QT-F003.md');
}

function validateApprovalBinding(value: unknown): value is CandidateApprovalBinding {
  return isRecord(value) &&
    exactKeys(value, ['queueId', 'approvalItemSha256', 'documents', 'evidenceRef', 'evidenceSha256']) &&
    value.queueId === 'Q-017' && isSha(value.approvalItemSha256) &&
    validateDocuments(value.documents) &&
    value.evidenceRef === 'docs/evidence/requirements/F003-approval-binding.json' &&
    isSha(value.evidenceSha256);
}

function validateWork(value: unknown): value is BatchCandidateRegistryWork {
  return isRecord(value) && exactKeys(value, ['workId', 'title', 'order', 'cardUrl', 'xhtmlUrl']) &&
    typeof value.workId === 'string' && WORK_ID.test(value.workId) && isText(value.title) &&
    Number.isSafeInteger(value.order) && (value.order as number) >= 1 &&
    canonicalHttps(value.cardUrl, 'card') && canonicalHttps(value.xhtmlUrl, 'xhtml');
}

/** @des DES-F003-001 @fun FUN-F003-001 @ut UT-F003-001 */
export function validateBatchCandidateRegistry(value: unknown): CandidateValidationResult {
  const fail = (code: CandidateFailureCode, message: string): CandidateValidationResult =>
    Object.freeze({ ok: false, code, message });
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'candidates']) ||
    value.schemaVersion !== '1.0.0' || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    return fail('CANDIDATE_REGISTRY_INVALID', 'candidate registryのtop-level schemaが不正です');
  }
  const batchIds = new Set<string>();
  const features = new Set<string>();
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) ||
      !exactKeys(candidate, ['batchId', 'feature', 'author', 'works', 'approvalBinding']) ||
      typeof candidate.batchId !== 'string' || !BATCH_ID.test(candidate.batchId) ||
      typeof candidate.feature !== 'string' || candidate.feature !== candidate.batchId ||
      !validateAuthor(candidate.author) ||
      !Array.isArray(candidate.works) || candidate.works.length !== 3 ||
      !candidate.works.every(validateWork) || !validateApprovalBinding(candidate.approvalBinding)) {
      return fail('CANDIDATE_REGISTRY_INVALID', 'candidateのexact schemaまたはidentityが不正です');
    }
    if (batchIds.has(candidate.batchId) || features.has(candidate.feature) ||
      new Set(candidate.works.map((work) => work.workId)).size !== 3) {
      return fail('CANDIDATE_DUPLICATE', 'batch、feature、work IDは一意である必要があります');
    }
    const works = candidate.works as unknown as readonly BatchCandidateRegistryWork[];
    const ordered = [...works].sort((left, right) => left.order - right.order);
    if (ordered.some((work, index) => work.order !== index + 1) ||
      ordered.some((work, index) => work !== works[index])) {
      return fail('CANDIDATE_REGISTRY_INVALID', 'work orderは配列順の1〜3である必要があります');
    }
    batchIds.add(candidate.batchId);
    features.add(candidate.feature);
  }
  return Object.freeze({
    ok: true,
    value: structuredClone(value) as unknown as BatchCandidateRegistry,
  });
}

/** @des DES-F003-001 @fun FUN-F003-001 @ut UT-F003-001 */
export async function writeBatchCandidateRegistryAtomic(
  workspace: string,
  registryPath: WorkspaceRelativePath,
  value: unknown,
  expectedSha: Sha256 | null,
): Promise<Sha256> {
  if (registryPath !== 'content/batch-candidates.json') {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'candidate registry pathがcanonical pathではありません');
  }
  const validated = validateBatchCandidateRegistry(value);
  if (!validated.ok) throw new BatchCandidateError(validated.code, validated.message);
  const target = join(workspace, ...registryPath.split('/'));
  const current = await fingerprintArtifact(target);
  let currentSha: Sha256 | null = null;
  try {
    currentSha = hash(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (currentSha !== expectedSha) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'candidate registryのexpected SHAが一致しません');
  }
  await writeJsonArtifactAtomic(workspace, target, validated.value, { expectedFingerprint: current });
  const written = await readFile(target);
  const expected = canonicalJson(validated.value);
  if (written.toString('utf8') !== expected) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'candidate registryのpost-read検証に失敗しました');
  }
  return hash(written);
}

async function verifiedWorkspaceFile(workspace: string, path: WorkspaceRelativePath): Promise<string> {
  if (!isAbsolute(workspace) || !isSafePath(path)) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'workspaceまたはpathが不正です');
  }
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'workspace実体が不正です');
  }
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'pathがworkspace外です');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'pathにreparse/symbolic linkがあります');
    }
  }
  const info = await lstat(target);
  if (!info.isFile() || await realpath(target) !== target) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', '対象がcanonical regular fileではありません');
  }
  return target;
}

function parseYamlSequence(raw: string): readonly unknown[] {
  const document = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'queue YAMLが厳密に解析できません');
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(value) || !exactKeys(value, ['items']) || !Array.isArray(value.items)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'queueはitemsだけを持つmappingである必要があります');
  }
  return value.items;
}

function approvalProjection(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(APPROVAL_PROJECTION_FIELDS.map((field) => [field, item[field]]));
}

function parseBindingEvidence(value: unknown): ApprovalBindingEvidence {
  const keys = [
    'schemaVersion', 'feature', 'queueId', 'queuePath', 'queueSha256AtMigration',
    'approvalProjectionFields', 'approvalItemSha256', 'documents', 'changes', 'migratedAt',
  ];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schemaVersion !== '1.0.0' ||
    value.feature !== 'F003' || value.queueId !== 'Q-017' || value.queuePath !== 'queue.yaml' ||
    !isSha(value.queueSha256AtMigration) || !isSha(value.approvalItemSha256) ||
    !Array.isArray(value.approvalProjectionFields) ||
    canonicalJson(value.approvalProjectionFields) !== canonicalJson(APPROVAL_PROJECTION_FIELDS) ||
    !validateDocuments(value.documents) || !Array.isArray(value.changes) ||
    !value.changes.some((change) => isRecord(change) && change.id === 'CHG-F003-001' &&
      change.level === 'testspec' && change.status === 'done') ||
    typeof value.migratedAt !== 'string' || !Number.isFinite(Date.parse(value.migratedAt))) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'approval binding evidenceが不正です');
  }
  return value as unknown as ApprovalBindingEvidence;
}

function hasApprovedFrontmatter(raw: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match?.[1]) return false;
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) return false;
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  return isRecord(value) && value.status === 'Approved' && value.feature === 'F003';
}

/** @des DES-F003-001 @fun FUN-F003-002 @ut UT-F003-002 */
export async function loadAndVerifyClosedApproval(
  workspace: string,
  queuePath: WorkspaceRelativePath,
  expectedQueueSha: Sha256,
  bindingEvidence: BindingEvidenceLocator,
): Promise<VerifiedClosedApproval> {
  if (queuePath !== 'queue.yaml' || !isSha(expectedQueueSha) ||
    bindingEvidence.path !== 'docs/evidence/requirements/F003-approval-binding.json' ||
    !isSha(bindingEvidence.sha256)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'approval loaderの入力が不正です');
  }
  const queueFile = await verifiedWorkspaceFile(workspace, queuePath);
  const queueRaw = await readFile(queueFile, 'utf8');
  const queueSha = hash(queueRaw);
  if (queueSha !== expectedQueueSha) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'queue全体SHAがexpected値と一致しません');
  }
  const evidenceFile = await verifiedWorkspaceFile(workspace, bindingEvidence.path);
  const evidenceRaw = await readFile(evidenceFile, 'utf8');
  if (hash(evidenceRaw) !== bindingEvidence.sha256) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'binding evidence SHAが一致しません');
  }
  let evidenceValue: unknown;
  try {
    evidenceValue = JSON.parse(evidenceRaw) as unknown;
  } catch {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'binding evidence JSONが不正です');
  }
  if (evidenceRaw !== canonicalJson(evidenceValue)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'binding evidenceがcanonical JSONではありません');
  }
  const evidence = parseBindingEvidence(evidenceValue);
  const queue = parseYamlSequence(queueRaw);
  const matches = queue.filter((item) => isRecord(item) && item.id === evidence.queueId);
  if (matches.length !== 1 || !isRecord(matches[0])) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'Q-017が一意に存在しません');
  }
  const item = matches[0];
  if (item.type !== 'approval' || item.status !== 'closed' || item.target !== 'docs/srs/SRS-F003.md' ||
    item.target_mode !== 'document' || item.answer !== '承認' || typeof item.approved_at !== 'string' ||
    !Number.isFinite(Date.parse(item.approved_at))) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'Q-017はclosed document approvalではありません');
  }
  const projectionSha = hash(canonicalJson(approvalProjection(item)));
  if (projectionSha !== evidence.approvalItemSha256) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'Q-017 canonical projection SHAが一致しません');
  }
  for (const document of evidence.documents) {
    const documentFile = await verifiedWorkspaceFile(workspace, document.path);
    const raw = await readFile(documentFile, 'utf8');
    if (!hasApprovedFrontmatter(raw) || hash(raw) !== document.sha256) {
      throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', `Approved文書SHAが一致しません: ${document.path}`);
    }
  }
  return Object.freeze({
    __brand: 'VerifiedClosedApproval',
    queueId: evidence.queueId,
    queueSha256: queueSha,
    approvalItemSha256: projectionSha,
    feature: evidence.feature,
    target: item.target as WorkspaceRelativePath,
    documents: Object.freeze(evidence.documents.map((document) => Object.freeze({ ...document }))),
    evidenceRef: bindingEvidence.path,
    evidenceSha256: bindingEvidence.sha256,
  });
}

function sameDocuments(left: readonly ApprovalBindingDocument[], right: readonly ApprovalBindingDocument[]): boolean {
  const ordered = (value: readonly ApprovalBindingDocument[]) =>
    [...value].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return canonicalJson(ordered(left)) === canonicalJson(ordered(right));
}

/** @des DES-F003-001 @fun FUN-F003-003 @ut UT-F003-003 */
export function selectApprovedBatchCandidateAndCreateTemplate(
  registryValue: unknown,
  approval: VerifiedClosedApproval,
  feature: BatchId,
  gateRefs: BatchApprovalGateRefs,
): BatchManifest {
  const registry = validateBatchCandidateRegistry(registryValue);
  if (!registry.ok) throw new BatchCandidateError(registry.code, registry.message);
  if (!isRecord(approval) || approval.__brand !== 'VerifiedClosedApproval' ||
    approval.feature !== feature || !isSha(approval.approvalItemSha256) ||
    !isSha(approval.evidenceSha256)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'verified approvalがfeatureと一致しません');
  }
  const candidates = registry.value.candidates.filter((candidate) => candidate.feature === feature);
  if (candidates.length !== 1) {
    throw new BatchCandidateError('CANDIDATE_DUPLICATE', 'featureに対する承認候補が一意ではありません');
  }
  const candidate = candidates[0];
  if (!candidate || candidate.batchId !== feature ||
    candidate.approvalBinding.queueId !== approval.queueId ||
    candidate.approvalBinding.approvalItemSha256 !== approval.approvalItemSha256 ||
    candidate.approvalBinding.evidenceRef !== approval.evidenceRef ||
    candidate.approvalBinding.evidenceSha256 !== approval.evidenceSha256 ||
    !sameDocuments(candidate.approvalBinding.documents, approval.documents)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'candidate approval bindingが検証済み承認と一致しません');
  }
  return createNextBatchTemplate({
    candidateId: candidate.batchId,
    approved: true,
    author: candidate.author,
    works: candidate.works.map((work) => ({ workId: work.workId, title: work.title })),
    approvalGateRefs: gateRefs,
    existingFeatureIds: ['F001', 'F002'],
  }, feature);
}
