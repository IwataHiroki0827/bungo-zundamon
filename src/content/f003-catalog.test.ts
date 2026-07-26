import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadAcceptedF003CatalogFragment,
  loadPublishedF002CatalogFragment,
} from './f003-catalog.ts';
import {
  F002_PUBLISHED_RELEASE,
  loadAndVerifyPublishedBaseline,
} from './published-baseline.ts';

describe('UT-F003-022 最終Catalog fragment統合 [DES-F003-009][FUN-F003-022]', () => {
  it('固定F002とaccepted F003を永続artifactからデータ駆動で復元する', async () => {
    const workspace = resolve(process.cwd());
    const baseline = await loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE);
    const [f002, f003] = await Promise.all([
      loadPublishedF002CatalogFragment(workspace, baseline.catalog),
      loadAcceptedF003CatalogFragment(workspace),
    ]);

    expect(f002.works).toHaveLength(3);
    expect(f003.authors).toMatchObject([{ authorId: '000035', introducedByBatchId: 'F003' }]);
    expect(f003.works.map((work) => [work.workId, work.title])).toEqual([
      ['000275', '女生徒'],
      ['001567', '走れメロス'],
      ['000258', 'グッド・バイ'],
    ]);
    expect(f003.works.find((work) => work.workId === '000258')).toMatchObject({
      completionStatus: 'unfinished',
      notices: expect.arrayContaining([
        expect.objectContaining({ textKey: 'unfinished' }),
        expect.objectContaining({ textKey: 'official-content-warning' }),
        expect.objectContaining({ textKey: 'dialogue-excerpt-scope' }),
      ]),
    });
    expect(f003.candidateCounts).toMatchObject({
      total: 282,
      published: 259,
      editorialExcluded: 23,
      audioExcluded: 0,
    });
    expect(f003.audioAssets).toHaveLength(255);
    expect(new Set(f003.audioAssets.map((asset) => asset.audioId)).size).toBe(255);
    expect(f003.publicFiles).toHaveLength(4);
  }, 15_000);
});
