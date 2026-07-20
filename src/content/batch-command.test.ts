import { describe, expect, it, vi } from 'vitest';
import {
  type BatchDependencies,
  BatchCommandError,
  runBatchCommand,
  serializeBatchCommandResult,
} from './batch-command.ts';
import {
  type AcceptedAudioSource,
  type BatchManifest,
  type Sha256,
  type StageRecord,
  type WorkId,
  type WorkProgress,
  type WorkStatus,
  type WorkspaceRelativePath,
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
} from './batch.ts';

const A = 'a'.repeat(64) as Sha256;
const B = 'b'.repeat(64) as Sha256;

function path(value: string): WorkspaceRelativePath {
  return value as WorkspaceRelativePath;
}

function record(stage: string, input: Sha256 = A, output: Sha256 = B): StageRecord {
  return {
    stage,
    inputHashes: [input],
    outputHashes: [output],
    toolVersion: 'test/1.0.0',
    count: 1,
    completedAt: '2026-07-20T00:00:00Z',
  };
}

function work(workId: string, status: WorkStatus): WorkProgress {
  if (status === 'pending') return { workId: workId as WorkId, status, stageRecords: [] };
  const common = { workId: workId as WorkId, status, stageRecords: [record(status)] };
  if (status !== 'accepted') return common;
  const source: AcceptedAudioSource = {
    path: path(`content/batches/F002/accepted-audio/${workId}/audio.wav`),
    sha256: B,
    bytes: 44,
    configHash: A,
  };
  return { ...common, acceptedAt: '2026-07-20T00:00:00Z', acceptedBy: 'reviewer', acceptedAudioSources: [source] };
}

function manifest(statuses: readonly [WorkStatus, WorkStatus, WorkStatus] = ['pending', 'pending', 'pending']): BatchManifest {
  const allAccepted = statuses.every((status) => status === 'accepted');
  const raw: BatchManifest = {
    batchId: 'F002' as BatchManifest['batchId'],
    feature: 'F002',
    schemaVersion: '1.0.0',
    status: allAccepted ? 'accepted' : 'draft',
    author: {
      authorId: '000081',
      name: 'みやざわずんじ',
      originalName: '宮沢賢治',
      slug: 'miyazawa-zunji',
      identitySha256: A,
    },
    workIds: ['000473', '043752', '043754'] as unknown as BatchManifest['workIds'],
    workProgress: [work('000473', statuses[0]), work('043752', statuses[1]), work('043754', statuses[2])],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: [],
    voiceConfigRef: path('content/batches/F002/voice-config.json'),
    artworkProvenanceRef: path('content/batches/F002/artwork.json'),
    ...(allAccepted ? { acceptedAt: '2026-07-20T00:00:00Z', acceptedBy: 'reviewer' } : {}),
  };
  const checked = validateBatchManifest(raw);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

function dependencies(initial: BatchManifest): BatchDependencies & {
  executeStage: ReturnType<typeof vi.fn<BatchDependencies['executeStage']>>;
  persistManifest: ReturnType<typeof vi.fn<BatchDependencies['persistManifest']>>;
  acceptWork: ReturnType<typeof vi.fn<BatchDependencies['acceptWork']>>;
  prepareRelease: ReturnType<typeof vi.fn<BatchDependencies['prepareRelease']>>;
  verifyRelease: ReturnType<typeof vi.fn<BatchDependencies['verifyRelease']>>;
} {
  const terminal = { inputHashes: [A], outputHashes: [B], count: 1 };
  return {
    loadManifest: vi.fn(async () => initial),
    executeStage: vi.fn(async ({ manifest: current }) => ({ ...terminal, nextManifest: current })),
    persistManifest: vi.fn(async () => B),
    acceptWork: vi.fn(async () => terminal),
    prepareRelease: vi.fn(async () => terminal),
    verifyRelease: vi.fn(async () => terminal),
    verifyCommit: vi.fn(async () => true),
  };
}

describe('batch command adapter [DES-F002-002][DES-F002-014][DES-F002-015]', () => {
  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('review stageをwork付きで実行しmanifestを1回だけ保存する', async () => {
    const before = manifest(['extracted', 'pending', 'pending']);
    const deps = dependencies(before);
    const evidence = {
      kind: 'stage' as const,
      expectedManifestSha: hashBatchManifest(before),
      workId: before.workIds[0],
      stage: 'reviewed',
      inputHashes: [hashBatchManifest(before), B],
      outputHashes: [B],
      toolVersion: 'review/1.0.0',
      count: 1,
      completedAt: '2026-07-20T00:01:00Z',
      result: 'pass' as const,
      pendingCount: 0,
    };
    const next = transitionWorkState(before, before.workIds[0], 'reviewed', evidence);
    deps.executeStage.mockResolvedValue({ inputHashes: evidence.inputHashes, outputHashes: evidence.outputHashes, count: 1, nextManifest: next });
    const result = await runBatchCommand(['--batch', 'F002', '--work', '000473', '--stage', 'review'], 'C:/workspace', deps);
    expect(result).toMatchObject({ code: 0, stage: 'review', workId: '000473', workStatus: 'reviewed' });
    expect(deps.persistManifest).toHaveBeenCalledTimes(1);
    expect(serializeBatchCommandResult(result).split('\n')).toHaveLength(2);
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('acceptをtransactionへ完全委譲して外側manifest writeを行わない', async () => {
    const before = manifest(['voiced', 'pending', 'pending']);
    const deps = dependencies(before);
    const result = await runBatchCommand(['--batch', 'F002', '--work', '000473', '--stage', 'accept'], 'C:/workspace', deps);
    expect(result).toMatchObject({ code: 0, stage: 'accept' });
    expect(deps.acceptWork).toHaveBeenCalledTimes(1);
    expect(deps.persistManifest).not.toHaveBeenCalled();
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('allは完了hash chainを再実行せずreview manual gateで正常停止する', async () => {
    const before = manifest(['extracted', 'pending', 'pending']);
    const checked = validateBatchManifest({ ...before, status: 'rights-verified', stageRecords: [record('rights-verified')] });
    if (!checked.ok) throw new Error(checked.error.message);
    const deps = dependencies(checked.value);
    const result = await runBatchCommand(['--batch', 'F002', '--work', '000473', '--stage', 'all'], 'C:/workspace', deps);
    expect(result).toMatchObject({ code: 0, status: 'awaiting_manual_gate', gate: 'review' });
    expect(deps.executeStage).not.toHaveBeenCalled();
    expect(deps.persistManifest).not.toHaveBeenCalled();
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('後続work、work欠落、前段不足をstage別exit codeで拒否する', async () => {
    const deps = dependencies(manifest(['extracted', 'extracted', 'pending']));
    await expect(runBatchCommand(['--batch', 'F002', '--work', '043752', '--stage', 'review'], 'C:/workspace', deps)).rejects.toMatchObject({
      code: 'BATCH_WORK_ORDER_BLOCKED', exitCode: 4,
    });
    await expect(runBatchCommand(['--batch', 'F002', '--stage', 'review'], 'C:/workspace', deps)).rejects.toMatchObject({
      code: 'BATCH_WORK_REQUIRED', exitCode: 1,
    });
    const pendingDeps = dependencies(manifest());
    await expect(runBatchCommand(['--batch', 'F002', '--work', '000473', '--stage', 'review'], 'C:/workspace', pendingDeps)).rejects.toMatchObject({
      code: 'BATCH_STAGE_PREREQUISITE', exitCode: 4,
    });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('prepare/releaseはaccepted batchとexact clean commitを要求し、releaseはread-onlyに委譲する', async () => {
    const accepted = manifest(['accepted', 'accepted', 'accepted']);
    const deps = dependencies(accepted);
    const commit = 'c'.repeat(40);
    await expect(runBatchCommand(['--batch', 'F002', '--stage', 'release-verify'], 'C:/workspace', deps)).rejects.toMatchObject({
      code: 'BATCH_COMMIT_REQUIRED', exitCode: 1,
    });
    vi.mocked(deps.verifyCommit).mockResolvedValue(false);
    await expect(runBatchCommand(['--batch', 'F002', '--stage', 'prepare-release', '--commit', commit], 'C:/workspace', deps)).rejects.toMatchObject({
      code: 'BATCH_COMMIT_MISMATCH', exitCode: 8,
    });
    vi.mocked(deps.verifyCommit).mockResolvedValue(true);
    const result = await runBatchCommand(['--batch', 'F002', '--stage', 'release-verify', '--commit', commit], 'C:/workspace', deps);
    expect(result).toMatchObject({ stage: 'release-verify', commit });
    expect(deps.verifyRelease).toHaveBeenCalledTimes(1);
    expect(deps.persistManifest).not.toHaveBeenCalled();
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('production dependencyの前提不足codeをaccept/releaseで保持する', async () => {
    const acceptDeps = dependencies(manifest(['voiced', 'pending', 'pending']));
    vi.mocked(acceptDeps.acceptWork).mockRejectedValue(
      new BatchCommandError('BATCH_STAGE_PREREQUISITE', 7, 'accept artifactが不足しています', 'accept'),
    );
    await expect(runBatchCommand(
      ['--batch', 'F002', '--work', '000473', '--stage', 'accept'],
      'C:/workspace',
      acceptDeps,
    )).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE', exitCode: 7 });

    const releaseDeps = dependencies(manifest(['accepted', 'accepted', 'accepted']));
    vi.mocked(releaseDeps.prepareRelease).mockRejectedValue(
      new BatchCommandError('BATCH_STAGE_PREREQUISITE', 8, 'release artifactが不足しています', 'prepare-release'),
    );
    await expect(runBatchCommand(
      ['--batch', 'F002', '--stage', 'prepare-release', '--commit', 'c'.repeat(40)],
      'C:/workspace',
      releaseDeps,
    )).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE', exitCode: 8 });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('未知引数とmanifest外workをexit 1で拒否する', async () => {
    const deps = dependencies(manifest());
    await expect(runBatchCommand(['--batch', 'F002', '--unknown', 'x', '--stage', 'rights'], 'C:/workspace', deps)).rejects.toBeInstanceOf(BatchCommandError);
    await expect(runBatchCommand(['--batch', 'F002', '--work', '999999', '--stage', 'review'], 'C:/workspace', deps)).rejects.toMatchObject({
      code: 'BATCH_WORK_NOT_FOUND', exitCode: 1,
    });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('既存evidenceを返すno-op dependencyを拒否して保存しない', async () => {
    const before = manifest(['extracted', 'pending', 'pending']);
    const deps = dependencies(before);
    await expect(runBatchCommand(['--batch', 'F002', '--work', '000473', '--stage', 'review'], 'C:/workspace', deps)).rejects.toMatchObject({
      code: 'BATCH_DEPENDENCY_FAILED', exitCode: 4,
    });
    expect(deps.persistManifest).not.toHaveBeenCalled();
  });
});
