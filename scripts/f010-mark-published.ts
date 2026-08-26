import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest } from '../src/content/batch.ts';

/**
 * F010 v0.10.0公開commitがrecordPublishedBatch相当のstatus更新を伴わなかった
 * 既知事象（F004→F005〜F008→F009で確認済みの同型パターン、f009-mark-published.tsが
 * 直近の是正先例）を是正する。
 * F011（T-206、手袋を買いに content-preview実行時、loadAcceptedBatchesが
 * manifest.status==='published'を要求するためF010がcatalogから欠落し
 * verifyF011ArtworkAgainstCatalogの「既存9作者以上」チェックで発覚）で発見した。
 * 実evidence（docs/evidence/release/F010-{deployment,smoke}.json、実際の
 * GitHub Actions run 32667081141の実データ）を根拠にdeploymentEvidenceRef/
 * publishedAt/releaseVersion/smokeEvidenceRef/statusをcanonical JSONとして
 * 追記・更新する。f009-mark-published.tsのF010向け複製。
 */

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = resolve(workspace, 'content', 'batches', 'F010', 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F010 manifestがcanonicalではありません');
  }
  if (checked.value.status !== 'accepted') {
    throw new Error(`F010 manifestは既にstatus=${checked.value.status}です`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const updated = {
    ...checked.value,
    deploymentEvidenceRef: 'docs/evidence/release/F010-deployment.json',
    publishedAt: '2026-08-23T21:35:47Z',
    releaseVersion: '0.10.0',
    smokeEvidenceRef: 'docs/evidence/release/F010-smoke.json',
    status: 'published' as const,
  };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error('書込み後のF010 manifestがcanonicalではありません');
  }
  process.stdout.write(
    `F010 batch.json: status=${recheck.value.status}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
