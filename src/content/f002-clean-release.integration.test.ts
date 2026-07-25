import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import {
  buildIntegratedPublicTree,
  type BatchCatalogFragment,
  type F001BaselineBundle,
} from './batch-public.ts';
import {
  verifyF001DistInvariant,
  verifyF001Invariant,
  type F001Baseline,
} from './baseline.ts';
import { buildPagesPreview, type PagesBuildAdapter, type PagesDistPreview } from './pages-preview.ts';
import type {
  BatchId,
  BatchManifest,
  PublishableBatch,
  ReleaseBuildContext,
  Sha256,
  WorkspaceRelativePath,
} from './batch.ts';
import type { CatalogV2 } from './processing.ts';
import { verifyActualCapacity, type ReleaseActualCapacityReport } from '../voice/budget.ts';
import type { ArtworkProvenanceV2 } from '../notices/artwork-provenance.ts';

const execFile = promisify(execFileCallback);
const WORK_IDS = ['000473', '043752', '043754'] as const;
const F001_WORK_IDS = ['000127', '000128', '000129'] as const;
const F002_BATCH_ID = 'F002' as BatchId;
const NOW = '2026-07-25T03:00:00.000Z';

function sha(bytes: Uint8Array | string): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

function pngFixture(): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  new DataView(bytes.buffer).setUint32(16, 1254);
  new DataView(bytes.buffer).setUint32(20, 1254);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function dialogue(workId: string, order: number, audioId: string) {
  const dialogueId = `${workId}-dialogue-${String(order).padStart(2, '0')}`;
  return {
    dialogueId,
    workId,
    order,
    displayText: `台詞${order}`,
    speechText: `台詞${order}`,
    audioId,
    sourceAnchor: { bodySelector: '.main_text', startToken: order * 2, endToken: order * 2 + 1 },
    review: {
      candidateId: dialogueId,
      revision: 1,
      status: 'approved' as const,
      reasonCode: 'SPOKEN_DIALOGUE',
      reviewer: 'integration-test',
      reviewedAt: NOW,
      policyCheckedAt: NOW,
    },
  };
}

interface CheckoutModel {
  readonly f001: F001BaselineBundle;
  readonly baseline: F001Baseline;
  readonly batches: readonly PublishableBatch[];
  readonly catalogs: Readonly<Record<string, BatchCatalogFragment>>;
}

const F001_ARTWORK = new TextEncoder().encode('f001-artwork');
const F001_AUDIO = new TextEncoder().encode('f001-audio');
const F001_PROVENANCE = new TextEncoder().encode('{"source":"f001"}\n');
const LICENSES = new TextEncoder().encode('{"licenses":[]}\n');
const F002_ARTWORK = pngFixture();
const F001_ARTWORK_PROVENANCE = new TextEncoder().encode(canonicalJson({
  schemaVersion: '1.0.0',
  manifestId: 'artwork-F001-integration',
  output: { path: 'artwork/f001.png', sha256: sha(F001_ARTWORK) },
}));
const F002_ARTWORK_PROVENANCE_VALUE: ArtworkProvenanceV2 = {
  schemaVersion: '2.0.0',
  manifestId: 'artwork-F002-000081-integration',
  batchId: 'F002',
  authorId: '000081',
  creationMethod: 'original-generation',
  generatedOn: '2026-07-20',
  generation: {
    provider: 'OpenAI',
    tool: 'built-in image_gen',
    model: 'not exposed by built-in tool',
    modelVersion: 'not exposed by built-in tool',
    inputImageCount: 0,
    prompt: 'integration original prompt',
    promptSha256: sha('integration original prompt'),
    recipe: 'integration generated PNG copied byte-for-byte',
    recipeSha256: sha('integration generated PNG copied byte-for-byte'),
    providerTerms: {
      policyId: 'openai-terms',
      url: 'https://openai.com/policies/terms-of-use/',
      contentSha256: 'a'.repeat(64),
      fetchedAt: NOW,
      decisionSummary: 'provider termsを確認',
    },
  },
  inputAllowlist: [],
  inputs: [],
  credit: 'integration test original artwork',
  output: {
    sourcePath: 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png',
    publicPath: 'artwork/miyazawa-zundamon.png',
    sha256: sha(F002_ARTWORK),
    bytes: F002_ARTWORK.byteLength,
    mediaType: 'image/png',
    width: 1254,
    height: 1254,
    bitDepth: 8,
    colorType: 'RGB',
  },
  characterGuideline: {
    policyId: 'zundamon-character-guideline',
    url: 'https://zunko.jp/guideline.html',
    contentSha256: 'b'.repeat(64),
    fetchedAt: NOW,
    decisionSummary: '非公式ファンアート利用条件を確認',
    decision: 'allowed-original-fan-art',
  },
  humanReview: {
    reviewer: 'integration reviewer',
    reviewedAt: NOW,
    promptConformance: true,
    noRealPhotographOrIdentifiableFace: true,
    noThirdPartyMaterial: true,
    noThirdPartyDerivative: true,
    noTrademarkOrLogo: true,
    noTextSignatureOrWatermark: true,
    handsNatural: true,
    decision: 'approved',
    summary: '入力なし独自生成PNGを目視確認',
  },
};
const F002_ARTWORK_PROVENANCE = new TextEncoder().encode(canonicalJson(F002_ARTWORK_PROVENANCE_VALUE));
const F002_AUDIO = WORK_IDS.map((workId) => new TextEncoder().encode(`accepted-wave-${workId}`));
const F002_PROVENANCE = WORK_IDS.map((workId) => new TextEncoder().encode(canonicalJson({ source: workId })));
const F002_AUDIO_SHA = F002_AUDIO.map(sha);
const F002_CONFIG_SHA = WORK_IDS.map((workId) => sha(`config-${workId}`));

function manifest(): BatchManifest {
  return {
    batchId: 'F002',
    feature: 'F002',
    status: 'accepted',
    workIds: [...WORK_IDS],
    author: {
      authorId: '000081',
      name: 'みやざわずんじ',
      originalName: '宮沢賢治',
      slug: 'miyazawa-zunji',
      identitySha256: sha('author-f002'),
    },
    acceptedAt: NOW,
    artworkProvenanceRef: 'content/batches/F002/artwork-provenance.json',
  } as unknown as BatchManifest;
}

function model(root: string): CheckoutModel {
  const f001Works: CatalogV2['works'] = F001_WORK_IDS.map((workId, index) => ({
    workId,
    authorId: '000879',
    batchId: 'F001',
    title: `F001作品${index + 1}`,
    cardLink: `https://www.aozora.gr.jp/cards/000879/card${Number(workId)}.html`,
    source: {
      cardUrl: `https://www.aozora.gr.jp/cards/000879/card${Number(workId)}.html`,
      textUrl: `https://www.aozora.gr.jp/cards/000879/files/${Number(workId)}_1.html`,
      attribution: '青空文庫',
      baseEdition: '底本',
      inputter: '入力者',
      proofreader: '校正者',
      fetchedAt: NOW,
      transformation: '決定的変換',
      sourceSha256: sha(`f001-source-${workId}`),
      provenancePath: 'content/provenance/F001/source.json',
      provenanceSha256: sha(F001_PROVENANCE),
    },
    dialogues: Array.from({ length: index === 2 ? 19 : 20 }, (_, order) =>
      dialogue(workId, order, 'f001-audio')),
  }));
  const catalog: F001BaselineBundle['catalog'] = {
    schemaVersion: '2.0.0',
    authors: [{
      authorId: '000879',
      name: 'あくたがわずんのすけ',
      originalName: '芥川龍之介',
      slug: 'akutagawa-zunnosuke',
      artwork: { path: 'artwork/f001.png', alt: 'F001', sha256: sha(F001_ARTWORK) },
      introducedByBatchId: 'F001',
      identitySha256: sha('author-f001'),
    }],
    works: f001Works,
    audioAssets: [{
      audioId: 'f001-audio',
      batchId: 'F001',
      path: 'audio/F001/f001-audio.wav',
      sha256: sha(F001_AUDIO),
      bytes: F001_AUDIO.byteLength,
      durationMs: 1000,
      configHash: sha('f001-config'),
    }],
    batches: [],
    candidateCounts: {
      total: 59,
      published: 59,
      editorialExcluded: 0,
      audioExcluded: 0,
      byBatch: { F001: { total: 59, published: 59, editorialExcluded: 0, audioExcluded: 0 } },
    },
    creditsRef: 'content/licenses.json',
  };
  const files = [
    { path: 'artwork/f001.png', bytes: F001_ARTWORK },
    { path: 'audio/F001/f001-audio.wav', bytes: F001_AUDIO },
    { path: 'content/provenance/F001/source.json', bytes: F001_PROVENANCE },
    { path: 'content/licenses.json', bytes: LICENSES },
    { path: 'content/artwork-provenance.json', bytes: F001_ARTWORK_PROVENANCE },
  ].map(({ path, bytes }) => ({
    path: path as WorkspaceRelativePath,
    sha256: sha(bytes),
    bytes: bytes.byteLength,
  }));
  const f001: F001BaselineBundle = {
    sourceRoot: join(root, 'baseline'),
    files,
    catalog,
    syntheticBatch: {
      batchId: 'F001',
      feature: 'F001',
      status: 'published',
      authorId: '000879',
      workIds: [...F001_WORK_IDS],
      acceptedAt: NOW,
      publishedAt: NOW,
      evidenceSha256: sha('f001-evidence'),
    },
    baselineSha256: sha('synthetic-f001-baseline'),
  };

  const batchManifest = manifest();
  const acceptedAudioSources = WORK_IDS.map((workId, index) => ({
    path: `content/batches/F002/accepted-audio/${workId}/${F002_AUDIO_SHA[index]}.wav` as WorkspaceRelativePath,
    sha256: F002_AUDIO_SHA[index]!,
    bytes: F002_AUDIO[index]!.byteLength,
    configHash: F002_CONFIG_SHA[index]!,
  }));
  const f002Works: CatalogV2['works'] = WORK_IDS.map((workId, index) => ({
    workId,
    authorId: '000081',
    batchId: 'F002',
    title: `F002作品${index + 1}`,
    cardLink: `https://www.aozora.gr.jp/cards/000081/card${Number(workId)}.html`,
    source: {
      cardUrl: `https://www.aozora.gr.jp/cards/000081/card${Number(workId)}.html`,
      textUrl: `https://www.aozora.gr.jp/cards/000081/files/${Number(workId)}_1.html`,
      attribution: '青空文庫',
      baseEdition: '底本',
      inputter: '入力者',
      proofreader: '校正者',
      fetchedAt: NOW,
      transformation: '決定的変換',
      sourceSha256: sha(`f002-source-${workId}`),
      provenancePath: `content/provenance/F002/${workId}.json`,
      provenanceSha256: sha(F002_PROVENANCE[index]!),
    },
    dialogues: [dialogue(workId, 0, F002_AUDIO_SHA[index]!)],
  }));
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']> = [
    {
      source: 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png' as WorkspaceRelativePath,
      publicPath: 'artwork/miyazawa-zundamon.png' as WorkspaceRelativePath,
      sha256: sha(F002_ARTWORK),
      bytes: F002_ARTWORK.byteLength,
    },
    ...WORK_IDS.map((workId, index) => ({
      source: `content/batches/F002/public-files/provenance/${workId}.json` as WorkspaceRelativePath,
      publicPath: `content/provenance/F002/${workId}.json` as WorkspaceRelativePath,
      sha256: sha(F002_PROVENANCE[index]!),
      bytes: F002_PROVENANCE[index]!.byteLength,
    })),
  ];
  const fragment: BatchCatalogFragment = {
    authors: [{
      ...batchManifest.author,
      artwork: { path: 'artwork/miyazawa-zundamon.png', alt: 'F002', sha256: sha(F002_ARTWORK) },
      introducedByBatchId: 'F002',
    }],
    works: f002Works,
    audioAssets: WORK_IDS.map((_, index) => ({
      audioId: F002_AUDIO_SHA[index]!,
      batchId: 'F002',
      path: `audio/F002/${F002_AUDIO_SHA[index]}.wav`,
      sha256: F002_AUDIO_SHA[index]!,
      bytes: F002_AUDIO[index]!.byteLength,
      durationMs: 1000,
      configHash: F002_CONFIG_SHA[index]!,
    })),
    candidateCounts: { total: 3, published: 3, editorialExcluded: 0, audioExcluded: 0 },
    publicFiles,
  };
  return {
    f001,
    baseline: {
      baselineSha256: f001.baselineSha256,
      catalog: catalog as F001Baseline['catalog'],
      files,
    },
    batches: [{
      manifest: batchManifest,
      manifestPath: 'content/batches/F002/batch.json' as WorkspaceRelativePath,
      manifestSha256: sha(canonicalJson(batchManifest)),
      candidate: true,
      acceptedAudioSources,
    }],
    catalogs: { F002: fragment },
  };
}

async function writeSourceRepository(root: string): Promise<void> {
  const writes: Array<[string, Uint8Array | string]> = [
    ['.gitattributes', '* -text\n'],
    ['.gitignore', '.cache/\ndist/\n'],
    ['index.html', '<main id="app"></main>'],
    ['package.json', '{"name":"clean-release-fixture","private":true}'],
    ['package-lock.json', '{"name":"clean-release-fixture","lockfileVersion":3}'],
    ['src/main.ts', 'document.querySelector("#app");'],
    ['baseline/artwork/f001.png', F001_ARTWORK],
    ['baseline/audio/F001/f001-audio.wav', F001_AUDIO],
    ['baseline/content/provenance/F001/source.json', F001_PROVENANCE],
    ['baseline/content/licenses.json', LICENSES],
    ['baseline/content/artwork-provenance.json', F001_ARTWORK_PROVENANCE],
    ['content/batches/F002/batch.json', canonicalJson(manifest())],
    ['content/batches/F002/artwork-provenance.json', F002_ARTWORK_PROVENANCE],
    ['content/batches/F002/public-files/artwork/miyazawa-zundamon.png', F002_ARTWORK],
    ...WORK_IDS.map((workId, index) =>
      [`content/batches/F002/accepted-audio/${workId}/${F002_AUDIO_SHA[index]}.wav`, F002_AUDIO[index]!] as [string, Uint8Array]),
    ...WORK_IDS.map((workId, index) =>
      [`content/batches/F002/public-files/provenance/${workId}.json`, F002_PROVENANCE[index]!] as [string, Uint8Array]),
  ];
  for (const [path, bytes] of writes) {
    const target = join(root, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Integration Test'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'integration@example.invalid'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'source inputs'], { cwd: root });
}

async function commit(root: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return stdout.trim();
}

async function cloneAt(source: string, target: string, revision: string): Promise<void> {
  await execFile('git', ['clone', '--quiet', '--no-hardlinks', source, target]);
  await execFile('git', ['checkout', '--quiet', '--detach', revision], { cwd: target });
}

const pagesAdapter: PagesBuildAdapter = {
  toolFile: import.meta.filename,
  async build(_appSource, publicRoot, outputRoot) {
    await cp(publicRoot, outputRoot, { recursive: true });
    await mkdir(join(outputRoot, 'assets'), { recursive: true });
    await writeFile(join(outputRoot, 'index.html'), '<main id="app"></main>');
    await writeFile(join(outputRoot, '.nojekyll'), '');
    await writeFile(join(outputRoot, 'assets', 'app.js'), 'document.querySelector("#app");');
    await writeFile(join(outputRoot, 'assets', 'app.css'), 'main{display:block}');
  },
};

function candidate(releaseCommit: string, pages: PagesDistPreview, artifactDigest: Sha256): ReleaseBuildContext {
  return {
    releaseCandidateBatchId: F002_BATCH_ID,
    feature: 'F002',
    releaseCommit,
    distSha256: pages.distSha256,
    artifactDigest,
  };
}

function evidence(release: ReleaseBuildContext, result = 'pass') {
  return { result, candidate: release };
}

async function acceptanceContext(
  release: ReleaseBuildContext,
  checkoutModel: CheckoutModel,
  capacity: ReleaseActualCapacityReport | Record<string, unknown>,
) {
  return {
    now: NOW,
    releaseBuild: release,
    checkout: {
      status: 'clean',
      releaseVerifyStatus: 'completed',
      headSha: release.releaseCommit,
      releaseCommit: release.releaseCommit,
    },
    authors: [{ authorId: '000879' }, { authorId: '000081' }],
    batches: [
      { batchId: 'F001', feature: 'F001', status: 'published' },
      { batchId: 'F002', feature: 'F002', status: 'accepted' },
    ],
    works: WORK_IDS.map((workId, index) => ({
      workId,
      status: 'accepted',
      pendingCount: 0,
      acceptedAudioSources: [checkoutModel.batches[0]!.acceptedAudioSources[index]!],
    })),
    voiceEvidence: WORK_IDS.map((workId) => ({ ...evidence(release), workId, acceptedAudioCount: 1 })),
    f001: {
      baseline: evidence(release),
      contentInvariant: evidence(release),
      distInvariant: { ...evidence(release), distSha256: release.distSha256, artifactDigest: release.artifactDigest },
    },
    rights: { selection: evidence(release, 'unchanged'), predeploy: evidence(release, 'unchanged') },
    policy: {
      selection: { status: 'unchanged', candidate: release },
      predeploy: { status: 'changed-reviewed', candidate: release },
    },
    artwork: evidence(release),
    capacity,
    security: { status: 'pass', candidate: release },
    regression: {
      status: 'passed',
      unitTests: 337,
      browserTests: 78,
      f002Tests: 'passed',
      candidate: release,
    },
    browser: {
      status: 'passed',
      viewports: ['390x844', '844x390', '1440x900'],
      accessibility: ['keyboard', 'screen-reader', 'reduced-motion'],
      manualBrowsers: ['Windows Chrome', 'Windows Edge', 'iOS Safari'],
      automatedBrowsers: ['chromium', 'firefox', 'webkit', 'android-viewport'],
      candidate: release,
    },
    qtEvidence: Array.from({ length: 14 }, (_, index) => ({
      id: `QT-F002-${String(index + 1).padStart(3, '0')}`,
      status: 'passed',
      ...release,
      executedAt: NOW,
      evidenceRefs: [`docs/evidence/qt/QT-F002-${index + 1}.json`],
    })),
  };
}

interface Pipeline {
  readonly root: string;
  readonly sourceRepository: string;
  readonly sourceCheckout: string;
  readonly releaseCheckout: string;
  readonly sourceCommit: string;
  readonly releaseCommit: string;
  readonly release: ReleaseBuildContext;
  readonly pages: PagesDistPreview;
  readonly checkoutModel: CheckoutModel;
  readonly capacity: ReleaseActualCapacityReport;
}

let pipeline: Pipeline;

// Direct trace tags: IT-F002-002 IT-F002-007 IT-F002-008 IT-F002-015 IT-F002-018
// Qualification trace tags: QT-F002-001 QT-F002-012
describe('F002 exact-clean release chain integration', () => {
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'f002-clean-release-'));
    const sourceRepository = join(root, 'repository');
    const sourceCheckout = join(root, 'source-checkout');
    const releaseCheckout = join(root, 'release-checkout');
    await mkdir(sourceRepository);
    await writeSourceRepository(sourceRepository);
    const sourceCommit = await commit(sourceRepository);
    await cloneAt(sourceRepository, sourceCheckout, sourceCommit);

    const sourceModel = model(sourceCheckout);
    const prepareStage = join(sourceCheckout, '.cache', 'prepare-content');
    await mkdir(prepareStage, { recursive: true });
    const prepared = await buildIntegratedPublicTree(sourceModel.batches, sourceModel.f001, prepareStage, {
      mode: 'prepare-release',
      workspaceRoot: sourceCheckout,
      batchCatalogs: sourceModel.catalogs,
    }, undefined, {
      releaseCandidateBatchId: F002_BATCH_ID,
      feature: 'F002',
      sourceCommit,
    });
    const preparedCatalog = JSON.parse(await readFile(join(prepareStage, 'content', 'catalog.json'), 'utf8')) as CatalogV2;
    await verifyF001Invariant(preparedCatalog, prepareStage, sourceModel.baseline);
    const prepareDist = join(sourceCheckout, '.cache', 'prepare-dist');
    await mkdir(prepareDist);
    const preparedPages = await buildPagesPreview(prepared, sourceCheckout, prepareDist, true, { adapter: pagesAdapter });
    const artifactDigest = sha(canonicalJson({
      distSha256: preparedPages.distSha256,
      files: preparedPages.files,
    }));

    await cp(prepareStage, join(sourceRepository, 'public'), { recursive: true });
    await execFile('git', ['add', 'public'], { cwd: sourceRepository });
    await execFile('git', ['commit', '-m', 'release candidate'], { cwd: sourceRepository });
    const releaseCommit = await commit(sourceRepository);
    await cloneAt(sourceRepository, releaseCheckout, releaseCommit);

    const checkoutModel = model(releaseCheckout);
    const releaseStage = join(releaseCheckout, '.cache', 'release-content');
    await mkdir(releaseStage, { recursive: true });
    const releaseContext = candidate(releaseCommit, preparedPages, artifactDigest);
    const released = await buildIntegratedPublicTree(checkoutModel.batches, checkoutModel.f001, releaseStage, {
      mode: 'release-verify',
      workspaceRoot: releaseCheckout,
      batchCatalogs: checkoutModel.catalogs,
      trackedPublicRoot: join(releaseCheckout, 'public'),
    }, undefined, undefined, releaseContext);
    const releaseCatalog = JSON.parse(await readFile(join(releaseStage, 'content', 'catalog.json'), 'utf8')) as CatalogV2;
    const contentInvariant = await verifyF001Invariant(releaseCatalog, releaseStage, checkoutModel.baseline);
    const releaseDist = join(releaseCheckout, '.cache', 'release-dist');
    await mkdir(releaseDist);
    const pages = await buildPagesPreview(released, releaseCheckout, releaseDist, true, { adapter: pagesAdapter });
    expect(pages.distSha256).toBe(preparedPages.distSha256);
    await verifyF001DistInvariant(pages, checkoutModel.baseline, contentInvariant);
    const capacity = await verifyActualCapacity({
      phase: 'release',
      releaseCandidateBatchId: 'F002',
      feature: 'F002',
      releaseCommit,
      artifactDigest,
      contentBuildSha256: released.buildSha256,
      contentStagingSha256: contentInvariant.stagingSha256,
      workspaceRoot: releaseCheckout,
      repositoryRoot: releaseCheckout,
      additionalAudioFiles: checkoutModel.batches[0]!.acceptedAudioSources.map((source) =>
        join(releaseCheckout, ...source.path.split('/'))),
      repositoryCandidateFiles: [],
      disk: { liveWriteUpperBounds: 1, rollbackBackupBytes: 1, freeBytes: 1_000_000_000 },
    }, pages);
    pipeline = {
      root,
      sourceRepository,
      sourceCheckout,
      releaseCheckout,
      sourceCommit,
      releaseCommit,
      release: releaseContext,
      pages,
      checkoutModel,
      capacity,
    };
  }, 30_000);

  afterAll(async () => {
    if (pipeline?.root) await rm(pipeline.root, { recursive: true, force: true });
  });

  it('accepted sourceからCatalogV2、offline dist、F001不変、actual容量、受入tupleまで接続する', async () => {
    // @ts-expect-error release-checks.mjsは本番JavaScript adapterで型宣言を持たない
    const { acceptF002Release } = await import('../../scripts/release-checks.mjs') as {
      acceptF002Release(context: unknown): Promise<unknown>;
    };
    expect(pipeline.capacity).toMatchObject({
      evidenceKind: 'actual',
      phase: 'release',
      result: 'pass',
      ...pipeline.release,
    });
    await expect(acceptF002Release(
      await acceptanceContext(pipeline.release, pipeline.checkoutModel, pipeline.capacity),
    )).resolves.toEqual({ status: 'ready_for_approval', ...pipeline.release });
  });

  it('dirty checkoutとsource/release commit混在をfail-closedにする', async () => {
    const dirty = join(pipeline.root, 'dirty-checkout');
    await cloneAt(pipeline.sourceRepository, dirty, pipeline.releaseCommit);
    await writeFile(join(dirty, 'content', 'batches', 'F002', 'batch.json'), `${canonicalJson(manifest())}\n`);
    const dirtyModel = model(dirty);
    const dirtyStage = join(dirty, '.cache', 'dirty-stage');
    await mkdir(dirtyStage, { recursive: true });
    await expect(buildIntegratedPublicTree(dirtyModel.batches, dirtyModel.f001, dirtyStage, {
      mode: 'release-verify',
      workspaceRoot: dirty,
      batchCatalogs: dirtyModel.catalogs,
      trackedPublicRoot: join(dirty, 'public'),
    }, undefined, undefined, pipeline.release)).rejects.toMatchObject({ code: 'PUBLIC_CLEAN_CHECKOUT_REQUIRED' });

    const mixedStage = join(pipeline.releaseCheckout, '.cache', 'mixed-stage');
    await mkdir(mixedStage);
    await expect(buildIntegratedPublicTree(
      pipeline.checkoutModel.batches,
      pipeline.checkoutModel.f001,
      mixedStage,
      {
        mode: 'release-verify',
        workspaceRoot: pipeline.releaseCheckout,
        batchCatalogs: pipeline.checkoutModel.catalogs,
        trackedPublicRoot: join(pipeline.releaseCheckout, 'public'),
      },
      undefined,
      undefined,
      { ...pipeline.release, releaseCommit: pipeline.sourceCommit },
    )).rejects.toMatchObject({ code: 'PUBLIC_CLEAN_CHECKOUT_REQUIRED' });
  });

  it('work-preview容量レポート流用を受入で拒否する', async () => {
    // @ts-expect-error release-checks.mjsは本番JavaScript adapterで型宣言を持たない
    const { acceptF002Release } = await import('../../scripts/release-checks.mjs') as {
      acceptF002Release(context: unknown): Promise<{ status: string; blockers?: string[] }>;
    };
    const reused = { ...pipeline.capacity, phase: 'work-preview' };
    const result = await acceptF002Release(await acceptanceContext(pipeline.release, pipeline.checkoutModel, reused));
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.blockers).toContain('ACCEPT_CAPACITY_BLOCKED');
  });

  it('accepted WAVの宣言SHA改変を実体照合で拒否する', async () => {
    const firstSource = pipeline.checkoutModel.batches[0]!.acceptedAudioSources[0]!;
    const alteredSha = sha('altered-declaration');
    const alteredBatches: readonly PublishableBatch[] = [{
      ...pipeline.checkoutModel.batches[0]!,
      acceptedAudioSources: [
        { ...firstSource, sha256: alteredSha },
        ...pipeline.checkoutModel.batches[0]!.acceptedAudioSources.slice(1),
      ],
    }];
    const originalFragment = pipeline.checkoutModel.catalogs.F002!;
    const alteredCatalogs = {
      F002: {
        ...originalFragment,
        audioAssets: originalFragment.audioAssets.map((asset, index) =>
          index === 0 ? { ...asset, sha256: alteredSha } : asset),
      },
    };
    const alteredStage = join(pipeline.releaseCheckout, '.cache', 'altered-sha-stage');
    await mkdir(alteredStage);
    await expect(buildIntegratedPublicTree(
      alteredBatches,
      pipeline.checkoutModel.f001,
      alteredStage,
      {
        mode: 'release-verify',
        workspaceRoot: pipeline.releaseCheckout,
        batchCatalogs: alteredCatalogs,
        trackedPublicRoot: join(pipeline.releaseCheckout, 'public'),
      },
      undefined,
      undefined,
      pipeline.release,
    )).rejects.toMatchObject({ code: 'PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH' });
  });
});
