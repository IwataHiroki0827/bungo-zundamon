import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../src/content/artifacts.ts';
import {
  hashEditorialCandidates,
  hashEditorialJudgmentArtifact,
  loadAndVerifyEditorialJudgmentSets,
  reconcileIndependentJudgments,
  registerEditorialAuthorizations,
  sealAndValidateEditorialJudgmentSet,
  verifyEditorialCompleteness,
  type EditorialCandidate,
  type EditorialJudgment,
  type EditorialJudgmentExternalResult,
  type EditorialJudgmentSet,
  type ReviewInputRef,
  type ReviewRunAuthorization,
} from '../src/content/editorial-independent.ts';
import { bridgeEditorialResolutionSetToReviewRecords } from '../src/content/f003-review-acceptance.ts';

const BATCH_ID = 'F003';
const WORK_IDS = ['000275', '001567', '000258'] as const;
const workArgument = process.argv[2] === '--work' ? process.argv[3] : process.argv[2];
if (!workArgument || !WORK_IDS.includes(workArgument as (typeof WORK_IDS)[number])) {
  throw new Error(`usage: node --experimental-transform-types scripts/f003-editorial.ts --work ${WORK_IDS.join('|')}`);
}
const WORK_ID = workArgument;
const WORK_INDEX = WORK_IDS.indexOf(WORK_ID as (typeof WORK_IDS)[number]);
const CANDIDATES_PATH =
  `data/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/intermediate/${WORK_ID}/candidates.json`;
const DECISION_ROOT = `.cache/f003-editorial/${WORK_ID}`;
const OUTPUT_ROOT = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}`;
const SHA256 = /^[a-f0-9]{64}$/u;

interface StoredCandidate {
  readonly candidateId: string;
  readonly sha256: string;
  readonly sourceAnchor: {
    readonly bodySelector: string;
    readonly startToken: number;
    readonly endToken: number;
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function workspacePath(workspace: string, logicalPath: string): string {
  const root = resolve(workspace);
  const target = resolve(root, ...logicalPath.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new Error(`workspace外のpathです: ${logicalPath}`);
  }
  return target;
}

async function readBytes(workspace: string, logicalPath: string): Promise<Uint8Array> {
  return readFile(workspacePath(workspace, logicalPath));
}

async function readJson<T>(workspace: string, logicalPath: string): Promise<T> {
  const bytes = await readBytes(workspace, logicalPath);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
}

async function writeCanonicalCreateOrSame(
  workspace: string,
  logicalPath: string,
  value: unknown,
): Promise<void> {
  const target = workspacePath(workspace, logicalPath);
  const bytes = new TextEncoder().encode(canonicalJson(value));
  await mkdir(dirname(target), { recursive: true });
  try {
    const current = await readFile(target);
    if (!current.equals(bytes)) throw new Error(`既存artifactが異なります: ${logicalPath}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

function authorization(
  role: ReviewRunAuthorization['role'],
  suffix: string,
  producerTaskPath: string,
  issuedAt: string,
  candidates: readonly EditorialCandidate[],
  common: {
    readonly candidateSetSha256: string;
    readonly policySha256: string;
    readonly promptSha256: string;
    readonly toolSha256: string;
    readonly inputRefs: readonly ReviewInputRef[];
  },
  extraRefs: readonly ReviewInputRef[] = [],
): ReviewRunAuthorization {
  return Object.freeze({
    authorizationId: `f003-${WORK_ID}-${suffix}`,
    role,
    producerTaskPath,
    judgeRole: role,
    runId: `f003-${WORK_ID}-${suffix}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f003-${WORK_ID}-${suffix}-nonce`,
    issuedAt,
    inputRefs: Object.freeze([...common.inputRefs, ...extraRefs]),
    candidates,
  });
}

function external(
  auth: ReviewRunAuthorization,
  judgments: EditorialJudgment[],
): EditorialJudgmentExternalResult {
  return {
    schemaVersion: '1.0.0',
    authorizationId: auth.authorizationId,
    role: auth.role,
    runId: auth.runId,
    candidateSetSha256: auth.candidateSetSha256,
    policySha256: auth.policySha256,
    promptSha256: auth.promptSha256,
    toolSha256: auth.toolSha256,
    judgments,
  };
}

function predictedArtifactSha(
  auth: ReviewRunAuthorization,
  judgments: readonly EditorialJudgment[],
  sealedAt: string,
): string {
  return hashEditorialJudgmentArtifact({
    schemaVersion: '1.0.0',
    header: {
      authorizationId: auth.authorizationId,
      role: auth.role,
      runId: auth.runId,
      candidateSetSha256: auth.candidateSetSha256,
      policySha256: auth.policySha256,
      promptSha256: auth.promptSha256,
      toolSha256: auth.toolSha256,
      sealedAt,
    },
    judgments,
  });
}

async function sealIfMissing(
  workspace: string,
  auth: ReviewRunAuthorization,
  judgments: EditorialJudgment[],
  sealedAt: string,
): Promise<EditorialJudgmentSet> {
  const expected = predictedArtifactSha(auth, judgments, sealedAt);
  const existing = (await loadAndVerifyEditorialJudgmentSets(workspace))
    .find((item) => item.header.authorizationId === auth.authorizationId);
  if (existing) {
    if (existing.header.artifactSha256 !== expected) {
      throw new Error(`${auth.role} sealが今回の判定と一致しません`);
    }
    return existing;
  }
  return sealAndValidateEditorialJudgmentSet(workspace, auth, external(auth, judgments), {
    now: () => sealedAt,
  });
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const rawCandidates = await readJson<StoredCandidate[]>(workspace, CANDIDATES_PATH);
  const candidates = Object.freeze(rawCandidates.map((candidate): EditorialCandidate => {
    if (!SHA256.test(candidate.sha256) || candidate.sourceAnchor.bodySelector !== '.main_text') {
      throw new Error(`candidate hash/anchorが不正です: ${candidate.candidateId}`);
    }
    return Object.freeze({
      candidateId: candidate.candidateId,
      inputSha256: candidate.sha256,
      sourceAnchor: `.main_text:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
    });
  }));
  const [primaryJudgments, secondaryJudgments, adjudicatorJudgments] = await Promise.all([
    readJson<EditorialJudgment[]>(workspace, `${DECISION_ROOT}/primary-decisions.json`),
    readJson<EditorialJudgment[]>(workspace, `${DECISION_ROOT}/secondary-decisions.json`),
    readJson<EditorialJudgment[]>(workspace, `${DECISION_ROOT}/adjudicator-decisions.json`),
  ]);
  const policyPath = 'docs/srs/SRS-F003.md';
  const promptPath = 'docs/tests/ut/UT-F003.md';
  const toolPath = 'src/content/editorial-independent.ts';
  const [candidateBytes, policyBytes, promptBytes, toolBytes] = await Promise.all([
    readBytes(workspace, CANDIDATES_PATH),
    readBytes(workspace, policyPath),
    readBytes(workspace, promptPath),
    readBytes(workspace, toolPath),
  ]);
  const common = {
    candidateSetSha256: hashEditorialCandidates(candidates),
    policySha256: sha256(policyBytes),
    promptSha256: sha256(promptBytes),
    toolSha256: sha256(toolBytes),
    inputRefs: [
      { kind: 'candidateSet', path: CANDIDATES_PATH, sha256: sha256(candidateBytes) },
      { kind: 'policy', path: policyPath, sha256: sha256(policyBytes) },
      { kind: 'prompt', path: promptPath, sha256: sha256(promptBytes) },
      { kind: 'tool', path: toolPath, sha256: sha256(toolBytes) },
    ] satisfies ReviewInputRef[],
  };
  const hour = String(8 + WORK_INDEX).padStart(2, '0');
  const primaryAt = `2026-07-26T${hour}:40:00.000Z`;
  const secondaryAt = `2026-07-26T${hour}:40:01.000Z`;
  const adjudicatorAt = `2026-07-26T${hour}:51:00.000Z`;
  const primary = authorization(
    'primary', 'primary', `/root/f003-editorial/${WORK_ID}/primary`, `2026-07-26T${hour}:34:00.000Z`,
    candidates, common,
  );
  const secondary = authorization(
    'secondary', 'secondary', `/root/f003-editorial/${WORK_ID}/secondary`, `2026-07-26T${hour}:34:01.000Z`,
    candidates, common,
  );
  const adjudicator = authorization(
    'adjudicator', 'adjudicator', `/root/f003-editorial/${WORK_ID}/adjudicator`, `2026-07-26T${hour}:45:00.000Z`,
    candidates, common,
    [
      {
        kind: 'primaryJudgment',
        path: `seals/${primary.authorizationId}.json`,
        sha256: predictedArtifactSha(primary, primaryJudgments, primaryAt),
      },
      {
        kind: 'secondaryJudgment',
        path: `seals/${secondary.authorizationId}.json`,
        sha256: predictedArtifactSha(secondary, secondaryJudgments, secondaryAt),
      },
    ],
  );
  await registerEditorialAuthorizations(workspace, [primary, secondary, adjudicator]);
  await sealIfMissing(workspace, primary, primaryJudgments, primaryAt);
  await sealIfMissing(workspace, secondary, secondaryJudgments, secondaryAt);
  await sealIfMissing(workspace, adjudicator, adjudicatorJudgments, adjudicatorAt);
  const trusted = await loadAndVerifyEditorialJudgmentSets(workspace);
  const primarySet = trusted.find((item) => item.header.authorizationId === primary.authorizationId);
  const secondarySet = trusted.find((item) => item.header.authorizationId === secondary.authorizationId);
  const adjudicatorSet = trusted.find((item) => item.header.authorizationId === adjudicator.authorizationId);
  if (!primarySet || !secondarySet || !adjudicatorSet) throw new Error('trusted sealが3件揃っていません');
  const resolution = reconcileIndependentJudgments(candidates, primarySet, secondarySet, adjudicatorSet);
  const completeness = verifyEditorialCompleteness(candidates, resolution.resolutions);
  if (completeness.result !== 'pass' || resolution.pendingIds.length !== 0) {
    throw new Error(`編集判定が完結していません: ${canonicalJson(completeness)}`);
  }
  const legacyReviews = bridgeEditorialResolutionSetToReviewRecords(
    WORK_ID,
    resolution,
    primarySet,
    secondarySet,
    adjudicatorSet,
  );
  await Promise.all([
    writeCanonicalCreateOrSame(workspace, `${OUTPUT_ROOT}/reviews/primary.json`, primarySet),
    writeCanonicalCreateOrSame(workspace, `${OUTPUT_ROOT}/reviews/secondary.json`, secondarySet),
    writeCanonicalCreateOrSame(workspace, `${OUTPUT_ROOT}/reviews/adjudication.json`, adjudicatorSet),
    writeCanonicalCreateOrSame(workspace, `${OUTPUT_ROOT}/review-reconciliation.json`, resolution),
    writeCanonicalCreateOrSame(
      workspace,
      `content/batches/${BATCH_ID}/reviews/${WORK_ID}.json`,
      legacyReviews,
    ),
  ]);
  const approved = resolution.resolutions.filter((item) => item.finalDecision === 'approved').length;
  const rejected = resolution.resolutions.filter((item) => item.finalDecision === 'rejected').length;
  process.stdout.write(`F003/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0\n`);
}

await main();
