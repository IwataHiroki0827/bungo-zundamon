import { copyFile, lstat, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  hashBatchManifest,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';

const BATCH_ID = 'F003';
const WORK_ID = '000275';
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json` as WorkspaceRelativePath;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moveToBackup(workspace: string, backup: string, relativePath: string): Promise<void> {
  const source = join(workspace, ...relativePath.split('/'));
  if (!await exists(source)) return;
  const target = join(backup, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

function reviewedManifest(current: BatchManifest): BatchManifest {
  const index = current.workIds.indexOf(WORK_ID as never);
  const work = current.workProgress[index];
  if (current.batchId !== BATCH_ID || index !== 0 || !work || work.status !== 'accepted' ||
    work.stageRecords.at(-1)?.stage !== 'accepted') {
    throw new Error('女生徒がacceptedのcanonical F003 manifestではありません');
  }
  const reviewed = {
    workId: work.workId,
    status: 'reviewed' as const,
    stageRecords: work.stageRecords.slice(0, 2),
  };
  if (reviewed.stageRecords.at(-1)?.stage !== 'reviewed') {
    throw new Error('reviewedへ戻すためのstage chainがありません');
  }
  const candidate = {
    ...current,
    workProgress: current.workProgress.map((item, workIndex) => workIndex === index ? reviewed : item),
  };
  const checked = validateBatchManifest(candidate);
  if (!checked.ok) throw new Error(`reviewed manifestが不正です: ${checked.error.code}`);
  return checked.value;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestFile = join(workspace, ...MANIFEST_PATH.split('/'));
  const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown;
  const checked = validateBatchManifest(raw);
  if (!checked.ok) throw new Error(`F003 manifestが不正です: ${checked.error.code}`);
  const current = checked.value;
  const next = reviewedManifest(current);
  const backup = join(workspace, '.cache', 'f003-reaccept-backup', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(dirname(backup), { recursive: true });
  await mkdir(backup, { recursive: false });
  await copyFile(manifestFile, join(backup, 'batch.accepted.json'));

  for (const relativePath of [
    `content/batches/${BATCH_ID}/accepted-audio/${WORK_ID}`,
    `content/batches/${BATCH_ID}/capacity-forecast/${WORK_ID}.json`,
    `content/batches/${BATCH_ID}/capacity-actual/${WORK_ID}.json`,
    `content/batches/${BATCH_ID}/voice-evidence/${WORK_ID}.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/voice-completeness.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/capacity-actual.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/baseline-content.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/baseline-dist.json`,
    `.cache/batch-capacity/${BATCH_ID}/${WORK_ID}`,
    `.cache/batch-accept/${BATCH_ID}/${WORK_ID}`,
    `.cache/transactions/accepted-audio/${BATCH_ID}-${WORK_ID}.json`,
    `.cache/transactions/f003-work-acceptance/${BATCH_ID}-${WORK_ID}.json`,
  ]) {
    await moveToBackup(workspace, backup, relativePath);
  }

  await writeBatchManifestAtomic(workspace, MANIFEST_PATH, next, hashBatchManifest(current));
  process.stdout.write(`F003/${WORK_ID}をreviewedへ安全に戻しました。backup=${backup}\n`);
}

await main();
