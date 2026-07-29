import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ minted: new WeakSet<object>() }));
vi.mock('./f005-context.ts', () => ({
  isMintedF005ApprovedBatchContext(value: unknown) {
    return value !== null && typeof value === 'object' && contextMock.minted.has(value);
  },
}));

import type { Sha256 } from './batch.ts';
import type { F005ApprovedBatchContext } from './f005-context.ts';
import type { F005CandidateSet, F005WorkId } from './f005-source.ts';
import {
  F005ReviewError,
  buildF005SpeechRevisions,
  createF005ReviewCoordinator,
  isMintedF005ReviewAgreement,
  isMintedF005ReviewDispute,
  isMintedF005SpeechRevisionSet,
  issueF005ReviewAuthorizations,
  reconcileF005PrimarySecondary,
  sealF005ReviewJudgment,
  type F005ReviewAuthorization,
  type F005ReviewIdentity,
  type F005ReviewJudgment,
  type F005ReviewJudgmentArtifact,
  type F005ReviewPromptTemplate,
  type F005SpeechRevision,
} from './f005-review.ts';

const SOURCE_SHA = '1'.repeat(64);
const WORK_IDS = ['000799', '001076', '001104'] as const;
const PRODUCER = Object.freeze({
  principalId: 'producer-principal',
  sessionId: 'producer-session',
  runId: 'producer-run',
});
const PRIMARY = Object.freeze({
  principalId: 'primary-principal',
  sessionId: 'primary-session',
  runId: 'primary-run',
});
const SECONDARY = Object.freeze({
  principalId: 'secondary-principal',
  sessionId: 'secondary-session',
  runId: 'secondary-run',
});
const PROMPT = Object.freeze({
  schemaVersion: '1.0.0',
  prompt: '候補を独立判定してください',
  template: 'candidate={{candidate}}',
  tool: 'review-tool@1.0.0',
}) satisfies F005ReviewPromptTemplate;

function sha256(value: string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function context(): F005ApprovedBatchContext {
  const value = Object.freeze({
    __brand: 'ApprovedBatchContext',
    candidate: { batchId: 'F005' },
    definition: {
      workIds: WORK_IDS,
    },
    policy: {
      __brand: 'VerifiedApprovalBindingPolicy',
      requirementApprovalSnapshot: '18e3fa50edfe5214480a65ed2e840fe49a663ee2',
      artifactSha256s: { srs: '2'.repeat(64) },
    },
  }) as unknown as F005ApprovedBatchContext;
  contextMock.minted.add(value);
  return value;
}

function candidateSet(workId: F005WorkId = '000799', text = '「こんにちは」'): F005CandidateSet {
  return {
    schemaVersion: '1.0.0',
    workId,
    sourceSha256: SOURCE_SHA,
    extractorVersion: '1.0.0',
    result: {
      ok: true,
      success: true,
      candidates: [{
        workId,
        rawSourceSha256: SOURCE_SHA,
        order: 0,
        rawTokenRange: { start: 0, end: 1 },
        tokens: [{ type: 'text', value: text }],
        contextBefore: '',
        contextAfter: '',
        sourceAnchor: { bodySelector: '.main_text', startToken: 0, endToken: 1 },
        extractorVersion: '1.0.0',
      }],
      diagnostics: [],
    },
  };
}

function harness(workId: F005WorkId = '000799') {
  const approvedContext = context();
  const clock = { value: '2026-07-29T00:00:00Z' };
  let nonce = 0;
  const coordinator = createF005ReviewCoordinator(approvedContext, {
    now: () => clock.value,
    nonce: () => `nonce-${++nonce}`,
  });
  const candidates = candidateSet(workId);
  const authorizations = issueF005ReviewAuthorizations(
    coordinator,
    PRODUCER,
    candidates,
    workId,
    PRIMARY,
    SECONDARY,
    PROMPT,
    'f005-editorial-review',
    '2026-07-29T01:00:00Z',
  );
  return { approvedContext, clock, coordinator, candidates, authorizations };
}

function judgments(
  authorization: F005ReviewAuthorization,
  overrides: Partial<F005ReviewJudgment> = {},
): readonly F005ReviewJudgment[] {
  return authorization.candidateBindings.map((candidate) => ({
    candidateId: candidate.candidateId,
    inputSha256: candidate.inputSha256,
    sourceAnchor: candidate.sourceAnchor,
    decision: 'approved',
    reasonCode: 'SPOKEN_DIALOGUE',
    speaker: '語り手',
    ...overrides,
  }));
}

function sealAt(
  clock: { value: string },
  at: string,
  authorization: F005ReviewAuthorization,
  values: readonly F005ReviewJudgment[],
): F005ReviewJudgmentArtifact {
  clock.value = at;
  return sealF005ReviewJudgment(authorization, values);
}

function sealAgreement(workId: F005WorkId = '000799') {
  const values = harness(workId);
  const primary = sealAt(
    values.clock,
    '2026-07-29T00:10:00Z',
    values.authorizations.primary,
    judgments(values.authorizations.primary),
  );
  const secondary = sealAt(
    values.clock,
    '2026-07-29T00:11:00Z',
    values.authorizations.secondary,
    judgments(values.authorizations.secondary),
  );
  values.clock.value = '2026-07-29T00:12:00Z';
  const agreement = reconcileF005PrimarySecondary(
    values.approvedContext,
    values.candidates,
    primary,
    secondary,
    values.authorizations,
  );
  if (agreement.kind !== 'Agreement') throw new Error('agreement fixture mismatch');
  return { ...values, primary, secondary, agreement };
}

function expectCode(action: () => unknown, code: F005ReviewError['code']): void {
  try {
    action();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(F005ReviewError);
    expect((error as F005ReviewError).code).toBe(code);
  }
}

describe('F005二重review authorization [DES-F005-005][FUN-F005-011][UT-F005-011]', () => {
  it('canonical 000799 review-input 65候補をそのままauthorizationへ結合する', async () => {
    const artifact = JSON.parse(await readFile(
      resolve('content/batches/F005/review-inputs/000799.json'),
      'utf8',
    )) as F005CandidateSet;
    const approvedContext = context();
    let nonce = 0;
    const coordinator = createF005ReviewCoordinator(approvedContext, {
      now: () => '2026-07-29T00:00:00Z',
      nonce: () => `real-artifact-${++nonce}`,
    });
    const result = issueF005ReviewAuthorizations(
      coordinator,
      PRODUCER,
      artifact,
      '000799',
      PRIMARY,
      SECONDARY,
      PROMPT,
      'f005-editorial-review',
      '2026-07-29T01:00:00Z',
    );
    expect(result.primary.candidateBindings).toHaveLength(65);
    expect(result.primary.candidateSetSha256)
      .toBe('d2304bc12749bd37c0559afa603344a8d6333ddcdc3e48492bc8a133deee82d0');
    expect(result.primary.candidateSetSha256).toBe(result.secondary.candidateSetSha256);
  });

  it.each(WORK_IDS)('%sを同じ汎用coordinatorでprimary/secondaryへ結合する', (workId) => {
    const { authorizations } = harness(workId);
    expect(authorizations.workId).toBe(workId);
    expect(authorizations.primary.role).toBe('primary');
    expect(authorizations.secondary.role).toBe('secondary');
    expect(authorizations.primary.resultVisibility).toBe('blind-private');
    expect(authorizations.secondary.resultVisibility).toBe('blind-private');
    expect(authorizations.primary.candidateSetSha256).toBe(authorizations.secondary.candidateSetSha256);
    expect(authorizations.primary.promptSha256).toBe(sha256(PROMPT.prompt));
    expect(authorizations.primary.templateSha256).toBe(sha256(PROMPT.template));
    expect(authorizations.primary.toolSha256).toBe(sha256(PROMPT.tool));
  });

  it.each([
    ['principal', { ...SECONDARY, principalId: PRIMARY.principalId }],
    ['session', { ...SECONDARY, sessionId: PRODUCER.sessionId }],
    ['run', { ...SECONDARY, runId: PRIMARY.runId }],
  ] as const)('同一%s identityを拒否する', (_label, secondary) => {
    const approvedContext = context();
    const coordinator = createF005ReviewCoordinator(approvedContext, {
      now: () => '2026-07-29T00:00:00Z',
      nonce: (() => {
        let value = 0;
        return () => `identity-${++value}`;
      })(),
    });
    expectCode(() => issueF005ReviewAuthorizations(
      coordinator,
      PRODUCER,
      candidateSet(),
      '000799',
      PRIMARY,
      secondary,
      PROMPT,
      'audience',
      '2026-07-29T01:00:00Z',
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');
  });

  it('期限・nonce再利用・cross-work・authorization cloneを拒否する', () => {
    const approvedContext = context();
    const coordinator = createF005ReviewCoordinator(approvedContext, {
      now: () => '2026-07-29T00:00:00Z',
      nonce: () => 'same-nonce',
    });
    expectCode(() => issueF005ReviewAuthorizations(
      coordinator, PRODUCER, candidateSet(), '000799', PRIMARY, SECONDARY,
      PROMPT, 'audience', '2026-07-28T23:59:59Z',
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');
    expectCode(() => issueF005ReviewAuthorizations(
      coordinator, PRODUCER, candidateSet(), '000799', PRIMARY, SECONDARY,
      PROMPT, 'audience', '2026-07-29T01:00:00Z',
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');

    const valid = harness();
    expectCode(() => issueF005ReviewAuthorizations(
      valid.coordinator, PRODUCER, valid.candidates, '001076', PRIMARY, SECONDARY,
      PROMPT, 'audience', '2026-07-29T01:00:00Z',
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');
    valid.clock.value = '2026-07-29T00:10:00Z';
    expectCode(() => sealF005ReviewJudgment(
      structuredClone(valid.authorizations.primary),
      judgments(valid.authorizations.primary),
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');
  });

  it('getterとprototype汚染を値評価前に拒否する', () => {
    const { coordinator, candidates } = harness();
    let accessed = false;
    const hostile = Object.defineProperty({}, 'principalId', {
      enumerable: true,
      get() {
        accessed = true;
        return 'hostile';
      },
    }) as F005ReviewIdentity;
    expectCode(() => issueF005ReviewAuthorizations(
      coordinator, hostile, candidates, '000799', PRIMARY, SECONDARY,
      PROMPT, 'audience', '2026-07-29T01:00:00Z',
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');
    expect(accessed).toBe(false);

    const inherited = Object.create(PRODUCER) as F005ReviewIdentity;
    expectCode(() => issueF005ReviewAuthorizations(
      coordinator, inherited, candidates, '000799', PRIMARY, SECONDARY,
      PROMPT, 'audience', '2026-07-29T01:00:00Z',
    ), 'F005_REVIEW_AUTHORIZATION_INVALID');
  });
});

describe('F005 primary/secondary照合 [DES-F005-005][FUN-F005-012][UT-F005-012][IT-F005-004]', () => {
  it('semantic一致をbranded Agreementへ確定し一回限りCAS消費する', () => {
    const values = sealAgreement();
    expect(values.agreement.kind).toBe('Agreement');
    expect(isMintedF005ReviewAgreement(values.agreement)).toBe(true);
    expect(values.agreement.reconciliation.resolutions).toHaveLength(1);
    expectCode(() => reconcileF005PrimarySecondary(
      values.approvedContext,
      values.candidates,
      values.primary,
      values.secondary,
      values.authorizations,
    ), 'F005_REVIEW_REPLAY');
  });

  it('semantic不一致をsealed Disputeにしadjudicatorを発行しない', () => {
    const values = harness();
    const primary = sealAt(
      values.clock,
      '2026-07-29T00:10:00Z',
      values.authorizations.primary,
      judgments(values.authorizations.primary),
    );
    const secondary = sealAt(
      values.clock,
      '2026-07-29T00:11:00Z',
      values.authorizations.secondary,
      judgments(values.authorizations.secondary, {
        decision: 'rejected',
        reasonCode: 'NON_SPEECH',
        speaker: null,
      }),
    );
    values.clock.value = '2026-07-29T00:12:00Z';
    const dispute = reconcileF005PrimarySecondary(
      values.approvedContext,
      values.candidates,
      primary,
      secondary,
      values.authorizations,
    );
    expect(dispute.kind).toBe('Dispute');
    expect(isMintedF005ReviewDispute(dispute)).toBe(true);
    expect(Object.keys(dispute)).not.toContain('adjudicator');
  });

  it('primaryだけsealした中断は未消費でsecondaryから再開できる [IT-F005-015/FLT-03]', () => {
    const values = harness();
    const primary = sealAt(
      values.clock,
      '2026-07-29T00:10:00Z',
      values.authorizations.primary,
      judgments(values.authorizations.primary),
    );
    expectCode(() => reconcileF005PrimarySecondary(
      values.approvedContext,
      values.candidates,
      primary,
      null,
      values.authorizations,
    ), 'F005_REVIEW_INCOMPLETE');
    const secondary = sealAt(
      values.clock,
      '2026-07-29T00:11:00Z',
      values.authorizations.secondary,
      judgments(values.authorizations.secondary),
    );
    values.clock.value = '2026-07-29T00:12:00Z';
    expect(reconcileF005PrimarySecondary(
      values.approvedContext,
      values.candidates,
      primary,
      secondary,
      values.authorizations,
    ).kind).toBe('Agreement');
  });

  it('欠落・余分・重複・unknown PASS・cross-setを拒否する', () => {
    const missing = harness();
    missing.clock.value = '2026-07-29T00:10:00Z';
    expectCode(() => sealF005ReviewJudgment(
      missing.authorizations.primary,
      [],
    ), 'F005_REVIEW_RESULT_INVALID');
    const extra = judgments(missing.authorizations.primary);
    expectCode(() => sealF005ReviewJudgment(
      missing.authorizations.primary,
      [...extra, extra[0]!],
    ), 'F005_REVIEW_RESULT_INVALID');
    expectCode(() => sealF005ReviewJudgment(
      missing.authorizations.primary,
      [{ ...extra[0]!, pass: true }] as unknown as F005ReviewJudgment[],
    ), 'F005_REVIEW_RESULT_INVALID');

    const first = harness();
    const second = harness();
    const primary = sealAt(
      first.clock,
      '2026-07-29T00:10:00Z',
      first.authorizations.primary,
      judgments(first.authorizations.primary),
    );
    const wrongSecondary = sealAt(
      second.clock,
      '2026-07-29T00:11:00Z',
      second.authorizations.secondary,
      judgments(second.authorizations.secondary),
    );
    expectCode(() => reconcileF005PrimarySecondary(
      first.approvedContext,
      first.candidates,
      primary,
      wrongSecondary,
      first.authorizations,
    ), 'F005_REVIEW_RESULT_INVALID');
  });

  it('judgmentの全top-level field tamper・clone・getter・prototypeをfail-closedにする', () => {
    const values = harness();
    const primary = sealAt(
      values.clock,
      '2026-07-29T00:10:00Z',
      values.authorizations.primary,
      judgments(values.authorizations.primary),
    );
    const secondary = sealAt(
      values.clock,
      '2026-07-29T00:11:00Z',
      values.authorizations.secondary,
      judgments(values.authorizations.secondary),
    );
    values.clock.value = '2026-07-29T00:12:00Z';
    for (const field of Object.keys(primary)) {
      const changed = structuredClone(primary) as unknown as Record<string, unknown>;
      changed[field] = field === 'judgments' ? [] : 'tampered';
      expectCode(() => reconcileF005PrimarySecondary(
        values.approvedContext,
        values.candidates,
        changed as unknown as F005ReviewJudgmentArtifact,
        secondary,
        values.authorizations,
      ), 'F005_REVIEW_RESULT_INVALID');
    }
    expectCode(() => reconcileF005PrimarySecondary(
      values.approvedContext,
      values.candidates,
      Object.create(primary) as F005ReviewJudgmentArtifact,
      secondary,
      values.authorizations,
    ), 'F005_REVIEW_RESULT_INVALID');
    let accessed = false;
    const hostile = Object.defineProperty({}, 'artifactSha256', {
      get() {
        accessed = true;
        return primary.artifactSha256;
      },
    }) as F005ReviewJudgmentArtifact;
    expectCode(() => reconcileF005PrimarySecondary(
      values.approvedContext,
      values.candidates,
      hostile,
      secondary,
      values.authorizations,
    ), 'F005_REVIEW_RESULT_INVALID');
    expect(accessed).toBe(false);
  });

  it('Agreement/Disputeのcloneとhostile getterをmint判定で評価しない', () => {
    const { agreement } = sealAgreement();
    expect(isMintedF005ReviewAgreement(structuredClone(agreement))).toBe(false);
    let accessed = false;
    const hostile = Object.defineProperty({}, 'kind', {
      get() {
        accessed = true;
        return 'Agreement';
      },
    });
    expect(isMintedF005ReviewAgreement(hostile)).toBe(false);
    expect(isMintedF005ReviewDispute(hostile)).toBe(false);
    expect(accessed).toBe(false);
  });
});

describe('F005 speech revision [DES-F005-005][FUN-F005-013][UT-F005-013][IT-F005-004]', () => {
  it('revisionなしと連続chainでdisplayを不変にしspeechだけを変更する', () => {
    const { agreement } = sealAgreement();
    const none = buildF005SpeechRevisions(agreement.reconciliation, []);
    const originalDisplay = none.items[0]!.displayText;
    const before = none.items[0]!.speechText;
    const after1 = 'こんにちは、なのだ';
    const after2 = 'こんにちはなのだ';
    const revisions: F005SpeechRevision[] = [{
      candidateId: none.items[0]!.candidateId,
      revision: 1,
      before,
      after: after1,
      reason: '読みを自然にする',
      inputSha256: sha256(before),
      outputSha256: sha256(after1),
    }, {
      candidateId: none.items[0]!.candidateId,
      revision: 2,
      before: after1,
      after: after2,
      reason: '間を調整する',
      inputSha256: sha256(after1),
      outputSha256: sha256(after2),
    }];
    const revised = buildF005SpeechRevisions(agreement.reconciliation, revisions);
    expect(revised.items[0]).toMatchObject({
      displayText: originalDisplay,
      speechText: after2,
      speechSha256: sha256(after2),
    });
    expect(isMintedF005SpeechRevisionSet(revised)).toBe(true);
    expect(isMintedF005SpeechRevisionSet(structuredClone(revised))).toBe(false);
  });

  it.each([
    ['候補外', { candidateId: 'outside' }],
    ['before差', { before: '別の本文' }],
    ['input hash差', { inputSha256: 'f'.repeat(64) }],
    ['output hash差', { outputSha256: 'e'.repeat(64) }],
    ['飛越し', { revision: 2 }],
  ] as const)('%s revisionを拒否する', (_label, override) => {
    const { agreement } = sealAgreement();
    const base = buildF005SpeechRevisions(agreement.reconciliation, []);
    const before = base.items[0]!.speechText;
    const after = '補正後';
    const revision = {
      candidateId: base.items[0]!.candidateId,
      revision: 1,
      before,
      after,
      reason: '読み補正',
      inputSha256: sha256(before),
      outputSha256: sha256(after),
      ...override,
    } as F005SpeechRevision;
    expectCode(() => buildF005SpeechRevisions(
      agreement.reconciliation,
      [revision],
    ), 'F005_SPEECH_REVISION_INVALID');
  });

  it('循環・reconciliation clone・revision getter/prototypeを拒否する', () => {
    const { agreement } = sealAgreement();
    const base = buildF005SpeechRevisions(agreement.reconciliation, []);
    const before = base.items[0]!.speechText;
    const after = '一度変更';
    const cycle: F005SpeechRevision[] = [{
      candidateId: base.items[0]!.candidateId,
      revision: 1,
      before,
      after,
      reason: '一度変更',
      inputSha256: sha256(before),
      outputSha256: sha256(after),
    }, {
      candidateId: base.items[0]!.candidateId,
      revision: 2,
      before: after,
      after: before,
      reason: '元へ戻す',
      inputSha256: sha256(after),
      outputSha256: sha256(before),
    }];
    expectCode(() => buildF005SpeechRevisions(
      agreement.reconciliation,
      cycle,
    ), 'F005_SPEECH_REVISION_INVALID');
    expectCode(() => buildF005SpeechRevisions(
      structuredClone(agreement.reconciliation),
      [],
    ), 'F005_SPEECH_REVISION_INVALID');

    let accessed = false;
    const hostile = Object.defineProperty({}, 'candidateId', {
      enumerable: true,
      get() {
        accessed = true;
        return base.items[0]!.candidateId;
      },
    });
    expectCode(() => buildF005SpeechRevisions(
      agreement.reconciliation,
      [hostile as F005SpeechRevision],
    ), 'F005_SPEECH_REVISION_INVALID');
    expect(accessed).toBe(false);
    expectCode(() => buildF005SpeechRevisions(
      agreement.reconciliation,
      [Object.create(cycle[0]!) as F005SpeechRevision],
    ), 'F005_SPEECH_REVISION_INVALID');
  });
});
