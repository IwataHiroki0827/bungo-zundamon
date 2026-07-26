import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Sha256 } from './batch.ts';
import {
  F002_PUBLISHED_RELEASE,
  loadAndVerifyPublishedBaseline,
  verifyPublishedInvariant,
  type PublishedBaselineBundle,
} from './published-baseline.ts';

const workspace = process.cwd();
const temporary: string[] = [];
let baseline: PublishedBaselineBundle;

async function treeDigest(root: string): Promise<Sha256> {
  const { lstat, readdir } = await import('node:fs/promises');
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (directory: string, logical: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      const target = join(directory, entry.name);
      const info = await lstat(target);
      if (info.isDirectory()) await walk(target, path);
      else files.push({ path, bytes: new Uint8Array(await readFile(target)) });
    }
  };
  await walk(root, '');
  const digest = createHash('sha256');
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  }
  return digest.digest('hex') as Sha256;
}

beforeAll(async () => {
  baseline = await loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE);
}, 30_000);

afterAll(async () => {
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })));
});

describe('UT-F003-004 FUN-F003-004 pinned F002 published baseline', () => {
  it('固定commitのGit objectだけから2作者・6作品・213台詞と全226 file/referenceを復元する', () => {
    expect(baseline.release).toEqual(F002_PUBLISHED_RELEASE);
    expect(baseline.catalog.authors).toHaveLength(2);
    expect(baseline.catalog.works).toHaveLength(6);
    expect(baseline.catalog.works.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(213);
    expect(baseline.files).toHaveLength(226);
    expect(baseline.catalog.works.some((work) => work.batchId === 'F003')).toBe(false);
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  it('pin差、descriptor再hash改変、Git treeへのF003混入を同じ理由codeで拒否する', async () => {
    await expect(loadAndVerifyPublishedBaseline(workspace, {
      ...F002_PUBLISHED_RELEASE,
      distSha256: '0'.repeat(64),
    } as typeof F002_PUBLISHED_RELEASE)).rejects.toMatchObject({ code: 'PUBLISHED_BASELINE_MISMATCH' });

    const root = await mkdtemp(join(tmpdir(), 'f002-baseline-descriptor-'));
    temporary.push(root);
    const source = join(workspace, 'content', 'baselines', 'F002-v0.2.0.json');
    const changed = JSON.parse(await readFile(source, 'utf8')) as { counts: { dialogues: number }; descriptorSha256: string };
    changed.counts.dialogues += 1;
    changed.descriptorSha256 = createHash('sha256').update(JSON.stringify(changed)).digest('hex');
    const path = join(root, 'changed.json');
    await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`);
    await expect(loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE, { descriptorPath: path }))
      .rejects.toMatchObject({ code: 'PUBLISHED_BASELINE_MISMATCH' });

    await expect(loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE, {
      git: {
        resolveCommit: async () => F002_PUBLISHED_RELEASE.commit,
        listPublicTree: async (_root, commit) => [
          ...await (await import('./published-baseline.ts')).nodePublishedGitObjectAdapter.listPublicTree(workspace, commit),
          { mode: '100644', oid: '0'.repeat(40), path: 'audio/F003/mixed.wav' },
        ],
        readBlob: async (_root, oid) => (await import('./published-baseline.ts')).nodePublishedGitObjectAdapter.readBlob(workspace, oid),
      },
    })).rejects.toMatchObject({ code: 'PUBLISHED_BASELINE_MISMATCH' });
  });
});

describe('UT-F003-005 FUN-F003-005 published invariant', () => {
  it('work previewの完全同値をpassにし、入力SHA差・既存1byte差をblockedにする', async () => {
    const source = join(workspace, 'public');
    const exact = await verifyPublishedInvariant(baseline, {
      target: 'work-preview',
      root: source,
      treeSha256: await treeDigest(source),
    });
    expect(exact).toMatchObject({ result: 'pass', mismatches: [] });

    const wrongTree = await verifyPublishedInvariant(baseline, {
      target: 'integrated-tree',
      root: source,
      treeSha256: '0'.repeat(64) as Sha256,
    });
    expect(wrongTree).toMatchObject({
      result: 'blocked',
      reasonCode: 'PUBLISHED_BASELINE_MISMATCH',
      mismatches: ['INPUT_TREE_SHA_MISMATCH'],
    });

    const root = await mkdtemp(join(tmpdir(), 'f002-invariant-'));
    temporary.push(root);
    await cp(source, root, { recursive: true });
    const file = baseline.files.find((entry) => entry.path.startsWith('audio/F001/'))!;
    await writeFile(join(root, ...file.path.split('/')), '1byte差');
    const changed = await verifyPublishedInvariant(baseline, {
      target: 'dist',
      root,
      treeSha256: await treeDigest(root),
    });
    expect(changed.result).toBe('blocked');
    expect(changed.mismatches).toContain(`FILE_MISMATCH:${file.path}`);
  });

  it('画像provenance集約はF003追記を許可し、既存作者entryの変更を拒否する', async () => {
    const source = join(workspace, 'public');
    const root = await mkdtemp(join(tmpdir(), 'f002-artwork-projection-'));
    temporary.push(root);
    await cp(source, root, { recursive: true });
    const path = join(root, 'content', 'artwork-provenances.json');
    const bundle = JSON.parse(await readFile(path, 'utf8')) as {
      artworks: Array<Record<string, unknown>>;
      schemaVersion: '1.0.0';
    };
    bundle.artworks.push({
      authorId: '000035',
      batchId: 'F003',
      manifestId: 'artwork-F003-000035-v1',
      provenanceRef: 'content/artwork-provenance/F003.json',
      provenanceSha256: 'a'.repeat(64),
      output: { path: 'artwork/dazai-zundamon.png', sha256: 'b'.repeat(64) },
    });
    await writeFile(path, JSON.stringify(bundle));
    const appended = await verifyPublishedInvariant(baseline, {
      target: 'work-preview',
      root,
      treeSha256: await treeDigest(root),
    });
    expect(appended).toMatchObject({ result: 'pass', mismatches: [] });

    bundle.artworks[0] = { ...bundle.artworks[0], provenanceSha256: 'c'.repeat(64) };
    await writeFile(path, JSON.stringify(bundle));
    const changed = await verifyPublishedInvariant(baseline, {
      target: 'work-preview',
      root,
      treeSha256: await treeDigest(root),
    });
    expect(changed).toMatchObject({
      result: 'blocked',
      mismatches: ['ARTWORK_PROVENANCE_PROJECTION_MISMATCH'],
    });
  });
});
