import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Sha256 } from './batch.ts';
import {
  F009CatalogError,
  deriveF009RouteSet,
  isMintedF009MergedCatalog,
  mergeNewAuthorCatalog009,
  type F009CatalogFragment,
  type F009CatalogWorkV2,
  type F009MergedCatalog,
} from './f009-catalog.ts';
import {
  F009_WORKS,
  defineF009AuthorAndWorkRegistry,
  verifyF009AuthorIdentity,
  type F009VerifiedAuthor,
} from './f009-source.ts';
import type { CatalogAudioAssetV2, CatalogCandidateCountV2, CatalogV2 } from './processing.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

const BASELINE_AUTHOR_SLUGS = [
  'akutagawa-ryunosuke', 'miyazawa-kenji', 'dazai-osamu', 'natsume-soseki', 'nakajima-atsushi', 'mori-ogai',
  'edogawa-ranpo',
] as const;

function baselineCatalog(): CatalogV2 {
  const authors = BASELINE_AUTHOR_SLUGS.map((slug, index) => ({
    authorId: `00000${index}`,
    name: `作者${index}`,
    originalName: `原作者${index}`,
    slug,
    artwork: { path: `artwork/${slug}.png`, alt: slug, sha256: sha256(`artwork:${slug}`) },
    introducedByBatchId: `F00${index + 1}`,
    identitySha256: sha256(`identity:${slug}`),
  }));
  const works = Array.from({ length: 24 }, (_, index) => ({
    workId: `w${index}`,
    title: `作品${index}`,
    cardLink: `https://www.aozora.gr.jp/cards/000000/card${index}.html`,
    authorId: authors[index % authors.length]!.authorId,
    batchId: `F00${(index % 7) + 1}`,
    source: {} as CatalogV2['works'][number]['source'],
    dialogues: [],
  }));
  return {
    schemaVersion: '2.0.0',
    authors,
    works,
    audioAssets: [{
      audioId: sha256('baseline-audio'),
      path: 'audio/F001/baseline.wav',
      bytes: 100,
      durationMs: 500,
      configHash: sha256('config'),
      batchId: 'F001',
    } as unknown as CatalogAudioAssetV2],
    batches: [{
      batchId: 'F001',
      feature: 'F001',
      status: 'published',
      authorId: authors[0]!.authorId,
      workIds: ['w0'],
      acceptedAt: '2026-01-01T00:00:00.000Z',
      evidenceSha256: sha256('evidence'),
    }],
    candidateCounts: {
      total: 20,
      published: 15,
      editorialExcluded: 3,
      audioExcluded: 2,
      editorialReasons: { taste: 3 },
      audioFailureReasons: { silence: 2 },
      byBatch: {},
    },
    creditsRef: 'content/credits.json',
  };
}

function verifiedAuthor(baseline: CatalogV2): F009VerifiedAuthor {
  const registry = defineF009AuthorAndWorkRegistry();
  return verifyF009AuthorIdentity(registry, baseline);
}

const NOTICE_KEYS: Readonly<Record<string, readonly ('official-content-warning' | 'dialogue-excerpt-scope')[]>> = {
  '002381': ['official-content-warning', 'dialogue-excerpt-scope'],
  '046694': ['dialogue-excerpt-scope'],
  '002380': ['official-content-warning', 'dialogue-excerpt-scope'],
};

function fragmentWorks(): readonly F009CatalogWorkV2[] {
  return F009_WORKS.map((expected) => ({
    workId: expected.workId,
    title: expected.title,
    cardLink: expected.cardUrl,
    authorId: '000096' as const,
    batchId: 'F009' as const,
    completionStatus: 'complete' as const,
    notices: NOTICE_KEYS[expected.workId]!.map((textKey) => ({
      textKey,
      placements: ['work-list', 'work-detail', 'credits'],
    })),
    source: {} as F009CatalogWorkV2['source'],
    dialogues: [{
      dialogueId: sha256(`dialogue:${expected.workId}`),
      workId: expected.workId,
      order: 0,
      displayText: `「台詞-${expected.workId}」`,
      speechText: `「台詞-${expected.workId}」`,
      audioId: sha256(`audio:${expected.workId}`),
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {},
    } as unknown as F009CatalogWorkV2['dialogues'][number]],
  }));
}

function fragmentAudioAssets(): readonly CatalogAudioAssetV2[] {
  return F009_WORKS.map((expected) => ({
    audioId: sha256(`audio:${expected.workId}`),
    path: `audio/F009/${expected.workId}.wav`,
    bytes: 200,
    durationMs: 700,
    configHash: sha256(`config:${expected.workId}`),
    batchId: 'F009',
  } as unknown as CatalogAudioAssetV2));
}

function candidateCounts(): CatalogCandidateCountV2 {
  return {
    total: 6,
    published: 3,
    editorialExcluded: 2,
    audioExcluded: 1,
    editorialReasons: { taste: 2 },
    audioFailureReasons: { silence: 1 },
  };
}

function fragment(overrides: Partial<F009CatalogFragment> = {}): F009CatalogFragment {
  return {
    batchId: 'F009',
    feature: 'F009',
    authorId: '000096',
    authorArtwork: {
      path: 'artwork/yumeno-kyusaku-zundamon.png',
      alt: '夢野久作ずんだもん',
      sha256: sha256('artwork:yumeno-kyusaku'),
    },
    works: fragmentWorks(),
    audioAssets: fragmentAudioAssets(),
    candidateCounts: candidateCounts(),
    acceptedAt: '2026-08-23T00:00:00.000Z',
    evidenceSha256: asSha(sha256('evidence:F009')),
    ...overrides,
  };
}

describe('mergeNewAuthorCatalog009（f009-catalog.ts）', () => {
  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('baseline join 0・非衝突時だけauthors 8・works 27のCatalogを返す', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog009(baseline, fragment(), author);
    expect(isMintedF009MergedCatalog(merged)).toBe(true);
    expect(merged.authors.length).toBe(8);
    expect(merged.works.length).toBe(27);
    expect(merged.authors.at(-1)?.authorId).toBe('000096');
    expect(merged.batches.at(-1)).toMatchObject({
      batchId: 'F009',
      feature: 'F009',
      authorId: '000096',
      workIds: ['002381', '046694', '002380'],
    });
    expect(merged.candidateCounts.total).toBe(26);
    expect(merged.candidateCounts.byBatch.F009).toEqual(candidateCounts());
    // baseline側の既存7作者24作品projectionは変化しない
    expect(merged.authors.slice(0, 7)).toEqual(baseline.authors);
    expect(merged.works.slice(0, 24)).toEqual(baseline.works);
    // 瓶詰地獄・死後の恋はofficial-content-warningを持ち、きのこ会議は持たない
    const binzumeJigoku = merged.works.find((work) => work.workId === '002381');
    expect(binzumeJigoku?.notices?.map((notice) => notice.textKey)).toEqual([
      'official-content-warning', 'dialogue-excerpt-scope',
    ]);
    const shigoNoKoi = merged.works.find((work) => work.workId === '002380');
    expect(shigoNoKoi?.notices?.map((notice) => notice.textKey)).toEqual([
      'official-content-warning', 'dialogue-excerpt-scope',
    ]);
    const kinokoKaigi = merged.works.find((work) => work.workId === '046694');
    expect(kinokoKaigi?.notices?.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('baselineの作者数が7以外はF009_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, authors: baseline.authors.slice(0, 6) };
    expect(() => mergeNewAuthorCatalog009(broken, fragment(), author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('baselineの作品数が24以外はF009_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, works: baseline.works.slice(0, 23) };
    expect(() => mergeNewAuthorCatalog009(broken, fragment(), author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('作者ID衝突（baseline joinが0でない）はF009_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const conflicting: CatalogV2 = {
      ...baseline,
      authors: [
        ...baseline.authors.slice(0, 6),
        { ...baseline.authors[6]!, authorId: '000096' },
      ],
    };
    expect(() => mergeNewAuthorCatalog009(conflicting, fragment(), author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('audio ID衝突はF009_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const collidingFragment = fragment({
      audioAssets: [
        { ...fragmentAudioAssets()[0]!, audioId: baseline.audioAssets[0]!.audioId },
        ...fragmentAudioAssets().slice(1),
      ],
    });
    expect(() => mergeNewAuthorCatalog009(baseline, collidingFragment, author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('瓶詰地獄にofficial-content-warningが欠落しているとF009_CATALOG_MERGE_CONFLICT（QA-F009 No.4）', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '002381'
        ? { ...work, notices: [{ textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] }] }
        : work),
    });
    expect(() => mergeNewAuthorCatalog009(baseline, missingNotice, author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('死後の恋にofficial-content-warningが欠落しているとF009_CATALOG_MERGE_CONFLICT（QA-F009 No.4）', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '002380'
        ? { ...work, notices: [{ textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] }] }
        : work),
    });
    expect(() => mergeNewAuthorCatalog009(baseline, missingNotice, author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('work順・workIdがF009_WORKSと不一致な場合はF009_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const reordered = fragment({ works: [...fragmentWorks()].reverse() });
    expect(() => mergeNewAuthorCatalog009(baseline, reordered, author)).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('未検証のverifiedAuthorはF009_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const fakeAuthor = { ...verifiedAuthor(baseline) };
    expect(() => mergeNewAuthorCatalog009(baseline, fragment(), fakeAuthor)).toThrow(F009CatalogError);
  });
});

describe('deriveF009RouteSet（f009-catalog.ts）', () => {
  function mergedFixture(): F009MergedCatalog {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    return mergeNewAuthorCatalog009(baseline, fragment(), author);
  }

  /** @des DES-F009-010 @fun FUN-F009-012 @ut UT-F009-012 */
  it('8作者・固定route集合からexact 11 routeを決定的に導出する', () => {
    const merged = mergedFixture();
    const first = deriveF009RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    const second = deriveF009RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    expect(first.routes).toEqual([
      '#/',
      '#/authors/akutagawa-ryunosuke',
      '#/authors/miyazawa-kenji',
      '#/authors/dazai-osamu',
      '#/authors/natsume-soseki',
      '#/authors/nakajima-atsushi',
      '#/authors/mori-ogai',
      '#/authors/edogawa-ranpo',
      '#/authors/yumeno-kyusaku',
      '#/favorites',
      '#/credits',
    ]);
    expect(first.routes.length).toBe(11);
    expect(first.digest).toBe(second.digest);
  });

  /** @des DES-F009-010 @fun FUN-F009-012 @ut UT-F009-012 */
  it('未mintのCatalogはF009_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    const forged = { ...merged } as F009MergedCatalog;
    expect(() => deriveF009RouteSet(forged, ['#/', '#/favorites', '#/credits'])).toThrow(F009CatalogError);
  });

  /** @des DES-F009-010 @fun FUN-F009-012 @ut UT-F009-012 */
  it('staticRoutesが固定値と不一致な場合はF009_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    expect(() => deriveF009RouteSet(merged, ['#/', '#/favorites'])).toThrow(F009CatalogError);
  });
});
