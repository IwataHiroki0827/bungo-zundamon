import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F009_V080_PINS,
  isMintedPublishedV080Baseline,
  loadPublishedV080Baseline,
  nodePublishedV080GitAdapter,
  PublishedV080BaselineError,
} from './f009-baseline.ts';

const workspace = resolve('.');

describe('FUN-F009-002 v0.8.0固定baseline', () => {
  /** @des DES-F009-002 @fun FUN-F009-002 @test UT-F009-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV080Baseline(workspace, F009_V080_PINS);

    expect(baseline.__brand).toBe('PublishedV080Baseline');
    expect(baseline.pins.releaseCommit).toBe(F009_V080_PINS.releaseCommit);
    expect(baseline.publicFiles).toHaveLength(1234);
    expect(baseline.catalog.authors).toHaveLength(7);
    expect(baseline.catalog.works).toHaveLength(24);
    expect(baseline.catalog.audioAssets).toHaveLength(1182);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(1199);
    expect(baseline.controlManifest.batchId).toBe('F008');
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F009-002 @fun FUN-F009-002 @test UT-F009-002 */
  it.each([
    ['commit差', { releaseCommit: '0'.repeat(40) }],
    ['tag差', { tag: 'v0.7.0' }],
    ['catalog SHA差', { catalogSha256: '0'.repeat(64) }],
    ['dist SHA差', { distSha256: '0'.repeat(64) }],
    ['artifact SHA差', { artifactDigest: '0'.repeat(64) }],
  ])('%sをF009_PUBLISHED_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F009_V080_PINS, ...patch } as unknown as typeof F009_V080_PINS;
    await expect(loadPublishedV080Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F009_PUBLISHED_BASELINE_MISMATCH' } satisfies Partial<PublishedV080BaselineError>,
    );
  });

  /** @des DES-F009-002 @fun FUN-F009-002 @test UT-F009-002 */
  it('候補checkoutの現行public treeからは再導出しない(固定Git objectのみを読む)', async () => {
    const calls: string[] = [];
    const git = {
      ...nodePublishedV080GitAdapter,
      async listPublicTree(root: string, commit: string) {
        calls.push(commit);
        return nodePublishedV080GitAdapter.listPublicTree(root, commit);
      },
    };
    const baseline = await loadPublishedV080Baseline(workspace, F009_V080_PINS, { git });
    expect(calls).toEqual([F009_V080_PINS.releaseCommit]);
    expect(baseline.publicFiles.length).toBe(1234);
  });

  /** @des DES-F009-002 @fun FUN-F009-002 @test UT-F009-002 */
  it('public objectの改ざんを拒否する', async () => {
    const git = {
      ...nodePublishedV080GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV080GitAdapter.readObject(root, commit, path);
        if (path !== 'public/content/catalog.json') return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV080Baseline(
      workspace,
      F009_V080_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F009_PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('FUN-F009-003 isMintedPublishedV080Baseline', () => {
  /** @des DES-F009-002 @fun FUN-F009-003 @test UT-F009-003 */
  it('work preview・統合tree・distの3段階で同一bundleをbrand検査する', async () => {
    const baseline = await loadPublishedV080Baseline(workspace, F009_V080_PINS);
    expect(isMintedPublishedV080Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV080Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV080Baseline(baseline)).toBe(true);
  });

  /** @des DES-F009-002 @fun FUN-F009-003 @test UT-F009-003 */
  it('未mint値・偽造値・改変値をfalseとする', async () => {
    const baseline = await loadPublishedV080Baseline(workspace, F009_V080_PINS);
    expect(isMintedPublishedV080Baseline({ ...baseline })).toBe(false);
    expect(isMintedPublishedV080Baseline({ __brand: 'PublishedV080Baseline' })).toBe(false);
    expect(isMintedPublishedV080Baseline(null)).toBe(false);
    expect(isMintedPublishedV080Baseline(undefined)).toBe(false);
  });
});
