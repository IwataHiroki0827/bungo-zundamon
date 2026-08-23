import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F010_V090_PINS,
  isMintedPublishedV090Baseline,
  loadPublishedV090Baseline,
  nodePublishedV090GitAdapter,
  PublishedV090BaselineError,
} from './f010-baseline.ts';

const workspace = resolve('.');

describe('FUN-F010-002 v0.9.0固定baseline', () => {
  /** @des DES-F010-002 @fun FUN-F010-002 @test UT-F010-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV090Baseline(workspace, F010_V090_PINS);

    expect(baseline.__brand).toBe('PublishedV090Baseline');
    expect(baseline.pins.releaseCommit).toBe(F010_V090_PINS.releaseCommit);
    expect(baseline.publicFiles).toHaveLength(1266);
    expect(baseline.catalog.authors).toHaveLength(8);
    expect(baseline.catalog.works).toHaveLength(27);
    expect(baseline.catalog.audioAssets).toHaveLength(1209);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(1226);
    expect(baseline.controlManifest.batchId).toBe('F009');
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F010-002 @fun FUN-F010-002 @test UT-F010-002 */
  it.each([
    ['commit差', { releaseCommit: '0'.repeat(40) }],
    ['tag差', { tag: 'v0.8.0' }],
    ['catalog SHA差', { catalogSha256: '0'.repeat(64) }],
    ['dist SHA差', { distSha256: '0'.repeat(64) }],
    ['artifact SHA差', { artifactDigest: '0'.repeat(64) }],
  ])('%sをF010_PUBLISHED_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F010_V090_PINS, ...patch } as unknown as typeof F010_V090_PINS;
    await expect(loadPublishedV090Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F010_PUBLISHED_BASELINE_MISMATCH' } satisfies Partial<PublishedV090BaselineError>,
    );
  });

  /** @des DES-F010-002 @fun FUN-F010-002 @test UT-F010-002 */
  it('候補checkoutの現行public treeからは再導出しない(固定Git objectのみを読む)', async () => {
    const calls: string[] = [];
    const git = {
      ...nodePublishedV090GitAdapter,
      async listPublicTree(root: string, commit: string) {
        calls.push(commit);
        return nodePublishedV090GitAdapter.listPublicTree(root, commit);
      },
    };
    const baseline = await loadPublishedV090Baseline(workspace, F010_V090_PINS, { git });
    expect(calls).toEqual([F010_V090_PINS.releaseCommit]);
    expect(baseline.publicFiles.length).toBe(1266);
  });

  /** @des DES-F010-002 @fun FUN-F010-002 @test UT-F010-002 */
  it('public objectの改ざんを拒否する', async () => {
    const git = {
      ...nodePublishedV090GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV090GitAdapter.readObject(root, commit, path);
        if (path !== 'public/content/catalog.json') return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV090Baseline(
      workspace,
      F010_V090_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F010_PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('FUN-F010-003 isMintedPublishedV090Baseline', () => {
  /** @des DES-F010-002 @fun FUN-F010-003 @test UT-F010-003 */
  it('work preview・統合tree・distの3段階で同一bundleをbrand検査する', async () => {
    const baseline = await loadPublishedV090Baseline(workspace, F010_V090_PINS);
    expect(isMintedPublishedV090Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV090Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV090Baseline(baseline)).toBe(true);
  });

  /** @des DES-F010-002 @fun FUN-F010-003 @test UT-F010-003 */
  it('未mint値・偽造値・改変値をfalseとする', async () => {
    const baseline = await loadPublishedV090Baseline(workspace, F010_V090_PINS);
    expect(isMintedPublishedV090Baseline({ ...baseline })).toBe(false);
    expect(isMintedPublishedV090Baseline({ __brand: 'PublishedV090Baseline' })).toBe(false);
    expect(isMintedPublishedV090Baseline(null)).toBe(false);
    expect(isMintedPublishedV090Baseline(undefined)).toBe(false);
  });
});
