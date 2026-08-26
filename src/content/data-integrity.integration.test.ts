import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  loadAndVerifyF001Baseline,
  verifyF001Invariant,
  type F001Baseline,
} from './baseline';
import {
  validateBatchManifest,
  type AcceptedAudioSource,
  type BatchManifest,
} from './batch';
import {
  extractDialogueCandidates,
  normalizeDisplayText,
  type CatalogV2,
  type DecodedSource,
} from './processing';
import { validateCatalogV2 } from '../ui/catalog-loader';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORK_IDS = ['000127', '000092', '043015'] as const;
const F002_WORKS = [
  { workId: '000473', dialogues: 26, acceptedAudio: 26 },
  { workId: '043752', dialogues: 63, acceptedAudio: 62 },
  { workId: '043754', dialogues: 65, acceptedAudio: 64 },
] as const;

interface Candidate {
  candidateId: string;
  workId: string;
  order: number;
  rawSourceSha256: string;
  displayText: string;
  speechText: string;
}

interface ReviewRecord {
  candidateId: string;
  revision: number;
  status: 'approved' | 'rejected' | 'pending';
  reasonCode: string;
  reviewer: string;
}

interface ReviewedPair {
  candidate: Candidate;
  review: ReviewRecord;
}

interface ReviewedContent {
  works: Array<{ workId: string; candidateIds: string[]; source: CatalogSource }>;
  review: {
    all: ReviewedPair[];
    approved: ReviewedPair[];
    rejected: ReviewedPair[];
    pending: ReviewedPair[];
    counts: { approved: number; rejected: number; pending: number };
  };
}

interface CatalogSource {
  sourceSha256: string;
  textUrl: string;
  cardUrl: string;
  fetchedAt: string;
  provenancePath?: string;
  provenanceSha256?: string;
}

interface CatalogDialogue {
  dialogueId: string;
  audioId: string;
  displayText: string;
  speechText: string;
  review: ReviewRecord;
  workId?: string;
}

interface AudioAsset {
  audioId: string;
  candidateIds: string[];
  path: string;
  bytes: number;
  sha256: string;
  configHash: string;
  batchId?: string;
}

interface CandidateCounts {
  total: number;
  published: number;
  editorialExcluded: number;
  audioExcluded: number;
  editorialReasons?: Record<string, number>;
  audioFailureReasons?: Record<string, number>;
}

interface Catalog {
  works: Array<{ workId: string; source: CatalogSource; dialogues: CatalogDialogue[] }>;
  audioAssets: AudioAsset[];
  candidateCounts: CandidateCounts;
}

interface VoiceGeneration {
  assets: AudioAsset[];
  failures: Array<{ candidateIds: string[]; reasonCode: string }>;
  attempted: number;
  succeeded: number;
  failed: number;
}

interface AssetManifest {
  audioAssets: AudioAsset[];
  candidateAudio: Record<string, string>;
}

interface ProvenanceWork {
  workId: string;
  sourceSha256: string;
  sourceUrl: string;
  stableCardUrl: string;
  fetchedAt: string;
}

interface Provenance {
  works: ProvenanceWork[];
  sourceHashes: Record<string, string>;
}

interface SourceRecord {
  workId: string;
  rawSha256: string;
  sourceUrl: string;
  fetchedAt: string;
}

interface DecodedArtifact extends DecodedSource {
  diagnostics?: unknown[];
}

interface PublicAudio {
  bytes: number;
  sha256: string;
}

interface IntegrityDataset {
  candidates: Candidate[][];
  reviews: ReviewRecord[][];
  reviewed: ReviewedContent;
  catalog: Catalog;
  generation: VoiceGeneration;
  assetManifest: AssetManifest;
  provenance: Provenance;
  sources: SourceRecord[];
  publicAudio: Record<string, PublicAudio>;
  publicCatalog: CatalogV2;
  publicCatalogBytes: number;
  f002Manifest: BatchManifest;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(projectRoot, path), 'utf8')) as T;
}

async function loadDataset(): Promise<IntegrityDataset> {
  const candidates = await Promise.all(WORK_IDS.map((workId) =>
    json<Candidate[]>(`data/intermediate/${workId}/candidates.json`)));
  const reviews = await Promise.all(WORK_IDS.map((workId) =>
    json<ReviewRecord[]>(`content/reviews/${workId}.json`)));
  const sources = await Promise.all(WORK_IDS.map((workId) =>
    json<SourceRecord>(`data/sources/${workId}/source.json`)));
  const audioRoot = join(projectRoot, 'public/audio/F001');
  const publicAudio: Record<string, PublicAudio> = {};
  for (const name of await readdir(audioRoot)) {
    const path = join(audioRoot, name);
    const bytes = await readFile(path);
    publicAudio[relative(join(projectRoot, 'public'), path).replaceAll('\\', '/')] = {
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const publicCatalogText = await readFile(join(projectRoot, 'public/content/catalog.json'), 'utf8');
  const publicCatalog = JSON.parse(publicCatalogText) as CatalogV2;
  const manifestValidation = validateBatchManifest(await json<unknown>('content/batches/F002/batch.json'));
  if (!manifestValidation.ok) {
    throw new Error(`F002 batch manifestが不正です: ${manifestValidation.error.code}`);
  }
  const f001Counts = publicCatalog.candidateCounts.byBatch.F001;
  if (!f001Counts) throw new Error('CatalogV2にF001 candidateCountsがありません');
  return {
    candidates,
    reviews,
    reviewed: await json<ReviewedContent>('content/reviewed-content.json'),
    catalog: {
      works: publicCatalog.works.filter((work) => work.batchId === 'F001'),
      audioAssets: publicCatalog.audioAssets
        .filter((asset) => asset.batchId === 'F001')
        .map((asset) => ({ ...asset, batchId: undefined, candidateIds: asset.candidateIds ?? [] })),
      candidateCounts: f001Counts,
    },
    generation: await json<VoiceGeneration>('content/voice-generation.json'),
    assetManifest: await json<AssetManifest>('content/asset-manifest.json'),
    provenance: await json<Provenance>('content/provenance.json'),
    sources,
    publicAudio,
    publicCatalog,
    publicCatalogBytes: Buffer.byteLength(publicCatalogText, 'utf8'),
    f002Manifest: manifestValidation.value,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function addIf(issues: Set<string>, condition: boolean, code: string): void {
  if (condition) issues.add(code);
}

function contentIntegrityIssues(dataset: IntegrityDataset): string[] {
  const issues = new Set<string>();
  const expectedWorkIds = new Set<string>(WORK_IDS);
  const candidateById = new Map<string, Candidate>();
  const candidateIdsByWork = new Map<string, Set<string>>();

  dataset.candidates.forEach((group, workIndex) => {
    const workId = WORK_IDS[workIndex];
    if (!workId) {
      issues.add('CANDIDATE_WORK_ORDER_MISMATCH');
      return;
    }
    const ids = new Set<string>();
    group.forEach((candidate, order) => {
      addIf(issues, candidate.workId !== workId || candidate.order !== order, 'CANDIDATE_WORK_ORDER_MISMATCH');
      addIf(issues, candidateById.has(candidate.candidateId), 'CANDIDATE_ID_DUPLICATE');
      candidateById.set(candidate.candidateId, candidate);
      ids.add(candidate.candidateId);
    });
    candidateIdsByWork.set(workId, ids);
  });

  const latestReview = new Map<string, ReviewRecord>();
  dataset.reviews.forEach((records, workIndex) => {
    const workId = WORK_IDS[workIndex];
    const allowed = workId ? candidateIdsByWork.get(workId) ?? new Set<string>() : new Set<string>();
    const revisions = new Set<string>();
    for (const review of records) {
      addIf(issues, !allowed.has(review.candidateId), 'REVIEW_ORPHAN_OR_WRONG_WORK');
      const revisionKey = `${review.candidateId}:${review.revision}`;
      addIf(issues, revisions.has(revisionKey), 'REVIEW_REVISION_DUPLICATE');
      revisions.add(revisionKey);
      const current = latestReview.get(review.candidateId);
      if (!current || review.revision > current.revision) latestReview.set(review.candidateId, review);
    }
  });
  addIf(issues, latestReview.size !== candidateById.size, 'REVIEW_COVERAGE_MISMATCH');
  for (const candidateId of candidateById.keys()) {
    if (!latestReview.has(candidateId)) issues.add('REVIEW_COVERAGE_MISMATCH');
  }

  const reviewedById = new Map(dataset.reviewed.review.all.map((pair) => [pair.candidate.candidateId, pair]));
  addIf(issues, reviewedById.size !== candidateById.size, 'REVIEWED_CONTENT_COVERAGE_MISMATCH');
  for (const [candidateId, candidate] of candidateById) {
    const pair = reviewedById.get(candidateId);
    addIf(issues, !pair || !sameJson(pair.candidate, candidate) || !sameJson(pair.review, latestReview.get(candidateId)), 'REVIEWED_CONTENT_JOIN_MISMATCH');
  }
  addIf(issues, dataset.reviewed.review.pending.length !== 0 || dataset.reviewed.review.counts.pending !== 0, 'PENDING_REVIEW_REMAINS');
  addIf(issues,
    dataset.reviewed.review.all.length !== dataset.reviewed.review.counts.approved +
      dataset.reviewed.review.counts.rejected + dataset.reviewed.review.counts.pending,
    'REVIEW_COUNT_MISMATCH');
  for (const review of latestReview.values()) {
    addIf(issues, review.status !== 'pending' && review.reasonCode.trim() === '', 'EXCLUSION_REASON_MISSING');
  }

  const approvedIds = new Set([...latestReview].filter(([, review]) => review.status === 'approved').map(([id]) => id));
  const failedIds = new Set(dataset.generation.failures.flatMap((failure) => {
    addIf(issues, failure.reasonCode.trim() === '', 'AUDIO_EXCLUSION_REASON_MISSING');
    return failure.candidateIds;
  }));
  const audioById = new Map<string, AudioAsset>();
  const audioByCandidate = new Map<string, AudioAsset>();
  for (const asset of dataset.generation.assets) {
    addIf(issues, audioById.has(asset.audioId), 'AUDIO_ID_DUPLICATE');
    audioById.set(asset.audioId, asset);
    for (const candidateId of asset.candidateIds) {
      addIf(issues, audioByCandidate.has(candidateId), 'AUDIO_CANDIDATE_DUPLICATE');
      addIf(issues, !approvedIds.has(candidateId), 'AUDIO_CANDIDATE_NOT_APPROVED');
      audioByCandidate.set(candidateId, asset);
    }
  }
  addIf(issues,
    dataset.generation.succeeded !== dataset.generation.assets.length ||
      dataset.generation.failed !== dataset.generation.failures.length ||
      dataset.generation.attempted !== dataset.generation.succeeded + dataset.generation.failed,
    'VOICE_GENERATION_COUNT_MISMATCH');
  for (const candidateId of approvedIds) {
    addIf(issues, !audioByCandidate.has(candidateId) && !failedIds.has(candidateId), 'APPROVED_AUDIO_RESULT_MISSING');
  }

  const catalogWorkIds = new Set(dataset.catalog.works.map((work) => work.workId));
  addIf(issues,
    catalogWorkIds.size !== expectedWorkIds.size || [...catalogWorkIds].some((workId) => !expectedWorkIds.has(workId)),
    'CATALOG_WORK_SET_MISMATCH');
  const publishedIds = new Set<string>();
  for (const work of dataset.catalog.works) {
    const provenance = dataset.provenance.works.find((item) => item.workId === work.workId);
    const source = dataset.sources.find((item) => item.workId === work.workId);
    addIf(issues,
      !provenance || !source || work.source.sourceSha256 !== provenance.sourceSha256 ||
        work.source.sourceSha256 !== source.rawSha256 || work.source.textUrl !== provenance.sourceUrl ||
        work.source.cardUrl !== provenance.stableCardUrl || work.source.fetchedAt !== provenance.fetchedAt,
      'SOURCE_PROVENANCE_JOIN_MISMATCH');
    for (const dialogue of work.dialogues) {
      const candidate = candidateById.get(dialogue.dialogueId);
      const review = latestReview.get(dialogue.dialogueId);
      addIf(issues, publishedIds.has(dialogue.dialogueId), 'CATALOG_DIALOGUE_DUPLICATE');
      addIf(issues, !candidate || candidate.workId !== work.workId || !approvedIds.has(dialogue.dialogueId), 'CATALOG_UNKNOWN_CANDIDATE');
      addIf(issues,
        !candidate || dialogue.displayText !== candidate.displayText || dialogue.speechText !== candidate.speechText ||
          !sameJson(dialogue.review, review),
        'CATALOG_DIALOGUE_JOIN_MISMATCH');
      addIf(issues, audioByCandidate.get(dialogue.dialogueId)?.audioId !== dialogue.audioId, 'CATALOG_AUDIO_JOIN_MISMATCH');
      publishedIds.add(dialogue.dialogueId);
    }
  }
  const expectedPublished = new Set([...approvedIds].filter((candidateId) => !failedIds.has(candidateId)));
  addIf(issues,
    publishedIds.size !== expectedPublished.size || [...expectedPublished].some((id) => !publishedIds.has(id)),
    'CATALOG_PUBLISHED_SET_MISMATCH');
  addIf(issues,
    dataset.catalog.candidateCounts.total !== candidateById.size ||
      dataset.catalog.candidateCounts.published !== publishedIds.size ||
      dataset.catalog.candidateCounts.editorialExcluded !== dataset.reviewed.review.counts.rejected ||
      dataset.catalog.candidateCounts.audioExcluded !== failedIds.size ||
      dataset.catalog.candidateCounts.total !== dataset.catalog.candidateCounts.published +
        dataset.catalog.candidateCounts.editorialExcluded + dataset.catalog.candidateCounts.audioExcluded,
    'CATALOG_CANDIDATE_COUNT_MISMATCH');

  addIf(issues, !sameJson(dataset.catalog.audioAssets, dataset.generation.assets), 'CATALOG_AUDIO_MANIFEST_MISMATCH');
  addIf(issues, !sameJson(dataset.assetManifest.audioAssets, dataset.generation.assets), 'ASSET_AUDIO_MANIFEST_MISMATCH');
  for (const [candidateId, asset] of audioByCandidate) {
    addIf(issues, dataset.assetManifest.candidateAudio[candidateId] !== asset.audioId, 'ASSET_CANDIDATE_AUDIO_MISMATCH');
  }
  const expectedAudioPaths = new Set(dataset.generation.assets.map((asset) => asset.path));
  const actualAudioPaths = new Set(Object.keys(dataset.publicAudio));
  addIf(issues,
    expectedAudioPaths.size !== actualAudioPaths.size || [...expectedAudioPaths].some((path) => !actualAudioPaths.has(path)),
    'PUBLIC_AUDIO_SET_MISMATCH');
  for (const asset of dataset.generation.assets) {
    const file = dataset.publicAudio[asset.path];
    addIf(issues, !file || file.bytes !== asset.bytes || file.sha256 !== asset.sha256, 'PUBLIC_AUDIO_HASH_MISMATCH');
  }

  const provenanceWorkIds = new Set(dataset.provenance.works.map((work) => work.workId));
  addIf(issues,
    provenanceWorkIds.size !== expectedWorkIds.size || [...provenanceWorkIds].some((workId) => !expectedWorkIds.has(workId)),
    'PROVENANCE_WORK_SET_MISMATCH');
  for (const candidate of candidateById.values()) {
    addIf(issues, dataset.provenance.sourceHashes[candidate.workId] !== candidate.rawSourceSha256, 'CANDIDATE_PROVENANCE_HASH_MISMATCH');
  }
  return [...issues].sort((left, right) => left.localeCompare(right, 'en'));
}

let productionDataset: IntegrityDataset;

beforeAll(async () => {
  productionDataset = await loadDataset();
});

describe('F001全件照合とF002 CatalogV2統合 [IT-F001-018][IT-F002-007]', () => {
  /** @des DES-F001-005 DES-F001-006 @test IT-F001-002 IT-F001-018 */
  it('取得済み3作品の原典から67件を欠落なく再抽出できる', async () => {
    const expectedCounts = new Map<string, number>([
      ['000127', 15],
      ['000092', 3],
      ['043015', 49],
    ]);
    const extracted = new Map<string, string[]>();

    for (const workId of WORK_IDS) {
      const decoded = await json<DecodedArtifact>(`data/intermediate/${workId}/decoded.json`);
      const result = extractDialogueCandidates(decoded, workId);
      expect(result, `${workId}: ${JSON.stringify(result.diagnostics)}`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      const displayTexts = result.candidates.map((candidate) => normalizeDisplayText(candidate.tokens));
      expect(displayTexts).toHaveLength(expectedCounts.get(workId)!);
      extracted.set(workId, displayTexts);
    }

    expect(extracted.get('000092')).toEqual([
      '「いや、いや、これも小さいながら、命のあるものに違いない。その命を無暗にとると云う事は、いくら何でも可哀そうだ。」',
      '「しめた。しめた。」',
      '「こら、罪人ども。この蜘蛛の糸は己のものだぞ。お前たちは一体誰に尋いて、のぼって来た。下りろ。下りろ。」',
    ]);
  });

  /** @des DES-F001-002 DES-F001-003 DES-F001-007 DES-F001-012 @test IT-F001-018 */
  it('実data/content/publicをcandidate・review・catalog・audio・provenanceで全件joinできる', () => {
    expect(contentIntegrityIssues(productionDataset)).toEqual([]);
    expect(productionDataset.reviewed.review.counts).toEqual({ approved: 59, rejected: 8, pending: 0 });
  });

  /** @des DES-F002-001 DES-F002-003 DES-F002-006 @test IT-F002-007 */
  it('CatalogV2はF001 baselineを保持しF002の承認済み3作品・参照実体を統合する', async () => {
    const { publicCatalog: catalog, f002Manifest } = productionDataset;
    const validation = validateCatalogV2(catalog, productionDataset.publicCatalogBytes);
    expect(validation).toMatchObject({ ok: true });

    const publicRoot = join(projectRoot, 'public');
    const verifiedF001 = await loadAndVerifyF001Baseline(
      publicRoot,
      join(projectRoot, 'content/baselines/F001-v0.1.0.json'),
      join(projectRoot, 'content/baselines/F001-v0.1.0-catalog.json'),
    );
    const f001Baseline = {
      baselineSha256: verifiedF001.baselineSha256,
      files: verifiedF001.files,
      catalog: verifiedF001.catalog,
    } as F001Baseline;
    await expect(verifyF001Invariant(catalog, publicRoot, f001Baseline)).resolves.toMatchObject({
      result: 'pass',
      baselineSha256: f001Baseline.baselineSha256,
    });

    const expectedWorkIds = F002_WORKS.map((work) => work.workId);
    const f002Author = catalog.authors.find((author) => author.introducedByBatchId === 'F002');
    const f002Batch = catalog.batches.find((batch) => batch.batchId === 'F002');
    const f002Works = catalog.works.filter((work) => work.batchId === 'F002');
    const f002Audio = catalog.audioAssets.filter((asset) => asset.batchId === 'F002');
    expect(f002Author?.authorId).toBe('000081');
    expect(f002Batch).toMatchObject({
      feature: 'F002',
      status: 'accepted',
      authorId: '000081',
      workIds: expectedWorkIds,
    });
    expect(f002Manifest).toMatchObject({
      status: 'published',
      author: { authorId: '000081' },
      workIds: expectedWorkIds,
      releaseVersion: '0.2.0',
      deploymentEvidenceRef: 'docs/evidence/release/F002-deployment.json',
      smokeEvidenceRef: 'docs/evidence/release/F002-smoke.json',
    });
    expect(f002Works.map((work) => ({
      workId: work.workId,
      dialogues: work.dialogues.length,
    }))).toEqual(F002_WORKS.map(({ workId, dialogues }) => ({ workId, dialogues })));
    expect(f002Manifest.workProgress.map((work) => ({
      workId: work.workId,
      status: work.status,
      acceptedAudio: work.acceptedAudioSources?.length ?? 0,
    }))).toEqual(F002_WORKS.map(({ workId, acceptedAudio }) => ({
      workId,
      status: 'accepted',
      acceptedAudio,
    })));

    const acceptedAudioBySha = new Map<string, AcceptedAudioSource[]>();
    for (const source of f002Manifest.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
      const group = acceptedAudioBySha.get(source.sha256) ?? [];
      group.push(source);
      acceptedAudioBySha.set(source.sha256, group);
    }
    expect(acceptedAudioBySha.size).toBe(f002Audio.length);
    expect((await readdir(join(projectRoot, 'public/audio/F002'))).sort((left, right) => left.localeCompare(right, 'en')))
      .toEqual(f002Audio.map((asset) => `${asset.audioId}.wav`).sort((left, right) => left.localeCompare(right, 'en')));
    for (const asset of f002Audio) {
      const acceptedGroup = acceptedAudioBySha.get(asset.sha256);
      expect(acceptedGroup?.length).toBeGreaterThan(0);
      const canonicalAudioId = acceptedGroup!
        .map((source) => source.path.split('/').at(-1)!.replace(/\.wav$/u, ''))
        .sort((left, right) => left.localeCompare(right, 'en'))[0];
      expect(asset.audioId).toBe(canonicalAudioId);
      for (const accepted of acceptedGroup!) {
        expect(accepted).toMatchObject({
          sha256: asset.sha256,
          bytes: asset.bytes,
          configHash: asset.configHash,
        });
        const acceptedBytes = await readFile(join(projectRoot, ...accepted.path.split('/')));
        expect({ bytes: acceptedBytes.byteLength, sha256: sha256(acceptedBytes) }).toEqual({
          bytes: asset.bytes, sha256: asset.sha256,
        });
      }
      const publicBytes = await readFile(join(projectRoot, 'public', ...asset.path.split('/')));
      expect({ bytes: publicBytes.byteLength, sha256: sha256(publicBytes) }).toEqual({
        bytes: asset.bytes, sha256: asset.sha256,
      });
    }

    const dialogueIds = new Set<string>();
    const f002AudioIds = new Set(f002Audio.map((asset) => asset.audioId));
    for (const work of f002Works) {
      expect(work).toMatchObject({ authorId: '000081', batchId: 'F002' });
      expect(work.source.provenancePath).toBe(`content/provenance/F002/${work.workId}.json`);
      const [sourceProvenance, publicProvenance] = await Promise.all([
        readFile(join(projectRoot, 'content', 'batches', 'F002', 'public-files', 'provenance', `${work.workId}.json`)),
        readFile(join(projectRoot, 'public', ...work.source.provenancePath!.split('/'))),
      ]);
      expect(sha256(sourceProvenance)).toBe(work.source.provenanceSha256);
      expect(sha256(publicProvenance)).toBe(work.source.provenanceSha256);
      for (const dialogue of work.dialogues) {
        expect(dialogue.workId).toBe(work.workId);
        expect(f002AudioIds.has(dialogue.audioId)).toBe(true);
        expect(dialogueIds.has(dialogue.dialogueId)).toBe(false);
        dialogueIds.add(dialogue.dialogueId);
      }
    }

    const f002Counts = catalog.candidateCounts.byBatch.F002!;
    expect(f002Counts.published).toBe(dialogueIds.size);
    expect(f002Counts.total).toBe(f002Counts.published + f002Counts.editorialExcluded + f002Counts.audioExcluded);
    expect(f002Counts).toMatchObject({ total: 167, published: 154, editorialExcluded: 13, audioExcluded: 0 });

    const [sourceArtwork, publicArtwork, credits] = await Promise.all([
      readFile(join(projectRoot, 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png')),
      readFile(join(projectRoot, 'public', ...f002Author!.artwork.path.split('/'))),
      readFile(join(projectRoot, 'public', ...catalog.creditsRef.split('/'))),
    ]);
    expect(f002Author!.artwork.path).toBe('artwork/miyazawa-zundamon.png');
    expect(sha256(sourceArtwork)).toBe(f002Author!.artwork.sha256);
    expect(sha256(publicArtwork)).toBe(f002Author!.artwork.sha256);
    expect(credits.byteLength).toBeGreaterThan(0);
  }, 60_000);

  /** @des DES-F001-002 DES-F001-007 DES-F001-012 @test IT-F001-018 */
  it.each([
    ['review欠落', (dataset: IntegrityDataset) => { dataset.reviews[0]!.pop(); }, 'REVIEW_COVERAGE_MISMATCH'],
    ['catalog余分', (dataset: IntegrityDataset) => {
      dataset.catalog.works[0]!.dialogues.push({ ...dataset.catalog.works[0]!.dialogues[0]!, dialogueId: 'unknown-candidate' });
    }, 'CATALOG_UNKNOWN_CANDIDATE'],
    ['audio候補重複', (dataset: IntegrityDataset) => {
      dataset.generation.assets[1]!.candidateIds.push(dataset.generation.assets[0]!.candidateIds[0]!);
    }, 'AUDIO_CANDIDATE_DUPLICATE'],
    ['理由なし除外', (dataset: IntegrityDataset) => {
      const rejected = dataset.reviews.flat().find((review) => review.status === 'rejected');
      if (rejected) rejected.reasonCode = '';
    }, 'EXCLUSION_REASON_MISSING'],
    ['公開音声欠落', (dataset: IntegrityDataset) => {
      delete dataset.publicAudio[dataset.generation.assets[0]!.path];
    }, 'PUBLIC_AUDIO_SET_MISMATCH'],
  ] as const)('%sを全件照合で検出する', (_name, mutate, expectedIssue) => {
    const mutated = structuredClone(productionDataset);
    mutate(mutated);
    expect(contentIntegrityIssues(mutated)).toContain(expectedIssue);
  });
});
