/**
 * CHG-F005-0NN: F005 batch.jsonの3作品は、恒久修正(f005-acceptance.ts)前の
 * finalizeF005WorkAcceptanceで既にaccepted確定してしまっており、
 * work単位actualCapacityRefとbatch単位rightsSnapshotIdsが一度も書き込まれていなかった。
 * work状態遷移はforward-onlyのため、通常のacceptedフローをやり直すことはできない。
 * このスクリプトは、実在するevidence(capacity-actual実体のファイル名=journalId、
 * selection.jsonのpolicies[].decision.contentSha256)から機械的に値を導出し、
 * batch.jsonへ一度だけ直接書き込む。値は捏造せず、必ず実ファイルを読んで検証する。
 *
 * 実行後もこのファイルは記録として残す(削除しない)。
 * 参照: docs/changes/CHG-F005-0NN.md
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson, fingerprintArtifact, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest, type BatchManifest, type WorkspaceRelativePath } from '../src/content/batch.ts';

const WORKSPACE = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = join(WORKSPACE, 'content', 'batches', 'F005', 'batch.json');
const SHA256 = /^[0-9a-f]{64}$/u;
const WORK_IDS = ['000799', '001076', '001104'] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path: string): Promise<{ readonly bytes: Uint8Array; readonly text: string; readonly value: unknown }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error(`regular fileではありません: ${path}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bytes, text, value: JSON.parse(text) as unknown };
}

async function deriveActualCapacityRef(workId: string): Promise<WorkspaceRelativePath> {
  const directory = join(WORKSPACE, 'content', 'batches', 'F005', 'capacity-actual', workId);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/u.test(entry.name));
  if (entries.length !== 1) {
    throw new Error(`capacity-actual実体が一意ではありません: ${workId} (${entries.length}件)`);
  }
  const fileName = entries[0]!.name;
  const journalId = fileName.slice(0, -'.json'.length);
  const path = join(directory, fileName);
  const { value } = await readJson(path);
  const report = value as {
    schemaVersion?: unknown;
    kind?: unknown;
    workId?: unknown;
    journalId?: unknown;
    payload?: { state?: unknown };
  };
  if (report.schemaVersion !== '1.0.0' || report.kind !== 'actual-capacity-report' ||
    report.workId !== workId || report.journalId !== journalId ||
    !report.payload || report.payload.state !== 'closed') {
    throw new Error(`capacity-actual実体のschema/tupleが不正です: ${workId}`);
  }
  const relativePath = `content/batches/F005/capacity-actual/${workId}/${fileName}`;
  console.log(`  actualCapacityRef[${workId}] = ${relativePath} (journalId=${journalId})`);
  return relativePath as WorkspaceRelativePath;
}

async function deriveRightsSnapshotIds(): Promise<readonly string[]> {
  const path = join(WORKSPACE, 'content', 'batches', 'F005', 'source-snapshots', 'selection.json');
  const { text, value } = await readJson(path);
  if (canonicalJson(value) !== text) {
    throw new Error('selection.jsonがcanonical JSONではありません');
  }
  const record = value as {
    kind?: unknown;
    batchId?: unknown;
    policies?: readonly unknown[];
  };
  if (record.kind !== 'f005-source-selection-snapshot' || record.batchId !== 'F005' ||
    !Array.isArray(record.policies) || record.policies.length === 0) {
    throw new Error('selection.jsonのpolicies集合が不正です');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const policy of record.policies) {
    const item = policy as {
      policyId?: unknown;
      artifact?: { sha256?: unknown };
      decision?: { contentSha256?: unknown; decision?: unknown };
    };
    if (typeof item.policyId !== 'string' || item.policyId.length === 0 ||
      !item.decision || typeof item.decision.contentSha256 !== 'string' ||
      !SHA256.test(item.decision.contentSha256) || item.decision.decision !== 'allow' ||
      !item.artifact || item.artifact.sha256 !== item.decision.contentSha256 ||
      seen.has(item.policyId)) {
      throw new Error(`selection.json policyのtupleが不正です: ${JSON.stringify(policy)}`);
    }
    seen.add(item.policyId);
    ids.push(`${item.policyId}:${item.decision.contentSha256}`);
  }
  console.log(`  rightsSnapshotIds = ${JSON.stringify(ids)}`);
  return ids;
}

async function main(): Promise<void> {
  const { bytes: manifestBytes, text: manifestText, value: manifestValue } = await readJson(MANIFEST_PATH);
  const checked = validateBatchManifest(manifestValue);
  if (!checked.ok || checked.value.batchId !== 'F005' || canonicalJson(checked.value) !== manifestText) {
    throw new Error(`既存batch.jsonがcanonical F005 manifestではありません: ${!checked.ok ? checked.error.code : 'text mismatch'}`);
  }
  const manifest = checked.value;
  if (manifest.status !== 'accepted') {
    throw new Error(`backfill前提が崩れています。status=${manifest.status} (accepted想定)`);
  }
  if (manifest.rightsSnapshotIds.length > 0 &&
    manifest.workProgress.every((work) => work.actualCapacityRef !== undefined)) {
    console.log('backfill不要: rightsSnapshotIds/actualCapacityRefは既に設定済みです。');
    return;
  }

  console.log('evidence導出:');
  const actualCapacityRefs = new Map<string, WorkspaceRelativePath>();
  for (const workId of WORK_IDS) {
    actualCapacityRefs.set(workId, await deriveActualCapacityRef(workId));
  }
  const rightsSnapshotIds = manifest.rightsSnapshotIds.length > 0
    ? manifest.rightsSnapshotIds
    : await deriveRightsSnapshotIds();

  const nextWorkProgress = manifest.workProgress.map((work) => {
    if (work.actualCapacityRef !== undefined) return work;
    const ref = actualCapacityRefs.get(work.workId);
    if (!ref) throw new Error(`actualCapacityRefが導出できません: ${work.workId}`);
    return { ...work, actualCapacityRef: ref };
  }) as unknown as BatchManifest['workProgress'];

  const candidate: BatchManifest = {
    ...manifest,
    workProgress: nextWorkProgress,
    rightsSnapshotIds,
  };
  const validated = validateBatchManifest(candidate);
  if (!validated.ok) {
    throw new Error(`backfill後manifestが不正です: ${validated.error.code} ${validated.error.message}`);
  }

  const fingerprint = await fingerprintArtifact(MANIFEST_PATH);
  await writeJsonArtifactAtomic(WORKSPACE, MANIFEST_PATH, validated.value, {
    expectedFingerprint: fingerprint,
  });
  console.log(`書込み完了: ${MANIFEST_PATH}`);
  console.log(`  before sha256=${sha256(manifestBytes)}`);
  const after = await readFile(MANIFEST_PATH, 'utf8');
  console.log(`  after  sha256=${sha256(new TextEncoder().encode(after))}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
