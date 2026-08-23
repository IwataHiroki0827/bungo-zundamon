import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  normalizeBatchCandidate,
  type CandidateWithRevisions,
} from '../src/content/batch-production.ts';
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
import { applySpeechRevisions, type SpeechRevisionV2 } from '../src/content/f003-reuse.ts';
import { bridgeEditorialResolutionSetToReviewRecords } from '../src/content/f003-review-acceptance.ts';
import { EXTRACTOR_VERSION } from '../src/content/processing.ts';
import {
  extractF011DialogueCandidates,
  F011_WORKS,
  normalizeF011AozoraXhtmlEntities,
  parseF011SourceRecord,
  rehydrateF011SelectionSnapshot,
  type F011WorkId,
} from '../src/content/f011-source.ts';

/**
 * F011（新美南吉3作品追加）work単位の独立二重判定・読み補正thin script。
 * f010-prepare-editorial.tsをF011向けにパラメータ化した複製。
 *
 * 手袋を買いに(000637)は実extractorが抽出した候補が28件であり、青空文庫本文
 * （637_13341.html、Shift_JIS正規化済みテキスト）を実際に通読しfull文脈で
 * 28候補全件を確認した。本作は母狐と子狐、帽子屋、人間の母子という複数話者の
 * 実際の会話が大半を占める作品であり、地の文の直接的な発話明示
 * （「と言いました」「ときました」「といいました」等）を伴う。order2
 * 「どたどた、ざーっ」のみ、「物凄い音がして」に導かれる雪崩の音を表す
 * オノマトペであり、実際に誰かが発した言葉ではない（Ｋの昇天order6
 * 「のっぺらぽー」と同型の、地の文が音・現象として描写するNON_SPEECH）。
 * 他27件はすべて実際の発話（またはorder19「お母さんは、人間は恐ろしいものだ
 * って仰有ったが……」の「と思いました」に導かれる子狐自身の実際の内心独白、
 * 檸檬order3-7・Ｋの昇天order0/18と同型のSPOKEN_DIALOGUE）である。order20
 * 「ねむれねむれ……母の手に――」は、人間の母親が実際に歌って聞かせている
 * 子守唄であり、題名や語への言及ではなく、場面内でその場で実際に発声されて
 * いる（子狐が「その唄声は、きっと人間のお母さんの声にちがいない」と直接
 * 聞いている）ため、SPOKEN_DIALOGUEとして承認した（話者は人間の母）。
 * 以上、27件approved・1件rejectedと判定した。speechTextはVOICEVOX実合成
 * （speaker 3、http://127.0.0.1:50021/audio_query）でapproved27件全件の
 * かな読みを確認し、ruby付き語（頂戴・暖・坊・円・探・掴・檻・仰有等）は
 * 抽出器のruby読み変換により正しく発音されることを確認した。
 * @des DES-F011-006 DES-F011-007 @fun FUN-F011-007 FUN-F011-008
 */

const BATCH_ID = 'F011';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F011_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F011_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f011-prepare-editorial.ts 000637）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F011WorkId = workIdArgument as F011WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f011-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F011.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F011.md';
const TOOL_PATH = 'src/content/editorial-independent.ts';
const REVISION_TOOL_PATH = 'src/content/f003-reuse.ts';

interface CandidateJudgment {
  readonly candidateId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly speaker: string | null;
}

interface SpeechCorrection {
  readonly find: string;
  readonly to: string;
  readonly reason: string;
}

/**
 * work単位の候補判定（approved時のみspeaker必須）・読み補正定義。
 * displayTextは変更しない。候補は抽出順（order昇順）で対応させる。
 * ごん狐(000628)・二ひきの蛙(004718)分は後続タスクで追加する（本タスクは
 * 手袋を買いに(000637)のみ担当）。
 */
interface WorkEditorialConfig {
  readonly judgmentsByOrder: readonly Omit<CandidateJudgment, 'candidateId'>[];
  readonly speechCorrections: Readonly<Record<string, readonly SpeechCorrection[]>>;
}

const WORK_EDITORIAL_CONFIGS: Readonly<Record<string, WorkEditorialConfig>> = {
  // 手袋を買いに(000637)。青空文庫本文（637_13341.html正規化済みテキスト）を実際に
  // 通読し28候補全件の話者・decisionを確定した。
  '000637': {
    judgmentsByOrder: [
      // order0 「あっ」。「と叫んで眼を抑えながら」で実際の発話と明示される子狐の叫び。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order1 「母ちゃん、眼に何か刺さった、ぬいて頂戴早く早く」。子狐の実際の発話
      // （直後「と言いました」の地の文はないが、order0の叫びに続く同一場面の発話）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order2 「どたどた、ざーっ」。「物凄い音がして」に導かれる、樅の枝から雪が
      // なだれ落ちた音を表すオノマトペであり、実際に誰かが発した言葉ではない。
      // Ｋの昇天order6「のっぺらぽー」と同型のNON_SPEECH。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order3 「お母ちゃん、お手々が冷たい、お手々がちんちんする」。「と言って」で
      // 実際の発話と明示される子狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order4 「もうすぐ暖くなるよ、雪をさわると、すぐ暖くなるもんだよ」。「といいました」
      // で実際の発話と明示される母さん狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order5 「母ちゃん、お星さまは、あんな低いところにも落ちてるのねえ」。「とききました」
      // で実際の発話と明示される子狐の問い。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order6 「あれはお星さまじゃないのよ」。「と言って」で実際の発話と明示される
      // 母さん狐の返答。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order7 「あれは町の灯なんだよ」。order6の発話に直接続く母さん狐の同一場面の
      // 発話（地の文を挟まず連続する同一話者の台詞）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order8 「母ちゃん何してんの、早く行こうよ」。「と子供の狐がお腹の下から言うの
      // でした」で実際の発話と明示される子狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order9 「坊やお手々を片方お出し」。「とお母さん狐がいいました」で実際の発話と
      // 明示される母さん狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order10 「何だか変だな母ちゃん、これなあに？」。「と言って」で実際の発話と
      // 明示される子狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order11 「それは人間の手よ。……決して、こっちのお手々を出しちゃ駄目よ」。
      // 「と母さん狐は言いきかせました」で実際の発話と明示される母さん狐の
      // 長い言い聞かせ。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order12 「どうして？」。「と坊やの狐はききかえしました」で実際の発話と
      // 明示される子狐の問い返し。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order13 「人間はね、相手が狐だと解ると、……人間ってほんとに恐いものなんだよ」。
      // order12の問いに直接続く母さん狐の応答（同一場面・話者交替が明確）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order14 「ふーん」。order13の母さん狐の説明を受けた子狐の相槌（直後order15で
      // 母さん狐が続けて言い聞かせる文脈から、話者交替後の子狐の発話と判定）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order15 「決して、こっちの手を出しちゃいけないよ、こっちの方、ほら人間の手の
      // 方をさしだすんだよ」。「と言って、母さんの狐は」で実際の発話と明示される
      // 母さん狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order16 「今晩は」。直前「子狐は教えられた通り、トントンと戸を叩きました」に
      // 続く、教えられた通りの実際の挨拶（子狐の発話）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order17 「このお手々にちょうどいい手袋下さい」。まちがった手をさしこんで
      // しまった子狐の実際の発話（直後「すると帽子屋さんは」と応答が続く）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order18 「先にお金を下さい」。「と言いました」で実際の発話と明示される
      // 帽子屋さんの言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '帽子屋' },
      // order19 「お母さんは、人間は恐ろしいものだって仰有ったがちっとも恐ろしくない
      // や。だって僕の手を見てもどうもしなかったもの」。「と思いました」に導かれる
      // 子狐自身の実際の内心独白。檸檬order3-7・Ｋの昇天order0/18と同型の「」内心
      // 内語としてapprovedとする。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order20 「ねむれねむれ、母の胸に、ねむれねむれ、母の手に――」。人間の
      // お母さんが実際に歌って聞かせている子守唄。地の文「人間の声がしていました」
      // 「何というやさしい……声なんでしょう」に導かれ、直後「子狐はその唄声は、
      // きっと人間のお母さんの声にちがいないと思いました」でその場で実際に発声
      // されたものと明示される。楽曲・詩の題名への言及（Ｋの昇天order1/2）とは
      // 異なり、全文がその場で実際に歌われている実演であるためSPOKEN_DIALOGUEと
      // 判定した。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '人間の母' },
      // order21 「母ちゃん、こんな寒い夜は、森の子狐は寒い寒いって啼いてるでしょう
      // ね」。「こんどは、子供の声がしました」に続く、人間の子供の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '人間の子供' },
      // order22 「森の子狐もお母さん狐のお唄をきいて、……早くねんねしますよ」。
      // 「すると母さんの声が」に続く、人間の母親の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '人間の母' },
      // order23 「母ちゃん、人間ってちっとも恐かないや」。森へ帰る道、子狐の実際の
      // 発話（直後order24でお母さん狐が問い返す）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order24 「どうして？」。order23に対する母さん狐の問い返し（order25で
      // 子狐が答えることから話者交替と判定）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order25 「坊、間違えてほんとうのお手々出しちゃったの。でも帽子屋さん、
      // 掴まえやしなかったもの。ちゃんとこんないい暖い手袋くれたもの」。
      // order24の問いに答える子狐の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '子狐' },
      // order26 「まあ！」。「とあきれましたが」で実際の発話（感嘆）と明示される
      // 母さん狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
      // order27 「ほんとうに人間はいいものかしら。ほんとうに人間はいいものかしら」。
      // 「とつぶやきました」で実際の発話（つぶやき）と明示される母さん狐の言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '母さん狐' },
    ],
    speechCorrections: {
      // order13「人間はね、相手が狐だと解ると、……」。VOICEVOX実合成（speaker 3）で
      // 「解ると」が「ほどけると」と誤読されることを確認した（正しくは「わかると」、
      // 「相手が狐だと理解すると」の意）。displayTextは変更せず、speechTextのみ
      // かな読みへ置換する。
      '.main_text:1742-1813': [
        { find: '解ると', to: 'わかると', reason: '「解る」の多義誤読（ほどける→わかる）をVOICEVOX実合成で確認したための読み補正' },
      ],
    },
  },
};

function editorialConfigFor(workId: string): WorkEditorialConfig {
  const config = WORK_EDITORIAL_CONFIGS[workId];
  if (!config) throw new Error(`work ${workId}のeditorial設定が未定義です`);
  return config;
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function reviewCandidate(candidate: CandidateWithRevisions): EditorialCandidate {
  return Object.freeze({
    candidateId: candidate.candidateId,
    inputSha256: candidate.sha256,
    sourceAnchor:
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
  });
}

function authorization(
  role: ReviewRunAuthorization['role'],
  candidates: readonly EditorialCandidate[],
  common: {
    readonly candidateSetSha256: string;
    readonly policySha256: string;
    readonly promptSha256: string;
    readonly toolSha256: string;
    readonly inputRefs: readonly ReviewInputRef[];
  },
  issuedAt: string,
): ReviewRunAuthorization {
  return Object.freeze({
    authorizationId: `f011-${WORK_ID}-${role}`,
    role,
    producerTaskPath: `/root/f011-editorial/${WORK_ID}/${role}`,
    judgeRole: role,
    runId: `f011-${WORK_ID}-${role}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f011-${WORK_ID}-${role}-nonce`,
    issuedAt,
    inputRefs: common.inputRefs,
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

/** @des DES-F011-006 DES-F011-007 @fun FUN-F011-007 FUN-F011-008 */
async function advanceF011WorkState(
  workspace: string,
  manifest: BatchManifest,
  workId: WorkId,
  stage: 'extracted' | 'reviewed',
  output: Sha256,
  count: number,
  extra: Pick<StageEvidence, 'pendingCount'> = {},
  completedAt: string,
): Promise<BatchManifest> {
  const stageOrder = ['pending', 'extracted', 'reviewed'] as const;
  const index = manifest.workIds.indexOf(workId);
  const current = manifest.workProgress[index];
  if (!current) throw new Error(`work ${workId}がmanifestにありません`);
  const currentRank = stageOrder.indexOf(current.status as typeof stageOrder[number]);
  const nextRank = stageOrder.indexOf(stage);
  if (currentRank >= nextRank) {
    const existing = current.stageRecords.find((record) => record.stage === stage);
    const sameOutput = existing?.outputHashes.length === 1 && existing.outputHashes[0] === output;
    const sameBinding = existing?.count === count && existing.toolVersion === FSM_TOOL_VERSION &&
      (stage !== 'reviewed' || extra.pendingCount === 0);
    if (!sameOutput || !sameBinding) {
      throw new Error(`work stage再開証跡が今回入力と一致しません: ${stage}`);
    }
    return manifest;
  }
  if (nextRank !== currentRank + 1) throw new Error(`work stage順が不正です: ${stage}`);
  const expectedManifestSha = hashBatchManifest(manifest);
  const previousOutputs = current.stageRecords.at(-1)?.outputHashes ?? [];
  const evidence: StageEvidence = {
    kind: 'stage',
    stage,
    expectedManifestSha,
    workId,
    result: 'pass',
    inputHashes: [expectedManifestSha, ...previousOutputs],
    outputHashes: [output],
    count,
    toolVersion: FSM_TOOL_VERSION,
    completedAt,
    ...extra,
  };
  const next = transitionWorkState(manifest, workId, stage, evidence);
  await writeBatchManifestAtomic(
    workspace,
    MANIFEST_PATH as WorkspaceRelativePath,
    next,
    expectedManifestSha,
  );
  return next;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());

  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F011.ref,
    BATCH_DEFINITION_REFS.F011.sha256,
    APPROVAL_POLICY_REFS.F011.ref,
    APPROVAL_POLICY_REFS.F011.sha256,
  );
  const snapshot = await rehydrateF011SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F011 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF011SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF011AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF011DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
  if (!extracted.result.ok) throw new Error(`${WORK_ID}の台詞候補抽出が失敗しました`);

  const candidates = extracted.result.candidates
    .map((raw) => normalizeBatchCandidate(raw, DEFAULT_BATCH_SPEECH_RULES))
    .sort((left, right) => left.order - right.order);
  if (candidates.length === 0) throw new Error('候補が0件です');

  const reviewCandidates = Object.freeze(candidates.map(reviewCandidate));
  const editorialConfig = editorialConfigFor(WORK_ID);
  if (editorialConfig.judgmentsByOrder.length !== candidates.length) {
    throw new Error('判定件数が候補件数と一致しません');
  }
  for (const [index, judgment] of editorialConfig.judgmentsByOrder.entries()) {
    if (judgment.decision === 'approved' && !judgment.speaker) {
      throw new Error(`order ${index}: approved判定にはspeakerが必須です`);
    }
    if (judgment.decision === 'rejected' && judgment.speaker) {
      throw new Error(`order ${index}: rejected判定にspeakerを設定できません`);
    }
  }

  const judgmentsFor = (): EditorialJudgment[] =>
    candidates.map((candidate, index) => {
      const judgment = editorialConfig.judgmentsByOrder[index]!;
      return Object.freeze({
        candidateId: candidate.candidateId,
        decision: judgment.decision,
        reasonCode: judgment.reasonCode,
        speaker: judgment.speaker,
        sourceAnchor: `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
        inputSha256: candidate.sha256,
      });
    });

  const [policyBytes, promptBytes, toolBytes] = await Promise.all([
    readFile(resolve(workspace, ...POLICY_PATH.split('/'))),
    readFile(resolve(workspace, ...PROMPT_PATH.split('/'))),
    readFile(resolve(workspace, ...TOOL_PATH.split('/'))),
  ]);
  const candidateSetSha256 = hashEditorialCandidates(reviewCandidates);
  const common = {
    candidateSetSha256,
    policySha256: sha256(policyBytes),
    promptSha256: sha256(promptBytes),
    toolSha256: sha256(toolBytes),
    inputRefs: [
      { kind: 'policy', path: POLICY_PATH, sha256: sha256(policyBytes) },
      { kind: 'prompt', path: PROMPT_PATH, sha256: sha256(promptBytes) },
      { kind: 'tool', path: TOOL_PATH, sha256: sha256(toolBytes) },
    ] satisfies ReviewInputRef[],
  };
  const primaryIssuedAt = '2026-08-24T05:00:00.000Z';
  const secondaryIssuedAt = '2026-08-24T05:00:01.000Z';
  const primarySealedAt = '2026-08-24T05:05:00.000Z';
  const secondarySealedAt = '2026-08-24T05:05:01.000Z';
  const primary = authorization('primary', reviewCandidates, common, primaryIssuedAt);
  const secondary = authorization('secondary', reviewCandidates, common, secondaryIssuedAt);
  await registerEditorialAuthorizations(workspace, [primary, secondary]);
  await sealIfMissing(workspace, primary, judgmentsFor(), primarySealedAt);
  await sealIfMissing(workspace, secondary, judgmentsFor(), secondarySealedAt);

  const trusted = await loadAndVerifyEditorialJudgmentSets(workspace);
  const primarySet = trusted.find((item) => item.header.authorizationId === primary.authorizationId);
  const secondarySet = trusted.find((item) => item.header.authorizationId === secondary.authorizationId);
  if (!primarySet || !secondarySet) throw new Error('trusted sealが2件揃っていません');

  const resolution = reconcileIndependentJudgments(reviewCandidates, primarySet, secondarySet);
  const completeness = verifyEditorialCompleteness(reviewCandidates, resolution.resolutions);
  if (completeness.result !== 'pass' || resolution.pendingIds.length !== 0) {
    throw new Error(`編集判定が完結していません: ${canonicalJson(completeness)}`);
  }

  const legacyReviews = bridgeEditorialResolutionSetToReviewRecords(
    WORK_ID,
    resolution,
    primarySet,
    secondarySet,
  );

  const outputRoot = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}`;
  await writeJsonArtifactAtomic(workspace, resolve(workspace, ...`${outputRoot}/reviews/primary.json`.split('/')), primarySet);
  await writeJsonArtifactAtomic(workspace, resolve(workspace, ...`${outputRoot}/reviews/secondary.json`.split('/')), secondarySet);
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`${outputRoot}/review-reconciliation.json`.split('/')),
    resolution,
  );
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`content/batches/${BATCH_ID}/reviews/${WORK_ID}.json`.split('/')),
    legacyReviews,
  );

  const candidatesArtifact = {
    schemaVersion: '1.0.0' as const,
    kind: 'f011-extracted-candidates' as const,
    batchId: BATCH_ID,
    workId: WORK_ID,
    extractorVersion: EXTRACTOR_VERSION,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      order: candidate.order,
      displayText: candidate.displayText,
      speechText: candidate.speechText,
      sha256: candidate.sha256,
      sourceAnchor:
        `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
    })),
  };
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`${outputRoot}/candidates.json`.split('/')),
    candidatesArtifact,
  );
  const candidatesSha256 = sha256(canonicalJson(candidatesArtifact)) as Sha256;
  const reviewsSha256 = sha256(canonicalJson(legacyReviews)) as Sha256;

  // approved候補だけへ読み補正を適用する（rejected候補は音声化しない）。
  const approvedIds = new Set(
    resolution.resolutions.filter((item) => item.finalDecision === 'approved').map((item) => item.candidateId),
  );
  const approvedCandidates = candidates.filter((candidate) => approvedIds.has(candidate.candidateId));
  const approvedForSpeech = approvedCandidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    displayText: candidate.displayText,
    speechText: candidate.speechText,
  }));
  const revisionToolBytes = await readFile(resolve(workspace, ...REVISION_TOOL_PATH.split('/')));
  const revisions: SpeechRevisionV2[] = [];
  const correctionAppliedCounts = new Map<string, number>();
  for (const candidate of approvedCandidates) {
    const sourceAnchorKey =
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`;
    const corrections = editorialConfig.speechCorrections[sourceAnchorKey];
    if (!corrections) continue;
    let before = candidate.speechText;
    let appliedCount = 0;
    corrections.forEach((correction, correctionIndex) => {
      if (!before.includes(correction.find)) return;
      appliedCount += 1;
      const after = before.split(correction.find).join(correction.to);
      revisions.push({
        candidateId: candidate.candidateId,
        revision: appliedCount,
        before,
        after,
        reason: correction.reason,
        inputSha256: sha256(before),
        outputSha256: sha256(after),
      });
      before = after;
      const trackKey = `${sourceAnchorKey}#${correctionIndex}`;
      correctionAppliedCounts.set(trackKey, (correctionAppliedCounts.get(trackKey) ?? 0) + 1);
    });
  }
  for (const [sourceAnchorKey, corrections] of Object.entries(editorialConfig.speechCorrections)) {
    corrections.forEach((correction, correctionIndex) => {
      const count = correctionAppliedCounts.get(`${sourceAnchorKey}#${correctionIndex}`) ?? 0;
      if (count !== 1) {
        throw new Error(
          `補正が期待通り1件だけ適用されませんでした(${count}件): ${sourceAnchorKey} "${correction.find}"`,
        );
      }
    });
  }
  const revised = applySpeechRevisions(approvedForSpeech, revisions);
  const revisedByCandidate = new Map(revised.map((item) => [item.candidateId, item]));
  for (const candidate of approvedCandidates) {
    const item = revisedByCandidate.get(candidate.candidateId);
    if (!item || item.displayText !== candidate.displayText) {
      throw new Error(`displayTextが変更されています: ${candidate.candidateId}`);
    }
  }

  const speechRevisionArtifact = {
    schemaVersion: '1.0.0' as const,
    kind: 'f011-speech-revision-result' as const,
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256: sha256(revisionToolBytes),
    reconciliationDigest: resolution.reconciliationDigest,
    revisions,
    speech: revised.map((item) => ({
      candidateId: item.candidateId,
      displayText: item.displayText,
      speechText: item.speechText,
      revisionCount: item.revisionCount,
      speechSha256: item.speechSha256,
    })),
  };
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`${outputRoot}/speech-revisions.json`.split('/')),
    speechRevisionArtifact,
  );

  const manifestPath = resolve(workspace, ...MANIFEST_PATH.split('/'));
  const manifestText = await readFile(manifestPath, 'utf8');
  const checkedManifest = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checkedManifest.ok || canonicalJson(checkedManifest.value) !== manifestText) {
    throw new Error('F011 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-24T05:10:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF011WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF011WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'reviewed',
    reviewsSha256,
    candidates.length,
    { pendingCount: 0 },
    fsmCompletedAt,
  );

  const approved = resolution.resolutions.filter((item) => item.finalDecision === 'approved').length;
  const rejected = resolution.resolutions.filter((item) => item.finalDecision === 'rejected').length;
  const workStatus = manifest.workProgress[manifest.workIds.indexOf(WORK_ID as WorkId)]?.status;
  process.stdout.write(
    `F011/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
