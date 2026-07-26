import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline } from '../src/content/baseline.ts';
import {
  F002_PUBLISHED_RELEASE,
  loadAndVerifyPublishedBaseline,
  verifyPublishedInvariant,
} from '../src/content/published-baseline.ts';
import {
  hashBatchManifest,
  loadAcceptedBatches,
  validateBatchManifest,
  type Sha256,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  buildIntegratedPublicTree,
  type ActiveBatchPreview,
  type BatchCatalogFragment,
} from '../src/content/batch-public.ts';
import {
  applyWorkReviews,
  type Candidate,
  type CatalogV2,
  type ReviewRecord,
  type WorkReviewResult,
} from '../src/content/processing.ts';

const BATCH_ID = 'F003';
const WORK_IDS = ['000275', '001567', '000258'] as const;
const workFlag = process.argv.indexOf('--work');
const workArgument = workFlag >= 0 ? process.argv[workFlag + 1] : process.argv[2];
if (!workArgument || !WORK_IDS.includes(workArgument as (typeof WORK_IDS)[number])) {
  throw new Error(`usage: node --experimental-transform-types scripts/f003-preview.ts --work ${WORK_IDS.join('|')}`);
}
const WORK_ID = workArgument;

interface VoiceGenerationArtifact {
  readonly generation: {
    readonly schemaVersion: '2';
    readonly batchId: string;
    readonly workId: string;
    readonly configHash: string;
    readonly generationDigest: string;
    readonly assets: readonly {
      readonly audioId: string;
      readonly candidateIds: readonly string[];
      readonly sourcePath: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly durationMs: number;
      readonly configHash: string;
    }[];
  };
}

interface PreviousWorkPreview {
  readonly work: BatchCatalogFragment['works'][number];
  readonly audioAssets: BatchCatalogFragment['audioAssets'];
  readonly candidateCounts: BatchCatalogFragment['candidateCounts'];
  readonly publicFile: NonNullable<BatchCatalogFragment['publicFiles']>[number];
  readonly stagedFiles: readonly ActiveBatchPreview['stagedFiles'][number][];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha256(value: string): Sha256 {
  return value as Sha256;
}

function asWorkspacePath(value: string): WorkspaceRelativePath {
  return value as WorkspaceRelativePath;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeCanonicalAtomic(path: string, value: unknown): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  await mkdir(dirname(path), { recursive: true });
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return bytes;
    throw new Error(`既存artifactが現在のtupleと異なります: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return bytes;
}

async function f002Fragment(workspace: string, catalog: CatalogV2): Promise<BatchCatalogFragment> {
  const author = catalog.authors.filter((item) => item.introducedByBatchId === 'F002');
  const works = catalog.works.filter((item) => item.batchId === 'F002');
  const audioAssets = catalog.audioAssets.filter((item) => item.batchId === 'F002').map((item) => ({ ...item }));
  const f002Manifest = await readJson<{
    readonly workProgress: readonly {
      readonly acceptedAudioSources?: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly configHash: string;
      }[];
    }[];
  }>(join(workspace, 'content', 'batches', 'F002', 'batch.json'));
  for (const source of f002Manifest.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F002 accepted audioのcatalog aliasを復元できません: ${audioId}`);
    audioAssets.push({
      ...canonical,
      audioId,
      path: `audio/F002/${audioId}.wav`,
    });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of [
    ...author.map((value) => ({
      source: 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png',
      publicPath: value.artwork.path,
    })),
    ...works.map((value) => ({
      source: `content/batches/F002/public-files/provenance/${value.workId}.json`,
      publicPath: value.source.provenancePath,
    })),
  ]) {
    const bytes = await readFile(join(workspace, ...item.source.split('/')));
    publicFiles.push({
      source: asWorkspacePath(item.source),
      publicPath: asWorkspacePath(item.publicPath),
      sha256: asSha256(sha256(bytes)),
      bytes: bytes.byteLength,
    });
  }
  const counts = catalog.candidateCounts.byBatch.F002;
  if (!counts) throw new Error('公開catalogにF002 candidate countsがありません');
  return { authors: author, works, audioAssets, candidateCounts: counts, publicFiles };
}

async function previousWorkPreview(
  workspace: string,
  workId: string,
  rights: {
    readonly selection: { readonly works: readonly {
      readonly workId: string;
      readonly title: string;
      readonly cardUrl: string;
      readonly sourceUrl: string;
      readonly baseEdition: string;
      readonly inputter: string;
      readonly proofreader: string;
    }[] };
  },
): Promise<PreviousWorkPreview> {
  const [candidates, reviewRecords, generationArtifact, provenanceBytes] = await Promise.all([
    readJson<Candidate[]>(join(
      workspace, 'data', 'batches', BATCH_ID, 'work-artifacts', workId, 'intermediate', workId, 'candidates.json',
    )),
    readJson<ReviewRecord[]>(join(workspace, 'content', 'batches', BATCH_ID, 'reviews', `${workId}.json`)),
    readJson<{ readonly payload: { readonly generation: VoiceGenerationArtifact['generation'] } }>(join(
      workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId, 'voice-completeness.json',
    )),
    readFile(join(workspace, 'content', 'batches', BATCH_ID, 'public-files', 'provenance', `${workId}.json`)),
  ]);
  const selected = rights.selection.works.find((item) => item.workId === workId);
  if (!selected) throw new Error(`rights selectionに先行作品がありません: ${workId}`);
  const review = applyWorkReviews(workId, candidates, reviewRecords);
  const generation = generationArtifact.payload.generation;
  if (generation.batchId !== BATCH_ID || generation.workId !== workId) {
    throw new Error(`先行作品のgeneration tupleが不正です: ${workId}`);
  }
  const provenance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(provenanceBytes)) as {
    readonly processing: { readonly transformation: string };
    readonly source: { readonly fetchedAt: string; readonly rawSha256: string };
  };
  const candidateAudio = new Map<string, string>();
  for (const asset of generation.assets) {
    for (const candidateId of asset.candidateIds) candidateAudio.set(candidateId, asset.audioId);
  }
  const reviews = new Map(review.all.map((item) => [item.candidate.candidateId, item.review]));
  const dialogues = review.approved.map(({ candidate }, order) => {
    const audioId = candidateAudio.get(candidate.candidateId);
    const editorial = reviews.get(candidate.candidateId);
    if (!audioId || !editorial) throw new Error(`先行作品のaudio/review対応がありません: ${workId}/${candidate.candidateId}`);
    return {
      dialogueId: candidate.candidateId,
      workId,
      order,
      displayText: candidate.displayText,
      speechText: candidate.speechText,
      audioId,
      sourceAnchor: candidate.sourceAnchor,
      review: editorial,
    };
  });
  const reasonCounts = Object.fromEntries(
    [...new Set(review.rejected.map((item) => item.review.reasonCode))]
      .map((reason) => [reason, review.rejected.filter((item) => item.review.reasonCode === reason).length]),
  );
  const provenancePath = `content/provenance/${BATCH_ID}/${workId}.json`;
  const publicFile = {
    source: asWorkspacePath(`content/batches/${BATCH_ID}/public-files/provenance/${workId}.json`),
    publicPath: asWorkspacePath(provenancePath),
    sha256: asSha256(sha256(provenanceBytes)),
    bytes: provenanceBytes.byteLength,
  };
  const stagedFiles: ActiveBatchPreview['stagedFiles'][number][] = [];
  stagedFiles.push({
    source: join(workspace, ...publicFile.source.split('/')),
    publicPath: publicFile.publicPath,
    sha256: publicFile.sha256,
    bytes: publicFile.bytes,
  });
  return {
    work: {
      workId,
      title: selected.title,
      cardLink: selected.cardUrl,
      authorId: '000035',
      batchId: BATCH_ID,
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
      completionStatus: 'complete',
      notices: [
        { textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] },
        { textKey: 'official-content-warning', placements: ['work-list', 'work-detail', 'credits'] },
      ],
    },
    audioAssets: generation.assets.map((asset) => ({
      audioId: asset.audioId,
      batchId: BATCH_ID,
      path: `audio/${BATCH_ID}/${asset.audioId}.wav`,
      sha256: asset.sha256,
      bytes: asset.bytes,
      durationMs: asset.durationMs,
      configHash: asset.configHash,
      candidateIds: [...asset.candidateIds],
    })),
    candidateCounts: {
      total: review.all.length,
      published: review.approved.length,
      editorialExcluded: review.rejected.length,
      audioExcluded: 0,
      editorialReasons: reasonCounts,
      audioFailureReasons: {},
    },
    publicFile,
    stagedFiles,
  };
}

function sumCounts(
  counts: readonly BatchCatalogFragment['candidateCounts'][],
): BatchCatalogFragment['candidateCounts'] {
  const sumRecord = (field: 'editorialReasons' | 'audioFailureReasons'): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const count of counts) {
      for (const [reason, value] of Object.entries(count[field] ?? {})) {
        result[reason] = (result[reason] ?? 0) + value;
      }
    }
    return result;
  };
  return {
    total: counts.reduce((sum, item) => sum + item.total, 0),
    published: counts.reduce((sum, item) => sum + item.published, 0),
    editorialExcluded: counts.reduce((sum, item) => sum + item.editorialExcluded, 0),
    audioExcluded: counts.reduce((sum, item) => sum + item.audioExcluded, 0),
    editorialReasons: sumRecord('editorialReasons'),
    audioFailureReasons: sumRecord('audioFailureReasons'),
  };
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
      current.sha256 !== asset.sha256 || current.bytes !== asset.bytes ||
      current.configHash !== asset.configHash || current.durationMs !== asset.durationMs ||
      current.path !== asset.path
    ) {
      throw new Error(`同一audioIdのmetadataが競合しています: ${asset.audioId}`);
    }
    merged.set(asset.audioId, {
      ...current,
      candidateIds: [...new Set([...(current.candidateIds ?? []), ...(asset.candidateIds ?? [])])],
    });
  }
  return [...merged.values()];
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const batchPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readJson<unknown>(batchPath));
  if (!checked.ok) throw new Error(`F003 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workProgress = manifest.workProgress[manifest.workIds.indexOf(WORK_ID as never)];
  if (workProgress?.status !== 'voiced') throw new Error(`previewにはvoiced workが必要です: ${workProgress?.status}`);

  const [review, generationArtifact, rights, source, reconciliationBytes, reviewBytes] = await Promise.all([
    readJson<WorkReviewResult>(join(workspace, '.cache', 'batch-review', BATCH_ID, WORK_ID, 'review-result.json')),
    readJson<VoiceGenerationArtifact>(
      join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'voice-generation.json'),
    ),
    readJson<{
      readonly selection: { readonly works: readonly {
        readonly workId: string;
        readonly title: string;
        readonly cardUrl: string;
        readonly sourceUrl: string;
        readonly baseEdition: string;
        readonly inputter: string;
        readonly proofreader: string;
      }[] };
    }>(join(workspace, 'content', 'batches', BATCH_ID, 'rights-selection.json')),
    readJson<{
      readonly rawSha256: string;
      readonly fetchedAt: string;
      readonly sourceUrl: string;
    }>(join(workspace, 'data', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'sources', WORK_ID, 'source.json')),
    readFile(join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'review-reconciliation.json')),
    readFile(join(workspace, 'content', 'batches', BATCH_ID, 'reviews', `${WORK_ID}.json`)),
  ]);
  const selected = rights.selection.works.find((item) => item.workId === WORK_ID);
  if (!selected || review.pending.length !== 0 || review.approved.length === 0 ||
    generationArtifact.generation.batchId !== BATCH_ID ||
    generationArtifact.generation.workId !== WORK_ID) {
    throw new Error('review/generation/source tupleが不正です');
  }

  const revisionsPath = join(workspace, 'content', 'batches', BATCH_ID, 'speech-revisions', `${WORK_ID}.json`);
  const revisionsBytes = await writeCanonicalAtomic(revisionsPath, []);
  const provenance = {
    authorId: manifest.author.authorId,
    batchId: BATCH_ID,
    editorialReview: {
      approved: review.approved.length,
      path: `content/batches/${BATCH_ID}/reviews/${WORK_ID}.json`,
      pending: 0,
      rejected: review.rejected.length,
      resultSha256: workProgress.stageRecords.findLast((item) => item.stage === 'reviewed')?.outputHashes[0],
      sha256: sha256(reviewBytes),
    },
    processing: {
      candidateCount: review.all.length,
      sourceTreeSha256: workProgress.stageRecords.find((item) => item.stage === 'extracted')?.outputHashes[0],
      toolVersion: 'batch-runtime-source/1.0.0',
      transformation: '青空文庫公式XHTMLを宣言charsetでdecodeし、外側の「」候補を抽出して表示文とVOICEVOX用speech textへ決定的に正規化',
    },
    schemaVersion: '1.0.0',
    source: {
      baseEdition: selected.baseEdition,
      cardUrl: selected.cardUrl,
      fetchedAt: source.fetchedAt,
      inputter: selected.inputter,
      proofreader: selected.proofreader,
      rawSha256: source.rawSha256,
      textUrl: selected.sourceUrl,
    },
    speechRevisions: {
      count: 0,
      path: `content/batches/${BATCH_ID}/speech-revisions/${WORK_ID}.json`,
      sha256: sha256(revisionsBytes),
    },
    title: selected.title,
    workId: WORK_ID,
  };
  const provenanceSource = join(
    workspace, 'content', 'batches', BATCH_ID, 'public-files', 'provenance', `${WORK_ID}.json`,
  );
  const provenanceBytes = await writeCanonicalAtomic(provenanceSource, provenance);
  const artworkSource = join(
    workspace, 'content', 'batches', BATCH_ID, 'public-files', 'artwork', 'dazai-zundamon.png',
  );
  const artworkBytes = await readFile(artworkSource);
  const reviews = new Map(review.all.map((item) => [item.candidate.candidateId, item.review]));
  const candidateAudio = new Map<string, string>();
  for (const asset of generationArtifact.generation.assets) {
    for (const candidateId of asset.candidateIds) candidateAudio.set(candidateId, asset.audioId);
  }
  const dialogues = review.approved.map(({ candidate }, order) => {
    const audioId = candidateAudio.get(candidate.candidateId);
    const editorial = reviews.get(candidate.candidateId);
    if (!audioId || !editorial) throw new Error(`candidate audio/reviewがありません: ${candidate.candidateId}`);
    return {
      dialogueId: candidate.candidateId,
      workId: WORK_ID,
      order,
      displayText: candidate.displayText,
      speechText: candidate.speechText,
      audioId,
      sourceAnchor: candidate.sourceAnchor,
      review: editorial,
    };
  });
  const reasonCounts = Object.fromEntries(
    [...new Set(review.rejected.map((item) => item.review.reasonCode))]
      .map((reason) => [reason, review.rejected.filter((item) => item.review.reasonCode === reason).length]),
  );
  const provenancePath = `content/provenance/${BATCH_ID}/${WORK_ID}.json`;
  const currentFragment: BatchCatalogFragment = {
    authors: [{
      ...manifest.author,
      artwork: {
        path: 'artwork/dazai-zundamon.png',
        alt: '太宰治をイメージしたずんだもん',
        sha256: sha256(artworkBytes),
      },
      introducedByBatchId: BATCH_ID,
    }],
    works: [{
      workId: WORK_ID,
      title: selected.title,
      cardLink: selected.cardUrl,
      authorId: manifest.author.authorId,
      batchId: BATCH_ID,
      source: {
        cardUrl: selected.cardUrl,
        textUrl: selected.sourceUrl,
        attribution: '青空文庫',
        baseEdition: selected.baseEdition,
        inputter: selected.inputter,
        proofreader: selected.proofreader,
        fetchedAt: source.fetchedAt,
        transformation: provenance.processing.transformation,
        sourceSha256: source.rawSha256,
        provenancePath,
        provenanceSha256: sha256(provenanceBytes),
      },
      dialogues,
      completionStatus: 'complete',
      notices: [
        { textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] },
        { textKey: 'official-content-warning', placements: ['work-list', 'work-detail', 'credits'] },
      ],
    }],
    audioAssets: generationArtifact.generation.assets.map((asset) => ({
      audioId: asset.audioId,
      batchId: BATCH_ID,
      path: `audio/${BATCH_ID}/${asset.audioId}.wav`,
      sha256: asset.sha256,
      bytes: asset.bytes,
      durationMs: asset.durationMs,
      configHash: asset.configHash,
      candidateIds: [...asset.candidateIds],
    })),
    candidateCounts: {
      total: review.all.length,
      published: review.approved.length,
      editorialExcluded: review.rejected.length,
      audioExcluded: 0,
      editorialReasons: reasonCounts,
      audioFailureReasons: {},
    },
    publicFiles: [
      {
        source: asWorkspacePath(`content/batches/${BATCH_ID}/public-files/artwork/dazai-zundamon.png`),
        publicPath: asWorkspacePath('artwork/dazai-zundamon.png'),
        sha256: asSha256(sha256(artworkBytes)),
        bytes: artworkBytes.byteLength,
      },
      {
        source: asWorkspacePath(`content/batches/${BATCH_ID}/public-files/provenance/${WORK_ID}.json`),
        publicPath: asWorkspacePath(provenancePath),
        sha256: asSha256(sha256(provenanceBytes)),
        bytes: provenanceBytes.byteLength,
      },
    ],
  };
  const workIndex = manifest.workIds.indexOf(WORK_ID as never);
  const priorWorkIds = manifest.workIds.slice(0, workIndex);
  for (const priorWorkId of priorWorkIds) {
    const prior = manifest.workProgress[manifest.workIds.indexOf(priorWorkId)];
    if (prior?.status !== 'accepted') {
      throw new Error(`先行作品がacceptedではありません: ${priorWorkId}/${prior?.status ?? 'missing'}`);
    }
  }
  const priorPreviews = await Promise.all(
    priorWorkIds.map((priorWorkId) => previousWorkPreview(workspace, priorWorkId, rights)),
  );
  const activeFragment: BatchCatalogFragment = {
    authors: currentFragment.authors,
    works: [...priorPreviews.map((item) => item.work), ...currentFragment.works],
    audioAssets: mergeAudioAssets([
      ...priorPreviews.flatMap((item) => item.audioAssets),
      ...currentFragment.audioAssets,
    ]),
    candidateCounts: sumCounts([
      ...priorPreviews.map((item) => item.candidateCounts),
      currentFragment.candidateCounts,
    ]),
    publicFiles: [
      ...(currentFragment.publicFiles?.filter((item) => item.publicPath === 'artwork/dazai-zundamon.png') ?? []),
      ...priorPreviews.map((item) => item.publicFile),
      ...(currentFragment.publicFiles?.filter((item) => item.publicPath !== 'artwork/dazai-zundamon.png') ?? []),
    ],
  };

  const activeStage = join(workspace, '.cache', `.f003-active-${randomUUID()}`);
  const previewStage = join(workspace, '.cache', `.f003-preview-${randomUUID()}`);
  await Promise.all([mkdir(activeStage, { recursive: false }), mkdir(previewStage, { recursive: false })]);
  const stagedFiles: ActiveBatchPreview['stagedFiles'][number][] = [];
  const priorAudioPaths = new Set(
    priorPreviews.flatMap((preview) => preview.audioAssets.map((asset) => asset.path)),
  );
  for (const asset of generationArtifact.generation.assets) {
    if (priorAudioPaths.has(`audio/${BATCH_ID}/${asset.audioId}.wav`)) continue;
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
  for (const item of [
    {
      source: artworkSource,
      publicPath: asWorkspacePath('artwork/dazai-zundamon.png'),
      sha256: asSha256(sha256(artworkBytes)),
      bytes: artworkBytes.byteLength,
    },
    {
      source: provenanceSource,
      publicPath: asWorkspacePath(provenancePath),
      sha256: asSha256(sha256(provenanceBytes)),
      bytes: provenanceBytes.byteLength,
    },
  ]) {
    const target = join(activeStage, ...item.publicPath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(item.source, target);
    stagedFiles.push({ ...item, source: target });
  }
  for (const item of priorPreviews.flatMap((preview) => preview.stagedFiles)) {
    const existing = stagedFiles.find((candidate) => candidate.publicPath === item.publicPath);
    if (existing) {
      if (existing.sha256 !== item.sha256 || existing.bytes !== item.bytes) {
        throw new Error(`先行作品とのpublic fileが競合しています: ${item.publicPath}`);
      }
      continue;
    }
    const target = join(activeStage, ...item.publicPath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(item.source, target);
    stagedFiles.push({ ...item, source: target });
  }

  const [f001, publishedBaseline, batches] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE),
    loadAcceptedBatches(workspace),
  ]);
  const f002 = await f002Fragment(workspace, publishedBaseline.catalog);
  const publishedF002Batch = publishedBaseline.catalog.batches.find((batch) => batch.batchId === 'F002');
  if (!publishedF002Batch) throw new Error('固定published baselineにF002 catalog batchがありません');
  const active: ActiveBatchPreview = {
    manifest,
    workId: WORK_ID,
    catalogFragment: activeFragment,
    catalogBatch: {
      batchId: BATCH_ID,
      feature: BATCH_ID,
      status: 'accepted',
      authorId: manifest.author.authorId,
      workIds: manifest.workIds.slice(0, workIndex + 1),
      acceptedAt: workProgress.stageRecords.findLast((item) => item.stage === 'voiced')!.completedAt,
      evidenceSha256: hashBatchManifest(manifest),
    },
    stagingRoot: activeStage,
    stagedFiles,
  };
  const build = await buildIntegratedPublicTree(
    batches,
    {
      baselineSha256: f001.baselineSha256,
      catalog: f001.catalog,
      files: f001.files,
      sourceRoot: f001.sourceRoot,
      syntheticBatch: f001.syntheticBatch,
    },
    previewStage,
    {
      mode: 'work-preview',
      workspaceRoot: workspace,
      batchCatalogs: { F002: f002 },
      publishedCatalogBatches: { F002: publishedF002Batch },
    },
    active,
  );
  const publishedInvariant = await verifyPublishedInvariant(publishedBaseline, {
    target: 'work-preview',
    root: build.stagingRoot,
    treeSha256: build.buildSha256,
  });
  if (publishedInvariant.result !== 'pass') {
    throw new Error(`固定F002 published baseline不変違反: ${publishedInvariant.mismatches.join(',')}`);
  }
  await writeCanonicalAtomic(
    join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'content-preview.json'),
    build,
  );
  await writeCanonicalAtomic(
    join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'published-content-invariant.json'),
    publishedInvariant,
  );
  process.stdout.write(
    `work-preview: ${build.files.length} files, build=${build.buildSha256}, reconciliation=${sha256(reconciliationBytes)}\n`,
  );
}

await main();
