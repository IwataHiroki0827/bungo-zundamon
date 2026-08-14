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
import {
  F005_WORKS,
  type F005CandidateSet,
  type F005WorkId,
} from '../src/content/f005-source.ts';

const MODE = process.argv[2];
if (MODE !== 'prepare' && MODE !== 'seal') {
  throw new Error('modeはprepareまたはsealです');
}
// CHG-F005-073: レビュー工程は作品ごとに実施する。作品固有の値
// (判定基準・speaker語彙・authorization有効期間) をここに集約し、
// 手続き部分は全作品で共有する。
interface F005ReviewWorkConfig {
  readonly reviewDate: string;
  readonly fixedNow: string;
  readonly expiresAt: string;
  readonly prompt: string;
  readonly template: string;
  readonly extraPromptByRun?: Readonly<Record<string, string>>;
}

const REVIEW_WORKS: Readonly<Record<string, F005ReviewWorkConfig>> = {
  '000799': {
    reviewDate: '20260729',
    fixedNow: '2026-07-29T06:00:00.000Z',
    expiresAt: '2026-08-05T06:00:00.000Z',
    prompt:
      '夢十夜の台詞候補を全件、他reviewerの結果を見ず独立判定する。speakerは共有canonical語彙を使い、' +
      '「聞く・答える・云う・唄う」と明示された回想・習慣発話は実台詞、教えた語句・覚えた語句だけの提示は表現例とする。',
    template:
      '{candidateId,inputSha256,sourceAnchor,decision,reasonCode,speaker}を候補順に返す。' +
      'speaker語彙:女,自分,背中の子供,父,老人,庄太郎,香具師,見物人,運慶,乗客,船の男,床屋,客,母,子供。',
    extraPromptByRun: {
      '03': ' source文脈から固定したorder→speaker写像を独立照合する: ' +
        '0-3=女;4=自分;5,7,8,10,12-16,18,19,21-23,25,26=背中の子供;' +
        '6,9,11,17,20,24=父;27,29,31,33=女;28,30,32=老人;34-40=香具師;' +
        '41-48=見物人;49,51=乗客;50,52=船の男;53=客;54-55=床屋;' +
        '56,58,62,64=母;57,59,63=子供;60-61はEXPRESSION_EXAMPLEでspeaker=null。',
    },
  },
  '001076': {
    reviewDate: '20260814',
    fixedNow: '2026-08-14T06:00:00.000Z',
    expiresAt: '2026-08-21T06:00:00.000Z',
    prompt:
      '倫敦塔の台詞候補を全件、他reviewerの結果を見ず独立判定する。' +
      '人物が実際に発した発話のみSPOKEN_DIALOGUEで承認し、speakerを共有canonical語彙から選ぶ。' +
      '地の文が語句を引用しただけのもの(作品名「塔」「ロンドン塔」)、壁に刻まれた題辞、' +
      '署名はEXPRESSION_EXAMPLEとして却下しspeakerはnullとする。' +
      '幻想場面の人物も実際の発話であれば承認する。' +
      '同名で別人となる女性は、王子らの母を「女」、余を案内する現代の女性を「怪しい女」、' +
      'ジェーン・グレーを「ジェーン」として区別する。',
    template:
      '{candidateId,inputSha256,sourceAnchor,decision,reasonCode,speaker}を候補順に返す。' +
      'decisionはapproved/rejected。reasonCodeはSPOKEN_DIALOGUEまたはEXPRESSION_EXAMPLE。' +
      'speaker語彙:兄,弟,女,牢守,高き影,低き影,ヘンリー,ある者,ビーフ・イーター,小供,' +
      '怪しい女,髯,磨ぎ手,ジェーン,坊さん,ガイフォークス,主人。',
  },
  '001104': {
    reviewDate: '20260814',
    fixedNow: '2026-08-14T06:00:00.000Z',
    expiresAt: '2026-08-21T06:00:00.000Z',
    prompt:
      '趣味の遺伝の台詞候補を全件、他reviewerの結果を見ず独立判定する。' +
      '人物が実際に発した発話のみSPOKEN_DIALOGUEで承認し、speakerを共有canonical語彙から選ぶ。' +
      '浩一の日記・手帳の引用、手紙の引用など、書かれた文章を地の文が引用したものは' +
      'EXPRESSION_EXAMPLEとして却下しspeakerはnullとする。' +
      '冒頭の幻想場面の発話、および余が思わず口に出した言葉は実際の発話として承認する。',
    template:
      '{candidateId,inputSha256,sourceAnchor,decision,reasonCode,speaker}を候補順に返す。' +
      'decisionはapproved/rejected。reasonCodeはSPOKEN_DIALOGUEまたはEXPRESSION_EXAMPLE。' +
      'speaker語彙:神,犬共,余,腹の減った男,婦人,一人,御母さん,同僚,老人。',
  },
};

function resolveReviewWork(value: string): {
  readonly workId: F005WorkId;
  readonly config: F005ReviewWorkConfig;
} {
  const config = REVIEW_WORKS[value];
  if (!config || !F005_WORKS.some((work) => work.workId === value)) {
    throw new Error(`review設定のない作品IDです: ${value}`);
  }
  return { workId: value as F005WorkId, config };
}

const { workId: WORK_ID, config: WORK_CONFIG } =
  resolveReviewWork(process.argv[3] ?? '000799');
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
const FIXED_NOW = WORK_CONFIG.fixedNow;
const EXPIRES_AT = WORK_CONFIG.expiresAt;

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
    `f005-${WORK_ID}-primary-${WORK_CONFIG.reviewDate}-${REVIEW_RUN}`,
    `f005-${WORK_ID}-secondary-${WORK_CONFIG.reviewDate}-${REVIEW_RUN}`,
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
      runId: `source-producer-${WORK_ID}-01`,
    },
    candidateSet,
    WORK_ID,
    {
      principalId: 'codex-reviewer-primary',
      sessionId: 'f005-t070-primary',
      runId: `primary-${WORK_ID}-${WORK_CONFIG.reviewDate}-${REVIEW_RUN}`,
    },
    {
      principalId: 'codex-reviewer-secondary',
      sessionId: 'f005-t070-secondary',
      runId: `secondary-${WORK_ID}-${WORK_CONFIG.reviewDate}-${REVIEW_RUN}`,
    },
    {
      schemaVersion: '1.0.0',
      prompt: WORK_CONFIG.prompt +
        (WORK_CONFIG.extraPromptByRun?.[REVIEW_RUN] ?? ''),
      template: WORK_CONFIG.template,
      tool: 'Codex independent literary dialogue review',
    },
    `bungo-zundamon:F005:${WORK_ID}:editorial`,
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
