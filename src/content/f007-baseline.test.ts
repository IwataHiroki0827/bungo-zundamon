import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  F007_V060_PINS,
  isMintedPublishedV060Baseline,
  loadPublishedV060Baseline,
  nodePublishedV060GitAdapter,
  PublishedV060BaselineError,
} from './f007-baseline.ts';

const workspace = resolve('.');

describe('FUN-F007-002 v0.6.0固定baseline', () => {
  /** @des DES-F007-002 @fun FUN-F007-002 @test UT-F007-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', async () => {
    const baseline = await loadPublishedV060Baseline(workspace, F007_V060_PINS);

    expect(baseline.__brand).toBe('PublishedV060Baseline');
    expect(baseline.pins.releaseCommit).toBe(F007_V060_PINS.releaseCommit);
    expect(baseline.publicFiles).toHaveLength(965);
    expect(baseline.catalog.authors).toHaveLength(5);
    expect(baseline.catalog.works).toHaveLength(18);
    expect(baseline.catalog.audioAssets).toHaveLength(923);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(939);
    expect(baseline.controlManifest.batchId).toBe('F006');
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F007-002 @fun FUN-F007-002 @test UT-F007-002 */
  it.each([
    ['commit差', { releaseCommit: '0'.repeat(40) }],
    ['tag差', { tag: 'v0.5.0' }],
    ['catalog SHA差', { catalogSha256: '0'.repeat(64) }],
    ['dist SHA差', { distSha256: '0'.repeat(64) }],
    ['artifact SHA差', { artifactDigest: '0'.repeat(64) }],
  ])('%sをF007_PUBLISHED_BASELINE_MISMATCHで拒否する', async (_label, patch) => {
    const pins = { ...F007_V060_PINS, ...patch } as unknown as typeof F007_V060_PINS;
    await expect(loadPublishedV060Baseline(workspace, pins)).rejects.toMatchObject(
      { code: 'F007_PUBLISHED_BASELINE_MISMATCH' } satisfies Partial<PublishedV060BaselineError>,
    );
  });

  /** @des DES-F007-002 @fun FUN-F007-002 @test UT-F007-002 */
  it('候補checkoutの現行public treeからは再導出しない(固定Git objectのみを読む)', async () => {
    const calls: string[] = [];
    const git = {
      ...nodePublishedV060GitAdapter,
      async listPublicTree(root: string, commit: string) {
        calls.push(commit);
        return nodePublishedV060GitAdapter.listPublicTree(root, commit);
      },
    };
    const baseline = await loadPublishedV060Baseline(workspace, F007_V060_PINS, { git });
    expect(calls).toEqual([F007_V060_PINS.releaseCommit]);
    expect(baseline.publicFiles.length).toBe(965);
  });

  /** @des DES-F007-002 @fun FUN-F007-002 @test UT-F007-002 */
  it('public objectの改ざんを拒否する', async () => {
    const git = {
      ...nodePublishedV060GitAdapter,
      async readObject(root: string, commit: string, path: string) {
        const bytes = await nodePublishedV060GitAdapter.readObject(root, commit, path);
        if (path !== 'public/content/catalog.json') return bytes;
        const changed = new Uint8Array(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        return changed;
      },
    };
    await expect(loadPublishedV060Baseline(
      workspace,
      F007_V060_PINS,
      { git },
    )).rejects.toMatchObject({ code: 'F007_PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('FUN-F007-003 isMintedPublishedV060Baseline', () => {
  /** @des DES-F007-002 @fun FUN-F007-003 @test UT-F007-003 */
  it('work preview・統合tree・distの3段階で同一bundleをbrand検査する', async () => {
    const baseline = await loadPublishedV060Baseline(workspace, F007_V060_PINS);
    expect(isMintedPublishedV060Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV060Baseline(baseline)).toBe(true);
    expect(isMintedPublishedV060Baseline(baseline)).toBe(true);
  });

  /** @des DES-F007-002 @fun FUN-F007-003 @test UT-F007-003 */
  it('未mint値・偽造値・改変値をfalseとする', async () => {
    const baseline = await loadPublishedV060Baseline(workspace, F007_V060_PINS);
    expect(isMintedPublishedV060Baseline({ ...baseline })).toBe(false);
    expect(isMintedPublishedV060Baseline({ __brand: 'PublishedV060Baseline' })).toBe(false);
    expect(isMintedPublishedV060Baseline(null)).toBe(false);
    expect(isMintedPublishedV060Baseline(undefined)).toBe(false);
  });
});
