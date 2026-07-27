import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  loadAndVerifyEditorialJudgmentSets,
  type EditorialResolutionSet,
} from '../src/content/editorial-independent.ts';
import { bridgeEditorialResolutionSetToReviewRecords } from '../src/content/f003-review-acceptance.ts';
import {
  compileF004SpeechRevisions,
  reconcileF004Judgments,
  type F004CandidateSet,
  type F004SpeechRevision,
} from '../src/content/f004-editorial.ts';
import { applyWorkReviews } from '../src/content/processing.ts';

const WORK_ID = '000466';
const REVIEW_INPUT_PATH = `content/batches/F004/review-inputs/${WORK_ID}.json`;
const RECONCILIATION_PATH =
  `content/batches/F004/work-artifacts/${WORK_ID}/review-reconciliation.json`;
const REVIEW_RECORDS_PATH = `content/batches/F004/reviews/${WORK_ID}.json`;
const SPEECH_ITEMS_PATH =
  `content/batches/F004/work-artifacts/${WORK_ID}/speech-items.json`;
const REVISION_PATH = `content/batches/F004/speech-revisions/${WORK_ID}.json`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function optionalRevisions(workspace: string): Promise<readonly F004SpeechRevision[]> {
  try {
    const artifact = await canonicalArtifact<{
      schemaVersion: '1.0.0';
      batchId: 'F004';
      workId: string;
      revisions: readonly F004SpeechRevision[];
    }>(workspace, REVISION_PATH);
    if (
      artifact.value.schemaVersion !== '1.0.0' ||
      artifact.value.batchId !== 'F004' ||
      artifact.value.workId !== WORK_ID ||
      !Array.isArray(artifact.value.revisions)
    ) {
      throw new Error('speech revision artifactが不正です');
    }
    return artifact.value.revisions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [candidateArtifact, reconciliationArtifact, seals, revisions] = await Promise.all([
    canonicalArtifact<F004CandidateSet>(workspace, REVIEW_INPUT_PATH),
    canonicalArtifact<EditorialResolutionSet>(workspace, RECONCILIATION_PATH),
    loadAndVerifyEditorialJudgmentSets(workspace),
    optionalRevisions(workspace),
  ]);
  const primary = seals.find((item) => item.header.authorizationId === `f004-${WORK_ID}-primary`);
  const secondary = seals.find((item) => item.header.authorizationId === `f004-${WORK_ID}-secondary`);
  const adjudicator = seals.find((item) => item.header.authorizationId === `f004-${WORK_ID}-adjudicator`);
  if (!primary || !secondary || !adjudicator) throw new Error('trusted seal 3件が揃っていません');
  const recomputed = reconcileF004Judgments(
    candidateArtifact.value.reviewCandidates,
    primary,
    secondary,
    adjudicator,
  );
  if (canonicalJson(recomputed) !== reconciliationArtifact.text) {
    throw new Error('保存済みreconciliationがtrusted sealの再計算値と一致しません');
  }
  const reviewRecords = bridgeEditorialResolutionSetToReviewRecords(
    WORK_ID,
    recomputed,
    primary,
    secondary,
    adjudicator,
  );
  const reviewed = applyWorkReviews(WORK_ID, candidateArtifact.value.candidates, reviewRecords);
  if (
    reviewed.pending.length !== 0 ||
    reviewed.approved.length !== 44 ||
    reviewed.rejected.length !== 2
  ) {
    throw new Error('review recordsのpartitionが44/2/0ではありません');
  }
  const approvedIds = new Set(reviewed.approved.map((item) => item.candidate.candidateId));
  const approvedCandidates = candidateArtifact.value.candidates
    .filter((candidate) => approvedIds.has(candidate.candidateId));
  const speechItems = compileF004SpeechRevisions(approvedCandidates, revisions);
  await Promise.all([
    writeJsonArtifactAtomic(
      workspace,
      join(resolve(workspace), ...REVIEW_RECORDS_PATH.split('/')),
      reviewRecords,
    ),
    writeJsonArtifactAtomic(
      workspace,
      join(resolve(workspace), ...SPEECH_ITEMS_PATH.split('/')),
      speechItems,
    ),
  ]);
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    approved: reviewed.approved.length,
    rejected: reviewed.rejected.length,
    pending: reviewed.pending.length,
    revisionCount: revisions.length,
    reviewRecordsPath: REVIEW_RECORDS_PATH,
    reviewRecordsSha256: sha256(canonicalJson(reviewRecords)),
    speechItemsPath: SPEECH_ITEMS_PATH,
    speechItemsSha256: sha256(canonicalJson(speechItems)),
    speechItemCount: speechItems.length,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
