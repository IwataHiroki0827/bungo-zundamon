import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import {
  buildF005SpeechRevisions,
  createF005ReviewCoordinator,
  issueF005ReviewAuthorizations,
  reconcileF005PrimarySecondary,
  sealF005ReviewJudgment,
  type F005ReviewJudgment,
} from '../src/content/f005-review.ts';
import type { F005CandidateSet } from '../src/content/f005-source.ts';

const MODE = process.argv[2];
if (MODE !== 'prepare' && MODE !== 'seal') {
  throw new Error('modeはprepareまたはsealです');
}
const WORK_ID = '000799' as const;
const REVIEW_RUN = process.env.F005_REVIEW_RUN ?? '01';
if (!/^[0-9]{2}$/u.test(REVIEW_RUN)) throw new Error('F005_REVIEW_RUNは2桁です');
const CANDIDATE_PATH = `content/batches/F005/review-inputs/${WORK_ID}.json`;
const AUTHORIZATION_PATH =
  `content/batches/F005/review-inputs/${WORK_ID}-authorizations-${REVIEW_RUN}.json`;
const PRIMARY_INPUT_PATH =
  `.cache/f005-review/${WORK_ID}-primary-${REVIEW_RUN}.json`;
const SECONDARY_INPUT_PATH =
  `.cache/f005-review/${WORK_ID}-secondary-${REVIEW_RUN}.json`;
const REVIEW_ROOT = `content/batches/F005/work-artifacts/${WORK_ID}/reviews`;
const AGREEMENT_PATH =
  `content/batches/F005/work-artifacts/${WORK_ID}/review-agreement.json`;
const RECONCILIATION_PATH =
  `content/batches/F005/work-artifacts/${WORK_ID}/review-reconciliation.json`;
const REVISION_PATH = `content/batches/F005/speech-revisions/${WORK_ID}.json`;
const SPEECH_PATH =
  `content/batches/F005/work-artifacts/${WORK_ID}/speech-items.json`;
const FIXED_NOW = '2026-07-29T06:00:00.000Z';
const EXPIRES_AT = '2026-08-05T06:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<T> {
  const text = await readFile(resolve(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return value;
}

async function writeCanonical(workspace: string, path: string, value: unknown): Promise<void> {
  await writeJsonArtifactAtomic(workspace, resolve(workspace, ...path.split('/')), value);
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const contextRoot = await realpath(process.env.F005_CONTEXT_ROOT ?? workspace);
  const [context, candidateSet] = await Promise.all([
    loadVerifiedF005Definition(contextRoot),
    canonicalArtifact<F005CandidateSet>(workspace, CANDIDATE_PATH),
  ]);
  let nonceIndex = 0;
  const nonces = [
    `f005-000799-primary-20260729-${REVIEW_RUN}`,
    `f005-000799-secondary-20260729-${REVIEW_RUN}`,
  ];
  const coordinator = createF005ReviewCoordinator(context, {
    now: () => FIXED_NOW,
    nonce: () => nonces[nonceIndex++] ?? 'f005-review-nonce-overflow',
  });
  const authorizations = issueF005ReviewAuthorizations(
    coordinator,
    {
      principalId: 'codex-root',
      sessionId: 'f005-t070-production',
      runId: 'source-producer-000799-01',
    },
    candidateSet,
    WORK_ID,
    {
      principalId: 'codex-reviewer-primary',
      sessionId: 'f005-t070-primary',
      runId: `primary-000799-20260729-${REVIEW_RUN}`,
    },
    {
      principalId: 'codex-reviewer-secondary',
      sessionId: 'f005-t070-secondary',
      runId: `secondary-000799-20260729-${REVIEW_RUN}`,
    },
    {
      schemaVersion: '1.0.0',
      prompt:
        '夢十夜の台詞候補を全件、他reviewerの結果を見ず独立判定する。speakerは共有canonical語彙を使い、' +
        '「聞く・答える・云う・唄う」と明示された回想・習慣発話は実台詞、教えた語句・覚えた語句だけの提示は表現例とする。' +
        (REVIEW_RUN === '03'
          ? ' source文脈から固定したorder→speaker写像を独立照合する: ' +
            '0-3=女;4=自分;5,7,8,10,12-16,18,19,21-23,25,26=背中の子供;' +
            '6,9,11,17,20,24=父;27,29,31,33=女;28,30,32=老人;34-40=香具師;' +
            '41-48=見物人;49,51=乗客;50,52=船の男;53=客;54-55=床屋;' +
            '56,58,62,64=母;57,59,63=子供;60-61はEXPRESSION_EXAMPLEでspeaker=null。'
          : ''),
      template:
        '{candidateId,inputSha256,sourceAnchor,decision,reasonCode,speaker}を候補順に返す。' +
        'speaker語彙:女,自分,背中の子供,父,老人,庄太郎,香具師,見物人,運慶,乗客,船の男,床屋,客,母,子供。',
      tool: 'Codex independent literary dialogue review',
    },
    'bungo-zundamon:F005:000799:editorial',
    EXPIRES_AT,
  );
  const authorizationArtifact = {
    schemaVersion: '1.0.0',
    kind: 'f005-review-authorization-set',
    batchId: 'F005',
    workId: WORK_ID,
    candidatePath: CANDIDATE_PATH,
    candidateSha256: sha256(canonicalJson(candidateSet)),
    authorizations,
  };
  if (MODE === 'prepare') {
    await writeCanonical(workspace, AUTHORIZATION_PATH, authorizationArtifact);
    process.stdout.write(canonicalJson({
      ok: true,
      mode: MODE,
      path: AUTHORIZATION_PATH,
      setSha256: authorizations.setSha256,
      candidateCount: authorizations.primary.candidateBindings.length,
    }));
    return;
  }

  const persistedAuthorizations = await canonicalArtifact<unknown>(
    workspace,
    AUTHORIZATION_PATH,
  );
  if (canonicalJson(persistedAuthorizations) !== canonicalJson(authorizationArtifact)) {
    throw new Error('保存済みauthorization setを再現できません');
  }
  const [primaryJudgments, secondaryJudgments] = await Promise.all([
    canonicalArtifact<readonly F005ReviewJudgment[]>(workspace, PRIMARY_INPUT_PATH),
    canonicalArtifact<readonly F005ReviewJudgment[]>(workspace, SECONDARY_INPUT_PATH),
  ]);
  const primary = sealF005ReviewJudgment(
    authorizations.primary,
    primaryJudgments,
  );
  const secondary = sealF005ReviewJudgment(
    authorizations.secondary,
    secondaryJudgments,
  );
  const outcome = reconcileF005PrimarySecondary(
    context,
    candidateSet,
    primary,
    secondary,
    authorizations,
  );
  await Promise.all([
    writeCanonical(workspace, `${REVIEW_ROOT}/primary-${REVIEW_RUN}.json`, primary),
    writeCanonical(workspace, `${REVIEW_ROOT}/secondary-${REVIEW_RUN}.json`, secondary),
  ]);
  if (outcome.kind === 'Dispute') {
    await writeCanonical(
      workspace,
      `content/batches/F005/work-artifacts/${WORK_ID}/review-dispute.json`,
      outcome,
    );
    throw new Error(`独立reviewが不一致です: ${outcome.mismatchDigest}`);
  }
  const revisions = buildF005SpeechRevisions(outcome.reconciliation, []);
  const resolutionById = new Map(outcome.reconciliation.resolutions.map((item) => [
    item.candidateId,
    item,
  ]));
  const speechItems = revisions.items.map((item) => {
    const resolution = resolutionById.get(item.candidateId);
    if (!resolution || resolution.decision !== 'approved' || !resolution.speaker) {
      throw new Error(`approved resolutionがありません: ${item.candidateId}`);
    }
    return {
      candidateId: item.candidateId,
      workId: item.workId,
      displayText: item.displayText,
      speechText: item.speechText,
      speechSha256: item.speechSha256,
      approved: true as const,
      speaker: resolution.speaker,
      reasonCode: resolution.reasonCode,
    };
  });
  await Promise.all([
    writeCanonical(workspace, AGREEMENT_PATH, outcome),
    writeCanonical(workspace, RECONCILIATION_PATH, outcome.reconciliation),
    writeCanonical(workspace, REVISION_PATH, revisions),
    writeCanonical(workspace, SPEECH_PATH, speechItems),
  ]);
  process.stdout.write(canonicalJson({
    ok: true,
    mode: MODE,
    reviewRun: REVIEW_RUN,
    agreementSha256: outcome.agreementSha256,
    reconciliationSha256: outcome.reconciliation.reconciliationSha256,
    approvedCount: speechItems.length,
    rejectedCount: outcome.reconciliation.resolutions.length - speechItems.length,
    speechPath: SPEECH_PATH,
    speechSha256: sha256(canonicalJson(speechItems)),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
