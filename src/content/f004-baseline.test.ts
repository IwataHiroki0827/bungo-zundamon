import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F004_V030_PINS,
  loadPublishedV030Baseline,
  nodePublishedV030GitAdapter,
  PublishedV030BaselineError,
} from './f004-baseline.ts';

const workspace = resolve('.');

describe('FUN-F004-002 v0.3.0二重baseline', () => {
  /** @des DES-F004-002 @fun FUN-F004-002 @test UT-F004-002 */
  it('release payloadとpublished controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV030Baseline(workspace, F004_V030_PINS);

    expect(baseline.__brand).toBe('PublishedV030Baseline');
    expect(baseline.pins.releaseCommit).not.toBe(baseline.pins.controlCommit);
    expect(baseline.publicFiles).toHaveLength(492);
    expect(baseline.catalog.authors).toHaveLength(3);
    expect(baseline.catalog.works).toHaveLength(9);
    expect(baseline.catalog.audioAssets).toHaveLength(463);
    expect(baseline.controlManifest.status).toBe('published');
    expect(baseline.artwork).toMatchObject({
      __brand: 'TrustedPublishedArtwork',
      authorId: '000081',
      batchId: 'F002',
      bytes: 3_118_359,
      provenanceSha256: '304f035c2e3f477b900740ac6aaf400182dffc08aad3bef442b5f237a0cffb12',
    });
    expect(Object.isFrozen(baseline.artwork)).toBe(true);
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F004-002 @fun FUN-F004-002 @test UT-F004-002 */
  it.each([
    ['release/control逆転', { releaseCommit: F004_V030_PINS.controlCommit }],
    ['tag差', { tag: 'v0.2.1' }],
    ['catalog差', { catalogSha256: '0'.repeat(64) }],
    ['dist差', { distSha256: '0'.repeat(64) }],
    ['artifact件数差', { artifactFiles: 494 }],
    ['artifact byte差', { artifactBytes: 164_314_349 }],
    ['manifest差', { f003ManifestSha256: '0'.repeat(64) }],
  ])('%sをF004_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F004_V030_PINS, ...patch } as unknown as typeof F004_V030_PINS;
    await expect(loadPublishedV030Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F004_BASELINE_MISMATCH' } satisfies Partial<PublishedV030BaselineError>,
    );
  });

  /** @des DES-F004-002 @des DES-F004-007 @fun FUN-F004-002 @fun FUN-F004-023 @test UT-F004-002 */
  it.each([
    'public/content/artwork-provenances.json',
    'public/content/artwork-provenance/F002.json',
    'public/artwork/miyazawa-zundamon.png',
  ])('%sのrelease object改ざんを拒否する', async (target) => {
    const git = {
      ...nodePublishedV030GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV030GitAdapter.readObject(root, commit, path);
        if (path !== target) return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV030Baseline(
      workspace,
      F004_V030_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F004_BASELINE_MISMATCH' });
  });
});
