import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { loadAndVerifyF001Baseline, verifyF001DistInvariant, verifyF001Invariant, type F001Baseline, type F001BaselineDocument } from './baseline.ts';
import type { IntegratedFile } from './batch-public.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';
import type { CatalogV2 } from './processing.ts';
import type { PagesDistPreview } from './pages-preview.ts';

const hash = (value: Uint8Array | string): Sha256 => createHash('sha256').update(value).digest('hex') as Sha256;

function rehashBaseline(document: F001BaselineDocument): string {
  const payload = { ...document } as unknown as Record<string, unknown>;
  delete payload.baselineSha256;
  return canonicalJson({ ...payload, baselineSha256: hash(canonicalJson(payload)) });
}

async function digest(root: string): Promise<Sha256> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (dir: string, logical: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else files.push({ path, bytes: new Uint8Array(await readFile(join(dir, entry.name))) });
    }
  };
  await walk(root, '');
  const value = createHash('sha256');
  for (const file of files) value.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  return value.digest('hex') as Sha256;
}

async function metadata(root: string): Promise<IntegratedFile[]> {
  const files: IntegratedFile[] = [];
  const walk = async (dir: string, logical: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else {
        const bytes = new Uint8Array(await readFile(join(dir, entry.name)));
        files.push({ path: path as WorkspaceRelativePath, sha256: hash(bytes), bytes: bytes.byteLength });
      }
    }
  };
  await walk(root, '');
  return files;
}

async function fixture(): Promise<{ root: string; catalog: CatalogV2; baseline: F001Baseline }> {
  const root = await mkdtemp(join(tmpdir(), 'f001-invariant-'));
  const author = {
    authorId: '000879', name: 'あくたがわずんのすけ', originalName: '芥川龍之介', slug: 'akutagawa-zunnosuke',
    artwork: { path: 'artwork/akutagawa.png', alt: '芥川', sha256: hash('art') }, introducedByBatchId: 'F001', identitySha256: hash('identity'),
  };
  const audioAssets: CatalogV2['audioAssets'] = [];
  const works: CatalogV2['works'] = ['000127', '000092', '043015'].map((workId, workIndex) => ({
    workId, authorId: author.authorId, batchId: 'F001', title: `作品${workIndex + 1}`,
    cardLink: `https://www.aozora.gr.jp/cards/000879/card${Number(workId)}.html`,
    source: {
      cardUrl: `https://www.aozora.gr.jp/cards/000879/card${Number(workId)}.html`, textUrl: `https://www.aozora.gr.jp/cards/000879/files/${Number(workId)}_1.html`,
      attribution: '青空文庫', baseEdition: '底本', inputter: '入力', proofreader: '校正', fetchedAt: '2026-07-01T00:00:00.000Z',
      transformation: '変換', sourceSha256: hash(`source-${workId}`), provenancePath: `content/provenance/F001/${workId}.json`, provenanceSha256: hash(`prov-${workId}`),
    },
    dialogues: Array.from({ length: workIndex === 2 ? 19 : 20 }, (_, dialogueIndex) => {
      const audioId = hash(`${workId}-${dialogueIndex}`);
      audioAssets.push({ audioId, batchId: 'F001', path: `audio/F001/${audioId}.wav`, sha256: hash(`wav-${audioId}`), bytes: Buffer.byteLength(`wav-${audioId}`), durationMs: 1000, configHash: hash('config') });
      return {
        dialogueId: `d-${workId}-${dialogueIndex}`, workId, order: dialogueIndex, displayText: `表示${workId}-${dialogueIndex}`,
        speechText: `発話${workId}-${dialogueIndex}`, audioId, sourceAnchor: { bodySelector: '.main_text', startToken: dialogueIndex, endToken: dialogueIndex + 1 },
        review: { candidateId: `d-${workId}-${dialogueIndex}`, revision: 1, status: 'approved' as const, reasonCode: 'SPOKEN_DIALOGUE', reviewer: 'r', reviewedAt: '2026-07-01T00:00:00.000Z', policyCheckedAt: '2026-07-01T00:00:00.000Z' },
      };
    }),
  }));
  const catalog: CatalogV2 = {
    schemaVersion: '2.0.0', authors: [author], works, audioAssets,
    batches: [{ batchId: 'F001', feature: 'F001', status: 'published', authorId: author.authorId, workIds: works.map((work) => work.workId), acceptedAt: '2026-07-01T00:00:00.000Z', publishedAt: '2026-07-01T01:00:00.000Z', evidenceSha256: hash('evidence') }],
    candidateCounts: { total: 59, published: 59, editorialExcluded: 0, audioExcluded: 0, byBatch: { F001: { total: 59, published: 59, editorialExcluded: 0, audioExcluded: 0 } } },
    creditsRef: 'content/licenses.json',
  };
  const values = new Map<string, Uint8Array>([
    ['artwork/akutagawa.png', new TextEncoder().encode('art')],
    ['content/licenses.json', new TextEncoder().encode('licenses')],
    ...works.map((work) => [work.source.provenancePath, new TextEncoder().encode(`prov-${work.workId}`)] as const),
    ...audioAssets.map((asset) => [asset.path, new TextEncoder().encode(`wav-${asset.audioId}`)] as const),
  ]);
  const files: IntegratedFile[] = [];
  for (const [path, bytes] of values) {
    await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...path.split('/')), bytes);
    files.push({ path: path as WorkspaceRelativePath, sha256: hash(bytes), bytes: bytes.byteLength });
  }
  await mkdir(join(root, 'content'), { recursive: true });
  await writeFile(join(root, 'content', 'catalog.json'), JSON.stringify(catalog));
  await writeFile(join(root, '.nojekyll'), '');
  return { root, catalog, baseline: { baselineSha256: hash('baseline'), catalog: { authors: [author], works, audioAssets }, files } };
}

describe('FUN-F002-038/040 F001 invariants', () => {
  it('F002追加を比較外とし、F001 3作品59台詞と全実体を固定する', async () => {
    const value = await fixture();
    const extended = { ...value.catalog, authors: [...value.catalog.authors, { ...value.catalog.authors[0]!, authorId: '000081', introducedByBatchId: 'F002' }] };
    const report = await verifyF001Invariant(extended, value.root, value.baseline);
    expect(report).toMatchObject({ result: 'pass', buildSha256: await digest(value.root), baselineSha256: value.baseline.baselineSha256 });

    const mutated = structuredClone(value.catalog);
    mutated.works[0]!.dialogues[0]!.displayText = '改変';
    await expect(verifyF001Invariant(mutated, value.root, value.baseline)).rejects.toMatchObject({ code: 'F001_POSTBUILD_ITEM_MUTATED' });
    await writeFile(join(value.root, 'artwork', 'akutagawa.png'), 'changed');
    await expect(verifyF001Invariant(value.catalog, value.root, value.baseline)).rejects.toMatchObject({ code: 'F001_POSTBUILD_ASSET_HASH_MISMATCH' });
  });

  it('完全dist digestとcontent reportを同じbuildへ結合する', async () => {
    const value = await fixture();
    const content = await verifyF001Invariant(value.catalog, value.root, value.baseline);
    const dist = await mkdtemp(join(tmpdir(), 'f001-dist-'));
    await cp(value.root, dist, { recursive: true });
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<html></html>');
    await writeFile(join(dist, 'assets', 'app.js'), 'js');
    await writeFile(join(dist, 'assets', 'app.css'), 'css');
    const preview = { distSha256: await digest(dist), contentBuildSha256: content.buildSha256, outputRoot: dist, files: await metadata(dist), inputHashes: {} } as unknown as PagesDistPreview;
    await expect(verifyF001DistInvariant(preview, value.baseline, content)).resolves.toMatchObject({ result: 'pass', distSha256: preview.distSha256 });
    await writeFile(join(dist, 'audio', 'F001', `${value.catalog.audioAssets[0]!.audioId}.wav`), 'tamper');
    await expect(verifyF001DistInvariant(preview, value.baseline, content)).rejects.toMatchObject({ code: 'F001_DIST_DIGEST_MISMATCH' });
  });
});

describe('FUN-F002-005 loadAndVerifyF001Baseline', () => {
  const baselinePath = join(process.cwd(), 'content', 'baselines', 'F001-v0.1.0.json');
  const rawCatalogSnapshot = join(process.cwd(), 'content', 'baselines', 'F001-v0.1.0-catalog.json');
  const publicRoot = join(process.cwd(), 'public');

  it('統合後CatalogV2のpublicでも固定raw snapshotとF001 allowlist実体からbundleを返す', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'f001-integrated-public-'));
    const integratedPublic = join(workspace, 'public');
    await cp(publicRoot, integratedPublic, { recursive: true });
    await writeFile(join(integratedPublic, 'content', 'catalog.json'), canonicalJson({ schemaVersion: '2.0.0' }));
    const bundle = await loadAndVerifyF001Baseline(integratedPublic, baselinePath, rawCatalogSnapshot);
    expect(bundle.syntheticBatch).toMatchObject({ batchId: 'F001', feature: 'F001', status: 'published' });
    expect(bundle.catalog.works).toHaveLength(3);
    expect(bundle.catalog.works?.reduce((sum, work) => sum + work.dialogues.length, 0)).toBe(59);
    expect(bundle.files.filter((file) => file.path.startsWith('audio/F001/'))).toHaveLength(57);
    expect(bundle.sourceRoot).toBe(integratedPublic);
  });

  it('非canonical/identity改変baselineとsource asset欠損・改変を個別codeで拒否する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'f001-loader-'));
    const copiedPublic = join(workspace, 'public');
    await cp(publicRoot, copiedPublic, { recursive: true });
    const raw = await readFile(baselinePath, 'utf8');
    const noncanonical = join(workspace, 'pretty.json');
    await writeFile(noncanonical, JSON.stringify(JSON.parse(raw)));
    await expect(loadAndVerifyF001Baseline(copiedPublic, noncanonical, rawCatalogSnapshot)).rejects.toMatchObject({ code: 'F001_BASELINE_IDENTITY_INVALID' });

    const changed = JSON.parse(raw) as F001BaselineDocument;
    const identityPayload = { ...changed, release: 'v9.9.9' as 'v0.1.0' };
    const payload = { ...identityPayload } as unknown as Record<string, unknown>;
    delete payload.baselineSha256;
    const changedIdentity = { ...payload, baselineSha256: hash(canonicalJson(payload)) };
    const changedPath = join(workspace, 'changed.json');
    await writeFile(changedPath, canonicalJson(changedIdentity));
    await expect(loadAndVerifyF001Baseline(copiedPublic, changedPath, rawCatalogSnapshot)).rejects.toMatchObject({ code: 'F001_BASELINE_IDENTITY_INVALID' });

    const audio = changed.files.find((file) => file.path.startsWith('audio/F001/'))!;
    await writeFile(join(copiedPublic, ...audio.path.split('/')), 'tamper');
    await expect(loadAndVerifyF001Baseline(copiedPublic, baselinePath, rawCatalogSnapshot)).rejects.toMatchObject({ code: 'F001_ASSET_HASH_MISMATCH' });
    await cp(publicRoot, copiedPublic, { recursive: true, force: true });
    await rm(join(copiedPublic, 'content', 'provenance.json'));
    await expect(loadAndVerifyF001Baseline(copiedPublic, baselinePath, rawCatalogSnapshot)).rejects.toMatchObject({ code: 'F001_PROVENANCE_MISSING' });
  });

  it('payload改変後に自己申告SHAを再計算しても外部固定SHAで拒否する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'f001-rehash-'));
    const document = JSON.parse(await readFile(baselinePath, 'utf8')) as F001BaselineDocument;
    document.catalog.works[0]!.dialogues[0]!.displayText = '再ハッシュ済み改変';
    const mutatedPath = join(workspace, 'rehashed-mutation.json');
    await writeFile(mutatedPath, rehashBaseline(document));
    await expect(loadAndVerifyF001Baseline(publicRoot, mutatedPath, rawCatalogSnapshot)).rejects.toMatchObject({ code: 'F001_BASELINE_IDENTITY_INVALID' });
  });

  it('固定raw Catalog v1のSHA不一致を拒否する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'f001-raw-catalog-'));
    const rawCatalogPath = join(workspace, 'F001-v0.1.0-catalog.json');
    await cp(rawCatalogSnapshot, rawCatalogPath);
    const rawCatalog = JSON.parse(await readFile(rawCatalogPath, 'utf8')) as { works: Array<{ dialogues: Array<{ displayText: string }> }> };
    rawCatalog.works[0]!.dialogues[0]!.displayText = 'raw catalog改変';
    await writeFile(rawCatalogPath, canonicalJson(rawCatalog));
    await expect(loadAndVerifyF001Baseline(publicRoot, baselinePath, rawCatalogPath)).rejects.toMatchObject({ code: 'F001_ITEM_MUTATED' });
  });

  it('baseline JSON内の期待SHA差し替えを許可しない', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'f001-sha-replace-'));
    const document = JSON.parse(await readFile(baselinePath, 'utf8')) as F001BaselineDocument;
    const replaced = { ...document, baselineSha256: '0'.repeat(64) as Sha256 };
    const replacedPath = join(workspace, 'replaced-expected-sha.json');
    await writeFile(replacedPath, canonicalJson(replaced));
    await expect(loadAndVerifyF001Baseline(publicRoot, replacedPath, rawCatalogSnapshot)).rejects.toMatchObject({ code: 'F001_BASELINE_IDENTITY_INVALID' });
  });
});
