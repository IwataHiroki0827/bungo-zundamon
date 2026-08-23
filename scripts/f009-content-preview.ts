import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline } from '../src/content/baseline.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import {
  buildIntegratedPublicTree,
  type ActiveBatchPreview,
  type BatchCatalogFragment,
  type F001BaselineBundle,
  type IntegratedBuild,
} from '../src/content/batch-public.ts';
import {
  hashBatchManifest,
  loadAcceptedBatches,
  validateBatchManifest,
  type BatchId,
  type Sha256,
  type WorkId,
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
import { isMintedPublishedV080Baseline, loadPublishedV080Baseline, type PublishedV080Baseline } from '../src/content/f009-baseline.ts';
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
import type { VoiceDiffGenerationResult } from '../src/voice/generation.ts';
import type { ReviewRecord } from '../src/content/processing.ts';

/**
 * F009（夢野久作3作品追加）work単位のwork-preview content統合script。
 * F008の`scripts/f008-content-preview.ts`をF009向けにパラメータ化した複製。baselineを
 * v0.8.0（F001〜F008公開済み、7作者24作品）へ拡張する。
 *
 * v0.7.0までのbaselineがJSON snapshot（`content/baselines/F00N-vX.Y.Z.json`＋
 * `public/`実体の直接byte比較）だったのに対し、v0.8.0 baseline（`f009-baseline.ts`の
 * `loadPublishedV080Baseline`）は固定Git commit（v0.8.0 tag／F008 release）から
 * `public/`配下のtree（path・oid・bytes）を`git ls-tree`で再導出するモデルへ変更
 * されている。現在の作業treeの`public/`は（F009着手前のためF008 release後の状態を
 * 一切変更していない）このrelease commitとbyte単位で完全一致することを確認済み
 * （`git diff <releaseCommit> -- public/`が空）であるため、baseline
 * `publicFiles`（path・oid・bytes）が列挙する各pathの実体は、現在の`public/`
 * ディレクトリから直接読み出して比較する（F008までのbaseline読み出しパターンを
 * 踏襲、git blob oidの再計算は行わない）。
 * @des DES-F009-002 DES-F009-010 @fun FUN-F009-002 FUN-F009-011
 */

const BATCH_ID = 'F009';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F009_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F009_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f009-content-preview.ts 002381）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F009WorkId = workIdArgument as F009WorkId;
const AUTHOR_ID = '000096';
const ARTWORK_PUBLIC_PATH = 'artwork/yumeno-kyusaku-zundamon.png';
const ARTWORK_SOURCE_PATH = `content/batches/${BATCH_ID}/public-files/artwork/yumeno-kyusaku-zundamon.png`;
// content/batches/F009/artwork-provenance.jsonのoriginalImageSha256（実測）と一致する固定値。
const ARTWORK_SHA256 = '25c47c982523cd03b25596a02ad17b5b071389a4ce7e2b1b76a95ffb04851d83' as Sha256;

function sha256(value: Uint8Array | string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
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

/**
 * v0.8.0固定baseline（Git commit由来のpublic tree、7作者24作品分）の既存public fileを、
 * 統合buildの実tree（bytes/SHA）とexact比較する。content/catalog.jsonと
 * content/artwork-provenances.jsonはF009追記により変化するため全体byte比較から
 * 除外し、既存分がprefixとして完全維持され末尾へ夢野久作分だけが追加された
 * ことを個別にcanonical比較する。
 * @des DES-F009-002 @fun FUN-F009-002
 */
async function assertV080Invariant(
  build: IntegratedBuild,
  baseline: PublishedV080Baseline,
  workspace: string,
  accumulatedWorkCount: number,
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
    const bytes = await readFile(join(workspace, 'public', ...expected.path.split('/')));
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
    catalog.works.length !== baselineCatalog.works.length + accumulatedWorkCount ||
    canonicalJson(catalog.works.slice(0, baselineCatalog.works.length)) !== canonicalJson(baselineCatalog.works) ||
    canonicalJson(catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length)) !== canonicalJson(baselineCatalog.audioAssets) ||
    canonicalJson(catalog.batches.slice(0, baselineCatalog.batches.length)) !== canonicalJson(baselineCatalog.batches)
  ) {
    throw new Error('v0.8.0固定7作者24作品projectionがpreview catalogと一致しません');
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
    throw new Error('v0.8.0固定7作者分のartwork-provenances.jsonがpreviewと一致しません');
  }
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
  readonly generationAssets: VoiceDiffGenerationResult['assets'];
}

/**
 * 候補の除外理由を「編集レビューで却下(reviews[].status!=='approved')」と
 * 「レビュー承認済みだが音声段階で除外」へ正しく分離する。F008の
 * `computeExclusionCounts`と同一ロジック。瓶詰地獄は4候補全件approvedのため
 * 本関数は0/0を返す想定だが、他2作品（きのこ会議・死後の恋）のための
 * 汎用ロジックとして維持する。
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
 * work単位のcatalog fragment片を構築する。manifest累積範囲（先行accepted work分＋
 * 現在work分）を1件ずつこの関数で組み立て、呼び出し側で連結する。
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
    readJson<{ readonly candidates: readonly CandidateRecord[] }>(
      join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId, 'candidates.json'),
    ),
    readJson<{ readonly speech: readonly SpeechRecord[] }>(
      join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId, 'speech-revisions.json'),
    ),
    readJson<readonly ReviewRecord[]>(join(workspace, 'content', 'batches', BATCH_ID, 'reviews', `${workId}.json`)),
    readJson<VoiceDiffGenerationResult>(
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
  const totalCandidateIdsInAssets = generation.assets.reduce((sum, asset) => sum + asset.candidateIds.length, 0);
  const referencedAudioIds = new Set(dialogues.map((item) => item.audioId));
  const assetAudioIds = new Set(generation.assets.map((asset) => asset.audioId));
  if (
    dialogues.length !== speechArtifact.speech.length ||
    dialogues.length !== totalCandidateIdsInAssets ||
    referencedAudioIds.size !== assetAudioIds.size ||
    ![...referencedAudioIds].every((audioId) => assetAudioIds.has(audioId))
  ) {
    throw new Error('dialogue/speech/audio件数が一致しません');
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
    generationAssets: generation.assets,
  };
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readJson<unknown>(manifestPath));
  if (!checked.ok) throw new Error(`F009 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workIndex = manifest.workIds.indexOf(WORK_ID as WorkId);
  const workProgress = manifest.workProgress[workIndex];
  if (workProgress?.status !== 'voiced') throw new Error(`previewにはvoiced workが必要です: ${workProgress?.status}`);

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
  if (sha256(artworkBytes) !== ARTWORK_SHA256) throw new Error('夢野久作作者画像SHAが固定値と一致しません');

  const noticeReport = await loadAndValidateWorkNotices(workspace, AUTHOR_ID);
  const noticesByWorkId = new Map(noticeReport.works.map((work) => [
    work.workId,
    {
      completionStatus: work.completionStatus,
      notices: work.renderedNotices.map((item) => ({ textKey: item.textKey, placements: [...item.placements] })),
    },
  ]));

  const accumulatedWorkIds = manifest.workIds.slice(0, workIndex + 1) as readonly F009WorkId[];
  const pieces: WorkFragmentPiece[] = [];
  for (const workId of accumulatedWorkIds) {
    pieces.push(await buildWorkFragmentPiece(workspace, workId, snapshot, registry, noticesByWorkId));
  }

  const currentFragment: BatchCatalogFragment = {
    authors: [{
      authorId: verifiedAuthor.authorId,
      name: verifiedAuthor.name,
      originalName: verifiedAuthor.originalName,
      slug: verifiedAuthor.slug,
      artwork: { path: ARTWORK_PUBLIC_PATH, alt: '夢野久作をイメージしたずんだもん', sha256: sha256(artworkBytes) },
      introducedByBatchId: BATCH_ID,
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: pieces.map((piece) => piece.work),
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
    publicFiles: [
      {
        source: asWorkspacePath(ARTWORK_SOURCE_PATH),
        publicPath: asWorkspacePath(ARTWORK_PUBLIC_PATH),
        sha256: asSha256(sha256(artworkBytes)),
        bytes: artworkBytes.byteLength,
      },
      ...pieces.map((piece) => piece.provenancePublicFile),
    ],
  };

  const activeStage = join(workspace, '.cache', `.f009-active-${randomUUID()}`);
  const previewStage = join(workspace, '.cache', `.f009-preview-${randomUUID()}`);
  await Promise.all([mkdir(activeStage, { recursive: false }), mkdir(previewStage, { recursive: false })]);
  const stagedFiles: ActiveBatchPreview['stagedFiles'][number][] = [];
  const activePiece = pieces.at(-1);
  if (!activePiece || activePiece.work.workId !== WORK_ID) throw new Error('累積piecesの末尾が現在workと一致しません');
  for (const asset of activePiece.generationAssets) {
    const target = join(activeStage, 'audio', `${asset.audioId}.wav`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(asset.sourcePath, target);
    stagedFiles.push({
      source: target,
      publicPath: asWorkspacePath(`audio/${BATCH_ID}/${asset.audioId}.wav`),
      sha256: asSha256(asset.sha256),
      bytes: asset.bytes,
    });
  }
  for (const item of currentFragment.publicFiles ?? []) {
    const target = join(activeStage, ...item.publicPath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(workspace, ...item.source.split('/')), target);
    stagedFiles.push({ ...item, source: target });
  }

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
    loadAcceptedBatches(workspace, { excludeActiveBatchId: BATCH_ID as BatchId }),
  ]);
  const f001Bundle: F001BaselineBundle = {
    baselineSha256: f001.baselineSha256,
    catalog: f001.catalog,
    files: f001.files,
    sourceRoot: f001.sourceRoot,
    syntheticBatch: f001.syntheticBatch,
  };
  const publishedCatalogBatches = Object.fromEntries(v080.catalog.batches.map((batch) => [batch.batchId, batch]));

  const active: ActiveBatchPreview = {
    manifest,
    workId: WORK_ID,
    catalogFragment: currentFragment,
    catalogBatch: {
      batchId: BATCH_ID,
      feature: BATCH_ID,
      status: 'accepted',
      authorId: AUTHOR_ID,
      workIds: [...accumulatedWorkIds],
      acceptedAt: workProgress.stageRecords.findLast((item) => item.stage === 'voiced')!.completedAt,
      evidenceSha256: hashBatchManifest(manifest),
    },
    stagingRoot: activeStage,
    stagedFiles,
  };
  const build = await buildIntegratedPublicTree(
    batches,
    f001Bundle,
    previewStage,
    {
      mode: 'work-preview',
      workspaceRoot: workspace,
      batchCatalogs: { F002: f002, F003: f003, F004: f004, F005: f005, F006: f006, F007: f007, F008: f008 },
      publishedCatalogBatches,
    },
    active,
  );
  await assertV080Invariant(build, v080, workspace, accumulatedWorkIds.length);

  await writeJsonArtifactAtomic(
    workspace,
    join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'content-preview.json'),
    build,
  );
  process.stdout.write(
    `work-preview: ${build.files.length} files, build=${build.buildSha256}\n`,
  );
}

await main();
