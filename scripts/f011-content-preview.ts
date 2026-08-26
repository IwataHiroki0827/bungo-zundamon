import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

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
  type BatchManifest,
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
import { isMintedPublishedV0100Baseline, loadPublishedV0100Baseline, type PublishedV0100Baseline } from '../src/content/f011-baseline.ts';
import {
  buildF011SourceProvenance,
  defineF011AuthorAndWorkRegistry,
  F011_WORKS,
  parseF011SourceRecord,
  rehydrateF011SelectionSnapshot,
  verifyF011AuthorIdentity,
  type F011WorkId,
} from '../src/content/f011-source.ts';
import { loadF011WorkNotices } from '../src/content/f011-catalog.ts';
import type { WorkNoticePlacement, WorkNoticeTextKey } from '../src/notices/work-notices.ts';
import { resolveVoiceGenerationPaths } from '../src/content/f003-artifact-paths.ts';
import type { VoiceDiffGenerationResult } from '../src/voice/generation.ts';
import type { CatalogV2 } from '../src/content/processing.ts';
import type { ReviewRecord } from '../src/content/processing.ts';

/**
 * F011（新美南吉3作品追加）work単位のwork-preview content統合script。
 * F010の`scripts/f010-content-preview.ts`をF011向けにパラメータ化した複製。baselineを
 * v0.10.0（F001〜F010公開済み、9作者30作品）へ拡張する。
 *
 * v0.9.0と同じくv0.10.0 baseline（`f011-baseline.ts`の`loadPublishedV0100Baseline`）は
 * 固定Git commit（v0.10.0 tag／F010 release）から`public/`配下のtree（path・oid・bytes）を
 * `git ls-tree`で再導出するモデルである。現在の作業treeの`public/`は（F011着手前のため
 * F010 release後の状態を一切変更していない）このrelease commitとbyte単位で完全一致する
 * ことを確認済み（`git diff <releaseCommit> -- public/`が空）であるため、baseline
 * `publicFiles`（path・oid・bytes）が列挙する各pathの実体は、現在の`public/`
 * ディレクトリから直接読み出して比較する（F010までのbaseline読み出しパターンを
 * 踏襲、git blob oidの再計算は行わない）。
 *
 * F011は3作品とも`official-content-warning`が0件のため、`work-notices.ts`の
 * `TRUSTED_REGISTRY_BINDINGS`にentryを追加せず、`f011-catalog.ts`の
 * `loadF011WorkNotices`（`content/batches/F011/work-notices.json`をローカル
 * 静的経路から直接読む軽量関数）を使う。
 *
 * `f003-catalog.ts`（凍結モジュール）はF010向けpublished fragment loaderを
 * 持たないため、F010分のfragment復元だけは本scriptローカルの
 * `loadPublishedF010CatalogFragment`（`loadPublishedF009CatalogFragment`と同型）で
 * 行う（`f003-catalog.ts`は一切変更しない）。
 * @des DES-F011-002 DES-F011-010 @fun FUN-F011-002 FUN-F011-011
 */

const BATCH_ID = 'F011';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F011_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F011_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f011-content-preview.ts 000637）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F011WorkId = workIdArgument as F011WorkId;
const AUTHOR_ID = '000121';
const ARTWORK_PUBLIC_PATH = 'artwork/niimi-nankichi-zundamon.png';
const ARTWORK_SOURCE_PATH = `content/batches/${BATCH_ID}/public-files/artwork/niimi-nankichi-zundamon.png`;
// content/batches/F011/artwork-provenance.jsonのoriginalImageSha256（実測）と一致する固定値。
const ARTWORK_SHA256 = 'c5076c088534c560e063bb1f28243075a066123d8beca4b24eba4df5c8bb526f' as Sha256;

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

/**
 * `f003-catalog.ts`の`loadPublishedF009CatalogFragment`と同型のF010向け複製。
 * `f003-catalog.ts`（凍結モジュール）は変更しないため、F011専用scriptローカルへ
 * 定義する。固定v0.10.0 Catalogと追跡済みF010 manifestから、公開済みF010 fragmentを
 * 復元する。
 * @des DES-F011-002 @fun FUN-F011-002
 */
async function loadPublishedF010CatalogFragment(
  workspace: string,
  catalog: CatalogV2,
): Promise<BatchCatalogFragment> {
  const authors = catalog.authors.filter((item) => item.introducedByBatchId === 'F010');
  const works = catalog.works.filter((item) => item.batchId === 'F010');
  const audioAssets = catalog.audioAssets
    .filter((item) => item.batchId === 'F010')
    .map((item) => ({ ...item }));
  const manifest = await readJson<BatchManifest>(join(workspace, 'content', 'batches', 'F010', 'batch.json'));
  const checked = validateBatchManifest(manifest);
  if (!checked.ok || !['accepted', 'published'].includes(checked.value.status)) {
    throw new Error('F010 published manifestが不正です');
  }
  for (const source of checked.value.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F010 accepted audioのaliasを復元できません: ${audioId}`);
    audioAssets.push({ ...canonical, audioId, path: `audio/F010/${audioId}.wav` });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of [
    ...authors.map((author) => ({
      source: 'content/batches/F010/public-files/artwork/kajii-motojiro-zundamon.png',
      publicPath: author.artwork.path,
    })),
    ...works.map((work) => ({
      source: `content/batches/F010/public-files/provenance/${work.workId}.json`,
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
  const candidateCounts = catalog.candidateCounts.byBatch.F010;
  if (!candidateCounts) throw new Error('固定v0.10.0 CatalogにF010 candidate countsがありません');
  return { authors, works, audioAssets, candidateCounts, publicFiles };
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
 * v0.10.0固定baseline（Git commit由来のpublic tree、9作者30作品分）の既存public fileを、
 * 統合buildの実tree（bytes/SHA）とexact比較する。content/catalog.jsonと
 * content/artwork-provenances.jsonはF011追記により変化するため全体byte比較から
 * 除外し、既存分がprefixとして完全維持され末尾へ新美南吉分だけが追加された
 * ことを個別にcanonical比較する。
 * @des DES-F011-002 @fun FUN-F011-002
 */
async function assertV0100Invariant(
  build: IntegratedBuild,
  baseline: PublishedV0100Baseline,
  workspace: string,
  accumulatedWorkCount: number,
): Promise<void> {
  if (!isMintedPublishedV0100Baseline(baseline)) {
    throw new Error('mint済みv0.10.0 baselineが必要です');
  }
  const GROWING_PATHS = new Set(['content/catalog.json', 'content/artwork-provenances.json']);
  const actualByPath = new Map(build.files.map((file) => [file.path, file]));
  for (const expected of baseline.publicFiles) {
    if (GROWING_PATHS.has(expected.path)) continue;
    const actual = actualByPath.get(expected.path as WorkspaceRelativePath);
    if (!actual) throw new Error(`v0.10.0 baseline assetがpreviewにありません: ${expected.path}`);
    const bytes = await readFile(join(workspace, 'public', ...expected.path.split('/')));
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== actual.sha256) {
      throw new Error(`v0.10.0 baseline assetが変化しています: ${expected.path}`);
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
    throw new Error('v0.10.0固定9作者30作品projectionがpreview catalogと一致しません');
  }

  const expectedProvenanceFile = baseline.publicFiles.find((file) => file.path === 'content/artwork-provenances.json');
  if (!expectedProvenanceFile) throw new Error('v0.10.0 baselineにcontent/artwork-provenances.jsonがありません');
  const baselineProvenanceBytes = await readFile(join(workspace, 'public', 'content', 'artwork-provenances.json'));
  if (baselineProvenanceBytes.byteLength !== expectedProvenanceFile.bytes) {
    throw new Error('v0.10.0 baselineのcontent/artwork-provenances.json参照元がpinned byte数と一致しません');
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
    throw new Error('v0.10.0固定9作者分のartwork-provenances.jsonがpreviewと一致しません');
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
 * 「レビュー承認済みだが音声段階で除外」へ正しく分離する。F009/F010の
 * `computeExclusionCounts`と同一ロジック。
 * @des DES-F011-010 @fun FUN-F011-011
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
 * @des DES-F011-002 DES-F011-010 @fun FUN-F011-002 FUN-F011-011
 */
async function buildWorkFragmentPiece(
  workspace: string,
  workId: F011WorkId,
  snapshot: Awaited<ReturnType<typeof rehydrateF011SelectionSnapshot>>,
  registry: ReturnType<typeof defineF011AuthorAndWorkRegistry>,
  noticesByWorkId: ReadonlyMap<string, { readonly completionStatus: 'complete' | 'unfinished'; readonly notices: readonly { readonly textKey: WorkNoticeTextKey; readonly placements: readonly WorkNoticePlacement[] }[] }>,
  publishedAudioShaSet: ReadonlySet<string>,
): Promise<WorkFragmentPiece> {
  const workSnapshot = snapshot.works.find((work) => work.workId === workId);
  if (!workSnapshot) throw new Error(`selection snapshotにwork ${workId}がありません`);
  const source = parseF011SourceRecord(workSnapshot, workId);
  const provenanceValue = buildF011SourceProvenance(source, snapshot);
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

  // VOICEVOX合成はtext+config決定論のため、既公開batch（F002〜F010、v0.10.0固定
  // baseline）に既に同一WAV（同一sha256）が存在するcandidateが稀に発生しうる
  // （短い相槌等、実データで初めて確認: 000628の1件がF003 000275の音声と完全一致）。
  // その場合、新規audioIdは既公開分と文字列として同一になるため（audioIdはtext+config
  // のcontent-addressableハッシュ、cache.ts createVoiceCacheKey）、自fragmentへ重複
  // entryを追加するとbatch-public.tsのcatalog全体audioId一意性検証
  // （PUBLIC_ID_COLLISION）に抵触する。既公開分と重複するassetはfragment側に含めず
  // （物理audioは既公開batch側から既に配信される）、dialogueのaudioIdはcontent-address
  // 一致により自動的に既公開分と同一文字列を指すため変更不要。
  const externalDuplicateGenerationAssets = generation.assets.filter((asset) => publishedAudioShaSet.has(asset.sha256));
  const publishableGenerationAssets = generation.assets.filter((asset) => !publishedAudioShaSet.has(asset.sha256));
  if (externalDuplicateGenerationAssets.length > 0) {
    process.stderr.write(
      `F011/${workId}: 既公開batchと同一WAVのcandidateを${externalDuplicateGenerationAssets.length}件検出、` +
      `重複entryを追加せず既公開分を再利用します（audioId: ${externalDuplicateGenerationAssets.map((asset) => asset.audioId).join(', ')}）\n`,
    );
  }
  const audioAssets = publishableGenerationAssets.map((asset) => ({
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
        // CatalogSourceV2.proofreaderはstring型。F011のproofreaderは複数名併記対応の
        // 非空tuple（DD-F011.md §0）のため、二ひきの蛙のような複数値は原資料の区切りに
        // 合わせ「、」で連結してcanonical表示文字列へ落とす（手袋を買いに・ごん狐は
        // 単一要素のため連結は無影響）。
        proofreader: source.bibliography.proofreader.join('、'),
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
    // stagingは公開catalogのaudioAssets集合と1:1で一致させる必要があるため、既公開分と
    // 重複するassetはaudioAssets同様ここでも除外する（既公開batch側から既に配信される）。
    generationAssets: publishableGenerationAssets,
  };
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readJson<unknown>(manifestPath));
  if (!checked.ok) throw new Error(`F011 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workIndex = manifest.workIds.indexOf(WORK_ID as WorkId);
  const workProgress = manifest.workProgress[workIndex];
  if (workProgress?.status !== 'voiced') throw new Error(`previewにはvoiced workが必要です: ${workProgress?.status}`);

  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F011.ref,
    BATCH_DEFINITION_REFS.F011.sha256,
    APPROVAL_POLICY_REFS.F011.ref,
    APPROVAL_POLICY_REFS.F011.sha256,
  );
  const v0100 = await loadPublishedV0100Baseline(workspace);
  const registry = defineF011AuthorAndWorkRegistry();
  const verifiedAuthor = verifyF011AuthorIdentity(registry, v0100.catalog);

  const snapshot = await rehydrateF011SelectionSnapshot(workspace, context);
  const artworkBytes = await readFile(join(workspace, ...ARTWORK_SOURCE_PATH.split('/')));
  if (sha256(artworkBytes) !== ARTWORK_SHA256) throw new Error('新美南吉作者画像SHAが固定値と一致しません');

  const noticeReport = await loadF011WorkNotices(workspace);
  const noticesByWorkId = new Map(noticeReport.works.map((work) => [
    work.workId,
    {
      completionStatus: work.completionStatus,
      notices: work.renderedNotices.map((item) => ({ textKey: item.textKey, placements: [...item.placements] })),
    },
  ]));

  // 既公開（v0.10.0固定baseline、F001〜F010）audio sha256集合。VOICEVOX合成は
  // text+config決定論のため、既公開分と完全一致するcandidateのaudioは
  // buildWorkFragmentPiece側で自fragmentへ二重登録しない（PUBLIC_ID_COLLISION回避）。
  // ただし既にacceptedへ到達した先行work（例: 000637）はaudioAssetsのpathが
  // manifest.workProgress[].acceptedAudioSourcesへ`audio/F011/<audioId>.wav`として
  // 固定済みのため、ここで遡って除外するとbatch-public.tsの先行accepted audio突合
  // （PUBLIC_REFERENCE_MISSING）を壊す。除外は現在work（未accepted、これから
  // 新規にfragmentへ加わる分）に限定する。
  const publishedAudioShaSet = new Set(v0100.catalog.audioAssets.map((asset) => asset.sha256));

  const accumulatedWorkIds = manifest.workIds.slice(0, workIndex + 1) as readonly F011WorkId[];
  const pieces: WorkFragmentPiece[] = [];
  for (const workId of accumulatedWorkIds) {
    const shaSetForWork = workId === WORK_ID ? publishedAudioShaSet : new Set<string>();
    pieces.push(await buildWorkFragmentPiece(workspace, workId, snapshot, registry, noticesByWorkId, shaSetForWork));
  }

  const currentFragment: BatchCatalogFragment = {
    authors: [{
      authorId: verifiedAuthor.authorId,
      name: verifiedAuthor.name,
      originalName: verifiedAuthor.originalName,
      slug: verifiedAuthor.slug,
      artwork: { path: ARTWORK_PUBLIC_PATH, alt: '新美南吉をイメージしたずんだもん', sha256: sha256(artworkBytes) },
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

  const activeStage = join(workspace, '.cache', `.f011-active-${randomUUID()}`);
  const previewStage = join(workspace, '.cache', `.f011-preview-${randomUUID()}`);
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

  const [f001, f002, f003, f004, f005, f006, f007, f008, f009, f010, batches] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadPublishedF002CatalogFragment(workspace, v0100.catalog),
    loadAcceptedF003CatalogFragment(workspace),
    loadPublishedF004CatalogFragment(workspace, v0100.catalog),
    loadPublishedF005CatalogFragment(workspace, v0100.catalog),
    loadPublishedF006CatalogFragment(workspace, v0100.catalog),
    loadPublishedF007CatalogFragment(workspace, v0100.catalog),
    loadPublishedF008CatalogFragment(workspace, v0100.catalog),
    loadPublishedF009CatalogFragment(workspace, v0100.catalog),
    loadPublishedF010CatalogFragment(workspace, v0100.catalog),
    loadAcceptedBatches(workspace, { excludeActiveBatchId: BATCH_ID as BatchId }),
  ]);
  const f001Bundle: F001BaselineBundle = {
    baselineSha256: f001.baselineSha256,
    catalog: f001.catalog,
    files: f001.files,
    sourceRoot: f001.sourceRoot,
    syntheticBatch: f001.syntheticBatch,
  };
  const publishedCatalogBatches = Object.fromEntries(v0100.catalog.batches.map((batch) => [batch.batchId, batch]));

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
      batchCatalogs: { F002: f002, F003: f003, F004: f004, F005: f005, F006: f006, F007: f007, F008: f008, F009: f009, F010: f010 },
      publishedCatalogBatches,
    },
    active,
  );
  await assertV0100Invariant(build, v0100, workspace, accumulatedWorkIds.length);

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
