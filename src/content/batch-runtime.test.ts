import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import { createProductionBatchDependencies } from './batch-runtime.ts';
import { validateBatchManifest, type BatchManifest, type Sha256, type WorkId, type WorkspaceRelativePath } from './batch.ts';
import type { Candidate, ReviewRecord } from './processing.ts';

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
