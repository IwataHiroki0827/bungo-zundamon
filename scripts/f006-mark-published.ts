import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest } from '../src/content/batch.ts';

/**
 * F006 v0.6.0公開commitがrecordPublishedBatch相当のstatus更新を伴わなかった
 * 既知事象（F004→F005で確認済みの同型パターン、commit 9105bfaが同じ形式で
 * F005を是正した先例に倣う）を是正する。汎用recordPublishedBatchは
 * PUBLIC_ROUTES_BY_FEATURE(F002/F003/F004のみ登録)にF006が未登録のため
 * PUBLISH_SMOKE_FAILEDで使えない(F005の是正時もこの理由で同じ手法を
 * 採らなかった)。実evidence(docs/evidence/release/F006-{deployment,smoke}.json、
 * T-156で実データ作成済み)を根拠にdeploymentEvidenceRef/publishedAt/
 * releaseVersion/smokeEvidenceRef/statusをcanonical JSONとして追記・更新する。
 */

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = resolve(workspace, 'content', 'batches', 'F006', 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F006 manifestがcanonicalではありません');
  }
  if (checked.value.status !== 'accepted') {
    throw new Error(`F006 manifestは既にstatus=${checked.value.status}です`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const updated = {
    ...checked.value,
    deploymentEvidenceRef: 'docs/evidence/release/F006-deployment.json',
    publishedAt: '2026-08-22T06:22:52Z',
    releaseVersion: '0.6.0',
    smokeEvidenceRef: 'docs/evidence/release/F006-smoke.json',
    status: 'published' as const,
  };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error('書込み後のF006 manifestがcanonicalではありません');
  }
  process.stdout.write(
    `F006 batch.json: status=${recheck.value.status}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
