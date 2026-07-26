import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  prepareWorkAcceptance,
  promoteVerifiedWorkArtifacts,
  type F003BaselineDistArtifact,
  type F003EvidenceFileRef,
  type F003VoiceCompletenessArtifact,
  type F003WorkEvidenceRefs,
} from '../src/content/f003-review-acceptance.ts';

const BATCH_ID = 'F003';
const WORK_ID = '000275';
const WORK_ROOT = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}`;

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function ref(workspace: string, path: string): Promise<F003EvidenceFileRef> {
  const bytes = await readFile(resolve(workspace, ...path.split('/')));
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

async function json<T>(workspace: string, path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(workspace, ...path.split('/')), 'utf8')) as T;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const paths = {
    primary: `${WORK_ROOT}/reviews/primary.json`,
    secondary: `${WORK_ROOT}/reviews/secondary.json`,
    adjudication: `${WORK_ROOT}/reviews/adjudication.json`,
    reconciliation: `${WORK_ROOT}/review-reconciliation.json`,
    candidateSafety: `${WORK_ROOT}/candidate-safety.json`,
    voiceCompleteness: `${WORK_ROOT}/voice-completeness.json`,
    capacityActual: `${WORK_ROOT}/capacity-actual.json`,
    baselineContent: `${WORK_ROOT}/baseline-content.json`,
    baselineDist: `${WORK_ROOT}/baseline-dist.json`,
  } as const;
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) =>
    [key, await ref(workspace, path)] as const));
  const refs = Object.fromEntries(entries) as unknown as F003WorkEvidenceRefs;
  const [voice, dist] = await Promise.all([
    json<F003VoiceCompletenessArtifact>(workspace, paths.voiceCompleteness),
    json<F003BaselineDistArtifact>(workspace, paths.baselineDist),
  ]);
  const baseline = {
    contentBuildSha256: dist.payload.contentBuildSha256,
    distSha256: dist.payload.distSha256,
    voiceConfigHash: voice.payload.generation.configHash,
  };
  const prepared = await prepareWorkAcceptance(
    workspace,
    `content/batches/${BATCH_ID}/batch.json`,
    WORK_ID,
    refs,
    baseline,
  );
  const result = await promoteVerifiedWorkArtifacts(
    workspace,
    prepared,
    prepared.manifestSha256,
  );
  process.stdout.write(
    `accepted ${BATCH_ID}/${WORK_ID}: tree=${result.evidence.postTreeDigest}, journal=${result.journalSha256}\n`,
  );
}

await main();
