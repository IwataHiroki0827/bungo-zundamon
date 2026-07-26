import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import {
  EDITORIAL_TRANSACTION_ROOT,
  EditorialIndependentError,
  hashEditorialCandidates,
  hashEditorialJudgmentArtifact,
  loadAndVerifyEditorialJudgmentSets,
  reconcileIndependentJudgments,
  recoverEditorialJudgmentTransaction,
  sealAndValidateEditorialJudgmentSet,
  verifyEditorialCompleteness,
  type EditorialCandidate,
  type EditorialJudgmentExternalResult,
  type EditorialJudgmentSet,
  type ReviewAuthorizationStore,
  type ReviewRunAuthorization,
} from './editorial-independent.ts';

const roots: string[] = [];
const H = (value: string) => createHash('sha256').update(value).digest('hex');
const CANDIDATES: readonly EditorialCandidate[] = Object.freeze([
  Object.freeze({ candidateId: 'candidate-1', inputSha256: H('input-1'), sourceAnchor: '.main_text:10-20' }),
  Object.freeze({ candidateId: 'candidate-2', inputSha256: H('input-2'), sourceAnchor: '.main_text:30-40' }),
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function authorization(
  role: ReviewRunAuthorization['role'],
  suffix: string,
  inputRefs: ReviewRunAuthorization['inputRefs'] = [],
  candidates: readonly EditorialCandidate[] = CANDIDATES,
): ReviewRunAuthorization {
  return Object.freeze({
    authorizationId: `authorization-${suffix}`,
    role,
    producerTaskPath: `/root/f003/${suffix}`,
    judgeRole: role,
    runId: `run-${suffix}`,
    candidateSetSha256: hashEditorialCandidates(candidates),
    policySha256: H('policy'),
    promptSha256: H(`prompt-${suffix}`),
    toolSha256: H('tool'),
    nonce: `nonce-${suffix}`,
    issuedAt: '2026-07-26T00:00:00.000Z',
    inputRefs,
    candidates,
  });
}

function external(
  auth: ReviewRunAuthorization,
  decisions: readonly ('approved' | 'rejected' | 'ambiguous')[] = ['approved', 'rejected'],
): EditorialJudgmentExternalResult {
  return {
    schemaVersion: '1.0.0',
    authorizationId: auth.authorizationId,
    role: auth.role,
    runId: auth.runId,
    candidateSetSha256: auth.candidateSetSha256,
    policySha256: auth.policySha256,
    promptSha256: auth.promptSha256,
    toolSha256: auth.toolSha256,
    judgments: auth.candidates.map((candidate, index) => ({
      ...candidate,
      decision: decisions[index] ?? 'rejected',
      reasonCode: decisions[index] === 'rejected' ? 'NARRATION' : 'SPOKEN_DIALOGUE',
      speaker: decisions[index] === 'rejected' ? null : '主人公',
    })),
  };
}

async function workspace(authorizations: readonly ReviewRunAuthorization[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-editorial-'));
  roots.push(root);
  const directory = join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/'));
  await mkdir(directory, { recursive: true });
  const store: ReviewAuthorizationStore = {
    schemaVersion: '1.0.0',
    authorizations: authorizations.map((entry) => ({
      authorization: entry,
      status: 'unused',
      usedAt: null,
      sealPath: null,
      sealSha256: null,
    })),
  };
  await writeFile(join(directory, 'store.json'), canonicalJson(store), 'utf8');
  return root;
}

async function stored(root: string): Promise<ReviewAuthorizationStore> {
  return JSON.parse(await readFile(
    join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/'), 'store.json'),
    'utf8',
  )) as ReviewAuthorizationStore;
}

function set(
  auth: ReviewRunAuthorization,
  overrides: Partial<EditorialJudgmentSet> = {},
): EditorialJudgmentSet {
  const value = external(auth);
  const judgments = overrides.judgments ?? value.judgments;
  const header = {
    authorizationId: auth.authorizationId,
    role: auth.role,
    runId: auth.runId,
    candidateSetSha256: auth.candidateSetSha256,
    policySha256: auth.policySha256,
    promptSha256: auth.promptSha256,
    toolSha256: auth.toolSha256,
    sealedAt: '2026-07-26T01:00:00.000Z',
  } as const;
  return {
    schemaVersion: '1.0.0',
    header: {
      ...header,
      artifactSha256: hashEditorialJudgmentArtifact({
        schemaVersion: '1.0.0',
        header,
        judgments,
      }),
    },
    judgments,
    ...overrides,
  };
}

function reseal(
  source: EditorialJudgmentSet,
  judgments: EditorialJudgmentSet['judgments'],
): EditorialJudgmentSet {
  const { artifactSha256: _artifactSha256, ...header } = source.header;
  void _artifactSha256;
  return {
    ...source,
    header: {
      ...header,
      artifactSha256: hashEditorialJudgmentArtifact({
        schemaVersion: '1.0.0',
        header,
        judgments,
      }),
    },
    judgments,
  };
}

async function trustedSet(
  auth: ReviewRunAuthorization,
  result: EditorialJudgmentExternalResult = external(auth),
): Promise<EditorialJudgmentSet> {
  const root = await workspace([auth]);
  return sealAndValidateEditorialJudgmentSet(root, auth, result, {
    now: () => '2026-07-26T01:00:00.000Z',
  });
}

async function trustedAdjudicationBundle(
  primary: ReviewRunAuthorization,
  secondary: ReviewRunAuthorization,
  secondaryResult: EditorialJudgmentExternalResult,
): Promise<{
  primary: EditorialJudgmentSet;
  secondary: EditorialJudgmentSet;
  adjudication: EditorialJudgmentSet;
  adjudicator: ReviewRunAuthorization;
}> {
  const secondaryPreview = set(secondary, { judgments: secondaryResult.judgments });
  const adjudicator = authorization('adjudicator', 'adjudicator', [
    {
      kind: 'primaryJudgment',
      path: `seals/${primary.authorizationId}.json`,
      sha256: set(primary).header.artifactSha256,
    },
    {
      kind: 'secondaryJudgment',
      path: `seals/${secondary.authorizationId}.json`,
      sha256: secondaryPreview.header.artifactSha256,
    },
  ]);
  const root = await workspace([primary, secondary, adjudicator]);
  const primarySet = await sealAndValidateEditorialJudgmentSet(root, primary, external(primary), {
    now: () => '2026-07-26T01:00:00.000Z',
  });
  const secondarySet = await sealAndValidateEditorialJudgmentSet(root, secondary, secondaryResult, {
    now: () => '2026-07-26T01:00:00.000Z',
  });
  const adjudication = await sealAndValidateEditorialJudgmentSet(root, adjudicator, external(adjudicator), {
    now: () => '2026-07-26T01:00:00.000Z',
  });
  return { primary: primarySet, secondary: secondarySet, adjudication, adjudicator };
}

describe('UT-F003-009 独立判定authorization・seal [DES-F003-005][FUN-F003-009]', () => {
  it('trusted storeと外部exact schemaを全candidate joinし、primary identityをsealへ自己申告させない', async () => {
    const primary = authorization('primary', 'primary');
    const secondary = authorization('secondary', 'secondary');
    const root = await workspace([primary, secondary]);

    const sealed = await sealAndValidateEditorialJudgmentSet(root, primary, external(primary), {
      now: () => '2026-07-26T01:00:00.000Z',
    });
    const saved = await stored(root);

    expect(sealed.header).toMatchObject({
      authorizationId: primary.authorizationId,
      role: 'primary',
      runId: primary.runId,
    });
    expect(Object.keys(sealed.header)).not.toContain('producerTaskPath');
    expect(saved.authorizations[0]).toMatchObject({
      status: 'used',
      usedAt: '2026-07-26T01:00:00.000Z',
      sealPath: `seals/${primary.authorizationId}.json`,
      sealSha256: sealed.header.artifactSha256,
    });
    await expect(sealAndValidateEditorialJudgmentSet(root, primary, external(primary)))
      .rejects.toMatchObject({ code: 'EDITORIAL_AUTHORIZATION_USED' });
  });

  it.each(['prepared', 'old-moved', 'new-moved', 'verified'] as const)(
    '%s停止後にjournal回復し、seal済+usedへatomic収束する',
    async (phase) => {
      const primary = authorization('primary', phase);
      const secondary = authorization('secondary', `${phase}-secondary`);
      const root = await workspace([primary, secondary]);
      await expect(sealAndValidateEditorialJudgmentSet(root, primary, external(primary), {
        now: () => '2026-07-26T01:00:00.000Z',
        promotionHooks: { afterPhase: (current) => {
          if (current === phase) throw new Error(`fault-${phase}`);
        } },
      })).rejects.toThrow(`fault-${phase}`);

      await recoverEditorialJudgmentTransaction(root);
      const saved = await stored(root);
      const record = saved.authorizations[0]!;
      expect(record.status).toBe('used');
      expect(record.sealPath).toBe(`seals/${primary.authorizationId}.json`);
      const seal = JSON.parse(await readFile(
        join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/'), record.sealPath!),
        'utf8',
      )) as EditorialJudgmentSet;
      expect(seal.header.artifactSha256).toBe(record.sealSha256);

      await sealAndValidateEditorialJudgmentSet(root, secondary, external(secondary), {
        now: () => '2026-07-26T01:01:00.000Z',
      });
      const restored = await loadAndVerifyEditorialJudgmentSets(root);
      expect(restored).toHaveLength(2);
      const restoredPrimary = restored.find((item) => item.header.role === 'primary')!;
      const restoredSecondary = restored.find((item) => item.header.role === 'secondary')!;
      expect(reconcileIndependentJudgments(
        primary.candidates,
        restoredPrimary,
        restoredSecondary,
      ).pendingIds).toEqual([]);
    },
  );

  it('seal改変、candidate欠落・anchor差、自己申告identity、primary非開示違反を拒否する', async () => {
    const primary = authorization('primary', 'primary');
    const unsafeSecondary = authorization('secondary', 'secondary', [{
      kind: 'primaryJudgment',
      path: 'content/editorial/authorization-transaction/seals/authorization-primary.json',
      sha256: H('primary-seal'),
    }]);
    const root = await workspace([primary, unsafeSecondary]);

    const missing = external(primary);
    missing.judgments = missing.judgments.slice(0, 1);
    await expect(sealAndValidateEditorialJudgmentSet(root, primary, missing))
      .rejects.toMatchObject({ code: 'EDITORIAL_EXTERNAL_RESULT_INVALID' });

    const wrongAnchor = external(primary);
    wrongAnchor.judgments[0] = { ...wrongAnchor.judgments[0]!, sourceAnchor: '.main_text:11-20' };
    await expect(sealAndValidateEditorialJudgmentSet(root, primary, wrongAnchor))
      .rejects.toMatchObject({ code: 'EDITORIAL_EXTERNAL_RESULT_INVALID' });

    await expect(sealAndValidateEditorialJudgmentSet(root, primary, {
      ...external(primary),
      producerTaskPath: '/self/claimed',
    }))
      .rejects.toMatchObject({ code: 'EDITORIAL_EXTERNAL_RESULT_INVALID' });
    await expect(sealAndValidateEditorialJudgmentSet(root, unsafeSecondary, external(unsafeSecondary)))
      .rejects.toMatchObject({ code: 'EDITORIAL_PRIMARY_DISCLOSURE' });

    const sealed = await sealAndValidateEditorialJudgmentSet(root, primary, external(primary));
    const sealPath = join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/'), `seals/${primary.authorizationId}.json`);
    await writeFile(sealPath, canonicalJson({ ...sealed, tampered: true }), 'utf8');
    await expect(sealAndValidateEditorialJudgmentSet(root, primary, external(primary)))
      .rejects.toMatchObject({ code: 'EDITORIAL_SEAL_TAMPERED' });
  });

  it('trusted store差替えとrole間task/run/nonce identity衝突を拒否する', async () => {
    const primary = authorization('primary', 'primary');
    const colliding = {
      ...authorization('secondary', 'secondary'),
      producerTaskPath: primary.producerTaskPath,
      runId: primary.runId,
      nonce: primary.nonce,
    };
    const root = await workspace([primary, colliding]);

    await expect(sealAndValidateEditorialJudgmentSet(root, colliding, external(colliding)))
      .rejects.toMatchObject({ code: 'EDITORIAL_IDENTITY_COLLISION' });
    const cleanRoot = await workspace([primary]);
    await expect(sealAndValidateEditorialJudgmentSet(cleanRoot, {
      ...primary,
      producerTaskPath: '/caller/substitution',
    }, external(primary)))
      .rejects.toMatchObject({ code: 'EDITORIAL_AUTHORIZATION_UNTRUSTED' });
  });

  it('adjudicatorはtrusted storeでusedになったsealed primary/secondaryだけを入力にできる', async () => {
    const primary = authorization('primary', 'adjudication-primary');
    const secondary = authorization('secondary', 'adjudication-secondary');
    const adjudicator = authorization('adjudicator', 'adjudication-final', [
      {
        kind: 'primaryJudgment',
        path: `seals/${primary.authorizationId}.json`,
        sha256: set(primary).header.artifactSha256,
      },
      {
        kind: 'secondaryJudgment',
        path: `seals/${secondary.authorizationId}.json`,
        sha256: set(secondary).header.artifactSha256,
      },
    ]);
    const root = await workspace([primary, secondary, adjudicator]);
    const fixedTime = { now: () => '2026-07-26T01:00:00.000Z' };

    await expect(sealAndValidateEditorialJudgmentSet(root, adjudicator, external(adjudicator), fixedTime))
      .rejects.toMatchObject({ code: 'EDITORIAL_PRIMARY_DISCLOSURE' });
    await sealAndValidateEditorialJudgmentSet(root, primary, external(primary), fixedTime);
    await sealAndValidateEditorialJudgmentSet(root, secondary, external(secondary), fixedTime);
    const sealed = await sealAndValidateEditorialJudgmentSet(root, adjudicator, external(adjudicator), fixedTime);
    expect(sealed.header.role).toBe('adjudicator');
  });
});

describe('UT-F003-010 二判定照合・第三裁定 [DES-F003-005][FUN-F003-010]', () => {
  it('run metadata差を無視してsemantic一致だけを確定しdigestを固定する', async () => {
    const primary = authorization('primary', 'primary');
    const secondary = authorization('secondary', 'secondary');
    const primarySet = await trustedSet(primary);
    const secondarySet = await trustedSet(secondary);
    const result = reconcileIndependentJudgments(CANDIDATES, primarySet, secondarySet);
    const repeated = reconcileIndependentJudgments(CANDIDATES, primarySet, secondarySet);

    expect(result.resolutions.map((item) => item.finalDecision)).toEqual(['approved', 'rejected']);
    expect(result.pendingIds).toEqual([]);
    expect(result.reconciliationDigest).toBe(repeated.reconciliationDigest);
  });

  it('candidate 1件境界でも一致を確定する', async () => {
    const candidates = CANDIDATES.slice(0, 1);
    const primary = authorization('primary', 'one-primary', [], candidates);
    const secondary = authorization('secondary', 'one-secondary', [], candidates);
    const result = reconcileIndependentJudgments(
      candidates,
      await trustedSet(primary),
      await trustedSet(secondary),
    );
    expect(result.resolutions).toHaveLength(1);
    expect(result.pendingIds).toEqual([]);
  });

  it.each([
    ['decision', (judgment: EditorialJudgmentSet['judgments'][number]) => ({ ...judgment, decision: 'rejected' as const })],
    ['reasonCode', (judgment: EditorialJudgmentSet['judgments'][number]) => ({ ...judgment, reasonCode: 'DIFFERENT_REASON' })],
    ['speaker', (judgment: EditorialJudgmentSet['judgments'][number]) => ({ ...judgment, speaker: '別の話者' })],
  ])('%s差を裁定なしではpendingにする', async (_field, mutate) => {
    const primary = authorization('primary', `mismatch-primary-${_field}`);
    const secondary = authorization('secondary', `mismatch-secondary-${_field}`);
    const judgments = external(secondary).judgments;
    judgments[0] = mutate(judgments[0]!);
    const primarySet = await trustedSet(primary);
    const secondarySet = await trustedSet(secondary, { ...external(secondary), judgments });
    const result = reconcileIndependentJudgments(
      CANDIDATES,
      primarySet,
      secondarySet,
    );
    expect(result.pendingIds).toContain('candidate-1');
  });

  it('自己整合hashだけの偽sealは正しいanchor/inputでもtrusted store未封印として拒否する', () => {
    const primary = authorization('primary', 'forged-primary');
    const secondary = authorization('secondary', 'forged-secondary');
    const forge = (source: EditorialJudgmentSet): EditorialJudgmentSet => {
      const judgments = source.judgments.map((judgment) =>
        ({ ...judgment, decision: 'approved' as const, reasonCode: 'FORGED' }));
      return reseal(source, judgments);
    };

    expect(() => reconcileIndependentJudgments(
      CANDIDATES,
      forge(set(primary)),
      forge(set(secondary)),
    )).toThrow(expect.objectContaining({ code: 'EDITORIAL_JUDGMENT_SET_UNTRUSTED' }));
  });

  it('semantic不一致をpendingにし、別identity/runの第三裁定だけで確定する', async () => {
    const primary = authorization('primary', 'primary');
    const secondary = authorization('secondary', 'secondary');
    const secondaryJudgments = external(secondary).judgments;
    secondaryJudgments[0] = { ...secondaryJudgments[0]!, reasonCode: 'DIFFERENT_REASON' };
    const bundle = await trustedAdjudicationBundle(
      primary,
      secondary,
      { ...external(secondary), judgments: secondaryJudgments },
    );

    const pending = reconcileIndependentJudgments(CANDIDATES, bundle.primary, bundle.secondary);
    expect(pending.pendingIds).toEqual(['candidate-1']);
    expect(pending.resolutions[0]?.finalDecision).toBe('pending');

    const resolved = reconcileIndependentJudgments(
      CANDIDATES,
      bundle.primary,
      bundle.secondary,
      bundle.adjudication,
    );
    expect(resolved.resolutions[0]?.finalDecision).toBe('approved');
    expect(resolved.resolutions[0]?.resolutionSource).toBe('adjudication');

    const sameRun = set({ ...bundle.adjudicator, runId: primary.runId });
    expect(() => reconcileIndependentJudgments(CANDIDATES, bundle.primary, bundle.secondary, sameRun))
      .toThrowError(EditorialIndependentError);
  });
});

describe('UT-F003-011 編集完結性 [DES-F003-005][FUN-F003-011]', () => {
  it('candidateとapproved/rejected resolutionの1対1 joinだけをpassにする', async () => {
    const primary = authorization('primary', 'primary');
    const secondary = authorization('secondary', 'secondary');
    const resolutions = reconcileIndependentJudgments(
      CANDIDATES,
      await trustedSet(primary),
      await trustedSet(secondary),
    );

    expect(verifyEditorialCompleteness(CANDIDATES, resolutions.resolutions)).toEqual({
      result: 'pass',
      counts: { candidateDuplicates: 0, resolutionDuplicates: 0, missing: 0, extra: 0, pending: 0, reasonMissing: 0, topicOnlyRejections: 0 },
      ids: { candidateDuplicates: [], resolutionDuplicates: [], missing: [], extra: [], pending: [], reasonMissing: [], topicOnlyRejections: [] },
    });
  });

  it.each([
    ['pending', (items: ReturnType<typeof reconcileIndependentJudgments>['resolutions']) =>
      items.map((item, index) => index === 0 ? { ...item, finalDecision: 'pending' as const } : item)],
    ['extra', (items: ReturnType<typeof reconcileIndependentJudgments>['resolutions']) =>
      [...items, { ...items[0]!, candidateId: 'extra' }]],
    ['missing', (items: ReturnType<typeof reconcileIndependentJudgments>['resolutions']) => items.slice(1)],
    ['duplicate', (items: ReturnType<typeof reconcileIndependentJudgments>['resolutions']) => [...items, items[0]!]],
    ['reason missing', (items: ReturnType<typeof reconcileIndependentJudgments>['resolutions']) =>
      items.map((item, index) => index === 0 ? { ...item, reasonCode: ' ' } : item)],
    ['topic-only', (items: ReturnType<typeof reconcileIndependentJudgments>['resolutions']) =>
      items.map((item, index) => index === 0 ? {
        ...item,
        finalDecision: 'rejected' as const,
        reasonCode: 'TOPIC_KEYWORD_ONLY',
      } : item)],
  ])('%sをID・件数付きblockedにする', async (_name, mutate) => {
    const primary = authorization('primary', 'primary');
    const secondary = authorization('secondary', 'secondary');
    const base = reconcileIndependentJudgments(
      CANDIDATES,
      await trustedSet(primary),
      await trustedSet(secondary),
    );
    const report = verifyEditorialCompleteness(CANDIDATES, mutate(base.resolutions));
    expect(report.result).toBe('blocked');
    expect(Object.values(report.counts).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(Object.values(report.ids).flat().length).toBeGreaterThan(0);
  });
});
