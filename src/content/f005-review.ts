import { createHash, randomBytes } from 'node:crypto';

import { canonicalJson } from './artifacts.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  normalizeBatchCandidate,
  type CandidateWithRevisions,
} from './batch-production.ts';
import type { Sha256 } from './batch.ts';
import {
  isMintedF005ApprovedBatchContext,
  type F005ApprovedBatchContext,
} from './f005-context.ts';
import type { F005CandidateSet, F005WorkId } from './f005-source.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DECISIONS = new Set(['approved', 'rejected']);
const authorizationSets = new WeakSet<object>();
const authorizations = new WeakSet<object>();
const judgmentArtifacts = new WeakSet<object>();
const agreements = new WeakSet<object>();
const disputes = new WeakSet<object>();
const reconciliations = new WeakSet<object>();
const revisionSets = new WeakSet<object>();

export type F005ReviewErrorCode =
  | 'F005_REVIEW_AUTHORIZATION_INVALID'
  | 'F005_REVIEW_INCOMPLETE'
  | 'F005_REVIEW_RESULT_INVALID'
  | 'F005_REVIEW_REPLAY'
  | 'F005_SPEECH_REVISION_INVALID';

export class F005ReviewError extends Error {
  constructor(public readonly code: F005ReviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F005ReviewError';
  }
}

export interface F005ReviewIdentity {
  readonly principalId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface F005ReviewPromptTemplate {
  readonly schemaVersion: '1.0.0';
  readonly prompt: string;
  readonly template: string;
  readonly tool: string;
}

export interface F005ReviewCandidateBinding {
  readonly candidateId: string;
  readonly inputSha256: Sha256;
  readonly sourceAnchor: string;
}

export interface F005ReviewAuthorization {
  readonly __brand: 'F005ReviewAuthorization';
  readonly schemaVersion: '1.0.0';
  readonly authorizationId: string;
  readonly feature: 'F005';
  readonly batchId: 'F005';
  readonly workId: F005WorkId;
  readonly role: 'primary' | 'secondary';
  readonly producer: F005ReviewIdentity;
  readonly reviewer: F005ReviewIdentity;
  readonly candidateSetSha256: Sha256;
  readonly candidateBindings: readonly F005ReviewCandidateBinding[];
  readonly policySha256: Sha256;
  readonly toolSha256: Sha256;
  readonly promptSha256: Sha256;
  readonly templateSha256: Sha256;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly audience: string;
  readonly resultVisibility: 'blind-private';
  readonly nonce: string;
  readonly authorizationSha256: Sha256;
}

export interface F005ReviewAuthorizationSet {
  readonly __brand: 'F005ReviewAuthorizationSet';
  readonly schemaVersion: '1.0.0';
  readonly workId: F005WorkId;
  readonly candidateSetSha256: Sha256;
  readonly primary: F005ReviewAuthorization;
  readonly secondary: F005ReviewAuthorization;
  readonly setSha256: Sha256;
}

export interface F005ReviewJudgment {
  readonly candidateId: string;
  readonly inputSha256: Sha256;
  readonly sourceAnchor: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly speaker: string | null;
}

export interface F005ReviewJudgmentArtifact {
  readonly __brand: 'F005ReviewJudgmentArtifact';
  readonly schemaVersion: '1.0.0';
  readonly authorizationId: string;
  readonly role: 'primary' | 'secondary';
  readonly principalId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly workId: F005WorkId;
  readonly candidateSetSha256: Sha256;
  readonly promptSha256: Sha256;
  readonly templateSha256: Sha256;
  readonly audience: string;
  readonly resultVisibility: 'sealed-private';
  readonly peerArtifactSha256: null;
  readonly sealedAt: string;
  readonly judgments: readonly F005ReviewJudgment[];
  readonly artifactSha256: Sha256;
}

export interface F005ReviewResolution {
  readonly candidateId: string;
  readonly inputSha256: Sha256;
  readonly sourceAnchor: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly speaker: string | null;
}

export interface F005Reconciliation {
  readonly __brand: 'F005Reconciliation';
  readonly schemaVersion: '1.0.0';
  readonly workId: F005WorkId;
  readonly candidateSetSha256: Sha256;
  readonly primaryArtifactSha256: Sha256;
  readonly secondaryArtifactSha256: Sha256;
  readonly resolutions: readonly F005ReviewResolution[];
  readonly reconciliationSha256: Sha256;
}

export interface F005ReviewAgreement {
  readonly __brand: 'F005ReviewAgreement';
  readonly kind: 'Agreement';
  readonly reconciliation: F005Reconciliation;
  readonly agreementSha256: Sha256;
}

export interface F005ReviewDispute {
  readonly __brand: 'F005ReviewDispute';
  readonly kind: 'Dispute';
  readonly workId: F005WorkId;
  readonly candidateSetSha256: Sha256;
  readonly mismatchDigest: Sha256;
  readonly disputeSha256: Sha256;
}

export interface F005SpeechRevision {
  readonly candidateId: string;
  readonly revision: number;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  readonly inputSha256: Sha256;
  readonly outputSha256: Sha256;
}

export interface F005SpeechRevisionItem {
  readonly candidateId: string;
  readonly workId: F005WorkId;
  readonly displayText: string;
  readonly speechText: string;
  readonly speechSha256: Sha256;
  readonly revisions: readonly F005SpeechRevision[];
}

export interface F005SpeechRevisionSet {
  readonly __brand: 'F005SpeechRevisionSet';
  readonly schemaVersion: '1.0.0';
  readonly workId: F005WorkId;
  readonly reconciliationSha256: Sha256;
  readonly items: readonly F005SpeechRevisionItem[];
  readonly speechRevisionSetSha256: Sha256;
}

export interface F005ReviewCoordinator {
  readonly __brand: 'F005ReviewCoordinator';
}

interface AuthorizationRecord {
  readonly canonicalAuthorization: string;
  readonly authorization: F005ReviewAuthorization;
  status: 'issued' | 'sealed' | 'consumed';
  canonicalJudgment: string | null;
}

interface CoordinatorState {
  readonly context: F005ApprovedBatchContext;
  readonly now: () => string;
  readonly nonce: () => string;
  readonly records: Map<string, AuthorizationRecord>;
  readonly usedNonces: Set<string>;
}

interface AuthorizationAssociation {
  readonly coordinator: F005ReviewCoordinator;
  readonly set: F005ReviewAuthorizationSet;
}

interface ReconciliationPrivate {
  readonly candidates: readonly CandidateWithRevisions[];
}

const coordinatorStates = new WeakMap<object, CoordinatorState>();
const authorizationAssociations = new WeakMap<object, AuthorizationAssociation>();
const reconciliationPrivate = new WeakMap<object, ReconciliationPrivate>();

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function dataRecord(
  value: unknown,
  keys: readonly string[],
  code: F005ReviewErrorCode = 'F005_REVIEW_AUTHORIZATION_INVALID',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new F005ReviewError(code, 'plain data objectが必要です');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !('value' in descriptor);
    }) ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new F005ReviewError(code, 'exact data schemaが必要です');
  }
  return value as Record<string, unknown>;
}

function assertPlainData(
  value: unknown,
  code: F005ReviewErrorCode = 'F005_REVIEW_AUTHORIZATION_INVALID',
  active = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (active.has(value)) {
    throw new F005ReviewError(code, '循環dataは禁止です');
  }
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new F005ReviewError(code, '配列prototypeが不正です');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => {
      if (typeof key !== 'string') return true;
      const descriptor = descriptors[key];
      return key !== 'length' && (!/^(?:0|[1-9]\d*)$/u.test(key) ||
        !descriptor || !('value' in descriptor));
    })) {
      throw new F005ReviewError(code, '配列accessorは禁止です');
    }
    for (const item of value) assertPlainData(item, code, active);
    active.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new F005ReviewError(code, 'object prototypeが不正です');
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new F005ReviewError(code, 'property descriptorが不正です');
    }
    if (!('value' in descriptor)) {
      throw new F005ReviewError(code, 'getter/setterは禁止です');
    }
    assertPlainData(descriptor.value, code, active);
  }
  active.delete(value);
}

function nonBlank(value: unknown, max = 32_768): value is string {
  return typeof value === 'string' && value === value.normalize('NFC') &&
    value.trim().length > 0 && [...value].length <= max &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || code === 11 || code === 12 ||
        (code >= 14 && code <= 31) || code === 127;
    });
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

function validateIdentity(value: unknown): asserts value is F005ReviewIdentity {
  const record = dataRecord(value, ['principalId', 'sessionId', 'runId']);
  if (![record.principalId, record.sessionId, record.runId].every((item) =>
    typeof item === 'string' && SAFE_ID.test(item))) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'review identityが不正です');
  }
}

function validatePromptTemplate(value: unknown): asserts value is F005ReviewPromptTemplate {
  const record = dataRecord(value, ['schemaVersion', 'prompt', 'template', 'tool']);
  if (record.schemaVersion !== '1.0.0' ||
    !nonBlank(record.prompt) || !nonBlank(record.template) || !nonBlank(record.tool)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'prompt/template/toolが不正です');
  }
}

function identityCollision(left: F005ReviewIdentity, right: F005ReviewIdentity): boolean {
  return left.principalId === right.principalId ||
    left.sessionId === right.sessionId ||
    left.runId === right.runId;
}

function sourceAnchor(candidate: CandidateWithRevisions): string {
  return `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`;
}

function validateRawCandidate(candidate: unknown, workId: string, sourceSha256: string): void {
  const record = dataRecord(candidate, [
    'workId', 'rawSourceSha256', 'order', 'rawTokenRange', 'tokens',
    'contextBefore', 'contextAfter', 'sourceAnchor', 'extractorVersion',
  ]);
  const range = dataRecord(record.rawTokenRange, ['start', 'end']);
  const anchor = dataRecord(record.sourceAnchor, ['bodySelector', 'startToken', 'endToken']);
  if (record.workId !== workId || record.rawSourceSha256 !== sourceSha256 ||
    !Number.isSafeInteger(record.order) || (record.order as number) < 0 ||
    !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
    (range.start as number) < 0 || (range.end as number) < (range.start as number) ||
    anchor.bodySelector !== '.main_text' ||
    !Number.isSafeInteger(anchor.startToken) || !Number.isSafeInteger(anchor.endToken) ||
    (anchor.startToken as number) < 0 || (anchor.endToken as number) < (anchor.startToken as number) ||
    !nonBlank(record.extractorVersion, 128) ||
    typeof record.contextBefore !== 'string' || typeof record.contextAfter !== 'string' ||
    !Array.isArray(record.tokens) || record.tokens.length === 0) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'candidate bindingが不正です');
  }
  for (const token of record.tokens) {
    if (token !== null && typeof token === 'object') {
      const typeDescriptor = Object.getOwnPropertyDescriptor(token, 'type');
      if (!typeDescriptor || !('value' in typeDescriptor)) {
        throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'token accessorは禁止です');
      }
      if (typeDescriptor.value === 'text') {
        const item = dataRecord(token, ['type', 'value']);
        if (typeof item.value !== 'string') throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'text tokenが不正です');
      } else if (typeDescriptor.value === 'ruby') {
        const item = dataRecord(token, ['type', 'base', 'reading']);
        if (!nonBlank(item.base) || !nonBlank(item.reading)) {
          throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'ruby tokenが不正です');
        }
      } else if (typeDescriptor.value === 'lineBreak') {
        dataRecord(token, ['type']);
      } else {
        throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'token typeが不正です');
      }
    } else {
      throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'tokenが不正です');
    }
  }
}

function normalizeCandidateSet(candidateSet: unknown, expectedWorkId: string): {
  readonly canonical: string;
  readonly sha256: Sha256;
  readonly candidates: readonly CandidateWithRevisions[];
  readonly bindings: readonly F005ReviewCandidateBinding[];
} {
  assertPlainData(candidateSet);
  const record = dataRecord(candidateSet, [
    'schemaVersion', 'workId', 'sourceSha256', 'extractorVersion', 'result',
  ]);
  if (record.schemaVersion !== '1.0.0' || record.workId !== expectedWorkId ||
    !SHA256.test(String(record.sourceSha256)) || !nonBlank(record.extractorVersion, 128)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'candidate set headerが不正です');
  }
  const result = dataRecord(record.result, ['ok', 'success', 'candidates', 'diagnostics']);
  if (result.ok !== true || result.success !== true ||
    !Array.isArray(result.candidates) || result.candidates.length === 0 ||
    !Array.isArray(result.diagnostics)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', '成功したcandidate setが必要です');
  }
  for (const diagnostic of result.diagnostics) {
    const descriptors = diagnostic !== null && typeof diagnostic === 'object'
      ? Object.keys(Object.getOwnPropertyDescriptors(diagnostic))
      : [];
    const item = dataRecord(diagnostic, descriptors.includes('element')
      ? ['code', 'message', 'element']
      : ['code', 'message']);
    if (!nonBlank(item.code, 128) || !nonBlank(item.message) ||
      (descriptors.includes('element') && !nonBlank(item.element))) {
      throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'diagnosticが不正です');
    }
  }
  const normalized: CandidateWithRevisions[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const raw of result.candidates) {
    validateRawCandidate(raw, expectedWorkId, String(record.sourceSha256));
    const candidate = normalizeBatchCandidate(
      raw as Parameters<typeof normalizeBatchCandidate>[0],
      DEFAULT_BATCH_SPEECH_RULES,
    );
    if (!nonBlank(candidate.candidateId, 128) ||
      !nonBlank(candidate.displayText) || !nonBlank(candidate.speechText) ||
      !SHA256.test(candidate.sha256) ||
      ids.has(candidate.candidateId) || orders.has(candidate.order)) {
      throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'candidate重複があります');
    }
    ids.add(candidate.candidateId);
    orders.add(candidate.order);
    normalized.push(candidate);
  }
  if (normalized.some((candidate, index) =>
    index > 0 && candidate.order <= normalized[index - 1]!.order)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'candidate順序が不正です');
  }
  const canonical = canonicalJson(candidateSet);
  const bindings = normalized.map((candidate) => Object.freeze({
    candidateId: candidate.candidateId,
    inputSha256: candidate.sha256,
    sourceAnchor: sourceAnchor(candidate),
  }));
  return {
    canonical,
    sha256: sha256(canonical),
    candidates: Object.freeze(normalized),
    bindings: Object.freeze(bindings),
  };
}

function stateOf(coordinator: F005ReviewCoordinator): CoordinatorState {
  const state = coordinatorStates.get(coordinator);
  if (!state) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'mint済みcoordinatorが必要です');
  }
  return state;
}

function associationOf(value: object): AuthorizationAssociation {
  const association = authorizationAssociations.get(value);
  if (!association) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'mint済みauthorizationが必要です');
  }
  return association;
}

function authorizationCore(
  authorization: Omit<F005ReviewAuthorization, '__brand' | 'authorizationSha256'>,
): Omit<F005ReviewAuthorization, '__brand' | 'authorizationSha256'> {
  return authorization;
}

function createAuthorization(
  state: CoordinatorState,
  role: 'primary' | 'secondary',
  producer: F005ReviewIdentity,
  reviewer: F005ReviewIdentity,
  workId: F005WorkId,
  candidate: ReturnType<typeof normalizeCandidateSet>,
  promptTemplate: F005ReviewPromptTemplate,
  audience: string,
  issuedAt: string,
  expiresAt: string,
): F005ReviewAuthorization {
  const nonce = state.nonce();
  if (!SAFE_ID.test(nonce) || state.usedNonces.has(nonce)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'nonceが不正または再利用されています');
  }
  state.usedNonces.add(nonce);
  const promptSha256 = sha256(promptTemplate.prompt);
  const templateSha256 = sha256(promptTemplate.template);
  const toolSha256 = sha256(promptTemplate.tool);
  const policySha256 = sha256(canonicalJson(state.context.policy));
  const authorizationId = `F005:${workId}:${role}:${sha256(`${nonce}\0${candidate.sha256}`).slice(0, 24)}`;
  const core = authorizationCore({
    schemaVersion: '1.0.0',
    authorizationId,
    feature: 'F005',
    batchId: 'F005',
    workId,
    role,
    producer: Object.freeze({ ...producer }),
    reviewer: Object.freeze({ ...reviewer }),
    candidateSetSha256: candidate.sha256,
    candidateBindings: candidate.bindings,
    policySha256,
    toolSha256,
    promptSha256,
    templateSha256,
    issuedAt,
    expiresAt,
    audience,
    resultVisibility: 'blind-private',
    nonce,
  });
  const authorization = deepFreeze({
    __brand: 'F005ReviewAuthorization' as const,
    ...core,
    authorizationSha256: sha256(canonicalJson(core)),
  });
  authorizations.add(authorization);
  state.records.set(authorizationId, {
    canonicalAuthorization: canonicalJson(authorization),
    authorization,
    status: 'issued',
    canonicalJudgment: null,
  });
  return authorization;
}

/**
 * F005 approval contextに結合したreview coordinatorをmintする。
 * @des DES-F005-005 @fun FUN-F005-011 @ut UT-F005-011
 */
export function createF005ReviewCoordinator(
  context: F005ApprovedBatchContext,
  options: {
    readonly now?: () => string;
    readonly nonce?: () => string;
  } = {},
): F005ReviewCoordinator {
  if (!isMintedF005ApprovedBatchContext(context)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'mint済みF005 contextが必要です');
  }
  const coordinator = Object.freeze({ __brand: 'F005ReviewCoordinator' as const });
  coordinatorStates.set(coordinator, {
    context,
    now: options.now ?? (() => new Date().toISOString()),
    nonce: options.nonce ?? (() => randomBytes(24).toString('base64url')),
    records: new Map(),
    usedNonces: new Set(),
  });
  return coordinator;
}

/**
 * producerから独立したprimary/secondaryへblind authorizationだけを発行する。
 * @des DES-F005-005 @fun FUN-F005-011 @ut UT-F005-011
 */
export function issueF005ReviewAuthorizations(
  coordinator: F005ReviewCoordinator,
  producer: F005ReviewIdentity,
  candidateSet: F005CandidateSet,
  workId: F005WorkId,
  primary: F005ReviewIdentity,
  secondary: F005ReviewIdentity,
  promptTemplate: F005ReviewPromptTemplate,
  audience: string,
  expiresAt: string,
): F005ReviewAuthorizationSet {
  const state = stateOf(coordinator);
  validateIdentity(producer);
  validateIdentity(primary);
  validateIdentity(secondary);
  validatePromptTemplate(promptTemplate);
  if (identityCollision(producer, primary) || identityCollision(producer, secondary) ||
    identityCollision(primary, secondary) || !nonBlank(audience, 512) ||
    !state.context.definition.workIds.includes(workId)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', '独立review identity/work/audienceが不正です');
  }
  const issuedAt = state.now();
  if (!validInstant(issuedAt) || !validInstant(expiresAt) ||
    Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'authorization期限が不正です');
  }
  const candidate = normalizeCandidateSet(candidateSet, workId);
  const primaryAuthorization = createAuthorization(
    state, 'primary', producer, primary, workId, candidate,
    promptTemplate, audience, issuedAt, expiresAt,
  );
  let secondaryAuthorization: F005ReviewAuthorization;
  try {
    secondaryAuthorization = createAuthorization(
      state, 'secondary', producer, secondary, workId, candidate,
      promptTemplate, audience, issuedAt, expiresAt,
    );
  } catch (error) {
    state.records.delete(primaryAuthorization.authorizationId);
    state.usedNonces.delete(primaryAuthorization.nonce);
    throw error;
  }
  const setCore = {
    schemaVersion: '1.0.0' as const,
    workId,
    candidateSetSha256: candidate.sha256,
    primaryAuthorizationSha256: primaryAuthorization.authorizationSha256,
    secondaryAuthorizationSha256: secondaryAuthorization.authorizationSha256,
  };
  const set = deepFreeze({
    __brand: 'F005ReviewAuthorizationSet' as const,
    schemaVersion: '1.0.0' as const,
    workId,
    candidateSetSha256: candidate.sha256,
    primary: primaryAuthorization,
    secondary: secondaryAuthorization,
    setSha256: sha256(canonicalJson(setCore)),
  });
  authorizationSets.add(set);
  authorizationAssociations.set(set, { coordinator, set });
  authorizationAssociations.set(primaryAuthorization, { coordinator, set });
  authorizationAssociations.set(secondaryAuthorization, { coordinator, set });
  return set;
}

function validateJudgments(
  value: unknown,
  authorization: F005ReviewAuthorization,
): readonly F005ReviewJudgment[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== authorization.candidateBindings.length) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'judgment件数がcandidateと一致しません');
  }
  const seen = new Set<string>();
  const judgments: F005ReviewJudgment[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = dataRecord(value[index], [
      'candidateId', 'inputSha256', 'sourceAnchor', 'decision', 'reasonCode', 'speaker',
    ], 'F005_REVIEW_RESULT_INVALID');
    const expected = authorization.candidateBindings[index];
    if (!expected || item.candidateId !== expected.candidateId ||
      item.inputSha256 !== expected.inputSha256 || item.sourceAnchor !== expected.sourceAnchor ||
      !DECISIONS.has(String(item.decision)) || !nonBlank(item.reasonCode, 128) ||
      !(item.speaker === null || nonBlank(item.speaker, 512)) ||
      seen.has(String(item.candidateId))) {
      throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'judgmentのexact joinが不正です');
    }
    seen.add(String(item.candidateId));
    judgments.push(Object.freeze({ ...item }) as unknown as F005ReviewJudgment);
  }
  return Object.freeze(judgments);
}

/**
 * reviewerの結果を自身のauthorizationへ一度だけsealする。peer結果は入力できない。
 */
export function sealF005ReviewJudgment(
  authorization: F005ReviewAuthorization,
  judgments: readonly F005ReviewJudgment[],
): F005ReviewJudgmentArtifact {
  if (!authorizations.has(authorization)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'authorization cloneは使用できません');
  }
  const association = associationOf(authorization);
  const state = stateOf(association.coordinator);
  const record = state.records.get(authorization.authorizationId);
  if (!record || record.canonicalAuthorization !== canonicalJson(authorization)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'canonical authorizationが一致しません');
  }
  if (record.status !== 'issued') {
    throw new F005ReviewError('F005_REVIEW_REPLAY', 'authorizationは既にsealまたは消費済みです');
  }
  const actualSealedAt = state.now();
  if (!validInstant(actualSealedAt) ||
    Date.parse(actualSealedAt) < Date.parse(authorization.issuedAt) ||
    Date.parse(actualSealedAt) >= Date.parse(authorization.expiresAt)) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'seal時刻がauthorization期間外です');
  }
  assertPlainData(judgments, 'F005_REVIEW_RESULT_INVALID');
  const normalized = validateJudgments(judgments, authorization);
  const core = {
    schemaVersion: '1.0.0' as const,
    authorizationId: authorization.authorizationId,
    role: authorization.role,
    principalId: authorization.reviewer.principalId,
    sessionId: authorization.reviewer.sessionId,
    runId: authorization.reviewer.runId,
    workId: authorization.workId,
    candidateSetSha256: authorization.candidateSetSha256,
    promptSha256: authorization.promptSha256,
    templateSha256: authorization.templateSha256,
    audience: authorization.audience,
    resultVisibility: 'sealed-private' as const,
    peerArtifactSha256: null,
    sealedAt: actualSealedAt,
    judgments: normalized,
  };
  const artifact = deepFreeze({
    __brand: 'F005ReviewJudgmentArtifact' as const,
    ...core,
    artifactSha256: sha256(canonicalJson(core)),
  });
  record.status = 'sealed';
  record.canonicalJudgment = canonicalJson(artifact);
  judgmentArtifacts.add(artifact);
  authorizationAssociations.set(artifact, association);
  return artifact;
}

function parseCanonicalJudgment(
  record: AuthorizationRecord,
  expected: F005ReviewJudgmentArtifact,
): F005ReviewJudgmentArtifact {
  if (!record.canonicalJudgment) {
    throw new F005ReviewError('F005_REVIEW_INCOMPLETE', 'review結果が未sealです');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.canonicalJudgment);
  } catch (error) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'canonical judgmentを再読込できません', { cause: error });
  }
  assertPlainData(parsed, 'F005_REVIEW_RESULT_INVALID');
  if (canonicalJson(parsed) !== record.canonicalJudgment ||
    canonicalJson(expected) !== record.canonicalJudgment) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'caller judgmentとcanonical artifactが一致しません');
  }
  const artifact = parsed as F005ReviewJudgmentArtifact;
  const { __brand: brand, artifactSha256, ...core } = artifact;
  if (brand !== 'F005ReviewJudgmentArtifact' || artifactSha256 !== sha256(canonicalJson(core))) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'judgment sealが不正です');
  }
  validateJudgments(artifact.judgments, record.authorization);
  return artifact;
}

function sameSemantic(left: F005ReviewJudgment, right: F005ReviewJudgment): boolean {
  return left.candidateId === right.candidateId &&
    left.inputSha256 === right.inputSha256 &&
    left.sourceAnchor === right.sourceAnchor &&
    left.decision === right.decision &&
    left.reasonCode === right.reasonCode &&
    left.speaker === right.speaker;
}

/**
 * canonical primary/secondaryを再読込し、両authorizationを一回限りCAS消費する。
 * @des DES-F005-005 @fun FUN-F005-012 @ut UT-F005-012
 */
export function reconcileF005PrimarySecondary(
  context: F005ApprovedBatchContext,
  candidateSet: F005CandidateSet,
  primary: F005ReviewJudgmentArtifact | null,
  secondary: F005ReviewJudgmentArtifact | null,
  authorizationSet: F005ReviewAuthorizationSet,
): F005ReviewAgreement | F005ReviewDispute {
  if (!isMintedF005ApprovedBatchContext(context) || !authorizationSets.has(authorizationSet)) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'mint済みcontext/authorization setが必要です');
  }
  const association = associationOf(authorizationSet);
  const state = stateOf(association.coordinator);
  if (state.context !== context) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'approval contextが発行時と異なります');
  }
  if (primary === null || secondary === null) {
    throw new F005ReviewError('F005_REVIEW_INCOMPLETE', 'primary/secondaryの両方が必要です');
  }
  if (!judgmentArtifacts.has(primary) || !judgmentArtifacts.has(secondary) ||
    associationOf(primary).set !== authorizationSet ||
    associationOf(secondary).set !== authorizationSet) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'judgment clone/cross-setを拒否しました');
  }
  const candidate = normalizeCandidateSet(candidateSet, authorizationSet.workId);
  if (candidate.sha256 !== authorizationSet.candidateSetSha256) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'candidate setが発行時と異なります');
  }
  const primaryRecord = state.records.get(authorizationSet.primary.authorizationId);
  const secondaryRecord = state.records.get(authorizationSet.secondary.authorizationId);
  if (!primaryRecord || !secondaryRecord) {
    throw new F005ReviewError('F005_REVIEW_AUTHORIZATION_INVALID', 'authorization recordが欠落しています');
  }
  if (primaryRecord.status === 'consumed' || secondaryRecord.status === 'consumed') {
    throw new F005ReviewError('F005_REVIEW_REPLAY', 'authorizationは消費済みです');
  }
  if (primaryRecord.status !== 'sealed' || secondaryRecord.status !== 'sealed') {
    throw new F005ReviewError('F005_REVIEW_INCOMPLETE', 'primary/secondaryのsealが未完了です');
  }
  const now = state.now();
  if (!validInstant(now) || Date.parse(now) >= Date.parse(authorizationSet.primary.expiresAt) ||
    Date.parse(now) >= Date.parse(authorizationSet.secondary.expiresAt)) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'authorizationが期限切れです');
  }
  const trustedPrimary = parseCanonicalJudgment(primaryRecord, primary);
  const trustedSecondary = parseCanonicalJudgment(secondaryRecord, secondary);
  if (trustedPrimary.role !== 'primary' || trustedSecondary.role !== 'secondary' ||
    Date.parse(now) < Date.parse(trustedPrimary.sealedAt) ||
    Date.parse(now) < Date.parse(trustedSecondary.sealedAt)) {
    throw new F005ReviewError('F005_REVIEW_RESULT_INVALID', 'primary/secondary roleが逆です');
  }

  // Single-threaded compare-and-swap: validation above observes both "sealed"; this is the only transition.
  primaryRecord.status = 'consumed';
  secondaryRecord.status = 'consumed';

  const mismatches = trustedPrimary.judgments
    .map((judgment, index) => sameSemantic(judgment, trustedSecondary.judgments[index]!)
      ? null
      : {
          candidateId: judgment.candidateId,
          primary: judgment,
          secondary: trustedSecondary.judgments[index],
        })
    .filter((value) => value !== null);
  if (mismatches.length !== 0) {
    const mismatchDigest = sha256(canonicalJson(mismatches));
    const core = {
      kind: 'Dispute' as const,
      workId: authorizationSet.workId,
      candidateSetSha256: candidate.sha256,
      primaryArtifactSha256: trustedPrimary.artifactSha256,
      secondaryArtifactSha256: trustedSecondary.artifactSha256,
      mismatchDigest,
    };
    const dispute = deepFreeze({
      __brand: 'F005ReviewDispute' as const,
      kind: 'Dispute' as const,
      workId: authorizationSet.workId,
      candidateSetSha256: candidate.sha256,
      mismatchDigest,
      disputeSha256: sha256(canonicalJson(core)),
    });
    disputes.add(dispute);
    return dispute;
  }

  const resolutions = Object.freeze(trustedPrimary.judgments.map((judgment) =>
    Object.freeze({ ...judgment })));
  const reconciliationCore = {
    schemaVersion: '1.0.0' as const,
    workId: authorizationSet.workId,
    candidateSetSha256: candidate.sha256,
    primaryArtifactSha256: trustedPrimary.artifactSha256,
    secondaryArtifactSha256: trustedSecondary.artifactSha256,
    resolutions,
  };
  const reconciliation = deepFreeze({
    __brand: 'F005Reconciliation' as const,
    ...reconciliationCore,
    reconciliationSha256: sha256(canonicalJson(reconciliationCore)),
  });
  reconciliations.add(reconciliation);
  reconciliationPrivate.set(reconciliation, { candidates: candidate.candidates });
  const agreement = deepFreeze({
    __brand: 'F005ReviewAgreement' as const,
    kind: 'Agreement' as const,
    reconciliation,
    agreementSha256: sha256(canonicalJson({
      kind: 'Agreement',
      reconciliationSha256: reconciliation.reconciliationSha256,
    })),
  });
  agreements.add(agreement);
  return agreement;
}

function validRevisionText(value: unknown): value is string {
  return nonBlank(value) && value === value.normalize('NFC');
}

/**
 * Agreementに結合したapproved候補だけへ連続speech revisionを適用する。
 * display textはcanonical candidateから再投影し、caller入力を受けない。
 * @des DES-F005-005 @fun FUN-F005-013 @ut UT-F005-013
 */
export function buildF005SpeechRevisions(
  reconciliation: F005Reconciliation,
  revisionEntries: readonly F005SpeechRevision[],
): F005SpeechRevisionSet {
  if (!reconciliations.has(reconciliation)) {
    throw new F005ReviewError('F005_SPEECH_REVISION_INVALID', 'Agreement由来のreconciliationが必要です');
  }
  assertPlainData(revisionEntries, 'F005_SPEECH_REVISION_INVALID');
  const privateState = reconciliationPrivate.get(reconciliation);
  if (!privateState) {
    throw new F005ReviewError('F005_SPEECH_REVISION_INVALID', 'candidate bindingがありません');
  }
  const approvedIds = new Set(reconciliation.resolutions
    .filter((resolution) => resolution.decision === 'approved')
    .map((resolution) => resolution.candidateId));
  const byCandidate = new Map<string, F005SpeechRevision[]>();
  for (const value of revisionEntries) {
    const entry = dataRecord(value, [
      'candidateId', 'revision', 'before', 'after', 'reason', 'inputSha256', 'outputSha256',
    ], 'F005_SPEECH_REVISION_INVALID');
    if (!approvedIds.has(String(entry.candidateId)) ||
      !Number.isSafeInteger(entry.revision) || (entry.revision as number) <= 0 ||
      !validRevisionText(entry.before) || !validRevisionText(entry.after) ||
      !nonBlank(entry.reason) || !SHA256.test(String(entry.inputSha256)) ||
      !SHA256.test(String(entry.outputSha256))) {
      throw new F005ReviewError('F005_SPEECH_REVISION_INVALID', 'speech revision schema/bindingが不正です');
    }
    const normalized = Object.freeze({ ...entry }) as unknown as F005SpeechRevision;
    const bucket = byCandidate.get(normalized.candidateId) ?? [];
    bucket.push(normalized);
    byCandidate.set(normalized.candidateId, bucket);
  }
  const items = privateState.candidates
    .filter((candidate) => approvedIds.has(candidate.candidateId))
    .map((candidate): F005SpeechRevisionItem => {
      const chain = byCandidate.get(candidate.candidateId) ?? [];
      let speechText = candidate.speechText;
      const seenHashes = new Set<Sha256>([sha256(speechText)]);
      for (let index = 0; index < chain.length; index += 1) {
        const revision = chain[index]!;
        const inputSha256 = sha256(speechText);
        const outputSha256 = sha256(revision.after);
        if (revision.revision !== index + 1 ||
          revision.before !== speechText || revision.inputSha256 !== inputSha256 ||
          revision.outputSha256 !== outputSha256 || seenHashes.has(outputSha256)) {
          throw new F005ReviewError('F005_SPEECH_REVISION_INVALID', 'revision chainが断絶または循環しています');
        }
        speechText = revision.after;
        seenHashes.add(outputSha256);
      }
      return deepFreeze({
        candidateId: candidate.candidateId,
        workId: candidate.workId as F005WorkId,
        displayText: candidate.displayText,
        speechText,
        speechSha256: sha256(speechText),
        revisions: chain.map((revision) => Object.freeze({ ...revision })),
      });
    });
  const core = {
    schemaVersion: '1.0.0' as const,
    workId: reconciliation.workId,
    reconciliationSha256: reconciliation.reconciliationSha256,
    items,
  };
  const result = deepFreeze({
    __brand: 'F005SpeechRevisionSet' as const,
    ...core,
    speechRevisionSetSha256: sha256(canonicalJson(core)),
  });
  revisionSets.add(result);
  return result;
}

export function isMintedF005ReviewAgreement(value: unknown): value is F005ReviewAgreement {
  return value !== null && typeof value === 'object' && agreements.has(value);
}

export function isMintedF005ReviewDispute(value: unknown): value is F005ReviewDispute {
  return value !== null && typeof value === 'object' && disputes.has(value);
}

export function isMintedF005SpeechRevisionSet(value: unknown): value is F005SpeechRevisionSet {
  return value !== null && typeof value === 'object' && revisionSets.has(value);
}
