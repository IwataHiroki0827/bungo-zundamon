/**
 * F005/F006/F007/F008と同型の不備（CHG-F005-078・F006/F007/F008側是正参照）がF009にも再発した:
 * F009 batch.jsonはbatch level `stageRecords`が空のまま（F002〜F004が経由する
 * 共有`transitionBatchState('rights-verified', ...)`を一度も通らない設計）
 * であるため、`rightsSnapshotIds`が空配列のまま3作品全件acceptedへ進んで
 * しまっていた。
 * work状態遷移はforward-onlyのため、通常のacceptedフローをやり直すことはできない。
 * このスクリプトは、実在するevidence（selection.jsonのpolicies[].decision.contentSha256、
 * 選定時に取得・検証済み）から機械的に値を導出し、batch.jsonへ一度だけ直接書き込む。
 * 値は捏造せず、必ず実ファイルを読んで検証する。
 * selection.jsonの`kind`フィールドは実データ上`f008-source-selection-snapshot`のまま
 * （F009向けgenerator実装時に`kind`文字列がF008から複製されリネームされなかった、
 * 既存の実データそのもの）であり、本scriptはこの実測値をそのまま検証条件とする。
 *
 * 実行後もこのファイルは記録として残す（削除しない）。
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson, fingerprintArtifact, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest, type BatchManifest } from '../src/content/batch.ts';

const WORKSPACE = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = join(WORKSPACE, 'content', 'batches', 'F009', 'batch.json');
const SELECTION_PATH = join(WORKSPACE, 'content', 'batches', 'F009', 'source-snapshots', 'selection.json');
const SHA256 = /^[0-9a-f]{64}$/u;

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

async function deriveRightsSnapshotIds(): Promise<readonly string[]> {
  const { text, value } = await readJson(SELECTION_PATH);
  if (canonicalJson(value) !== text) {
    throw new Error('selection.jsonがcanonical JSONではありません');
  }
  const record = value as {
    kind?: unknown;
    batchId?: unknown;
    policies?: readonly unknown[];
  };
  if (record.kind !== 'f008-source-selection-snapshot' || record.batchId !== 'F009' ||
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
  if (!checked.ok || checked.value.batchId !== 'F009' || canonicalJson(checked.value) !== manifestText) {
    throw new Error(`既存batch.jsonがcanonical F009 manifestではありません: ${!checked.ok ? checked.error.code : 'text mismatch'}`);
  }
  const manifest = checked.value;
  if (manifest.status !== 'accepted') {
    throw new Error(`backfill前提が崩れています。status=${manifest.status} (accepted想定)`);
  }
  if (manifest.rightsSnapshotIds.length > 0) {
    console.log('backfill不要: rightsSnapshotIdsは既に設定済みです。');
    return;
  }

  console.log('evidence導出:');
  const rightsSnapshotIds = await deriveRightsSnapshotIds();

  const candidate: BatchManifest = {
    ...manifest,
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
