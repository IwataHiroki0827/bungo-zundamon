import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BatchManifest,
  BatchStatus,
  Sha256,
  WorkStatus,
} from './batch.ts';
import {
  computeDHash64V1,
  F005_ARTWORK_POLICY_SNAPSHOTS,
  parseAndRehydrateF005ArtworkProvenance,
  sealF005ArtworkProvenance,
  serializeF005ArtworkProvenance,
  verifyF005ArtworkAgainstCatalog,
  type ArtworkAcceptance,
} from './f005-artwork.ts';
import {
  deriveF005RouteSet,
  F005CatalogError,
  isMintedF005Catalog,
  mergeNewAuthorCatalog,
  projectF005Bibliography,
  projectF005CatalogFragment,
  projectF005CatalogSource,
  projectF005Credits,
  type DataDrivenWorkNoticeV1,
  type F005FinalCatalogFragment,
  type F005FinalCatalog,
  type F005IncludedCatalogWork,
} from './f005-catalog.ts';
import {
  loadVerifiedF005Definition,
  type F005ApprovedBatchContext,
} from './f005-context.ts';
import {
  verifyNatsumeIdentity,
  type VerifiedNewAuthor,
} from './f005-foundation.ts';
import {
  F005_WORKS,
  type F005WorkId,
  type RightsUsageDecision,
  type SourceRecordV2,
} from './f005-source.ts';
import type {
  CatalogDialogueV2,
  CatalogV2,
} from './processing.ts';

const workspace = resolve('.');
const execFile = promisify(execFileCallback);
const HASH = 'a'.repeat(64);
// release: F004公開treeを昇格（F005着手前の最終commit）。verifyNatsumeIdentityの
// 「既存author集合との衝突」検証は、作業中に書き換わるworking treeのpublic/ではなく
// この凍結commit時点のcatalogを基準にする必要がある。
const PRE_F005_BASELINE_COMMIT = '19759e2ec5fe2b3969fb19f522b8351d0e587551';
let context: F005ApprovedBatchContext;
let baseline: CatalogV2;
let author: VerifiedNewAuthor;
let artworkAcceptance: ArtworkAcceptance;
let temporaryRoot: string | undefined;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'f005-catalog-'));
  const cleanWorkspace = join(temporaryRoot, 'checkout');
  await execFile('git', [
    '-c',
    'core.autocrlf=false',
    'clone',
    '--shared',
    '--branch',
    'feature/F005',
    '--single-branch',
    workspace,
    cleanWorkspace,
  ], {
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execFile('git', [
    '-C',
    cleanWorkspace,
    'checkout',
    '-b',
    'f005-catalog-context',
    '0c4c5ba2234df5443b65ee1c2a0a6370e44e0d28',
  ], { windowsHide: true });
  [context, baseline] = await Promise.all([
    loadVerifiedF005Definition(cleanWorkspace),
    execFile('git', [
      '-C',
      workspace,
      'show',
      `${PRE_F005_BASELINE_COMMIT}:public/content/catalog.json`,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }).then(({ stdout }) => JSON.parse(stdout) as CatalogV2),
  ]);
  author = verifyNatsumeIdentity(context, baseline);
  artworkAcceptance = createArtworkAcceptance(context);
}, 60_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Uint8Array {
  const image = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha] = pixel(x, y);
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = alpha;
    }
  }
  return new Uint8Array(PNG.sync.write(image, { colorType: 6 }));
}

function patternedArtwork(descending: boolean): Uint8Array {
  return png(9, 8, (x) => {
    const value = 31 * (descending ? 8 - x : x);
    return [value, value, value, 255];
  });
}

function createArtworkAcceptance(approvedContext: F005ApprovedBatchContext): ArtworkAcceptance {
  const bytes = patternedArtwork(false);
  const generation = {
    generator: 'OpenAI',
    generatorVersion: 'built-in-imagegen-2026-07',
    tool: 'built-in image_gen',
    providerTerms: { ...F005_ARTWORK_POLICY_SNAPSHOTS.providerTerms },
    characterGuideline: { ...F005_ARTWORK_POLICY_SNAPSHOTS.characterGuideline },
    prompt: '夏目漱石を想起させる独自の文豪風ずんだもん。',
    negativePrompt: '実在人物の写真、第三者画像、文字、ロゴ、透かし。',
    generatedAt: '2026-07-29T00:00:00Z',
    originalImageBytes: bytes,
  };
  const inputs = { referenceInputs: [], processingInputs: [] } as const;
  const finalImage = {
    sourcePath: 'content/batches/F005/public-files/artwork/natsume-zundamon.png',
    publicPath: 'artwork/natsume-zundamon.png',
    credit: '夏目漱石ずんだもん：OpenAI built-in image_genによる独自生成（参照画像なし）',
    bytes,
  } as const;
  const sealed = sealF005ArtworkProvenance(approvedContext, generation, inputs, finalImage);
  const rehydrated = parseAndRehydrateF005ArtworkProvenance(
    approvedContext,
    serializeF005ArtworkProvenance(sealed),
    generation,
    inputs,
    finalImage,
  );
  const existingBytes = patternedArtwork(true);
  return verifyF005ArtworkAgainstCatalog(rehydrated, bytes, ['000879', '000081', '000035'].map(
    (authorId, index) => ({
      authorId,
      path: `artwork/existing-${index}.png`,
      bytes: existingBytes,
      sha256: sha256(existingBytes),
      dHash64: computeDHash64V1(existingBytes),
    }),
  ));
}

function sourceRecord(workId: F005WorkId): SourceRecordV2 {
  const expected = F005_WORKS.find((work) => work.workId === workId)!;
  const rawBytes = new TextEncoder().encode(`raw:${workId}`);
  const cardBytes = new TextEncoder().encode(`card:${workId}`);
  const rawSha = sha256(rawBytes);
  const cardSha = sha256(cardBytes);
  const proofreader = workId === '000799' ? null : `校正者-${workId}`;
  const raw = {
    storage: 'inline' as const,
    sourceUrl: expected.sourceUrl,
    fetchedAt: '2026-07-29T00:00:00.000Z',
    mediaType: 'application/xhtml+xml',
    charset: 'Shift_JIS' as const,
    bytes: rawBytes,
    byteLength: rawBytes.byteLength,
    sha256: rawSha,
    transport: {} as SourceRecordV2['raw']['transport'],
  };
  const card = {
    storage: 'inline' as const,
    sourceUrl: expected.cardUrl,
    fetchedAt: '2026-07-29T00:00:00.000Z',
    mediaType: 'text/html',
    charset: 'UTF-8' as const,
    bytes: cardBytes,
    byteLength: cardBytes.byteLength,
    sha256: cardSha,
    transport: {} as SourceRecordV2['card']['transport'],
  };
  return {
    schemaVersion: '2.0.0',
    workId,
    title: expected.title,
    cardUrl: expected.cardUrl,
    sourceUrl: expected.sourceUrl,
    fetchedAt: raw.fetchedAt,
    updatedAt: '2026-07-01',
    raw,
    card,
    cardRawSha256: cardSha,
    cardRawBytes: cardBytes.byteLength,
    bibliographyCharset: 'Shift_JIS',
    bodySelector: '.main_text',
    bibliography: {
      baseEdition: `底本-${workId}`,
      inputter: `入力者-${workId}`,
      proofreader,
    },
  };
}

function includedWork(
  workId: F005WorkId,
  lifecycle: 'accepted' | 'staged',
): F005IncludedCatalogWork {
  const source = sourceRecord(workId);
  const sourceProvenance = {
    path: `content/provenance/F005/${workId}.json` as const,
    sha256: asSha(sha256(`source-provenance:${workId}`)),
  };
  const audioId = sha256(`audio:${workId}`);
  const dialogueId = sha256(`dialogue:${workId}`);
  const dialogue = {
    dialogueId,
    workId,
    order: 0,
    displayText: `「台詞-${workId}」`,
    speechText: `「台詞-${workId}」`,
    audioId,
    sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
    review: {},
  } as unknown as CatalogDialogueV2;
  return {
    lifecycle,
    sourceRecord: source,
    work: {
      workId,
      title: source.title,
      cardLink: source.cardUrl,
      authorId: '000148',
      batchId: 'F005',
      source: projectF005CatalogSource(source, sourceProvenance),
      dialogues: [dialogue],
      completionStatus: 'complete',
      notices: [{
        textKey: 'dialogue-excerpt-scope',
        placements: ['work-list', 'work-detail', 'credits'],
      }],
    },
    sourceProvenance,
    audioAssets: [{
      audioId,
      batchId: 'F005',
      path: `audio/F005/${audioId}.wav`,
      sha256: asSha(sha256(`wav:${workId}`)),
      bytes: 44,
      durationMs: 0,
      configHash: asSha(HASH),
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
    artifactSha256: asSha(HASH),
  };
}

function manifest(
  statuses: readonly [WorkStatus, WorkStatus, WorkStatus],
  status: BatchStatus,
): BatchManifest {
  const completedAt = '2026-07-29T00:00:00.000Z';
  const workProgress = statuses.map((workStatus, index) => {
    const workId = F005_WORKS[index]!.workId;
    const stageRecords = workStatus === 'pending' ? [] : [{
      stage: workStatus,
      inputHashes: [],
      toolVersion: 'f005-catalog-test-v1',
      outputHashes: [],
      count: workStatus === 'accepted' ? 1 : 0,
      completedAt,
    }];
    return {
      workId,
      status: workStatus,
      stageRecords,
      ...(workStatus === 'accepted' ? {
        acceptedAudioSources: [{
          path: `content/batches/F005/accepted-audio/${workId}/${sha256(`accepted:${workId}`)}.wav`,
          sha256: asSha(sha256(`accepted:${workId}`)),
          bytes: 44,
          configHash: asSha(HASH),
        }],
        acceptedAt: completedAt,
        acceptedBy: 'f005-test',
      } : {}),
    };
  });
  return {
    batchId: 'F005',
    feature: 'F005',
    schemaVersion: '1.0.0',
    status,
    author: context.definition.author,
    workIds: ['000799', '001076', '001104'],
    workProgress,
    inputPaths: ['content/batches/F005'],
    outputPaths: ['public/audio/F005'],
    stageRecords: status === 'draft' ? [] : [{
      stage: status,
      inputHashes: [],
      toolVersion: 'f005-catalog-test-v1',
      outputHashes: [],
      count: 0,
      completedAt,
    }],
    rightsSnapshotIds: ['selection', 'predeploy'],
    voiceConfigRef: 'content/voice-config.json',
    artworkProvenanceRef: 'content/batches/F005/artwork-provenance.json',
    ...(status === 'accepted' ? {
      acceptedAt: completedAt,
      acceptedBy: 'f005-test',
    } : {}),
  } as unknown as BatchManifest;
}

function finalCatalog(): {
  readonly catalog: F005FinalCatalog;
  readonly included: readonly F005IncludedCatalogWork[];
} {
  const included = F005_WORKS.map((work) => includedWork(work.workId, 'accepted'));
  const fragment = projectF005CatalogFragment(
    context,
    manifest(['accepted', 'accepted', 'accepted'], 'accepted'),
    included,
    author,
    artworkAcceptance,
    'final',
  );
  return {
    catalog: mergeNewAuthorCatalog(baseline, fragment, author),
    included,
  };
}

describe('UT-F005-024 nullable書誌validator [DES-F005-003][DES-F005-007][FUN-F005-024]', () => {
  it('夢十夜だけcanonical nullを「校正者: 記載なし」へ投影し、既存文字列を維持する', () => {
    expect(projectF005Bibliography({
      baseEdition: '底本',
      inputter: '入力者',
      proofreader: null,
    }, '000799')).toEqual({
      baseEdition: '底本',
      inputter: '入力者',
      proofreader: null,
      proofreaderLabel: '校正者: 記載なし',
    });
    expect(projectF005Bibliography({
      baseEdition: '底本',
      inputter: '入力者',
      proofreader: '校正者',
    }, '001076').proofreaderLabel).toBe('校正者: 校正者');
  });

  it.each([
    ['夢十夜の空文字', { baseEdition: '底本', inputter: '入力者', proofreader: '' }, '000799'],
    ['夢十夜の推測名', { baseEdition: '底本', inputter: '入力者', proofreader: '推測名' }, '000799'],
    ['倫敦塔のnull', { baseEdition: '底本', inputter: '入力者', proofreader: null }, '001076'],
    ['unknown field', { baseEdition: '底本', inputter: '入力者', proofreader: null, extra: true }, '000799'],
  ] as const)('%sを拒否する', (_label, value, workId) => {
    expect(() => projectF005Bibliography(value, workId)).toThrow();
  });
});

describe('UT-F005-025 Catalog fragment [DES-F005-007][FUN-F005-025]', () => {
  it('accepted prefix＋staged 1件をpreviewとしてmintし、final brandと型分離する', () => {
    const included = [
      includedWork('000799', 'accepted'),
      includedWork('001076', 'staged'),
    ] as const;
    const preview = projectF005CatalogFragment(
      context,
      manifest(['accepted', 'reviewed', 'pending'], 'draft'),
      included,
      author,
      artworkAcceptance,
      'work-preview',
    );
    expect(preview.__brand).toBe('F005WorkPreviewCatalogFragment');
    expect(preview.works.map((work) => work.workId)).toEqual(['000799', '001076']);
    expect(preview.acceptedAt).toBeNull();
    expect(preview.manifestObservedAt).toBe('2026-07-29T00:00:00.000Z');

    // @ts-expect-error preview fragmentをfinalへ代入できない
    const invalidFinal: F005FinalCatalogFragment = preview;
    expect(invalidFinal.mode).toBe('work-preview');
    const previewCatalog = mergeNewAuthorCatalog(baseline, preview, author);
    expect(previewCatalog.batches.at(-1)?.acceptedAt).toBe('2026-07-29T00:00:00.000Z');
    expect(previewCatalog.batches.at(-1)?.acceptedAt).not.toBe(new Date(0).toISOString());
    // @ts-expect-error preview catalogをfinal catalogへ代入できない
    const invalidFinalCatalog: F005FinalCatalog = previewCatalog;
    expect(invalidFinalCatalog.mode).toBe('work-preview');
    const finalIncluded = F005_WORKS.map((work) => includedWork(work.workId, 'accepted'));
    const final = projectF005CatalogFragment(
      context,
      manifest(['accepted', 'accepted', 'accepted'], 'accepted'),
      finalIncluded,
      author,
      artworkAcceptance,
      'final',
    );
    expect(final.__brand).toBe('F005FinalCatalogFragment');
    expect(final.acceptedAt).toBe('2026-07-29T00:00:00.000Z');
  });

  it('staged 0/2、順序差、孤立asset、provenance差、final時刻矛盾を拒否する', () => {
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['accepted', 'reviewed', 'pending'], 'draft'),
      [includedWork('000799', 'accepted'), includedWork('001076', 'accepted')],
      author,
      artworkAcceptance,
      'work-preview',
    )).toThrowError(F005CatalogError);
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['reviewed', 'pending', 'pending'], 'draft'),
      [includedWork('001076', 'staged')],
      author,
      artworkAcceptance,
      'work-preview',
    )).toThrowError(F005CatalogError);
    const orphan = includedWork('000799', 'staged');
    const orphanAsset = {
      ...orphan,
      audioAssets: [...orphan.audioAssets, {
        ...orphan.audioAssets[0]!,
        audioId: sha256('orphan'),
        path: `audio/F005/${sha256('orphan')}.wav`,
      }],
    };
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['reviewed', 'pending', 'pending'], 'draft'),
      [orphanAsset],
      author,
      artworkAcceptance,
      'work-preview',
    )).toThrowError(F005CatalogError);
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['accepted', 'accepted', 'reviewed'], 'reviewed'),
      [
        includedWork('000799', 'accepted'),
        includedWork('001076', 'accepted'),
        includedWork('001104', 'accepted'),
      ],
      author,
      artworkAcceptance,
      'final',
    )).toThrowError(F005CatalogError);

    const forgedArtwork = structuredClone(artworkAcceptance);
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['reviewed', 'pending', 'pending'], 'draft'),
      [includedWork('000799', 'staged')],
      author,
      forgedArtwork,
      'work-preview',
    )).toThrowError(F005CatalogError);

    const wrongArtworkManifest = {
      ...manifest(['reviewed', 'pending', 'pending'], 'draft'),
      artworkProvenanceRef:
        'content/batches/F005/other-artwork-provenance.json',
    } as BatchManifest;
    expect(() => projectF005CatalogFragment(
      context,
      wrongArtworkManifest,
      [includedWork('000799', 'staged')],
      author,
      artworkAcceptance,
      'work-preview',
    )).toThrowError(F005CatalogError);

    const rawReuse = includedWork('000799', 'staged');
    const rawSha = rawReuse.sourceRecord.raw.sha256 as Sha256;
    const rawReuseEntry: F005IncludedCatalogWork = {
      ...rawReuse,
      sourceProvenance: { ...rawReuse.sourceProvenance, sha256: rawSha },
      work: {
        ...rawReuse.work,
        source: { ...rawReuse.work.source, provenanceSha256: rawSha },
      },
    };
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['reviewed', 'pending', 'pending'], 'draft'),
      [rawReuseEntry],
      author,
      artworkAcceptance,
      'work-preview',
    )).toThrowError(F005CatalogError);

    const duplicateProvenance = [
      includedWork('000799', 'accepted'),
      includedWork('001076', 'staged'),
    ];
    duplicateProvenance[1] = {
      ...duplicateProvenance[1]!,
      sourceProvenance: {
        ...duplicateProvenance[1]!.sourceProvenance,
        sha256: duplicateProvenance[0]!.sourceProvenance.sha256,
      },
      work: {
        ...duplicateProvenance[1]!.work,
        source: {
          ...duplicateProvenance[1]!.work.source,
          provenanceSha256: duplicateProvenance[0]!.sourceProvenance.sha256,
        },
      },
    };
    expect(() => projectF005CatalogFragment(
      context,
      manifest(['accepted', 'reviewed', 'pending'], 'draft'),
      duplicateProvenance,
      author,
      artworkAcceptance,
      'work-preview',
    )).toThrowError(F005CatalogError);

    const validFinalManifest = manifest(
      ['accepted', 'accepted', 'accepted'],
      'accepted',
    );
    // CHG-F005-075: acceptedAtの裏付けは各作品のaccepted stage recordである。
    // 最後に受理された作品の完了時刻がbatchのacceptedAtと食い違えば拒否する。
    const timeMismatch = {
      ...validFinalManifest,
      workProgress: validFinalManifest.workProgress.map((work, index) =>
        index === validFinalManifest.workProgress.length - 1
          ? {
            ...work,
            stageRecords: work.stageRecords.map((record, position) =>
              position === work.stageRecords.length - 1
                ? { ...record, completedAt: '2026-07-29T00:01:00.000Z' }
                : record),
          }
          : work),
    } as unknown as BatchManifest;
    expect(() => projectF005CatalogFragment(
      context,
      timeMismatch,
      F005_WORKS.map((work) => includedWork(work.workId, 'accepted')),
      author,
      artworkAcceptance,
      'final',
    )).toThrowError(F005CatalogError);
  });
});

describe('UT-F005-026 新作者Catalog merge [DES-F005-007][FUN-F005-026]', () => {
  it('夏目1作者と3作品を末尾追加し既存3作者・12作品serialized projectionをexact維持する', () => {
    const beforeAuthors = JSON.stringify(baseline.authors);
    const beforeWorks = JSON.stringify(baseline.works);
    const { catalog } = finalCatalog();

    expect(catalog.authors).toHaveLength(4);
    expect(catalog.works).toHaveLength(15);
    expect(catalog.authors.at(-1)).toMatchObject({
      authorId: '000148',
      slug: 'natsume-soseki',
      introducedByBatchId: 'F005',
    });
    expect(catalog.works.slice(-3).map((work) => [work.workId, work.authorId])).toEqual([
      ['000799', '000148'],
      ['001076', '000148'],
      ['001104', '000148'],
    ]);
    expect(JSON.stringify(catalog.authors.slice(0, 3))).toBe(beforeAuthors);
    expect(JSON.stringify(catalog.works.slice(0, 12))).toBe(beforeWorks);
    expect(catalog.batches.at(-1)?.acceptedAt).toBe('2026-07-29T00:00:00.000Z');
    expect(isMintedF005Catalog(catalog)).toBe(true);
  });

  it('baseline join 1、ID/slug衝突、別作者fragment、forged fragmentを拒否する', () => {
    const included = F005_WORKS.map((work) => includedWork(work.workId, 'accepted'));
    const fragment = projectF005CatalogFragment(
      context,
      manifest(['accepted', 'accepted', 'accepted'], 'accepted'),
      included,
      author,
      artworkAcceptance,
      'final',
    );
    expect(() => mergeNewAuthorCatalog({
      ...baseline,
      authors: [...baseline.authors, fragment.author],
    }, fragment, author)).toThrowError(F005CatalogError);
    expect(() => mergeNewAuthorCatalog({
      ...baseline,
      authors: baseline.authors.map((entry, index) =>
        index === 0 ? { ...entry, slug: 'natsume-soseki' } : entry),
    }, fragment, author)).toThrowError(F005CatalogError);
    expect(() => mergeNewAuthorCatalog(
      baseline,
      structuredClone(fragment),
      author,
    )).toThrowError(F005CatalogError);
    expect(isMintedF005Catalog(structuredClone(
      mergeNewAuthorCatalog(baseline, fragment, author),
    ))).toBe(false);
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'mode', {
      get() {
        getterCalls += 1;
        throw new Error('getter-must-not-run');
      },
    });
    expect(isMintedF005Catalog(hostile)).toBe(false);
    expect(getterCalls).toBe(0);
  });
});

describe('UT-F005-027 route集合 [DES-F005-007][DES-F005-009][FUN-F005-027]', () => {
  it('Catalog作者slugからhome・4作者・favorites・creditsのexact 7 routeを導出する', () => {
    const { catalog } = finalCatalog();
    const routeSet = deriveF005RouteSet(catalog, ['#/', '#/favorites', '#/credits']);
    expect(routeSet.routes).toEqual([
      '#/',
      '#/authors/akutagawa-zunnosuke',
      '#/authors/miyazawa-zunji',
      '#/authors/dazai-osamu',
      '#/authors/natsume-soseki',
      '#/favorites',
      '#/credits',
    ]);
    expect(routeSet.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ['重複', ['#/', '#/', '#/credits']],
    ['不足', ['#/', '#/credits']],
    ['余分', ['#/', '#/favorites', '#/credits', '#/about']],
    ['未知', ['#/', '#/favorites', '#/unknown']],
  ])('%s static routeを拒否する', (_label, routes) => {
    const { catalog } = finalCatalog();
    expect(() => deriveF005RouteSet(catalog, routes)).toThrowError(F005CatalogError);
  });
});

describe('UT-F005-032 credits [DES-F005-010][FUN-F005-032]', () => {
  function fixtures() {
    const { catalog, included } = finalCatalog();
    const sources = included.map((entry) => entry.sourceRecord);
    const shumi = sources.find((source) => source.workId === '001104')!;
    const noticeText = '作品カードに記載された公式の表現上の注意です。';
    const notice: DataDrivenWorkNoticeV1 = {
      schemaVersion: 1,
      workId: '001104',
      text: noticeText,
      sourceUrl: shumi.cardUrl,
      sourceRawSha256: shumi.cardRawSha256 as DataDrivenWorkNoticeV1['sourceRawSha256'],
      textSha256: sha256(noticeText) as DataDrivenWorkNoticeV1['textSha256'],
      placements: ['author', 'work', 'credits'],
    };
    const decisions: readonly RightsUsageDecision[] = [
      {
        decision: 'allow',
        reasons: [],
        phase: 'selection',
        observedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        decision: 'allow',
        reasons: [],
        phase: 'predeploy',
        observedAt: '2026-07-29T01:00:00.000Z',
      },
    ];
    return { catalog, sources, notice, decisions };
  }

  it('author/work/creditsを同じjoinから生成し、null・notice・安全anchorをtext dataへ投影する', () => {
    const { catalog, sources, notice, decisions } = fixtures();
    const projection = projectF005Credits(catalog, sources, decisions, [notice], artworkAcceptance);
    expect(projection.author).toHaveLength(4);
    expect(Object.keys(projection.works)).toEqual(['000799', '001076', '001104']);
    expect(projection.credits).toHaveLength(4);
    expect(projection.works['000799'].nodes).toContainEqual({
      kind: 'text',
      text: '校正者: 記載なし',
    });
    expect(projection.works['001104'].nodes).toContainEqual({
      kind: 'text',
      text: notice.text,
    });
    expect(projection.works['001104'].nodes).toContainEqual({
      kind: 'anchor',
      text: '公式表現注意の出典',
      href: notice.sourceUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(JSON.stringify(projection)).not.toContain('<');
  });

  it('source hash差、credit欠落、notice HTML/配置差、権利blockedを拒否する', () => {
    const { catalog, sources, notice, decisions } = fixtures();
    expect(() => projectF005Credits(catalog, sources, decisions, [{
      ...notice,
      sourceRawSha256: asSha(HASH),
    }], artworkAcceptance)).toThrowError(F005CatalogError);
    expect(() => projectF005Credits(catalog, sources, decisions, [notice], {
      ...artworkAcceptance,
      credit: '',
    })).toThrowError(F005CatalogError);
    const html = '<b>危険</b>';
    expect(() => projectF005Credits(catalog, sources, decisions, [{
      ...notice,
      text: html,
      textSha256: sha256(html) as DataDrivenWorkNoticeV1['textSha256'],
    }], artworkAcceptance)).toThrowError(F005CatalogError);
    expect(() => projectF005Credits(catalog, sources, decisions, [{
      ...notice,
      placements: ['author', 'work', 'work'] as unknown as DataDrivenWorkNoticeV1['placements'],
    }], artworkAcceptance)).toThrowError(F005CatalogError);
    expect(() => projectF005Credits(catalog, sources, [
      decisions[0]!,
      { ...decisions[1]!, decision: 'blocked' },
    ], [notice], artworkAcceptance)).toThrowError(F005CatalogError);
  });
});

describe('IT-F005-007 nullable書誌・notice・creditsのCatalog統合', () => {
  it('4作者・15作品、既存bytes不変、夢十夜「記載なし」、notice exact 3配置、孤立0を一括確認する', () => {
    const baselineBytes = JSON.stringify({
      authors: baseline.authors,
      works: baseline.works,
    });
    const { catalog, included } = finalCatalog();
    const sources = included.map((entry) => entry.sourceRecord);
    const shumi = sources.find((source) => source.workId === '001104')!;
    const noticeText = '作品カードに記載された公式の表現上の注意です。';
    const notice: DataDrivenWorkNoticeV1 = {
      schemaVersion: 1,
      workId: '001104',
      text: noticeText,
      sourceUrl: shumi.cardUrl,
      sourceRawSha256: shumi.cardRawSha256 as DataDrivenWorkNoticeV1['sourceRawSha256'],
      textSha256: sha256(noticeText) as DataDrivenWorkNoticeV1['textSha256'],
      placements: ['author', 'work', 'credits'],
    };
    const decisions: readonly RightsUsageDecision[] = [
      { decision: 'allow', reasons: [], phase: 'selection', observedAt: '2026-07-29T00:00:00.000Z' },
      { decision: 'allow', reasons: [], phase: 'predeploy', observedAt: '2026-07-29T01:00:00.000Z' },
    ];
    const credits = projectF005Credits(catalog, sources, decisions, [notice], artworkAcceptance);

    expect(catalog.authors).toHaveLength(4);
    expect(catalog.works).toHaveLength(15);
    expect(JSON.stringify({
      authors: catalog.authors.slice(0, 3),
      works: catalog.works.slice(0, 12),
    })).toBe(baselineBytes);
    expect(credits.works['000799'].nodes.some((node) =>
      node.kind === 'text' && node.text === '校正者: 記載なし')).toBe(true);
    expect([
      credits.author.find((placement) => placement.workId === '001104'),
      credits.works['001104'],
      credits.credits.find((placement) => placement.workId === '001104'),
    ].every((placement) => placement?.nodes.some((node) =>
      node.kind === 'text' && node.text === noticeText))).toBe(true);
    expect(new Set(Object.keys(credits.works))).toEqual(new Set(catalog.works.slice(-3).map((work) => work.workId)));
  });
});
