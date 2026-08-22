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
} from '../src/content/f003-catalog.ts';
import { loadPublishedV050Baseline, isMintedPublishedV050Baseline } from '../src/content/f006-baseline.ts';
import { F006_ARTWORK_SHA256 } from '../src/content/f006-catalog.ts';
import {
  buildF006SourceProvenance,
  defineF006AuthorAndWorkRegistry,
  F006_WORKS,
  parseF006SourceRecord,
  rehydrateF006SelectionSnapshot,
  verifyF006AuthorIdentity,
  type F006WorkId,
} from '../src/content/f006-source.ts';
import { resolveVoiceGenerationPaths } from '../src/content/f003-artifact-paths.ts';
import type { VoiceDiffGenerationResult } from '../src/voice/generation.ts';
import type { ReviewRecord } from '../src/content/processing.ts';

/**
 * F006（中島敦3作品追加）work単位のwork-preview content統合script。
 * F003（f003-preview.ts）のsingle-author preview構築パターンを踏襲しつつ、
 * baselineをv0.5.0（F001〜F005公開済み）へ拡張したもの。
 * mergeNewAuthorCatalog006（FUN-F006-011）はF006 3作品全件が揃った最終統合
 * （T-154想定）専用であり、単一work previewでは使わない（fragment.works厳密3件
 * assertionと両立しないため）。ここではF003と同様、BatchCatalogFragmentを
 * 手動構築しbuildIntegratedPublicTreeのwork-previewモードへ渡す。
 *
 * T-152（名人伝）着手時にwork ID固定を解消しCLI引数化した（T-153弟子でも再利用するため）。
 * @des DES-F006-002 DES-F006-010 @fun FUN-F006-002 FUN-F006-011
 */

const BATCH_ID = 'F006';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F006_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F006_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f006-content-preview.ts 000621）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F006WorkId = workIdArgument as F006WorkId;
const AUTHOR_ID = '000119';
const ARTWORK_PUBLIC_PATH = 'artwork/nakajima-zundamon.png';
const ARTWORK_SOURCE_PATH = `content/batches/${BATCH_ID}/public-files/artwork/nakajima-zundamon.png`;

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
 * v0.5.0固定baselineの既存public file 898件を、統合buildの実tree（bytes/SHA）と
 * exact比較する。content/catalog.jsonとcontent/artwork-provenances.jsonは
 * F006追記により変化するため全体byte比較から除外し、既存分がprefixとして完全
 * 維持され末尾へ中島敦分だけが追加されたことを個別にcanonical比較する。
 * @des DES-F006-002 @fun FUN-F006-002
 */
async function assertV050Invariant(
  build: IntegratedBuild,
  baseline: Awaited<ReturnType<typeof loadPublishedV050Baseline>>,
  workspace: string,
  accumulatedWorkCount: number,
): Promise<void> {
  if (!isMintedPublishedV050Baseline(baseline)) {
    throw new Error('mint済みv0.5.0 baselineが必要です');
  }
  const GROWING_PATHS = new Set(['content/catalog.json', 'content/artwork-provenances.json']);
  const actualByPath = new Map(build.files.map((file) => [file.path, file]));
  for (const expected of baseline.publicFiles) {
    if (GROWING_PATHS.has(expected.path)) continue;
    const actual = actualByPath.get(expected.path as WorkspaceRelativePath);
    if (!actual) throw new Error(`v0.5.0 baseline assetがpreviewにありません: ${expected.path}`);
    const bytes = await readFile(join(build.stagingRoot, ...expected.path.split('/')));
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== actualByPath.get(expected.path as WorkspaceRelativePath)?.sha256) {
      throw new Error(`v0.5.0 baseline assetが変化しています: ${expected.path}`);
    }
    void actual;
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
    throw new Error('v0.5.0固定4作者15作品projectionがpreview catalogと一致しません');
  }

  const expectedProvenanceFile = baseline.publicFiles.find((file) => file.path === 'content/artwork-provenances.json');
  if (!expectedProvenanceFile) throw new Error('v0.5.0 baselineにcontent/artwork-provenances.jsonがありません');
  const baselineProvenanceBytes = await readFile(join(workspace, 'public', 'content', 'artwork-provenances.json'));
  if (baselineProvenanceBytes.byteLength !== expectedProvenanceFile.bytes) {
    throw new Error('v0.5.0 baselineのcontent/artwork-provenances.json参照元がpinned byte数と一致しません');
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
    throw new Error('v0.5.0固定4作者分のartwork-provenances.jsonがpreviewと一致しません');
  }
}

interface WorkFragmentPiece {
  readonly work: BatchCatalogFragment['works'][number];
  readonly audioAssets: BatchCatalogFragment['audioAssets'];
  readonly candidateTotal: number;
  readonly publishedTotal: number;
  readonly provenancePublicFile: NonNullable<BatchCatalogFragment['publicFiles']>[number];
  readonly generationAssets: VoiceDiffGenerationResult['assets'];
}

/**
 * work単位のcatalog fragment片（work entry・audioAssets・provenance public file・
 * ステージ対象audio asset一覧）を構築する。manifest累積範囲（先行accepted work分＋
 * 現在work分）を1件ずつこの関数で組み立て、呼び出し側で連結する
 * （src/content/batch-public.tsのbuildIntegratedPublicTreeがactive fragment.works
 * ／catalogBatch.workIdsへ累積work ID全件を要求するため）。
 * @des DES-F006-002 DES-F006-010 @fun FUN-F006-002 FUN-F006-011
 */
async function buildWorkFragmentPiece(
  workspace: string,
  workId: F006WorkId,
  snapshot: Awaited<ReturnType<typeof rehydrateF006SelectionSnapshot>>,
  registry: ReturnType<typeof defineF006AuthorAndWorkRegistry>,
): Promise<WorkFragmentPiece> {
  const workSnapshot = snapshot.works.find((work) => work.workId === workId);
  if (!workSnapshot) throw new Error(`selection snapshotにwork ${workId}がありません`);
  const source = parseF006SourceRecord(workSnapshot, workId);
  const provenanceValue = buildF006SourceProvenance(source, snapshot);
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
  if (dialogues.length !== candidatesArtifact.candidates.length || dialogues.length !== generation.assets.length) {
    throw new Error('dialogue/candidate/audio件数が一致しません');
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
      completionStatus: 'complete',
      // QA-F006 No.4の確定回答による「notices: []」はF006CatalogFragment（batch
      // 単位、mergeNewAuthorCatalog006が扱う付加的data-driven notice集合）の話であり、
      // CatalogV2の各work固定必須notice（dialogue-excerpt-scope）は他featureと同様に
      // 必ず含める（catalog-loader.tsのv2WorkNoticesがdialogue-excerpt-scope欠落を拒否する）。
      notices: [
        { textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] },
      ],
    },
    audioAssets,
    candidateTotal: candidatesArtifact.candidates.length,
    publishedTotal: dialogues.length,
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
  if (!checked.ok) throw new Error(`F006 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workIndex = manifest.workIds.indexOf(WORK_ID as WorkId);
  const workProgress = manifest.workProgress[workIndex];
  if (workProgress?.status !== 'voiced') throw new Error(`previewにはvoiced workが必要です: ${workProgress?.status}`);

  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F006.ref,
    BATCH_DEFINITION_REFS.F006.sha256,
    APPROVAL_POLICY_REFS.F006.ref,
    APPROVAL_POLICY_REFS.F006.sha256,
  );
  const v050 = await loadPublishedV050Baseline(workspace);
  const registry = defineF006AuthorAndWorkRegistry();
  const verifiedAuthor = verifyF006AuthorIdentity(registry, v050.catalog);

  const snapshot = await rehydrateF006SelectionSnapshot(workspace, context);
  const artworkBytes = await readFile(join(workspace, ...ARTWORK_SOURCE_PATH.split('/')));
  if (sha256(artworkBytes) !== F006_ARTWORK_SHA256) throw new Error('中島敦作者画像SHAが固定値と一致しません');

  // buildIntegratedPublicTreeは累積work ID全件（先行accepted work＋現在work）を
  // active fragment.works／catalogBatch.workIdsへ要求するため、manifest.workIds
  // のうち現在workまでの範囲を1件ずつ組み立てて連結する。
  const accumulatedWorkIds = manifest.workIds.slice(0, workIndex + 1) as readonly F006WorkId[];
  const pieces: WorkFragmentPiece[] = [];
  for (const workId of accumulatedWorkIds) {
    pieces.push(await buildWorkFragmentPiece(workspace, workId, snapshot, registry));
  }

  const currentFragment: BatchCatalogFragment = {
    authors: [{
      authorId: verifiedAuthor.authorId,
      name: verifiedAuthor.name,
      originalName: verifiedAuthor.originalName,
      slug: verifiedAuthor.slug,
      artwork: { path: ARTWORK_PUBLIC_PATH, alt: '中島敦をイメージしたずんだもん', sha256: sha256(artworkBytes) },
      introducedByBatchId: BATCH_ID,
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: pieces.map((piece) => piece.work),
    audioAssets: pieces.flatMap((piece) => piece.audioAssets),
    candidateCounts: {
      total: pieces.reduce((sum, piece) => sum + piece.candidateTotal, 0),
      published: pieces.reduce((sum, piece) => sum + piece.publishedTotal, 0),
      editorialExcluded: 0,
      audioExcluded: 0,
      editorialReasons: {},
      audioFailureReasons: {},
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

  const activeStage = join(workspace, '.cache', `.f006-active-${randomUUID()}`);
  const previewStage = join(workspace, '.cache', `.f006-preview-${randomUUID()}`);
  await Promise.all([mkdir(activeStage, { recursive: false }), mkdir(previewStage, { recursive: false })]);
  const stagedFiles: ActiveBatchPreview['stagedFiles'][number][] = [];
  // 先行accepted work分の音声はbuildIntegratedPublicTree自体がmanifestの
  // acceptedAudioSourcesから直接staging済みcontent/batches/F006/accepted-audio/
  // を根拠にcopyする（src/content/batch-public.ts activePriorSources）ため、
  // ここでstageするのは現在work（pieces末尾＝WORK_ID）分の音声だけでよい。
  // 先行分まで二重stageするとexpectedFiles（先行audioAssetsを除外した集合）と
  // 不一致になりPUBLIC_ACCEPTED_AUDIO_HASH_MISMATCHで拒否される。
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

  const [f001, f002, f003, f004, f005, batches] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadPublishedF002CatalogFragment(workspace, v050.catalog),
    loadAcceptedF003CatalogFragment(workspace),
    loadPublishedF004CatalogFragment(workspace, v050.catalog),
    loadPublishedF005CatalogFragment(workspace, v050.catalog),
    loadAcceptedBatches(workspace, { excludeActiveBatchId: BATCH_ID as BatchId }),
  ]);
  const f001Bundle: F001BaselineBundle = {
    baselineSha256: f001.baselineSha256,
    catalog: f001.catalog,
    files: f001.files,
    sourceRoot: f001.sourceRoot,
    syntheticBatch: f001.syntheticBatch,
  };
  const publishedCatalogBatches = Object.fromEntries(v050.catalog.batches.map((batch) => [batch.batchId, batch]));

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
      batchCatalogs: { F002: f002, F003: f003, F004: f004, F005: f005 },
      publishedCatalogBatches,
    },
    active,
  );
  await assertV050Invariant(build, v050, workspace, accumulatedWorkIds.length);

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
