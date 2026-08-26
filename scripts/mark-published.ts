import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest } from '../src/content/batch.ts';

/**
 * リリース(デプロイ成功)後にbatch manifestをaccepted→publishedへ書き戻す汎用CLI。
 * 使い方: node --experimental-transform-types scripts/mark-published.ts <batchId>
 *
 * f006〜f010-mark-published.tsとして5本複製されてきた同型是正スクリプトの共通化
 * (KB-0015: デプロイ後台帳書戻しはフローに組み込まないと毎回漏れる)。
 * 以後のフィーチャーはこのCLIをリリース工程(公開後更新チェックリスト)から呼ぶ。
 *
 * publishedAt/releaseVersionは手書きせず、実evidence
 * (docs/evidence/release/{batchId}-deployment.json / {batchId}-approval.json)から
 * 導出する。evidenceが存在しない・result不合格のbatchには適用できない。
 */

interface DeploymentEvidence {
  readonly deployedAt: string;
  readonly result: string;
}

interface ApprovalEvidence {
  readonly releaseVersion: string;
  readonly result: string;
}

async function main(): Promise<void> {
  const batchId = process.argv[2];
  if (batchId === undefined || !/^F\d{3}$/.test(batchId)) {
    throw new Error('使い方: mark-published.ts <batchId(F0NN形式)>');
  }
  const workspace = resolve(process.cwd());

  const deploymentRef = `docs/evidence/release/${batchId}-deployment.json`;
  const smokeRef = `docs/evidence/release/${batchId}-smoke.json`;
  const approvalRef = `docs/evidence/release/${batchId}-approval.json`;
  const deployment = JSON.parse(
    await readFile(resolve(workspace, deploymentRef), 'utf8'),
  ) as DeploymentEvidence;
  const approval = JSON.parse(
    await readFile(resolve(workspace, approvalRef), 'utf8'),
  ) as ApprovalEvidence;
  await readFile(resolve(workspace, smokeRef), 'utf8');
  if (deployment.result !== 'success') {
    throw new Error(`${deploymentRef}のresultがsuccessではありません: ${deployment.result}`);
  }
  if (approval.result !== 'approved') {
    throw new Error(`${approvalRef}のresultがapprovedではありません: ${approval.result}`);
  }

  const manifestPath = resolve(workspace, 'content', 'batches', batchId, 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error(`${batchId} manifestがcanonicalではありません`);
  }
  if (checked.value.status === 'published') {
    process.stdout.write(`${batchId} batch.json: 既にpublishedです(冪等スキップ)\n`);
    return;
  }
  if (checked.value.status !== 'accepted') {
    throw new Error(`${batchId} manifestはstatus=${checked.value.status}のためpublished化できません`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const updated = {
    ...checked.value,
    deploymentEvidenceRef: deploymentRef,
    publishedAt: deployment.deployedAt,
    releaseVersion: approval.releaseVersion,
    smokeEvidenceRef: smokeRef,
    status: 'published' as const,
  };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error(`書込み後の${batchId} manifestがcanonicalではありません`);
  }
  process.stdout.write(
    `${batchId} batch.json: status=${recheck.value.status}, publishedAt=${deployment.deployedAt}, releaseVersion=${approval.releaseVersion}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
