import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import {
  hashEditorialJudgmentArtifact,
  loadAndVerifyEditorialJudgmentSets,
  reconcileIndependentJudgments,
  type EditorialCandidate,
  type EditorialJudgment,
  type EditorialJudgmentSet,
} from './editorial-independent.ts';
import {
  bridgeEditorialResolutionSetToReviewRecords,
  prepareWorkAcceptance,
  promoteVerifiedWorkArtifacts,
  recoverWorkAcceptance,
  type F003AcceptanceArtifact,
  type F003AcceptanceBaseline,
  type F003EvidenceFileRef,
  type F003WorkEvidenceRefs,
} from './f003-review-acceptance.ts';
import {
  transitionWorkState,
  type BatchManifest,
  type Sha256,
  type WorkId,
  type WorkspaceRelativePath,
} from './batch.ts';
import { applyWorkReviews, type Candidate } from './processing.ts';

const roots: string[] = [];
const sha = (value: string | Uint8Array): Sha256 =>
  createHash('sha256').update(value).digest('hex') as Sha256;
const H = (value: string): Sha256 => sha(value);
const WORK = '000275' as WorkId;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function candidates(): EditorialCandidate[] {
  return [
    { candidateId: 'c1', inputSha256: H('c1'), sourceAnchor: 'body:1-2' },
    { candidateId: 'c2', inputSha256: H('c2'), sourceAnchor: 'body:3-4' },
  ];
}

function pipelineCandidates(): Candidate[] {
  return candidates().map((candidate, index) => ({
    candidateId: candidate.candidateId,
    workId: WORK,
    rawSourceSha256: H(`raw-${index}`),
    order: index,
    rawTokenRange: { start: index * 2, end: index * 2 + 1 },
    displayText: `「候補${index}」`,
    speechText: `候補${index}`,
    contextBefore: '前',
    contextAfter: '後',
    sourceAnchor: { bodySelector: '.main_text', startToken: index * 2, endToken: index * 2 + 1 },
    extractorVersion: '1.0.0',
    normalizerVersion: '1.0.0',
  }));
}

function seal(
  role: 'primary' | 'secondary' | 'adjudicator',
  values: readonly EditorialJudgment[],
  sealedAt: string,
): EditorialJudgmentSet {
  const unhashed = {
    authorizationId: `${role}-authorization`,
    role,
    runId: `${role}-run`,
    candidateSetSha256: H(canonicalJson(candidates())),
    policySha256: H('policy'),
    promptSha256: H('prompt'),
    toolSha256: H('tool'),
    sealedAt,
  };
  return {
    schemaVersion: '1.0.0',
    header: {
      ...unhashed,
      artifactSha256: hashEditorialJudgmentArtifact({
        schemaVersion: '1.0.0',
        header: unhashed,
        judgments: values,
      }),
    },
    judgments: [...values],
  };
}

async function trustSeals(
  root: string,
  seals: readonly EditorialJudgmentSet[],
): Promise<readonly EditorialJudgmentSet[]> {
  const transactionRoot = join(root, 'content', 'editorial', 'authorization-transaction');
  const records = seals.map((value, index) => {
    const role = value.header.role;
    const inputRefs = [
      { kind: 'candidateSet', path: 'content/editorial/candidates.json', sha256: value.header.candidateSetSha256 },
      { kind: 'policy', path: 'content/editorial/policy.json', sha256: value.header.policySha256 },
      { kind: 'prompt', path: 'content/editorial/prompt.json', sha256: value.header.promptSha256 },
      { kind: 'tool', path: 'content/editorial/tool.json', sha256: value.header.toolSha256 },
      ...(role === 'adjudicator' ? [
        {
          kind: 'primaryJudgment',
          path: `seals/${seals.find((sealValue) => sealValue.header.role === 'primary')!.header.authorizationId}.json`,
          sha256: seals.find((sealValue) => sealValue.header.role === 'primary')!.header.artifactSha256,
        },
        {
          kind: 'secondaryJudgment',
          path: `seals/${seals.find((sealValue) => sealValue.header.role === 'secondary')!.header.authorizationId}.json`,
          sha256: seals.find((sealValue) => sealValue.header.role === 'secondary')!.header.artifactSha256,
        },
      ] : []),
    ];
    return {
      authorization: {
        authorizationId: value.header.authorizationId,
        role,
        producerTaskPath: `/root/f003-${role}`,
        judgeRole: role,
        runId: value.header.runId,
        candidateSetSha256: value.header.candidateSetSha256,
        policySha256: value.header.policySha256,
        promptSha256: value.header.promptSha256,
        toolSha256: value.header.toolSha256,
        nonce: `${role}-nonce-${index}`,
        issuedAt: '2026-07-26T07:00:00.000Z',
        inputRefs,
        candidates: candidates(),
      },
      status: 'used',
      usedAt: value.header.sealedAt,
      sealPath: `seals/${value.header.authorizationId}.json`,
      sealSha256: value.header.artifactSha256,
    };
  });
  await writeCanonical(root, 'content/editorial/authorization-transaction/store.json', {
    schemaVersion: '1.0.0',
    authorizations: records,
  });
  for (const value of seals) {
    await writeCanonical(
      root,
      `content/editorial/authorization-transaction/seals/${value.header.authorizationId}.json`,
      value,
    );
  }
  await mkdir(transactionRoot, { recursive: true });
  return loadAndVerifyEditorialJudgmentSets(root);
}

function judgments(approved: EditorialJudgment['decision'] = 'approved'): EditorialJudgment[] {
  const [first, second] = candidates();
  return [
    {
      candidateId: first!.candidateId,
      decision: approved,
      reasonCode: approved === 'approved' ? 'SPOKEN_DIALOGUE' : 'NON_SPEECH',
      speaker: approved === 'approved' ? '女生徒' : null,
      sourceAnchor: first!.sourceAnchor,
      inputSha256: first!.inputSha256,
    },
    {
      candidateId: second!.candidateId,
      decision: 'rejected',
      reasonCode: 'NON_SPEECH',
      speaker: null,
      sourceAnchor: second!.sourceAnchor,
      inputSha256: second!.inputSha256,
    },
  ];
}

function manifest(status: 'voiced' | 'accepted' = 'voiced'): BatchManifest {
  const record = (stage: string, input: string, output: string) => ({
    stage,
    inputHashes: [H(input)],
    outputHashes: [H(output)],
    toolVersion: 'fixture/1.0.0',
    count: 1,
    completedAt: '2026-07-26T08:00:00.000Z',
  });
  const first = {
    workId: WORK,
    status,
    stageRecords: [
      record('extracted', 'a', 'b'),
      record('reviewed', 'b', 'c'),
      record('budget-approved', 'c', 'd'),
      record('voiced', 'd', 'e'),
      ...(status === 'accepted' ? [record('accepted', 'e', 'f')] : []),
    ],
    forecastRef: 'content/batches/F003/forecast.json' as WorkspaceRelativePath,
    voiceEvidenceRef: 'content/batches/F003/voice.json' as WorkspaceRelativePath,
    ...(status === 'accepted' ? {
      acceptedAudioSources: [{
        path: 'content/batches/F003/accepted-audio/000275/audio.wav' as WorkspaceRelativePath,
        sha256: H('audio'),
        bytes: 46,
        configHash: H('config'),
      }],
      acceptedAt: '2026-07-26T09:00:00.000Z',
      acceptedBy: 'fixture',
    } : {}),
  };
  return {
    schemaVersion: '1.0.0',
    batchId: 'F003',
    feature: 'F003',
    status: 'draft',
    author: {
      authorId: '000035',
      name: 'だざいおさむ',
      originalName: '太宰治',
      slug: 'dazai-osamu',
      identitySha256: H('author'),
    },
    workIds: [WORK, '001567' as WorkId, '000258' as WorkId],
    workProgress: [
      first,
      { workId: '001567' as WorkId, status: 'pending', stageRecords: [] },
      { workId: '000258' as WorkId, status: 'pending', stageRecords: [] },
    ],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: ['rights'],
    voiceConfigRef: 'content/batches/F003/voice-config.json' as WorkspaceRelativePath,
    artworkProvenanceRef: 'content/batches/F003/artwork-provenance.json' as WorkspaceRelativePath,
  } as unknown as BatchManifest;
}

async function writeCanonical(root: string, relativePath: string, value: unknown): Promise<F003EvidenceFileRef> {
  const text = canonicalJson(value);
  const path = join(root, ...relativePath.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return { path: relativePath, sha256: sha(text), bytes: Buffer.byteLength(text) };
}

function artifact<K extends F003AcceptanceArtifact['kind']>(
  kind: K,
  inputHashes: readonly string[],
  payload: Extract<F003AcceptanceArtifact, { kind: K }>['payload'],
): Extract<F003AcceptanceArtifact, { kind: K }> {
  return {
    schemaVersion: '1.0.0',
    kind,
    batchId: 'F003',
    workId: WORK,
    toolSha256: H(`${kind}-tool`),
    inputHashes,
    payload,
  } as Extract<F003AcceptanceArtifact, { kind: K }>;
}

async function acceptanceFixture(adjudication = false) {
  const root = await mkdtemp(join(tmpdir(), 'f003-acceptance-'));
  roots.push(root);
  const primaryRaw = seal('primary', judgments(), '2026-07-26T08:00:00.000Z');
  const secondaryValues = adjudication ? judgments('rejected') : judgments();
  const secondaryRaw = seal('secondary', secondaryValues, '2026-07-26T08:01:00.000Z');
  const judgeRaw = adjudication
    ? seal('adjudicator', judgments(), '2026-07-26T08:02:00.000Z')
    : undefined;
  const trusted = await trustSeals(
    root,
    [primaryRaw, secondaryRaw, ...(judgeRaw ? [judgeRaw] : [])],
  );
  const primary = trusted.find((value) => value.header.role === 'primary')!;
  const secondary = trusted.find((value) => value.header.role === 'secondary')!;
  const judge = trusted.find((value) => value.header.role === 'adjudicator');
  const reconciliation = reconcileIndependentJudgments(candidates(), primary, secondary, judge);
  const rootPath = `content/batches/F003/work-artifacts/${WORK}`;
  const refs = {} as Record<string, F003EvidenceFileRef>;
  refs.primary = await writeCanonical(root, `${rootPath}/reviews/primary.json`, primary);
  refs.secondary = await writeCanonical(root, `${rootPath}/reviews/secondary.json`, secondary);
  if (judge) refs.adjudication = await writeCanonical(root, `${rootPath}/reviews/adjudication.json`, judge);
  refs.reconciliation = await writeCanonical(root, `${rootPath}/review-reconciliation.json`, reconciliation);
  const safety = artifact('candidate-safety', [reconciliation.reconciliationDigest], {
    reconciliationDigest: reconciliation.reconciliationDigest,
    reports: [{
      result: 'pass',
      candidateId: 'c1',
      profileSha256: H('profile'),
      configHash: H('config'),
      speechSha256: H('speech'),
      codePoints: 1,
      durationMs: 1,
      wavBytes: 46,
      limits: { codePoints: 500, durationMs: 120_000, wavBytes: 5_760_044 },
      reasons: [],
    }],
  });
  refs.safety = await writeCanonical(root, `${rootPath}/candidate-safety.json`, safety);
  const voice = artifact('voice-completeness', [refs.safety.sha256, reconciliation.reconciliationDigest], {
    planDigest: H('plan'),
    generationDigest: H('generation'),
    completenessDigest: H('completeness'),
    reconciliationDigest: reconciliation.reconciliationDigest,
    generation: {
      schemaVersion: '2',
      batchId: 'F003',
      workId: WORK,
      stagingRoot: '.cache/voice-stage',
      assets: [],
    } as never,
    completeness: { result: 'pass', batchId: 'F003', workId: WORK } as never,
  });
  refs.voice = await writeCanonical(root, `${rootPath}/voice-completeness.json`, voice);
  const capacity = artifact('capacity-actual', [refs.voice.sha256], {
    result: 'pass',
    planDigest: H('plan'),
    generationDigest: H('generation'),
    completenessDigest: H('completeness'),
    contentBuildSha256: H('build'),
    distSha256: H('dist'),
    actual: { result: 'pass', batchId: 'F003', workId: WORK } as never,
  });
  refs.capacity = await writeCanonical(root, `${rootPath}/capacity-actual.json`, capacity);
  const content = artifact('baseline-content', [refs.capacity.sha256], {
    result: 'pass',
    contentBuildSha256: H('build'),
    preview: {
      mode: 'work-preview',
      activeBatchId: 'F003',
      activeWorkId: WORK,
      buildSha256: H('build'),
      stagingRoot: '.cache/content-preview',
    } as never,
    invariant: { result: 'pass', buildSha256: H('build'), stagingSha256: H('build') } as never,
    publishedInvariant: {
      result: 'pass',
      target: 'work-preview',
      inputTreeSha256: H('build'),
      actualTreeSha256: H('build'),
      baselineSha256: H('published-baseline'),
      mismatches: [],
      reportSha256: H('published-report'),
    },
  });
  refs.content = await writeCanonical(root, `${rootPath}/baseline-content.json`, content);
  const dist = artifact('baseline-dist', [refs.content.sha256], {
    result: 'pass',
    contentBuildSha256: H('build'),
    distSha256: H('dist'),
    preview: {
      batchId: 'F003',
      workId: WORK,
      contentBuildSha256: H('build'),
      distSha256: H('dist'),
      outputRoot: '.cache/dist-preview',
    } as never,
    invariant: { result: 'pass', contentBuildSha256: H('build'), distSha256: H('dist') },
  });
  refs.dist = await writeCanonical(root, `${rootPath}/baseline-dist.json`, dist);
  const batch = manifest();
  await writeCanonical(root, 'content/batches/F003/batch.json', batch);
  const evidenceRefs: F003WorkEvidenceRefs = {
    primary: refs.primary!,
    secondary: refs.secondary!,
    ...(refs.adjudication ? { adjudication: refs.adjudication } : {}),
    reconciliation: refs.reconciliation!,
    candidateSafety: refs.safety!,
    voiceCompleteness: refs.voice!,
    capacityActual: refs.capacity!,
    baselineContent: refs.content!,
    baselineDist: refs.dist!,
  };
  const baseline: F003AcceptanceBaseline = {
    contentBuildSha256: H('build'),
    distSha256: H('dist'),
    voiceConfigHash: H('config'),
  };
  return { root, primary, secondary, judge, reconciliation, evidenceRefs, baseline, batch };
}

describe('F003 review bridge', () => {
  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it('resolutionをlegacy ReviewRecordへ決定的に写像しspeaker/input/anchor/seal時刻をhash chainへ結合する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f003-review-bridge-'));
    roots.push(root);
    const trusted = await trustSeals(root, [
      seal('primary', judgments(), '2026-07-26T08:00:00.000Z'),
      seal('secondary', judgments(), '2026-07-26T08:01:00.000Z'),
    ]);
    const primary = trusted.find((value) => value.header.role === 'primary')!;
    const secondary = trusted.find((value) => value.header.role === 'secondary')!;
    const resolution = reconcileIndependentJudgments(candidates(), primary, secondary);
    const first = bridgeEditorialResolutionSetToReviewRecords(WORK, resolution, primary, secondary);
    const second = bridgeEditorialResolutionSetToReviewRecords(WORK, resolution, primary, secondary);
    expect(first).toEqual(second);
    expect(first).toMatchObject([
      {
        candidateId: 'c1',
        workId: WORK,
        status: 'approved',
        policyDecision: 'allowed',
        reasonCode: 'SPOKEN_DIALOGUE',
        reviewer: 'editorial-independent:primary-authorization+secondary-authorization',
        reviewedAt: '2026-07-26T08:01:00.000Z',
      },
      { candidateId: 'c2', status: 'rejected', policyDecision: 'allowed', reasonCode: 'NON_SPEECH' },
    ]);
    expect(first[0]!.note).toContain(H('c1'));
    expect(first[0]!.note).toContain('body:1-2');
    expect(first[0]!.note).toContain('女生徒');
    expect(applyWorkReviews(WORK, pipelineCandidates(), first)).toMatchObject({
      counts: { approved: 1, rejected: 1, pending: 0 },
    });
  });

  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it('pending・topic-only・resolution改変を拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f003-review-bridge-'));
    roots.push(root);
    const trustedPending = await trustSeals(root, [
      seal('primary', judgments(), '2026-07-26T08:00:00.000Z'),
      seal('secondary', judgments('rejected'), '2026-07-26T08:01:00.000Z'),
    ]);
    const primary = trustedPending.find((value) => value.header.role === 'primary')!;
    const secondary = trustedPending.find((value) => value.header.role === 'secondary')!;
    const pending = reconcileIndependentJudgments(candidates(), primary, secondary);
    expect(() => bridgeEditorialResolutionSetToReviewRecords(WORK, pending, primary, secondary)).toThrow();
    const agreedRoot = await mkdtemp(join(tmpdir(), 'f003-review-bridge-agreed-'));
    roots.push(agreedRoot);
    const trustedAgreed = await trustSeals(agreedRoot, [
      seal('primary', judgments(), '2026-07-26T08:00:00.000Z'),
      seal('secondary', judgments(), '2026-07-26T08:01:00.000Z'),
    ]);
    const agreedPrimary = trustedAgreed.find((value) => value.header.role === 'primary')!;
    const agreedSecondary = trustedAgreed.find((value) => value.header.role === 'secondary')!;
    const agreed = reconcileIndependentJudgments(candidates(), agreedPrimary, agreedSecondary);
    const changed = {
      ...agreed,
      resolutions: [{ ...agreed.resolutions[0]!, sourceAnchor: 'other' }, ...agreed.resolutions.slice(1)],
    };
    expect(() => bridgeEditorialResolutionSetToReviewRecords(
      WORK,
      changed,
      agreedPrimary,
      agreedSecondary,
    )).toThrow();
  });
});

describe('F003 work acceptance', () => {
  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it.each([false, true])('canonical %s adjudication経路の8/9原artifactを再読込してprepareする', async (withJudge) => {
    const fixture = await acceptanceFixture(withJudge);
    const prepared = await prepareWorkAcceptance(
      fixture.root,
      'content/batches/F003/batch.json',
      WORK,
      fixture.evidenceRefs,
      fixture.baseline,
    );
    expect(prepared).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'f003-work-acceptance-prepared',
      batchId: 'F003',
      workId: WORK,
      evidenceCount: withJudge ? 9 : 8,
      reconciliationDigest: fixture.reconciliation.reconciliationDigest,
    });
  });

  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it('余分なadjudication・SHA差・後続work先行を拒否する', async () => {
    const fixture = await acceptanceFixture(false);
    await writeCanonical(
      fixture.root,
      `content/batches/F003/work-artifacts/${WORK}/reviews/adjudication.json`,
      fixture.primary,
    );
    await expect(prepareWorkAcceptance(
      fixture.root,
      'content/batches/F003/batch.json',
      WORK,
      fixture.evidenceRefs,
      fixture.baseline,
    )).rejects.toBeTruthy();
    await rm(join(fixture.root, 'content', 'batches', 'F003', 'work-artifacts', WORK, 'reviews', 'adjudication.json'));
    const changedRefs = {
      ...fixture.evidenceRefs,
      candidateSafety: { ...fixture.evidenceRefs.candidateSafety, sha256: H('changed') },
    };
    await expect(prepareWorkAcceptance(
      fixture.root,
      'content/batches/F003/batch.json',
      WORK,
      changedRefs,
      fixture.baseline,
    )).rejects.toBeTruthy();
  });

  /** @des DES-F003-008 @fun FUN-F003-020 @test UT-F003-020 */
  /** @des DES-F003-008 @fun FUN-F003-021 @test UT-F003-021 */
  it('既存promoterを1回だけ呼び、crash後はjournalから同じprepared tupleを回復する', async () => {
    const fixture = await acceptanceFixture(false);
    const prepared = await prepareWorkAcceptance(
      fixture.root,
      'content/batches/F003/batch.json',
      WORK,
      fixture.evidenceRefs,
      fixture.baseline,
    );
    let attempts = 0;
    const promoter = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('crash');
      return {
        kind: 'accepted',
        batchId: 'F003',
        workId: WORK,
        expectedManifestSha: prepared.manifestSha256,
        acceptedSources: [{
          path: 'content/batches/F003/accepted-audio/000275/audio.wav',
          sha256: H('audio'),
          bytes: 46,
          configHash: H('config'),
        }],
        preTreeDigest: H('pre'),
        postTreeDigest: H('post'),
        contentBuildSha: H('build'),
        contentStagingSha: H('build'),
        distSha: H('dist'),
        actualCapacityReportSha: H('capacity'),
        f001ContentInvariantReportSha: H('content'),
        f001DistInvariantReportSha: H('dist-report'),
        journalId: 'fixture-journal',
        acceptedAt: '2026-07-26T09:00:00.000Z',
        acceptedBy: `f003-acceptance:${prepared.preparedDigest}`,
      } as never;
    });
    await expect(promoteVerifiedWorkArtifacts(
      fixture.root,
      prepared,
      prepared.manifestSha256,
      { acceptedAt: '2026-07-26T09:00:00.000Z', promoter },
    )).rejects.toThrow('crash');
    const journalPath = join(
      fixture.root,
      '.cache',
      'transactions',
      'f003-work-acceptance',
      `F003-${WORK}.json`,
    );
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { preparedDigest: string };
    expect(journal.preparedDigest).toBe(prepared.preparedDigest);
    const recovered = await recoverWorkAcceptance(fixture.root, journalPath, { promoter });
    expect(recovered.evidence.workId).toBe(WORK);
    expect(promoter).toHaveBeenCalledTimes(2);
    const repeated = await recoverWorkAcceptance(fixture.root, journalPath, { promoter });
    expect(repeated.evidence).toEqual(recovered.evidence);
    expect(promoter).toHaveBeenCalledTimes(2);

    const acceptedManifest = transitionWorkState(
      manifest(),
      WORK,
      'accepted',
      recovered.evidence,
    );
    await writeCanonical(fixture.root, 'content/batches/F003/batch.json', acceptedManifest);
    const acceptedPrepared = await prepareWorkAcceptance(
      fixture.root,
      'content/batches/F003/batch.json',
      WORK,
      fixture.evidenceRefs,
      fixture.baseline,
    );
    expect(acceptedPrepared.preparedDigest).toBe(prepared.preparedDigest);
    const acceptedRepeated = await promoteVerifiedWorkArtifacts(
      fixture.root,
      acceptedPrepared,
      acceptedPrepared.manifestSha256,
      { promoter },
    );
    expect(acceptedRepeated.evidence).toEqual(recovered.evidence);
    expect(promoter).toHaveBeenCalledTimes(2);

    const mutations = [
      (value: BatchManifest) => {
        (value.workProgress[0] as { acceptedBy: string }).acceptedBy = '別の受入主体';
      },
      (value: BatchManifest) => {
        (value.workProgress[0] as { acceptedAt: string }).acceptedAt = '2026-07-26T09:00:01.000Z';
      },
      (value: BatchManifest) => {
        const source = value.workProgress[0]!.acceptedAudioSources![0] as { sha256: Sha256 };
        source.sha256 = H('changed-audio');
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(acceptedManifest);
      mutate(changed);
      await writeCanonical(fixture.root, 'content/batches/F003/batch.json', changed);
      const changedPrepared = await prepareWorkAcceptance(
        fixture.root,
        'content/batches/F003/batch.json',
        WORK,
        fixture.evidenceRefs,
        fixture.baseline,
      );
      await expect(promoteVerifiedWorkArtifacts(
        fixture.root,
        changedPrepared,
        changedPrepared.manifestSha256,
        { promoter },
      )).rejects.toMatchObject({ code: 'F003_ACCEPTANCE_JOURNAL_CONFLICT' });
    }
  });
});
