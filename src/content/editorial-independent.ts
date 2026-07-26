import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from './artifacts.ts';
import {
  promoteBatchSourceArtifactTree,
  recoverBatchSourceArtifactPromotion,
  type BatchSourceTreeEntry,
  type PromotionHooks,
} from './batch-production.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CANDIDATE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const ROLES = ['primary', 'secondary', 'adjudicator'] as const;
const DECISIONS = ['approved', 'rejected', 'ambiguous'] as const;
const TOPIC_ONLY_REASONS = new Set([
  'TOPIC_KEYWORD_ONLY',
  'TITLE_KEYWORD_ONLY',
  'SUBJECT_ONLY',
  'MOTIF_ONLY',
]);
const verifiedJudgmentSets = new WeakSet<object>();

export const EDITORIAL_TRANSACTION_ROOT = 'content/editorial/authorization-transaction';
const AUTHORIZATION_STORE_PATH = 'store.json';

export type EditorialRole = typeof ROLES[number];
export type EditorialDecision = typeof DECISIONS[number];
export type FinalEditorialDecision = Exclude<EditorialDecision, 'ambiguous'> | 'pending';

export interface EditorialCandidate {
  readonly candidateId: string;
  readonly inputSha256: Sha256 | string;
  readonly sourceAnchor: string;
}

export interface ReviewInputRef {
  readonly kind: 'candidateSet' | 'policy' | 'prompt' | 'tool' | 'primaryJudgment' | 'secondaryJudgment';
  readonly path: string;
  readonly sha256: Sha256 | string;
}

export interface ReviewRunAuthorization {
  readonly authorizationId: string;
  readonly role: EditorialRole;
  readonly producerTaskPath: string;
  readonly judgeRole: EditorialRole;
  readonly runId: string;
  readonly candidateSetSha256: Sha256 | string;
  readonly policySha256: Sha256 | string;
  readonly promptSha256: Sha256 | string;
  readonly toolSha256: Sha256 | string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly inputRefs: readonly ReviewInputRef[];
  readonly candidates: readonly EditorialCandidate[];
}

export interface ReviewAuthorizationRecord {
  readonly authorization: ReviewRunAuthorization;
  readonly status: 'unused' | 'used';
  readonly usedAt: string | null;
  readonly sealPath: string | null;
  readonly sealSha256: Sha256 | string | null;
}

export interface ReviewAuthorizationStore {
  readonly schemaVersion: '1.0.0';
  readonly authorizations: readonly ReviewAuthorizationRecord[];
}

export interface EditorialJudgment {
  readonly candidateId: string;
  readonly decision: EditorialDecision;
  readonly reasonCode: string;
  readonly speaker: string | null;
  readonly sourceAnchor: string;
  readonly inputSha256: Sha256 | string;
}

export interface EditorialJudgmentExternalResult {
  readonly schemaVersion: '1.0.0';
  readonly authorizationId: string;
  readonly role: EditorialRole;
  readonly runId: string;
  readonly candidateSetSha256: Sha256 | string;
  readonly policySha256: Sha256 | string;
  readonly promptSha256: Sha256 | string;
  readonly toolSha256: Sha256 | string;
  judgments: EditorialJudgment[];
}

export interface EditorialJudgmentSetHeader {
  readonly authorizationId: string;
  readonly role: EditorialRole;
  readonly runId: string;
  readonly candidateSetSha256: Sha256 | string;
  readonly policySha256: Sha256 | string;
  readonly promptSha256: Sha256 | string;
  readonly toolSha256: Sha256 | string;
  readonly sealedAt: string;
  readonly artifactSha256: Sha256 | string;
}

type UnhashedEditorialJudgmentSetHeader = Omit<EditorialJudgmentSetHeader, 'artifactSha256'>;

export interface EditorialJudgmentSet {
  readonly schemaVersion: '1.0.0';
  readonly header: EditorialJudgmentSetHeader;
  judgments: EditorialJudgment[];
}

export interface EditorialResolution {
  readonly candidateId: string;
  readonly inputSha256: Sha256 | string;
  readonly finalDecision: FinalEditorialDecision;
  readonly reasonCode: string;
  readonly speaker: string | null;
  readonly sourceAnchor: string;
  readonly resolutionSource: 'agreement' | 'adjudication' | 'pending';
  readonly primaryArtifactSha256: Sha256 | string;
  readonly secondaryArtifactSha256: Sha256 | string;
  readonly adjudicationArtifactSha256: Sha256 | string | null;
}

export interface EditorialResolutionSet {
  readonly schemaVersion: '1.0.0';
  readonly candidateSetSha256: Sha256 | string;
  readonly primaryArtifactSha256: Sha256 | string;
  readonly secondaryArtifactSha256: Sha256 | string;
  readonly adjudicationArtifactSha256: Sha256 | string | null;
  readonly reconciliationDigest: Sha256 | string;
  readonly resolutions: readonly EditorialResolution[];
  readonly pendingIds: readonly string[];
}

type CompletenessCategory =
  | 'candidateDuplicates'
  | 'resolutionDuplicates'
  | 'missing'
  | 'extra'
  | 'pending'
  | 'reasonMissing'
  | 'topicOnlyRejections';

export interface ReviewCompletenessReport {
  readonly result: 'pass' | 'blocked';
  readonly counts: Readonly<Record<CompletenessCategory, number>>;
  readonly ids: Readonly<Record<CompletenessCategory, readonly string[]>>;
}

export interface EditorialSealOptions {
  readonly now?: () => string;
  readonly promotionHooks?: PromotionHooks;
}

export type EditorialIndependentErrorCode =
  | 'EDITORIAL_AUTHORIZATION_STORE_INVALID'
  | 'EDITORIAL_AUTHORIZATION_UNTRUSTED'
  | 'EDITORIAL_AUTHORIZATION_USED'
  | 'EDITORIAL_IDENTITY_COLLISION'
  | 'EDITORIAL_PRIMARY_DISCLOSURE'
  | 'EDITORIAL_EXTERNAL_RESULT_INVALID'
  | 'EDITORIAL_SEAL_EXISTS'
  | 'EDITORIAL_SEAL_TAMPERED'
  | 'EDITORIAL_JUDGMENT_SET_INVALID'
  | 'EDITORIAL_JUDGMENT_SET_UNTRUSTED'
  | 'EDITORIAL_ADJUDICATION_INVALID'
  | 'EDITORIAL_CANDIDATE_SET_INVALID'
  | 'EDITORIAL_WORKSPACE_INVALID';

export class EditorialIndependentError extends Error {
  constructor(public readonly code: EditorialIndependentErrorCode, message: string) {
    super(message);
    this.name = 'EditorialIndependentError';
  }
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

function validNonEmpty(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    });
}

function validRelativePath(value: unknown): value is string {
  if (!validNonEmpty(value, 512) || value.includes('\\') || value.includes(':') || value.startsWith('/')) return false;
  return value.split('/').every((component) =>
    component !== '' && component !== '.' && component !== '..' && !/[. ]$/u.test(component));
}

function validTaskPath(value: unknown): value is string {
  return validNonEmpty(value, 512) && value.startsWith('/') && !value.includes('\\') &&
    value.split('/').slice(1).every((component) => component !== '' && component !== '.' && component !== '..');
}

function validCandidate(value: unknown): value is EditorialCandidate {
  return isRecord(value) &&
    exactKeys(value, ['candidateId', 'inputSha256', 'sourceAnchor']) &&
    typeof value.candidateId === 'string' && CANDIDATE_ID.test(value.candidateId) &&
    typeof value.inputSha256 === 'string' && SHA256.test(value.inputSha256) &&
    validNonEmpty(value.sourceAnchor, 1_024);
}

function assertCandidateSet(candidates: readonly EditorialCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.some((candidate) => !validCandidate(candidate))) {
    throw new EditorialIndependentError('EDITORIAL_CANDIDATE_SET_INVALID', 'candidate setのexact schemaが不正です');
  }
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw new EditorialIndependentError('EDITORIAL_CANDIDATE_SET_INVALID', 'candidate IDが重複しています');
  }
}

/** @des DES-F003-005 @fun FUN-F003-009 */
export function hashEditorialCandidates(candidates: readonly EditorialCandidate[]): Sha256 {
  assertCandidateSet(candidates);
  return sha256(canonicalJson(candidates));
}

function validInputRef(value: unknown): value is ReviewInputRef {
  return isRecord(value) && exactKeys(value, ['kind', 'path', 'sha256']) &&
    ['candidateSet', 'policy', 'prompt', 'tool', 'primaryJudgment', 'secondaryJudgment'].includes(String(value.kind)) &&
    validRelativePath(value.path) && typeof value.sha256 === 'string' && SHA256.test(value.sha256);
}

function validateAuthorization(value: unknown): asserts value is ReviewRunAuthorization {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'authorizationId', 'role', 'producerTaskPath', 'judgeRole', 'runId',
      'candidateSetSha256', 'policySha256', 'promptSha256', 'toolSha256',
      'nonce', 'issuedAt', 'inputRefs', 'candidates',
    ]) ||
    typeof value.authorizationId !== 'string' || !SAFE_ID.test(value.authorizationId) ||
    !ROLES.includes(value.role as EditorialRole) ||
    value.judgeRole !== value.role ||
    !validTaskPath(value.producerTaskPath) ||
    typeof value.runId !== 'string' || !SAFE_ID.test(value.runId) ||
    typeof value.nonce !== 'string' || !SAFE_ID.test(value.nonce) ||
    !validTimestamp(value.issuedAt) ||
    ![value.candidateSetSha256, value.policySha256, value.promptSha256, value.toolSha256]
      .every((item) => typeof item === 'string' && SHA256.test(item)) ||
    !Array.isArray(value.inputRefs) || value.inputRefs.some((reference) => !validInputRef(reference)) ||
    !Array.isArray(value.candidates)
  ) {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'authorization exact schemaが不正です');
  }
  assertCandidateSet(value.candidates as EditorialCandidate[]);
  if (hashEditorialCandidates(value.candidates as EditorialCandidate[]) !== value.candidateSetSha256) {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'candidate set SHAが一致しません');
  }
  const refs = value.inputRefs as ReviewInputRef[];
  const refIdentity = refs.map((reference) => `${reference.kind}\0${reference.path}`);
  if (new Set(refIdentity).size !== refIdentity.length) {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'authorization input refが重複しています');
  }
}

function validateStore(value: unknown): asserts value is ReviewAuthorizationStore {
  if (
    !isRecord(value) || !exactKeys(value, ['schemaVersion', 'authorizations']) ||
    value.schemaVersion !== '1.0.0' || !Array.isArray(value.authorizations) ||
    value.authorizations.length === 0
  ) {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'trusted authorization storeが不正です');
  }
  for (const item of value.authorizations) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ['authorization', 'status', 'usedAt', 'sealPath', 'sealSha256']) ||
      !['unused', 'used'].includes(String(item.status))
    ) {
      throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'authorization recordが不正です');
    }
    validateAuthorization(item.authorization);
    if (item.status === 'unused') {
      if (item.usedAt !== null || item.sealPath !== null || item.sealSha256 !== null) {
        throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'unused authorizationにseal情報があります');
      }
    } else if (
      !validTimestamp(item.usedAt) || !validRelativePath(item.sealPath) ||
      typeof item.sealSha256 !== 'string' || !SHA256.test(item.sealSha256)
    ) {
      throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'used authorizationのseal情報が不正です');
    }
  }
  const authorizations = value.authorizations as ReviewAuthorizationRecord[];
  for (const field of ['authorizationId', 'producerTaskPath', 'runId', 'nonce'] as const) {
    const values = authorizations.map((item) => item.authorization[field]);
    if (new Set(values).size !== values.length) {
      throw new EditorialIndependentError('EDITORIAL_IDENTITY_COLLISION', `authorization ${field}が衝突しています`);
    }
  }
}

async function verifiedTransactionRoot(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) {
    throw new EditorialIndependentError('EDITORIAL_WORKSPACE_INVALID', 'workspaceは絶対pathが必要です');
  }
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe');
  } catch {
    throw new EditorialIndependentError('EDITORIAL_WORKSPACE_INVALID', 'workspace実体が不正です');
  }
  const transactionRoot = join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/'));
  const relation = relative(root, transactionRoot);
  if (!relation || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new EditorialIndependentError('EDITORIAL_WORKSPACE_INVALID', 'transaction rootがworkspace外です');
  }
  return transactionRoot;
}

async function readTransactionTree(workspace: string): Promise<Map<string, Uint8Array>> {
  const root = await verifiedTransactionRoot(workspace);
  const entries = new Map<string, Uint8Array>();
  const walk = async (directory: string, logical: string): Promise<void> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new EditorialIndependentError('EDITORIAL_WORKSPACE_INVALID', 'transaction treeに非directoryがあります');
    }
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relativePath = logical ? `${logical}/${name}` : name;
      const child = await lstat(path);
      if (child.isSymbolicLink()) {
        throw new EditorialIndependentError('EDITORIAL_WORKSPACE_INVALID', 'transaction treeにlinkがあります');
      }
      if (child.isDirectory()) {
        if (relativePath !== 'seals') {
          throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'transaction treeに未知directoryがあります');
        }
        await walk(path, relativePath);
      } else if (child.isFile()) {
        if (
          relativePath !== AUTHORIZATION_STORE_PATH &&
          !/^seals\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(relativePath)
        ) {
          throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'transaction treeに未知fileがあります');
        }
        entries.set(relativePath, await readFile(path));
      } else {
        throw new EditorialIndependentError('EDITORIAL_WORKSPACE_INVALID', 'transaction treeはregular file以外を含めません');
      }
    }
  };
  await walk(root, '');
  return entries;
}

function parseCanonicalJson(bytes: Uint8Array, code: EditorialIndependentErrorCode): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (canonicalJson(parsed) !== text) throw new Error('not canonical');
    return parsed;
  } catch {
    throw new EditorialIndependentError(code, 'canonical JSON artifactが不正です');
  }
}

function validJudgment(value: unknown): value is EditorialJudgment {
  return isRecord(value) &&
    exactKeys(value, ['candidateId', 'decision', 'reasonCode', 'speaker', 'sourceAnchor', 'inputSha256']) &&
    typeof value.candidateId === 'string' && CANDIDATE_ID.test(value.candidateId) &&
    DECISIONS.includes(value.decision as EditorialDecision) &&
    validNonEmpty(value.reasonCode, 128) &&
    (value.speaker === null || validNonEmpty(value.speaker, 256)) &&
    validNonEmpty(value.sourceAnchor, 1_024) &&
    typeof value.inputSha256 === 'string' && SHA256.test(value.inputSha256);
}

function exactJudgmentJoin(
  candidates: readonly EditorialCandidate[],
  judgments: readonly EditorialJudgment[],
): boolean {
  if (judgments.length !== candidates.length) return false;
  const byId = new Map(judgments.map((judgment) => [judgment.candidateId, judgment]));
  return byId.size === judgments.length && candidates.every((candidate) => {
    const judgment = byId.get(candidate.candidateId);
    return judgment?.inputSha256 === candidate.inputSha256 &&
      judgment.sourceAnchor === candidate.sourceAnchor;
  });
}

function validateExternal(
  value: unknown,
  authorization: ReviewRunAuthorization,
): asserts value is EditorialJudgmentExternalResult {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion', 'authorizationId', 'role', 'runId', 'candidateSetSha256',
      'policySha256', 'promptSha256', 'toolSha256', 'judgments',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    value.authorizationId !== authorization.authorizationId ||
    value.role !== authorization.role ||
    value.runId !== authorization.runId ||
    value.candidateSetSha256 !== authorization.candidateSetSha256 ||
    value.policySha256 !== authorization.policySha256 ||
    value.promptSha256 !== authorization.promptSha256 ||
    value.toolSha256 !== authorization.toolSha256 ||
    !Array.isArray(value.judgments) ||
    value.judgments.some((judgment) => !validJudgment(judgment)) ||
    !exactJudgmentJoin(authorization.candidates, value.judgments as EditorialJudgment[])
  ) {
    throw new EditorialIndependentError(
      'EDITORIAL_EXTERNAL_RESULT_INVALID',
      '外部判定はauthorizationと全candidateをexact joinできません',
    );
  }
}

/** artifactSha256自身を除くcanonical seal payloadのSHA-256。 */
export function hashEditorialJudgmentArtifact(input: {
  readonly schemaVersion: '1.0.0';
  readonly header: UnhashedEditorialJudgmentSetHeader;
  readonly judgments: readonly EditorialJudgment[];
}): Sha256 {
  return sha256(canonicalJson(input));
}

function validateSealedSet(value: unknown): asserts value is EditorialJudgmentSet {
  if (
    !isRecord(value) || !exactKeys(value, ['schemaVersion', 'header', 'judgments']) ||
    value.schemaVersion !== '1.0.0' || !isRecord(value.header) ||
    !exactKeys(value.header, [
      'authorizationId', 'role', 'runId', 'candidateSetSha256', 'policySha256',
      'promptSha256', 'toolSha256', 'sealedAt', 'artifactSha256',
    ]) ||
    typeof value.header.authorizationId !== 'string' || !SAFE_ID.test(value.header.authorizationId) ||
    !ROLES.includes(value.header.role as EditorialRole) ||
    typeof value.header.runId !== 'string' || !SAFE_ID.test(value.header.runId) ||
    ![value.header.candidateSetSha256, value.header.policySha256, value.header.promptSha256,
      value.header.toolSha256, value.header.artifactSha256]
      .every((item) => typeof item === 'string' && SHA256.test(item)) ||
    !validTimestamp(value.header.sealedAt) ||
    !Array.isArray(value.judgments) || value.judgments.some((judgment) => !validJudgment(judgment))
  ) {
    throw new EditorialIndependentError('EDITORIAL_JUDGMENT_SET_INVALID', 'sealed judgment setが不正です');
  }
  const header = value.header as unknown as EditorialJudgmentSetHeader;
  const { artifactSha256, ...unhashedHeader } = header;
  if (hashEditorialJudgmentArtifact({
    schemaVersion: '1.0.0',
    header: unhashedHeader,
    judgments: value.judgments as EditorialJudgment[],
  }) !== artifactSha256) {
    throw new EditorialIndependentError('EDITORIAL_JUDGMENT_SET_INVALID', 'seal artifact SHAが一致しません');
  }
}

function assertPrimaryDisclosurePolicy(authorization: ReviewRunAuthorization): void {
  const kinds = authorization.inputRefs.map((reference) => reference.kind);
  if (authorization.role === 'secondary' && kinds.some((kind) =>
    kind === 'primaryJudgment' || kind === 'secondaryJudgment')) {
    throw new EditorialIndependentError('EDITORIAL_PRIMARY_DISCLOSURE', 'secondaryへprimary判定を開示できません');
  }
  if (authorization.role === 'primary' && kinds.some((kind) =>
    kind === 'primaryJudgment' || kind === 'secondaryJudgment')) {
    throw new EditorialIndependentError('EDITORIAL_PRIMARY_DISCLOSURE', 'primaryへ他判定を入力できません');
  }
  if (
    authorization.role === 'adjudicator' &&
    (kinds.filter((kind) => kind === 'primaryJudgment').length !== 1 ||
      kinds.filter((kind) => kind === 'secondaryJudgment').length !== 1)
  ) {
    throw new EditorialIndependentError('EDITORIAL_PRIMARY_DISCLOSURE', 'adjudicatorにはsealed primary/secondaryを1件ずつ渡します');
  }
}

function authorizationRecord(
  store: ReviewAuthorizationStore,
  authorization: ReviewRunAuthorization,
): ReviewAuthorizationRecord {
  const record = store.authorizations.find((item) =>
    item.authorization.authorizationId === authorization.authorizationId);
  if (!record || canonicalJson(record.authorization) !== canonicalJson(authorization)) {
    throw new EditorialIndependentError(
      'EDITORIAL_AUTHORIZATION_UNTRUSTED',
      'caller authorizationがtrusted coordinator storeと一致しません',
    );
  }
  return record;
}

function verifySealsAgainstStore(
  store: ReviewAuthorizationStore,
  tree: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, EditorialJudgmentSet> {
  const expectedPaths = new Set<string>();
  const verified = new Map<string, EditorialJudgmentSet>();
  for (const record of store.authorizations) {
    if (record.status === 'unused') continue;
    const expectedPath = `seals/${record.authorization.authorizationId}.json`;
    if (record.sealPath !== expectedPath) {
      throw new EditorialIndependentError('EDITORIAL_SEAL_TAMPERED', 'trusted storeのseal pathが不正です');
    }
    expectedPaths.add(expectedPath);
    const bytes = tree.get(expectedPath);
    if (!bytes) throw new EditorialIndependentError('EDITORIAL_SEAL_TAMPERED', 'used authorizationのsealが欠落しています');
    try {
      const seal = parseCanonicalJson(bytes, 'EDITORIAL_SEAL_TAMPERED');
      validateSealedSet(seal);
      if (
        seal.header.authorizationId !== record.authorization.authorizationId ||
        seal.header.role !== record.authorization.role ||
        seal.header.runId !== record.authorization.runId ||
        seal.header.candidateSetSha256 !== record.authorization.candidateSetSha256 ||
        seal.header.policySha256 !== record.authorization.policySha256 ||
        seal.header.promptSha256 !== record.authorization.promptSha256 ||
        seal.header.toolSha256 !== record.authorization.toolSha256 ||
        seal.header.sealedAt !== record.usedAt ||
        seal.header.artifactSha256 !== record.sealSha256 ||
        !exactJudgmentJoin(record.authorization.candidates, seal.judgments)
      ) {
        throw new Error('seal mismatch');
      }
      verified.set(expectedPath, seal);
    } catch {
      throw new EditorialIndependentError('EDITORIAL_SEAL_TAMPERED', '既存sealが改変されています');
    }
  }
  for (const path of tree.keys()) {
    if (path.startsWith('seals/') && !expectedPaths.has(path)) {
      throw new EditorialIndependentError('EDITORIAL_SEAL_TAMPERED', 'storeに結合されないsealがあります');
    }
  }
  return verified;
}

function assertAdjudicationRefs(
  store: ReviewAuthorizationStore,
  authorization: ReviewRunAuthorization,
): void {
  if (authorization.role !== 'adjudicator') return;
  for (const role of ['primary', 'secondary'] as const) {
    const reference = authorization.inputRefs.find((item) => item.kind === `${role}Judgment`);
    if (!reference) {
      throw new EditorialIndependentError(
        'EDITORIAL_PRIMARY_DISCLOSURE',
        `adjudicatorの${role} refがありません`,
      );
    }
    const records = store.authorizations.filter((item) =>
      item.authorization.role === role &&
      item.status === 'used' &&
      item.sealPath === reference.path &&
      item.sealSha256 === reference.sha256);
    if (records.length !== 1) {
      throw new EditorialIndependentError(
        'EDITORIAL_PRIMARY_DISCLOSURE',
        `adjudicatorの${role} refがtrusted sealed artifactと一致しません`,
      );
    }
  }
}

function transactionTreeDigest(tree: ReadonlyMap<string, Uint8Array>): Sha256 {
  const hash = createHash('sha256');
  for (const [path, bytes] of [...tree].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex') as Sha256;
}

/** @des DES-F003-005 @fun FUN-F003-009 */
export async function recoverEditorialJudgmentTransaction(workspace: string): Promise<void> {
  await recoverBatchSourceArtifactPromotion(
    workspace,
    EDITORIAL_TRANSACTION_ROOT as WorkspaceRelativePath,
  );
}

/**
 * crash recoveryまたはプロセス再開後、永続storeとsealを再検証して信頼済みobjectとして読み込む。
 * @des DES-F003-005 @fun FUN-F003-009
 */
export async function loadAndVerifyEditorialJudgmentSets(
  workspace: string,
): Promise<readonly EditorialJudgmentSet[]> {
  await recoverEditorialJudgmentTransaction(workspace);
  const tree = await readTransactionTree(workspace);
  const storeBytes = tree.get(AUTHORIZATION_STORE_PATH);
  if (!storeBytes) {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'trusted storeがありません');
  }
  const storeUnknown = parseCanonicalJson(storeBytes, 'EDITORIAL_AUTHORIZATION_STORE_INVALID');
  validateStore(storeUnknown);
  const store = storeUnknown;
  const persisted = verifySealsAgainstStore(store, tree);
  const trusted: EditorialJudgmentSet[] = [];
  for (const record of store.authorizations) {
    if (record.status !== 'used' || !record.sealPath) continue;
    assertPrimaryDisclosurePolicy(record.authorization);
    assertAdjudicationRefs(store, record.authorization);
    const seal = persisted.get(record.sealPath);
    if (!seal) {
      throw new EditorialIndependentError('EDITORIAL_SEAL_TAMPERED', 'used authorizationのsealを再読込できません');
    }
    const restored: EditorialJudgmentSet = Object.freeze({
      schemaVersion: '1.0.0',
      header: Object.freeze({ ...seal.header }),
      judgments: Object.freeze(
        seal.judgments.map((judgment) => Object.freeze({ ...judgment })),
      ) as unknown as EditorialJudgment[],
    });
    validateSealedSet(restored);
    verifiedJudgmentSets.add(restored);
    trusted.push(restored);
  }
  return Object.freeze(trusted);
}

/** @des DES-F003-005 @fun FUN-F003-009 */
export async function sealAndValidateEditorialJudgmentSet(
  workspace: string,
  authorization: ReviewRunAuthorization,
  externalResult: unknown,
  options: EditorialSealOptions = {},
): Promise<EditorialJudgmentSet> {
  await recoverEditorialJudgmentTransaction(workspace);
  const tree = await readTransactionTree(workspace);
  const storeBytes = tree.get(AUTHORIZATION_STORE_PATH);
  if (!storeBytes) {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_STORE_INVALID', 'trusted storeがありません');
  }
  const storeUnknown = parseCanonicalJson(storeBytes, 'EDITORIAL_AUTHORIZATION_STORE_INVALID');
  validateStore(storeUnknown);
  const store = storeUnknown;
  verifySealsAgainstStore(store, tree);
  validateAuthorization(authorization);
  const record = authorizationRecord(store, authorization);
  if (record.status === 'used') {
    throw new EditorialIndependentError('EDITORIAL_AUTHORIZATION_USED', 'authorizationは使用済みです');
  }
  assertPrimaryDisclosurePolicy(authorization);
  assertAdjudicationRefs(store, authorization);
  validateExternal(externalResult, authorization);
  const sealPath = `seals/${authorization.authorizationId}.json`;
  if (tree.has(sealPath)) {
    throw new EditorialIndependentError('EDITORIAL_SEAL_EXISTS', 'create-new sealが既に存在します');
  }

  const sealedAt = options.now?.() ?? new Date().toISOString();
  if (!validTimestamp(sealedAt)) {
    throw new EditorialIndependentError('EDITORIAL_EXTERNAL_RESULT_INVALID', 'sealedAtがRFC 3339ではありません');
  }
  const unhashedHeader: UnhashedEditorialJudgmentSetHeader = {
    authorizationId: authorization.authorizationId,
    role: authorization.role,
    runId: authorization.runId,
    candidateSetSha256: authorization.candidateSetSha256,
    policySha256: authorization.policySha256,
    promptSha256: authorization.promptSha256,
    toolSha256: authorization.toolSha256,
    sealedAt,
  };
  const judgments = externalResult.judgments.map((judgment) => Object.freeze({ ...judgment }));
  const artifactSha256 = hashEditorialJudgmentArtifact({
    schemaVersion: '1.0.0',
    header: unhashedHeader,
    judgments,
  });
  const sealed: EditorialJudgmentSet = Object.freeze({
    schemaVersion: '1.0.0',
    header: Object.freeze({ ...unhashedHeader, artifactSha256 }),
    judgments: Object.freeze(judgments) as unknown as EditorialJudgment[],
  });
  const nextStore: ReviewAuthorizationStore = {
    schemaVersion: '1.0.0',
    authorizations: store.authorizations.map((item) =>
      item.authorization.authorizationId === authorization.authorizationId
        ? {
            authorization: item.authorization,
            status: 'used',
            usedAt: sealedAt,
            sealPath,
            sealSha256: artifactSha256,
          }
        : item),
  };
  const entries: BatchSourceTreeEntry[] = [];
  for (const [path, bytes] of tree) {
    if (path !== AUTHORIZATION_STORE_PATH) entries.push({ path, bytes });
  }
  entries.push({ path: AUTHORIZATION_STORE_PATH, bytes: jsonBytes(nextStore) });
  entries.push({ path: sealPath, bytes: jsonBytes(sealed) });
  const expectedTreeDigest = transactionTreeDigest(tree);
  await promoteBatchSourceArtifactTree(
    workspace,
    EDITORIAL_TRANSACTION_ROOT as WorkspaceRelativePath,
    entries,
    options.promotionHooks,
    async () => {
      if (transactionTreeDigest(await readTransactionTree(workspace)) !== expectedTreeDigest) {
        throw new EditorialIndependentError(
          'EDITORIAL_AUTHORIZATION_UNTRUSTED',
          'trusted storeがseal処理中に変更されました',
        );
      }
    },
  );
  const restored = (await loadAndVerifyEditorialJudgmentSets(workspace))
    .find((item) => item.header.artifactSha256 === artifactSha256);
  if (!restored) {
    throw new EditorialIndependentError('EDITORIAL_SEAL_TAMPERED', '永続化したsealを再検証できません');
  }
  return restored;
}

function semanticMatch(left: EditorialJudgment, right: EditorialJudgment): boolean {
  return left.candidateId === right.candidateId &&
    left.inputSha256 === right.inputSha256 &&
    left.decision === right.decision &&
    left.reasonCode === right.reasonCode &&
    left.speaker === right.speaker &&
    left.sourceAnchor === right.sourceAnchor;
}

function assertIndependentSets(
  candidates: readonly EditorialCandidate[],
  primary: EditorialJudgmentSet,
  secondary: EditorialJudgmentSet,
  adjudication?: EditorialJudgmentSet,
): void {
  for (const set of [primary, secondary, ...(adjudication ? [adjudication] : [])]) {
    if (!verifiedJudgmentSets.has(set)) {
      throw new EditorialIndependentError(
        'EDITORIAL_JUDGMENT_SET_UNTRUSTED',
        'trusted authorization storeで封印されたjudgment setだけを照合できます',
      );
    }
    validateSealedSet(set);
    if (
      set.header.candidateSetSha256 !== hashEditorialCandidates(candidates) ||
      set.judgments.length !== candidates.length ||
      new Set(set.judgments.map((judgment) => judgment.candidateId)).size !== set.judgments.length ||
      candidates.some((candidate) => !set.judgments.some((judgment) =>
        judgment.candidateId === candidate.candidateId))
    ) {
      throw new EditorialIndependentError('EDITORIAL_JUDGMENT_SET_INVALID', 'judgment setがcandidate setと一致しません');
    }
  }
  if (primary.header.role !== 'primary' || secondary.header.role !== 'secondary') {
    throw new EditorialIndependentError('EDITORIAL_JUDGMENT_SET_INVALID', 'primary/secondary roleが不正です');
  }
  const baseIds = [primary.header.authorizationId, secondary.header.authorizationId];
  const baseRuns = [primary.header.runId, secondary.header.runId];
  if (new Set(baseIds).size !== 2 || new Set(baseRuns).size !== 2) {
    throw new EditorialIndependentError('EDITORIAL_IDENTITY_COLLISION', 'primary/secondary identityまたはrunが同一です');
  }
  if (adjudication) {
    if (
      adjudication.header.role !== 'adjudicator' ||
      baseIds.includes(adjudication.header.authorizationId) ||
      baseRuns.includes(adjudication.header.runId)
    ) {
      throw new EditorialIndependentError('EDITORIAL_ADJUDICATION_INVALID', '第三裁定identity/runが独立していません');
    }
  }
}

/** @des DES-F003-005 @fun FUN-F003-010 */
export function reconcileIndependentJudgments(
  candidates: readonly EditorialCandidate[],
  primary: EditorialJudgmentSet,
  secondary: EditorialJudgmentSet,
  adjudication?: EditorialJudgmentSet,
): EditorialResolutionSet {
  assertCandidateSet(candidates);
  assertIndependentSets(candidates, primary, secondary, adjudication);
  const primaryById = new Map(primary.judgments.map((judgment) => [judgment.candidateId, judgment]));
  const secondaryById = new Map(secondary.judgments.map((judgment) => [judgment.candidateId, judgment]));
  const adjudicationById = new Map(adjudication?.judgments.map((judgment) =>
    [judgment.candidateId, judgment]) ?? []);
  const resolutions = candidates.map((candidate): EditorialResolution => {
    const first = primaryById.get(candidate.candidateId)!;
    const second = secondaryById.get(candidate.candidateId)!;
    const judge = adjudicationById.get(candidate.candidateId);
    const commonInput = first.inputSha256 === candidate.inputSha256 &&
      second.inputSha256 === candidate.inputSha256;
    const commonSourceAnchor = first.sourceAnchor === candidate.sourceAnchor &&
      second.sourceAnchor === candidate.sourceAnchor;
    if (commonInput && commonSourceAnchor && semanticMatch(first, second) && first.decision !== 'ambiguous') {
      return Object.freeze({
        candidateId: candidate.candidateId,
        inputSha256: candidate.inputSha256,
        finalDecision: first.decision,
        reasonCode: first.reasonCode,
        speaker: first.speaker,
        sourceAnchor: candidate.sourceAnchor,
        resolutionSource: 'agreement',
        primaryArtifactSha256: primary.header.artifactSha256,
        secondaryArtifactSha256: secondary.header.artifactSha256,
        adjudicationArtifactSha256: null,
      });
    }
    if (
      commonInput && judge &&
      judge.inputSha256 === candidate.inputSha256 &&
      judge.sourceAnchor === candidate.sourceAnchor &&
      judge.decision !== 'ambiguous'
    ) {
      return Object.freeze({
        candidateId: candidate.candidateId,
        inputSha256: candidate.inputSha256,
        finalDecision: judge.decision,
        reasonCode: judge.reasonCode,
        speaker: judge.speaker,
        sourceAnchor: candidate.sourceAnchor,
        resolutionSource: 'adjudication',
        primaryArtifactSha256: primary.header.artifactSha256,
        secondaryArtifactSha256: secondary.header.artifactSha256,
        adjudicationArtifactSha256: adjudication!.header.artifactSha256,
      });
    }
    return Object.freeze({
      candidateId: candidate.candidateId,
      inputSha256: candidate.inputSha256,
      finalDecision: 'pending',
      reasonCode: 'PENDING_ADJUDICATION',
      speaker: null,
      sourceAnchor: candidate.sourceAnchor,
      resolutionSource: 'pending',
      primaryArtifactSha256: primary.header.artifactSha256,
      secondaryArtifactSha256: secondary.header.artifactSha256,
      adjudicationArtifactSha256: adjudication?.header.artifactSha256 ?? null,
    });
  });
  const pendingIds = resolutions
    .filter((resolution) => resolution.finalDecision === 'pending')
    .map((resolution) => resolution.candidateId);
  const digestPayload = {
    schemaVersion: '1.0.0',
    candidateSetSha256: hashEditorialCandidates(candidates),
    primaryArtifactSha256: primary.header.artifactSha256,
    secondaryArtifactSha256: secondary.header.artifactSha256,
    adjudicationArtifactSha256: adjudication?.header.artifactSha256 ?? null,
    resolutions,
    pendingIds,
  } as const;
  return Object.freeze({
    ...digestPayload,
    reconciliationDigest: sha256(canonicalJson(digestPayload)),
    resolutions: Object.freeze(resolutions),
    pendingIds: Object.freeze(pendingIds),
  });
}

function duplicateIds(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

/** @des DES-F003-005 @fun FUN-F003-011 */
export function verifyEditorialCompleteness(
  candidates: readonly EditorialCandidate[],
  resolutions: readonly EditorialResolution[],
): ReviewCompletenessReport {
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  const resolutionIds = resolutions.map((resolution) => resolution.candidateId);
  const candidateSet = new Set(candidateIds);
  const resolutionSet = new Set(resolutionIds);
  const ids: Record<CompletenessCategory, string[]> = {
    candidateDuplicates: duplicateIds(candidateIds),
    resolutionDuplicates: duplicateIds(resolutionIds),
    missing: [...candidateSet].filter((id) => !resolutionSet.has(id)).sort(),
    extra: [...resolutionSet].filter((id) => !candidateSet.has(id)).sort(),
    pending: resolutions.filter((item) => item.finalDecision === 'pending').map((item) => item.candidateId).sort(),
    reasonMissing: resolutions
      .filter((item) => item.finalDecision !== 'pending' && item.reasonCode.trim().length === 0)
      .map((item) => item.candidateId)
      .sort(),
    topicOnlyRejections: resolutions
      .filter((item) => item.finalDecision === 'rejected' && TOPIC_ONLY_REASONS.has(item.reasonCode))
      .map((item) => item.candidateId)
      .sort(),
  };
  const counts = Object.fromEntries(
    Object.entries(ids).map(([category, values]) => [category, values.length]),
  ) as Record<CompletenessCategory, number>;
  const blocked = Object.values(counts).some((count) => count > 0);
  return Object.freeze({
    result: blocked ? 'blocked' : 'pass',
    counts: Object.freeze(counts),
    ids: Object.freeze(Object.fromEntries(
      Object.entries(ids).map(([category, values]) => [category, Object.freeze(values)]),
    )) as Readonly<Record<CompletenessCategory, readonly string[]>>,
  });
}
