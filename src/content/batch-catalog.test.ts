import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  createBatchManifestFromApprovedContext,
  loadAndVerifyBatchCandidate,
  type ApprovedBatchContext,
  type VerifiedBatchDefinition,
} from './batch-candidate.ts';
import {
  BatchCatalogError,
  loadPublishedVerifiedBatchDefinition,
  loadVerifiedIncludedBatchWork,
  loadVerifiedAuthorIntroduction,
  mergeExistingAuthorCatalog,
  prepareBatchWorkPreview,
  probeRuntimeAudioController,
  projectBatchCatalogFragment,
  validateNoticesAndInitialState,
  verifyReusedArtwork,
  type FinalCatalog,
  type FinalCatalogFragment,
  type IncludedBatchWork,
} from './batch-catalog.ts';
import { F004_V030_PINS, loadPublishedV030Baseline, type PublishedV030Baseline } from './f004-baseline.ts';
import {
  F002_PUBLISHED_RELEASE,
  loadAndVerifyPublishedBaseline,
  type PublishedBaselineBundle,
} from './published-baseline.ts';
import {
  createNextBatchTemplate,
  hashBatchManifest,
  type BatchManifest,
  type WorkspaceRelativePath,
} from './batch.ts';
import { canonicalJson } from './artifacts.ts';
import { WORK_NOTICE_TEXT } from '../notices/work-notice-text.ts';

const workspace = resolve('.');
let context: ApprovedBatchContext;
let baseline: PublishedV030Baseline;
let manifest: BatchManifest;
let fixtureRoot: string;
let f003Definition: VerifiedBatchDefinition;
let f002Baseline: PublishedBaselineBundle;

function gates() {
  return {
    requirements: 'docs/srs/SRS-F004.md' as WorkspaceRelativePath,
    design: 'docs/design/DD-F004.md' as WorkspaceRelativePath,
    testspec: 'docs/tests/ut/UT-F004.md' as WorkspaceRelativePath,
    release: 'docs/evidence/release/F004-approval.json' as WorkspaceRelativePath,
  };
}

function wavFixture(): Uint8Array {
  const dataBytes = 48;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

async function prepared(
  lifecycles: readonly ('accepted' | 'staged')[],
  options: Readonly<{ firstAudioPath?: string }> = {},
): Promise<{ works: IncludedBatchWork[]; boundManifest: BatchManifest }> {
  const sourceWorks = baseline.catalog.works.filter(
    (work) => work.authorId === context.definition.author.authorId,
  );
  const sourceIndex = JSON.parse(
    await readFile(join(fixtureRoot, 'content', 'batches', 'F004', 'source-index.json'), 'utf8'),
  ) as { works: Array<Record<string, unknown>> };
  const artifacts = await Promise.all(lifecycles.map(async (lifecycle, index) => {
    const source = structuredClone(sourceWorks[index]!);
    const definitionWork = context.definition.works[index]!;
    const sourceEntry = sourceIndex.works[index]!;
    const provenancePath =
      `data/batches/F004/fixed-sources/${definitionWork.workId}/${definitionWork.workId}/provenance.json`;
    const provenance = await readFile(join(fixtureRoot, ...provenancePath.split('/')));
    const provenanceValue = JSON.parse(provenance.toString()) as {
      transformation: string;
    };
    const record = JSON.parse(await readFile(
      join(fixtureRoot, ...(sourceEntry.recordPath as string).split('/')),
      'utf8',
    )) as Record<string, unknown>;
    const dialogueId = `dialogue-${definitionWork.workId}`;
    const audioId = `audio-${definitionWork.workId}`;
    const wav = wavFixture();
    const audioPath = index === 0 && options.firstAudioPath
      ? options.firstAudioPath
      : `audio/F004/${audioId}.wav`;
    await mkdir(dirname(join(fixtureRoot, ...`public/${audioPath}`.split('/'))), { recursive: true });
    await writeFile(join(fixtureRoot, ...`public/${audioPath}`.split('/')), wav);
    const templateDialogue = structuredClone(source.dialogues[0]!);
    const value = {
      schemaVersion: '1.0.0',
      batchId: context.definition.batchId,
      workId: definitionWork.workId,
      lifecycle,
      work: {
        ...source,
        workId: definitionWork.workId,
        title: definitionWork.title,
        cardLink: definitionWork.cardUrl,
        authorId: context.definition.author.authorId,
        batchId: context.definition.batchId,
        source: {
          ...source.source,
          cardUrl: definitionWork.cardUrl,
          textUrl: definitionWork.xhtmlUrl,
          attribution: '青空文庫',
          baseEdition: sourceEntry.baseEdition,
          inputter: sourceEntry.inputter,
          proofreader: sourceEntry.proofreader,
          fetchedAt: sourceEntry.fetchedAt,
          transformation: provenanceValue.transformation,
          sourceSha256: sourceEntry.rawSha256,
          provenancePath,
          provenanceSha256: createHash('sha256').update(provenance).digest('hex'),
          bibliographyCharset: sourceEntry.bibliographyCharset,
          bodySelector: '.main_text',
          rawBytes: sourceEntry.rawBytes,
          rawSha256: sourceEntry.rawSha256,
          canonicalSourceSha256: createHash('sha256').update(canonicalJson({
            work: sourceEntry,
            record,
            bodySelector: '.main_text',
          })).digest('hex'),
          sourceUpdatedAt: sourceEntry.sourceUpdatedAt,
        },
        notices: [{
          textKey: 'dialogue-excerpt-scope',
          placements: ['work-list', 'work-detail', 'credits'],
        }],
        completionStatus: 'complete',
        dialogues: [{
          ...templateDialogue,
          dialogueId,
          workId: definitionWork.workId,
          audioId,
          review: {
            ...templateDialogue.review,
            candidateId: dialogueId,
            workId: definitionWork.workId,
            status: 'approved',
          },
          sourceAnchor: { ...templateDialogue.sourceAnchor, bodySelector: '.main_text' },
        }],
      },
      audioAssets: [{
        audioId,
        batchId: context.definition.batchId,
        path: audioPath,
        sha256: createHash('sha256').update(wav).digest('hex'),
        bytes: wav.byteLength,
        durationMs: 1,
        configHash: 'a'.repeat(64),
        candidateIds: [dialogueId],
      }],
      candidateCounts: {
        total: 1,
        published: 1,
        editorialExcluded: 0,
        audioExcluded: 0,
        editorialReasons: {},
        audioFailureReasons: {},
      },
    };
    const raw = canonicalJson(value);
    const artifactRef = `artifacts/${definitionWork.workId}.json`;
    await mkdir(join(fixtureRoot, 'artifacts'), { recursive: true });
    await writeFile(join(fixtureRoot, ...artifactRef.split('/')), raw, 'utf8');
    return {
      artifactRef,
      sha256: createHash('sha256').update(raw).digest('hex'),
      lifecycle,
      audioSha256: createHash('sha256').update(wav).digest('hex'),
      audioBytes: wav.byteLength,
      configHash: 'a'.repeat(64),
      audioId,
    };
  }));
  const bound = structuredClone(manifest) as unknown as {
    status: string;
    acceptedAt?: string;
    acceptedBy?: string;
    workProgress: Array<{
      workId: string;
      status: string;
      stageRecords: Array<Record<string, unknown>>;
      acceptedAt?: string;
      acceptedBy?: string;
      acceptedAudioSources?: Array<Record<string, unknown>>;
    }>;
  };
  artifacts.forEach((artifact, index) => {
    const progress = bound.workProgress[index]!;
    progress.status = artifact.lifecycle === 'accepted' ? 'accepted' : 'voiced';
    bound.workProgress[index]!.stageRecords = [{
      stage: artifact.lifecycle === 'accepted' ? 'accepted' : 'voiced',
      inputHashes: [],
      toolVersion: 'test',
      outputHashes: [artifact.sha256],
      count: 1,
      completedAt: '2026-07-27T00:00:00Z',
    }];
    if (artifact.lifecycle === 'accepted') {
      progress.acceptedAt = '2026-07-27T00:00:00Z';
      progress.acceptedBy = 'test';
      progress.acceptedAudioSources = [{
        path: `content/batches/F004/accepted-audio/${progress.workId}/${artifact.audioId}.wav`,
        sha256: artifact.audioSha256,
        bytes: artifact.audioBytes,
        configHash: artifact.configHash,
      }];
    }
  });
  if (lifecycles.length === 3 && lifecycles.every((value) => value === 'accepted')) {
    bound.status = 'accepted';
    bound.acceptedAt = '2026-07-27T00:00:00Z';
    bound.acceptedBy = 'test';
  } else if (lifecycles.length === 3) {
    bound.status = 'voiced';
  }
  const boundManifest = bound as unknown as BatchManifest;
  const manifestSha = hashBatchManifest(boundManifest);
  const works = await Promise.all(artifacts.map((artifact) =>
    loadVerifiedIncludedBatchWork(
      fixtureRoot,
      context.definition,
      boundManifest,
      manifestSha,
      artifact.artifactRef,
      artifact.sha256 as never,
    )));
  return { works, boundManifest };
}

async function preparedF003(): Promise<{
  work: IncludedBatchWork;
  boundManifest: BatchManifest;
}> {
  const definitionWork = f003Definition.works[0]!;
  const rawBytes = new TextEncoder().encode('<div class="main_text">「台詞」</div>');
  const rawSha = createHash('sha256').update(rawBytes).digest('hex');
  const base = `data/batches/${f003Definition.batchId}/fixed-sources/${definitionWork.workId}/${definitionWork.workId}`;
  await mkdir(join(fixtureRoot, ...base.split('/')), { recursive: true });
  await mkdir(join(fixtureRoot, 'content', 'batches', f003Definition.batchId), { recursive: true });
  const provenancePath = `${base}/provenance.json`;
  const sourceMetadata = {
    baseEdition: '女生徒',
    bibliographyCharset: 'UTF-8',
    fetchedAt: '2026-07-28T00:00:00Z',
    inputter: '入力者',
    proofreader: '校正者',
    sourceUpdatedAt: '2026-07-28',
  };
  const provenanceValue = {
    baseEdition: sourceMetadata.baseEdition,
    bibliography: {},
    changeNotice: '加工内容',
    fetchedAt: sourceMetadata.fetchedAt,
    inputter: sourceMetadata.inputter,
    proofreader: sourceMetadata.proofreader,
    sourceSha256: rawSha,
    sourceUrl: definitionWork.xhtmlUrl,
    stableCardUrl: definitionWork.cardUrl,
    toolVersion: 'test',
    transformation: '青空文庫公式XHTMLから台詞を抽出',
    workId: definitionWork.workId,
  };
  const provenanceRaw = canonicalJson(provenanceValue);
  await writeFile(join(fixtureRoot, ...provenancePath.split('/')), provenanceRaw, 'utf8');
  const rawPath = `${base}/source.raw`;
  const recordPath = `${base}/source.json`;
  await writeFile(join(fixtureRoot, ...rawPath.split('/')), rawBytes);
  const record = {
    bibliographyCharset: sourceMetadata.bibliographyCharset,
    fetchedAt: sourceMetadata.fetchedAt,
    httpCharset: 'UTF-8',
    mediaType: 'text/html',
    rawPath: `${definitionWork.workId}/source.raw`,
    workId: definitionWork.workId,
    rawSha256: rawSha,
    sourceUrl: definitionWork.xhtmlUrl,
  };
  await writeFile(join(fixtureRoot, ...recordPath.split('/')), canonicalJson(record), 'utf8');
  const indexWork = {
    ...sourceMetadata,
    workId: definitionWork.workId,
    title: definitionWork.title,
    cardUrl: definitionWork.cardUrl,
    sourceUrl: definitionWork.xhtmlUrl,
    rawPath,
    recordPath,
    rawSha256: rawSha,
    rawBytes: rawBytes.byteLength,
  };
  await writeFile(
    join(fixtureRoot, 'content', 'batches', f003Definition.batchId, 'source-index.json'),
    canonicalJson({
      schemaVersion: '1.0.0',
      batchId: f003Definition.batchId,
      bodySelector: '.main_text',
      rightsRef: `content/batches/${f003Definition.batchId}/rights-selection.json`,
      works: [indexWork],
    }),
    'utf8',
  );
  const templateWork = structuredClone(f002Baseline.catalog.works[0]!);
  const templateDialogue = structuredClone(templateWork.dialogues[0]!);
  const dialogueId = 'dialogue-f003';
  const audioId = 'audio-f003';
  const wav = wavFixture();
  const audioPath = `audio/${f003Definition.batchId}/${audioId}.wav`;
  await mkdir(join(fixtureRoot, 'public', 'audio', f003Definition.batchId), { recursive: true });
  await writeFile(join(fixtureRoot, ...`public/${audioPath}`.split('/')), wav);
  const artifact = {
    schemaVersion: '1.0.0',
    batchId: f003Definition.batchId,
    workId: definitionWork.workId,
    lifecycle: 'staged',
    work: {
      ...templateWork,
      workId: definitionWork.workId,
      title: definitionWork.title,
      cardLink: definitionWork.cardUrl,
      authorId: f003Definition.author.authorId,
      batchId: f003Definition.batchId,
      source: {
        ...templateWork.source,
        cardUrl: definitionWork.cardUrl,
        textUrl: definitionWork.xhtmlUrl,
        attribution: '青空文庫',
        baseEdition: sourceMetadata.baseEdition,
        inputter: sourceMetadata.inputter,
        proofreader: sourceMetadata.proofreader,
        fetchedAt: sourceMetadata.fetchedAt,
        transformation: provenanceValue.transformation,
        sourceSha256: rawSha,
        provenancePath,
        provenanceSha256: createHash('sha256').update(provenanceRaw).digest('hex'),
        bibliographyCharset: sourceMetadata.bibliographyCharset,
        bodySelector: '.main_text',
        rawBytes: rawBytes.byteLength,
        rawSha256: rawSha,
        canonicalSourceSha256: createHash('sha256').update(canonicalJson({
          work: indexWork,
          record,
          bodySelector: '.main_text',
        })).digest('hex'),
        sourceUpdatedAt: sourceMetadata.sourceUpdatedAt,
      },
      dialogues: [{
        ...templateDialogue,
        dialogueId,
        workId: definitionWork.workId,
        audioId,
        review: {
          ...templateDialogue.review,
          candidateId: dialogueId,
          workId: definitionWork.workId,
          status: 'approved',
        },
        sourceAnchor: { ...templateDialogue.sourceAnchor, bodySelector: '.main_text' },
      }],
    },
    audioAssets: [{
      audioId,
      batchId: f003Definition.batchId,
      path: audioPath,
      sha256: createHash('sha256').update(wav).digest('hex'),
      bytes: wav.byteLength,
      durationMs: 1,
      configHash: 'a'.repeat(64),
      candidateIds: [dialogueId],
    }],
    candidateCounts: {
      total: 1,
      published: 1,
      editorialExcluded: 0,
      audioExcluded: 0,
      editorialReasons: {},
      audioFailureReasons: {},
    },
  };
  const artifactRaw = canonicalJson(artifact);
  const artifactSha = createHash('sha256').update(artifactRaw).digest('hex');
  const artifactRef = 'artifacts/f003-introduce.json';
  await mkdir(join(fixtureRoot, 'artifacts'), { recursive: true });
  await writeFile(join(fixtureRoot, ...artifactRef.split('/')), artifactRaw, 'utf8');
  const bound = structuredClone(createNextBatchTemplate({
    candidateId: f003Definition.batchId,
    approved: true,
    author: f003Definition.author,
    works: f003Definition.works,
    approvalGateRefs: gates(),
    existingFeatureIds: ['F001', 'F002'],
  }, f003Definition.batchId)) as unknown as {
    workProgress: Array<{ status: string; stageRecords: Array<Record<string, unknown>> }>;
  };
  bound.workProgress[0]!.status = 'voiced';
  bound.workProgress[0]!.stageRecords = [{
    stage: 'voiced',
    inputHashes: [],
    toolVersion: 'test',
    outputHashes: [artifactSha],
    count: 1,
    completedAt: '2026-07-28T00:00:00Z',
  }];
  const boundManifest = bound as unknown as BatchManifest;
  const manifestSha = hashBatchManifest(boundManifest);
  return {
    work: await loadVerifiedIncludedBatchWork(
      fixtureRoot,
      f003Definition,
      boundManifest,
      manifestSha,
      artifactRef,
      artifactSha as never,
    ),
    boundManifest,
  };
}

beforeAll(async () => {
  [context, baseline, f002Baseline] = await Promise.all([
    loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    ),
    loadPublishedV030Baseline(workspace, F004_V030_PINS),
    loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE),
  ]);
  f003Definition = await loadPublishedVerifiedBatchDefinition(
    workspace,
    BATCH_DEFINITION_REFS.F003.ref,
    BATCH_DEFINITION_REFS.F003.sha256,
    baseline,
  );
  manifest = createBatchManifestFromApprovedContext(context, gates());
  fixtureRoot = await mkdtemp(join(tmpdir(), 'f004-catalog-'));
  await mkdir(join(fixtureRoot, 'content', 'batches', 'F004'), { recursive: true });
  await mkdir(join(fixtureRoot, 'data', 'batches', 'F004'), { recursive: true });
  await cp(
    join(workspace, 'content', 'batches', 'F004', 'source-index.json'),
    join(fixtureRoot, 'content', 'batches', 'F004', 'source-index.json'),
  );
  await cp(
    join(workspace, 'data', 'batches', 'F004', 'fixed-sources'),
    join(fixtureRoot, 'data', 'batches', 'F004', 'fixed-sources'),
    { recursive: true },
  );
}, 30_000);

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe('generic batch Catalog pipeline', () => {
  /** @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @fun FUN-F004-022 @test IT-F004-012 */
  it('同じprojector/mergeでF003 introduceとF004 reuseを扱い意味的batch分岐を持たない', async () => {
    const introduction = await loadVerifiedAuthorIntroduction(
      workspace,
      f003Definition,
      baseline,
    );
    const fixture = await preparedF003();
    const fragment = projectBatchCatalogFragment(
      f003Definition,
      fixture.boundManifest,
      [fixture.work],
      f002Baseline,
      'work-preview',
      introduction,
    );
    expect(fragment).toMatchObject({
      authorContribution: 'introduce',
      authors: [{ authorId: f003Definition.author.authorId }],
    });
    const catalog = mergeExistingAuthorCatalog(f002Baseline, fragment);
    expect(catalog.authors).toHaveLength(f002Baseline.catalog.authors.length + 1);
    expect(() => projectBatchCatalogFragment(
      f003Definition,
      fixture.boundManifest,
      [fixture.work],
      f002Baseline,
      'work-preview',
    )).toThrow(expect.objectContaining({ code: 'BATCH_AUTHOR_IDENTITY_CONFLICT' }));
    expect(() => projectBatchCatalogFragment(
      f003Definition,
      fixture.boundManifest,
      [fixture.work],
      baseline,
      'work-preview',
      introduction,
    )).toThrow(expect.objectContaining({ code: 'BATCH_AUTHOR_IDENTITY_CONFLICT' }));
    const productionSource = await readFile(
      join(workspace, 'src', 'content', 'batch-catalog.ts'),
      'utf8',
    );
    expect(productionSource).not.toMatch(
      /(?:batchId|feature)\s*(?:===|!==)\s*['"]F(?:003|004)['"]/u,
    );
  });

  /** @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @ut UT-F004-021 */
  it('preview 1/2/3件とfinal 3件を別brandでmintし、F004 reuseではauthorsを追加しない', async () => {
    for (const count of [1, 2, 3]) {
      const lifecycles = Array.from({ length: count }, (_, index) =>
        index === count - 1 ? 'staged' as const : 'accepted' as const);
      const fixture = await prepared(lifecycles);
      const preview = projectBatchCatalogFragment(
        context.definition,
        fixture.boundManifest,
        fixture.works,
        baseline,
        'work-preview',
      );
      expect(preview.authors).toEqual([]);
      expect(preview.works).toHaveLength(count);
      expect(preview.__brand).toBe('WorkPreviewCatalogFragment');
      // @ts-expect-error preview fragmentをfinal fragmentへ代入できない
      const invalidFinal: FinalCatalogFragment = preview;
      expect(invalidFinal.mode).toBe('work-preview');
    }
    const finalFixture = await prepared(['accepted', 'accepted', 'accepted']);
    const final = projectBatchCatalogFragment(
      context.definition,
      finalFixture.boundManifest,
      finalFixture.works,
      baseline,
      'final',
    );
    expect(final.__brand).toBe('FinalCatalogFragment');
    expect(final.works).toHaveLength(3);
    const falseAccepted = await prepared(['accepted', 'staged']);
    expect(() => projectBatchCatalogFragment(
      context.definition,
      manifest,
      falseAccepted.works,
      baseline,
      'work-preview',
    )).toThrow(expect.objectContaining({ code: 'BATCH_AUTHOR_IDENTITY_CONFLICT' }));
  });

  /** @des DES-F004-007 @fun FUN-F004-022 @ut UT-F004-022 @test IT-F004-007 */
  it('宮沢の末尾へ3作品だけを追記し、他作者とauthors projectionを不変に保つ', async () => {
    const fixture = await prepared(['accepted', 'accepted', 'accepted']);
    const fragment = projectBatchCatalogFragment(
      context.definition,
      fixture.boundManifest,
      fixture.works,
      baseline,
      'final',
    );
    const catalog = mergeExistingAuthorCatalog(baseline, fragment);
    expect(catalog.__brand).toBe('FinalCatalog');
    expect(catalog.authors).toEqual(baseline.catalog.authors);
    const byAuthor = (authorId: string) => catalog.works.filter((work) => work.authorId === authorId);
    expect(byAuthor(context.definition.author.authorId).map((work) => work.workId).slice(-3))
      .toEqual(context.definition.workIds);
    for (const author of baseline.catalog.authors.filter(
      (entry) => entry.authorId !== context.definition.author.authorId,
    )) {
      expect(byAuthor(author.authorId)).toEqual(
        baseline.catalog.works.filter((work) => work.authorId === author.authorId),
      );
    }
    expect(() => mergeExistingAuthorCatalog(
      baseline,
      structuredClone(fragment),
    )).toThrow(expect.objectContaining<Partial<BatchCatalogError>>({
      code: 'BATCH_CATALOG_FRAGMENT_FORGED',
    }));
  });

  /** @des DES-F004-007 @fun FUN-F004-023 @ut UT-F004-023 */
  it('宮沢画像・provenance・creditのexact再利用と新規entry 0を検証する', async () => {
    const fixture = await prepared(['accepted', 'accepted', 'accepted']);
    const fragment = projectBatchCatalogFragment(
      context.definition,
      fixture.boundManifest,
      fixture.works,
      baseline,
      'final',
    );
    const catalog = mergeExistingAuthorCatalog(baseline, fragment);
    const author = baseline.catalog.authors.find(
      (entry) => entry.authorId === context.definition.author.authorId,
    )!;
    const publicFile = baseline.publicFiles.find(
      (entry) => entry.path === author.artwork.path,
    )!;
    expect(verifyReusedArtwork(baseline, catalog))
      .toMatchObject({ result: 'pass', newEntries: 0, bytes: publicFile.bytes });
    expect(() => verifyReusedArtwork(structuredClone(baseline), catalog))
      .toThrow(expect.objectContaining({ code: 'BATCH_ARTWORK_REUSE_MISMATCH' }));
  });

  /** @des DES-F004-008 @fun FUN-F004-024 @ut UT-F004-024 @test IT-F004-008 */
  it('3作品3配置の固定notice・初期open 0・実AudioController契約を検査する', async () => {
    const fixture = await prepared(['accepted', 'accepted', 'accepted']);
    const catalog = mergeExistingAuthorCatalog(
      baseline,
      projectBatchCatalogFragment(
        context.definition,
        fixture.boundManifest,
        fixture.works,
        baseline,
        'final',
      ),
    );
    const targetWorks = context.definition.workIds.map((workId) =>
      catalog.works.find((work) => work.workId === workId)!);
    document.body.replaceChildren();
    for (const work of targetWorks) {
      const panel = document.createElement('details');
      panel.className = 'work-panel';
      panel.dataset.workId = work.workId;
      document.body.append(panel);
      for (const placement of ['work-list', 'work-detail', 'credits'] as const) {
        const notice = document.createElement('p');
        notice.dataset.workId = work.workId;
        notice.dataset.noticeKey = 'dialogue-excerpt-scope';
        notice.dataset.noticePlacement = placement;
        notice.append(document.createTextNode(WORK_NOTICE_TEXT['dialogue-excerpt-scope']));
        document.body.append(notice);
      }
    }
    const probe = await probeRuntimeAudioController(catalog, document, context.definition);
    expect(validateNoticesAndInitialState(
      catalog,
      document,
      context.definition,
      probe,
    )).toMatchObject({
      result: 'pass',
      workCount: 3,
      noticeCount: 9,
      initialOpenPanels: 0,
      audio: {
        simultaneousMaximum: 1,
        routeCleanup: true,
        staleEventsIgnored: true,
        isolatedFailure: true,
      },
    });
    const panel = document.querySelector<HTMLDetailsElement>('details.work-panel')!;
    panel.open = true;
    expect(() => validateNoticesAndInitialState(catalog, document, context.definition, probe))
      .toThrow(expect.objectContaining({ code: 'BATCH_RUNTIME_CONTENT_INVALID' }));
    panel.open = false;

    const notice = document.querySelector<HTMLElement>('[data-notice-key]')!;
    notice.replaceChildren(document.createElement('span'));
    expect(() => validateNoticesAndInitialState(catalog, document, context.definition, probe))
      .toThrow(expect.objectContaining({ code: 'BATCH_RUNTIME_CONTENT_INVALID' }));
    notice.replaceChildren(document.createTextNode(WORK_NOTICE_TEXT['dialogue-excerpt-scope']));
    notice.dataset.noticePlacement = 'wrong';
    expect(() => validateNoticesAndInitialState(catalog, document, context.definition, probe))
      .toThrow(expect.objectContaining({ code: 'BATCH_RUNTIME_CONTENT_INVALID' }));
    notice.dataset.noticePlacement = 'work-list';
    expect(() => validateNoticesAndInitialState(
      catalog,
      document,
      context.definition,
      structuredClone(probe),
    ))
      .toThrow(expect.objectContaining({ code: 'BATCH_RUNTIME_CONTENT_INVALID' }));
    expect(() => validateNoticesAndInitialState(
      structuredClone(baseline.catalog),
      document,
      context.definition,
      probe,
    )).toThrow(expect.objectContaining({ code: 'BATCH_RUNTIME_CONTENT_INVALID' }));
  });

  /** @des DES-F004-007 @fun FUN-F004-022 @ut UT-F004-022 */
  it('compile-timeでfinal catalogとpreview catalogを相互代入不可にする', async () => {
    const fixture = await prepared(['staged']);
    const preview = mergeExistingAuthorCatalog(
      baseline,
      projectBatchCatalogFragment(
        context.definition,
        fixture.boundManifest,
        fixture.works,
        baseline,
        'work-preview',
      ),
    );
    // @ts-expect-error preview catalogをfinal catalogへ代入できない
    const invalidFinal: FinalCatalog = preview;
    expect(invalidFinal.mode).toBe('work-preview');
  });

  /** @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @ut UT-F004-021 */
  it('manifest canonical hashをloaderからprojectorまで固定し、A/B差替えと不正state machineを拒否する', async () => {
    const fixture = await prepared(['staged']);
    const manifestA = fixture.boundManifest;
    const manifestB = structuredClone(manifestA) as unknown as {
      workProgress: Array<{ stageRecords: Array<{ toolVersion: string }> }>;
    };
    manifestB.workProgress[0]!.stageRecords[0]!.toolVersion = 'different-valid-tool';
    expect(() => projectBatchCatalogFragment(
      context.definition,
      manifestB as unknown as BatchManifest,
      fixture.works,
      baseline,
      'work-preview',
    )).toThrow(expect.objectContaining({ code: 'BATCH_AUTHOR_IDENTITY_CONFLICT' }));

    const artifactRef = 'artifacts/000466.json';
    const artifactSha = createHash('sha256')
      .update(await readFile(join(fixtureRoot, ...artifactRef.split('/'))))
      .digest('hex');
    await expect(loadVerifiedIncludedBatchWork(
      fixtureRoot,
      context.definition,
      manifestA,
      '0'.repeat(64) as never,
      artifactRef,
      artifactSha as never,
    )).rejects.toMatchObject({ code: 'BATCH_ARTIFACT_INVALID' });

    const invalidState = structuredClone(manifestA) as unknown as {
      workProgress: Array<{ stageRecords: Array<{ stage: string }> }>;
    };
    invalidState.workProgress[0]!.stageRecords[0]!.stage = 'catalog-artifact';
    await expect(loadVerifiedIncludedBatchWork(
      fixtureRoot,
      context.definition,
      invalidState as unknown as BatchManifest,
      hashBatchManifest(invalidState as unknown as BatchManifest),
      artifactRef,
      artifactSha as never,
    )).rejects.toMatchObject({ code: 'BATCH_ARTIFACT_INVALID' });
  });

  /** @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @ut UT-F004-021 */
  it('source全projectionとaudio実体・candidate/dialogue joinの差替えを拒否する', async () => {
    type MutableArtifact = {
      work: {
        source: Record<string, unknown>;
        dialogues: Array<{ audioId: string; review: { workId: string } }>;
      };
      audioAssets: Array<{
        sha256: string;
        bytes: number;
        durationMs: number;
        configHash: string;
        candidateIds: string[];
      }>;
    };
    const rejected = async (
      lifecycle: 'staged' | 'accepted',
      mutate: (artifact: MutableArtifact) => void,
    ): Promise<void> => {
      const fixture = await prepared([lifecycle]);
      const artifactRef = 'artifacts/000466.json';
      const artifactPath = join(fixtureRoot, ...artifactRef.split('/'));
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as MutableArtifact;
      mutate(artifact);
      const raw = canonicalJson(artifact);
      await writeFile(artifactPath, raw, 'utf8');
      const artifactSha = createHash('sha256').update(raw).digest('hex');
      const bound = structuredClone(fixture.boundManifest) as unknown as {
        workProgress: Array<{ stageRecords: Array<{ outputHashes: string[] }> }>;
      };
      bound.workProgress[0]!.stageRecords[0]!.outputHashes = [artifactSha];
      await expect(loadVerifiedIncludedBatchWork(
        fixtureRoot,
        context.definition,
        bound as unknown as BatchManifest,
        hashBatchManifest(bound as unknown as BatchManifest),
        artifactRef,
        artifactSha as never,
      )).rejects.toMatchObject({ code: 'BATCH_ARTIFACT_INVALID' });
    };

    for (const field of ['attribution', 'baseEdition', 'inputter', 'proofreader'] as const) {
      await rejected('staged', (artifact) => { artifact.work.source[field] = 'F002 clone'; });
    }
    await rejected('staged', (artifact) => { artifact.audioAssets[0]!.sha256 = '0'.repeat(64); });
    await rejected('staged', (artifact) => { artifact.audioAssets[0]!.bytes += 1; });
    await rejected('staged', (artifact) => { artifact.audioAssets[0]!.durationMs += 1; });
    await rejected('accepted', (artifact) => { artifact.audioAssets[0]!.configHash = 'c'.repeat(64); });
    await rejected('staged', (artifact) => { artifact.audioAssets[0]!.candidateIds = ['orphan']; });
    await rejected('staged', (artifact) => { artifact.work.dialogues[0]!.audioId = 'orphan-audio'; });
    await rejected('staged', (artifact) => { artifact.work.dialogues[0]!.review.workId = '000473'; });
  });

  /** @des DES-F004-007 @fun FUN-F004-022 @ut UT-F004-022 */
  it('baseline既存audio pathとの衝突をIDが異なっても拒否する', async () => {
    const collisionPath = baseline.catalog.audioAssets[0]!.path;
    const fixture = await prepared(
      ['accepted', 'accepted', 'accepted'],
      { firstAudioPath: collisionPath },
    );
    const fragment = projectBatchCatalogFragment(
      context.definition,
      fixture.boundManifest,
      fixture.works,
      baseline,
      'final',
    );
    expect(() => mergeExistingAuthorCatalog(baseline, fragment))
      .toThrow(expect.objectContaining({ code: 'BATCH_CATALOG_ID_CONFLICT' }));
  });

  /** @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @fun FUN-F004-037 @ut UT-F004-021 @ut UT-F004-037 */
  it('F002 clone sourceを拒否し、canonical workから非破壊previewを構築する', async () => {
    const fixture = await prepared(['staged']);
    const baselineBefore = canonicalJson(baseline);
    const publicBefore = createHash('sha256').update(
      await readFile(join(fixtureRoot, 'public', fixture.works[0]!.audioAssets[0]!.path)),
    ).digest('hex');
    const preview = await prepareBatchWorkPreview(
      workspace,
      context.definition,
      fixture.boundManifest,
      [],
      fixture.works[0]!,
      baseline,
    );
    expect(preview).toMatchObject({
      __brand: 'BatchWorkPreview',
      baselineInvariant: { result: 'pass' },
      catalog: { __brand: 'WorkPreviewCatalog' },
    });
    expect(preview.previewTreeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.distSha256).toMatch(/^[0-9a-f]{64}$/u);
    const builtCatalog = JSON.parse(
      await readFile(join(preview.stagingRoot, 'content', 'catalog.json'), 'utf8'),
    ) as PublishedV030Baseline['catalog'];
    expect(builtCatalog.works).toHaveLength(10);
    expect(builtCatalog.works.some((work) => work.workId === context.definition.workIds[0]!)).toBe(true);
    expect({
      authors: builtCatalog.authors,
      works: builtCatalog.works.filter((work) => work.batchId !== context.definition.batchId),
      audioAssets: builtCatalog.audioAssets.filter((asset) => asset.batchId !== context.definition.batchId),
      batches: builtCatalog.batches.filter((batch) => batch.batchId !== context.definition.batchId),
    }).toEqual({
      authors: baseline.catalog.authors,
      works: baseline.catalog.works,
      audioAssets: baseline.catalog.audioAssets,
      batches: baseline.catalog.batches,
    });
    expect(await readFile(join(preview.stagingRoot, 'content', 'batches', 'F004', 'rights-selection.json')))
      .not.toHaveLength(0);
    expect(createHash('sha256').update(
      await readFile(join(fixtureRoot, 'public', fixture.works[0]!.audioAssets[0]!.path)),
    ).digest('hex')).toBe(publicBefore);
    expect(canonicalJson(baseline)).toBe(baselineBefore);
    await rm(dirname(preview.stagingRoot), { recursive: true, force: true });

    const artifactPath = join(fixtureRoot, 'artifacts', '000466.json');
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
      work: { source: { provenancePath: string } };
    };
    artifact.work.source.provenancePath =
      'data/batches/F002/work-artifacts/000473/provenance.json';
    const raw = canonicalJson(artifact);
    await writeFile(artifactPath, raw, 'utf8');
    const artifactSha = createHash('sha256').update(raw).digest('hex');
    const forgedManifest = structuredClone(fixture.boundManifest) as unknown as {
      workProgress: Array<{ stageRecords: Array<{ outputHashes: string[] }> }>;
    };
    forgedManifest.workProgress[0]!.stageRecords[0]!.outputHashes = [artifactSha];
    await expect(loadVerifiedIncludedBatchWork(
      fixtureRoot,
      context.definition,
      forgedManifest as unknown as BatchManifest,
      hashBatchManifest(forgedManifest as unknown as BatchManifest),
      'artifacts/000466.json',
      artifactSha as never,
    )).rejects.toMatchObject({ code: 'BATCH_ARTIFACT_INVALID' });
  }, 30_000);
});
