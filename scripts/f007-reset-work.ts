import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest, type WorkProgress } from '../src/content/batch.ts';

/**
 * 高瀬舟(045245)のorder12候補(2408文字)がVOICEVOX synthesis上限
 * (実測約1330〜1340文字)超でHTTP 500になる実バグが発見され、
 * f007-source.tsのsplitOverlongF007Candidatesで安全分割する訂正を導入した
 * (候補数13→16)。この訂正前の誤った候補構成でstatus=budget-approved
 * まで進行済み(extracted/reviewed/budget-approvedの3 stageRecords)だった
 * ため、transitionWorkState/advanceF007WorkStateは巻き戻しを許さず
 * (WORK_STATE_REWIND)、訂正後の候補構成でのやり直しができない状態に
 * なっていた。
 *
 * writeBatchManifestAtomic自体はFSM単調性を強制しない汎用atomic writerの
 * ため(F006 published是正 commit 801352eと同型)、045245のworkProgressを
 * 000689(未着手work)と同一の最小pending形状へ直接リセットし、訂正後の
 * 候補構成で抽出→独立二重判定→音声化→受入を最初からやり直せるようにする。
 * 対象work以外のworkProgress(058126=accepted、000689=pending)は変更しない。
 */

const WORK_ID = '045245';

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestPath = resolve(workspace, 'content', 'batches', 'F007', 'batch.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== manifestText) {
    throw new Error('F007 manifestがcanonicalではありません');
  }
  const index = checked.value.workIds.indexOf(WORK_ID as never);
  const current = checked.value.workProgress[index];
  if (!current) throw new Error(`work ${WORK_ID}がmanifestにありません`);
  if (current.status === 'accepted') {
    throw new Error(`work ${WORK_ID}は既にacceptedです。resetの対象外です`);
  }
  const beforeSha = hashBatchManifest(checked.value);
  const resetProgress: WorkProgress = { workId: WORK_ID as never, status: 'pending', stageRecords: [] };
  const nextWorkProgress = checked.value.workProgress.map((item, i) => (i === index ? resetProgress : item));
  const updated = { ...checked.value, workProgress: nextWorkProgress };
  await writeJsonArtifactAtomic(workspace, manifestPath, updated);
  const rewritten = await readFile(manifestPath, 'utf8');
  const recheck = validateBatchManifest(JSON.parse(rewritten) as unknown);
  if (!recheck.ok || canonicalJson(recheck.value) !== rewritten) {
    throw new Error('書込み後のF007 manifestがcanonicalではありません');
  }
  process.stdout.write(
    `F007 batch.json: work ${WORK_ID} status=${recheck.value.workProgress[index]?.status}, beforeSha=${beforeSha}, afterSha=${hashBatchManifest(recheck.value)}\n`,
  );
}

await main();
