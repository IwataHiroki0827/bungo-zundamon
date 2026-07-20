import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeVoiceCompletenessDigest, computeVoiceGenerationDigest } from '../voice/generation.ts';
import { canonicalJson } from './artifacts.ts';
import { promoteVerifiedWorkArtifacts } from './batch-acceptance.ts';
import { hashBatchManifest, type BatchId, type BatchManifest, type Sha256, type WorkId, type WorkspaceRelativePath } from './batch.ts';
import type { IntegratedBuild } from './batch-public.ts';

const HASH = (value: string): Sha256 => createHash('sha256').update(value).digest('hex') as Sha256;
const workId = '000473' as WorkId;
const batchId = 'F002' as BatchId;

function manifest(): BatchManifest {
  const record = (stage: string, input: Sha256, output: Sha256) => ({
    stage, inputHashes: [input], outputHashes: [output], toolVersion: 'test/1.0.0', count: 1, completedAt: '2026-07-20T00:00:00.000Z',
  });
  return {
    batchId, feature: 'F002', schemaVersion: '1.0.0', status: 'draft',
    author: { authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji', identitySha256: HASH('author') },
    workIds: [workId, '043752' as WorkId, '043754' as WorkId],
    workProgress: [{
      workId, status: 'voiced',
      stageRecords: [
        record('extracted', HASH('a'), HASH('b')), record('reviewed', HASH('b'), HASH('c')),
        record('budget-approved', HASH('c'), HASH('d')), record('voiced', HASH('d'), HASH('e')),
      ],
      forecastRef: 'content/batches/F002/forecast.json' as WorkspaceRelativePath,
      voiceEvidenceRef: 'content/batches/F002/voice.json' as WorkspaceRelativePath,
    }, { workId: '043752' as WorkId, status: 'pending', stageRecords: [] }, { workId: '043754' as WorkId, status: 'pending', stageRecords: [] }],
    inputPaths: [], outputPaths: [], stageRecords: [], rightsSnapshotIds: ['rights'],
    voiceConfigRef: 'content/batches/F002/voice-config.json' as WorkspaceRelativePath,
    artworkProvenanceRef: 'content/batches/F002/artwork-provenance.json' as WorkspaceRelativePath,
  };
}

function bindVoicedManifest(
  current: BatchManifest,
  targetWorkId: WorkId,
  preVoiceManifestSha: Sha256,
  generationDigest: string,
  completenessDigest: string,
): BatchManifest {
  const index = current.workIds.indexOf(targetWorkId);
  const work = current.workProgress[index];
  const voiced = work?.stageRecords.at(-1);
  if (!work || !voiced || voiced.stage !== 'voiced') throw new Error('voiced fixtureが不正です');
  const progress = [...current.workProgress] as [BatchManifest['workProgress'][number], BatchManifest['workProgress'][number], BatchManifest['workProgress'][number]];
  progress[index] = {
    ...work,
    stageRecords: [...work.stageRecords.slice(0, -1), {
      ...voiced,
      inputHashes: [...new Set([...voiced.inputHashes, preVoiceManifestSha])],
      outputHashes: [generationDigest as Sha256, completenessDigest as Sha256],
    }],
  };
  return { ...current, workProgress: progress };
}

function voiceTuple(root: string, current: BatchManifest, targetWorkId: WorkId, preTreeDigest: Sha256, sourcePath: string, bytes: Uint8Array) {
  const generationCore = {
    schemaVersion: '2' as const, batchId, workId: targetWorkId, expectedManifestSha: hashBatchManifest(current), preTreeDigest,
    planDigest: HASH('plan'), authorizationDigest: HASH('authorization'), configHash: HASH('config'),
    assets: [{
      audioId: 'audio-1', path: 'audio/F002/audio-1.wav', sha256: HASH(new TextDecoder().decode(bytes)), bytes: bytes.byteLength,
      durationMs: 1000, configHash: HASH('config'), candidateIds: ['candidate-1'], source: 'staging' as const,
      sourcePath, workIds: [targetWorkId],
    }],
    failures: [], attempted: 1, succeeded: 1, failed: 0, stagedBytes: bytes.byteLength, stagingRoot: dirname(sourcePath),
  };
  const generationDigest = computeVoiceGenerationDigest(generationCore);
  const stagedVoice = { ...generationCore, generationDigest };
  const completenessCore = {
    result: 'pass' as const, batchId, workId: targetWorkId, expectedManifestSha: generationCore.expectedManifestSha, preTreeDigest,
    planDigest: HASH('plan'), authorizationDigest: HASH('authorization'), generationDigest,
    approvedCount: 1, uniqueAudioCount: 1, candidateAudio: { 'candidate-1': 'audio-1' },
  };
  const completeness = { ...completenessCore, completenessDigest: computeVoiceCompletenessDigest(completenessCore) };
  const boundManifest = bindVoicedManifest(
    current, targetWorkId, generationCore.expectedManifestSha, generationDigest, completeness.completenessDigest,
  );
  const preview: IntegratedBuild = {
    mode: 'work-preview', stagingRoot: join(root, '.cache', 'preview'), buildSha256: HASH('content'), files: [],
    activeBatchId: batchId, activeWorkId: targetWorkId,
  };
  return {
    stagedVoice, completeness, preview, boundManifest,
    actual: {
      result: 'pass' as const, batchId, workId: targetWorkId, contentBuildSha256: HASH('content'), distSha256: HASH('dist'),
      voiceConfigHash: HASH('config'), planDigest: HASH('plan'), authorizationDigest: HASH('authorization'),
      generationDigest: generationDigest as Sha256, completenessDigest: completeness.completenessDigest as Sha256,
    },
    pages: { distSha256: HASH('dist'), contentBuildSha256: HASH('content'), batchId, workId: targetWorkId },
    contentInvariant: { result: 'pass' as const, buildSha256: HASH('content'), stagingSha256: HASH('content'), baselineSha256: HASH('baseline') },
    distInvariant: { result: 'pass' as const, distSha256: HASH('dist'), contentBuildSha256: HASH('content') },
  };
}

describe('FUN-F002-033 accepted work transaction', () => {
  it.each(['source-moved', 'manifest-updated'] as const)('%s実process停止後にstale lockを回収して完了する', async (faultPhase) => {
    const root = await mkdtemp(join(tmpdir(), 'accepted-work-'));
    const manifestPath = join(root, 'content', 'batches', 'F002', 'batch.json');
    await mkdir(join(root, 'content', 'batches', 'F002'), { recursive: true });
    const currentManifest = manifest();
    await writeFile(manifestPath, canonicalJson(currentManifest));
    const voiceRoot = join(root, '.cache', 'voice-stage');
    await mkdir(voiceRoot, { recursive: true });
    const wav = new TextEncoder().encode('verified-wave');
    const sourcePath = join(voiceRoot, 'audio-1.wav');
    await writeFile(sourcePath, wav);
    const generationCore = {
      schemaVersion: '2' as const, batchId, workId, expectedManifestSha: hashBatchManifest(currentManifest), preTreeDigest: HASH(''),
      planDigest: HASH('plan'), authorizationDigest: HASH('authorization'), configHash: HASH('config'),
      assets: [{
        audioId: 'audio-1', path: 'audio/F002/audio-1.wav', sha256: HASH('verified-wave'), bytes: wav.byteLength, durationMs: 1000,
        configHash: HASH('config'), candidateIds: ['candidate-1'], source: 'staging' as const, sourcePath, workIds: [workId],
      }],
      failures: [], attempted: 1, succeeded: 1, failed: 0, stagedBytes: wav.byteLength, stagingRoot: voiceRoot,
    };
    const generationDigest = computeVoiceGenerationDigest(generationCore);
    const stagedVoice = { ...generationCore, generationDigest };
    const completenessCore = {
      result: 'pass' as const, batchId, workId, expectedManifestSha: generationCore.expectedManifestSha, preTreeDigest: HASH(''),
      planDigest: HASH('plan'), authorizationDigest: HASH('authorization'), generationDigest,
      approvedCount: 1, uniqueAudioCount: 1, candidateAudio: { 'candidate-1': 'audio-1' },
    };
    const completeness = { ...completenessCore, completenessDigest: computeVoiceCompletenessDigest(completenessCore) };
    const boundManifest = bindVoicedManifest(
      currentManifest, workId, generationCore.expectedManifestSha, generationDigest, completeness.completenessDigest,
    );
    await writeFile(manifestPath, canonicalJson(boundManifest));
    const preview: IntegratedBuild = {
      mode: 'work-preview', stagingRoot: join(root, '.cache', 'preview'), buildSha256: HASH('content'), files: [], activeBatchId: batchId, activeWorkId: workId,
    };
    const args = [
      root, batchId, workId, stagedVoice,
      completeness,
      {
        result: 'pass' as const, batchId, workId, contentBuildSha256: HASH('content'), distSha256: HASH('dist'),
        voiceConfigHash: HASH('config'), planDigest: HASH('plan'), authorizationDigest: HASH('authorization'),
        generationDigest: generationDigest as Sha256, completenessDigest: completeness.completenessDigest as Sha256,
      }, preview,
      { distSha256: HASH('dist'), contentBuildSha256: HASH('content'), batchId, workId },
      { result: 'pass' as const, buildSha256: HASH('content'), stagingSha256: HASH('content'), baselineSha256: HASH('baseline') },
      { result: 'pass' as const, distSha256: HASH('dist'), contentBuildSha256: HASH('content') },
    ] as const;

    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'content', 'batch-acceptance.ts')).href;
    const source = [
      `import { promoteVerifiedWorkArtifacts } from ${JSON.stringify(moduleUrl)};`,
      `const args = ${JSON.stringify(args)};`,
      `await promoteVerifiedWorkArtifacts(...args, { acceptedAt: '2026-07-20T01:00:00.000Z', acceptedBy: 'test',`,
      `  afterPhase(phase) { if (phase === ${JSON.stringify(faultPhase)}) process.kill(process.pid, 'SIGKILL'); },`,
      `});`,
    ].join('\n');
    const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', source], {
      stdio: 'ignore', windowsHide: true,
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    expect(exit.code === 0 && exit.signal === null).toBe(false);
    const evidence = await promoteVerifiedWorkArtifacts(...args, { acceptedAt: '2026-07-20T01:00:00.000Z', acceptedBy: 'test' });

    expect(evidence.acceptedSources).toHaveLength(1);
    expect(await readFile(join(root, ...evidence.acceptedSources[0]!.path.split('/')), 'utf8')).toBe('verified-wave');
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as BatchManifest;
    expect(saved.workProgress[0].status).toBe('accepted');
    expect(saved.workProgress[0].acceptedAudioSources).toEqual(evidence.acceptedSources);
  });

  it('shared audioは先行owner pathを再利用し、0新規時のtree digestを変えない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accepted-shared-'));
    const bytes = new TextEncoder().encode('verified-wave');
    const priorPath = join(root, 'content', 'batches', 'F002', 'accepted-audio', '000473', 'audio-1.wav');
    await mkdir(dirname(priorPath), { recursive: true });
    await writeFile(priorPath, bytes);
    const base = manifest();
    const priorSource = {
      path: 'content/batches/F002/accepted-audio/000473/audio-1.wav' as WorkspaceRelativePath,
      sha256: HASH('verified-wave'), bytes: bytes.byteLength, configHash: HASH('config'),
    };
    const acceptedRecord = {
      stage: 'accepted', inputHashes: [HASH('e')], outputHashes: [HASH('verified-wave')], toolVersion: 'accepted-audio-transaction-v1',
      count: 1, completedAt: '2026-07-20T00:30:00.000Z',
    };
    const secondWorkId = '043752' as WorkId;
    const current = {
      ...base,
      workProgress: [
        { ...base.workProgress[0], status: 'accepted' as const, stageRecords: [...base.workProgress[0].stageRecords, acceptedRecord],
          acceptedAudioSources: [priorSource], acceptedAt: '2026-07-20T00:30:00.000Z', acceptedBy: 'test' },
        { ...base.workProgress[0], workId: secondWorkId },
        base.workProgress[2],
      ],
    } as unknown as BatchManifest;
    const manifestPath = join(root, 'content', 'batches', 'F002', 'batch.json');
    await writeFile(manifestPath, canonicalJson(current));
    const digest = createHash('sha256')
      .update('000473/audio-1.wav').update('\0').update(String(bytes.byteLength)).update('\0').update(HASH('verified-wave'))
      .digest('hex') as Sha256;
    const sourcePath = join(root, '.cache', 'voice-stage', 'audio-1.wav');
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, bytes);
    const tuple = voiceTuple(root, current, secondWorkId, digest, sourcePath, bytes);
    await writeFile(manifestPath, canonicalJson(tuple.boundManifest));

    const evidence = await promoteVerifiedWorkArtifacts(
      root, batchId, secondWorkId, tuple.stagedVoice, tuple.completeness, tuple.actual, tuple.preview,
      tuple.pages, tuple.contentInvariant, tuple.distInvariant, { acceptedAt: '2026-07-20T01:00:00.000Z', acceptedBy: 'test' },
    );

    expect(evidence.preTreeDigest).toBe(digest);
    expect(evidence.postTreeDigest).toBe(digest);
    expect(evidence.acceptedSources[0]?.path).toBe(priorSource.path);
    expect(await readdir(join(root, 'content', 'batches', 'F002', 'accepted-audio', '043752'))).toEqual([]);
  });

  it('journalなしtargetをpreTree stale判定より先に隔離する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accepted-orphan-'));
    const current = manifest();
    const manifestPath = join(root, 'content', 'batches', 'F002', 'batch.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, canonicalJson(current));
    const target = join(root, 'content', 'batches', 'F002', 'accepted-audio', '000473');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'orphan.wav'), 'orphan');
    const sourcePath = join(root, '.cache', 'voice-stage', 'audio-1.wav');
    const bytes = new TextEncoder().encode('verified-wave');
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, bytes);
    const tuple = voiceTuple(root, current, workId, HASH(''), sourcePath, bytes);
    await writeFile(manifestPath, canonicalJson(tuple.boundManifest));

    await expect(promoteVerifiedWorkArtifacts(
      root, batchId, workId, tuple.stagedVoice, tuple.completeness, tuple.actual, tuple.preview,
      tuple.pages, tuple.contentInvariant, tuple.distInvariant,
    )).rejects.toMatchObject({ code: 'WORK_ACCEPTED_AUDIO_ORPHAN_MISMATCH' });
    await expect(readdir(target)).rejects.toThrow();
    expect(await readdir(join(root, '.cache', 'quarantine', 'accepted-audio'))).toHaveLength(1);
  });
});
