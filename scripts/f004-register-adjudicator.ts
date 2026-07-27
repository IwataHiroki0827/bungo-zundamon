import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import type {
  EditorialJudgmentSet,
  ReviewRunAuthorization,
} from '../src/content/editorial-independent.ts';
import {
  registerF004ReviewAuthorizations,
  type F004CandidateSet,
} from '../src/content/f004-editorial.ts';

const WORK_ID = '000466';
const BUNDLE_PATH = `content/batches/F004/review-inputs/${WORK_ID}-authorizations.json`;
const REVIEW_INPUT_PATH = `content/batches/F004/review-inputs/${WORK_ID}.json`;
const CANDIDATE_PATH =
  `data/batches/F004/work-artifacts/${WORK_ID}/intermediate/${WORK_ID}/candidates.json`;
const POLICY_PATH = 'docs/srs/SRS-F004.md';
const TOOL_PATH = 'src/content/f004-editorial.ts';
const PRIMARY_SEAL_PATH = `content/editorial/authorization-transaction/seals/f004-${WORK_ID}-primary.json`;
const SECONDARY_SEAL_PATH = `content/editorial/authorization-transaction/seals/f004-${WORK_ID}-secondary.json`;
const PROMPT_PATH =
  `content/batches/F004/review-inputs/${WORK_ID}-adjudicator-prompt.json`;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [bundleArtifact, reviewInput, candidate, policy, tool, primary, secondary] = await Promise.all([
    canonicalArtifact<{
      schemaVersion: '1.0.0';
      kind: 'f004-review-authorization-bundle';
      batchId: 'F004';
      workId: string;
      authorizations: readonly ReviewRunAuthorization[];
    }>(workspace, BUNDLE_PATH),
    canonicalArtifact<F004CandidateSet>(workspace, REVIEW_INPUT_PATH),
    canonicalArtifact<unknown>(workspace, CANDIDATE_PATH),
    readFile(join(workspace, ...POLICY_PATH.split('/'))),
    readFile(join(workspace, ...TOOL_PATH.split('/'))),
    canonicalArtifact<EditorialJudgmentSet>(workspace, PRIMARY_SEAL_PATH),
    canonicalArtifact<EditorialJudgmentSet>(workspace, SECONDARY_SEAL_PATH),
  ]);
  const existing = bundleArtifact.value.authorizations;
  const resumed = existing.find((item) => item.role === 'adjudicator');
  if (resumed) {
    await registerF004ReviewAuthorizations(workspace, [resumed]);
    process.stdout.write(canonicalJson({
      ok: true,
      resumed: true,
      bundlePath: BUNDLE_PATH,
      bundleSha256: sha256(bundleArtifact.text),
      authorization: resumed,
    }));
    return;
  }
  if (
    existing.length !== 2 ||
    !existing.some((item) => item.role === 'primary') ||
    !existing.some((item) => item.role === 'secondary') ||
    reviewInput.value.reviewCandidates.length !== 46 ||
    primary.value.header.role !== 'primary' ||
    secondary.value.header.role !== 'secondary' ||
    !/^[a-f0-9]{64}$/u.test(primary.value.header.artifactSha256) ||
    !/^[a-f0-9]{64}$/u.test(secondary.value.header.artifactSha256)
  ) {
    throw new Error('裁定authorizationの前提tupleが不正です');
  }
  const differences = reviewInput.value.reviewCandidates.flatMap((reviewCandidate, order) => {
    const first = primary.value.judgments.find((item) => item.candidateId === reviewCandidate.candidateId);
    const second = secondary.value.judgments.find((item) => item.candidateId === reviewCandidate.candidateId);
    if (!first || !second) throw new Error('sealed judgmentが候補全集合を覆っていません');
    return canonicalJson(first) === canonicalJson(second)
      ? []
      : [{
          order,
          candidateId: reviewCandidate.candidateId,
          primary: first,
          secondary: second,
        }];
  });
  if (differences.length === 0) throw new Error('裁定対象差分がありません');
  const prompt = {
    schemaVersion: '1.0.0',
    kind: 'f004-independent-adjudication-prompt',
    feature: 'F004',
    batchId: 'F004',
    workId: WORK_ID,
    role: 'adjudicator',
    producerTaskPath: '/root/f004_t056_adjudicator',
    runId: 'adjudicator-000466-20260728-01',
    candidatePath: CANDIDATE_PATH,
    candidateSha256: sha256(candidate.text),
    primarySealPath: PRIMARY_SEAL_PATH,
    primaryArtifactSha256: primary.value.header.artifactSha256,
    primaryFileSha256: sha256(primary.text),
    secondarySealPath: SECONDARY_SEAL_PATH,
    secondaryArtifactSha256: secondary.value.header.artifactSha256,
    secondaryFileSha256: sha256(secondary.text),
    outputPath: `.cache/f004-review/${WORK_ID}-adjudicator.json`,
    differences,
    instruction: '候補46件を裁定し、差分3件は本文文脈からspeaker表記を一つ選ぶ。agreement候補も全集合としてexact出力する。',
    decisions: ['approved', 'rejected', 'ambiguous'],
    approvedReasonCodes: ['SPOKEN_DIALOGUE', 'INNER_MONOLOGUE'],
    rejectedReasonCodes: [
      'QUOTED_MATERIAL',
      'EXPRESSION_EXAMPLE',
      'NON_SPEECH',
      'EXTRACTION_ARTIFACT',
      'POLICY_EXCLUDED',
    ],
  };
  await writeJsonArtifactAtomic(
    workspace,
    join(resolve(workspace), ...PROMPT_PATH.split('/')),
    prompt,
  );
  const authorizationValue: ReviewRunAuthorization = {
    authorizationId: `f004-${WORK_ID}-adjudicator`,
    role: 'adjudicator',
    producerTaskPath: '/root/f004_t056_adjudicator',
    judgeRole: 'adjudicator',
    runId: 'adjudicator-000466-20260728-01',
    candidateSetSha256: reviewInput.value.reviewCandidateSetSha256,
    policySha256: sha256(policy),
    promptSha256: sha256(canonicalJson(prompt)),
    toolSha256: sha256(tool),
    nonce: `f004-${WORK_ID}-adjudicator-20260728-01-nonce`,
    issuedAt: new Date().toISOString(),
    inputRefs: [
      { kind: 'candidateSet', path: CANDIDATE_PATH, sha256: sha256(candidate.text) },
      { kind: 'policy', path: POLICY_PATH, sha256: sha256(policy) },
      { kind: 'prompt', path: PROMPT_PATH, sha256: sha256(canonicalJson(prompt)) },
      { kind: 'tool', path: TOOL_PATH, sha256: sha256(tool) },
      {
        kind: 'primaryJudgment',
        path: `seals/f004-${WORK_ID}-primary.json`,
        sha256: primary.value.header.artifactSha256,
      },
      {
        kind: 'secondaryJudgment',
        path: `seals/f004-${WORK_ID}-secondary.json`,
        sha256: secondary.value.header.artifactSha256,
      },
    ],
    candidates: reviewInput.value.reviewCandidates,
  };
  const authorization = Object.freeze(authorizationValue);
  const nextBundle = {
    ...bundleArtifact.value,
    authorizations: [...existing, authorization],
  };
  await writeJsonArtifactAtomic(
    workspace,
    join(resolve(workspace), ...BUNDLE_PATH.split('/')),
    nextBundle,
  );
  await registerF004ReviewAuthorizations(workspace, [authorization]);
  process.stdout.write(canonicalJson({
    ok: true,
    bundlePath: BUNDLE_PATH,
    bundleSha256: sha256(canonicalJson(nextBundle)),
    promptPath: PROMPT_PATH,
    promptSha256: authorization.promptSha256,
    differences: differences.map((item) => item.candidateId),
    authorization,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
