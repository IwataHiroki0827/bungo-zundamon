import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest } from '../src/content/batch.ts';

/**
 * F011専用の一時運用script。ごん狐(000628)の32承認候補中2件
 * (candidateId IYovdjGtidDGIWvhWi-C4JXJ0V6O0DECy4hNqUURksk /
 * FG3i_rrQnSDmNhuVmH1X2iVqIbbF5NldebR3V6_eb8I)のaudioIdが既公開batch
 * (v0.10.0固定baseline)の既存音声と偶然一致し、src/ui/render.tsの
 * ハード不変条件(1 audioIdにつきasset厳密に1件、かつそのbatchIdが
 * work.batchIdと一致)を満たせないことが判明した(CHG-F008-004と同型の
 * 事象、詳細はdocs/changes/changes.yaml参照)。
 *
 * この2候補を音声段階の除外対象(candidateCounts.audioExcluded、既存schema)
 * として扱うため、000628をaccepted→reviewedへ巻き戻し、この2候補を除いた
 * 30候補で音声生成からやり直す。work状態遷移はforward-onlyのため、
 * batch.jsonのworkProgressを直接書き換える(F011ローカル、共有モジュール
 * 無変更)。
 */
const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = resolve(WORKSPACE, 'content', 'batches', 'F011', 'batch.json');
const WORK_ID = '000628';

async function main(): Promise<void> {
  const manifestText = await readFile(MANIFEST_PATH, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok) throw new Error('F011 manifestがcanonicalではありません');
  const manifest = checked.value;
  const index = manifest.workIds.indexOf(WORK_ID as never);
  const work = manifest.workProgress[index];
  if (!work || work.status !== 'accepted') {
    throw new Error(`work ${WORK_ID}はaccepted状態ではありません: ${String(work?.status)}`);
  }
  const stageRecords = work.stageRecords.filter((record) => record.stage === 'extracted' || record.stage === 'reviewed');
  if (stageRecords.length !== 2) throw new Error('extracted/reviewed stageRecordsが想定と異なります');

  const nextWork: Record<string, unknown> = {
    workId: work.workId,
    status: 'reviewed',
    stageRecords,
  };
  const nextWorkProgress = manifest.workProgress.map((item, i) => (i === index ? nextWork : item));
  const nextManifest: Record<string, unknown> = { ...manifest, workProgress: nextWorkProgress };
  const validated = validateBatchManifest(nextManifest);
  if (!validated.ok) throw new Error(`reset後manifestが不正です: ${validated.error.code} ${validated.error.message}`);

  await writeJsonArtifactAtomic(WORKSPACE, MANIFEST_PATH, validated.value);
  await rm(resolve(WORKSPACE, '.cache', 'transactions', 'batch-manifest', 'F011.json'), { force: true });
  await rm(resolve(WORKSPACE, '.cache', 'transactions', 'accepted-audio', `F011-${WORK_ID}.json`), { force: true });

  // 派生artifact(voiced以降で生成された実データ)を削除する。
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'accepted-audio', WORK_ID), { recursive: true, force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'capacity-actual', `${WORK_ID}.json`), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'capacity-forecast', `${WORK_ID}.json`), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'voice-evidence', `${WORK_ID}.json`), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'work-artifacts', WORK_ID, 'voice-generation.json'), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'work-artifacts', WORK_ID, 'voice-completeness.json'), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'work-artifacts', WORK_ID, `.voice-stage-${WORK_ID}`), { recursive: true, force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F011', 'public-files', 'provenance', `${WORK_ID}.json`), { force: true });

  process.stdout.write(canonicalJson({ ok: true, workId: WORK_ID, status: 'reviewed' }));
}

await main();
