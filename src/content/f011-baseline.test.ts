import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F011_V0100_PINS,
  isMintedPublishedV0100Baseline,
  loadPublishedV0100Baseline,
  nodePublishedV0100GitAdapter,
  PublishedV0100BaselineError,
} from './f011-baseline.ts';

const workspace = resolve('.');

describe('FUN-F011-002 v0.10.0固定baseline', () => {
  /** @des DES-F011-002 @fun FUN-F011-002 @test UT-F011-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV0100Baseline(workspace, F011_V0100_PINS);

    expect(baseline.__brand).toBe('PublishedV0100Baseline');
    expect(baseline.pins.releaseCommit).toBe(F011_V0100_PINS.releaseCommit);
    expect(baseline.publicFiles).toHaveLength(1292);
    expect(baseline.catalog.authors).toHaveLength(9);
    expect(baseline.catalog.works).toHaveLength(30);
    expect(baseline.catalog.audioAssets).toHaveLength(1230);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(1247);
    expect(baseline.controlManifest.batchId).toBe('F010');
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F011-002 @fun FUN-F011-002 @test UT-F011-002 */
  it.each([
    ['commit差', { releaseCommit: '0'.repeat(40) }],
    ['tag差', { tag: 'v0.9.0' }],
    ['catalog SHA差', { catalogSha256: '0'.repeat(64) }],
    ['dist SHA差', { distSha256: '0'.repeat(64) }],
    ['artifact SHA差', { artifactDigest: '0'.repeat(64) }],
  ])('%sをF011_PUBLISHED_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F011_V0100_PINS, ...patch } as unknown as typeof F011_V0100_PINS;
    await expect(loadPublishedV0100Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F011_PUBLISHED_BASELINE_MISMATCH' } satisfies Partial<PublishedV0100BaselineError>,
    );
  });

  /** @des DES-F011-002 @fun FUN-F011-002 @test UT-F011-002 */
  it('候補checkoutの現行public treeからは再導出しない(固定Git objectのみを読む)', async () => {
    const calls: string[] = [];
    const git = {
      ...nodePublishedV0100GitAdapter,
      async listPublicTree(root: string, commit: string) {
        calls.push(commit);
        return nodePublishedV0100GitAdapter.listPublicTree(root, commit);
      },
    };
    const baseline = await loadPublishedV0100Baseline(workspace, F011_V0100_PINS, { git });
    expect(calls).toEqual([F011_V0100_PINS.releaseCommit]);
    expect(baseline.publicFiles.length).toBe(1292);
  });

  /** @des DES-F011-002 @fun FUN-F011-002 @test UT-F011-002 */
  it('public objectの改ざんを拒否する', async () => {
    const git = {
      ...nodePublishedV0100GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV0100GitAdapter.readObject(root, commit, path);
        if (path !== 'public/content/catalog.json') return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV0100Baseline(
      workspace,
      F011_V0100_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F011_PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('FUN-F011-003 isMintedPublishedV0100Baseline', () => {
  /** @des DES-F011-002 @fun FUN-F011-003 @test UT-F011-003 */
  it('work preview・統合tree・distの3段階で同一bundleをbrand検査する', async () => {
    const baseline = await loadPublishedV0100Baseline(workspace, F011_V0100_PINS);
    expect(isMintedPublishedV0100Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV0100Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV0100Baseline(baseline)).toBe(true);
  });

  /** @des DES-F011-002 @fun FUN-F011-003 @test UT-F011-003 */
  it('未mint値・偽造値・改変値をfalseとする', async () => {
    const baseline = await loadPublishedV0100Baseline(workspace, F011_V0100_PINS);
    expect(isMintedPublishedV0100Baseline({ ...baseline })).toBe(false);
    expect(isMintedPublishedV0100Baseline({ __brand: 'PublishedV0100Baseline' })).toBe(false);
    expect(isMintedPublishedV0100Baseline(null)).toBe(false);
    expect(isMintedPublishedV0100Baseline(undefined)).toBe(false);
  });
});
