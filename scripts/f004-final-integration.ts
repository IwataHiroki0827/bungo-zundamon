import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline, verifyF001Invariant } from '../src/content/baseline.ts';
import {
  buildIntegratedPublicTree,
  type BatchCatalogFragment as PublicBatchCatalogFragment,
  type F001BaselineBundle,
} from '../src/content/batch-public.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import {
  loadVerifiedIncludedBatchWork,
  mergeExistingAuthorCatalog,
  projectBatchCatalogFragment,
  verifyReusedArtwork,
} from '../src/content/batch-catalog.ts';
import {
  hashBatchManifest,
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
  F004_V030_PINS,
  loadPublishedV030Baseline,
} from '../src/content/f004-baseline.ts';
import { buildPagesPreview } from '../src/content/pages-preview.ts';
import type { CatalogV2 } from '../src/content/processing.ts';
import { validateCatalogV2 } from '../src/ui/catalog-loader.ts';

const execFile = promisify(execFileCallback);
const BATCH_ID = 'F004';

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label}が固定v0.3.0またはFinalCatalogと一致しません`);
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error('usage: f004-final-integration.ts');
  }
  const workspace = resolve(process.cwd());
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  const sourceCommit = head.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || status.trim() !== '') {
    throw new Error('F004最終統合にはexact clean source commitが必要です');
  }

  const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readJson<unknown>(manifestPath));
  if (!checked.ok || checked.value.status !== 'accepted' ||
    checked.value.workProgress.some((work) => work.status !== 'accepted')) {
    throw new Error('F004全3作品がacceptedではありません');
  }
  const manifest = checked.value;
  const [context, baseline] = await Promise.all([
    loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    ),
    loadPublishedV030Baseline(workspace, F004_V030_PINS),
  ]);
  const artworkReusePath = join(workspace, ...manifest.artworkProvenanceRef.split('/'));
  const artworkReuseBytes = await readFile(artworkReusePath);
  const artworkReuse = JSON.parse(artworkReuseBytes.toString('utf8')) as {
    readonly schemaVersion: string;
    readonly batchId: string;
    readonly authorId: string;
    readonly newArtworkEntries: number;
    readonly reuse: {
      readonly introducedByBatchId: string;
      readonly sourceProvenanceRef: string;
      readonly sourceProvenanceSha256: string;
      readonly output: { readonly path: string; readonly sha256: string };
      readonly credit: string;
    };
  };
  const sourceArtworkProvenance = await readFile(
    join(workspace, ...artworkReuse.reuse.sourceProvenanceRef.split('/')),
  );
  if (canonicalJson(artworkReuse) !== artworkReuseBytes.toString('utf8') ||
    artworkReuse.schemaVersion !== '1.0.0' ||
    artworkReuse.batchId !== BATCH_ID ||
    artworkReuse.authorId !== baseline.artwork.authorId ||
    artworkReuse.newArtworkEntries !== 0 ||
    artworkReuse.reuse.introducedByBatchId !== baseline.artwork.introducedByBatchId ||
    artworkReuse.reuse.sourceProvenanceRef !== 'content/batches/F002/artwork-provenance.json' ||
    artworkReuse.reuse.sourceProvenanceSha256 !== sha(sourceArtworkProvenance) ||
    artworkReuse.reuse.output.path !== baseline.artwork.path ||
    artworkReuse.reuse.output.sha256 !== baseline.artwork.sha256 ||
    artworkReuse.reuse.credit !== baseline.artwork.credit) {
    throw new Error('F004既存画像reuse証跡が固定v0.3.0と一致しません');
  }

  const temporaryInput = await mkdtemp(join(workspace, '.cache', 'f004-final-input-'));
  const finalRoot = await mkdtemp(join(workspace, '.cache', 'f004-final-integration-'));
  try {
    await mkdir(join(temporaryInput, 'content', 'batches', BATCH_ID), { recursive: true });
    await cp(
      join(workspace, 'content', 'batches', BATCH_ID, 'source-index.json'),
      join(temporaryInput, 'content', 'batches', BATCH_ID, 'source-index.json'),
    );
    const rebound = structuredClone(manifest) as BatchManifest;
    const artifacts: Array<{
      readonly ref: WorkspaceRelativePath;
      readonly sha256: Sha256;
    }> = [];
    for (let index = 0; index < manifest.workIds.length; index += 1) {
      const workId = manifest.workIds[index]!;
      const progress = rebound.workProgress[index]!;
      const artifactRef =
        `content/batches/${BATCH_ID}/work-artifacts/${workId}/prepared-work.json` as WorkspaceRelativePath;
      const persisted = await readJson<Record<string, unknown>>(
        join(workspace, ...artifactRef.split('/')),
      );
      if (persisted.lifecycle !== 'staged' || persisted.workId !== workId ||
        persisted.batchId !== BATCH_ID || progress.status !== 'accepted' ||
        !Array.isArray(progress.acceptedAudioSources)) {
        throw new Error(`accepted work artifact tupleが不正です: ${workId}`);
      }
      const acceptedArtifact = { ...persisted, lifecycle: 'accepted' as const };
      const artifactSha256 = sha(canonicalJson(acceptedArtifact));
      await writeJsonArtifactAtomic(
        temporaryInput,
        join(temporaryInput, ...artifactRef.split('/')),
        acceptedArtifact,
      );
      for (const name of ['source.raw', 'source.json', 'provenance.json']) {
        const sourcePath =
          `data/batches/${BATCH_ID}/fixed-sources/${workId}/${workId}/${name}`;
        const target = join(temporaryInput, ...sourcePath.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await cp(join(workspace, ...sourcePath.split('/')), target);
      }
      const audioAssets = persisted.audioAssets as Array<{
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly configHash: string;
      }>;
      for (const asset of audioAssets) {
        const source = progress.acceptedAudioSources.find((entry) =>
          entry.sha256 === asset.sha256 &&
          entry.bytes === asset.bytes &&
          entry.configHash === asset.configHash);
        if (!source) throw new Error(`accepted audio bindingがありません: ${workId}/${asset.path}`);
        const target = join(temporaryInput, 'public', ...asset.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await cp(join(workspace, ...source.path.split('/')), target);
      }
      const acceptedStageIndex = progress.stageRecords
        .findLastIndex((record) => record.stage === 'accepted');
      if (acceptedStageIndex < 0) throw new Error(`accepted stageがありません: ${workId}`);
      const stages = progress.stageRecords as unknown as
        Array<(typeof progress.stageRecords)[number]>;
      const stage = stages[acceptedStageIndex]!;
      stages[acceptedStageIndex] = {
        ...stage,
        outputHashes: [...new Set([...stage.outputHashes, artifactSha256])],
      };
      artifacts.push({ ref: artifactRef, sha256: artifactSha256 });
    }

    const reboundSha256 = hashBatchManifest(rebound);
    const includedWorks = await Promise.all(artifacts.map((artifact) =>
      loadVerifiedIncludedBatchWork(
        temporaryInput,
        context.definition,
        rebound,
        reboundSha256,
        artifact.ref,
        artifact.sha256,
      )));
    const finalFragment = projectBatchCatalogFragment(
      context.definition,
      rebound,
      includedWorks,
      baseline,
      'final',
    );
    const finalCatalog = mergeExistingAuthorCatalog(baseline, finalFragment);
    const artwork = verifyReusedArtwork(baseline, finalCatalog);

    const publicFiles = await Promise.all(finalFragment.works.map(async (work) => {
      const source =
        `content/batches/${BATCH_ID}/public-files/provenance/${work.workId}.json` as WorkspaceRelativePath;
      const bytes = await readFile(join(workspace, ...source.split('/')));
      if (sha(bytes) !== work.source.provenanceSha256) {
        throw new Error(`公開provenanceがwork artifactと一致しません: ${work.workId}`);
      }
      return {
        source,
        publicPath: work.source.provenancePath as WorkspaceRelativePath,
        sha256: sha(bytes),
        bytes: bytes.byteLength,
      };
    }));
    const f004Fragment: PublicBatchCatalogFragment = {
      authors: structuredClone(finalFragment.authors),
      works: finalFragment.works.map((work) => structuredClone(work)),
      audioAssets: finalFragment.audioAssets.map((asset) => structuredClone(asset)),
      candidateCounts: structuredClone(finalFragment.candidateCounts),
      publicFiles,
    };

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
        .filter((batch) => batch.batchId === 'F002' || batch.batchId === 'F003')
        .map((batch) => [batch.batchId, batch]),
    );
    const contentRoot = join(finalRoot, 'content');
    const distRoot = join(finalRoot, 'dist');
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
        batchCatalogs: { F002: f002, F003: f003, F004: f004Fragment },
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
    if (!validation.ok) throw new Error(`F004最終Catalogが不正です: ${validation.error.code}`);
    const catalog = validation.value;

    assertEqual('authors projection', catalog.authors, finalCatalog.authors);
    assertEqual('works projection', catalog.works, finalCatalog.works);
    const normalizedAudio = (assets: CatalogV2['audioAssets']) =>
      assets.map((asset) => ({
        ...asset,
        ...(asset.candidateIds
          ? { candidateIds: [...asset.candidateIds].sort((left, right) => left.localeCompare(right, 'en')) }
          : {}),
      })).sort((left, right) => left.audioId.localeCompare(right.audioId, 'en'));
    assertEqual(
      'audio projection',
      normalizedAudio(catalog.audioAssets),
      normalizedAudio(finalCatalog.audioAssets),
    );
    const requiredCounts = (counts: CatalogV2['candidateCounts']) => ({
      total: counts.total,
      published: counts.published,
      editorialExcluded: counts.editorialExcluded,
      audioExcluded: counts.audioExcluded,
      byBatch: counts.byBatch,
    });
    assertEqual(
      'candidate counts',
      requiredCounts(catalog.candidateCounts),
      requiredCounts(finalCatalog.candidateCounts),
    );
    assertEqual('credits ref', catalog.creditsRef, finalCatalog.creditsRef);
    assertEqual(
      '既存authors',
      catalog.authors,
      baseline.catalog.authors,
    );
    assertEqual(
      '既存works',
      catalog.works.filter((work) => work.batchId !== BATCH_ID),
      baseline.catalog.works,
    );
    assertEqual(
      '既存audio',
      catalog.audioAssets.filter((asset) => asset.batchId !== BATCH_ID),
      baseline.catalog.audioAssets,
    );
    assertEqual(
      '既存batches',
      catalog.batches.filter((batch) => batch.batchId !== BATCH_ID),
      baseline.catalog.batches,
    );

    const files = new Map(build.files.map((file) => [file.path, file]));
    for (const author of catalog.authors) {
      const file = files.get(author.artwork.path as WorkspaceRelativePath);
      if (!file || file.sha256 !== author.artwork.sha256) {
        throw new Error(`作者画像assetが不整合です: ${author.authorId}`);
      }
    }
    const audioIds = new Set(catalog.audioAssets.map((asset) => asset.audioId));
    for (const work of catalog.works) {
      const provenance = files.get(work.source.provenancePath as WorkspaceRelativePath);
      if (!provenance || provenance.sha256 !== work.source.provenanceSha256 ||
        work.dialogues.some((dialogue) => !audioIds.has(dialogue.audioId))) {
        throw new Error(`作品asset joinが不整合です: ${work.workId}`);
      }
    }
    for (const asset of catalog.audioAssets) {
      const file = files.get(asset.path as WorkspaceRelativePath);
      if (!file || file.sha256 !== asset.sha256 || file.bytes !== asset.bytes) {
        throw new Error(`音声assetが不整合です: ${asset.audioId}`);
      }
    }

    const { authors, works, audioAssets } = f001.catalog;
    if (!authors || !works || !audioAssets) throw new Error('固定F001 projectionが不完全です');
    const f001Invariant = await verifyF001Invariant(catalog, contentRoot, {
      baselineSha256: f001.baselineSha256,
      files: f001.files,
      catalog: { authors, works, audioAssets },
    });
    if (f001Invariant.result !== 'pass') throw new Error('F001 invariantがblockedです');
    const pages = await buildPagesPreview(build, workspace, distRoot, true);
    const miyazawaWorks = catalog.works
      .filter((work) => work.authorId === manifest.author.authorId)
      .map((work) => work.workId);
    if (canonicalJson(miyazawaWorks) !== canonicalJson([
      ...baseline.catalog.works
        .filter((work) => work.authorId === manifest.author.authorId)
        .map((work) => work.workId),
      ...manifest.workIds,
    ])) {
      throw new Error('宮沢賢治作品の追記順が不正です');
    }
    const reportCore = {
      schemaVersion: '1.0.0',
      batchId: BATCH_ID,
      result: 'pass',
      sourceCommit,
      manifestSha256: hashBatchManifest(manifest),
      reboundManifestSha256: reboundSha256,
      finalFragmentSha256: finalFragment.digest,
      finalCatalogProjectionSha256: sha(canonicalJson(finalCatalog)),
      catalogSha256: sha(catalogBytes),
      contentBuildSha256: build.buildSha256,
      distSha256: pages.distSha256,
      fileCount: build.files.length,
      distFileCount: pages.files.length,
      authorCount: catalog.authors.length,
      workCount: catalog.works.length,
      dialogueCount: catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0),
      audioCount: catalog.audioAssets.length,
      f004WorkIds: finalFragment.works.map((work) => work.workId),
      f004DialogueCount: finalFragment.works.reduce((sum, work) => sum + work.dialogues.length, 0),
      f004AudioCount: finalFragment.audioAssets.length,
      miyazawaWorkIds: miyazawaWorks,
      artwork,
      f001Invariant,
      publishedV030Invariant: {
        result: 'pass',
        descriptorSha256: baseline.descriptorSha256,
        contentTreeSha256: baseline.pins.contentTreeSha256,
        mismatches: 0,
      },
      trackedPublicChangedPaths: [],
    } as const;
    const report = {
      ...reportCore,
      reportSha256: sha(canonicalJson(reportCore)),
    };
    await writeJsonArtifactAtomic(
      workspace,
      join(workspace, '.cache', 'batch-release', BATCH_ID, 'final-integration.json'),
      report,
    );
    process.stdout.write(canonicalJson(report));
  } finally {
    await Promise.all([
      rm(temporaryInput, { recursive: true, force: true }),
      rm(finalRoot, { recursive: true, force: true }),
    ]);
  }
}

await main();
