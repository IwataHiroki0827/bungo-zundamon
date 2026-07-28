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
const workIdArg = process.argv[2];
if (!workIdArg || !/^[0-9]{6}$/u.test(workIdArg)) throw new Error('6桁のwork IDが必要です');
const WORK_ID = workIdArg as WorkId;
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
if (work?.status !== 'reviewed') {
  throw new Error(`forecast入力にはreviewed状態が必要です: ${work?.status ?? 'missing'}`);
}
const output = join(workspace, '.cache', 'batch-capacity', BATCH_ID, WORK_ID, 'forecast-inputs.json');
await writeCanonicalAtomic(output, {
  schemaVersion: '1.0.0',
  kind: 'capacity-forecast-inputs',
  batchId: BATCH_ID,
  workId: WORK_ID,
  expectedManifestSha: hashBatchManifest(manifest),
  plannedPagesBytes: 16 * MEBIBYTE,
  repositoryCandidateFiles: [],
  liveWriteUpperBounds: 64 * MEBIBYTE,
  rollbackBackupBytes: 16 * MEBIBYTE,
});
process.stdout.write(`capacity-forecast inputs: ready (${hashBatchManifest(manifest)})\n`);
