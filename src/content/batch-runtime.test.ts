import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import { createProductionBatchDependencies } from './batch-runtime.ts';
import { runBatchCommand } from './batch-command.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  type BatchManifest,
  type PreparedWorkAcceptanceEvidence,
  type Sha256,
  type WorkId,
  type WorkspaceRelativePath,
} from './batch.ts';
import { applyWorkReviews, type Candidate, type ReviewRecord } from './processing.ts';
import type { VoiceDiffGenerationResult, VoiceDiffPlan } from '../voice/generation.ts';

const HASH = 'a'.repeat(64) as Sha256;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function hash(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function treeDigest(entries: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Sha256 {
  const digest = createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    digest.update(entry.path, 'utf8').update('\0').update(String(entry.bytes.byteLength), 'ascii').update('\0').update(entry.bytes);
  }
  return digest.digest('hex') as Sha256;
}

function candidate(candidateId = 'candidate-1', displayText = '「表示」'): Candidate {
  return {
    candidateId,
    workId: '000473',
    rawSourceSha256: HASH,
    order: 0,
    rawTokenRange: { start: 0, end: 3 },
    displayText,
    speechText: '読み',
    contextBefore: '前',
    contextAfter: '後',
    sourceAnchor: { bodySelector: '.main_text', startToken: 0, endToken: 3 },
    extractorVersion: '1.0.0',
    normalizerVersion: '1.0.0',
  };
}

function storedCandidate(core: Candidate): Candidate & { readonly revisions: readonly []; readonly sha256: Sha256 } {
  return { ...core, revisions: [], sha256: hash(canonicalJson(core)) };
}

function review(candidateId: string): ReviewRecord {
  return {
    candidateId,
    workId: '000473',
    policyDecision: 'allowed',
    revision: 1,
    status: 'approved',
    reasonCode: 'SPOKEN_DIALOGUE',
    reviewer: 'editor',
    reviewedAt: '2026-07-20T00:00:00Z',
    policyCheckedAt: '2026-07-20T00:00:00Z',
  };
}

interface Fixture {
  readonly workspace: string;
  readonly manifest: BatchManifest;
  readonly artifactRoot: string;
  readonly candidatesPath: string;
  readonly reviewPath: string;
}

async function fixture(): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-runtime-'));
  temporaryDirectories.push(workspace);
  const artifactRoot = join(workspace, 'data', 'batches', 'F002', 'work-artifacts', '000473');
  const core = candidate();
  const stored = storedCandidate(core);
  const csvName = 'list_person_all_extended_utf8.csv';
  const archiveName = 'list_person_all_extended_utf8.zip';
  const csvBytes = new TextEncoder().encode('csv-fixture');
  const archiveBytes = new TextEncoder().encode('zip-fixture');
  const snapshot = {
    sourceUrl: 'https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip',
    archivePath: archiveName,
    archiveSha256: hash(archiveBytes),
    archiveBytes: archiveBytes.byteLength,
    csvPath: csvName,
    csvEntry: csvName,
    csvSha256: hash(csvBytes),
    csvBytes: csvBytes.byteLength,
    mediaType: 'application/zip',
    fetchedAt: '2026-07-20T00:00:00Z',
    schemaVersion: '1.0.0',
  };
  const values: Readonly<Record<string, unknown>> = {
    'bibliography/source.json': snapshot,
    'selected-works.json': { works: ['000473'] },
    'sources/000473/source.json': { workId: '000473', rawSha256: HASH },
    'intermediate/000473/decoded.json': { workId: '000473', rawSha256: HASH },
    'intermediate/000473/raw-candidates.json': [{ workId: '000473' }],
    'intermediate/000473/candidates.json': [stored],
  };
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [logical, value] of Object.entries(values)) {
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const target = join(artifactRoot, ...logical.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    entries.push({ path: logical, bytes });
  }
  for (const [logical, bytes] of [[`bibliography/${csvName}`, csvBytes], [`bibliography/${archiveName}`, archiveBytes]] as const) {
    await writeFile(join(artifactRoot, ...logical.split('/')), bytes);
    entries.push({ path: logical, bytes });
  }
  const rawPath = 'sources/000473/source.raw';
  const rawBytes = new TextEncoder().encode('<html>source</html>');
  await writeFile(join(artifactRoot, ...rawPath.split('/')), rawBytes);
  entries.push({ path: rawPath, bytes: rawBytes });
  const extracted = {
    stage: 'extracted',
    inputHashes: [HASH],
    outputHashes: [treeDigest(entries), stored.sha256],
    toolVersion: 'source/1.0.0',
    count: 1,
    completedAt: '2026-07-20T00:00:00Z',
  };
  const rawManifest: BatchManifest = {
    batchId: 'F002' as BatchManifest['batchId'],
    feature: 'F002',
    schemaVersion: '1.0.0',
    status: 'draft',
    author: { authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji', identitySha256: HASH },
    workIds: ['000473', '043752', '043754'] as unknown as BatchManifest['workIds'],
    workProgress: [
      { workId: '000473' as WorkId, status: 'extracted', stageRecords: [extracted] },
      { workId: '043752' as WorkId, status: 'pending', stageRecords: [] },
      { workId: '043754' as WorkId, status: 'pending', stageRecords: [] },
    ],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: [],
    voiceConfigRef: 'content/batches/F002/voice-config.json' as WorkspaceRelativePath,
    artworkProvenanceRef: 'content/batches/F002/artwork.json' as WorkspaceRelativePath,
  };
  const checked = validateBatchManifest(rawManifest);
  if (!checked.ok) throw new Error(checked.error.message);
  const reviewPath = join(workspace, 'content', 'batches', 'F002', 'reviews', '000473.json');
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, canonicalJson([review(core.candidateId)]), 'utf8');
  return {
    workspace,
    manifest: checked.value,
    artifactRoot,
    candidatesPath: join(artifactRoot, 'intermediate', '000473', 'candidates.json'),
    reviewPath,
  };
}

async function executeReview(input: Fixture): Promise<unknown> {
  return createProductionBatchDependencies().executeStage({
    workspace: input.workspace,
    batchId: input.manifest.batchId,
    manifest: input.manifest,
    stage: 'review',
    workId: input.manifest.workIds[0],
  });
}

describe('production review input結合 [DES-F002-002][DES-F002-014][DES-F002-015]', () => {
  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('canonical tree digestとcandidate SHAがextracted evidenceへ完全一致した場合だけreviewする', async () => {
    const input = await fixture();
    const result = await executeReview(input) as { nextManifest: BatchManifest };
    expect(result.nextManifest.workProgress[0].status).toBe('reviewed');
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('差替えcandidateと整合する新reviewでもextracted evidence不一致で拒否する', async () => {
    const input = await fixture();
    const replacement = storedCandidate(candidate('candidate-replaced', '「差替え」'));
    await writeFile(input.candidatesPath, canonicalJson([replacement]), 'utf8');
    await writeFile(input.reviewPath, canonicalJson([review(replacement.candidateId)]), 'utf8');
    await expect(executeReview(input)).rejects.toMatchObject({ code: 'BATCH_DEPENDENCY_FAILED' });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('candidate以外のtree file改変もdigest不一致で拒否する', async () => {
    const input = await fixture();
    await writeFile(join(input.artifactRoot, 'selected-works.json'), canonicalJson({ works: ['tampered'] }), 'utf8');
    await expect(executeReview(input)).rejects.toMatchObject({ code: 'BATCH_DEPENDENCY_FAILED' });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('artifact file symlinkを実体内容が同じでも拒否する', async () => {
    const input = await fixture();
    const external = join(input.workspace, 'external-candidates.json');
    await writeFile(external, await readFile(input.candidatesPath));
    await rm(input.candidatesPath);
    try {
      await symlink(external, input.candidatesPath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(executeReview(input)).rejects.toMatchObject({ code: 'BATCH_DEPENDENCY_FAILED' });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('review file symlinkも実体内容が同じでも拒否する', async () => {
    const input = await fixture();
    const external = join(input.workspace, 'external-review.json');
    await writeFile(external, await readFile(input.reviewPath));
    await rm(input.reviewPath);
    try {
      await symlink(external, input.reviewPath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(executeReview(input)).rejects.toMatchObject({ code: 'BATCH_DEPENDENCY_FAILED' });
  });

  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('artifact ancestor junctionを拒否する', async () => {
    const input = await fixture();
    const original = join(input.workspace, 'original-work-artifacts');
    const workArtifacts = join(input.workspace, 'data', 'batches', 'F002', 'work-artifacts');
    await rename(workArtifacts, original);
    try {
      await symlink(original, workArtifacts, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(executeReview(input)).rejects.toMatchObject({ code: 'BATCH_DEPENDENCY_FAILED' });
  });
});

describe('production terminal handler接続 [DES-F002-002][DES-F002-006][DES-F002-014][DES-F002-015]', () => {
  it('voice/accept/prepare/releaseはunavailableではなく欠落artifactをprerequisiteで停止する', async () => {
    const input = await fixture();
    const reviewed = {
      stage: 'reviewed', inputHashes: [HASH], outputHashes: [HASH], toolVersion: 'fixture/1.0.0', count: 1,
      completedAt: '2026-07-20T00:00:00Z',
    };
    const budget = {
      stage: 'budget-approved', inputHashes: [HASH], outputHashes: [HASH], toolVersion: 'fixture/1.0.0', count: 1,
      completedAt: '2026-07-20T00:01:00Z',
    };
    const manifest = {
      ...input.manifest,
      workProgress: [{
        ...input.manifest.workProgress[0], status: 'budget-approved' as const, stageRecords: [reviewed, budget],
        forecastRef: 'content/batches/F002/capacity-forecast/000473.json' as WorkspaceRelativePath,
      }, input.manifest.workProgress[1], input.manifest.workProgress[2]],
    } as BatchManifest;
    const dependencies = createProductionBatchDependencies();
    const failures = [
      () => dependencies.executeStage({ workspace: input.workspace, batchId: manifest.batchId, manifest, stage: 'voice', workId: manifest.workIds[0] }),
      () => dependencies.acceptWork({ workspace: input.workspace, batchId: manifest.batchId, manifest, workId: manifest.workIds[0] }),
      () => dependencies.prepareRelease({ workspace: input.workspace, batchId: manifest.batchId, manifest, commit: 'b'.repeat(40), mode: 'prepare' }),
      () => dependencies.verifyRelease({ workspace: input.workspace, batchId: manifest.batchId, manifest, commit: 'b'.repeat(40), mode: 'release' }),
    ];
    for (const failure of failures) {
      await expect(failure()).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });
    }
  });

  it('CLI voiceでpre-voice/voiced両SHAへ結合したartifactをacceptへ正規連結する', async () => {
    const input = await fixture();
    const workId = input.manifest.workIds[0];
    const reviewed = applyWorkReviews(workId, [candidate()], [review('candidate-1')]);
    const reviewSha = hash(canonicalJson(reviewed));
    const extracted = input.manifest.workProgress[0].stageRecords[0]!;
    const reviewedRecord = {
      stage: 'reviewed', inputHashes: [extracted.outputHashes[0]!], outputHashes: [reviewSha],
      toolVersion: 'fixture/1.0.0', count: 1, completedAt: '2026-07-20T00:01:00Z',
    };
    const forecastOutput = hash('forecast-output');
    const budgetRecord = {
      stage: 'budget-approved', inputHashes: [reviewSha], outputHashes: [forecastOutput],
      toolVersion: 'fixture/1.0.0', count: 1, completedAt: '2026-07-20T00:02:00Z',
    };
    const forecastRef = 'content/batches/F002/capacity-forecast/000473.json' as WorkspaceRelativePath;
    const budgetManifest = {
      ...input.manifest,
      workProgress: [{
        ...input.manifest.workProgress[0], status: 'budget-approved' as const,
        stageRecords: [...input.manifest.workProgress[0].stageRecords, reviewedRecord, budgetRecord], forecastRef,
      }, input.manifest.workProgress[1], input.manifest.workProgress[2]],
    } as BatchManifest;
    const manifestPath = join(input.workspace, 'content', 'batches', 'F002', 'batch.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, canonicalJson(budgetManifest));
    const reviewArtifactPath = join(input.workspace, '.cache', 'batch-review', 'F002', workId, 'review-result.json');
    await mkdir(dirname(reviewArtifactPath), { recursive: true });
    await writeFile(reviewArtifactPath, canonicalJson(reviewed));
    const config = {
      engineVersion: '0.25.2', speakerUuid: '388f246b-8c41-4ac1-8e2d-5d79f3ff56d9', speakerName: 'ずんだもん',
      styleId: 3, styleName: 'ノーマル', speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
      outputSamplingRate: 24_000, presetVersion: '2.0.0',
    };
    const configPath = join(input.workspace, ...budgetManifest.voiceConfigRef.split('/'));
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, canonicalJson(config));
    const preVoiceManifestSha = hashBatchManifest(budgetManifest);
    const plan: VoiceDiffPlan = {
      schemaVersion: '2', batchId: 'F002', workId, expectedManifestSha: preVoiceManifestSha, preTreeDigest: HASH,
      config, configHash: hash('config'), cacheRoot: join(input.workspace, '.cache', 'voice'), entries: [],
      candidateCount: 1, uniqueAudioCount: 1, hitCount: 0, missCount: 1, invalidCount: 0, estimatedMissBytes: 46,
      existingUniqueAudioCount: 0, existingUniqueBytes: 0, planDigest: hash('plan'),
    };
    const authorization = { result: 'pass' as const, planDigest: plan.planDigest, remainingResponseBytes: 46, minimumFreeBytesAfterWrite: 0 };
    const authorizationArtifact = {
      schemaVersion: '1.0.0', kind: 'voice-capacity-authorization', batchId: 'F002', workId,
      expectedManifestSha: preVoiceManifestSha, preTreeDigest: HASH, reviewSha256: reviewSha,
      configSha256: hash(canonicalJson(config)), plan, authorization,
    };
    const forecastPath = join(input.workspace, ...forecastRef.split('/'));
    await mkdir(dirname(forecastPath), { recursive: true });
    await writeFile(forecastPath, canonicalJson(authorizationArtifact));
    const generation: VoiceDiffGenerationResult = {
      schemaVersion: '2', batchId: 'F002', workId, expectedManifestSha: preVoiceManifestSha, preTreeDigest: HASH,
      planDigest: plan.planDigest, authorizationDigest: hash('authorization'), generationDigest: hash('generation'), configHash: hash('config'),
      assets: [{
        audioId: 'audio-1', path: 'audio/F002/audio-1.wav', sha256: hash('wav'), bytes: 46, durationMs: 1,
        configHash: hash('config'), candidateIds: ['candidate-1'], source: 'staging',
        sourcePath: join(input.workspace, '.cache', '.voice-stage-fixture', 'audio-1.wav'), workIds: [workId],
      }],
      failures: [], attempted: 1, succeeded: 1, failed: 0, stagedBytes: 46,
      stagingRoot: join(input.workspace, '.cache', '.voice-stage-fixture'),
    };
    const completeness = {
      result: 'pass' as const, batchId: 'F002', workId, expectedManifestSha: preVoiceManifestSha, preTreeDigest: HASH,
      planDigest: plan.planDigest, authorizationDigest: generation.authorizationDigest, generationDigest: generation.generationDigest,
      completenessDigest: hash('completeness'), approvedCount: 1, uniqueAudioCount: 1,
      candidateAudio: { 'candidate-1': 'audio-1' },
    };
    let promotedPreVoiceSha: string | undefined;
    const dependencies = createProductionBatchDependencies({
      planVoice: vi.fn(async () => plan),
      authorizeVoice: vi.fn((value) => ({ ...value, authorization, authorizationDigest: generation.authorizationDigest })),
      generateVoice: vi.fn(async () => generation),
      verifyVoice: vi.fn(async () => completeness),
      promoteWork: vi.fn(async (workspace, _batchId, targetWorkId, stagedVoice) => {
        const voiced = JSON.parse(await readFile(manifestPath, 'utf8')) as BatchManifest;
        promotedPreVoiceSha = stagedVoice.expectedManifestSha;
        expect(promotedPreVoiceSha).toBe(preVoiceManifestSha);
        expect(hashBatchManifest(voiced)).not.toBe(preVoiceManifestSha);
        const acceptedSource = {
          path: `content/batches/F002/accepted-audio/${targetWorkId}/audio-1.wav` as WorkspaceRelativePath,
          sha256: hash('wav'), bytes: 46, configHash: hash('config'),
        };
        const evidence: PreparedWorkAcceptanceEvidence = {
          kind: 'accepted', batchId: voiced.batchId, workId: targetWorkId, expectedManifestSha: hashBatchManifest(voiced),
          acceptedSources: [acceptedSource], preTreeDigest: HASH, postTreeDigest: hash('post-tree'),
          contentBuildSha: hash('content'), contentStagingSha: hash('content'), distSha: hash('dist'),
          actualCapacityReportSha: hash('actual'), f001ContentInvariantReportSha: hash('f001-content'),
          f001DistInvariantReportSha: hash('f001-dist'), journalId: 'runtime-link-test',
          acceptedAt: '2026-07-20T01:00:00Z', acceptedBy: 'test',
        };
        const accepted = transitionWorkState(voiced, targetWorkId, 'accepted', evidence);
        await writeFile(join(workspace, 'content', 'batches', 'F002', 'batch.json'), canonicalJson(accepted));
        return evidence;
      }),
    });

    const voiceResult = await runBatchCommand(['--batch', 'F002', '--work', workId, '--stage', 'voice'], input.workspace, dependencies);
    expect(voiceResult.workStatus).toBe('voiced');
    const voiced = JSON.parse(await readFile(manifestPath, 'utf8')) as BatchManifest;
    const acceptRoot = join(input.workspace, '.cache', 'batch-accept', 'F002', workId);
    const contentSha = hash('content');
    const distSha = hash('dist');
    await Promise.all([
      writeFile(join(acceptRoot, 'content-preview.json'), canonicalJson({
        mode: 'work-preview', stagingRoot: join(input.workspace, '.cache', 'preview'), buildSha256: contentSha, files: [],
        activeBatchId: 'F002', activeWorkId: workId,
      })),
      writeFile(join(acceptRoot, 'dist-preview.json'), canonicalJson({ distSha256: distSha, contentBuildSha256: contentSha, batchId: 'F002', workId })),
      writeFile(join(acceptRoot, 'f001-content-invariant.json'), canonicalJson({
        result: 'pass', buildSha256: contentSha, stagingSha256: contentSha, baselineSha256: HASH,
      })),
      writeFile(join(acceptRoot, 'f001-dist-invariant.json'), canonicalJson({ result: 'pass', distSha256: distSha, contentBuildSha256: contentSha })),
    ]);
    const actualPath = join(input.workspace, 'content', 'batches', 'F002', 'capacity-actual', `${workId}.json`);
    await mkdir(dirname(actualPath), { recursive: true });
    await writeFile(actualPath, canonicalJson({
      result: 'pass', batchId: 'F002', workId, contentBuildSha256: contentSha, distSha256: distSha,
      voiceConfigHash: generation.configHash, planDigest: generation.planDigest, authorizationDigest: generation.authorizationDigest,
      generationDigest: generation.generationDigest, completenessDigest: completeness.completenessDigest,
    }));

    const acceptResult = await runBatchCommand(['--batch', 'F002', '--work', workId, '--stage', 'accept'], input.workspace, dependencies);
    expect(acceptResult.workStatus).toBe('accepted');
    expect(promotedPreVoiceSha).toBe(preVoiceManifestSha);
    expect(hashBatchManifest(voiced)).not.toBe(preVoiceManifestSha);
  });

  it('release-verifyはbuild検証だけを呼びpublic昇格とmanifest保存を行わない', async () => {
    const input = await fixture();
    const commit = 'b'.repeat(40);
    const candidateBytes = new TextEncoder().encode('candidate-artifact');
    const candidateArtifactPath = 'artifacts/F002-pages.tar.gz' as WorkspaceRelativePath;
    const candidateFile = join(input.workspace, ...candidateArtifactPath.split('/'));
    await mkdir(dirname(candidateFile), { recursive: true });
    await writeFile(candidateFile, candidateBytes);
    const context = {
      releaseCandidateBatchId: input.manifest.batchId,
      feature: input.manifest.feature,
      releaseCommit: commit,
      distSha256: HASH,
      artifactDigest: hash(candidateBytes),
    };
    const f001 = {
      sourceRoot: input.workspace,
      files: [],
      catalog: {},
      syntheticBatch: { batchId: 'F001' },
      baselineSha256: HASH,
    };
    const candidateCore = {
      releaseCandidateBatchId: input.manifest.batchId,
      feature: input.manifest.feature,
      releaseCommit: commit,
      contentBuildSha256: HASH,
      distSha256: context.distSha256,
      artifactDigest: context.artifactDigest,
    };
    const candidate = { ...candidateCore, evidenceSha256: hash(canonicalJson(candidateCore)) };
    const payload = { context, f001, batchCatalogs: {}, candidate, candidateArtifactPath };
    const artifact = {
      schemaVersion: '1.0.0',
      kind: 'release-verify-inputs',
      batchId: input.manifest.batchId,
      expectedManifestSha: hashBatchManifest(input.manifest),
      payloadSha256: hash(canonicalJson(payload)),
      ...payload,
    };
    const artifactPath = join(input.workspace, '.cache', 'batch-release', input.manifest.batchId, 'release-verify-inputs.json');
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, canonicalJson(artifact), 'utf8');
    const buildTree = vi.fn(async (_batches, _baseline, stagingRoot: string) => ({
      mode: 'release-verify' as const,
      stagingRoot,
      buildSha256: HASH,
      files: [],
      releaseCandidateBatchId: input.manifest.batchId,
      releaseCommit: commit,
    }));
    const promoteTree = vi.fn();
    const dependencies = createProductionBatchDependencies({
      loadBatches: vi.fn(async () => []),
      buildTree,
      promoteTree,
    });

    const result = await dependencies.verifyRelease({
      workspace: input.workspace,
      batchId: input.manifest.batchId,
      manifest: input.manifest,
      commit,
      mode: 'release',
    });

    expect(result.outputHashes).toEqual([HASH]);
    expect(buildTree).toHaveBeenCalledTimes(1);
    expect(promoteTree).not.toHaveBeenCalled();

    await writeFile(candidateFile, 'tampered-artifact');
    await expect(dependencies.verifyRelease({
      workspace: input.workspace,
      batchId: input.manifest.batchId,
      manifest: input.manifest,
      commit,
      mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });

    await writeFile(candidateFile, candidateBytes);
    const changedBuild = createProductionBatchDependencies({
      loadBatches: vi.fn(async () => []),
      buildTree: vi.fn(async (_batches, _baseline, stagingRoot: string) => ({
        mode: 'release-verify' as const,
        stagingRoot,
        buildSha256: hash('different-build'),
        files: [],
      })),
      promoteTree,
    });
    await expect(changedBuild.verifyRelease({
      workspace: input.workspace,
      batchId: input.manifest.batchId,
      manifest: input.manifest,
      commit,
      mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });
  });
});
