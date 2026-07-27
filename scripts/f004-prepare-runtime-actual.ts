import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson } from '../src/content/artifacts.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type WorkId,
} from '../src/content/batch.ts';

const BATCH_ID = 'F004';
const WORK_ID = '000466' as WorkId;
const MEBIBYTE = 1_048_576;

async function writeCanonicalAtomic(path: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  await mkdir(dirname(path), { recursive: true });
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return;
    throw new Error(`既存artifactが現在のmanifest tupleと異なります: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

const workspace = resolve(process.cwd());
const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
const checked = validateBatchManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as BatchManifest);
if (!checked.ok) throw new Error(`F004 manifestが不正です: ${checked.error.code}`);
const manifest = checked.value;
const work = manifest.workProgress[manifest.workIds.indexOf(WORK_ID)];
if (work?.status !== 'voiced') {
  throw new Error(`capacity actual入力にはvoiced状態が必要です: ${work?.status ?? 'missing'}`);
}
const output = join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'capacity-actual-inputs.json');
await writeCanonicalAtomic(output, {
  schemaVersion: '1.0.0',
  kind: 'capacity-actual-inputs',
  batchId: BATCH_ID,
  workId: WORK_ID,
  voicedManifestSha: hashBatchManifest(manifest),
  liveWriteUpperBounds: 64 * MEBIBYTE,
  rollbackBackupBytes: 16 * MEBIBYTE,
});
process.stdout.write(`capacity-actual inputs: ready (${hashBatchManifest(manifest)})\n`);
