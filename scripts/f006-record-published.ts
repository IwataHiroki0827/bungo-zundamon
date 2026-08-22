import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  hashBatchManifest,
  recordPublishedBatch,
  validateBatchManifest,
  type BatchId,
  type Sha256,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';

/**
 * F006 v0.6.0公開時にrecordPublishedBatchが呼ばれなかった既知事象（F005と同型）を
 * 一回限り是正する。手編集ではなくrecordPublishedBatch自体を実evidenceで呼ぶことで、
 * canonical JSON整形・journal・publish gate検証を汎用実装のまま正しく通す。
 */

function sha256(value: Uint8Array | string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = 'content/batches/F006/batch.json' as WorkspaceRelativePath;
  const manifestText = await readFile(resolve(workspace, ...manifestPath.split('/')), 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok) throw new Error('F006 manifestが不正です');
  const manifest = checked.value;
  const expectedManifestSha = hashBatchManifest(manifest);

  const approvalPath = 'docs/evidence/release/F006-approval.json';
  const deploymentPath = 'docs/evidence/release/F006-deployment.json';
  const smokePath = 'docs/evidence/release/F006-smoke.json';
  const [approvalRaw, deploymentRaw, smokeRaw] = await Promise.all([
    readFile(resolve(workspace, ...approvalPath.split('/')), 'utf8'),
    readFile(resolve(workspace, ...deploymentPath.split('/')), 'utf8'),
    readFile(resolve(workspace, ...smokePath.split('/')), 'utf8'),
  ]);
  const approvalJson = JSON.parse(approvalRaw) as Record<string, unknown>;
  const deploymentJson = JSON.parse(deploymentRaw) as Record<string, unknown>;
  const smokeJson = JSON.parse(smokeRaw) as Record<string, unknown>;

  const release = {
    releaseCandidateBatchId: 'F006' as BatchId,
    feature: 'F006',
    releaseCommit: String(approvalJson.releaseCommit),
    distSha256: String(approvalJson.distSha256) as Sha256,
    artifactDigest: String(approvalJson.artifactDigest) as Sha256,
  };
  const approval = {
    ...release,
    result: 'approved' as const,
    approvedAt: String(approvalJson.approvedAt),
    releaseVersion: String(approvalJson.releaseVersion),
    evidenceRef: approvalPath as WorkspaceRelativePath,
    evidenceSha256: sha256(approvalRaw),
  };
  const deployment = {
    ...release,
    result: 'success' as const,
    deployedAt: String(deploymentJson.deployedAt),
    evidenceRef: deploymentPath as WorkspaceRelativePath,
    evidenceSha256: sha256(deploymentRaw),
    deployFlagDisabled: Boolean(deploymentJson.deployFlagDisabled),
  };
  const smoke = {
    ...release,
    result: 'pass' as const,
    checkedAt: String(smokeJson.checkedAt),
    evidenceRef: smokePath as WorkspaceRelativePath,
    evidenceSha256: sha256(smokeRaw),
    allRoutesCovered: Boolean(smokeJson.allRoutesCovered),
    expectedRoutes: smokeJson.expectedRoutes as readonly string[],
    routes: smokeJson.routes as readonly string[],
  };

  const result = await recordPublishedBatch(
    workspace,
    manifestPath,
    manifest,
    expectedManifestSha,
    release,
    approval,
    deployment,
    smoke,
  );
  process.stdout.write(`F006 batch.json: status=${result.manifest.status}, sha256=${result.sha256}\n`);
}

await main();
