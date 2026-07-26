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
const WORK_IDS = ['000275', '001567', '000258'] as const;
const workFlag = process.argv.indexOf('--work');
const workArgument = workFlag >= 0 ? process.argv[workFlag + 1] : process.argv[2];
if (!workArgument || !WORK_IDS.includes(workArgument as (typeof WORK_IDS)[number])) {
  throw new Error(`usage: node --experimental-transform-types scripts/f003-reaccept-reset.ts --work ${WORK_IDS.join('|')}`);
}
const WORK_ID = workArgument;
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

function voicedManifest(current: BatchManifest): BatchManifest {
  const index = current.workIds.indexOf(WORK_ID as never);
  const work = current.workProgress[index];
  const accepted = work?.status === 'accepted' && work.stageRecords.at(-1)?.stage === 'accepted';
  const partiallyReset = work?.status === 'voiced' && work.stageRecords.at(-1)?.stage === 'capacity-actual';
  if (current.batchId !== BATCH_ID || index < 0 || !work || (!accepted && !partiallyReset) ||
    current.workProgress.slice(index + 1).some((item) => item.status === 'accepted')) {
    throw new Error(`${WORK_ID}が再受入可能な最後のaccepted/voiced workではありません`);
  }
  const {
    acceptedAt: _acceptedAt,
    acceptedBy: _acceptedBy,
    acceptedAudioSources: _acceptedAudioSources,
    ...workCore
  } = work;
  void _acceptedAt;
  void _acceptedBy;
  void _acceptedAudioSources;
  const voiced = {
    ...workCore,
    status: 'voiced' as const,
    stageRecords: work.stageRecords.slice(0, accepted ? -2 : -1),
  };
  if (voiced.stageRecords.at(-1)?.stage !== 'voiced') {
    throw new Error('voicedへ戻すためのstage chainがありません');
  }
  delete (voiced as { actualCapacityRef?: string }).actualCapacityRef;
  const {
    acceptedAt: _batchAcceptedAt,
    acceptedBy: _batchAcceptedBy,
    ...batchCore
  } = current;
  void _batchAcceptedAt;
  void _batchAcceptedBy;
  const candidate = {
    ...batchCore,
    status: 'voiced' as const,
    workProgress: current.workProgress.map((item, workIndex) => workIndex === index ? voiced : item),
  };
  const checked = validateBatchManifest(candidate);
  if (!checked.ok) throw new Error(`voiced manifestが不正です: ${checked.error.code}`);
  return checked.value;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const manifestFile = join(workspace, ...MANIFEST_PATH.split('/'));
  const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown;
  const checked = validateBatchManifest(raw);
  if (!checked.ok) throw new Error(`F003 manifestが不正です: ${checked.error.code}`);
  const current = checked.value;
  const next = voicedManifest(current);
  const backup = join(
    workspace,
    '.cache',
    'f003-reaccept-backup',
    `${WORK_ID}-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  await mkdir(dirname(backup), { recursive: true });
  await mkdir(backup, { recursive: false });
  await copyFile(manifestFile, join(backup, 'batch.accepted.json'));

  for (const relativePath of [
    `content/batches/${BATCH_ID}/accepted-audio/${WORK_ID}`,
    `content/batches/${BATCH_ID}/capacity-actual/${WORK_ID}.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/voice-completeness.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/capacity-actual.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/baseline-content.json`,
    `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/baseline-dist.json`,
    `.cache/batch-accept/${BATCH_ID}/${WORK_ID}/content-preview.json`,
    `.cache/batch-accept/${BATCH_ID}/${WORK_ID}/dist-preview.json`,
    `.cache/batch-accept/${BATCH_ID}/${WORK_ID}/f001-content-invariant.json`,
    `.cache/batch-accept/${BATCH_ID}/${WORK_ID}/published-content-invariant.json`,
    `.cache/batch-accept/${BATCH_ID}/${WORK_ID}/f001-dist-invariant.json`,
    `.cache/transactions/accepted-audio/${BATCH_ID}-${WORK_ID}.json`,
    `.cache/transactions/f003-work-acceptance/${BATCH_ID}-${WORK_ID}.json`,
  ]) {
    await moveToBackup(workspace, backup, relativePath);
  }

  await writeBatchManifestAtomic(workspace, MANIFEST_PATH, next, hashBatchManifest(current));
  process.stdout.write(`F003/${WORK_ID}をvoicedへ安全に戻しました。backup=${backup}\n`);
}

await main();
