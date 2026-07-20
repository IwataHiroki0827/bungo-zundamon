import { describe, expect, it } from 'vitest';

import { parseRouteV2, resolveRoute } from './routes.ts';
import type { UICatalogV2 } from './types.ts';

function catalog(authors: Array<{ authorId: string; slug: string }>): UICatalogV2 {
  return {
    schemaVersion: '2.0.0',
    authors: authors.map((author) => ({
      ...author,
      name: author.slug,
      originalName: author.slug,
      artwork: { path: `artwork/${author.slug}.png`, alt: author.slug, sha256: 'a'.repeat(64) },
      introducedByBatchId: 'F001',
      identitySha256: 'b'.repeat(64),
    })),
    works: [],
    audioAssets: [],
    batches: [],
    candidateCounts: { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0, byBatch: {} },
    creditsRef: 'content/licenses.json',
  } as UICatalogV2;
}

describe('FUN-F002-020 parseRouteV2', () => {
  it.each([
    ['#/', { kind: 'home' }],
    ['#/credits', { kind: 'credits' }],
    ['#/authors/miyazawa-zunji', { kind: 'authorSlug', slug: 'miyazawa-zunji' }],
    ['#/authors/miyazawa%2Dzunji', { kind: 'authorSlug', slug: 'miyazawa-zunji' }],
  ])('%sを既知routeとして構文解析する', (hash, expected) => {
    expect(parseRouteV2(hash)).toEqual(expected);
  });

  it.each([
    '', '#', '#/authors/', '#/authors/miyazawa-zunji/extra', '#/authors/miyazawa%2Fzunji', '#/%ZZ',
    '#/authors/https:%2F%2Fevil.example', '//evil.example', 'https://evil.example', '#/authors/a\u0000b', '#/authors/a%00b',
    `#/${'a'.repeat(253)}`,
  ])('unsafeまたは未知hashを例外なしnotFoundへ倒す: %s', (hash) => {
    expect(hash.length).toBeLessThanOrEqual(257);
    expect(() => parseRouteV2(hash)).not.toThrow();
    expect(parseRouteV2(hash)).toEqual({ kind: 'notFound' });
  });

  it('256文字境界を処理し257文字を長さで拒否する', () => {
    const boundary = `#/${'a'.repeat(254)}`;
    const tooLong = `${boundary}a`;
    expect(boundary).toHaveLength(256);
    expect(tooLong).toHaveLength(257);
    expect(parseRouteV2(boundary)).toEqual({ kind: 'notFound' });
    expect(parseRouteV2(tooLong)).toEqual({ kind: 'notFound' });
  });
});

describe('FUN-F002-021 resolveRoute', () => {
  const valid = catalog([
    { authorId: '000879', slug: 'akutagawa-zunnosuke' },
    { authorId: '000081', slug: 'miyazawa-zunji' },
  ]);

  it('一意slugをauthorId付きrouteへ解決する', () => {
    expect(resolveRoute({ kind: 'authorSlug', slug: 'miyazawa-zunji' }, valid)).toEqual({
      kind: 'author', authorId: '000081', slug: 'miyazawa-zunji',
    });
    expect(resolveRoute({ kind: 'home' }, valid)).toEqual({ kind: 'home' });
    expect(resolveRoute({ kind: 'credits' }, valid)).toEqual({ kind: 'credits' });
  });

  it('未知slugとschema境界を迂回した重複slugをnotFoundへ倒す', () => {
    expect(resolveRoute({ kind: 'authorSlug', slug: 'unknown' }, valid)).toEqual({ kind: 'notFound' });
    const ambiguous = catalog([
      { authorId: '000879', slug: 'same-author' },
      { authorId: '000081', slug: 'same-author' },
    ]);
    expect(resolveRoute({ kind: 'authorSlug', slug: 'same-author' }, ambiguous)).toEqual({ kind: 'notFound' });
  });
});
