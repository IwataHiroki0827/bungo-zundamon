import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import { loadAndVerifyF001Baseline } from './baseline.ts';
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
import type { ActualCapacityInput, CapacityForecastInput } from '../voice/budget.ts';

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
  it('reviewed workを現在planと実forecastへ結合しauthorization artifactを保存する', async () => {
    const input = await fixture();
    await mkdir(join(input.workspace, 'public'), { recursive: true });
    await writeFile(join(input.workspace, 'public', 'index.html'), 'public');
    execFileSync('git', ['init', '--quiet'], { cwd: input.workspace });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: input.workspace });
    execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: input.workspace });
    execFileSync('git', ['add', '.'], { cwd: input.workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: input.workspace });
    const reviewedResult = await executeReview(input) as { nextManifest: BatchManifest };
    const manifest = reviewedResult.nextManifest;
    const workId = manifest.workIds[0];
    const config = {
      engineVersion: '0.25.2', speakerUuid: '388f246b-8c41-4ac1-8e2d-5d79f3ff56d9', speakerName: 'ずんだもん',
      styleId: 3, styleName: 'ノーマル', speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
      outputSamplingRate: 24_000, presetVersion: '2.0.0',
    };
    const configPath = join(input.workspace, ...manifest.voiceConfigRef.split('/'));
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, canonicalJson(config));
    const forecastInputs = {
      schemaVersion: '1.0.0', kind: 'capacity-forecast-inputs', batchId: manifest.batchId, workId,
      expectedManifestSha: hashBatchManifest(manifest), plannedPagesBytes: 1, repositoryCandidateFiles: [],
      liveWriteUpperBounds: 0, rollbackBackupBytes: 0,
    };
    const inputsPath = join(input.workspace, '.cache', 'batch-capacity', manifest.batchId, workId, 'forecast-inputs.json');
    await mkdir(dirname(inputsPath), { recursive: true });
    await writeFile(inputsPath, canonicalJson(forecastInputs));
    const plan = {
      schemaVersion: '2' as const, batchId: manifest.batchId, workId,
      expectedManifestSha: forecastInputs.expectedManifestSha, preTreeDigest: hash(''), config, configHash: hash('config'),
      cacheRoot: join(input.workspace, '.cache', 'voice'), entries: [], candidateCount: 1, uniqueAudioCount: 1,
      hitCount: 0, missCount: 1, invalidCount: 0, estimatedMissBytes: 46,
      existingUniqueAudioCount: 0, existingUniqueBytes: 0, planDigest: hash('plan'),
    } satisfies VoiceDiffPlan;
    const section = { measuredBytes: 1, thresholdBytes: 100, status: 'pass' as const, includedPaths: [], deduplicatedHashes: [], reasons: [] };
    const report = {
      evidenceKind: 'forecast' as const, actualCapacitySatisfied: false as const, result: 'pass' as const, canGenerate: true,
      batchId: manifest.batchId, workId, expectedManifestSha: forecastInputs.expectedManifestSha,
      preTreeDigest: hash(''), planDigest: plan.planDigest, remainingResponseBytes: 46, minimumFreeBytesAfterWrite: 0,
      additionalAudio: section, pagesArtifact: section, sourceRepository: section, singleGitObjects: section,
      workDrive: section, reasons: [],
    };
    const dependencies = createProductionBatchDependencies({
      planVoice: vi.fn(async () => plan),
      forecastCapacity: vi.fn(async (capacityInput: CapacityForecastInput) => {
        expect(capacityInput.currentPagesBytes).toBe(Buffer.byteLength('public'));
        expect(capacityInput.repositoryNonObjectBytes).toBeGreaterThan(0);
        expect(capacityInput.gitObjects.length).toBeGreaterThan(0);
        expect(capacityInput.disk.freeBytes).toBeGreaterThan(0);
        return report;
      }),
      authorizeVoice: vi.fn((value) => value),
    });

    const result = await dependencies.executeStage({
      workspace: input.workspace, batchId: manifest.batchId, manifest, stage: 'capacity-forecast', workId,
    });
    expect(result.nextManifest?.workProgress[0].status).toBe('budget-approved');
    expect(result.nextManifest?.workProgress[0].forecastRef).toBe(`content/batches/F002/capacity-forecast/${workId}.json`);
    const artifact = JSON.parse(await readFile(join(
      input.workspace, 'content', 'batches', 'F002', 'capacity-forecast', `${workId}.json`,
    ), 'utf8')) as { plan: VoiceDiffPlan; authorization: { result: string } };
    expect(artifact.plan.planDigest).toBe(plan.planDigest);
    expect(artifact.authorization.result).toBe('pass');

    const blockedDependencies = createProductionBatchDependencies({
      planVoice: vi.fn(async () => plan),
      forecastCapacity: vi.fn(async () => ({ ...report, result: 'blocked' as const, canGenerate: false })),
      authorizeVoice: vi.fn((value) => value),
    });
    await expect(blockedDependencies.executeStage({
      workspace: input.workspace, batchId: manifest.batchId, manifest, stage: 'capacity-forecast', workId,
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });

    await writeFile(inputsPath, canonicalJson({
      ...forecastInputs,
      currentPagesBytes: 0,
      repositoryNonObjectBytes: 0,
      gitObjects: [],
      freeBytes: Number.MAX_SAFE_INTEGER,
    }));
    await expect(dependencies.executeStage({
      workspace: input.workspace, batchId: manifest.batchId, manifest, stage: 'capacity-forecast', workId,
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });
  });

  it('voiced workの実preview/invariant/capacityをactual artifactへ結合して状態を据え置く', async () => {
    const input = await fixture();
    execFileSync('git', ['init', '--quiet'], { cwd: input.workspace });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: input.workspace });
    execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: input.workspace });
    execFileSync('git', ['add', '.'], { cwd: input.workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: input.workspace });
    const reviewed = (await executeReview(input) as { nextManifest: BatchManifest }).nextManifest;
    const workId = reviewed.workIds[0];
    const forecastRef = `content/batches/F002/capacity-forecast/${workId}.json` as WorkspaceRelativePath;
    const budgeted = transitionWorkState(reviewed, workId, 'budget-approved', {
      kind: 'stage', expectedManifestSha: hashBatchManifest(reviewed), workId, stage: 'budget-approved',
      inputHashes: [hashBatchManifest(reviewed), ...reviewed.workProgress[0].stageRecords.at(-1)!.outputHashes],
      outputHashes: [hash('forecast')], toolVersion: 'test/1', count: 1,
      completedAt: '2026-07-20T00:01:00Z', result: 'pass', forecastRef,
    });
    const voiceEvidenceRef = `content/batches/F002/voice-evidence/${workId}.json` as WorkspaceRelativePath;
    const voiced = transitionWorkState(budgeted, workId, 'voiced', {
      kind: 'stage', expectedManifestSha: hashBatchManifest(budgeted), workId, stage: 'voiced',
      inputHashes: [hashBatchManifest(budgeted), ...budgeted.workProgress[0].stageRecords.at(-1)!.outputHashes],
      outputHashes: [hash('generation'), hash('completeness')],
      toolVersion: 'test/1', count: 1, completedAt: '2026-07-20T00:02:00Z', result: 'pass', voiceEvidenceRef,
    });
    const acceptRoot = join(input.workspace, '.cache', 'batch-accept', 'F002', workId);
    const stagingRoot = join(input.workspace, '.cache', 'content-preview');
    const generationSource = join(input.workspace, '.cache', 'voice-stage', 'audio.wav');
    await mkdir(join(stagingRoot, 'content'), { recursive: true });
    await mkdir(dirname(generationSource), { recursive: true });
    await writeFile(generationSource, 'actual-audio');
    await writeFile(join(stagingRoot, 'content', 'catalog.json'), canonicalJson({ schemaVersion: '2.0.0' }));
    const generation = {
      schemaVersion: '2', batchId: 'F002', workId, expectedManifestSha: hash('pre-voice'), preTreeDigest: HASH,
      planDigest: hash('plan'), authorizationDigest: hash('authorization'), generationDigest: hash('generation'),
      configHash: hash('config'), assets: [{
        audioId: 'audio-actual', path: 'audio/F002/audio-actual.wav', sha256: hash('actual-audio'), bytes: 12,
        durationMs: 1, configHash: hash('config'), candidateIds: ['candidate-1'], source: 'staging',
        sourcePath: generationSource, workIds: [workId],
      }], failures: [], attempted: 1, succeeded: 1, failed: 0,
      stagedBytes: 12, stagingRoot: dirname(generationSource),
    } as VoiceDiffGenerationResult;
    const completeness = {
      result: 'pass', batchId: 'F002', workId, expectedManifestSha: generation.expectedManifestSha,
      preTreeDigest: HASH, planDigest: generation.planDigest, authorizationDigest: generation.authorizationDigest,
      generationDigest: generation.generationDigest, completenessDigest: hash('completeness'),
      approvedCount: 0, uniqueAudioCount: 0, candidateAudio: {},
    };
    const generationArtifact = {
      schemaVersion: '1.0.0', kind: 'voice-generation-runtime', batchId: 'F002', workId,
      preVoiceManifestSha: generation.expectedManifestSha, voicedManifestSha: hashBatchManifest(voiced),
      generationSha256: hash(canonicalJson(generation)), generation,
    };
    const preview = {
      mode: 'work-preview', stagingRoot, buildSha256: hash('content-build'), files: [],
      activeBatchId: 'F002', activeWorkId: workId,
    };
    const actualInputs = {
      schemaVersion: '1.0.0', kind: 'capacity-actual-inputs', batchId: 'F002', workId,
      voicedManifestSha: hashBatchManifest(voiced),
      liveWriteUpperBounds: 0, rollbackBackupBytes: 0,
    };
    await mkdir(acceptRoot, { recursive: true });
    await Promise.all([
      writeFile(join(acceptRoot, 'voice-generation.json'), canonicalJson(generationArtifact)),
      writeFile(join(acceptRoot, 'voice-completeness.json'), canonicalJson(completeness)),
      writeFile(join(acceptRoot, 'content-preview.json'), canonicalJson(preview)),
      writeFile(join(acceptRoot, 'capacity-actual-inputs.json'), canonicalJson(actualInputs)),
    ]);
    const section = { measuredBytes: 0, thresholdBytes: 1, status: 'pass' as const, includedPaths: [], deduplicatedHashes: [], reasons: [] };
    const pages = {
      distSha256: hash('dist'), contentBuildSha256: preview.buildSha256, outputRoot: join(input.workspace, '.cache', 'runtime-pages'),
      files: [], inputHashes: {
        contentTreeSha256: preview.buildSha256, appSourceSha256: HASH, lockfileSha256: HASH, toolSha256: HASH,
      }, batchId: voiced.batchId, workId,
    };
    const contentInvariant = { result: 'pass' as const, buildSha256: preview.buildSha256, stagingSha256: preview.buildSha256, baselineSha256: HASH };
    const distInvariant = { result: 'pass' as const, distSha256: pages.distSha256, contentBuildSha256: preview.buildSha256, baselineSha256: HASH, reportSha256: hash('dist-report') };
    const actual = {
      evidenceKind: 'actual' as const, phase: 'work-preview' as const, result: 'pass' as const,
      batchId: voiced.batchId, workId, expectedManifestSha: generation.expectedManifestSha, preTreeDigest: HASH,
      contentBuildSha256: preview.buildSha256, contentStagingSha256: preview.buildSha256, distSha256: pages.distSha256,
      voiceConfigHash: generation.configHash, planDigest: generation.planDigest,
      authorizationDigest: generation.authorizationDigest, generationDigest: generation.generationDigest,
      completenessDigest: completeness.completenessDigest,
      additionalAudio: section, pagesArtifact: section, sourceRepository: section, singleGitObjects: section, workDrive: section, reasons: [],
    };
    const buildPagesPreview = vi.fn(async (_preview, appSource: string, outputRoot: string, offline: boolean) => {
      expect(appSource).toBe(input.workspace);
      expect(outputRoot.startsWith(join(input.workspace, '.cache'))).toBe(true);
      expect(offline).toBe(true);
      return { ...pages, outputRoot } as never;
    });
    const dependencies = createProductionBatchDependencies({
      loadBaseline: vi.fn(async () => ({ sourceRoot: join(input.workspace, 'public'), files: [], catalog: {}, syntheticBatch: {}, baselineSha256: HASH } as never)),
      validateCatalog: vi.fn(() => ({ ok: true, success: true, value: {} } as never)),
      verifyF001Invariant: vi.fn(async () => contentInvariant),
      buildPagesPreview,
      verifyF001DistInvariant: vi.fn(async () => distInvariant),
      verifyActualCapacity: vi.fn(async (capacityInput: ActualCapacityInput) => {
        expect(capacityInput.additionalAudioFiles).toContain(generationSource);
        expect(capacityInput.gitObjects?.some((item) => item.path?.endsWith('.cache/voice-stage/audio.wav'))).toBe(true);
        return actual as never;
      }),
    });

    const externalRoot = await mkdtemp(join(tmpdir(), 'capacity-actual-external-'));
    temporaryDirectories.push(externalRoot);
    await writeFile(join(acceptRoot, 'capacity-actual-inputs.json'), canonicalJson({
      ...actualInputs, appSource: externalRoot, outputRoot: join(externalRoot, 'written'),
    }));
    await expect(dependencies.executeStage({
      workspace: input.workspace, batchId: voiced.batchId, manifest: voiced, stage: 'capacity-actual', workId,
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });
    expect(buildPagesPreview).not.toHaveBeenCalled();
    await expect(readFile(join(externalRoot, 'written'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(acceptRoot, 'capacity-actual-inputs.json'), canonicalJson(actualInputs));

    const result = await dependencies.executeStage({
      workspace: input.workspace, batchId: voiced.batchId, manifest: voiced, stage: 'capacity-actual', workId,
    });
    expect(result.nextManifest?.workProgress[0].status).toBe('voiced');
    expect(result.nextManifest?.workProgress[0].actualCapacityRef).toBe(`content/batches/F002/capacity-actual/${workId}.json`);
    expect(JSON.parse(await readFile(join(
      input.workspace, 'content', 'batches', 'F002', 'capacity-actual', `${workId}.json`,
    ), 'utf8'))).toMatchObject({ result: 'pass', generationDigest: generation.generationDigest });
  });

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

  it('release-verifyはclean commitからF001/Pages/release容量chainを実行しpublicを昇格しない', async () => {
    const input = await fixture();
    await writeFile(join(input.workspace, '.gitignore'), '.cache/\nartifacts/\n');
    await cp(join(process.cwd(), 'public'), join(input.workspace, 'public'), { recursive: true });
    const baselinePath = join(input.workspace, 'content', 'baselines', 'F001-v0.1.0.json');
    const rawCatalogPath = join(input.workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json');
    await mkdir(dirname(baselinePath), { recursive: true });
    await Promise.all([
      cp(join(process.cwd(), 'content', 'baselines', 'F001-v0.1.0.json'), baselinePath),
      cp(join(process.cwd(), 'content', 'baselines', 'F001-v0.1.0-catalog.json'), rawCatalogPath),
    ]);
    await writeFile(join(input.workspace, 'public', 'content', 'catalog.json'), canonicalJson({
      schemaVersion: '2.0.0', authors: [], works: [], audioAssets: [], batches: [],
    }));
    execFileSync('git', ['init', '--quiet'], { cwd: input.workspace });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: input.workspace });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: input.workspace });
    execFileSync('git', ['add', '.'], { cwd: input.workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'release fixture'], { cwd: input.workspace });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.workspace, encoding: 'utf8' }).trim();
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
    const f001 = await loadAndVerifyF001Baseline(join(input.workspace, 'public'), baselinePath, rawCatalogPath);
    const candidateCore = {
      releaseCandidateBatchId: input.manifest.batchId,
      feature: input.manifest.feature,
      releaseCommit: commit,
      contentBuildSha256: HASH,
      distSha256: context.distSha256,
      artifactDigest: context.artifactDigest,
    };
    const candidate = { ...candidateCore, evidenceSha256: hash(canonicalJson(candidateCore)) };
    const capacity = {
      repositoryCandidateFiles: [], liveWriteUpperBounds: 0, rollbackBackupBytes: 0,
    };
    const payload = { context, f001, batchCatalogs: {}, candidate, candidateArtifactPath, capacity };
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
    const buildTree = vi.fn(async (_batches, _baseline, stagingRoot: string) => {
      await mkdir(join(stagingRoot, 'content'), { recursive: true });
      await writeFile(join(stagingRoot, 'content', 'catalog.json'), canonicalJson({ schemaVersion: '2.0.0' }));
      return {
        mode: 'release-verify' as const, stagingRoot, buildSha256: HASH, files: [],
        releaseCandidateBatchId: input.manifest.batchId, releaseCommit: commit,
      };
    });
    const promoteTree = vi.fn();
    const loadBaseline = vi.fn(loadAndVerifyF001Baseline);
    const verifyF001Invariant = vi.fn(async () => ({ result: 'pass' as const, buildSha256: HASH, stagingSha256: HASH, baselineSha256: f001.baselineSha256 }));
    const pages = {
      distSha256: context.distSha256, contentBuildSha256: HASH, outputRoot: join(input.workspace, '.cache', 'runtime-pages'), files: [],
      inputHashes: { contentTreeSha256: HASH, appSourceSha256: HASH, lockfileSha256: HASH, toolSha256: HASH },
    };
    const buildPagesPreview = vi.fn(async (_build, appSource: string, outputRoot: string, offline: boolean) => {
      expect(appSource).toBe(input.workspace);
      expect(outputRoot.startsWith(join(input.workspace, '.cache'))).toBe(true);
      expect(offline).toBe(true);
      return { ...pages, outputRoot } as never;
    });
    const distInvariant = { result: 'pass' as const, distSha256: context.distSha256, contentBuildSha256: HASH, baselineSha256: HASH, reportSha256: hash('dist-report') };
    const verifyF001DistInvariant = vi.fn(async () => distInvariant);
    const section = { measuredBytes: 0, thresholdBytes: 1, status: 'pass' as const, includedPaths: [], deduplicatedHashes: [], reasons: [] };
    const releaseActual = {
      evidenceKind: 'actual' as const, phase: 'release' as const, result: 'pass' as const,
      releaseCandidateBatchId: input.manifest.batchId, feature: input.manifest.feature, releaseCommit: commit,
      artifactDigest: context.artifactDigest, contentBuildSha256: HASH, contentStagingSha256: HASH,
      distSha256: context.distSha256, additionalAudio: section, pagesArtifact: section, sourceRepository: section,
      singleGitObjects: section, workDrive: section, reasons: [],
    };
    const verifyActualCapacity = vi.fn(async (capacityInput: ActualCapacityInput) => {
      expect(capacityInput).toMatchObject({
        phase: 'release', releaseCandidateBatchId: input.manifest.batchId, releaseCommit: commit,
        artifactDigest: context.artifactDigest, contentBuildSha256: HASH,
      });
      return releaseActual as never;
    });
    const dependencies = createProductionBatchDependencies({
      loadBatches: vi.fn(async () => []),
      buildTree, promoteTree, loadBaseline,
      validateCatalog: vi.fn(() => ({ ok: true, success: true, value: {} } as never)),
      verifyF001Invariant, buildPagesPreview, verifyF001DistInvariant, verifyActualCapacity,
    });

    const result = await dependencies.verifyRelease({
      workspace: input.workspace,
      batchId: input.manifest.batchId,
      manifest: input.manifest,
      commit,
      mode: 'release',
    });

    expect(result.outputHashes).toHaveLength(5);
    expect(result.outputHashes).toContain(HASH);
    expect(result.outputHashes).toContain(context.distSha256);
    expect(buildTree).toHaveBeenCalledTimes(1);
    expect(loadBaseline).toHaveBeenCalledTimes(1);
    expect(loadBaseline).toHaveBeenCalledWith(join(input.workspace, 'public'), baselinePath, rawCatalogPath);
    expect(verifyF001Invariant).toHaveBeenCalledTimes(1);
    expect(buildPagesPreview).toHaveBeenCalledTimes(1);
    expect(verifyF001DistInvariant).toHaveBeenCalledTimes(1);
    expect(verifyActualCapacity).toHaveBeenCalledTimes(1);
    expect(promoteTree).not.toHaveBeenCalled();

    const externalRoot = await mkdtemp(join(tmpdir(), 'release-pages-external-'));
    temporaryDirectories.push(externalRoot);
    const invalidCapacity = {
      ...capacity, appSource: externalRoot, outputRoot: join(externalRoot, 'written'),
    };
    const invalidPayload = { ...payload, capacity: invalidCapacity };
    await writeFile(artifactPath, canonicalJson({
      ...artifact, ...invalidPayload, payloadSha256: hash(canonicalJson(invalidPayload)),
    }));
    await expect(dependencies.verifyRelease({
      workspace: input.workspace, batchId: input.manifest.batchId, manifest: input.manifest,
      commit, mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });
    expect(buildTree).toHaveBeenCalledTimes(1);
    expect(buildPagesPreview).toHaveBeenCalledTimes(1);
    await expect(readFile(join(externalRoot, 'written'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(artifactPath, canonicalJson(artifact), 'utf8');

    await writeFile(candidateFile, 'tampered-artifact');
    await expect(dependencies.verifyRelease({
      workspace: input.workspace,
      batchId: input.manifest.batchId,
      manifest: input.manifest,
      commit,
      mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });

    await writeFile(candidateFile, candidateBytes);
    const blocked = createProductionBatchDependencies({
      loadBatches: vi.fn(async () => []), buildTree, promoteTree, loadBaseline,
      validateCatalog: vi.fn(() => ({ ok: true, success: true, value: {} } as never)),
      verifyF001Invariant, buildPagesPreview, verifyF001DistInvariant,
      verifyActualCapacity: vi.fn(async () => ({ ...releaseActual, result: 'blocked' as const } as never)),
    });
    await expect(blocked.verifyRelease({
      workspace: input.workspace,
      batchId: input.manifest.batchId,
      manifest: input.manifest,
      commit,
      mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });

    const workReportReuse = createProductionBatchDependencies({
      loadBatches: vi.fn(async () => []), buildTree, promoteTree, loadBaseline,
      validateCatalog: vi.fn(() => ({ ok: true, success: true, value: {} } as never)),
      verifyF001Invariant, buildPagesPreview, verifyF001DistInvariant,
      verifyActualCapacity: vi.fn(async () => ({ ...releaseActual, phase: 'work-preview' as const } as never)),
    });
    await expect(workReportReuse.verifyRelease({
      workspace: input.workspace, batchId: input.manifest.batchId, manifest: input.manifest,
      commit, mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });

    const otherDist = createProductionBatchDependencies({
      loadBatches: vi.fn(async () => []), buildTree, promoteTree, loadBaseline,
      validateCatalog: vi.fn(() => ({ ok: true, success: true, value: {} } as never)),
      verifyF001Invariant,
      buildPagesPreview: vi.fn(async () => ({ ...pages, distSha256: hash('other-dist') } as never)),
      verifyF001DistInvariant, verifyActualCapacity,
    });
    await expect(otherDist.verifyRelease({
      workspace: input.workspace, batchId: input.manifest.batchId, manifest: input.manifest,
      commit, mode: 'release',
    })).rejects.toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE' });
  });
});
