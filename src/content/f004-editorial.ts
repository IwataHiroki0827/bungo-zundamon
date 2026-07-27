import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from './artifacts.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  normalizeBatchCandidate,
  type CandidateWithRevisions,
} from './batch-production.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';
import {
  hashEditorialCandidates,
  reconcileIndependentJudgments,
  registerEditorialAuthorizations,
  sealAndValidateEditorialJudgmentSet,
  type EditorialCandidate,
  type EditorialJudgmentExternalResult,
  type EditorialJudgmentSet,
  type EditorialResolutionSet,
  type ReviewRunAuthorization,
} from './editorial-independent.ts';
import {
  loadAndVerifyFixedF004Source,
  observeF004RightsSelection,
  type FixedF004Source,
} from './f004-source.ts';
import {
  EXTRACTOR_VERSION,
  extractDialogueCandidates,
  type Candidate,
  type RawCandidate,
} from './processing.ts';

const F004_WORK_IDS = new Set(['000466', '045679', '001918']);
const SHA256 = /^[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

export type F004EditorialErrorCode =
  | 'EXTRACTION_NON_DETERMINISTIC'
  | 'F004_EXTRACTION_INVALID'
  | 'F004_REVIEW_AUTHORIZATION_INVALID'
  | 'F004_REVIEW_PENDING'
  | 'SPEECH_REVISION_CHAIN_INVALID';

export class F004EditorialError extends Error {
  constructor(public readonly code: F004EditorialErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F004EditorialError';
  }
}

export interface F004CandidateSet {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'f004-dialogue-candidate-set';
  readonly batchId: 'F004';
  readonly workId: string;
  readonly sourceSha256: Sha256;
  readonly rawSourceSha256: Sha256;
  readonly extractorVersion: string;
  readonly normalizerVersion: string;
  readonly candidates: readonly CandidateWithRevisions[];
  readonly reviewCandidates: readonly EditorialCandidate[];
  readonly reviewCandidateSetSha256: Sha256;
}

export interface PreparedF004CandidateArtifact {
  readonly artifact: F004CandidateSet;
  readonly candidatePath: WorkspaceRelativePath;
  readonly candidateSha256: Sha256;
  readonly reviewInputPath: WorkspaceRelativePath;
  readonly reviewInputSha256: Sha256;
}

export interface F004SpeechRevision {
  readonly candidateId: string;
  readonly revision: number;
  readonly before: string;
  readonly beforeSha256: Sha256 | string;
  readonly after: string;
  readonly afterSha256: Sha256 | string;
  readonly reason: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
}

export interface F004SpeechItem extends Candidate {
  readonly speechSha256: Sha256;
  readonly revisions: readonly F004SpeechRevision[];
}

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

function reviewCandidate(candidate: CandidateWithRevisions): EditorialCandidate {
  return Object.freeze({
    candidateId: candidate.candidateId,
    inputSha256: candidate.sha256,
    sourceAnchor:
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
  });
}

function validateFixedSource(source: FixedF004Source, extractorVersion: string): void {
  if (
    source.__brand !== 'FixedF004Source' ||
    !F004_WORK_IDS.has(source.work.workId) ||
    source.decoded.workId !== source.work.workId ||
    source.decoded.rawSha256 !== source.work.rawSha256 ||
    source.bodySelector !== '.main_text' ||
    !SHA256.test(source.sourceSha256) ||
    extractorVersion !== EXTRACTOR_VERSION
  ) {
    throw new F004EditorialError('F004_EXTRACTION_INVALID', '固定原典または抽出器versionが不正です');
  }
}

function normalizeCandidates(raw: readonly RawCandidate[]): readonly CandidateWithRevisions[] {
  return Object.freeze(raw.map((candidate) =>
    normalizeBatchCandidate(candidate, DEFAULT_BATCH_SPEECH_RULES)));
}

/**
 * 固定済み原典の本文DOMから外側の「」だけを二度抽出し、同一結果だけを候補化する。
 * @des DES-F004-004 @fun FUN-F004-008 @ut UT-F004-008
 */
export function extractF004DialogueCandidates(
  source: FixedF004Source,
  extractorVersion: string = EXTRACTOR_VERSION,
): F004CandidateSet {
  validateFixedSource(source, extractorVersion);
  const allowed = new Set([source.work.workId]);
  const first = extractDialogueCandidates(source.decoded, source.work.workId, allowed);
  const second = extractDialogueCandidates(source.decoded, source.work.workId, allowed);
  if (!first.ok || !second.ok) {
    throw new F004EditorialError(
      'F004_EXTRACTION_INVALID',
      `本文抽出に失敗しました: ${canonicalJson(first.diagnostics)}`,
    );
  }
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new F004EditorialError(
      'EXTRACTION_NON_DETERMINISTIC',
      '同じ固定原典に対する二回の抽出結果が一致しません',
    );
  }
  const candidates = normalizeCandidates(first.candidates);
  if (candidates.length === 0) {
    throw new F004EditorialError('F004_EXTRACTION_INVALID', '台詞候補が0件です');
  }
  const reviewCandidates = Object.freeze(candidates.map(reviewCandidate));
  return deepFreeze({
    schemaVersion: '1.0.0' as const,
    kind: 'f004-dialogue-candidate-set' as const,
    batchId: 'F004' as const,
    workId: source.work.workId,
    sourceSha256: source.sourceSha256 as Sha256,
    rawSourceSha256: source.work.rawSha256 as Sha256,
    extractorVersion,
    normalizerVersion: DEFAULT_BATCH_SPEECH_RULES.version,
    candidates,
    reviewCandidates,
    reviewCandidateSetSha256: hashEditorialCandidates(reviewCandidates),
  });
}

/**
 * レビュー担当が読む正規化候補配列と、そのhashへ結合したreview inputをcanonical JSONで保存する。
 * judgmentは生成しない。
 */
export async function prepareF004CandidateArtifact(
  workspace: string,
  workId: string,
): Promise<PreparedF004CandidateArtifact> {
  const rights = await observeF004RightsSelection(workspace);
  const source = await loadAndVerifyFixedF004Source(workspace, workId, rights);
  const artifact = extractF004DialogueCandidates(source);
  const candidatePath =
    `data/batches/F004/work-artifacts/${workId}/intermediate/${workId}/candidates.json` as WorkspaceRelativePath;
  const reviewInputPath =
    `content/batches/F004/review-inputs/${workId}.json` as WorkspaceRelativePath;
  await writeJsonArtifactAtomic(
    workspace,
    join(resolve(workspace), ...candidatePath.split('/')),
    artifact.candidates,
  );
  await writeJsonArtifactAtomic(
    workspace,
    join(resolve(workspace), ...reviewInputPath.split('/')),
    artifact,
  );
  return Object.freeze({
    artifact,
    candidatePath,
    candidateSha256: sha256(canonicalJson(artifact.candidates)),
    reviewInputPath,
    reviewInputSha256: sha256(canonicalJson(artifact)),
  });
}

function validateF004Authorization(authorization: ReviewRunAuthorization): void {
  const expectedPrefix = `f004-`;
  const candidateRefs = authorization.inputRefs.filter((reference) => reference.kind === 'candidateSet');
  const expectedWork = authorization.authorizationId.match(/^f004-([0-9]{6})-(primary|secondary|adjudicator)$/u);
  if (
    !authorization.authorizationId.startsWith(expectedPrefix) ||
    !expectedWork ||
    authorization.role !== expectedWork[2] ||
    authorization.judgeRole !== authorization.role ||
    !F004_WORK_IDS.has(expectedWork[1]!) ||
    candidateRefs.length !== 1 ||
    candidateRefs[0]?.path !==
      `data/batches/F004/work-artifacts/${expectedWork[1]}/intermediate/${expectedWork[1]}/candidates.json` ||
    authorization.candidates.some((candidate) => !candidate.sourceAnchor.startsWith('.main_text:')) ||
    hashEditorialCandidates(authorization.candidates) !== authorization.candidateSetSha256
  ) {
    throw new F004EditorialError(
      'F004_REVIEW_AUTHORIZATION_INVALID',
      'F004 feature/batch/work/role/candidate authorization tupleが不正です',
    );
  }
}

/**
 * F004のexact input tupleへ結合したauthorizationだけをtrusted storeへ登録する。
 */
export async function registerF004ReviewAuthorizations(
  workspace: string,
  authorizations: readonly ReviewRunAuthorization[],
): Promise<void> {
  for (const authorization of authorizations) validateF004Authorization(authorization);
  await registerEditorialAuthorizations(workspace, authorizations);
}

/**
 * 独立reviewerの外部結果をF004 authorizationへexact joinし、CAS transactionでsealする。
 * @des DES-F004-004 @fun FUN-F004-009 @ut UT-F004-009
 */
export async function sealF004JudgmentSet(
  workspace: string,
  authorization: ReviewRunAuthorization,
  externalResult: EditorialJudgmentExternalResult,
): Promise<EditorialJudgmentSet> {
  validateF004Authorization(authorization);
  try {
    return await sealAndValidateEditorialJudgmentSet(workspace, authorization, externalResult);
  } catch (error) {
    throw new F004EditorialError(
      'F004_REVIEW_AUTHORIZATION_INVALID',
      'F004 review resultをauthorizationへsealできません',
      { cause: error },
    );
  }
}

/**
 * primary/secondaryのsemantic一致、または独立adjudicationだけを最終確定する。
 * @des DES-F004-004 @fun FUN-F004-010 @ut UT-F004-010
 */
export function reconcileF004Judgments(
  candidates: readonly EditorialCandidate[],
  primary: EditorialJudgmentSet,
  secondary: EditorialJudgmentSet,
  adjudication?: EditorialJudgmentSet,
): EditorialResolutionSet {
  let result: EditorialResolutionSet;
  try {
    result = reconcileIndependentJudgments(candidates, primary, secondary, adjudication);
  } catch (error) {
    throw new F004EditorialError(
      'F004_REVIEW_PENDING',
      'F004独立レビューを照合できません',
      { cause: error },
    );
  }
  if (result.pendingIds.length !== 0) {
    throw new F004EditorialError(
      'F004_REVIEW_PENDING',
      `第三裁定が必要な候補があります: ${result.pendingIds.join(',')}`,
    );
  }
  return result;
}

function validRevisionText(value: string): boolean {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  return value.trim().length > 0 && [...value].length <= 32_768 &&
    !hasControl && !/[\uD800-\uDFFF]/u.test(value);
}

/**
 * display textを変更せず、speechのbefore/after hash chainだけを連続適用する。
 * @des DES-F004-004 @fun FUN-F004-011 @ut UT-F004-011
 */
export function compileF004SpeechRevisions(
  approved: readonly CandidateWithRevisions[],
  revisions: readonly F004SpeechRevision[],
): readonly F004SpeechItem[] {
  const byCandidate = new Map<string, F004SpeechRevision[]>();
  for (const revision of revisions) {
    const current = byCandidate.get(revision.candidateId) ?? [];
    current.push(revision);
    byCandidate.set(revision.candidateId, current);
  }
  if ([...byCandidate.keys()].some((candidateId) =>
    !approved.some((candidate) => candidate.candidateId === candidateId))) {
    throw new F004EditorialError('SPEECH_REVISION_CHAIN_INVALID', '別candidateのspeech revisionがあります');
  }
  return Object.freeze(approved.map((candidate): F004SpeechItem => {
    const chain = byCandidate.get(candidate.candidateId) ?? [];
    let speechText = candidate.speechText;
    const seen = new Set([sha256(speechText)]);
    for (let index = 0; index < chain.length; index += 1) {
      const revision = chain[index]!;
      const beforeSha256 = sha256(revision.before);
      const afterSha256 = sha256(revision.after.normalize('NFC'));
      if (
        revision.revision !== index + 1 ||
        revision.before !== speechText ||
        revision.beforeSha256 !== beforeSha256 ||
        revision.afterSha256 !== afterSha256 ||
        !validRevisionText(revision.after) ||
        !revision.reason.trim() ||
        !revision.reviewer.trim() ||
        !RFC3339.test(revision.reviewedAt) ||
        !Number.isFinite(Date.parse(revision.reviewedAt)) ||
        seen.has(afterSha256)
      ) {
        throw new F004EditorialError(
          'SPEECH_REVISION_CHAIN_INVALID',
          `speech revision chainが不正です: ${candidate.candidateId}`,
        );
      }
      speechText = revision.after.normalize('NFC');
      seen.add(afterSha256);
    }
    return deepFreeze({
      candidateId: candidate.candidateId,
      workId: candidate.workId,
      rawSourceSha256: candidate.rawSourceSha256,
      order: candidate.order,
      rawTokenRange: { ...candidate.rawTokenRange },
      displayText: candidate.displayText,
      speechText,
      contextBefore: candidate.contextBefore,
      contextAfter: candidate.contextAfter,
      sourceAnchor: { ...candidate.sourceAnchor },
      extractorVersion: candidate.extractorVersion,
      normalizerVersion: candidate.normalizerVersion,
      speechSha256: sha256(speechText),
      revisions: chain.map((revision) => ({ ...revision })),
    });
  }));
}
