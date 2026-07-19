import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { extractDialogueCandidates, normalizeDisplayText, type DecodedSource } from './processing';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORK_IDS = ['000127', '000092', '043015'] as const;

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
}

interface CatalogDialogue {
  dialogueId: string;
  audioId: string;
  displayText: string;
  speechText: string;
  review: ReviewRecord;
}

interface AudioAsset {
  audioId: string;
  candidateIds: string[];
  path: string;
  bytes: number;
  sha256: string;
  configHash: string;
}

interface Catalog {
  works: Array<{ workId: string; source: CatalogSource; dialogues: CatalogDialogue[] }>;
  audioAssets: AudioAsset[];
  candidateCounts: {
    total: number;
    published: number;
    editorialExcluded: number;
    audioExcluded: number;
  };
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
  return {
    candidates,
    reviews,
    reviewed: await json<ReviewedContent>('content/reviewed-content.json'),
    catalog: await json<Catalog>('public/content/catalog.json'),
    generation: await json<VoiceGeneration>('content/voice-generation.json'),
    assetManifest: await json<AssetManifest>('content/asset-manifest.json'),
    provenance: await json<Provenance>('content/provenance.json'),
    sources,
    publicAudio,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

describe('初期公開3作品の全候補・公開件数照合 [IT-F001-018]', () => {
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
