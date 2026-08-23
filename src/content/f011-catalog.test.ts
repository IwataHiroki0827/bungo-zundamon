import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  F011CatalogError,
  deriveF011RouteSet,
  isMintedF011MergedCatalog,
  loadF011WorkNotices,
  mergeNewAuthorCatalog011,
  type F011CatalogFragment,
  type F011CatalogWorkV2,
  type F011MergedCatalog,
} from './f011-catalog.ts';
import {
  F011_WORKS,
  defineF011AuthorAndWorkRegistry,
  verifyF011AuthorIdentity,
  type F011VerifiedAuthor,
} from './f011-source.ts';
import type { CatalogAudioAssetV2, CatalogCandidateCountV2, CatalogV2 } from './processing.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

const BASELINE_AUTHOR_SLUGS = [
  'akutagawa-zunnosuke', 'miyazawa-zunji', 'dazai-osamu', 'natsume-soseki', 'nakajima-atsushi', 'mori-ogai',
  'edogawa-ranpo', 'yumeno-kyusaku', 'kajii-motojiro',
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
  const works = Array.from({ length: 30 }, (_, index) => ({
    workId: `w${index}`,
    title: `作品${index}`,
    cardLink: `https://www.aozora.gr.jp/cards/000000/card${index}.html`,
    authorId: authors[index % authors.length]!.authorId,
    batchId: `F00${(index % 9) + 1}`,
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

function verifiedAuthor(baseline: CatalogV2): F011VerifiedAuthor {
  const registry = defineF011AuthorAndWorkRegistry();
  return verifyF011AuthorIdentity(registry, baseline);
}

function fragmentWorks(): readonly F011CatalogWorkV2[] {
  return F011_WORKS.map((expected) => ({
    workId: expected.workId,
    title: expected.title,
    cardLink: expected.cardUrl,
    authorId: '000121' as const,
    batchId: 'F011' as const,
    completionStatus: 'complete' as const,
    notices: [{ textKey: 'dialogue-excerpt-scope' as const, placements: ['work-list', 'work-detail', 'credits'] }],
    source: {} as F011CatalogWorkV2['source'],
    dialogues: [{
      dialogueId: sha256(`dialogue:${expected.workId}`),
      workId: expected.workId,
      order: 0,
      displayText: `「台詞-${expected.workId}」`,
      speechText: `「台詞-${expected.workId}」`,
      audioId: sha256(`audio:${expected.workId}`),
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {},
    } as unknown as F011CatalogWorkV2['dialogues'][number]],
  }));
}

function fragmentAudioAssets(): readonly CatalogAudioAssetV2[] {
  return F011_WORKS.map((expected) => ({
    audioId: sha256(`audio:${expected.workId}`),
    path: `audio/F011/${expected.workId}.wav`,
    bytes: 200,
    durationMs: 700,
    configHash: sha256(`config:${expected.workId}`),
    batchId: 'F011',
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

function fragment(overrides: Partial<F011CatalogFragment> = {}): F011CatalogFragment {
  return {
    batchId: 'F011',
    feature: 'F011',
    authorId: '000121',
    authorArtwork: {
      path: 'artwork/niimi-nankichi-zundamon.png',
      alt: '新美南吉ずんだもん',
      sha256: sha256('artwork:niimi-nankichi'),
    },
    works: fragmentWorks(),
    audioAssets: fragmentAudioAssets(),
    candidateCounts: candidateCounts(),
    acceptedAt: '2026-08-24T00:00:00.000Z',
    evidenceSha256: asSha(sha256('evidence:F011')),
    ...overrides,
  };
}

describe('mergeNewAuthorCatalog011（f011-catalog.ts）', () => {
  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('baseline join 0・非衝突時だけauthors 10・works 33のCatalogを返す', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog011(baseline, fragment(), author);
    expect(isMintedF011MergedCatalog(merged)).toBe(true);
    expect(merged.authors.length).toBe(10);
    expect(merged.works.length).toBe(33);
    expect(merged.authors.at(-1)?.authorId).toBe('000121');
    expect(merged.batches.at(-1)).toMatchObject({
      batchId: 'F011',
      feature: 'F011',
      authorId: '000121',
      workIds: ['000637', '000628', '004718'],
    });
    expect(merged.candidateCounts.total).toBe(26);
    expect(merged.candidateCounts.byBatch.F011).toEqual(candidateCounts());
    // baseline側の既存9作者30作品projectionは変化しない
    expect(merged.authors.slice(0, 9)).toEqual(baseline.authors);
    expect(merged.works.slice(0, 30)).toEqual(baseline.works);
    // 3作品全てがdialogue-excerpt-scopeのみでofficial-content-warningを含まない
    for (const workId of ['000637', '000628', '004718']) {
      const work = merged.works.find((item) => item.workId === workId);
      expect(work?.notices?.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    }
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('baselineの作者数が9以外はF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, authors: baseline.authors.slice(0, 8) };
    expect(() => mergeNewAuthorCatalog011(broken, fragment(), author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('baselineの作品数が30以外はF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, works: baseline.works.slice(0, 29) };
    expect(() => mergeNewAuthorCatalog011(broken, fragment(), author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('作者ID衝突（baseline joinが0でない）はF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const conflicting: CatalogV2 = {
      ...baseline,
      authors: [
        ...baseline.authors.slice(0, 8),
        { ...baseline.authors[8]!, authorId: '000121' },
      ],
    };
    expect(() => mergeNewAuthorCatalog011(conflicting, fragment(), author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('audio ID衝突はF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const collidingFragment = fragment({
      audioAssets: [
        { ...fragmentAudioAssets()[0]!, audioId: baseline.audioAssets[0]!.audioId },
        ...fragmentAudioAssets().slice(1),
      ],
    });
    expect(() => mergeNewAuthorCatalog011(baseline, collidingFragment, author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('手袋を買いににdialogue-excerpt-scopeが欠落しているとF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '000637' ? { ...work, notices: [] } : work),
    });
    expect(() => mergeNewAuthorCatalog011(baseline, missingNotice, author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('ごん狐へofficial-content-warningが誤って混入しているとF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const injected = fragment({
      works: fragmentWorks().map((work) => work.workId === '000628'
        ? {
            ...work,
            notices: [
              { textKey: 'dialogue-excerpt-scope' as const, placements: ['work-list', 'work-detail', 'credits'] as const },
              { textKey: 'official-content-warning' as const, placements: ['work-list', 'work-detail', 'credits'] as const },
            ],
          }
        : work),
    });
    expect(() => mergeNewAuthorCatalog011(baseline, injected, author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('work順・workIdがF011_WORKSと不一致な場合はF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const reordered = fragment({ works: [...fragmentWorks()].reverse() });
    expect(() => mergeNewAuthorCatalog011(baseline, reordered, author)).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('未検証のverifiedAuthorはF011_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const fakeAuthor = { ...verifiedAuthor(baseline) };
    expect(() => mergeNewAuthorCatalog011(baseline, fragment(), fakeAuthor)).toThrow(F011CatalogError);
  });
});

describe('deriveF011RouteSet（f011-catalog.ts）', () => {
  function mergedFixture(): F011MergedCatalog {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    return mergeNewAuthorCatalog011(baseline, fragment(), author);
  }

  /** @des DES-F011-010 @fun FUN-F011-012 @ut UT-F011-012 */
  it('10作者・固定route集合からexact 13 routeを決定的に導出する', () => {
    const merged = mergedFixture();
    const first = deriveF011RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    const second = deriveF011RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    expect(first.routes).toEqual([
      '#/',
      '#/authors/akutagawa-zunnosuke',
      '#/authors/miyazawa-zunji',
      '#/authors/dazai-osamu',
      '#/authors/natsume-soseki',
      '#/authors/nakajima-atsushi',
      '#/authors/mori-ogai',
      '#/authors/edogawa-ranpo',
      '#/authors/yumeno-kyusaku',
      '#/authors/kajii-motojiro',
      '#/authors/niimi-nankichi',
      '#/favorites',
      '#/credits',
    ]);
    expect(first.routes.length).toBe(13);
    expect(first.digest).toBe(second.digest);
  });

  /** @des DES-F011-010 @fun FUN-F011-012 @ut UT-F011-012 */
  it('未mintのCatalogはF011_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    const forged = { ...merged } as F011MergedCatalog;
    expect(() => deriveF011RouteSet(forged, ['#/', '#/favorites', '#/credits'])).toThrow(F011CatalogError);
  });

  /** @des DES-F011-010 @fun FUN-F011-012 @ut UT-F011-012 */
  it('staticRoutesが固定値と不一致な場合はF011_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    expect(() => deriveF011RouteSet(merged, ['#/', '#/favorites'])).toThrow(F011CatalogError);
  });
});

describe('loadF011WorkNotices（f011-catalog.ts）', () => {
  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('committed F011 work-notices.jsonを読み、3作品全てdialogue-excerpt-scopeのみを返す', async () => {
    const report = await loadF011WorkNotices(process.cwd());
    expect(report.result).toBe('pass');
    expect(report.authorId).toBe('000121');
    expect(report.works).toHaveLength(3);
    for (const work of report.works) {
      expect(work.notices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
      expect(work.renderedNotices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    }
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('official-content-warningが混入したregistryを拒否する', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f011-notices-'));
    try {
      await mkdir(join(dir, 'content', 'batches', 'F011'), { recursive: true });
      const tampered = {
        authorId: '000121',
        schemaVersion: '1.0.0',
        works: [
          {
            cardUrl: 'https://www.aozora.gr.jp/cards/000121/card637.html',
            completionStatus: 'complete',
            notices: [
              { placements: ['work-list', 'work-detail', 'credits'], textKey: 'dialogue-excerpt-scope' },
              { placements: ['work-list', 'work-detail', 'credits'], textKey: 'official-content-warning' },
            ],
            title: '手袋を買いに',
            workId: '000637',
          },
          {
            cardUrl: 'https://www.aozora.gr.jp/cards/000121/card628.html',
            completionStatus: 'complete',
            notices: [{ placements: ['work-list', 'work-detail', 'credits'], textKey: 'dialogue-excerpt-scope' }],
            title: 'ごん狐',
            workId: '000628',
          },
          {
            cardUrl: 'https://www.aozora.gr.jp/cards/000121/card4718.html',
            completionStatus: 'complete',
            notices: [{ placements: ['work-list', 'work-detail', 'credits'], textKey: 'dialogue-excerpt-scope' }],
            title: '二ひきの蛙',
            workId: '004718',
          },
        ],
      };
      await writeFile(
        join(dir, 'content', 'batches', 'F011', 'work-notices.json'),
        canonicalJson(tampered),
      );
      await expect(loadF011WorkNotices(dir)).rejects.toThrow(F011CatalogError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** @des DES-F011-010 @fun FUN-F011-011 @ut UT-F011-011 */
  it('workspace外への相対pathやworkspace相対でないpathを拒否する', async () => {
    await expect(loadF011WorkNotices('relative/path')).rejects.toThrow(F011CatalogError);
  });
});
