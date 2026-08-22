import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Sha256 } from './batch.ts';
import {
  F007CatalogError,
  deriveF007RouteSet,
  isMintedF007MergedCatalog,
  mergeNewAuthorCatalog007,
  type F007CatalogFragment,
  type F007CatalogWorkV2,
  type F007MergedCatalog,
} from './f007-catalog.ts';
import {
  F007_WORKS,
  defineF007AuthorAndWorkRegistry,
  verifyF007AuthorIdentity,
  type F007VerifiedAuthor,
} from './f007-source.ts';
import type { CatalogAudioAssetV2, CatalogCandidateCountV2, CatalogV2 } from './processing.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

const BASELINE_AUTHOR_SLUGS = [
  'akutagawa-ryunosuke', 'miyazawa-kenji', 'dazai-osamu', 'natsume-soseki', 'nakajima-atsushi',
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
  const works = Array.from({ length: 18 }, (_, index) => ({
    workId: `w${index}`,
    title: `作品${index}`,
    cardLink: `https://www.aozora.gr.jp/cards/000000/card${index}.html`,
    authorId: authors[index % authors.length]!.authorId,
    batchId: `F00${(index % 5) + 1}`,
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

function verifiedAuthor(baseline: CatalogV2): F007VerifiedAuthor {
  const registry = defineF007AuthorAndWorkRegistry();
  return verifyF007AuthorIdentity(registry, baseline);
}

const NOTICE_KEYS: Readonly<Record<string, readonly ('official-content-warning' | 'dialogue-excerpt-scope')[]>> = {
  '058126': ['official-content-warning', 'dialogue-excerpt-scope'],
  '045245': ['dialogue-excerpt-scope'],
  '000689': ['dialogue-excerpt-scope'],
};

function fragmentWorks(): readonly F007CatalogWorkV2[] {
  return F007_WORKS.map((expected) => ({
    workId: expected.workId,
    title: expected.title,
    cardLink: expected.cardUrl,
    authorId: '000129' as const,
    batchId: 'F007' as const,
    completionStatus: 'complete' as const,
    notices: NOTICE_KEYS[expected.workId]!.map((textKey) => ({
      textKey,
      placements: ['work-list', 'work-detail', 'credits'],
    })),
    source: {} as F007CatalogWorkV2['source'],
    dialogues: [{
      dialogueId: sha256(`dialogue:${expected.workId}`),
      workId: expected.workId,
      order: 0,
      displayText: `「台詞-${expected.workId}」`,
      speechText: `「台詞-${expected.workId}」`,
      audioId: sha256(`audio:${expected.workId}`),
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {},
    } as unknown as F007CatalogWorkV2['dialogues'][number]],
  }));
}

function fragmentAudioAssets(): readonly CatalogAudioAssetV2[] {
  return F007_WORKS.map((expected) => ({
    audioId: sha256(`audio:${expected.workId}`),
    path: `audio/F007/${expected.workId}.wav`,
    bytes: 200,
    durationMs: 700,
    configHash: sha256(`config:${expected.workId}`),
    batchId: 'F007',
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

function fragment(overrides: Partial<F007CatalogFragment> = {}): F007CatalogFragment {
  return {
    batchId: 'F007',
    feature: 'F007',
    authorId: '000129',
    authorArtwork: {
      path: 'artwork/mori-ogai-zundamon.png',
      alt: '森鴎外ずんだもん',
      sha256: sha256('artwork:mori-ogai'),
    },
    works: fragmentWorks(),
    audioAssets: fragmentAudioAssets(),
    candidateCounts: candidateCounts(),
    acceptedAt: '2026-08-22T00:00:00.000Z',
    evidenceSha256: asSha(sha256('evidence:F007')),
    ...overrides,
  };
}

describe('mergeNewAuthorCatalog007（f007-catalog.ts）', () => {
  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('baseline join 0・非衝突時だけauthors 6・works 21のCatalogを返す', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog007(baseline, fragment(), author);
    expect(isMintedF007MergedCatalog(merged)).toBe(true);
    expect(merged.authors.length).toBe(6);
    expect(merged.works.length).toBe(21);
    expect(merged.authors.at(-1)?.authorId).toBe('000129');
    expect(merged.batches.at(-1)).toMatchObject({
      batchId: 'F007',
      feature: 'F007',
      authorId: '000129',
      workIds: ['058126', '045245', '000689'],
    });
    expect(merged.candidateCounts.total).toBe(26);
    expect(merged.candidateCounts.byBatch.F007).toEqual(candidateCounts());
    // baseline側の既存5作者18作品projectionは変化しない
    expect(merged.authors.slice(0, 5)).toEqual(baseline.authors);
    expect(merged.works.slice(0, 18)).toEqual(baseline.works);
    // 舞姫だけofficial-content-warningを持つ
    const maihime = merged.works.find((work) => work.workId === '058126');
    expect(maihime?.notices?.map((notice) => notice.textKey)).toEqual([
      'official-content-warning', 'dialogue-excerpt-scope',
    ]);
    const takasebune = merged.works.find((work) => work.workId === '045245');
    expect(takasebune?.notices?.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('baselineの作者数が5以外はF007_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, authors: baseline.authors.slice(0, 4) };
    expect(() => mergeNewAuthorCatalog007(broken, fragment(), author)).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('baselineの作品数が18以外はF007_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, works: baseline.works.slice(0, 17) };
    expect(() => mergeNewAuthorCatalog007(broken, fragment(), author)).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('作者ID衝突（baseline joinが0でない）はF007_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const conflicting: CatalogV2 = {
      ...baseline,
      authors: [
        ...baseline.authors.slice(0, 4),
        { ...baseline.authors[4]!, authorId: '000129' },
      ],
    };
    expect(() => mergeNewAuthorCatalog007(conflicting, fragment(), author)).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('audio ID衝突はF007_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const collidingFragment = fragment({
      audioAssets: [
        { ...fragmentAudioAssets()[0]!, audioId: baseline.audioAssets[0]!.audioId },
        ...fragmentAudioAssets().slice(1),
      ],
    });
    expect(() => mergeNewAuthorCatalog007(baseline, collidingFragment, author)).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('舞姫にofficial-content-warningが欠落しているとF007_CATALOG_MERGE_CONFLICT（QA-F007 No.4）', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '058126'
        ? { ...work, notices: [{ textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] }] }
        : work),
    });
    expect(() => mergeNewAuthorCatalog007(baseline, missingNotice, author)).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('work順・workIdがF007_WORKSと不一致な場合はF007_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const reordered = fragment({ works: [...fragmentWorks()].reverse() });
    expect(() => mergeNewAuthorCatalog007(baseline, reordered, author)).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-011 @ut UT-F007-011 */
  it('未検証のverifiedAuthorはF007_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const fakeAuthor = { ...verifiedAuthor(baseline) };
    expect(() => mergeNewAuthorCatalog007(baseline, fragment(), fakeAuthor)).toThrow(F007CatalogError);
  });
});

describe('deriveF007RouteSet（f007-catalog.ts）', () => {
  function mergedFixture(): F007MergedCatalog {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    return mergeNewAuthorCatalog007(baseline, fragment(), author);
  }

  /** @des DES-F007-010 @fun FUN-F007-012 @ut UT-F007-012 */
  it('6作者・固定route集合からexact 9 routeを決定的に導出する', () => {
    const merged = mergedFixture();
    const first = deriveF007RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    const second = deriveF007RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    expect(first.routes).toEqual([
      '#/',
      '#/authors/akutagawa-ryunosuke',
      '#/authors/miyazawa-kenji',
      '#/authors/dazai-osamu',
      '#/authors/natsume-soseki',
      '#/authors/nakajima-atsushi',
      '#/authors/mori-ogai',
      '#/favorites',
      '#/credits',
    ]);
    expect(first.routes.length).toBe(9);
    expect(first.digest).toBe(second.digest);
  });

  /** @des DES-F007-010 @fun FUN-F007-012 @ut UT-F007-012 */
  it('未mintのCatalogはF007_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    const forged = { ...merged } as F007MergedCatalog;
    expect(() => deriveF007RouteSet(forged, ['#/', '#/favorites', '#/credits'])).toThrow(F007CatalogError);
  });

  /** @des DES-F007-010 @fun FUN-F007-012 @ut UT-F007-012 */
  it('staticRoutesが固定値と不一致な場合はF007_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    expect(() => deriveF007RouteSet(merged, ['#/', '#/favorites'])).toThrow(F007CatalogError);
  });
});
