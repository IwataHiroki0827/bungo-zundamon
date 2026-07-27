import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F004_V030_PINS,
  loadPublishedV030Baseline,
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
});
