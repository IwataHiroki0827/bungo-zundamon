import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest } from '../src/content/batch.ts';

/**
 * F008 v0.8.0公開commitがrecordPublishedBatch相当のstatus更新を伴わなかった
 * 既知事象（F004→F005・F005→F006・F006→F007で確認済みの同型パターン、
 * commit 801352eがF006を・commit 11d3294がF007を是正した先例に倣う）を是正する。
 * F009（T-184、瓶詰地獄content-preview実行時、loadAcceptedBatchesが
 * manifest.status==='published'を要求するためF008がcatalogから欠落し
 * verifyF009ArtworkAgainstCatalogの「既存7作者以上」チェックで発覚）で発見した。
 * 実evidence（docs/evidence/release/F008-{deployment,smoke}.json、実際の
 * GitHub Actions run 32647228172の実データ）を根拠にdeploymentEvidenceRef/
 * publishedAt/releaseVersion/smokeEvidenceRef/statusをcanonical JSONとして
 * 追記・更新する。f007-mark-published.tsのF008向け複製。
 */

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = resolve(workspace, 'content', 'batches', 'F008', 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F008 manifestがcanonicalではありません');
  }
  if (checked.value.status !== 'accepted') {
    throw new Error(`F008 manifestは既にstatus=${checked.value.status}です`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const updated = {
    ...checked.value,
    deploymentEvidenceRef: 'docs/evidence/release/F008-deployment.json',
    publishedAt: '2026-08-23T15:26:47Z',
    releaseVersion: '0.8.0',
    smokeEvidenceRef: 'docs/evidence/release/F008-smoke.json',
    status: 'published' as const,
  };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error('書込み後のF008 manifestがcanonicalではありません');
  }
  process.stdout.write(
    `F008 batch.json: status=${recheck.value.status}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
