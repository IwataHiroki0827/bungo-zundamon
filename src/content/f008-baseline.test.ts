import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F008_V070_PINS,
  isMintedPublishedV070Baseline,
  loadPublishedV070Baseline,
  nodePublishedV070GitAdapter,
  PublishedV070BaselineError,
} from './f008-baseline.ts';

const workspace = resolve('.');

describe('FUN-F008-002 v0.7.0固定baseline', () => {
  /** @des DES-F008-002 @fun FUN-F008-002 @test UT-F008-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV070Baseline(workspace, F008_V070_PINS);

    expect(baseline.__brand).toBe('PublishedV070Baseline');
    expect(baseline.pins.releaseCommit).toBe(F008_V070_PINS.releaseCommit);
    expect(baseline.publicFiles).toHaveLength(1129);
    expect(baseline.catalog.authors).toHaveLength(6);
    expect(baseline.catalog.works).toHaveLength(21);
    expect(baseline.catalog.audioAssets).toHaveLength(1082);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(1099);
    expect(baseline.controlManifest.batchId).toBe('F007');
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F008-002 @fun FUN-F008-002 @test UT-F008-002 */
  it.each([
    ['commit差', { releaseCommit: '0'.repeat(40) }],
    ['tag差', { tag: 'v0.6.0' }],
    ['catalog SHA差', { catalogSha256: '0'.repeat(64) }],
    ['dist SHA差', { distSha256: '0'.repeat(64) }],
    ['artifact SHA差', { artifactDigest: '0'.repeat(64) }],
  ])('%sをF008_PUBLISHED_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F008_V070_PINS, ...patch } as unknown as typeof F008_V070_PINS;
    await expect(loadPublishedV070Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F008_PUBLISHED_BASELINE_MISMATCH' } satisfies Partial<PublishedV070BaselineError>,
    );
  });

  /** @des DES-F008-002 @fun FUN-F008-002 @test UT-F008-002 */
  it('候補checkoutの現行public treeからは再導出しない(固定Git objectのみを読む)', async () => {
    const calls: string[] = [];
    const git = {
      ...nodePublishedV070GitAdapter,
      async listPublicTree(root: string, commit: string) {
        calls.push(commit);
        return nodePublishedV070GitAdapter.listPublicTree(root, commit);
      },
    };
    const baseline = await loadPublishedV070Baseline(workspace, F008_V070_PINS, { git });
    expect(calls).toEqual([F008_V070_PINS.releaseCommit]);
    expect(baseline.publicFiles.length).toBe(1129);
  });

  /** @des DES-F008-002 @fun FUN-F008-002 @test UT-F008-002 */
  it('public objectの改ざんを拒否する', async () => {
    const git = {
      ...nodePublishedV070GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV070GitAdapter.readObject(root, commit, path);
        if (path !== 'public/content/catalog.json') return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV070Baseline(
      workspace,
      F008_V070_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F008_PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('FUN-F008-003 isMintedPublishedV070Baseline', () => {
  /** @des DES-F008-002 @fun FUN-F008-003 @test UT-F008-003 */
  it('work preview・統合tree・distの3段階で同一bundleをbrand検査する', async () => {
    const baseline = await loadPublishedV070Baseline(workspace, F008_V070_PINS);
    expect(isMintedPublishedV070Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV070Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV070Baseline(baseline)).toBe(true);
  });

  /** @des DES-F008-002 @fun FUN-F008-003 @test UT-F008-003 */
  it('未mint値・偽造値・改変値をfalseとする', async () => {
    const baseline = await loadPublishedV070Baseline(workspace, F008_V070_PINS);
    expect(isMintedPublishedV070Baseline({ ...baseline })).toBe(false);
    expect(isMintedPublishedV070Baseline({ __brand: 'PublishedV070Baseline' })).toBe(false);
    expect(isMintedPublishedV070Baseline(null)).toBe(false);
    expect(isMintedPublishedV070Baseline(undefined)).toBe(false);
  });
});
