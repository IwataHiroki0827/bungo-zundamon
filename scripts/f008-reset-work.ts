import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest, type WorkId } from '../src/content/batch.ts';

/**
 * F008専用の一時運用script。budget-approved stageのcapacity forecastを、
 * persistent voice cacheの事後昇格(scripts/f008-promote-voice-stage-cache.ts)で
 * hit/miss比率が変わった状態のまま再利用しようとするとplanDigest不一致で
 * 必ず失敗する(forecastCapacityのentries.status/metadataがdigestに含まれるため、
 * CHG-F008-003)。budget-approved stageRecordを取り除きstatusをreviewedへ
 * 巻き戻すことで、次回実行時に新しい(cache-primedな)planから forecast を
 * 再計算させる。実際に生成済みのWAV自体(persistent cache)は削除しない。
 */

const workIdArgument = process.argv[2];
if (!workIdArgument || !/^[0-9]{6}$/u.test(workIdArgument)) {
  throw new Error('work IDを6桁数値で指定してください');
}
const WORK_ID = workIdArgument as WorkId;
const MANIFEST_PATH = 'content/batches/F008/batch.json';

async function main(): Promise<void> {
  const workspace = await fileURLToPath(new URL('..', import.meta.url));
  const manifestPath = resolve(workspace, ...MANIFEST_PATH.split('/'));
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F008 manifestがcanonicalではありません');
  }
  const manifest = checked.value;
  const index = manifest.workIds.indexOf(WORK_ID);
  const work = manifest.workProgress[index];
  if (!work || work.status !== 'budget-approved') {
    throw new Error(`work ${WORK_ID}はbudget-approvedではありません: ${String(work?.status)}`);
  }
  const stageRecords = work.stageRecords.filter((record) => record.stage !== 'budget-approved');
  const nextWork = { ...work, status: 'reviewed' as const, stageRecords };
  delete (nextWork as { forecastRef?: unknown }).forecastRef;
  const nextWorkProgress = manifest.workProgress.map((item, i) => (i === index ? nextWork : item));
  const nextManifest = { ...manifest, workProgress: nextWorkProgress };
  await writeJsonArtifactAtomic(workspace, manifestPath, nextManifest);
  // このscriptはwriteBatchManifestAtomic(汎用transaction journal機構)を経由しないため、
  // 直前の中断されたbudget-approved書込みが残したjournal(.cache/transactions/
  // batch-manifest/F008.json)がstaleなまま残り、次回のwriteBatchManifestAtomic呼出しを
  // BATCH_WRITE_CONFLICTで必ずブロックする。安全に削除する(このscript自体が
  // manifestを既にcanonicalな状態へ確定させているため、journalの継続は不要)。
  await rm(resolve(workspace, '.cache', 'transactions', 'batch-manifest', 'F008.json'), { force: true });
  process.stdout.write(canonicalJson({ ok: true, workId: WORK_ID, status: 'reviewed' }));
}

await main();
