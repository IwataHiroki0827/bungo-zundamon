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
  loadPublishedF009CatalogFragment,
} from '../src/content/f003-catalog.ts';
import { isMintedPublishedV090Baseline, loadPublishedV090Baseline, type PublishedV090Baseline } from '../src/content/f010-baseline.ts';
import {
  buildF010SourceProvenance,
  defineF010AuthorAndWorkRegistry,
  F010_WORKS,
  parseF010SourceRecord,
  rehydrateF010SelectionSnapshot,
  verifyF010AuthorIdentity,
  type F010WorkId,
} from '../src/content/f010-source.ts';
import { loadF010WorkNotices } from '../src/content/f010-catalog.ts';
import type { WorkNoticePlacement, WorkNoticeTextKey } from '../src/notices/work-notices.ts';
import { resolveVoiceGenerationPaths } from '../src/content/f003-artifact-paths.ts';
import type { VoiceDiffGenerationResult } from '../src/voice/generation.ts';
import type { ReviewRecord } from '../src/content/processing.ts';

/**
 * F010（梶井基次郎3作品追加）work単位のwork-preview content統合script。
 * F009の`scripts/f009-content-preview.ts`をF010向けにパラメータ化した複製。baselineを
 * v0.9.0（F001〜F009公開済み、8作者27作品）へ拡張する。
 *
 * v0.8.0と同じくv0.9.0 baseline（`f010-baseline.ts`の`loadPublishedV090Baseline`）は
 * 固定Git commit（v0.9.0 tag／F009 release）から`public/`配下のtree（path・oid・bytes）を
 * `git ls-tree`で再導出するモデルである。現在の作業treeの`public/`は（F010着手前のため
 * F009 release後の状態を一切変更していない）このrelease commitとbyte単位で完全一致する
 * ことを確認済み（`git diff <releaseCommit> -- public/`が空）であるため、baseline
 * `publicFiles`（path・oid・bytes）が列挙する各pathの実体は、現在の`public/`
 * ディレクトリから直接読み出して比較する（F009までのbaseline読み出しパターンを
 * 踏襲、git blob oidの再計算は行わない）。
 *
 * F010は3作品とも`official-content-warning`が0件のため、`work-notices.ts`の
 * `TRUSTED_REGISTRY_BINDINGS`にentryを追加せず、`f010-catalog.ts`の
 * `loadF010WorkNotices`（`content/batches/F010/work-notices.json`をローカル
 * 静的経路から直接読む軽量関数）を使う。
 * @des DES-F010-002 DES-F010-010 @fun FUN-F010-002 FUN-F010-011
 */

const BATCH_ID = 'F010';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F010_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F010_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f010-content-preview.ts 000424）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F010WorkId = workIdArgument as F010WorkId;
const AUTHOR_ID = '000074';
const ARTWORK_PUBLIC_PATH = 'artwork/kajii-motojiro-zundamon.png';
const ARTWORK_SOURCE_PATH = `content/batches/${BATCH_ID}/public-files/artwork/kajii-motojiro-zundamon.png`;
// content/batches/F010/artwork-provenance.jsonのoriginalImageSha256（実測）と一致する固定値。
const ARTWORK_SHA256 = '6349575c681aac06f7a946fe4974e32dd2a9b9e15db43d7348a1b270698e94df' as Sha256;

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
 * v0.9.0固定baseline（Git commit由来のpublic tree、8作者27作品分）の既存public fileを、
 * 統合buildの実tree（bytes/SHA）とexact比較する。content/catalog.jsonと
 * content/artwork-provenances.jsonはF010追記により変化するため全体byte比較から
 * 除外し、既存分がprefixとして完全維持され末尾へ梶井基次郎分だけが追加された
 * ことを個別にcanonical比較する。
 * @des DES-F010-002 @fun FUN-F010-002
 */
async function assertV090Invariant(
  build: IntegratedBuild,
  baseline: PublishedV090Baseline,
  workspace: string,
  accumulatedWorkCount: number,
): Promise<void> {
  if (!isMintedPublishedV090Baseline(baseline)) {
    throw new Error('mint済みv0.9.0 baselineが必要です');
  }
  const GROWING_PATHS = new Set(['content/catalog.json', 'content/artwork-provenances.json']);
  const actualByPath = new Map(build.files.map((file) => [file.path, file]));
  for (const expected of baseline.publicFiles) {
    if (GROWING_PATHS.has(expected.path)) continue;
    const actual = actualByPath.get(expected.path as WorkspaceRelativePath);
    if (!actual) throw new Error(`v0.9.0 baseline assetがpreviewにありません: ${expected.path}`);
    const bytes = await readFile(join(workspace, 'public', ...expected.path.split('/')));
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== actual.sha256) {
      throw new Error(`v0.9.0 baseline assetが変化しています: ${expected.path}`);
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
    throw new Error('v0.9.0固定8作者27作品projectionがpreview catalogと一致しません');
  }

  const expectedProvenanceFile = baseline.publicFiles.find((file) => file.path === 'content/artwork-provenances.json');
  if (!expectedProvenanceFile) throw new Error('v0.9.0 baselineにcontent/artwork-provenances.jsonがありません');
  const baselineProvenanceBytes = await readFile(join(workspace, 'public', 'content', 'artwork-provenances.json'));
  if (baselineProvenanceBytes.byteLength !== expectedProvenanceFile.bytes) {
    throw new Error('v0.9.0 baselineのcontent/artwork-provenances.json参照元がpinned byte数と一致しません');
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
    throw new Error('v0.9.0固定8作者分のartwork-provenances.jsonがpreviewと一致しません');
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
 * 「レビュー承認済みだが音声段階で除外」へ正しく分離する。F009の
 * `computeExclusionCounts`と同一ロジック。檸檬は8候補中5件approved・3件
 * rejected(いずれも編集レビュー段階でのNON_SPEECH却下、音声段階除外は0件)の
 * ため本関数は`{editorialExcluded:3, audioExcluded:0, ...}`を返す想定だが、
 * 他2作品（Ｋの昇天・愛撫）のための汎用ロジックとして維持する。
 * @des DES-F010-010 @fun FUN-F010-011
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
 * @des DES-F010-002 DES-F010-010 @fun FUN-F010-002 FUN-F010-011
 */
async function buildWorkFragmentPiece(
  workspace: string,
  workId: F010WorkId,
  snapshot: Awaited<ReturnType<typeof rehydrateF010SelectionSnapshot>>,
  registry: ReturnType<typeof defineF010AuthorAndWorkRegistry>,
  noticesByWorkId: ReadonlyMap<string, { readonly completionStatus: 'complete' | 'unfinished'; readonly notices: readonly { readonly textKey: WorkNoticeTextKey; readonly placements: readonly WorkNoticePlacement[] }[] }>,
): Promise<WorkFragmentPiece> {
  const workSnapshot = snapshot.works.find((work) => work.workId === workId);
  if (!workSnapshot) throw new Error(`selection snapshotにwork ${workId}がありません`);
  const source = parseF010SourceRecord(workSnapshot, workId);
  const provenanceValue = buildF010SourceProvenance(source, snapshot);
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
  if (!checked.ok) throw new Error(`F010 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workIndex = manifest.workIds.indexOf(WORK_ID as WorkId);
  const workProgress = manifest.workProgress[workIndex];
  if (workProgress?.status !== 'voiced') throw new Error(`previewにはvoiced workが必要です: ${workProgress?.status}`);

  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F010.ref,
    BATCH_DEFINITION_REFS.F010.sha256,
    APPROVAL_POLICY_REFS.F010.ref,
    APPROVAL_POLICY_REFS.F010.sha256,
  );
  const v090 = await loadPublishedV090Baseline(workspace);
  const registry = defineF010AuthorAndWorkRegistry();
  const verifiedAuthor = verifyF010AuthorIdentity(registry, v090.catalog);

  const snapshot = await rehydrateF010SelectionSnapshot(workspace, context);
  const artworkBytes = await readFile(join(workspace, ...ARTWORK_SOURCE_PATH.split('/')));
  if (sha256(artworkBytes) !== ARTWORK_SHA256) throw new Error('梶井基次郎作者画像SHAが固定値と一致しません');

  const noticeReport = await loadF010WorkNotices(workspace);
  const noticesByWorkId = new Map(noticeReport.works.map((work) => [
    work.workId,
    {
      completionStatus: work.completionStatus,
      notices: work.renderedNotices.map((item) => ({ textKey: item.textKey, placements: [...item.placements] })),
    },
  ]));

  const accumulatedWorkIds = manifest.workIds.slice(0, workIndex + 1) as readonly F010WorkId[];
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
      artwork: { path: ARTWORK_PUBLIC_PATH, alt: '梶井基次郎をイメージしたずんだもん', sha256: sha256(artworkBytes) },
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

  const activeStage = join(workspace, '.cache', `.f010-active-${randomUUID()}`);
  const previewStage = join(workspace, '.cache', `.f010-preview-${randomUUID()}`);
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

  const [f001, f002, f003, f004, f005, f006, f007, f008, f009, batches] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadPublishedF002CatalogFragment(workspace, v090.catalog),
    loadAcceptedF003CatalogFragment(workspace),
    loadPublishedF004CatalogFragment(workspace, v090.catalog),
    loadPublishedF005CatalogFragment(workspace, v090.catalog),
    loadPublishedF006CatalogFragment(workspace, v090.catalog),
    loadPublishedF007CatalogFragment(workspace, v090.catalog),
    loadPublishedF008CatalogFragment(workspace, v090.catalog),
    loadPublishedF009CatalogFragment(workspace, v090.catalog),
    loadAcceptedBatches(workspace, { excludeActiveBatchId: BATCH_ID as BatchId }),
  ]);
  const f001Bundle: F001BaselineBundle = {
    baselineSha256: f001.baselineSha256,
    catalog: f001.catalog,
    files: f001.files,
    sourceRoot: f001.sourceRoot,
    syntheticBatch: f001.syntheticBatch,
  };
  const publishedCatalogBatches = Object.fromEntries(v090.catalog.batches.map((batch) => [batch.batchId, batch]));

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
      batchCatalogs: { F002: f002, F003: f003, F004: f004, F005: f005, F006: f006, F007: f007, F008: f008, F009: f009 },
      publishedCatalogBatches,
    },
    active,
  );
  await assertV090Invariant(build, v090, workspace, accumulatedWorkIds.length);

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
