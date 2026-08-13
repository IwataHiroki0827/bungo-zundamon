import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import {
  BatchOperationError,
  type BatchCandidate,
  type BatchManifest,
  type DeploymentEvidence,
  type PreparedWorkAcceptanceEvidence,
  type PublicSmokeEvidence,
  type PublishBatchJournalPhase,
  type ReleaseApproval,
  type ReleaseBuildContext,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkStatus,
  type WorkspaceRelativePath,
  hashBatchManifest,
  createNextBatchTemplate,
  recordPublishedBatch,
  transitionBatchState,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
} from './batch.ts';

const HASH_A = 'a'.repeat(64) as Sha256;
const HASH_B = 'b'.repeat(64) as Sha256;
const HASH_C = 'c'.repeat(64) as Sha256;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function path(value: string): WorkspaceRelativePath {
  return value as WorkspaceRelativePath;
}

function canonicalSha(value: unknown): Sha256 {
  return createHash('sha256').update(canonicalJson(value)).digest('hex') as Sha256;
}

function evidenceCore(evidence: ReleaseApproval | DeploymentEvidence | PublicSmokeEvidence): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'evidenceRef' && key !== 'evidenceSha256'),
  );
}

async function writeEvidenceArtifact(
  root: string,
  evidenceRef: WorkspaceRelativePath,
  core: Record<string, unknown>,
): Promise<Sha256> {
  const target = join(root, ...evidenceRef.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(core), 'utf8');
  return canonicalSha(core);
}

async function rewriteEvidenceArtifact(
  root: string,
  evidence: ReleaseApproval | DeploymentEvidence | PublicSmokeEvidence,
  core: Record<string, unknown> = evidenceCore(evidence),
): Promise<void> {
  const evidenceSha256 = await writeEvidenceArtifact(root, evidence.evidenceRef, core);
  Object.assign(evidence, { evidenceSha256 });
}

function fixture(): BatchManifest {
  return {
    batchId: 'F002' as BatchManifest['batchId'],
    feature: 'F002',
    schemaVersion: '1.0.0',
    status: 'draft',
    author: {
      authorId: '000081',
      name: 'みやざわずんじ',
      originalName: '宮沢賢治',
      slug: 'miyazawa-zunji',
      identitySha256: HASH_A,
    },
    workIds: ['000473', '043752', '043754'] as unknown as BatchManifest['workIds'],
    workProgress: [
      { workId: '000473' as WorkId, status: 'pending', stageRecords: [] },
      { workId: '043752' as WorkId, status: 'pending', stageRecords: [] },
      { workId: '043754' as WorkId, status: 'pending', stageRecords: [] },
    ],
    inputPaths: [path('data/batches/F002/selected-works.json')],
    outputPaths: [path('content/batches/F002/provenance.json')],
    stageRecords: [],
    rightsSnapshotIds: ['aozora-selection-2026-07-20'],
    voiceConfigRef: path('content/batches/F002/voice-config.json'),
    artworkProvenanceRef: path('content/batches/F002/artwork-provenance.json'),
  };
}

function validated(value: BatchManifest = fixture()): BatchManifest {
  const result = validateBatchManifest(value);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function acceptedFixture(): BatchManifest {
  const manifest = fixture();
  const acceptedAt = '2026-07-20T00:00:00Z';
  return validated({
    ...manifest,
    status: 'accepted',
    workProgress: manifest.workIds.map((workId, index) => ({
      workId,
      status: 'accepted',
      stageRecords: [{
        stage: 'accepted',
        inputHashes: [HASH_A],
        toolVersion: 'accepted-audio-transaction-v1',
        outputHashes: [HASH_B],
        count: 1,
        completedAt: acceptedAt,
      }],
      acceptedAudioSources: [{
        path: path(`content/batches/F002/accepted-audio/${workId}/audio-${index}.wav`),
        sha256: HASH_B,
        bytes: 44,
        configHash: HASH_C,
      }],
      acceptedAt,
      acceptedBy: 'acceptor',
    })) as unknown as BatchManifest['workProgress'],
    acceptedAt,
    acceptedBy: 'acceptor',
  });
}

function f003AcceptedFixture(): BatchManifest {
  const manifest = acceptedFixture();
  const workIds = ['000275', '001567', '000258'] as unknown as BatchManifest['workIds'];
  return validated({
    ...manifest,
    batchId: 'F003' as BatchManifest['batchId'],
    feature: 'F003',
    author: {
      authorId: '000035',
      name: 'だざいおさむ',
      originalName: '太宰治',
      slug: 'dazai-osamu',
      identitySha256: HASH_A,
    },
    workIds,
    workProgress: workIds.map((workId, index) => ({
      ...manifest.workProgress[index]!,
      workId,
      acceptedAudioSources: [{
        ...manifest.workProgress[index]!.acceptedAudioSources![0]!,
        path: path(`content/batches/F003/accepted-audio/${workId}/audio-${index}.wav`),
      }],
    })) as unknown as BatchManifest['workProgress'],
    inputPaths: [path('data/batches/F003/selected-works.json')],
    outputPaths: [path('content/batches/F003/provenance.json')],
    voiceConfigRef: path('content/batches/F003/voice-config.json'),
    artworkProvenanceRef: path('content/batches/F003/artwork-provenance.json'),
  });
}

function f004AcceptedFixture(): BatchManifest {
  const manifest = f003AcceptedFixture();
  return validated({
    ...manifest,
    batchId: 'F004' as BatchManifest['batchId'],
    feature: 'F004',
    author: {
      authorId: '000081',
      name: 'みやざわけんじ',
      originalName: '宮沢賢治',
      slug: 'miyazawa-kenji',
      identitySha256: HASH_A,
    },
    inputPaths: [path('data/batches/F004/selected-works.json')],
    outputPaths: [path('content/batches/F004/provenance.json')],
    voiceConfigRef: path('content/batches/F004/voice-config.json'),
    artworkProvenanceRef: path('content/batches/F004/artwork-provenance.json'),
    workProgress: manifest.workProgress.map((progress) => ({
      ...progress,
      acceptedAudioSources: progress.acceptedAudioSources?.map((source) => ({
        ...source,
        path: path(source.path.replace('content/batches/F003/', 'content/batches/F004/')),
      })),
    })) as unknown as BatchManifest['workProgress'],
  });
}

async function publishEvidence(root: string, manifest: BatchManifest): Promise<{
  release: ReleaseBuildContext;
  approval: ReleaseApproval;
  deployment: DeploymentEvidence;
  smoke: PublicSmokeEvidence;
}> {
  const release: ReleaseBuildContext = {
    releaseCandidateBatchId: manifest.batchId,
    feature: manifest.feature,
    releaseCommit: 'd'.repeat(40),
    distSha256: HASH_A,
    artifactDigest: HASH_B,
  };
  const approval = {
    ...release,
    result: 'approved' as const,
    approvedAt: '2026-07-20T01:00:00Z',
    releaseVersion: manifest.feature === 'F004' ? '0.4.0' : manifest.feature === 'F003' ? '0.3.0' : '0.2.0',
    evidenceRef: path(`docs/evidence/release/${manifest.batchId}-approval.json`),
    evidenceSha256: HASH_A,
  };
  const deployment = {
    ...release,
    result: 'success' as const,
    deployedAt: '2026-07-20T01:01:00Z',
    evidenceRef: path(`docs/evidence/release/${manifest.batchId}-deployment.json`),
    evidenceSha256: HASH_A,
    deployFlagDisabled: true,
  };
  const expectedRoutes = manifest.feature === 'F004'
    ? [
        '#/',
        '#/authors/akutagawa-zunnosuke',
        '#/authors/miyazawa-zunji',
        '#/authors/dazai-osamu',
        '#/favorites',
        '#/credits',
      ]
    : manifest.feature === 'F003'
      ? ['#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/authors/dazai-osamu', '#/credits']
      : ['#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits'];
  const smoke = {
    ...release,
    result: 'pass' as const,
    checkedAt: '2026-07-20T01:02:00Z',
    evidenceRef: path(`docs/evidence/release/${manifest.batchId}-smoke.json`),
    evidenceSha256: HASH_A,
    allRoutesCovered: true,
    expectedRoutes,
    routes: [...expectedRoutes],
  };
  await rewriteEvidenceArtifact(root, approval);
  await rewriteEvidenceArtifact(root, deployment);
  await rewriteEvidenceArtifact(root, smoke);
  return { release, approval, deployment, smoke };
}

async function publishFixture(manifest: BatchManifest = acceptedFixture()) {
  const root = await mkdtemp(join(tmpdir(), 'bungo-publish-'));
  temporaryDirectories.push(root);
  const manifestPath = path(`content/batches/${manifest.batchId}/batch.json`);
  const target = join(root, ...manifestPath.split('/'));
  await mkdir(join(root, 'content', 'batches', manifest.batchId), { recursive: true });
  await writeFile(target, canonicalJson(manifest), 'utf8');
  const evidence = await publishEvidence(root, manifest);
  return {
    root,
    manifestPath,
    target,
    manifest,
    expectedSha: hashBatchManifest(manifest),
    ...evidence,
  };
}

async function readValidatedManifest(target: string): Promise<BatchManifest> {
  const parsed = validateBatchManifest(JSON.parse(await readFile(target, 'utf8')) as unknown);
  if (!parsed.ok) throw new Error(`test manifest validation failed: ${parsed.error.code}`);
  return parsed.value;
}

function stage(
  manifest: BatchManifest,
  workId: WorkId,
  name: WorkStatus | 'rights-verified' | 'sources-fixed',
  input: Sha256,
  output: Sha256,
  extra: Partial<StageEvidence> = {},
): StageEvidence {
  return {
    kind: 'stage',
    expectedManifestSha: hashBatchManifest(manifest),
    workId,
    stage: name,
    inputHashes: [input],
    toolVersion: 'test-tool/1.0.0',
    outputHashes: [output],
    count: 1,
    completedAt: '2026-07-20T00:00:00Z',
    ...extra,
  };
}

describe('batch manifest contract [DES-F002-002][DES-F002-014]', () => {
  // @des DES-F002-002 DES-F002-014 @fun FUN-F002-001 @test UT-F002-001
  it('F002の固定work順と安全pathを検証してimmutable manifestを返す', () => {
    const source = fixture();
    const result = validateBatchManifest(source);
    expect(result).toMatchObject({ ok: true, success: true });
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.workProgress)).toBe(true);
    expect(result.value).not.toBe(source);
  });

  // @des DES-F002-002 DES-F002-014 @fun FUN-F002-001 @test UT-F002-001
  it.each([
    ['重複work', (value: BatchManifest) => Object.assign(value, { workIds: ['000473', '000473', '043754'] }), 'BATCH_WORK_DUPLICATE'],
    ['順序違い', (value: BatchManifest) => Object.assign(value, { workIds: ['043752', '000473', '043754'] }), 'BATCH_SCHEMA_INVALID'],
    ['絶対path', (value: BatchManifest) => Object.assign(value, { inputPaths: ['C:/outside.json'] }), 'BATCH_PATH_INVALID'],
    ['親参照path', (value: BatchManifest) => Object.assign(value, { outputPaths: ['content/../outside.json'] }), 'BATCH_PATH_INVALID'],
    ['Windows ADS', (value: BatchManifest) => Object.assign(value, { outputPaths: ['content/file.json:stream'] }), 'BATCH_PATH_INVALID'],
    ['Windows予約名', (value: BatchManifest) => Object.assign(value, { outputPaths: ['content/CON.json'] }), 'BATCH_PATH_INVALID'],
    ['control文字', (value: BatchManifest) => Object.assign(value, { outputPaths: ['content/file\u0001.json'] }), 'BATCH_PATH_INVALID'],
    ['authorId桁不足', (value: BatchManifest) => Object.assign(value.author, { authorId: '81' }), 'BATCH_SCHEMA_INVALID'],
    ['author slug大文字', (value: BatchManifest) => Object.assign(value.author, { slug: 'Miyazawa-Zunji' }), 'BATCH_SCHEMA_INVALID'],
    ['author slug連続hyphen', (value: BatchManifest) => Object.assign(value.author, { slug: 'miyazawa--zunji' }), 'BATCH_SCHEMA_INVALID'],
  ])('%sを全体拒否する', (_label, mutate, code) => {
    const value = fixture();
    mutate(value);
    expect(validateBatchManifest(value)).toMatchObject({ ok: false, error: { code } });
  });

  // @des DES-F002-002 DES-F002-014 @fun FUN-F002-001 @test UT-F002-001
  it('work/status/stage recordが矛盾する偽装reviewed manifestを拒否する', () => {
    const value = fixture();
    Object.assign(value, { status: 'reviewed' });
    expect(validateBatchManifest(value)).toMatchObject({ ok: false, error: { code: 'BATCH_SCHEMA_INVALID' } });
    const stagedBase = fixture();
    const staged = {
      ...stagedBase,
      workProgress: [
        { workId: stagedBase.workIds[0], status: 'reviewed', stageRecords: [] },
        stagedBase.workProgress[1],
        stagedBase.workProgress[2],
      ],
    } as BatchManifest;
    expect(validateBatchManifest(staged)).toMatchObject({ ok: false, error: { code: 'BATCH_STAGE_HASH_MISMATCH' } });
  });
});

describe('単方向状態遷移 [DES-F002-002][DES-F002-015]', () => {
  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-002 @test UT-F002-002
  it('batchの許可edgeだけをimmutableに進め、retryでrecordを重複させない', () => {
    const before = validated();
    const evidence = stage(before, before.workIds[0], 'rights-verified', HASH_A, HASH_B);
    const after = transitionBatchState(before, 'rights-verified', evidence);
    expect(after).toMatchObject({ status: 'rights-verified' });
    expect(after.stageRecords).toHaveLength(1);
    expect(transitionBatchState(after, 'rights-verified', evidence)).toBe(after);
    expect(before).toMatchObject({ status: 'draft', stageRecords: [] });
    expect(() => transitionBatchState(before, 'sources-fixed', evidence)).toThrow(expect.objectContaining<Partial<BatchOperationError>>({ code: 'BATCH_STATE_SKIP' }));
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-031 @test UT-F002-031
  it('workを1 edgeずつ進め、acceptedだけprepared evidenceでsourceを固定する', () => {
    const workId = '000473' as WorkId;
    let manifest = validated();
    let previousOutput = HASH_A;
    const progress = (
      next: Exclude<WorkStatus, 'pending' | 'accepted'>,
      output: Sha256,
      extra: Partial<StageEvidence> = {},
    ): void => {
      const evidence = stage(manifest, workId, next, previousOutput, output, extra);
      manifest = transitionWorkState(manifest, workId, next, evidence);
      previousOutput = output;
    };
    progress('extracted', HASH_B);
    progress('reviewed', HASH_C, { result: 'pass', pendingCount: 0 });
    progress('budget-approved', HASH_A, { result: 'pass_with_warning', forecastRef: path('data/batches/F002/forecast/000473.json') });
    progress('voiced', HASH_B, { result: 'pass', voiceEvidenceRef: path('data/batches/F002/voice/000473.json') });
    const prepared: PreparedWorkAcceptanceEvidence = {
      kind: 'accepted',
      batchId: manifest.batchId,
      workId,
      expectedManifestSha: hashBatchManifest(manifest),
      acceptedSources: [{
        path: path('content/batches/F002/accepted-audio/000473/audio-1.wav'),
        sha256: HASH_C,
        bytes: 44,
        configHash: HASH_A,
      }],
      preTreeDigest: HASH_A,
      postTreeDigest: HASH_C,
      contentBuildSha: HASH_B,
      contentStagingSha: HASH_A,
      distSha: HASH_C,
      actualCapacityReportSha: HASH_A,
      f001ContentInvariantReportSha: HASH_B,
      f001DistInvariantReportSha: HASH_C,
      journalId: 'accept-F002-000473-1',
      acceptedAt: '2026-07-20T00:01:00Z',
      acceptedBy: 'reviewer',
    };
    const accepted = transitionWorkState(manifest, workId, 'accepted', prepared);
    expect(accepted.workProgress[0]).toMatchObject({
      status: 'accepted',
      acceptedAudioSources: [{ path: 'content/batches/F002/accepted-audio/000473/audio-1.wav' }],
    });
    expect(accepted.workProgress.slice(1).map((work) => work.status)).toEqual(['pending', 'pending']);
    expect(accepted.status).toBe('draft');
    expect(transitionWorkState(accepted, workId, 'accepted', prepared)).toBe(accepted);
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-031 @test UT-F002-031
  it('skip、stale evidence、前work未acceptedの後続reviewを拒否する', () => {
    const manifest = validated();
    const second = manifest.workIds[1];
    expect(() => transitionWorkState(
      manifest,
      second,
      'reviewed',
      stage(manifest, second, 'reviewed', HASH_A, HASH_B, { result: 'pass', pendingCount: 0 }),
    )).toThrow(expect.objectContaining<Partial<BatchOperationError>>({ code: 'WORK_STATE_SKIP' }));
    const extracted = transitionWorkState(manifest, second, 'extracted', stage(manifest, second, 'extracted', HASH_A, HASH_B));
    expect(() => transitionWorkState(
      extracted,
      second,
      'reviewed',
      stage(extracted, second, 'reviewed', HASH_B, HASH_C, { result: 'pass', pendingCount: 0 }),
    )).toThrow(expect.objectContaining<Partial<BatchOperationError>>({ code: 'WORK_ORDER_BLOCKED' }));
    const stale = stage(manifest, manifest.workIds[0], 'extracted', HASH_A, HASH_B);
    const advanced = transitionBatchState(manifest, 'rights-verified', stage(manifest, manifest.workIds[0], 'rights-verified', HASH_A, HASH_C));
    expect(() => transitionWorkState(advanced, advanced.workIds[0], 'extracted', stale)).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'WORK_EVIDENCE_STALE' }),
    );
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-031 @test UT-F002-031
  it('workId欠落・stage名違い・pendingCount欠落のreview証跡を拒否する', () => {
    const workId = '000473' as WorkId;
    const manifest = validated();
    const extracted = transitionWorkState(manifest, workId, 'extracted', stage(manifest, workId, 'extracted', HASH_A, HASH_B));
    const base = stage(extracted, workId, 'reviewed', HASH_B, HASH_C, { result: 'pass', pendingCount: 0 });
    expect(() => transitionWorkState(extracted, workId, 'reviewed', { ...base, workId: undefined })).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'WORK_EVIDENCE_STALE' }),
    );
    expect(() => transitionWorkState(extracted, workId, 'reviewed', { ...base, stage: 'voice' })).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'WORK_GATE_INCOMPLETE' }),
    );
    expect(() => transitionWorkState(extracted, workId, 'reviewed', { ...base, pendingCount: undefined })).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'WORK_GATE_INCOMPLETE' }),
    );
  });
});

// Direct transaction trace: IT-F002-009 QT-F002-014
describe('expected SHA付きmanifest atomic write [DES-F002-002][DES-F002-015]', () => {
  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 @test UT-F002-003
  it('canonical bytesへ置換し、保存後SHAを返す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-batch-'));
    temporaryDirectories.push(root);
    const manifestPath = path('content/batches/F002/batch.json');
    const target = join(root, ...manifestPath.split('/'));
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    const before = validated();
    await writeFile(target, canonicalJson(before), 'utf8');
    const expected = hashBatchManifest(before);
    const evidence = stage(before, before.workIds[0], 'rights-verified', HASH_A, HASH_B);
    const next = transitionBatchState(before, 'rights-verified', evidence);
    const savedSha = await writeBatchManifestAtomic(root, manifestPath, next, expected);
    expect(savedSha).toBe(hashBatchManifest(next));
    expect(await readFile(target, 'utf8')).toBe(canonicalJson(next));
    expect(await writeBatchManifestAtomic(root, manifestPath, next, expected)).toBe(savedSha);
  });

  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 @test UT-F002-003
  it('expected SHA不一致とworkspace外pathを拒否して旧fileを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-batch-'));
    temporaryDirectories.push(root);
    const manifestPath = path('content/batches/F002/batch.json');
    const target = join(root, ...manifestPath.split('/'));
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    const manifest = validated();
    const bytes = canonicalJson(manifest);
    await writeFile(target, bytes, 'utf8');
    const next = transitionBatchState(
      manifest,
      'rights-verified',
      stage(manifest, manifest.workIds[0], 'rights-verified', HASH_A, HASH_B),
    );
    await expect(writeBatchManifestAtomic(root, manifestPath, next, HASH_C)).rejects.toEqual(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'BATCH_WRITE_CONFLICT' }),
    );
    await expect(writeBatchManifestAtomic(root, path('../batch.json'), manifest, hashBatchManifest(manifest))).rejects.toEqual(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'BATCH_WORKSPACE_BOUNDARY' }),
    );
    expect(await readFile(target, 'utf8')).toBe(bytes);
  });

  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 @test UT-F002-003
  it.each(['prepared', 'replaced'] as const)('%s journal直後の停止から旧版または検証済み新版へ収束する', async (faultPhase) => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-batch-recovery-'));
    temporaryDirectories.push(root);
    const manifestPath = path('content/batches/F002/batch.json');
    const target = join(root, ...manifestPath.split('/'));
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    const before = validated();
    await writeFile(target, canonicalJson(before), 'utf8');
    const next = transitionBatchState(
      before,
      'rights-verified',
      stage(before, before.workIds[0], 'rights-verified', HASH_A, HASH_B),
    );
    await expect(writeBatchManifestAtomic(root, manifestPath, next, hashBatchManifest(before), {
      afterPhase: (phase) => {
        if (phase === faultPhase) throw new Error(`fault:${phase}`);
      },
    })).rejects.toThrow(`fault:${faultPhase}`);
    const afterFault = await readFile(target, 'utf8');
    expect([canonicalJson(before), canonicalJson(next)]).toContain(afterFault);
    await expect(writeBatchManifestAtomic(root, manifestPath, next, hashBatchManifest(before))).resolves.toBe(hashBatchManifest(next));
    expect(await readFile(target, 'utf8')).toBe(canonicalJson(next));
    expect(await readFile(join(root, '.cache', 'transactions', 'batch-manifest', 'F002.json'), 'utf8')).toContain('"phase": "verified"');
  });

  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 @test UT-F002-003
  it('replaced直後に実processを強制終了しても再起動時にverifiedへ収束する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-batch-process-recovery-'));
    temporaryDirectories.push(root);
    const manifestPath = path('content/batches/F002/batch.json');
    const target = join(root, ...manifestPath.split('/'));
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    const before = validated();
    await writeFile(target, canonicalJson(before), 'utf8');
    const next = transitionBatchState(before, 'rights-verified', stage(before, before.workIds[0], 'rights-verified', HASH_A, HASH_B));
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'content', 'batch.ts')).href;
    const source = [
      `import { writeBatchManifestAtomic } from ${JSON.stringify(moduleUrl)};`,
      `const next = ${JSON.stringify(next)};`,
      `await writeBatchManifestAtomic(${JSON.stringify(root)}, 'content/batches/F002/batch.json', next, ${JSON.stringify(hashBatchManifest(before))}, {`,
      `  afterPhase(phase) { if (phase === 'replaced') process.kill(process.pid, 'SIGKILL'); },`,
      `});`,
    ].join('\n');
    const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', source], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    expect(exit.code === 0 && exit.signal === null).toBe(false);
    await expect(writeBatchManifestAtomic(root, manifestPath, next, hashBatchManifest(before))).resolves.toBe(hashBatchManifest(next));
    expect(await readFile(target, 'utf8')).toBe(canonicalJson(next));
  });

  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 @test UT-F002-003
  it('進行中journalと一致しない第三者hashを隔離して上書きしない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-batch-quarantine-'));
    temporaryDirectories.push(root);
    const manifestPath = path('content/batches/F002/batch.json');
    const target = join(root, ...manifestPath.split('/'));
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    const before = validated();
    await writeFile(target, canonicalJson(before), 'utf8');
    const next = transitionBatchState(before, 'rights-verified', stage(before, before.workIds[0], 'rights-verified', HASH_A, HASH_B));
    await expect(writeBatchManifestAtomic(root, manifestPath, next, hashBatchManifest(before), {
      afterPhase: (phase) => { if (phase === 'prepared') throw new Error('stop-before-rename'); },
    })).rejects.toThrow('stop-before-rename');
    await writeFile(target, '{"owner":"third-party"}\n', 'utf8');
    await expect(writeBatchManifestAtomic(root, manifestPath, next, hashBatchManifest(before))).rejects.toMatchObject({ code: 'BATCH_WRITE_CONFLICT' });
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantine = join(root, '.cache', 'quarantine', 'batch-manifest');
    await expect(readdir(quarantine)).resolves.toHaveLength(1);
  });

  // @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 @test UT-F002-003
  it('破損・未知field付きjournalを読込時に拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-batch-journal-invalid-'));
    temporaryDirectories.push(root);
    const manifestPath = path('content/batches/F002/batch.json');
    const target = join(root, ...manifestPath.split('/'));
    const journal = join(root, '.cache', 'transactions', 'batch-manifest', 'F002.json');
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    await mkdir(join(root, '.cache', 'transactions', 'batch-manifest'), { recursive: true });
    const manifest = validated();
    await writeFile(target, canonicalJson(manifest), 'utf8');
    await writeFile(journal, '{"schemaVersion":"1.0.0","phase":"owned-by-third-party"}\n', 'utf8');
    await expect(writeBatchManifestAtomic(root, manifestPath, manifest, hashBatchManifest(manifest))).rejects.toMatchObject({
      code: 'BATCH_WRITE_CONFLICT',
    });
    expect(await readFile(target, 'utf8')).toBe(canonicalJson(manifest));
  });
});

// Direct transaction trace: IT-F002-009 QT-F002-014
describe('published遷移transaction [DES-F002-002][DES-F002-015][DES-F002-016][UT-F003-029]', () => {
  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it('同一candidateのapproval/deploy/smokeだけをcanonical published manifestへ一度だけ記録する', async () => {
    const input = await publishFixture();
    const result = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    expect(result.manifest).toMatchObject({
      status: 'published',
      acceptedAt: input.manifest.acceptedAt,
      acceptedBy: input.manifest.acceptedBy,
      publishedAt: input.smoke.checkedAt,
      releaseVersion: input.approval.releaseVersion,
      deploymentEvidenceRef: input.deployment.evidenceRef,
      smokeEvidenceRef: input.smoke.evidenceRef,
    });
    expect(result.sha256).toBe(hashBatchManifest(result.manifest));
    const manifestBytes = await readFile(input.target, 'utf8');
    const releaseJournalPath = join(input.root, '.cache', 'transactions', 'release-publish', 'F002.json');
    const releaseJournal = await readFile(releaseJournalPath, 'utf8');
    expect(manifestBytes).toBe(canonicalJson(result.manifest));
    expect(releaseJournal).toContain('"phase": "published-verified"');
    expect(await readFile(join(input.root, '.cache', 'transactions', 'batch-manifest', 'F002.json'), 'utf8'))
      .toContain('"phase": "verified"');

    const resumed = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      await readValidatedManifest(input.target),
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    expect(resumed).toEqual(result);
    expect(await readFile(input.target, 'utf8')).toBe(manifestBytes);
    expect(await readFile(releaseJournalPath, 'utf8')).toBe(releaseJournal);
  });

  // @des DES-F003-012 @fun FUN-F003-029 @test UT-F003-029
  it('F003の公開5 routeを同一candidateへ結合してpublishedへ記録する', async () => {
    const input = await publishFixture(f003AcceptedFixture());
    const result = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    expect(result.manifest).toMatchObject({
      batchId: 'F003',
      feature: 'F003',
      status: 'published',
      releaseVersion: '0.3.0',
      deploymentEvidenceRef: 'docs/evidence/release/F003-deployment.json',
      smokeEvidenceRef: 'docs/evidence/release/F003-smoke.json',
    });
  });

  // @des DES-F004-013 @fun FUN-F002-037 @test UT-F004-021
  it('F004の公開6 routeを同一candidateへ結合してpublishedへ記録する', async () => {
    const input = await publishFixture(f004AcceptedFixture());
    const result = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    expect(result.manifest).toMatchObject({
      batchId: 'F004',
      feature: 'F004',
      status: 'published',
      releaseVersion: '0.4.0',
      deploymentEvidenceRef: 'docs/evidence/release/F004-deployment.json',
      smokeEvidenceRef: 'docs/evidence/release/F004-smoke.json',
    });
  });

  // @des DES-F003-012 @fun FUN-F003-029 @test UT-F003-029
  it('未知featureの自己申告routeを拒否してaccepted manifestをbyte不変で維持する', async () => {
    const input = await publishFixture(validated({ ...acceptedFixture(), feature: 'F999' }));
    const before = await readFile(input.target, 'utf8');
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    )).rejects.toMatchObject({ code: 'PUBLISH_SMOKE_FAILED' });
    expect(await readFile(input.target, 'utf8')).toBe(before);
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it.each([
    ['candidate tuple', (input: Awaited<ReturnType<typeof publishFixture>>) => {
      Object.assign(input.release, { feature: 'F003' });
    }, 'PUBLISH_CANDIDATE_MISMATCH'],
    ['approval tuple', (input: Awaited<ReturnType<typeof publishFixture>>) => {
      Object.assign(input.approval, { releaseCommit: 'e'.repeat(40) });
    }, 'PUBLISH_APPROVAL_MISMATCH'],
    ['deployment失敗', (input: Awaited<ReturnType<typeof publishFixture>>) => {
      Object.assign(input.deployment, { result: 'failed' });
    }, 'PUBLISH_DEPLOYMENT_MISMATCH'],
    ['deploy flag有効', (input: Awaited<ReturnType<typeof publishFixture>>) => {
      Object.assign(input.deployment, { deployFlagDisabled: false });
    }, 'PUBLISH_DEPLOY_FLAG_ACTIVE'],
    ['route smoke欠落', (input: Awaited<ReturnType<typeof publishFixture>>) => {
      Object.assign(input.smoke, { routes: [] });
    }, 'PUBLISH_SMOKE_FAILED'],
  ] as const)('%sを拒否してaccepted manifestをbyte不変で維持する', async (_label, mutate, code) => {
    const input = await publishFixture();
    const before = await readFile(input.target, 'utf8');
    mutate(input);
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    )).rejects.toEqual(expect.objectContaining<Partial<BatchOperationError>>({ code }));
    expect(await readFile(input.target, 'utf8')).toBe(before);
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it.each([
    ['存在しないapproval証跡', async (input: Awaited<ReturnType<typeof publishFixture>>) => {
      await rm(join(input.root, ...input.approval.evidenceRef.split('/')));
    }, 'PUBLISH_APPROVAL_MISMATCH'],
    ['candidate tupleが変わったapproval証跡', async (input: Awaited<ReturnType<typeof publishFixture>>) => {
      await rewriteEvidenceArtifact(input.root, input.approval, {
        ...evidenceCore(input.approval),
        releaseCommit: 'e'.repeat(40),
      });
    }, 'PUBLISH_APPROVAL_MISMATCH'],
    ['入力SHAと一致しないdeployment証跡', async (input: Awaited<ReturnType<typeof publishFixture>>) => {
      Object.assign(input.deployment, { evidenceSha256: HASH_C });
    }, 'PUBLISH_DEPLOYMENT_MISMATCH'],
  ] as const)('%sを実体検証で拒否する', async (_label, mutate, code) => {
    const input = await publishFixture();
    const before = await readFile(input.target, 'utf8');
    await mutate(input);
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    )).rejects.toMatchObject({ code });
    expect(await readFile(input.target, 'utf8')).toBe(before);
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it.each([
    ['自己申告subset', {
      expectedRoutes: ['#/', '#/credits'],
      routes: ['#/', '#/credits'],
    }],
    ['別author', {
      expectedRoutes: ['#/', '#/authors/dazai-osamu', '#/authors/natsume-soseki', '#/credits'],
      routes: ['#/', '#/authors/dazai-osamu', '#/authors/natsume-soseki', '#/credits'],
    }],
    ['余剰route', {
      expectedRoutes: [
        '#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits', '#/about',
      ],
      routes: [
        '#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits', '#/about',
      ],
    }],
    ['duplicate', {
      expectedRoutes: ['#/', '#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits'],
      routes: ['#/', '#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits'],
    }],
  ] as const)('smoke routeの%sを証跡ファイルと入力が一致していても拒否する', async (_label, routeUpdate) => {
    const input = await publishFixture();
    Object.assign(input.smoke, routeUpdate);
    await rewriteEvidenceArtifact(input.root, input.smoke);
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    )).rejects.toMatchObject({ code: 'PUBLISH_SMOKE_FAILED' });
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it.each([
    'deploy-verified',
    'manifest-prepared',
    'manifest-written',
    'published-verified',
  ] as const)('%s journal直後の停止からdeployなしでpublishedへ収束する', async (faultPhase) => {
    const input = await publishFixture();
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
      {
        afterPhase: (phase: PublishBatchJournalPhase) => {
          if (phase === faultPhase) throw new Error(`fault:${phase}`);
        },
      },
    )).rejects.toThrow(`fault:${faultPhase}`);
    const afterFault = await readValidatedManifest(input.target);
    expect(['accepted', 'published']).toContain(afterFault.status);
    const resumed = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      afterFault,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    expect(resumed.manifest.status).toBe('published');
    expect(await readFile(join(input.root, '.cache', 'transactions', 'release-publish', 'F002.json'), 'utf8'))
      .toContain('"phase": "published-verified"');
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it('manifest-written停止後に証跡が変化した場合はdisk上publishedからの再開をfail-closedにする', async () => {
    const input = await publishFixture();
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
      {
        afterPhase: (phase) => {
          if (phase === 'manifest-written') throw new Error('fault:manifest-written');
        },
      },
    )).rejects.toThrow('fault:manifest-written');
    const published = await readValidatedManifest(input.target);
    await writeFile(
      join(input.root, ...input.smoke.evidenceRef.split('/')),
      canonicalJson({ ...evidenceCore(input.smoke), checkedAt: '2026-07-20T01:03:00Z' }),
      'utf8',
    );
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      published,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    )).rejects.toMatchObject({ code: 'PUBLISH_SMOKE_FAILED' });
    expect(await readFile(join(input.root, '.cache', 'transactions', 'release-publish', 'F002.json'), 'utf8'))
      .toContain('"phase": "manifest-written"');
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it('published manifest再読込後にも全証跡を再検証する', async () => {
    const input = await publishFixture();
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
      {
        afterPhase: async (phase) => {
          if (phase !== 'manifest-written') return;
          await writeFile(
            join(input.root, ...input.deployment.evidenceRef.split('/')),
            canonicalJson({ ...evidenceCore(input.deployment), deployedAt: '2026-07-20T01:01:30Z' }),
            'utf8',
          );
        },
      },
    )).rejects.toMatchObject({ code: 'PUBLISH_DEPLOYMENT_MISMATCH' });
    expect((await readValidatedManifest(input.target)).status).toBe('published');
    expect(await readFile(join(input.root, '.cache', 'transactions', 'release-publish', 'F002.json'), 'utf8'))
      .toContain('"phase": "manifest-written"');
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it.each(['prepared', 'replaced'] as const)('FUN-003の%s停止から同じevidenceで再開する', async (faultPhase) => {
    const input = await publishFixture();
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
      {
        manifestWriteOptions: {
          afterPhase: (phase) => {
            if (phase === faultPhase) throw new Error(`manifest-fault:${phase}`);
          },
        },
      },
    )).rejects.toThrow(`manifest-fault:${faultPhase}`);
    const resumed = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      await readValidatedManifest(input.target),
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    expect(resumed.manifest.status).toBe('published');
    expect(await readFile(join(input.root, '.cache', 'transactions', 'batch-manifest', 'F002.json'), 'utf8'))
      .toContain('"phase": "verified"');
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it('expected SHA競合・第三者manifest・published入力を上書きしない', async () => {
    const stale = await publishFixture();
    const acceptedBytes = await readFile(stale.target, 'utf8');
    await expect(recordPublishedBatch(
      stale.root,
      stale.manifestPath,
      stale.manifest,
      HASH_C,
      stale.release,
      stale.approval,
      stale.deployment,
      stale.smoke,
    )).rejects.toMatchObject({ code: 'BATCH_WRITE_CONFLICT' });
    expect(await readFile(stale.target, 'utf8')).toBe(acceptedBytes);

    const thirdParty = await publishFixture();
    await expect(recordPublishedBatch(
      thirdParty.root,
      thirdParty.manifestPath,
      thirdParty.manifest,
      thirdParty.expectedSha,
      thirdParty.release,
      thirdParty.approval,
      thirdParty.deployment,
      thirdParty.smoke,
      {
        afterPhase: (phase) => {
          if (phase === 'manifest-prepared') throw new Error('stop-before-manifest');
        },
      },
    )).rejects.toThrow('stop-before-manifest');
    const thirdPartyBytes = '{"owner":"third-party"}\n';
    await writeFile(thirdParty.target, thirdPartyBytes, 'utf8');
    await expect(recordPublishedBatch(
      thirdParty.root,
      thirdParty.manifestPath,
      thirdParty.manifest,
      thirdParty.expectedSha,
      thirdParty.release,
      thirdParty.approval,
      thirdParty.deployment,
      thirdParty.smoke,
    )).rejects.toMatchObject({ code: 'BATCH_WRITE_CONFLICT' });
    expect(await readFile(thirdParty.target, 'utf8')).toBe(thirdPartyBytes);

    const publishedInput = await publishFixture();
    const result = await recordPublishedBatch(
      publishedInput.root,
      publishedInput.manifestPath,
      publishedInput.manifest,
      publishedInput.expectedSha,
      publishedInput.release,
      publishedInput.approval,
      publishedInput.deployment,
      publishedInput.smoke,
    );
    await rm(join(publishedInput.root, '.cache', 'transactions', 'release-publish', 'F002.json'));
    await expect(recordPublishedBatch(
      publishedInput.root,
      publishedInput.manifestPath,
      result.manifest,
      publishedInput.expectedSha,
      publishedInput.release,
      publishedInput.approval,
      publishedInput.deployment,
      publishedInput.smoke,
    )).rejects.toMatchObject({ code: 'PUBLISH_NOT_ACCEPTED' });
  });

  // @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 @test UT-F002-037
  it('完了journalは同一evidenceだけを冪等許可し、別evidenceを拒否する', async () => {
    const input = await publishFixture();
    const result = await recordPublishedBatch(
      input.root,
      input.manifestPath,
      input.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    );
    Object.assign(input.approval, { approvedAt: '2026-07-20T00:59:00Z' });
    await rewriteEvidenceArtifact(input.root, input.approval);
    await expect(recordPublishedBatch(
      input.root,
      input.manifestPath,
      result.manifest,
      input.expectedSha,
      input.release,
      input.approval,
      input.deployment,
      input.smoke,
    )).rejects.toMatchObject({ code: 'BATCH_WRITE_CONFLICT' });
    expect(await readFile(input.target, 'utf8')).toBe(canonicalJson(result.manifest));
  });
});

describe('次batch template [DES-F002-014]', () => {
  function candidate(): BatchCandidate {
    return {
      candidateId: 'candidate-F003',
      approved: true,
      author: {
        authorId: '000035',
        name: 'だざいおさむ',
        originalName: '太宰治',
        slug: 'dazai-osamu',
        identitySha256: HASH_B,
      },
      works: [
        { workId: '000001', title: '作品一' },
        { workId: '000002', title: '作品二' },
        { workId: '000003', title: '作品三' },
      ],
      approvalGateRefs: {
        requirements: path('docs/srs/SRS-F003.md'),
        design: path('docs/design/DD-F003.md'),
        testspec: path('docs/tests/ut/UT-F003.md'),
        release: path('docs/evidence/release/F003-approval.json'),
      },
      existingFeatureIds: ['F001', 'F002'],
    };
  }

  // @des DES-F002-014 @fun FUN-F002-028 @test UT-F002-028
  it('承認済みcandidateからartifactなし・全work pendingのtemplateだけを作る', () => {
    const template = createNextBatchTemplate(candidate(), 'F003' as BatchManifest['batchId']);
    expect(template).toMatchObject({ batchId: 'F003', feature: 'F003', status: 'draft' });
    expect(template.workProgress.map((work) => work.status)).toEqual(['pending', 'pending', 'pending']);
    expect(template.stageRecords).toEqual([]);
    expect(template.inputPaths).toEqual([]);
    expect(template.outputPaths).toEqual([]);
    expect(Object.keys(template.approvalGateRefs ?? {})).toHaveLength(4);
    expect(JSON.stringify(template)).not.toContain('雪渡り');
  });

  // @des DES-F002-014 @fun FUN-F002-028 @test UT-F002-028
  it.each([
    ['未承認', (value: BatchCandidate) => Object.assign(value, { approved: false }), 'NEXT_BATCH_NOT_APPROVED'],
    ['artifact混入', (value: BatchCandidate) => Object.assign(value, { artifactPaths: ['public/catalog.json'] }), 'NEXT_BATCH_NOT_APPROVED'],
    ['作品不足', (value: BatchCandidate) => Object.assign(value, { works: value.works.slice(0, 2) }), 'NEXT_BATCH_WORKS_INCOMPLETE'],
    ['作品重複', (value: BatchCandidate) => Object.assign(value, { works: [value.works[0], value.works[0], value.works[2]] }), 'NEXT_BATCH_WORKS_INCOMPLETE'],
  ] as const)('%sを拒否する', (_label, mutate, code) => {
    const value = candidate();
    mutate(value);
    expect(() => createNextBatchTemplate(value, 'F003' as BatchManifest['batchId'])).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code }),
    );
  });

  // @des DES-F002-014 @fun FUN-F002-028 @test UT-F002-028
  it('使用済み・不正feature IDを拒否する', () => {
    expect(() => createNextBatchTemplate(candidate(), 'F002' as BatchManifest['batchId'])).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'NEXT_BATCH_FEATURE_COLLISION' }),
    );
    expect(() => createNextBatchTemplate(candidate(), 'next' as BatchManifest['batchId'])).toThrow(
      expect.objectContaining<Partial<BatchOperationError>>({ code: 'NEXT_BATCH_FEATURE_COLLISION' }),
    );
  });
});
