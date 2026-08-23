import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest } from '../src/content/batch.ts';

/**
 * F008専用の一時運用script。一人二役(057193)候補「へええ」
 * (candidateId 6U_FZHeFuXXDsFhoZR_tL-rGzSiPDAqsLMdxMK0hCLA)のaudioIdが
 * F005(001104)の既存台詞と偶然一致し、かつ実測でWAV実体(sha256)が異なる
 * ため、src/ui/render.tsのハード不変条件(1 audioIdにつきasset厳密に1件、
 * かつそのbatchIdがwork.batchIdと一致)を満たせないことが判明した
 * (CHG-F008-004、詳細はdocs/changes/changes.yaml参照)。
 *
 * この候補を音声段階の除外対象(candidateCounts.audioExcluded、既存schema)
 * として扱うため、057193をaccepted→reviewedへ巻き戻し、この1候補を除いた
 * 10候補で音声生成からやり直す。work状態遷移はforward-onlyのため、
 * batch.jsonのworkProgressを直接書き換える(F008ローカル、共有モジュール
 * 無変更)。
 */
const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = resolve(WORKSPACE, 'content', 'batches', 'F008', 'batch.json');
const WORK_ID = '057193';

async function main(): Promise<void> {
  const manifestText = await readFile(MANIFEST_PATH, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok) throw new Error('F008 manifestがcanonicalではありません');
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
  const nextManifest: Record<string, unknown> = { ...manifest, status: 'reviewed' as const, workProgress: nextWorkProgress };
  delete nextManifest.acceptedAt;
  delete nextManifest.acceptedBy;
  const validated = validateBatchManifest(nextManifest);
  if (!validated.ok) throw new Error(`reset後manifestが不正です: ${validated.error.code} ${validated.error.message}`);

  await writeJsonArtifactAtomic(WORKSPACE, MANIFEST_PATH, validated.value);
  await rm(resolve(WORKSPACE, '.cache', 'transactions', 'batch-manifest', 'F008.json'), { force: true });

  // 派生artifact(voiced以降で生成された実データ)を削除する。
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'accepted-audio', WORK_ID), { recursive: true, force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'capacity-actual', `${WORK_ID}.json`), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'capacity-forecast', `${WORK_ID}.json`), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'voice-evidence', `${WORK_ID}.json`), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'work-artifacts', WORK_ID, 'voice-generation.json'), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'work-artifacts', WORK_ID, 'voice-completeness.json'), { force: true });
  await rm(resolve(WORKSPACE, 'content', 'batches', 'F008', 'work-artifacts', WORK_ID, `.voice-stage-${WORK_ID}`), { recursive: true, force: true });

  process.stdout.write(canonicalJson({ ok: true, workId: WORK_ID, status: 'reviewed' }));
}

await main();
