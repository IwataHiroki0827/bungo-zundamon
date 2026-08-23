import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest } from '../src/content/batch.ts';

/**
 * F007 v0.7.0公開commitがrecordPublishedBatch相当のstatus更新を伴わなかった
 * 既知事象（F004→F005・F005→F006で確認済みの同型パターン、commit 801352eが
 * F006を是正した先例に倣う）を是正する。T-173（F008 content-preview実行時、
 * loadAcceptedBatchesがmanifest.status==='published'を要求するためF007が
 * catalogから欠落しartwork existing-count検証がF008を含め5件しか見えない
 * という形で発覚）で発見した。汎用recordPublishedBatchはPUBLIC_ROUTES_BY_FEATURE
 * にF007が未登録のためPUBLISH_SMOKE_FAILEDで使えない（F006の是正時と同じ理由で
 * 同じ手法を採らなかった）。実evidence（docs/evidence/release/F007-{deployment,
 * smoke}.json、実際のGitHub Actions run 32576610868の実データ）を根拠に
 * deploymentEvidenceRef/publishedAt/releaseVersion/smokeEvidenceRef/statusを
 * canonical JSONとして追記・更新する。
 */

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = resolve(workspace, 'content', 'batches', 'F007', 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F007 manifestがcanonicalではありません');
  }
  if (checked.value.status !== 'accepted') {
    throw new Error(`F007 manifestは既にstatus=${checked.value.status}です`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const updated = {
    ...checked.value,
    deploymentEvidenceRef: 'docs/evidence/release/F007-deployment.json',
    publishedAt: '2026-08-22T13:51:39Z',
    releaseVersion: '0.7.0',
    smokeEvidenceRef: 'docs/evidence/release/F007-smoke.json',
    status: 'published' as const,
  };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error('書込み後のF007 manifestがcanonicalではありません');
  }
  process.stdout.write(
    `F007 batch.json: status=${recheck.value.status}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
