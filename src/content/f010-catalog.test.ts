import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  F010CatalogError,
  deriveF010RouteSet,
  isMintedF010MergedCatalog,
  loadF010WorkNotices,
  mergeNewAuthorCatalog010,
  type F010CatalogFragment,
  type F010CatalogWorkV2,
  type F010MergedCatalog,
} from './f010-catalog.ts';
import {
  F010_WORKS,
  defineF010AuthorAndWorkRegistry,
  verifyF010AuthorIdentity,
  type F010VerifiedAuthor,
} from './f010-source.ts';
import type { CatalogAudioAssetV2, CatalogCandidateCountV2, CatalogV2 } from './processing.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha(value: string): Sha256 {
  return value as Sha256;
}

const BASELINE_AUTHOR_SLUGS = [
  'akutagawa-zunnosuke', 'miyazawa-zunji', 'dazai-osamu', 'natsume-soseki', 'nakajima-atsushi', 'mori-ogai',
  'edogawa-ranpo', 'yumeno-kyusaku',
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
  const works = Array.from({ length: 27 }, (_, index) => ({
    workId: `w${index}`,
    title: `作品${index}`,
    cardLink: `https://www.aozora.gr.jp/cards/000000/card${index}.html`,
    authorId: authors[index % authors.length]!.authorId,
    batchId: `F00${(index % 8) + 1}`,
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

function verifiedAuthor(baseline: CatalogV2): F010VerifiedAuthor {
  const registry = defineF010AuthorAndWorkRegistry();
  return verifyF010AuthorIdentity(registry, baseline);
}

function fragmentWorks(): readonly F010CatalogWorkV2[] {
  return F010_WORKS.map((expected) => ({
    workId: expected.workId,
    title: expected.title,
    cardLink: expected.cardUrl,
    authorId: '000074' as const,
    batchId: 'F010' as const,
    completionStatus: 'complete' as const,
    notices: [{ textKey: 'dialogue-excerpt-scope' as const, placements: ['work-list', 'work-detail', 'credits'] }],
    source: {} as F010CatalogWorkV2['source'],
    dialogues: [{
      dialogueId: sha256(`dialogue:${expected.workId}`),
      workId: expected.workId,
      order: 0,
      displayText: `「台詞-${expected.workId}」`,
      speechText: `「台詞-${expected.workId}」`,
      audioId: sha256(`audio:${expected.workId}`),
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {},
    } as unknown as F010CatalogWorkV2['dialogues'][number]],
  }));
}

function fragmentAudioAssets(): readonly CatalogAudioAssetV2[] {
  return F010_WORKS.map((expected) => ({
    audioId: sha256(`audio:${expected.workId}`),
    path: `audio/F010/${expected.workId}.wav`,
    bytes: 200,
    durationMs: 700,
    configHash: sha256(`config:${expected.workId}`),
    batchId: 'F010',
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

function fragment(overrides: Partial<F010CatalogFragment> = {}): F010CatalogFragment {
  return {
    batchId: 'F010',
    feature: 'F010',
    authorId: '000074',
    authorArtwork: {
      path: 'artwork/kajii-motojiro-zundamon.png',
      alt: '梶井基次郎ずんだもん',
      sha256: sha256('artwork:kajii-motojiro'),
    },
    works: fragmentWorks(),
    audioAssets: fragmentAudioAssets(),
    candidateCounts: candidateCounts(),
    acceptedAt: '2026-08-24T00:00:00.000Z',
    evidenceSha256: asSha(sha256('evidence:F010')),
    ...overrides,
  };
}

describe('mergeNewAuthorCatalog010（f010-catalog.ts）', () => {
  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('baseline join 0・非衝突時だけauthors 9・works 30のCatalogを返す', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const merged = mergeNewAuthorCatalog010(baseline, fragment(), author);
    expect(isMintedF010MergedCatalog(merged)).toBe(true);
    expect(merged.authors.length).toBe(9);
    expect(merged.works.length).toBe(30);
    expect(merged.authors.at(-1)?.authorId).toBe('000074');
    expect(merged.batches.at(-1)).toMatchObject({
      batchId: 'F010',
      feature: 'F010',
      authorId: '000074',
      workIds: ['000424', '000419', '000411'],
    });
    expect(merged.candidateCounts.total).toBe(26);
    expect(merged.candidateCounts.byBatch.F010).toEqual(candidateCounts());
    // baseline側の既存8作者27作品projectionは変化しない
    expect(merged.authors.slice(0, 8)).toEqual(baseline.authors);
    expect(merged.works.slice(0, 27)).toEqual(baseline.works);
    // 3作品全てがdialogue-excerpt-scopeのみでofficial-content-warningを含まない
    for (const workId of ['000424', '000419', '000411']) {
      const work = merged.works.find((item) => item.workId === workId);
      expect(work?.notices?.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    }
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('baselineの作者数が8以外はF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, authors: baseline.authors.slice(0, 7) };
    expect(() => mergeNewAuthorCatalog010(broken, fragment(), author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('baselineの作品数が27以外はF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const broken: CatalogV2 = { ...baseline, works: baseline.works.slice(0, 26) };
    expect(() => mergeNewAuthorCatalog010(broken, fragment(), author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('作者ID衝突（baseline joinが0でない）はF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const conflicting: CatalogV2 = {
      ...baseline,
      authors: [
        ...baseline.authors.slice(0, 7),
        { ...baseline.authors[7]!, authorId: '000074' },
      ],
    };
    expect(() => mergeNewAuthorCatalog010(conflicting, fragment(), author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('audio ID衝突はF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const collidingFragment = fragment({
      audioAssets: [
        { ...fragmentAudioAssets()[0]!, audioId: baseline.audioAssets[0]!.audioId },
        ...fragmentAudioAssets().slice(1),
      ],
    });
    expect(() => mergeNewAuthorCatalog010(baseline, collidingFragment, author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('檸檬にdialogue-excerpt-scopeが欠落しているとF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const missingNotice = fragment({
      works: fragmentWorks().map((work) => work.workId === '000424' ? { ...work, notices: [] } : work),
    });
    expect(() => mergeNewAuthorCatalog010(baseline, missingNotice, author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('Ｋの昇天へofficial-content-warningが誤って混入しているとF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const injected = fragment({
      works: fragmentWorks().map((work) => work.workId === '000419'
        ? {
            ...work,
            notices: [
              { textKey: 'dialogue-excerpt-scope' as const, placements: ['work-list', 'work-detail', 'credits'] as const },
              { textKey: 'official-content-warning' as const, placements: ['work-list', 'work-detail', 'credits'] as const },
            ],
          }
        : work),
    });
    expect(() => mergeNewAuthorCatalog010(baseline, injected, author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('work順・workIdがF010_WORKSと不一致な場合はF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    const reordered = fragment({ works: [...fragmentWorks()].reverse() });
    expect(() => mergeNewAuthorCatalog010(baseline, reordered, author)).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('未検証のverifiedAuthorはF010_CATALOG_MERGE_CONFLICT', () => {
    const baseline = baselineCatalog();
    const fakeAuthor = { ...verifiedAuthor(baseline) };
    expect(() => mergeNewAuthorCatalog010(baseline, fragment(), fakeAuthor)).toThrow(F010CatalogError);
  });
});

describe('deriveF010RouteSet（f010-catalog.ts）', () => {
  function mergedFixture(): F010MergedCatalog {
    const baseline = baselineCatalog();
    const author = verifiedAuthor(baseline);
    return mergeNewAuthorCatalog010(baseline, fragment(), author);
  }

  /** @des DES-F010-010 @fun FUN-F010-012 @ut UT-F010-012 */
  it('9作者・固定route集合からexact 12 routeを決定的に導出する', () => {
    const merged = mergedFixture();
    const first = deriveF010RouteSet(merged, ['#/', '#/favorites', '#/credits']);
    const second = deriveF010RouteSet(merged, ['#/', '#/favorites', '#/credits']);
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
      '#/favorites',
      '#/credits',
    ]);
    expect(first.routes.length).toBe(12);
    expect(first.digest).toBe(second.digest);
  });

  /** @des DES-F010-010 @fun FUN-F010-012 @ut UT-F010-012 */
  it('未mintのCatalogはF010_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    const forged = { ...merged } as F010MergedCatalog;
    expect(() => deriveF010RouteSet(forged, ['#/', '#/favorites', '#/credits'])).toThrow(F010CatalogError);
  });

  /** @des DES-F010-010 @fun FUN-F010-012 @ut UT-F010-012 */
  it('staticRoutesが固定値と不一致な場合はF010_ROUTE_SET_INVALID', () => {
    const merged = mergedFixture();
    expect(() => deriveF010RouteSet(merged, ['#/', '#/favorites'])).toThrow(F010CatalogError);
  });
});

describe('loadF010WorkNotices（f010-catalog.ts）', () => {
  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('committed F010 work-notices.jsonを読み、3作品全てdialogue-excerpt-scopeのみを返す', async () => {
    const report = await loadF010WorkNotices(process.cwd());
    expect(report.result).toBe('pass');
    expect(report.authorId).toBe('000074');
    expect(report.works).toHaveLength(3);
    for (const work of report.works) {
      expect(work.notices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
      expect(work.renderedNotices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    }
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('official-content-warningが混入したregistryを拒否する', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f010-notices-'));
    try {
      await mkdir(join(dir, 'content', 'batches', 'F010'), { recursive: true });
      const tampered = {
        authorId: '000074',
        schemaVersion: '1.0.0',
        works: [
          {
            cardUrl: 'https://www.aozora.gr.jp/cards/000074/card424.html',
            completionStatus: 'complete',
            notices: [
              { placements: ['work-list', 'work-detail', 'credits'], textKey: 'dialogue-excerpt-scope' },
              { placements: ['work-list', 'work-detail', 'credits'], textKey: 'official-content-warning' },
            ],
            title: '檸檬',
            workId: '000424',
          },
          {
            cardUrl: 'https://www.aozora.gr.jp/cards/000074/card419.html',
            completionStatus: 'complete',
            notices: [{ placements: ['work-list', 'work-detail', 'credits'], textKey: 'dialogue-excerpt-scope' }],
            title: 'Ｋの昇天',
            workId: '000419',
          },
          {
            cardUrl: 'https://www.aozora.gr.jp/cards/000074/card411.html',
            completionStatus: 'complete',
            notices: [{ placements: ['work-list', 'work-detail', 'credits'], textKey: 'dialogue-excerpt-scope' }],
            title: '愛撫',
            workId: '000411',
          },
        ],
      };
      await writeFile(
        join(dir, 'content', 'batches', 'F010', 'work-notices.json'),
        canonicalJson(tampered),
      );
      await expect(loadF010WorkNotices(dir)).rejects.toThrow(F010CatalogError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011 */
  it('workspace外への相対pathやworkspace相対でないpathを拒否する', async () => {
    await expect(loadF010WorkNotices('relative/path')).rejects.toThrow(F010CatalogError);
  });
});
