import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Sha256 } from './batch.ts';
import {
  F008CatalogError,
  deriveF008RouteSet,
  isMintedF008MergedCatalog,
  mergeNewAuthorCatalog008,
  type F008CatalogFragment,
  type F008CatalogWorkV2,
  type F008MergedCatalog,
} from './f008-catalog.ts';
import {
  F008_WORKS,
  defineF008AuthorAndWorkRegistry,
  verifyF008AuthorIdentity,
  type F008VerifiedAuthor,
} from './f008-source.ts';
import type { CatalogAudioAssetV2, CatalogCandidateCountV2, CatalogV2 } from './processing.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

const BASELINE_AUTHOR_SLUGS = [
  'akutagawa-ryunosuke', 'miyazawa-kenji', 'dazai-osamu', 'natsume-soseki', 'nakajima-atsushi', 'mori-ogai',
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
  const works = Array.from({ length: 21 }, (_, index) => ({
    workId: `w${index}`,
    title: `作品${index}`,
    cardLink: `https://www.aozora.gr.jp/cards/000000/card${index}.html`,
    authorId: authors[index % authors.length]!.authorId,
    batchId: `F00${(index % 6) + 1}`,
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

function verifiedAuthor(baseline: CatalogV2): F008VerifiedAuthor {
  const registry = defineF008AuthorAndWorkRegistry();
  return verifyF008AuthorIdentity(registry, baseline);
}

const NOTICE_KEYS: Readonly<Record<string, readonly ('official-content-warning' | 'dialogue-excerpt-scope')[]>> = {
  '056648': ['official-content-warning', 'dialogue-excerpt-scope'],
  '056650': ['official-content-warning', 'dialogue-excerpt-scope'],
  '057193': ['dialogue-excerpt-scope'],
};

function fragmentWorks(): readonly F008CatalogWorkV2[] {
  return F008_WORKS.map((expected) => ({
    workId: expected.workId,
    title: expected.title,
    cardLink: expected.cardUrl,
    authorId: '001779' as const,
    batchId: 'F008' as const,
    completionStatus: 'complete' as const,
    notices: NOTICE_KEYS[expected.workId]!.map((textKey) => ({
      textKey,
      placements: ['work-list', 'work-detail', 'credits'],
    })),
    source: {} as F008CatalogWorkV2['source'],
    dialogues: [{
      dialogueId: sha256(`dialogue:${expected.workId}`),
      workId: expected.workId,
      order: 0,
      displayText: `「台詞-${expected.workId}」`,
      speechText: `「台詞-${expected.workId}」`,
      audioId: sha256(`audio:${expected.workId}`),
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {},
    } as unknown as F008CatalogWorkV2['dialogues'][number]],
  }));
}

function fragmentAudioAssets(): readonly CatalogAudioAssetV2[] {
  return F008_WORKS.map((expected) => ({
    audioId: sha256(`audio:${expected.workId}`),
    path: `audio/F008/${expected.workId}.wav`,
    bytes: 200,
    durationMs: 700,
    configHash: sha256(`config:${expected.workId}`),
    batchId: 'F008',
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

function fragment(overrides: Partial<F008CatalogFragment> = {}): F008CatalogFragment {
  return {
    batchId: 'F008',
    feature: 'F008',
    authorId: '001779',
    authorArtwork: {
      path: 'artwork/edogawa-ranpo-zundamon.png',
      alt: '江戸川乱歩ずんだもん',
      sha256: sha256('artwork:edogawa-ranpo'),
    },
    works: fragmentWorks(),
    audioAssets: fragmentAudioAssets(),
    candidateCounts: candidateCounts(),
    acceptedAt: '2026-08-22T00:00:00.000Z',
    evidenceSha256: asSha(sha256('evidence:F008')),
    ...overrides,
  };
}

describe('mergeNewAuthorCatalog008（f008-catalog.ts）', () => {
  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('baseline join 0・非衝突時だけauthors 7・works 24のCatalogを返す', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog008(baseline, fragment(), author);
    expect(isMintedF008MergedCatalog(merged)).toBe(true);
    expect(merged.authors.length).toBe(7);
    expect(merged.works.length).toBe(24);
    expect(merged.authors.at(-1)?.authorId).toBe('001779');
    expect(merged.batches.at(-1)).toMatchObject({
      batchId: 'F008',
      feature: 'F008',
      authorId: '001779',
      workIds: ['056648', '056650', '057193'],
    });
    expect(merged.candidateCounts.total).toBe(26);
    expect(merged.candidateCounts.byBatch.F008).toEqual(candidateCounts());
    // baseline側の既存6作者21作品projectionは変化しない
    expect(merged.authors.slice(0, 6)).toEqual(baseline.authors);
    expect(merged.works.slice(0, 21)).toEqual(baseline.works);
    // 人間椅子・Ｄ坂の殺人事件はofficial-content-warningを持ち、一人二役は持たない
    const ningen = merged.works.find((work) => work.workId === '056648');
    expect(ningen?.notices?.map((notice) => notice.textKey)).toEqual([
      'official-content-warning', 'dialogue-excerpt-scope',
    ]);
    const dzaka = merged.works.find((work) => work.workId === '056650');
    expect(dzaka?.notices?.map((notice) => notice.textKey)).toEqual([
      'official-content-warning', 'dialogue-excerpt-scope',
    ]);
    const hitorifutayaku = merged.works.find((work) => work.workId === '057193');
    expect(hitorifutayaku?.notices?.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('baselineの作者数が6以外はF008_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, authors: baseline.authors.slice(0, 5) };
    expect(() => mergeNewAuthorCatalog008(broken, fragment(), author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('baselineの作品数が21以外はF008_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, works: baseline.works.slice(0, 20) };
    expect(() => mergeNewAuthorCatalog008(broken, fragment(), author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('作者ID衝突（baseline joinが0でない）はF008_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const conflicting: CatalogV2 = {
      ...baseline,
      authors: [
        ...baseline.authors.slice(0, 5),
        { ...baseline.authors[5]!, authorId: '001779' },
      ],
    };
    expect(() => mergeNewAuthorCatalog008(conflicting, fragment(), author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('audio ID衝突はF008_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const collidingFragment = fragment({
      audioAssets: [
        { ...fragmentAudioAssets()[0]!, audioId: baseline.audioAssets[0]!.audioId },
        ...fragmentAudioAssets().slice(1),
      ],
    });
    expect(() => mergeNewAuthorCatalog008(baseline, collidingFragment, author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('人間椅子にofficial-content-warningが欠落しているとF008_CATALOG_MERGE_CONFLICT（QA-F008 No.4）', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '056648'
        ? { ...work, notices: [{ textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] }] }
        : work),
    });
    expect(() => mergeNewAuthorCatalog008(baseline, missingNotice, author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('Ｄ坂の殺人事件にofficial-content-warningが欠落しているとF008_CATALOG_MERGE_CONFLICT（QA-F008 No.4）', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '056650'
        ? { ...work, notices: [{ textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] }] }
        : work),
    });
    expect(() => mergeNewAuthorCatalog008(baseline, missingNotice, author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('work順・workIdがF008_WORKSと不一致な場合はF008_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const reordered = fragment({ works: [...fragmentWorks()].reverse() });
    expect(() => mergeNewAuthorCatalog008(baseline, reordered, author)).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('未検証のverifiedAuthorはF008_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const fakeAuthor = { ...verifiedAuthor(baseline) };
    expect(() => mergeNewAuthorCatalog008(baseline, fragment(), fakeAuthor)).toThrow(F008CatalogError);
  });
});

describe('deriveF008RouteSet（f008-catalog.ts）', () => {
  function mergedFixture(): F008MergedCatalog {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    return mergeNewAuthorCatalog008(baseline, fragment(), author);
  }

  /** @des DES-F008-010 @fun FUN-F008-012 @ut UT-F008-012 */
  it('7作者・固定route集合からexact 10 routeを決定的に導出する', () => {
    const merged = mergedFixture();
    const first = deriveF008RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    const second = deriveF008RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    expect(first.routes).toEqual([
      '#/',
      '#/authors/akutagawa-ryunosuke',
      '#/authors/miyazawa-kenji',
      '#/authors/dazai-osamu',
      '#/authors/natsume-soseki',
      '#/authors/nakajima-atsushi',
      '#/authors/mori-ogai',
      '#/authors/edogawa-ranpo',
      '#/favorites',
      '#/credits',
    ]);
    expect(first.routes.length).toBe(10);
    expect(first.digest).toBe(second.digest);
  });

  /** @des DES-F008-010 @fun FUN-F008-012 @ut UT-F008-012 */
  it('未mintのCatalogはF008_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    const forged = { ...merged } as F008MergedCatalog;
    expect(() => deriveF008RouteSet(forged, ['#/', '#/favorites', '#/credits'])).toThrow(F008CatalogError);
  });

  /** @des DES-F008-010 @fun FUN-F008-012 @ut UT-F008-012 */
  it('staticRoutesが固定値と不一致な場合はF008_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    expect(() => deriveF008RouteSet(merged, ['#/', '#/favorites'])).toThrow(F008CatalogError);
  });
});
