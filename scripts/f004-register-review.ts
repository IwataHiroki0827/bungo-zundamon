import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  registerF004ReviewAuthorizations,
  type F004CandidateSet,
} from '../src/content/f004-editorial.ts';
import type { ReviewRunAuthorization } from '../src/content/editorial-independent.ts';

const WORK_CONFIG = Object.freeze({
  '000466': { task: 't056', runDate: '20260728' },
  '045679': { task: 't057', runDate: '20260729' },
  '001918': { task: 't058', runDate: '20260729' },
} as const);
const WORK_ID = process.argv[2] as keyof typeof WORK_CONFIG;
const workConfig = WORK_CONFIG[WORK_ID];
if (!workConfig) throw new Error('F004のwork IDが必要です');
const CANDIDATE_PATH =
  `data/batches/F004/work-artifacts/${WORK_ID}/intermediate/${WORK_ID}/candidates.json`;
const REVIEW_INPUT_PATH = `content/batches/F004/review-inputs/${WORK_ID}.json`;
const POLICY_PATH = 'docs/srs/SRS-F004.md';
const TOOL_PATH = 'src/content/f004-editorial.ts';

const REVIEWERS = Object.freeze([
  {
    role: 'primary' as const,
    producerTaskPath: `/root/f004_${workConfig.task}_primary_review`,
    runId: `primary-${WORK_ID}-${workConfig.runDate}-01`,
    outputPath: `.cache/f004-review/${WORK_ID}-primary.json`,
  },
  {
    role: 'secondary' as const,
    producerTaskPath: `/root/f004_${workConfig.task}_secondary_review`,
    runId: `secondary-${WORK_ID}-${workConfig.runDate}-01`,
    outputPath: `.cache/f004-review/${WORK_ID}-secondary.json`,
  },
]);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readCanonical(workspace: string, path: string): Promise<{ text: string; value: unknown }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as unknown;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const bundlePath =
    `content/batches/F004/review-inputs/${WORK_ID}-authorizations.json`;
  const [candidate, reviewInput, policy, tool] = await Promise.all([
    readCanonical(workspace, CANDIDATE_PATH),
    readCanonical(workspace, REVIEW_INPUT_PATH),
    readFile(join(workspace, ...POLICY_PATH.split('/'))),
    readFile(join(workspace, ...TOOL_PATH.split('/'))),
  ]);
  const artifact = reviewInput.value as F004CandidateSet;
  if (
    artifact.schemaVersion !== '1.0.0' ||
    artifact.kind !== 'f004-dialogue-candidate-set' ||
    artifact.batchId !== 'F004' ||
    artifact.workId !== WORK_ID ||
    canonicalJson(artifact.candidates) !== candidate.text ||
    artifact.reviewCandidates.length !== artifact.candidates.length
  ) {
    throw new Error('候補artifactとreview inputのtupleが一致しません');
  }
  try {
    const existing = await readCanonical(workspace, bundlePath);
    const bundle = existing.value as {
      readonly schemaVersion?: unknown;
      readonly kind?: unknown;
      readonly batchId?: unknown;
      readonly workId?: unknown;
      readonly authorizations?: unknown;
    };
    if (
      bundle.schemaVersion !== '1.0.0' ||
      bundle.kind !== 'f004-review-authorization-bundle' ||
      bundle.batchId !== 'F004' ||
      bundle.workId !== WORK_ID ||
      !Array.isArray(bundle.authorizations) ||
      bundle.authorizations.length !== REVIEWERS.length
    ) {
      throw new Error('既存authorization bundleが不正です');
    }
    const authorizations = bundle.authorizations as ReviewRunAuthorization[];
    await registerF004ReviewAuthorizations(workspace, authorizations);
    process.stdout.write(canonicalJson({
      ok: true,
      resumed: true,
      bundlePath,
      bundleSha256: sha256(existing.text),
      authorizations,
    }));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const issuedAt = new Date().toISOString();
  const authorizations: ReviewRunAuthorization[] = [];
  for (const reviewer of REVIEWERS) {
    const promptPath =
      `content/batches/F004/review-inputs/${WORK_ID}-${reviewer.role}-prompt.json`;
    const prompt = {
      schemaVersion: '1.0.0',
      kind: 'f004-independent-review-prompt',
      feature: 'F004',
      batchId: 'F004',
      workId: WORK_ID,
      role: reviewer.role,
      producerTaskPath: reviewer.producerTaskPath,
      runId: reviewer.runId,
      candidatePath: CANDIDATE_PATH,
      candidateSha256: sha256(candidate.text),
      outputPath: reviewer.outputPath,
      independence: '他方reviewerの判断・出力を参照せず、候補全集合を独立判定する',
      decisions: ['approved', 'rejected', 'ambiguous'],
      approvedReasonCodes: ['SPOKEN_DIALOGUE', 'INNER_MONOLOGUE'],
      rejectedReasonCodes: [
        'QUOTED_MATERIAL',
        'EXPRESSION_EXAMPLE',
        'NON_SPEECH',
        'EXTRACTION_ARTIFACT',
        'POLICY_EXCLUDED',
      ],
      speakerRule: 'approvedはspeaker必須、rejected/ambiguousはspeaker=null',
    };
    await writeJsonArtifactAtomic(
      workspace,
      join(resolve(workspace), ...promptPath.split('/')),
      prompt,
    );
    const promptText = canonicalJson(prompt);
    const authorization: ReviewRunAuthorization = {
      authorizationId: `f004-${WORK_ID}-${reviewer.role}`,
      role: reviewer.role,
      producerTaskPath: reviewer.producerTaskPath,
      judgeRole: reviewer.role,
      runId: reviewer.runId,
      candidateSetSha256: artifact.reviewCandidateSetSha256,
      policySha256: sha256(policy),
      promptSha256: sha256(promptText),
      toolSha256: sha256(tool),
      nonce: `f004-${WORK_ID}-${reviewer.role}-${workConfig.runDate}-01-nonce`,
      issuedAt,
      inputRefs: [
        { kind: 'candidateSet', path: CANDIDATE_PATH, sha256: sha256(candidate.text) },
        { kind: 'policy', path: POLICY_PATH, sha256: sha256(policy) },
        { kind: 'prompt', path: promptPath, sha256: sha256(promptText) },
        { kind: 'tool', path: TOOL_PATH, sha256: sha256(tool) },
      ],
      candidates: artifact.reviewCandidates,
    };
    authorizations.push(Object.freeze(authorization));
  }
  await writeJsonArtifactAtomic(
    workspace,
    join(resolve(workspace), ...bundlePath.split('/')),
    {
      schemaVersion: '1.0.0',
      kind: 'f004-review-authorization-bundle',
      batchId: 'F004',
      workId: WORK_ID,
      authorizations,
    },
  );
  await registerF004ReviewAuthorizations(workspace, authorizations);
  process.stdout.write(canonicalJson({
    ok: true,
    bundlePath,
    bundleSha256: sha256(canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'f004-review-authorization-bundle',
      batchId: 'F004',
      workId: WORK_ID,
      authorizations,
    })),
    authorizations,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
