import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/content/artifacts.ts';
import { prepareF004CandidateArtifact } from '../src/content/f004-editorial.ts';

const WORK_ID = /^[0-9]{6}$/u;

async function main(): Promise<void> {
  const workId = process.argv[2];
  if (!workId || !WORK_ID.test(workId)) throw new Error('6桁のwork IDが必要です');
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const result = await prepareF004CandidateArtifact(workspace, workId);
  const summary = {
    ok: true,
    batchId: 'F004',
    workId,
    count: result.artifact.candidates.length,
    candidatePath: result.candidatePath,
    candidateSha256: result.candidateSha256,
    reviewInputPath: result.reviewInputPath,
    reviewInputSha256: result.reviewInputSha256,
    reviewCandidateSetSha256: result.artifact.reviewCandidateSetSha256,
  };
  process.stdout.write(canonicalJson(summary));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
