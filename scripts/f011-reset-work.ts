import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest } from '../src/content/batch.ts';
import { F011_WORKS } from '../src/content/f011-source.ts';

/**
 * F011専用の一時運用script（汎用化: 対象workIdは引数で指定する）。
 * 特定candidateの音声段階除外(candidateCounts.audioExcluded、既存schema)を
 * speech-revisions.json編集で行う前に、accepted済みworkをreviewedへ巻き戻し、
 * voiced以降の派生artifactを削除するために使う。
 *
 * 初出はごん狐(000628)の32承認候補中2件
 * (candidateId IYovdjGtidDGIWvhWi-C4JXJ0V6O0DECy4hNqUURksk /
 * FG3i_rrQnSDmNhuVmH1X2iVqIbbF5NldebR3V6_eb8I)のaudioIdが既公開batch
 * (v0.10.0固定baseline)の既存音声と偶然一致し、src/ui/render.tsの
 * ハード不変条件(1 audioIdにつきasset厳密に1件、かつそのbatchIdが
 * work.batchIdと一致)を満たせないことが判明したケース(CHG-F008-004と同型、
 * docs/changes/changes.yaml CHG-F011-001参照)。CHG-F011-002（000637・
 * 手袋を買いに、byteコンテンツ重複）でも同一scriptを再利用する。
 *
 * work状態遷移はforward-onlyのため、batch.jsonのworkProgressを直接
 * 書き換える(F011ローカル、共有モジュール無変更)。
 */
const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = resolve(WORKSPACE, 'content', 'batches', 'F011', 'batch.json');
const workIdArgument = process.argv[2];
if (!workIdArgument || !F011_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F011_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f011-reset-work.ts 000637）: ${String(workIdArgument)}`,
  );
}
const WORK_ID = workIdArgument;

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
  // batch.status(BatchManifest)はworkProgressの最低状態と一致している必要がある
  // (src/content/batch.ts validateBatchManifest、共有モジュール無変更のため
  // ここでは同じ規則をローカルに再現するだけ)。000628時点ではbatch全体が
  // まだaccepted未満だったため不要だったが、今回は3 work全てaccepted後の
  // 巻き戻しのためbatch.statusも合わせて引き下げる。
  const WORK_STATUS_ORDER = ['pending', 'extracted', 'reviewed', 'budget-approved', 'voiced', 'accepted'] as const;
  const minimumWorkRank = Math.min(
    ...nextWorkProgress.map((item) => WORK_STATUS_ORDER.indexOf((item as { status: string }).status as (typeof WORK_STATUS_ORDER)[number])),
  );
  const nextBatchStatus = minimumWorkRank > 0 ? WORK_STATUS_ORDER[minimumWorkRank] : manifest.status;
  const nextManifest: Record<string, unknown> = { ...manifest, status: nextBatchStatus, workProgress: nextWorkProgress };
  if (nextBatchStatus !== 'accepted' && nextBatchStatus !== 'published') {
    delete nextManifest.acceptedAt;
    delete nextManifest.acceptedBy;
  }
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
