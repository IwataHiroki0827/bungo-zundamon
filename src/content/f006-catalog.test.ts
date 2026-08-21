import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Sha256 } from './batch.ts';
import {
  F006CatalogError,
  deriveF006RouteSet,
  isMintedF006MergedCatalog,
  mergeNewAuthorCatalog006,
  type F006CatalogFragment,
  type F006CatalogWorkV2,
  type F006MergedCatalog,
} from './f006-catalog.ts';
import {
  F006_WORKS,
  defineF006AuthorAndWorkRegistry,
  verifyF006AuthorIdentity,
  type F006VerifiedAuthor,
} from './f006-source.ts';
import type { CatalogAudioAssetV2, CatalogCandidateCountV2, CatalogV2 } from './processing.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

const BASELINE_AUTHOR_SLUGS = ['akutagawa-ryunosuke', 'miyazawa-kenji', 'dazai-osamu', 'natsume-soseki'] as const;

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
  const works = Array.from({ length: 15 }, (_, index) => ({
    workId: `w${index}`,
    title: `作品${index}`,
    cardLink: `https://www.aozora.gr.jp/cards/000000/card${index}.html`,
    authorId: authors[index % authors.length]!.authorId,
    batchId: `F00${(index % 4) + 1}`,
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

function verifiedAuthor(baseline: CatalogV2): F006VerifiedAuthor {
  const registry = defineF006AuthorAndWorkRegistry();
  return verifyF006AuthorIdentity(registry, baseline);
}

function fragmentWorks(): readonly F006CatalogWorkV2[] {
  return F006_WORKS.map((expected) => ({
    workId: expected.workId,
    title: expected.title,
    cardLink: expected.cardUrl,
    authorId: '000119' as const,
    batchId: 'F006' as const,
    source: {} as F006CatalogWorkV2['source'],
    dialogues: [{
      dialogueId: sha256(`dialogue:${expected.workId}`),
      workId: expected.workId,
      order: 0,
      displayText: `「台詞-${expected.workId}」`,
      speechText: `「台詞-${expected.workId}」`,
      audioId: sha256(`audio:${expected.workId}`),
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {},
    } as unknown as F006CatalogWorkV2['dialogues'][number]],
  }));
}

function fragmentAudioAssets(): readonly CatalogAudioAssetV2[] {
  return F006_WORKS.map((expected) => ({
    audioId: sha256(`audio:${expected.workId}`),
    path: `audio/F006/${expected.workId}.wav`,
    bytes: 200,
    durationMs: 700,
    configHash: sha256(`config:${expected.workId}`),
    batchId: 'F006',
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

function fragment(overrides: Partial<F006CatalogFragment> = {}): F006CatalogFragment {
  return {
    batchId: 'F006',
    feature: 'F006',
    authorId: '000119',
    authorArtwork: {
      path: 'artwork/nakajima-zundamon.png',
      alt: '中島敦ずんだもん',
      sha256: sha256('artwork:nakajima'),
    },
    works: fragmentWorks(),
    audioAssets: fragmentAudioAssets(),
    candidateCounts: candidateCounts(),
    notices: [],
    acceptedAt: '2026-08-21T00:00:00.000Z',
    evidenceSha256: asSha(sha256('evidence:F006')),
    ...overrides,
  };
}

describe('mergeNewAuthorCatalog006（f006-catalog.ts）', () => {
  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('baseline join 0・非衝突時だけauthors 5・works 18のCatalogを返す', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog006(baseline, fragment(), author);
    expect(isMintedF006MergedCatalog(merged)).toBe(true);
    expect(merged.authors.length).toBe(5);
    expect(merged.works.length).toBe(18);
    expect(merged.authors.at(-1)?.authorId).toBe('000119');
    expect(merged.batches.at(-1)).toMatchObject({
      batchId: 'F006',
      feature: 'F006',
      authorId: '000119',
      workIds: ['000624', '000621', '001738'],
    });
    expect(merged.candidateCounts.total).toBe(26);
    expect(merged.candidateCounts.byBatch.F006).toEqual(candidateCounts());
    // baseline側の既存4作者15作品projectionは変化しない
    expect(merged.authors.slice(0, 4)).toEqual(baseline.authors);
    expect(merged.works.slice(0, 15)).toEqual(baseline.works);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('baselineの作者数が4以外はF006_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, authors: baseline.authors.slice(0, 3) };
    expect(() => mergeNewAuthorCatalog006(broken, fragment(), author)).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('baselineの作品数が15以外はF006_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, works: baseline.works.slice(0, 14) };
    expect(() => mergeNewAuthorCatalog006(broken, fragment(), author)).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('作者ID衝突（baseline joinが0でない）はF006_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const conflicting: CatalogV2 = {
      ...baseline,
      authors: [
        ...baseline.authors.slice(0, 3),
        { ...baseline.authors[3]!, authorId: '000119' },
      ],
    };
    expect(() => mergeNewAuthorCatalog006(conflicting, fragment(), author)).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('audio ID衝突はF006_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const collidingFragment = fragment({
      audioAssets: [
        { ...fragmentAudioAssets()[0]!, audioId: baseline.audioAssets[0]!.audioId },
        ...fragmentAudioAssets().slice(1),
      ],
    });
    expect(() => mergeNewAuthorCatalog006(baseline, collidingFragment, author)).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('fragment.noticesが非空はF006_CATALOG_MERGE_CONFLICT（QA-F006 No.4）', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const withNotice = fragment({
      notices: [{ dummy: true }] as unknown as readonly [],
    });
    expect(() => mergeNewAuthorCatalog006(baseline, withNotice, author)).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('work順・workIdがF006_WORKSと不一致な場合はF006_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const reordered = fragment({ works: [...fragmentWorks()].reverse() });
    expect(() => mergeNewAuthorCatalog006(baseline, reordered, author)).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011 */
  it('未検証のverifiedAuthorはF006_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const fakeAuthor = { ...verifiedAuthor(baseline) };
    expect(() => mergeNewAuthorCatalog006(baseline, fragment(), fakeAuthor)).toThrow(F006CatalogError);
  });
});

describe('deriveF006RouteSet（f006-catalog.ts）', () => {
  function mergedFixture(): F006MergedCatalog {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    return mergeNewAuthorCatalog006(baseline, fragment(), author);
  }

  /** @des DES-F006-010 @fun FUN-F006-012 @ut UT-F006-012 */
  it('5作者・固定route集合からexact 8 routeを決定的に導出する', () => {
    const merged = mergedFixture();
    const first = deriveF006RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    const second = deriveF006RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    expect(first.routes).toEqual([
      '#/',
      '#/authors/akutagawa-ryunosuke',
      '#/authors/miyazawa-kenji',
      '#/authors/dazai-osamu',
      '#/authors/natsume-soseki',
      '#/authors/nakajima-atsushi',
      '#/favorites',
      '#/credits',
    ]);
    expect(first.routes.length).toBe(8);
    expect(first.digest).toBe(second.digest);
  });

  /** @des DES-F006-010 @fun FUN-F006-012 @ut UT-F006-012 */
  it('未mintのCatalogはF006_ROUTE_SET_INVALID', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog006(baseline, fragment(), author);
    const forged = { ...merged } as F006MergedCatalog;
    expect(() => deriveF006RouteSet(forged, ['#/', '#/favorites', '#/credits'])).toThrow(F006CatalogError);
  });

  /** @des DES-F006-010 @fun FUN-F006-012 @ut UT-F006-012 */
  it('staticRoutesが固定値と不一致な場合はF006_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    expect(() => deriveF006RouteSet(merged, ['#/', '#/favorites'])).toThrow(F006CatalogError);
  });
});
