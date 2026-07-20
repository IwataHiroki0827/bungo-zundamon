import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import {
  loadAcceptedBatches,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkId,
  type WorkspaceRelativePath,
} from './batch.ts';

const execFile = promisify(execFileCallback);
const HASH = 'a'.repeat(64) as Sha256;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

async function createBatch(
  workspace: string,
  batchId: 'F002' | 'F003',
  status: 'accepted' | 'published',
): Promise<BatchManifest> {
  const workIds = batchId === 'F002' ? ['000473', '043752', '043754'] : ['100001', '100002', '100003'];
  const works = [];
  for (const [index, workId] of workIds.entries()) {
    const bytes = new TextEncoder().encode(`RIFF-${batchId}-${workId}`);
    const sourcePath = `content/batches/${batchId}/accepted-audio/${workId}/audio-${index}.wav`;
    const target = join(workspace, ...sourcePath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    works.push({
      workId: workId as WorkId,
      status: 'accepted' as const,
      stageRecords: [{
        stage: 'accepted', inputHashes: [HASH], outputHashes: [sha256(bytes)], toolVersion: 'accept/1.0.0', count: 1,
        completedAt: '2026-07-20T00:00:00Z',
      }],
      forecastRef: `data/batches/${batchId}/${workId}/forecast.json` as WorkspaceRelativePath,
      actualCapacityRef: `data/batches/${batchId}/${workId}/actual.json` as WorkspaceRelativePath,
      voiceEvidenceRef: `data/batches/${batchId}/${workId}/voice.json` as WorkspaceRelativePath,
      acceptedAudioSources: [{
        path: sourcePath as WorkspaceRelativePath,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        configHash: HASH,
      }],
      acceptedAt: '2026-07-20T00:00:00Z',
      acceptedBy: 'reviewer',
    });
  }
  const raw: BatchManifest = {
    batchId: batchId as BatchManifest['batchId'],
    feature: batchId,
    schemaVersion: '1.0.0',
    status,
    author: batchId === 'F002'
      ? { authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji', identitySha256: HASH }
      : { authorId: '000035', name: 'だざいおさむ', originalName: '太宰治', slug: 'dazai-osamu', identitySha256: 'b'.repeat(64) as Sha256 },
    workIds: workIds as unknown as BatchManifest['workIds'],
    workProgress: works as unknown as BatchManifest['workProgress'],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: [`rights-${batchId}`],
    voiceConfigRef: `content/batches/${batchId}/voice-config.json` as WorkspaceRelativePath,
    artworkProvenanceRef: `content/batches/${batchId}/artwork.json` as WorkspaceRelativePath,
    acceptedAt: '2026-07-20T00:00:00Z',
    acceptedBy: 'reviewer',
    ...(status === 'published' ? {
      publishedAt: '2026-07-20T01:00:00Z',
      releaseVersion: '1.0.0',
      deploymentEvidenceRef: `docs/evidence/${batchId}/deploy.json` as WorkspaceRelativePath,
      smokeEvidenceRef: `docs/evidence/${batchId}/smoke.json` as WorkspaceRelativePath,
    } : {}),
  };
  const checked = validateBatchManifest(raw);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  const manifestPath = join(workspace, 'content', 'batches', batchId, 'batch.json');
  await writeFile(manifestPath, canonicalJson(checked.value), 'utf8');
  return checked.value;
}

async function gitCommit(workspace: string): Promise<string> {
  await execFile('git', ['init'], { cwd: workspace });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  await execFile('git', ['add', '.'], { cwd: workspace });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: workspace });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  return stdout.trim();
}

describe('accepted batch discovery [DES-F002-001][DES-F002-002][DES-F002-006][DES-F002-014][DES-F002-015]', () => {
  // @des DES-F002-001 DES-F002-002 DES-F002-006 DES-F002-014 DES-F002-015 @fun FUN-F002-034 @test UT-F002-034
  it('通常列挙はpublishedだけ、prepareはclean tracked accepted candidateを1件加える', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bungo-discovery-'));
    temporaryDirectories.push(workspace);
    await createBatch(workspace, 'F002', 'published');
    await createBatch(workspace, 'F003', 'accepted');
    const normal = await loadAcceptedBatches(workspace);
    expect(normal.map((item) => item.manifest.batchId)).toEqual(['F002']);
    const commit = await gitCommit(workspace);
    const preparation = await loadAcceptedBatches(workspace, {
      preparation: { releaseCandidateBatchId: 'F003' as BatchManifest['batchId'], feature: 'F003', sourceCommit: commit },
    });
    expect(preparation.map((item) => [item.manifest.batchId, item.candidate])).toEqual([['F002', false], ['F003', true]]);
  });

  // @des DES-F002-001 DES-F002-002 DES-F002-006 DES-F002-014 DES-F002-015 @fun FUN-F002-034 @test UT-F002-034
  it('accepted audio改変とdirty checkoutをfail-closedにする', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bungo-discovery-'));
    temporaryDirectories.push(workspace);
    const published = await createBatch(workspace, 'F002', 'published');
    const publishedSource = published.workProgress[0].acceptedAudioSources?.[0];
    if (!publishedSource) throw new Error('fixture source missing');
    await writeFile(join(workspace, ...publishedSource.path.split('/')), 'tampered', 'utf8');
    await expect(loadAcceptedBatches(workspace)).rejects.toMatchObject({ code: 'BATCH_ACCEPTED_AUDIO_MISSING' });
    await rm(workspace, { recursive: true, force: true });
    temporaryDirectories.pop();

    const dirtyWorkspace = await mkdtemp(join(tmpdir(), 'bungo-discovery-'));
    temporaryDirectories.push(dirtyWorkspace);
    const accepted = await createBatch(dirtyWorkspace, 'F003', 'accepted');
    const commit = await gitCommit(dirtyWorkspace);
    const source = accepted.workProgress[0].acceptedAudioSources?.[0];
    if (!source) throw new Error('fixture source missing');
    await writeFile(join(dirtyWorkspace, ...source.path.split('/')), 'tampered', 'utf8');
    await expect(loadAcceptedBatches(dirtyWorkspace, {
      preparation: { releaseCandidateBatchId: accepted.batchId, feature: 'F003', sourceCommit: commit },
    })).rejects.toMatchObject({ code: 'BATCH_RELEASE_CHECKOUT_DIRTY' });
    await execFile('git', ['checkout', '--', source.path], { cwd: dirtyWorkspace });
    await writeFile(join(dirtyWorkspace, 'untracked.txt'), 'dirty', 'utf8');
    await expect(loadAcceptedBatches(dirtyWorkspace, {
      preparation: { releaseCandidateBatchId: accepted.batchId, feature: 'F003', sourceCommit: commit },
    })).rejects.toMatchObject({ code: 'BATCH_RELEASE_CHECKOUT_DIRTY' });
  });
});
