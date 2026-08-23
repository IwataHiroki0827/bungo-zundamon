import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest } from '../src/content/batch.ts';

/**
 * F009 v0.9.0公開commitがrecordPublishedBatch相当のstatus更新を伴わなかった
 * 既知事象（F004→F005・F005→F006・F006→F007・F007→F008で確認済みの同型パターン、
 * f008-mark-published.tsが直近の是正先例）を是正する。
 * F010（T-195、檸檬content-preview実行時、loadAcceptedBatchesが
 * manifest.status==='published'を要求するためF009がcatalogから欠落し
 * verifyF010ArtworkAgainstCatalogの「既存8作者以上」チェックで発覚）で発見した。
 * 実evidence（docs/evidence/release/F009-{deployment,smoke}.json、実際の
 * GitHub Actions run 32659045364の実データ）を根拠にdeploymentEvidenceRef/
 * publishedAt/releaseVersion/smokeEvidenceRef/statusをcanonical JSONとして
 * 追記・更新する。f008-mark-published.tsのF009向け複製。
 */

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = resolve(workspace, 'content', 'batches', 'F009', 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F009 manifestがcanonicalではありません');
  }
  if (checked.value.status !== 'accepted') {
    throw new Error(`F009 manifestは既にstatus=${checked.value.status}です`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const updated = {
    ...checked.value,
    deploymentEvidenceRef: 'docs/evidence/release/F009-deployment.json',
    publishedAt: '2026-08-23T19:02:36Z',
    releaseVersion: '0.9.0',
    smokeEvidenceRef: 'docs/evidence/release/F009-smoke.json',
    status: 'published' as const,
  };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error('書込み後のF009 manifestがcanonicalではありません');
  }
  process.stdout.write(
    `F009 batch.json: status=${recheck.value.status}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
