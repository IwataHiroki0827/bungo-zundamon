import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline } from '../src/content/baseline.ts';
import {
  buildIntegratedPublicTree,
  type BatchCatalogFragment as PublicBatchCatalogFragment,
  type F001BaselineBundle,
} from '../src/content/batch-public.ts';
import {
  loadAcceptedBatches,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  loadAcceptedF003CatalogFragment,
  loadPublishedF002CatalogFragment,
} from '../src/content/f003-catalog.ts';
import {
  computeDHash64V1,
  parseAndRehydrateF005ArtworkProvenance,
  verifyF005ArtworkAgainstCatalog,
} from '../src/content/f005-artwork.ts';
import {
  mergeNewAuthorCatalog,
  projectF005CatalogFragment,
  projectF005CatalogSource,
  type F005IncludedCatalogWork,
} from '../src/content/f005-catalog.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import { loadV040Baseline, verifyNatsumeIdentity } from '../src/content/f005-foundation.ts';
import {
  parseF005SourceRecord,
  rehydrateF005SelectionSnapshot,
  type F005WorkId,
} from '../src/content/f005-source.ts';
import type { CatalogDialogueV2 } from '../src/content/processing.ts';
import { validateCatalogV2 } from '../src/ui/catalog-loader.ts';
import { createVoiceCacheKeyV2, type VoiceConfigV2 } from '../src/voice/cache.ts';
import { inspectWav } from '../src/voice/generation.ts';

const execFile = promisify(execFileCallback);
const BATCH_ID = 'F005';
const AUTHOR_ID = '000148';
const CONFIG_PATH = 'content/batches/F002/voice-config.json';

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readCanonicalJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`canonical JSONではありません: ${path}`);
  return value;
}

interface SpeechItem {
  readonly candidateId: string;
  readonly workId: string;
  readonly displayText: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly speaker: string;
  readonly reasonCode: string;
}

interface CandidateRecord {
  readonly candidateId: string;
  readonly order: number;
  readonly displayText: string;
  readonly sha256: string;
  readonly sourceAnchor: {
    readonly bodySelector: string;
    readonly startToken: number;
    readonly endToken: number;
  };
}

interface Resolution {
  readonly candidateId: string;
  readonly decision: 'approved' | 'rejected';
  readonly inputSha256: string;
  readonly reasonCode: string;
  readonly sourceAnchor: string;
  readonly speaker: string | null;
}

interface Reconciliation {
  readonly reconciliationSha256: string;
  readonly resolutions: readonly Resolution[];
}

type SourceRecord = ReturnType<typeof parseF005SourceRecord>;
type SelectionSnapshot = Awaited<ReturnType<typeof rehydrateF005SelectionSnapshot>>;

/**
 * 公開provenanceは封緘済み選定snapshotと原典記録だけから決定的に組み立てる。
 * F001 baselineの凍結対象ではないため、リリースごとに再生成してよい。
 */
function buildSourceProvenance(
  source: SourceRecord,
  snapshot: SelectionSnapshot,
): Record<string, unknown> {
  return {
    baseEdition: source.bibliography.baseEdition,
    bibliography: {
      archiveBytes: snapshot.bibliographyArchive.byteLength,
      archiveSha256: snapshot.bibliographyArchive.sha256,
      csvBytes: snapshot.bibliographyCsv.byteLength,
      csvEntry: 'list_person_all_extended_utf8.csv',
      csvSha256: snapshot.bibliographyCsv.sha256,
      sourceUrl: snapshot.bibliographyArchive.sourceUrl,
    },
    changeNotice: '原文抽出・台詞選定・ずんだもん音声化を実施。加工部分はCC BY 4.0。',
    fetchedAt: source.fetchedAt,
    inputter: source.bibliography.inputter,
    proofreader: source.bibliography.proofreader,
    sourceSha256: source.raw.sha256,
    sourceUrl: source.sourceUrl,
    stableCardUrl: source.cardUrl,
    toolVersion: 'bungo-zundamon-source-v1',
    transformation:
      '公式XHTMLの実体参照正規化・本文抽出・台詞候補抽出・独立2名レビュー・音声合成',
  };
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  const sourceCommit = head.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || status.trim() !== '') {
    throw new Error('F005最終統合にはexact clean source commitが必要です');
  }

  const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readCanonicalJson<unknown>(manifestPath));
  if (!checked.ok || checked.value.status !== 'accepted' ||
    checked.value.workProgress.some((work) => work.status !== 'accepted')) {
    throw new Error('F005全3作品がacceptedではありません');
  }
  const manifest: BatchManifest = checked.value;

  const context = await loadVerifiedF005Definition(workspace);
  const baseline = await loadV040Baseline(workspace, context);
  const author = verifyNatsumeIdentity(context, baseline.catalog);

  // F005が導入する画像は1点だけで、生成元と最終画像のSHAが同一である。
  const artworkPath = join(
    workspace, 'content', 'batches', BATCH_ID, 'public-files', 'artwork', 'natsume-zundamon.png');
  const artworkBytes = new Uint8Array(await readFile(artworkPath));
  const provenanceText = await readFile(
    join(workspace, 'content', 'batches', BATCH_ID, 'artwork-provenance.json'), 'utf8');
  const persisted = JSON.parse(provenanceText) as {
    readonly generation: Record<string, unknown>;
    readonly credit: string;
  };
  const generation = persisted.generation;
  const provenance = parseAndRehydrateF005ArtworkProvenance(
    context,
    provenanceText,
    {
      generator: generation.generator as string,
      generatorVersion: generation.generatorVersion as string,
      tool: generation.tool as string,
      providerTerms: generation.providerTerms as never,
      characterGuideline: generation.characterGuideline as never,
      prompt: generation.prompt as string,
      negativePrompt: generation.negativePrompt as string,
      generatedAt: generation.generatedAt as string,
      originalImageBytes: artworkBytes,
    },
    {
      referenceInputs: [],
      processingInputs: [],
    } as never,
    {
      sourcePath: 'content/batches/F005/public-files/artwork/natsume-zundamon.png',
      publicPath: 'artwork/natsume-zundamon.png',
      credit: persisted.credit,
      bytes: artworkBytes,
    },
  );
  const existingArtwork = await Promise.all(baseline.catalog.authors.map(async (entry) => {
    const bytes = new Uint8Array(await readFile(join(workspace, 'public', ...entry.artwork.path.split('/'))));
    return {
      authorId: entry.authorId,
      path: entry.artwork.path,
      bytes,
      sha256: entry.artwork.sha256,
      dHash64: computeDHash64V1(bytes),
    };
  }));
  const artwork = verifyF005ArtworkAgainstCatalog(provenance, artworkBytes, existingArtwork);

  const snapshot = await rehydrateF005SelectionSnapshot(workspace, context);
  const config = await readCanonicalJson<VoiceConfigV2>(join(workspace, ...CONFIG_PATH.split('/')));
  const configHash = sha(canonicalJson(config));

  const includedWorks: F005IncludedCatalogWork[] = [];
  // 公開provenanceは決定的に再生成されるが、buildIntegratedPublicTreeのreferencedPublicEvidenceは
  // publicFiles[].sourceを実ワークスペース上の実ファイルとして検証するため、公開先パス
  // (content/provenance/F005/{workId}.json)とは別に、実ワークスペースへ永続化するevidenceコピー先
  // (content/batches/F005/public-files/provenance/{workId}.json)を持つ(F004の設計を踏襲)。
  const provenanceOutputs: Array<{
    readonly workId: string;
    readonly persistedPath: string;
    readonly publicPath: string;
    readonly bytes: Uint8Array;
    readonly value: Record<string, unknown>;
  }> = [];
  for (const workId of manifest.workIds as readonly F005WorkId[]) {
    const workRoot = join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', workId);
    const workSnapshot = snapshot.works.find((work) => work.workId === workId);
    if (!workSnapshot) throw new Error(`selection snapshotに${workId}がありません`);
    const source = parseF005SourceRecord(workSnapshot, workId);

    const provenanceValue = buildSourceProvenance(source, snapshot);
    const provenanceBytes = new TextEncoder().encode(canonicalJson(provenanceValue));
    const sourceProvenance = {
      path: `content/provenance/F005/${workId}.json` as const,
      sha256: sha(provenanceBytes),
    };
    provenanceOutputs.push({
      workId,
      persistedPath: `content/batches/${BATCH_ID}/public-files/provenance/${workId}.json`,
      publicPath: sourceProvenance.path,
      bytes: provenanceBytes,
      value: provenanceValue,
    });

    const [speechItems, candidates, reconciliation] = await Promise.all([
      readCanonicalJson<readonly SpeechItem[]>(join(workRoot, 'speech-items.json')),
      readCanonicalJson<readonly CandidateRecord[]>(join(workRoot, 'candidates.json')),
      readCanonicalJson<Reconciliation>(join(workRoot, 'review-reconciliation.json')),
    ]);
    const candidateById = new Map(candidates.map((entry) => [entry.candidateId, entry]));
    const resolutionById = new Map(
      reconciliation.resolutions.map((entry) => [entry.candidateId, entry]));

    const audioDirectory = join(
      workspace, 'content', 'batches', BATCH_ID, 'accepted-audio', workId);
    const audioBytesById = new Map<string, Uint8Array>();
    for (const entry of await readdir(audioDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.wav')) continue;
      audioBytesById.set(
        entry.name.slice(0, -4),
        new Uint8Array(await readFile(join(audioDirectory, entry.name))),
      );
    }

    const dialogues: CatalogDialogueV2[] = [];
    const candidateIdsByAudioId = new Map<string, string[]>();
    for (const item of speechItems) {
      const candidate = candidateById.get(item.candidateId);
      const resolution = resolutionById.get(item.candidateId);
      if (!candidate || !resolution || resolution.decision !== 'approved') {
        throw new Error(`approved候補が一致しません: ${workId}/${item.candidateId}`);
      }
      const audioId = createVoiceCacheKeyV2(item.speechText, config);
      if (!audioBytesById.has(audioId)) {
        throw new Error(`受理済み音声がありません: ${workId}/${audioId}`);
      }
      const ids = candidateIdsByAudioId.get(audioId) ?? [];
      ids.push(item.candidateId);
      candidateIdsByAudioId.set(audioId, ids);
      dialogues.push({
        dialogueId: item.candidateId,
        workId,
        order: candidate.order,
        displayText: item.displayText,
        speechText: item.speechText,
        audioId,
        sourceAnchor: candidate.sourceAnchor,
        review: {
          candidateId: item.candidateId,
          workId,
          policyDecision: 'allowed',
          revision: 1,
          status: 'approved',
          reasonCode: item.reasonCode,
          reviewer: `editorial-independent:f005-${workId}-primary+f005-${workId}-secondary`,
          note: canonicalJson({
            inputSha256: resolution.inputSha256,
            reconciliationDigest: reconciliation.reconciliationSha256,
            resolutionSource: 'agreement',
            sourceAnchor: resolution.sourceAnchor,
            speaker: item.speaker,
          }),
          reviewedAt: manifest.acceptedAt ?? snapshot.observedAt,
          policyCheckedAt: snapshot.observedAt,
        },
      } as unknown as CatalogDialogueV2);
    }
    dialogues.sort((left, right) => left.order - right.order);

    const audioAssets = [...candidateIdsByAudioId.entries()]
      .map(([audioId, candidateIds]) => {
        const bytes = audioBytesById.get(audioId);
        if (!bytes) throw new Error(`音声実体がありません: ${workId}/${audioId}`);
        return {
          audioId,
          batchId: BATCH_ID,
          path: `audio/${BATCH_ID}/${audioId}.wav`,
          sha256: sha(bytes),
          bytes: bytes.byteLength,
          durationMs: inspectWav(bytes).durationMs,
          configHash,
          candidateIds: [...candidateIds].sort((left, right) => left.localeCompare(right, 'en')),
        };
      })
      .sort((left, right) => left.audioId.localeCompare(right.audioId, 'en'));

    const editorialReasons: Record<string, number> = {};
    for (const resolution of reconciliation.resolutions) {
      if (resolution.decision !== 'rejected') continue;
      editorialReasons[resolution.reasonCode] = (editorialReasons[resolution.reasonCode] ?? 0) + 1;
    }
    includedWorks.push({
      lifecycle: 'accepted',
      sourceRecord: source,
      sourceProvenance,
      work: {
        workId,
        title: source.title,
        cardLink: source.cardUrl,
        authorId: AUTHOR_ID,
        batchId: BATCH_ID,
        source: projectF005CatalogSource(source, sourceProvenance),
        dialogues,
        completionStatus: 'complete',
        notices: [{
          textKey: 'dialogue-excerpt-scope',
          placements: ['work-list', 'work-detail', 'credits'],
        }],
      },
      audioAssets,
      candidateCounts: {
        total: reconciliation.resolutions.length,
        published: dialogues.length,
        editorialExcluded: reconciliation.resolutions.length - dialogues.length,
        audioExcluded: 0,
        editorialReasons,
        audioFailureReasons: {},
      },
      artifactSha256: sha(canonicalJson(reconciliation)),
    } as unknown as F005IncludedCatalogWork);
  }

  const fragment = projectF005CatalogFragment(
    context, manifest, includedWorks, author, artwork, 'final');
  const finalCatalog = mergeNewAuthorCatalog(baseline.catalog, fragment, author);

  const outputRoot = await mkdtemp(join(workspace, '.cache', 'f005-final-integration-'));
  for (const output of provenanceOutputs) {
    await writeJsonArtifactAtomic(
      workspace,
      join(workspace, ...output.persistedPath.split('/')),
      output.value,
    );
  }

  const publicFiles = fragment.works.map((work) => {
    const output = provenanceOutputs.find((entry) =>
      entry.publicPath === `content/provenance/${BATCH_ID}/${work.workId}.json`);
    if (!output) throw new Error(`公開provenanceがありません: ${work.workId}`);
    return {
      source: output.persistedPath as WorkspaceRelativePath,
      publicPath: work.source.provenancePath as WorkspaceRelativePath,
      sha256: sha(output.bytes),
      bytes: output.bytes.byteLength,
    };
  });
  const f005Fragment = {
    authors: [structuredClone(fragment.author)],
    works: fragment.works.map((work) => structuredClone(work)),
    audioAssets: fragment.audioAssets.map((asset) => structuredClone(asset)),
    candidateCounts: structuredClone(fragment.candidateCounts),
    publicFiles,
  } as unknown as PublicBatchCatalogFragment;

  const preparation = {
    releaseCandidateBatchId: manifest.batchId,
    feature: manifest.feature,
    sourceCommit,
  } as const;
  const [f001, f002, f003, batches] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadPublishedF002CatalogFragment(workspace, baseline.catalog),
    loadAcceptedF003CatalogFragment(workspace),
    loadAcceptedBatches(workspace, { preparation }),
  ]);
  const f001Bundle: F001BaselineBundle = {
    baselineSha256: f001.baselineSha256,
    catalog: f001.catalog,
    files: f001.files,
    sourceRoot: f001.sourceRoot,
    syntheticBatch: f001.syntheticBatch,
  };
  const publishedCatalogBatches = Object.fromEntries(
    baseline.catalog.batches
      .filter((batch) => batch.batchId !== BATCH_ID)
      .map((batch) => [batch.batchId, batch]),
  );
  const contentRoot = join(outputRoot, 'tree');
  await mkdir(contentRoot, { recursive: true });
  const build = await buildIntegratedPublicTree(
    batches,
    f001Bundle,
    contentRoot,
    {
      mode: 'prepare-release',
      workspaceRoot: workspace,
      batchCatalogs: { F002: f002, F003: f003, F005: f005Fragment },
      publishedCatalogBatches,
    },
    undefined,
    preparation,
  );
  const catalogBytes = await readFile(join(contentRoot, 'content', 'catalog.json'));
  const validation = validateCatalogV2(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)),
    catalogBytes.byteLength,
  );
  if (!validation.ok) throw new Error(`F005最終Catalogが不正です: ${validation.error.code}`);

  process.stdout.write(canonicalJson({
    ok: true,
    sourceCommit,
    outputRoot,
    authors: finalCatalog.authors.length,
    works: finalCatalog.works.length,
    dialogues: finalCatalog.works.reduce((sum, work) => sum + work.dialogues.length, 0),
    audioAssets: finalCatalog.audioAssets.length,
    catalogSha256: sha(catalogBytes),
    treeFiles: build.files.length,
  }));
}

await main();
