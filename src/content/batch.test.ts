import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import {
  BatchOperationError,
  type BatchCandidate,
  type BatchManifest,
  type PreparedWorkAcceptanceEvidence,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkStatus,
  type WorkspaceRelativePath,
  hashBatchManifest,
  createNextBatchTemplate,
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
