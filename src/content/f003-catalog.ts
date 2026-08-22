import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadAndValidateWorkNotices } from '../notices/work-notices.ts';
import {
  applyWorkReviews,
  type Candidate,
  type CatalogV2,
  type ReviewRecord,
} from './processing.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkspaceRelativePath,
} from './batch.ts';
import type { BatchCatalogFragment } from './batch-public.ts';

interface RightsSelection {
  readonly selection: {
    readonly works: readonly {
      readonly workId: string;
      readonly title: string;
      readonly cardUrl: string;
      readonly sourceUrl: string;
      readonly baseEdition: string;
      readonly inputter: string;
      readonly proofreader: string;
    }[];
  };
}

interface PersistedGeneration {
  readonly payload: {
    readonly generation: {
      readonly batchId: string;
      readonly workId: string;
      readonly assets: readonly {
        readonly audioId: string;
        readonly candidateIds: readonly string[];
        readonly sha256: string;
        readonly bytes: number;
        readonly durationMs: number;
        readonly configHash: string;
      }[];
    };
  };
}

interface WorkProvenance {
  readonly processing: { readonly transformation: string };
  readonly source: { readonly fetchedAt: string; readonly rawSha256: string };
}

function sha256(value: Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function mergeAudioAssets(
  assets: readonly BatchCatalogFragment['audioAssets'][number][],
): BatchCatalogFragment['audioAssets'] {
  const merged = new Map<string, BatchCatalogFragment['audioAssets'][number]>();
  for (const asset of assets) {
    const current = merged.get(asset.audioId);
    if (!current) {
      merged.set(asset.audioId, { ...asset, candidateIds: [...(asset.candidateIds ?? [])] });
      continue;
    }
    if (
      current.path !== asset.path || current.sha256 !== asset.sha256 ||
      current.bytes !== asset.bytes || current.durationMs !== asset.durationMs ||
      current.configHash !== asset.configHash
    ) {
      throw new Error(`F003同一audioIdのmetadataが競合しています: ${asset.audioId}`);
    }
    merged.set(asset.audioId, {
      ...current,
      candidateIds: [...new Set([...(current.candidateIds ?? []), ...(asset.candidateIds ?? [])])],
    });
  }
  return [...merged.values()].sort((left, right) => left.audioId.localeCompare(right.audioId, 'en'));
}

function sumCounts(
  counts: readonly BatchCatalogFragment['candidateCounts'][],
): BatchCatalogFragment['candidateCounts'] {
  const sumRecord = (key: 'editorialReasons' | 'audioFailureReasons'): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const count of counts) {
      for (const [reason, value] of Object.entries(count[key] ?? {})) {
        result[reason] = (result[reason] ?? 0) + value;
      }
    }
    return result;
  };
  return {
    total: counts.reduce((sum, value) => sum + value.total, 0),
    published: counts.reduce((sum, value) => sum + value.published, 0),
    editorialExcluded: counts.reduce((sum, value) => sum + value.editorialExcluded, 0),
    audioExcluded: counts.reduce((sum, value) => sum + value.audioExcluded, 0),
    editorialReasons: sumRecord('editorialReasons'),
    audioFailureReasons: sumRecord('audioFailureReasons'),
  };
}

/**
 * 固定v0.2.0 Catalogと追跡済みF002 manifestから、公開済みF002 fragmentを復元する。
 * @des DES-F003-002 @des DES-F003-009 @fun FUN-F003-005 @fun FUN-F003-022 @ut UT-F003-022
 */
export async function loadPublishedF002CatalogFragment(
  workspace: string,
  catalog: CatalogV2,
): Promise<BatchCatalogFragment> {
  const authors = catalog.authors.filter((item) => item.introducedByBatchId === 'F002');
  const works = catalog.works.filter((item) => item.batchId === 'F002');
  const audioAssets = catalog.audioAssets
    .filter((item) => item.batchId === 'F002')
    .map((item) => ({ ...item }));
  const manifest = await readJson<BatchManifest>(join(workspace, 'content', 'batches', 'F002', 'batch.json'));
  const checked = validateBatchManifest(manifest);
  if (!checked.ok || checked.value.status !== 'published') {
    throw new Error('F002 published manifestが不正です');
  }
  for (const source of checked.value.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F002 accepted audioのaliasを復元できません: ${audioId}`);
    audioAssets.push({ ...canonical, audioId, path: `audio/F002/${audioId}.wav` });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of [
    ...authors.map((author) => ({
      source: 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png',
      publicPath: author.artwork.path,
    })),
    ...works.map((work) => ({
      source: `content/batches/F002/public-files/provenance/${work.workId}.json`,
      publicPath: work.source.provenancePath,
    })),
  ]) {
    const bytes = await readFile(join(workspace, ...item.source.split('/')));
    publicFiles.push({
      source: item.source as WorkspaceRelativePath,
      publicPath: item.publicPath as WorkspaceRelativePath,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  const candidateCounts = catalog.candidateCounts.byBatch.F002;
  if (!candidateCounts) throw new Error('固定v0.2.0 CatalogにF002 candidate countsがありません');
  return { authors, works, audioAssets, candidateCounts, publicFiles };
}

/**
 * 固定v0.4.0 baseline Catalogと追跡済みF004 manifestから、公開済みF004 fragmentを復元する。
 * F004は既存作者画像(F002)を再利用し新規artworkを導入しないため、authors/publicFilesは
 * work provenanceのみを含む(loadPublishedF002CatalogFragmentの構造を踏襲)。
 * @des DES-F003-002 @des DES-F003-009 @fun FUN-F003-005 @fun FUN-F003-022
 */
export async function loadPublishedF004CatalogFragment(
  workspace: string,
  catalog: CatalogV2,
): Promise<BatchCatalogFragment> {
  const authors = catalog.authors.filter((item) => item.introducedByBatchId === 'F004');
  const works = catalog.works.filter((item) => item.batchId === 'F004');
  const audioAssets = catalog.audioAssets
    .filter((item) => item.batchId === 'F004')
    .map((item) => ({ ...item }));
  const manifest = await readJson<BatchManifest>(join(workspace, 'content', 'batches', 'F004', 'batch.json'));
  const checked = validateBatchManifest(manifest);
  if (!checked.ok || checked.value.status !== 'published') {
    throw new Error('F004 published manifestが不正です');
  }
  for (const source of checked.value.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F004 accepted audioのaliasを復元できません: ${audioId}`);
    audioAssets.push({ ...canonical, audioId, path: `audio/F004/${audioId}.wav` });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of works.map((work) => ({
    source: `content/batches/F004/public-files/provenance/${work.workId}.json`,
    publicPath: work.source.provenancePath,
  }))) {
    const bytes = await readFile(join(workspace, ...item.source.split('/')));
    publicFiles.push({
      source: item.source as WorkspaceRelativePath,
      publicPath: item.publicPath as WorkspaceRelativePath,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  const candidateCounts = catalog.candidateCounts.byBatch.F004;
  if (!candidateCounts) throw new Error('固定v0.4.0 CatalogにF004 candidate countsがありません');
  return { authors, works, audioAssets, candidateCounts, publicFiles };
}

/**
 * 固定v0.5.0 baseline Catalogと追跡済みF005 manifestから、公開済みF005 fragmentを復元する。
 * F005はF003と同様に新規作者(自作artwork)を導入するため、loadPublishedF002CatalogFragmentの
 * authors/artwork復元構造を踏襲する(loadPublishedF004CatalogFragmentの作品のみ構造とは異なる)。
 * @des DES-F006-010 @fun FUN-F006-011
 */
export async function loadPublishedF005CatalogFragment(
  workspace: string,
  catalog: CatalogV2,
): Promise<BatchCatalogFragment> {
  const authors = catalog.authors.filter((item) => item.introducedByBatchId === 'F005');
  const works = catalog.works.filter((item) => item.batchId === 'F005');
  const audioAssets = catalog.audioAssets
    .filter((item) => item.batchId === 'F005')
    .map((item) => ({ ...item }));
  const manifest = await readJson<BatchManifest>(join(workspace, 'content', 'batches', 'F005', 'batch.json'));
  const checked = validateBatchManifest(manifest);
  // 実装時点でcontent/batches/F005/batch.jsonのstatusは'accepted'のまま
  // （2026-08-21のF005 v0.5.0公開commit 3c47b83はrecordPublishedBatchによる
  // per-batch status更新を伴わなかった）。release自体（release commit・tag・
  // deploy artifact・公開後スモークPASS）はdocs/evidence/release/RELEASE-F005.md
  // ・F005-approval.json・F005-deployment.jsonで確定済みであり、
  // f006-baseline.tsのloadPublishedV050Baselineがそれらのhashを直接検証する。
  // loadAcceptedF003CatalogFragmentが'accepted'/'published'両方を受理する
  // 既存precedentに倣い、ここでも両方を許容する。
  if (!checked.ok || !['accepted', 'published'].includes(checked.value.status)) {
    throw new Error('F005 published manifestが不正です');
  }
  for (const source of checked.value.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F005 accepted audioのaliasを復元できません: ${audioId}`);
    audioAssets.push({ ...canonical, audioId, path: `audio/F005/${audioId}.wav` });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of [
    ...authors.map((author) => ({
      source: 'content/batches/F005/public-files/artwork/natsume-zundamon.png',
      publicPath: author.artwork.path,
    })),
    ...works.map((work) => ({
      source: `content/batches/F005/public-files/provenance/${work.workId}.json`,
      publicPath: work.source.provenancePath,
    })),
  ]) {
    const bytes = await readFile(join(workspace, ...item.source.split('/')));
    publicFiles.push({
      source: item.source as WorkspaceRelativePath,
      publicPath: item.publicPath as WorkspaceRelativePath,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  const candidateCounts = catalog.candidateCounts.byBatch.F005;
  if (!candidateCounts) throw new Error('固定v0.5.0 CatalogにF005 candidate countsがありません');
  return { authors, works, audioAssets, candidateCounts, publicFiles };
}

/**
 * 固定v0.6.0 baseline Catalogと追跡済みF006 manifestから、公開済みF006 fragmentを復元する。
 * loadPublishedF005CatalogFragmentと同型（新規作者・自作artwork導入）。
 * 実装時点でcontent/batches/F006/batch.jsonのstatusは'accepted'のまま
 * （F006 v0.6.0公開commitもrecordPublishedBatchによるper-batch status更新を
 * 伴わなかった、F005と同型の既知事象）。release自体はdocs/evidence/release/
 * RELEASE-F006.md・F006-approval.json・F006-deployment.jsonで確定済みであり、
 * f007-baseline.tsのloadPublishedV060Baselineがそれらのhashを直接検証する。
 * @des DES-F007-010 @fun FUN-F007-011
 */
export async function loadPublishedF006CatalogFragment(
  workspace: string,
  catalog: CatalogV2,
): Promise<BatchCatalogFragment> {
  const authors = catalog.authors.filter((item) => item.introducedByBatchId === 'F006');
  const works = catalog.works.filter((item) => item.batchId === 'F006');
  const audioAssets = catalog.audioAssets
    .filter((item) => item.batchId === 'F006')
    .map((item) => ({ ...item }));
  const manifest = await readJson<BatchManifest>(join(workspace, 'content', 'batches', 'F006', 'batch.json'));
  const checked = validateBatchManifest(manifest);
  if (!checked.ok || !['accepted', 'published'].includes(checked.value.status)) {
    throw new Error('F006 published manifestが不正です');
  }
  for (const source of checked.value.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F006 accepted audioのaliasを復元できません: ${audioId}`);
    audioAssets.push({ ...canonical, audioId, path: `audio/F006/${audioId}.wav` });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of [
    ...authors.map((author) => ({
      source: 'content/batches/F006/public-files/artwork/nakajima-zundamon.png',
      publicPath: author.artwork.path,
    })),
    ...works.map((work) => ({
      source: `content/batches/F006/public-files/provenance/${work.workId}.json`,
      publicPath: work.source.provenancePath,
    })),
  ]) {
    const bytes = await readFile(join(workspace, ...item.source.split('/')));
    publicFiles.push({
      source: item.source as WorkspaceRelativePath,
      publicPath: item.publicPath as WorkspaceRelativePath,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  const candidateCounts = catalog.candidateCounts.byBatch.F006;
  if (!candidateCounts) throw new Error('固定v0.6.0 CatalogにF006 candidate countsがありません');
  return { authors, works, audioAssets, candidateCounts, publicFiles };
}

const KNOWN_PUBLISHED_CATALOG_LOADERS: Readonly<
  Record<string, (workspace: string, catalog: CatalogV2) => Promise<BatchCatalogFragment>>
> = {
  F004: loadPublishedF004CatalogFragment,
  F005: loadPublishedF005CatalogFragment,
  F006: loadPublishedF006CatalogFragment,
};

/**
 * 呼出元(batch-catalog.ts等の汎用previewer)がbatchId固有の分岐を持たずに
 * 「このbatchId向けのpublished fragment loaderが存在するか」を判定できるようにする。
 */
export function isKnownPublishedCatalogBatchId(batchId: string): boolean {
  return batchId in KNOWN_PUBLISHED_CATALOG_LOADERS;
}

/**
 * isKnownPublishedCatalogBatchIdがtrueを返したbatchId向けに、対応するpublished
 * fragment loaderをdispatchする。未知のbatchIdで呼ぶとErrorになる(呼出前に
 * isKnownPublishedCatalogBatchIdで確認すること)。
 */
export async function loadKnownPublishedCatalogFragment(
  workspace: string,
  batchId: string,
  catalog: CatalogV2,
): Promise<BatchCatalogFragment> {
  const loader = KNOWN_PUBLISHED_CATALOG_LOADERS[batchId];
  if (!loader) throw new Error(`published fragment loaderが未登録です: ${batchId}`);
  return loader(workspace, catalog);
}

/**
 * acceptedまたはpublished F003の3作品を永続artifactだけから再構築し、作者・notice・音声参照を逆joinする。
 * @des DES-F003-009 @fun FUN-F003-022 @fun FUN-F003-023 @ut UT-F003-022 @ut UT-F003-023
 */
export async function loadAcceptedF003CatalogFragment(
  workspace: string,
): Promise<BatchCatalogFragment> {
  const batchPath = join(workspace, 'content', 'batches', 'F003', 'batch.json');
  const checked = validateBatchManifest(await readJson<unknown>(batchPath));
  if (!checked.ok || !['accepted', 'published'].includes(checked.value.status) ||
    checked.value.workProgress.some((work) => work.status !== 'accepted')) {
    throw new Error('F003全作品がaccepted済みのcanonical manifestではありません');
  }
  const manifest = checked.value;
  const [rights, notices, artworkBytes] = await Promise.all([
    readJson<RightsSelection>(join(workspace, 'content', 'batches', 'F003', 'rights-selection.json')),
    loadAndValidateWorkNotices(workspace, manifest.author.authorId),
    readFile(join(workspace, 'content', 'batches', 'F003', 'public-files', 'artwork', 'dazai-zundamon.png')),
  ]);
  const works: BatchCatalogFragment['works'][number][] = [];
  const allAudio: BatchCatalogFragment['audioAssets'][number][] = [];
  const counts: BatchCatalogFragment['candidateCounts'][] = [];
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [{
    source: 'content/batches/F003/public-files/artwork/dazai-zundamon.png' as WorkspaceRelativePath,
    publicPath: 'artwork/dazai-zundamon.png' as WorkspaceRelativePath,
    sha256: sha256(artworkBytes),
    bytes: artworkBytes.byteLength,
  }];

  for (const workId of manifest.workIds) {
    const selected = rights.selection.works.find((work) => work.workId === workId);
    const notice = notices.works.find((work) => work.workId === workId);
    if (!selected || !notice || selected.title !== notice.title || selected.cardUrl !== notice.cardUrl) {
      throw new Error(`F003 rights/noticeの作品identityが一致しません: ${workId}`);
    }
    const [candidates, reviewRecords, generationArtifact, provenanceBytes] = await Promise.all([
      readJson<Candidate[]>(join(
        workspace, 'data', 'batches', 'F003', 'work-artifacts', workId, 'intermediate', workId, 'candidates.json',
      )),
      readJson<ReviewRecord[]>(join(workspace, 'content', 'batches', 'F003', 'reviews', `${workId}.json`)),
      readJson<PersistedGeneration>(join(
        workspace, 'content', 'batches', 'F003', 'work-artifacts', workId, 'voice-completeness.json',
      )),
      readFile(join(workspace, 'content', 'batches', 'F003', 'public-files', 'provenance', `${workId}.json`)),
    ]);
    const review = applyWorkReviews(workId, candidates, reviewRecords);
    const generation = generationArtifact.payload.generation;
    const provenance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(provenanceBytes)) as WorkProvenance;
    if (generation.batchId !== 'F003' || generation.workId !== workId || review.pending.length !== 0) {
      throw new Error(`F003 review/generation tupleが不正です: ${workId}`);
    }
    const candidateAudio = new Map<string, string>();
    for (const asset of generation.assets) {
      for (const candidateId of asset.candidateIds) candidateAudio.set(candidateId, asset.audioId);
      allAudio.push({
        audioId: asset.audioId,
        batchId: 'F003',
        path: `audio/F003/${asset.audioId}.wav`,
        sha256: asset.sha256,
        bytes: asset.bytes,
        durationMs: asset.durationMs,
        configHash: asset.configHash,
        candidateIds: [...asset.candidateIds],
      });
    }
    const editorial = new Map(review.all.map((item) => [item.candidate.candidateId, item.review]));
    const dialogues = review.approved.map(({ candidate }, order) => {
      const audioId = candidateAudio.get(candidate.candidateId);
      const decision = editorial.get(candidate.candidateId);
      if (!audioId || !decision) throw new Error(`F003 candidate/audio/review joinが欠落しています: ${workId}`);
      return {
        dialogueId: candidate.candidateId,
        workId,
        order,
        displayText: candidate.displayText,
        speechText: candidate.speechText,
        audioId,
        sourceAnchor: candidate.sourceAnchor,
        review: decision,
      };
    });
    const reasonCounts = Object.fromEntries(
      [...new Set(review.rejected.map((item) => item.review.reasonCode))]
        .map((reason) => [reason, review.rejected.filter((item) => item.review.reasonCode === reason).length]),
    );
    counts.push({
      total: review.all.length,
      published: review.approved.length,
      editorialExcluded: review.rejected.length,
      audioExcluded: 0,
      editorialReasons: reasonCounts,
      audioFailureReasons: {},
    });
    const provenancePath = `content/provenance/F003/${workId}.json`;
    publicFiles.push({
      source: `content/batches/F003/public-files/provenance/${workId}.json` as WorkspaceRelativePath,
      publicPath: provenancePath as WorkspaceRelativePath,
      sha256: sha256(provenanceBytes),
      bytes: provenanceBytes.byteLength,
    });
    works.push({
      workId,
      title: selected.title,
      cardLink: selected.cardUrl,
      authorId: manifest.author.authorId,
      batchId: 'F003',
      source: {
        cardUrl: selected.cardUrl,
        textUrl: selected.sourceUrl,
        attribution: '青空文庫',
        baseEdition: selected.baseEdition,
        inputter: selected.inputter,
        proofreader: selected.proofreader,
        fetchedAt: provenance.source.fetchedAt,
        transformation: provenance.processing.transformation,
        sourceSha256: provenance.source.rawSha256,
        provenancePath,
        provenanceSha256: sha256(provenanceBytes),
      },
      dialogues,
      completionStatus: notice.completionStatus,
      notices: notice.notices.map((item) => ({
        textKey: item.textKey,
        placements: [...item.placements],
      })),
    });
  }

  return {
    authors: [{
      ...manifest.author,
      artwork: {
        path: 'artwork/dazai-zundamon.png',
        alt: '太宰治をイメージしたずんだもん',
        sha256: sha256(artworkBytes),
      },
      introducedByBatchId: 'F003',
    }],
    works,
    audioAssets: mergeAudioAssets(allAudio),
    candidateCounts: sumCounts(counts),
    publicFiles,
  };
}

export function acceptedF003CatalogBatch(
  manifest: BatchManifest,
): CatalogV2['batches'][number] {
  if (manifest.batchId !== 'F003' || manifest.status !== 'accepted' || !manifest.acceptedAt) {
    throw new Error('accepted F003 Catalog batchを作成できません');
  }
  return {
    batchId: manifest.batchId,
    feature: manifest.feature,
    status: 'accepted',
    authorId: manifest.author.authorId,
    workIds: [...manifest.workIds],
    acceptedAt: manifest.acceptedAt,
    evidenceSha256: hashBatchManifest(manifest),
  };
}
