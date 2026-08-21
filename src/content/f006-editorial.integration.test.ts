import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from './batch-candidate.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  normalizeBatchCandidate,
} from './batch-production.ts';
import {
  EDITORIAL_TRANSACTION_ROOT,
  EditorialIndependentError,
  hashEditorialCandidates,
  hashEditorialJudgmentArtifact,
  loadAndVerifyEditorialJudgmentSets,
  reconcileIndependentJudgments,
  registerEditorialAuthorizations,
  sealAndValidateEditorialJudgmentSet,
  verifyEditorialCompleteness,
  type EditorialCandidate,
  type EditorialJudgment,
  type EditorialJudgmentExternalResult,
  type EditorialJudgmentSet,
  type ReviewRunAuthorization,
} from './editorial-independent.ts';
import { applySpeechRevisions, F003ReuseError, type SpeechRevisionV2 } from './f003-reuse.ts';
import { EXTRACTOR_VERSION } from './processing.ts';
import type { Sha256 } from './batch.ts';
import {
  extractF006DialogueCandidates,
  normalizeF006AozoraXhtmlEntities,
  parseF006SourceRecord,
  rehydrateF006SelectionSnapshot,
} from './f006-source.ts';

/**
 * IT-F006-004: 独立二重判定・裁定・読み補正の全件完結。
 * 既存`editorial-independent.ts`・`f003-reuse.ts`の各関数へ、実際に
 * 永続化済みのF006（山月記, 000624）候補を投入し、pending: 0までの完結と
 * display text不変のspeech text生成を確認する。F006固有の新規wrapperは
 * 使わず、`scripts/f006-prepare-editorial.ts`と同じ既存関数呼び出しで検証する。
 * @des DES-F006-006 DES-F006-007 @fun FUN-F006-007 FUN-F006-008 @ut UT-F006-007 UT-F006-008
 */

const workspace = resolve('.');
const roots: string[] = [];
const H = (value: string) => createHash('sha256').update(value).digest('hex') as Sha256;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-f006-it-004-'));
  roots.push(root);
  await mkdir(join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/')), { recursive: true });
  return root;
}

async function realWorkCandidates(): Promise<readonly EditorialCandidate[]> {
  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F006.ref,
    BATCH_DEFINITION_REFS.F006.sha256,
    APPROVAL_POLICY_REFS.F006.ref,
    APPROVAL_POLICY_REFS.F006.sha256,
  );
  const snapshot = await rehydrateF006SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === '000624')!;
  const record = parseF006SourceRecord(workSnapshot, '000624');
  const normalization = normalizeF006AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF006DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
  expect(extracted.result.ok).toBe(true);
  const candidates = extracted.result.candidates
    .map((raw) => normalizeBatchCandidate(raw, DEFAULT_BATCH_SPEECH_RULES))
    .sort((left, right) => left.order - right.order);
  expect(candidates).toHaveLength(3);
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    candidateId: candidate.candidateId,
    inputSha256: candidate.sha256,
    sourceAnchor:
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
  })));
}

function authorization(
  root: string,
  role: ReviewRunAuthorization['role'],
  candidates: readonly EditorialCandidate[],
  extraRefs: ReviewRunAuthorization['inputRefs'] = [],
): ReviewRunAuthorization {
  void root;
  return Object.freeze({
    authorizationId: `it-f006-004-${role}`,
    role,
    producerTaskPath: `/root/it-f006-004/${role}`,
    judgeRole: role,
    runId: `it-f006-004-${role}-run`,
    candidateSetSha256: hashEditorialCandidates(candidates),
    policySha256: H('policy'),
    promptSha256: H(`prompt-${role}`),
    toolSha256: H('tool'),
    nonce: `it-f006-004-${role}-nonce`,
    issuedAt: '2026-08-22T00:00:00.000Z',
    inputRefs: extraRefs,
    candidates,
  });
}

function external(auth: ReviewRunAuthorization, judgments: EditorialJudgment[]): EditorialJudgmentExternalResult {
  return {
    schemaVersion: '1.0.0',
    authorizationId: auth.authorizationId,
    role: auth.role,
    runId: auth.runId,
    candidateSetSha256: auth.candidateSetSha256,
    policySha256: auth.policySha256,
    promptSha256: auth.promptSha256,
    toolSha256: auth.toolSha256,
    judgments,
  };
}

function predictedArtifactSha(
  auth: ReviewRunAuthorization,
  judgments: readonly EditorialJudgment[],
  sealedAt: string,
): string {
  return hashEditorialJudgmentArtifact({
    schemaVersion: '1.0.0',
    header: {
      authorizationId: auth.authorizationId,
      role: auth.role,
      runId: auth.runId,
      candidateSetSha256: auth.candidateSetSha256,
      policySha256: auth.policySha256,
      promptSha256: auth.promptSha256,
      toolSha256: auth.toolSha256,
      sealedAt,
    },
    judgments,
  });
}

function agreementJudgments(candidates: readonly EditorialCandidate[]): EditorialJudgment[] {
  const speakers = ['李徴', '袁傪', '李徴'];
  return candidates.map((candidate, index) => ({
    candidateId: candidate.candidateId,
    decision: 'approved',
    reasonCode: 'SPOKEN_DIALOGUE',
    speaker: speakers[index]!,
    sourceAnchor: candidate.sourceAnchor,
    inputSha256: candidate.inputSha256,
  }));
}

describe('IT-F006-004: 独立二重判定・裁定・読み補正の全件完結', () => {
  it('実データ(山月記000624・3候補)でprimary/secondary合意によりpending 0まで完結する', async () => {
    const root = await tempRoot();
    const candidates = await realWorkCandidates();
    const primary = authorization(root, 'primary', candidates);
    const secondary = authorization(root, 'secondary', candidates);
    await registerEditorialAuthorizations(root, [primary, secondary]);
    const primarySealedAt = '2026-08-22T00:05:00.000Z';
    const secondarySealedAt = '2026-08-22T00:05:01.000Z';
    await sealAndValidateEditorialJudgmentSet(
      root, primary, external(primary, agreementJudgments(candidates)), { now: () => primarySealedAt },
    );
    await sealAndValidateEditorialJudgmentSet(
      root, secondary, external(secondary, agreementJudgments(candidates)), { now: () => secondarySealedAt },
    );
    const trusted = await loadAndVerifyEditorialJudgmentSets(root);
    const primarySet = trusted.find((item) => item.header.authorizationId === primary.authorizationId)!;
    const secondarySet = trusted.find((item) => item.header.authorizationId === secondary.authorizationId)!;
    expect(primarySet).toBeDefined();
    expect(secondarySet).toBeDefined();

    const resolution = reconcileIndependentJudgments(candidates, primarySet, secondarySet);
    expect(resolution.pendingIds).toEqual([]);
    const completeness = verifyEditorialCompleteness(candidates, resolution.resolutions);
    expect(completeness.result).toBe('pass');
    expect(resolution.resolutions.every((item) => item.finalDecision === 'approved')).toBe(true);
    expect(resolution.resolutions.map((item) => item.speaker)).toEqual(['李徴', '袁傪', '李徴']);
  });

  it('primary/secondaryが不一致の候補は第三裁定なしでpendingのまま音声工程へ進まない', async () => {
    const root = await tempRoot();
    const candidates = await realWorkCandidates();
    const primary = authorization(root, 'primary', candidates);
    const secondary = authorization(root, 'secondary', candidates);
    await registerEditorialAuthorizations(root, [primary, secondary]);
    const primaryJudgments = agreementJudgments(candidates);
    const secondaryJudgments = agreementJudgments(candidates);
    // 2件目のspeakerだけ不一致にして裁定待ちを作る。
    secondaryJudgments[1] = { ...secondaryJudgments[1]!, speaker: '不明' };
    await sealAndValidateEditorialJudgmentSet(
      root, primary, external(primary, primaryJudgments), { now: () => '2026-08-22T00:05:00.000Z' },
    );
    await sealAndValidateEditorialJudgmentSet(
      root, secondary, external(secondary, secondaryJudgments), { now: () => '2026-08-22T00:05:01.000Z' },
    );
    const trusted = await loadAndVerifyEditorialJudgmentSets(root);
    const primarySet = trusted.find((item) => item.header.authorizationId === primary.authorizationId)!;
    const secondarySet = trusted.find((item) => item.header.authorizationId === secondary.authorizationId)!;

    const resolution = reconcileIndependentJudgments(candidates, primarySet, secondarySet);
    expect(resolution.pendingIds).toEqual([candidates[1]!.candidateId]);
    const completeness = verifyEditorialCompleteness(candidates, resolution.resolutions);
    expect(completeness.result).toBe('blocked');
    expect(completeness.counts.pending).toBe(1);
  });

  it('第三裁定authorizationにより不一致候補もpending 0まで解決する', async () => {
    const root = await tempRoot();
    const candidates = await realWorkCandidates();
    const primary = authorization(root, 'primary', candidates);
    const secondary = authorization(root, 'secondary', candidates);
    const primaryJudgments = agreementJudgments(candidates);
    const secondaryJudgments = agreementJudgments(candidates);
    secondaryJudgments[1] = { ...secondaryJudgments[1]!, speaker: '不明' };
    const primarySealedAt = '2026-08-22T00:05:00.000Z';
    const secondarySealedAt = '2026-08-22T00:05:01.000Z';
    const adjudicatorSealedAt = '2026-08-22T00:10:00.000Z';
    const adjudicator = authorization(root, 'adjudicator', candidates, [
      {
        kind: 'primaryJudgment',
        path: `seals/${primary.authorizationId}.json`,
        sha256: predictedArtifactSha(primary, primaryJudgments, primarySealedAt),
      },
      {
        kind: 'secondaryJudgment',
        path: `seals/${secondary.authorizationId}.json`,
        sha256: predictedArtifactSha(secondary, secondaryJudgments, secondarySealedAt),
      },
    ]);
    await registerEditorialAuthorizations(root, [primary, secondary, adjudicator]);
    await sealAndValidateEditorialJudgmentSet(
      root, primary, external(primary, primaryJudgments), { now: () => primarySealedAt },
    );
    await sealAndValidateEditorialJudgmentSet(
      root, secondary, external(secondary, secondaryJudgments), { now: () => secondarySealedAt },
    );
    await sealAndValidateEditorialJudgmentSet(
      root, adjudicator, external(adjudicator, agreementJudgments(candidates)), { now: () => adjudicatorSealedAt },
    );
    const trusted = await loadAndVerifyEditorialJudgmentSets(root);
    const primarySet = trusted.find((item) => item.header.authorizationId === primary.authorizationId)!;
    const secondarySet = trusted.find((item) => item.header.authorizationId === secondary.authorizationId)!;
    const adjudicatorSet = trusted.find((item) => item.header.authorizationId === adjudicator.authorizationId)!;

    const resolution = reconcileIndependentJudgments(candidates, primarySet, secondarySet, adjudicatorSet);
    expect(resolution.pendingIds).toEqual([]);
    const completeness = verifyEditorialCompleteness(candidates, resolution.resolutions);
    expect(completeness.result).toBe('pass');
    expect(resolution.resolutions[1]!.resolutionSource).toBe('adjudication');
  });

  it('封印されていないjudgment setは信用済みweak setに乗らずEDITORIAL_JUDGMENT_SET_UNTRUSTEDになる', async () => {
    const candidates = await realWorkCandidates();
    const primary = authorization('unused', 'primary', candidates);
    const secondary = authorization('unused', 'secondary', candidates);
    const forgedHeader = {
      authorizationId: primary.authorizationId,
      role: primary.role,
      runId: primary.runId,
      candidateSetSha256: primary.candidateSetSha256,
      policySha256: primary.policySha256,
      promptSha256: primary.promptSha256,
      toolSha256: primary.toolSha256,
      sealedAt: '2026-08-22T00:00:00.000Z',
    };
    const forgedJudgments = agreementJudgments(candidates);
    const forged: EditorialJudgmentSet = Object.freeze({
      schemaVersion: '1.0.0',
      header: Object.freeze({
        ...forgedHeader,
        artifactSha256: hashEditorialJudgmentArtifact({ schemaVersion: '1.0.0', header: forgedHeader, judgments: forgedJudgments }),
      }),
      judgments: forgedJudgments,
    });
    const secondaryForged: EditorialJudgmentSet = Object.freeze({
      ...forged,
      header: Object.freeze({ ...forged.header, authorizationId: secondary.authorizationId, role: 'secondary' }),
    });
    expect(() => reconcileIndependentJudgments(candidates, forged, secondaryForged))
      .toThrow(EditorialIndependentError);
  });

  it('山月記の読み補正チェーンがdisplayTextを変えずspeechTextだけを確定する（正常系・飛び越し検出）', async () => {
    const candidates = await realWorkCandidates();
    // scripts/f006-prepare-editorial.tsと同一の読み補正（VOICEVOX 0.25.2 speaker 3実測に基づく）。
    const approved = candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      displayText:
        candidate.sourceAnchor === '.main_text:839-851' ? '「あぶないところだった」'
        : candidate.sourceAnchor === '.main_text:899-919' ? '「その声は、我が友、李徴子ではないか？」'
        : '「如何にも自分は隴西の李徴である」',
      speechText:
        candidate.sourceAnchor === '.main_text:839-851' ? '「あぶないところだった」'
        : candidate.sourceAnchor === '.main_text:899-919' ? '「その声は、我が友、李徴子ではないか？」'
        : '「如何にも自分は隴西の李徴である」',
    }));
    const target = approved[1]!;
    const before = target.speechText;
    const after = before.replace('李徴子', 'リチョウシ');
    const revisions: SpeechRevisionV2[] = [{
      candidateId: target.candidateId,
      revision: 1,
      before,
      after,
      reason: 'VOICEVOX speaker 3実測で李徴子が誤読されるためカタカナで補正',
      inputSha256: H(before),
      outputSha256: H(after),
    }];
    const revised = applySpeechRevisions(approved, revisions);
    expect(revised).toHaveLength(3);
    for (const [index, item] of revised.entries()) {
      expect(item.displayText).toBe(approved[index]!.displayText);
    }
    const revisedTarget = revised.find((item) => item.candidateId === target.candidateId)!;
    expect(revisedTarget.speechText).toBe('「その声は、我が友、リチョウシではないか？」');
    expect(revisedTarget.displayText).toBe('「その声は、我が友、李徴子ではないか？」');
    expect(revisedTarget.revisionCount).toBe(1);

    // revision番号を飛び越すchainはSPEECH_REVISION_CHAIN_INVALIDで拒否される。
    const skipped: SpeechRevisionV2[] = [{ ...revisions[0]!, revision: 2 }];
    expect(() => applySpeechRevisions(approved, skipped)).toThrow(F003ReuseError);
  });
});
