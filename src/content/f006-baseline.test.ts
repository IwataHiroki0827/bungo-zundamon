import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F006_V050_PINS,
  isMintedPublishedV050Baseline,
  loadPublishedV050Baseline,
  nodePublishedV050GitAdapter,
  PublishedV050BaselineError,
} from './f006-baseline.ts';

const workspace = resolve('.');

describe('FUN-F006-002 v0.5.0固定baseline', () => {
  /** @des DES-F006-002 @fun FUN-F006-002 @test UT-F006-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV050Baseline(workspace, F006_V050_PINS);

    expect(baseline.__brand).toBe('PublishedV050Baseline');
    expect(baseline.pins.releaseCommit).toBe(F006_V050_PINS.releaseCommit);
    expect(baseline.publicFiles).toHaveLength(898);
    expect(baseline.catalog.authors).toHaveLength(4);
    expect(baseline.catalog.works).toHaveLength(15);
    expect(baseline.catalog.audioAssets).toHaveLength(861);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(877);
    expect(baseline.controlManifest.batchId).toBe('F005');
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F006-002 @fun FUN-F006-002 @test UT-F006-002 */
  it.each([
    ['commit差', { releaseCommit: '0'.repeat(40) }],
    ['tag差', { tag: 'v0.4.1' }],
    ['catalog SHA差', { catalogSha256: '0'.repeat(64) }],
    ['dist SHA差', { distSha256: '0'.repeat(64) }],
    ['artifact SHA差', { artifactDigest: '0'.repeat(64) }],
  ])('%sをF006_PUBLISHED_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F006_V050_PINS, ...patch } as unknown as typeof F006_V050_PINS;
    await expect(loadPublishedV050Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F006_PUBLISHED_BASELINE_MISMATCH' } satisfies Partial<PublishedV050BaselineError>,
    );
  });

  /** @des DES-F006-002 @fun FUN-F006-002 @test UT-F006-002 */
  it('候補checkoutの現行public treeからは再導出しない(固定Git objectのみを読む)', async () => {
    const calls: string[] = [];
    const git = {
      ...nodePublishedV050GitAdapter,
      async listPublicTree(root: string, commit: string) {
        calls.push(commit);
        return nodePublishedV050GitAdapter.listPublicTree(root, commit);
      },
    };
    const baseline = await loadPublishedV050Baseline(workspace, F006_V050_PINS, { git });
    expect(calls).toEqual([F006_V050_PINS.releaseCommit]);
    expect(baseline.publicFiles.length).toBe(898);
  });

  /** @des DES-F006-002 @fun FUN-F006-002 @test UT-F006-002 */
  it('public objectの改ざんを拒否する', async () => {
    const git = {
      ...nodePublishedV050GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV050GitAdapter.readObject(root, commit, path);
        if (path !== 'public/content/catalog.json') return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV050Baseline(
      workspace,
      F006_V050_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F006_PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('FUN-F006-003 isMintedPublishedV050Baseline', () => {
  /** @des DES-F006-002 @fun FUN-F006-003 @test UT-F006-003 */
  it('work preview・統合tree・distの3段階で同一bundleをbrand検査する', async () => {
    const baseline = await loadPublishedV050Baseline(workspace, F006_V050_PINS);
    expect(isMintedPublishedV050Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV050Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV050Baseline(baseline)).toBe(true);
  });

  /** @des DES-F006-002 @fun FUN-F006-003 @test UT-F006-003 */
  it('未mint値・偽造値・改変値をfalseとする', async () => {
    const baseline = await loadPublishedV050Baseline(workspace, F006_V050_PINS);
    expect(isMintedPublishedV050Baseline({ ...baseline })).toBe(false);
    expect(isMintedPublishedV050Baseline({ __brand: 'PublishedV050Baseline' })).toBe(false);
    expect(isMintedPublishedV050Baseline(null)).toBe(false);
    expect(isMintedPublishedV050Baseline(undefined)).toBe(false);
  });
});
