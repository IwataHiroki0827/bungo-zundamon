import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline } from '../src/content/baseline.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import {
  buildIntegratedPublicTree,
  type BatchCatalogFragment,
  type F001BaselineBundle,
  type IntegratedBuild,
} from '../src/content/batch-public.ts';
import {
  hashBatchManifest,
  loadAcceptedBatches,
  validateBatchManifest,
  type Sha256,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  loadAcceptedF003CatalogFragment,
  loadPublishedF002CatalogFragment,
  loadPublishedF004CatalogFragment,
  loadPublishedF005CatalogFragment,
  loadPublishedF006CatalogFragment,
  loadPublishedF007CatalogFragment,
  loadPublishedF008CatalogFragment,
} from '../src/content/f003-catalog.ts';
import {
  deriveF009RouteSet,
  mergeNewAuthorCatalog009,
  type F009CatalogFragment,
} from '../src/content/f009-catalog.ts';
import { loadPublishedV080Baseline, isMintedPublishedV080Baseline } from '../src/content/f009-baseline.ts';
import {
  buildF009SourceProvenance,
  defineF009AuthorAndWorkRegistry,
  F009_WORKS,
  parseF009SourceRecord,
  rehydrateF009SelectionSnapshot,
  verifyF009AuthorIdentity,
  type F009WorkId,
} from '../src/content/f009-source.ts';
import { loadAndValidateWorkNotices, type WorkNoticePlacement, type WorkNoticeTextKey } from '../src/notices/work-notices.ts';
import { resolveVoiceGenerationPaths } from '../src/content/f003-artifact-paths.ts';
import { buildPagesPreview } from '../src/content/pages-preview.ts';
import type { VoiceDiffGenerationResult } from '../src/voice/generation.ts';
import type { ReviewRecord } from '../src/content/processing.ts';
import { validateCatalogV2 } from '../src/ui/catalog-loader.ts';

/**
 * F009（夢野久作3作品追加）の最終Catalog統合script。`scripts/f008-final-integration.ts`と
 * 同じ役割（3作品分の作品fragment片を結合し、単一の公開tree候補にする。固定v0.8.0
 * baselineとの差分がREQ-F009-001通りであることを検証する）を、F009既存の
 * `mergeNewAuthorCatalog009`（FUN-F009-011、baseline projection exact維持のassertを
 * 内包）・`deriveF009RouteSet`（FUN-F009-012）を使って実装する。work単位の構築ロジックは
 * `scripts/f009-content-preview.ts`の`buildWorkFragmentPiece`と同型の複製
 * （同scriptはCLI引数化・`await main()`副作用付きのため直接importできない）。
 * @des DES-F009-002 DES-F009-010 @fun FUN-F009-002 FUN-F009-010 FUN-F009-011 FUN-F009-012
 */

const execFile = promisify(execFileCallback);
const BATCH_ID = 'F009';
const AUTHOR_ID = '000096';
const ARTWORK_PUBLIC_PATH = 'artwork/yumeno-kyusaku-zundamon.png';
const ARTWORK_SOURCE_PATH = `content/batches/${BATCH_ID}/public-files/artwork/yumeno-kyusaku-zundamon.png`;
// content/batches/F009/artwork-provenance.jsonのoriginalImageSha256（実測）と一致する固定値。
const F009_ARTWORK_SHA256 = '25c47c982523cd03b25596a02ad17b5b071389a4ce7e2b1b76a95ffb04851d83' as Sha256;
const STATIC_ROUTES = ['#/', '#/favorites', '#/credits'] as const;

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readCanonicalJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`canonical JSONではありません: ${path}`);
  return value;
}

function asSha256(value: string): Sha256 {
  return value as Sha256;
}

function asWorkspacePath(value: string): WorkspaceRelativePath {
  return value as WorkspaceRelativePath;
}

async function writeCanonicalAtomic(workspace: string, path: string, value: unknown): Promise<Uint8Array> {
  await writeJsonArtifactAtomic(workspace, path, value);
  return new Uint8Array(await readFile(path));
}

function parseSourceAnchor(value: string): { bodySelector: string; startToken: number; endToken: number } {
  const match = /^(.+):(\d+)-(\d+)$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`sourceAnchor形式が不正です: ${value}`);
  return { bodySelector: match[1], startToken: Number(match[2]), endToken: Number(match[3]) };
}

interface CandidateRecord {
  readonly candidateId: string;
  readonly order: number;
  readonly displayText: string;
  readonly sha256: string;
  readonly sourceAnchor: string;
  readonly speechText: string;
}

interface SpeechRecord {
  readonly candidateId: string;
  readonly displayText: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly revisionCount: number;
}

interface WorkFragmentPiece {
  readonly work: BatchCatalogFragment['works'][number];
  readonly audioAssets: BatchCatalogFragment['audioAssets'];
  readonly candidateTotal: number;
  readonly publishedTotal: number;
  readonly editorialExcluded: number;
  readonly editorialReasons: Readonly<Record<string, number>>;
  readonly audioExcluded: number;
  readonly audioFailureReasons: Readonly<Record<string, number>>;
  readonly provenancePublicFile: NonNullable<BatchCatalogFragment['publicFiles']>[number];
}

/**
 * 候補の除外理由を「編集レビューで却下(reviews[].status!=='approved')」と
 * 「レビュー承認済みだが音声段階で除外(speech-revisions.jsonに不在、candidateCounts.
 * audioExcluded/audioFailureReasons)」へ正しく分離する。`f008-final-integration.ts`の
 * `computeExclusionCounts`・`scripts/f009-content-preview.ts`と同一ロジック。
 * @des DES-F009-010 @fun FUN-F009-011
 */
function computeExclusionCounts(
  reviews: readonly ReviewRecord[],
  speech: readonly SpeechRecord[],
): Pick<WorkFragmentPiece, 'editorialExcluded' | 'editorialReasons' | 'audioExcluded' | 'audioFailureReasons'> {
  const speechIds = new Set(speech.map((item) => item.candidateId));
  const editorialReasons: Record<string, number> = {};
  const audioFailureReasons: Record<string, number> = {};
  let editorialExcluded = 0;
  let audioExcluded = 0;
  for (const review of reviews) {
    if (review.status !== 'approved') {
      editorialExcluded++;
      editorialReasons[review.reasonCode] = (editorialReasons[review.reasonCode] ?? 0) + 1;
    } else if (!speechIds.has(review.candidateId)) {
      audioExcluded++;
      audioFailureReasons.AUDIO_ID_COLLISION = (audioFailureReasons.AUDIO_ID_COLLISION ?? 0) + 1;
    }
  }
  return { editorialExcluded, editorialReasons, audioExcluded, audioFailureReasons };
}

/**
 * `scripts/f009-content-preview.ts`の`buildWorkFragmentPiece`と同一構造の複製
 * （candidates/speech-revisions/reviews/voice-generation artifactsから work entry・
 * audioAssets・provenance public fileを決定的に組み立てる）。
 * @des DES-F009-002 DES-F009-010 @fun FUN-F009-002 FUN-F009-011
 */
async function buildWorkFragmentPiece(
  workspace: string,
  workId: F009WorkId,
  snapshot: Awaited<ReturnType<typeof rehydrateF009SelectionSnapshot>>,
  registry: ReturnType<typeof defineF009AuthorAndWorkRegistry>,
  noticesByWorkId: ReadonlyMap<string, { readonly completionStatus: 'complete' | 'unfinished'; readonly notices: readonly { readonly textKey: WorkNoticeTextKey; readonly placements: readonly WorkNoticePlacement[] }[] }>,
): Promise<WorkFragmentPiece> {
  const workSnapshot = snapshot.works.find((work) => work.workId === workId);
  if (!workSnapshot) throw new Error(`selection snapshotにwork ${workId}がありません`);
  const source = parseF009SourceRecord(workSnapshot, workId);
  const provenanceValue = buildF009SourceProvenance(source, snapshot);
  const provenanceSourcePath = `content/batches/${BATCH_ID}/public-files/provenance/${workId}.json`;
  const provenancePublicPath = `content/provenance/${BATCH_ID}/${workId}.json`;
  const provenanceBytes = await writeCanonicalAtomic(
    workspace,
    join(workspace, ...provenanceSourcePath.split('/')),
    provenanceValue,
  );

  const [candidatesArtifact, speechArtifact, reviews, generationRaw] = await Promise.all([
    readCanonicalJson<{ readonly candidates: readonly CandidateRecord[] }>(
      join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId, 'candidates.json'),
    ),
    readCanonicalJson<{ readonly speech: readonly SpeechRecord[] }>(
      join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId, 'speech-revisions.json'),
    ),
    readCanonicalJson<readonly ReviewRecord[]>(join(workspace, 'content', 'batches', BATCH_ID, 'reviews', `${workId}.json`)),
    readCanonicalJson<VoiceDiffGenerationResult>(
      join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId, 'voice-generation.json'),
    ),
  ]);
  const generation = resolveVoiceGenerationPaths(workspace, generationRaw);
  if (generation.batchId !== BATCH_ID || generation.workId !== workId) throw new Error('voice generation tupleが不正です');

  const candidatesById = new Map(candidatesArtifact.candidates.map((item) => [item.candidateId, item]));
  const reviewsById = new Map(reviews.map((item) => [item.candidateId, item]));
  const audioByCandidateId = new Map<string, string>();
  for (const asset of generation.assets) {
    for (const candidateId of asset.candidateIds) audioByCandidateId.set(candidateId, asset.audioId);
  }
  const dialogues = [...speechArtifact.speech]
    .map((speech) => {
      const candidate = candidatesById.get(speech.candidateId);
      const review = reviewsById.get(speech.candidateId);
      const audioId = audioByCandidateId.get(speech.candidateId);
      if (!candidate || !review || !audioId) {
        throw new Error(`candidate/review/audio joinが欠落しています: ${speech.candidateId}`);
      }
      return {
        dialogueId: speech.candidateId,
        workId,
        order: candidate.order,
        displayText: speech.displayText,
        speechText: speech.speechText,
        audioId,
        sourceAnchor: parseSourceAnchor(candidate.sourceAnchor),
        review,
      };
    })
    .sort((left, right) => left.order - right.order);
  // generation.assetsは同一text+configの候補を1つのaudioIdへ重複排除するため
  // (src/voice/generation.tsの既存共有仕様、無変更)、dialogues.length(候補単位)と
  // generation.assets.length(重複排除後の音声ファイル単位)は一致し得ない。
  // 正しい不変条件は「全candidateIdがassets側でちょうど1回ずつ言及される」こと。
  const totalCandidateIdsInAssets = generation.assets.reduce((sum, asset) => sum + asset.candidateIds.length, 0);
  const referencedAudioIds = new Set(dialogues.map((item) => item.audioId));
  const assetAudioIds = new Set(generation.assets.map((asset) => asset.audioId));
  if (
    dialogues.length !== speechArtifact.speech.length ||
    dialogues.length !== totalCandidateIdsInAssets ||
    referencedAudioIds.size !== assetAudioIds.size ||
    ![...referencedAudioIds].every((audioId) => assetAudioIds.has(audioId))
  ) {
    throw new Error(`dialogue/speech/audio件数が一致しません: ${workId}`);
  }

  const audioAssets = generation.assets.map((asset) => ({
    audioId: asset.audioId,
    batchId: BATCH_ID,
    path: `audio/${BATCH_ID}/${asset.audioId}.wav`,
    sha256: asset.sha256,
    bytes: asset.bytes,
    durationMs: asset.durationMs,
    configHash: asset.configHash,
    candidateIds: [...asset.candidateIds],
  }));

  const workEntry = registry.works.find((item) => item.workId === workId);
  if (!workEntry) throw new Error('registryにworkがありません');
  const notice = noticesByWorkId.get(workId);
  if (!notice) throw new Error(`work-notices.jsonにwork ${workId}がありません`);

  return {
    work: {
      workId,
      title: workEntry.title,
      cardLink: source.cardUrl,
      authorId: AUTHOR_ID,
      batchId: BATCH_ID,
      source: {
        cardUrl: source.cardUrl,
        textUrl: source.sourceUrl,
        attribution: '青空文庫',
        baseEdition: source.bibliography.baseEdition,
        inputter: source.bibliography.inputter,
        proofreader: source.bibliography.proofreader,
        fetchedAt: source.fetchedAt,
        transformation: String(provenanceValue.transformation),
        sourceSha256: source.raw.sha256,
        provenancePath: provenancePublicPath,
        provenanceSha256: sha256(provenanceBytes),
      },
      dialogues,
      completionStatus: notice.completionStatus,
      // work-notices.jsonの実データからそのまま投影する（新規application分岐なし）。
      notices: notice.notices.map((item) => ({ textKey: item.textKey, placements: [...item.placements] })),
    },
    audioAssets,
    candidateTotal: candidatesArtifact.candidates.length,
    publishedTotal: dialogues.length,
    ...computeExclusionCounts(reviews, speechArtifact.speech),
    provenancePublicFile: {
      source: asWorkspacePath(provenanceSourcePath),
      publicPath: asWorkspacePath(provenancePublicPath),
      sha256: asSha256(sha256(provenanceBytes)),
      bytes: provenanceBytes.byteLength,
    },
  };
}

/**
 * v0.8.0固定baselineの既存public file（7作者24作品分）を、統合buildの実tree（bytes/SHA）と
 * exact比較する。content/catalog.jsonとcontent/artwork-provenances.jsonは
 * F009追記により変化するため全体byte比較から除外し、既存分がprefixとして完全
 * 維持され末尾へ夢野久作分3作品が追加されたことを個別にcanonical比較する。
 * `scripts/f008-final-integration.ts`の`assertV070Invariant`と同一構造の複製
 * （最終統合ではaccumulatedWorkCountは常に3固定）。
 * @des DES-F009-002 @fun FUN-F009-002
 */
async function assertV080Invariant(
  build: IntegratedBuild,
  baseline: Awaited<ReturnType<typeof loadPublishedV080Baseline>>,
  workspace: string,
): Promise<void> {
  if (!isMintedPublishedV080Baseline(baseline)) {
    throw new Error('mint済みv0.8.0 baselineが必要です');
  }
  const GROWING_PATHS = new Set(['content/catalog.json', 'content/artwork-provenances.json']);
  const actualByPath = new Map(build.files.map((file) => [file.path, file]));
  for (const expected of baseline.publicFiles) {
    if (GROWING_PATHS.has(expected.path)) continue;
    const actual = actualByPath.get(expected.path as WorkspaceRelativePath);
    if (!actual) throw new Error(`v0.8.0 baseline assetがpreviewにありません: ${expected.path}`);
    const bytes = await readFile(join(build.stagingRoot, ...expected.path.split('/')));
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== actual.sha256) {
      throw new Error(`v0.8.0 baseline assetが変化しています: ${expected.path}`);
    }
  }
  const catalogBytes = await readFile(join(build.stagingRoot, 'content', 'catalog.json'));
  const catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)) as {
    readonly authors: readonly unknown[];
    readonly works: readonly unknown[];
    readonly audioAssets: readonly unknown[];
    readonly batches: readonly unknown[];
  };
  const baselineCatalog = baseline.catalog;
  if (
    catalog.authors.length !== baselineCatalog.authors.length + 1 ||
    canonicalJson(catalog.authors.slice(0, baselineCatalog.authors.length)) !== canonicalJson(baselineCatalog.authors) ||
    catalog.works.length !== baselineCatalog.works.length + F009_WORKS.length ||
    canonicalJson(catalog.works.slice(0, baselineCatalog.works.length)) !== canonicalJson(baselineCatalog.works) ||
    canonicalJson(catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length)) !== canonicalJson(baselineCatalog.audioAssets) ||
    canonicalJson(catalog.batches.slice(0, baselineCatalog.batches.length)) !== canonicalJson(baselineCatalog.batches)
  ) {
    throw new Error('v0.8.0固定7作者24作品projectionが最終Catalogと一致しません');
  }

  const expectedProvenanceFile = baseline.publicFiles.find((file) => file.path === 'content/artwork-provenances.json');
  if (!expectedProvenanceFile) throw new Error('v0.8.0 baselineにcontent/artwork-provenances.jsonがありません');
  const baselineProvenanceBytes = await readFile(join(workspace, 'public', 'content', 'artwork-provenances.json'));
  if (baselineProvenanceBytes.byteLength !== expectedProvenanceFile.bytes) {
    throw new Error('v0.8.0 baselineのcontent/artwork-provenances.json参照元がpinned byte数と一致しません');
  }
  const baselineProvenance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(baselineProvenanceBytes)) as {
    readonly schemaVersion: string;
    readonly artworks: readonly unknown[];
  };
  const actualProvenanceBytes = await readFile(join(build.stagingRoot, 'content', 'artwork-provenances.json'));
  const actualProvenance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(actualProvenanceBytes)) as {
    readonly schemaVersion: string;
    readonly artworks: readonly unknown[];
  };
  if (
    actualProvenance.schemaVersion !== baselineProvenance.schemaVersion ||
    actualProvenance.artworks.length !== baselineProvenance.artworks.length + 1 ||
    canonicalJson(actualProvenance.artworks.slice(0, baselineProvenance.artworks.length)) !==
      canonicalJson(baselineProvenance.artworks)
  ) {
    throw new Error('v0.8.0固定7作者分のartwork-provenances.jsonが最終buildと一致しません');
  }
}

async function main(): Promise<void> {
  const retainCandidate = process.argv[2] === '--retain';
  if (process.argv.length !== (retainCandidate ? 3 : 2)) {
    throw new Error('usage: f009-final-integration.ts [--retain]');
  }
  const workspace = resolve(process.cwd());
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  const sourceCommit = head.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || status.trim() !== '') {
    throw new Error('F009最終統合にはexact clean source commitが必要です');
  }

  const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readCanonicalJson<unknown>(manifestPath));
  if (!checked.ok || checked.value.status !== 'accepted' ||
    checked.value.workProgress.some((work) => work.status !== 'accepted')) {
    throw new Error('F009全3作品がacceptedではありません');
  }
  const manifest = checked.value;

  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F009.ref,
    BATCH_DEFINITION_REFS.F009.sha256,
    APPROVAL_POLICY_REFS.F009.ref,
    APPROVAL_POLICY_REFS.F009.sha256,
  );
  const v080 = await loadPublishedV080Baseline(workspace);
  const registry = defineF009AuthorAndWorkRegistry();
  const verifiedAuthor = verifyF009AuthorIdentity(registry, v080.catalog);

  const snapshot = await rehydrateF009SelectionSnapshot(workspace, context);
  const artworkBytes = await readFile(join(workspace, ...ARTWORK_SOURCE_PATH.split('/')));
  if (sha256(artworkBytes) !== F009_ARTWORK_SHA256) throw new Error('夢野久作作者画像SHAが固定値と一致しません');

  const noticeReport = await loadAndValidateWorkNotices(workspace, AUTHOR_ID);
  const noticesByWorkId = new Map(noticeReport.works.map((work) => [
    work.workId,
    {
      completionStatus: work.completionStatus,
      notices: work.renderedNotices.map((item) => ({ textKey: item.textKey, placements: [...item.placements] })),
    },
  ]));

  const pieces: WorkFragmentPiece[] = [];
  for (const workId of manifest.workIds as readonly F009WorkId[]) {
    pieces.push(await buildWorkFragmentPiece(workspace, workId, snapshot, registry, noticesByWorkId));
  }

  const fragment: F009CatalogFragment = {
    batchId: 'F009',
    feature: 'F009',
    authorId: AUTHOR_ID,
    authorArtwork: {
      path: ARTWORK_PUBLIC_PATH,
      alt: '夢野久作をイメージしたずんだもん',
      sha256: sha256(artworkBytes),
    },
    works: pieces.map((piece) => piece.work) as F009CatalogFragment['works'],
    audioAssets: pieces.flatMap((piece) => piece.audioAssets),
    candidateCounts: {
      total: pieces.reduce((sum, piece) => sum + piece.candidateTotal, 0),
      published: pieces.reduce((sum, piece) => sum + piece.publishedTotal, 0),
      editorialExcluded: pieces.reduce((sum, piece) => sum + piece.editorialExcluded, 0),
      audioExcluded: pieces.reduce((sum, piece) => sum + piece.audioExcluded, 0),
      editorialReasons: pieces.reduce<Record<string, number>>((acc, piece) => {
        for (const [reason, count] of Object.entries(piece.editorialReasons)) acc[reason] = (acc[reason] ?? 0) + count;
        return acc;
      }, {}),
      audioFailureReasons: pieces.reduce<Record<string, number>>((acc, piece) => {
        for (const [reason, count] of Object.entries(piece.audioFailureReasons)) acc[reason] = (acc[reason] ?? 0) + count;
        return acc;
      }, {}),
    },
    acceptedAt: manifest.acceptedAt as string,
    evidenceSha256: hashBatchManifest(manifest),
  };

  for (const asset of fragment.audioAssets) {
    const clash = v080.catalog.audioAssets.find((existing) => existing.audioId === asset.audioId);
    if (clash) {
      console.error('DEBUG clash', JSON.stringify({ added: asset, existing: clash }, null, 2));
    }
  }
  const finalCatalog = mergeNewAuthorCatalog009(v080.catalog, fragment, verifiedAuthor);
  const routeSet = deriveF009RouteSet(finalCatalog, STATIC_ROUTES);
  if (routeSet.routes.length !== 11) throw new Error('F009公開routeがexact 11件ではありません');

  const publicFiles: BatchCatalogFragment['publicFiles'] = [
    {
      source: asWorkspacePath(ARTWORK_SOURCE_PATH),
      publicPath: asWorkspacePath(ARTWORK_PUBLIC_PATH),
      sha256: asSha256(sha256(artworkBytes)),
      bytes: artworkBytes.byteLength,
    },
    ...pieces.map((piece) => piece.provenancePublicFile),
  ];
  const f009Fragment: BatchCatalogFragment = {
    authors: [{
      authorId: verifiedAuthor.authorId,
      name: verifiedAuthor.name,
      originalName: verifiedAuthor.originalName,
      slug: verifiedAuthor.slug,
      artwork: structuredClone(fragment.authorArtwork),
      introducedByBatchId: 'F009' as const,
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: fragment.works.map((work) => structuredClone(work)),
    audioAssets: fragment.audioAssets.map((asset) => structuredClone(asset)),
    candidateCounts: structuredClone(fragment.candidateCounts),
    publicFiles,
  };

  const outputRoot = await mkdtemp(join(workspace, '.cache', 'f009-final-integration-'));
  let retained = false;
  try {
    const preparation = {
      releaseCandidateBatchId: manifest.batchId,
      feature: manifest.feature,
      sourceCommit,
    } as const;
    const [f001, f002, f003, f004, f005, f006, f007, f008, batches] = await Promise.all([
      loadAndVerifyF001Baseline(
        join(workspace, 'public'),
        join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
        join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
      ),
      loadPublishedF002CatalogFragment(workspace, v080.catalog),
      loadAcceptedF003CatalogFragment(workspace),
      loadPublishedF004CatalogFragment(workspace, v080.catalog),
      loadPublishedF005CatalogFragment(workspace, v080.catalog),
      loadPublishedF006CatalogFragment(workspace, v080.catalog),
      loadPublishedF007CatalogFragment(workspace, v080.catalog),
      loadPublishedF008CatalogFragment(workspace, v080.catalog),
      loadAcceptedBatches(workspace, { preparation }),
    ]);
    const f001Bundle: F001BaselineBundle = {
      baselineSha256: f001.baselineSha256,
      catalog: f001.catalog,
      files: f001.files,
      sourceRoot: f001.sourceRoot,
      syntheticBatch: f001.syntheticBatch,
    };
    const publishedCatalogBatches = Object.fromEntries(v080.catalog.batches.map((batch) => [batch.batchId, batch]));

    const contentRoot = join(outputRoot, 'tree');
    const distRoot = join(outputRoot, 'dist');
    await Promise.all([
      mkdir(contentRoot, { recursive: true }),
      mkdir(distRoot, { recursive: true }),
    ]);
    const build = await buildIntegratedPublicTree(
      batches,
      f001Bundle,
      contentRoot,
      {
        mode: 'prepare-release',
        workspaceRoot: workspace,
        batchCatalogs: { F002: f002, F003: f003, F004: f004, F005: f005, F006: f006, F007: f007, F008: f008, F009: f009Fragment },
        publishedCatalogBatches,
      },
      undefined,
      preparation,
    );
    await assertV080Invariant(build, v080, workspace);

    const catalogBytes = await readFile(join(contentRoot, 'content', 'catalog.json'));
    const validation = validateCatalogV2(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)),
      catalogBytes.byteLength,
    );
    if (!validation.ok) throw new Error(`F009最終Catalogが不正です: ${validation.error.code}`);

    const pages = await buildPagesPreview(build, workspace, distRoot, true);

    const report = {
      ok: true,
      sourceCommit,
      outputRoot,
      authors: finalCatalog.authors.length,
      works: finalCatalog.works.length,
      dialogues: finalCatalog.works.reduce((sum, work) => sum + work.dialogues.length, 0),
      audioAssets: finalCatalog.audioAssets.length,
      catalogSha256: sha256(catalogBytes),
      treeFiles: build.files.length,
      contentBuildSha256: build.buildSha256,
      distSha256: pages.distSha256,
      distFileCount: pages.files.length,
      routeSetDigest: routeSet.digest,
      routes: routeSet.routes,
    } as const;
    if (retainCandidate) {
      await writeJsonArtifactAtomic(
        workspace,
        join(workspace, '.cache', 'batch-release', BATCH_ID, 'candidate-paths.json'),
        {
          schemaVersion: '1.0.0',
          batchId: BATCH_ID,
          sourceCommit,
          contentRoot,
          distRoot,
          contentBuildSha256: build.buildSha256,
          distSha256: pages.distSha256,
        },
      );
      retained = true;
    }
    process.stdout.write(canonicalJson(report));
  } finally {
    if (!retained) await rm(outputRoot, { recursive: true, force: true });
  }
}

await main();
