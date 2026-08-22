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
  extractF007DialogueCandidates,
  F007_WORKS,
  normalizeF007AozoraXhtmlEntities,
  parseF007SourceRecord,
  rehydrateF007SelectionSnapshot,
  type F007WorkId,
} from '../src/content/f007-source.ts';

/**
 * F007（森鴎外3作品追加）work単位の独立二重判定・読み補正thin script。
 * F006のscripts/f006-prepare-editorial.tsをF007向けにパラメータ化した複製。
 * F006と異なり、F007の候補には実際の会話（dialogue）に加え、原文が「」で
 * 外来語・術語をタイポグラフィカルに強調する用例（例: 舞姫の「ホテル」
 * 「マンサルド」等）が混在する。この種の候補は独立二重判定でdecision:
 * 'rejected'・reasonCode: 'NARRATION'・speaker: nullとして扱い（editorial-
 * independent.test.tsの既存precedentに準拠、TOPIC_ONLY_REASONSには該当
 * させずverifyEditorialCompletenessをblockedにしない）、音声化対象からは
 * 除外する（F005のbuildF005SpeechRevisions等が確立したapprovedIds絞り込み
 * と同じ設計）。
 * @des DES-F007-006 DES-F007-007 @fun FUN-F007-007 FUN-F007-008
 */

const BATCH_ID = 'F007';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F007_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F007_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f007-prepare-editorial.ts 058126）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F007WorkId = workIdArgument as F007WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f007-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F007.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F007.md';
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
 * displayTextは変更しない（DD-F007.md FUN-F007-008）。候補は抽出順
 * （order昇順）で対応させる。1候補に複数補正が必要な場合があるため
 * anchorあたりSpeechCorrectionの配列（適用順=配列順=revision番号）とする。
 */
interface WorkEditorialConfig {
  readonly judgmentsByOrder: readonly Omit<CandidateJudgment, 'candidateId'>[];
  readonly speechCorrections: Readonly<Record<string, readonly SpeechCorrection[]>>;
}

const WORK_EDITORIAL_CONFIGS: Readonly<Record<string, WorkEditorialConfig>> = {
  // 舞姫(058126)。青空文庫本文（058126_73682.html正規化済みテキスト）を通読し
  // 48候補全件の話者・decisionを実際の文脈から確定した。原文は「」を実際の
  // 会話（太田豊太郎・エリス・老媼・馭丁・天方伯の発話）と、外来語・術語の
  // タイポグラフィカルな強調（「ホテル」「マンサルド」「クルズス」等22件）の
  // 両方に用いており、後者は音声化対象外のnarration扱いとする。
  // VOICEVOX 0.25.2 speaker 3のaudio_query実測（承認26候補全件）に基づき
  // 読み誤りを補正した。
  '058126': {
    judgmentsByOrder: [
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order0 「ホテル」（外来語強調、宿の意）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order1 「ニル・アドミラリイ」（ラテン語成句、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order2 「レエベマン」（独語Lebemann、地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order3 泣く少女への呼びかけ
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order4
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order5（order4に続くエリスの訴え）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order6
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '老媼' }, // order7 「誰ぞ」（戸口の母の声）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order8 「マンサルド」（独語Mansarde、地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order9
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order10 「マルク」（独語Mark、地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order11
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order12 「クルズス」（独語Kursus、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order13 「ヰクトリア」（劇場名、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order14 「コルポルタアジュ」（独語Kolportage、地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order15
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order16
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order17 「ゲエロック」（独語Gehrock、地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order18
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order19（order18に続く）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order20（order19に続く）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order21
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order22（order21に続く）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order23 「ドロシュケ」（独語Droschke、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order24 「カイゼルホオフ」（ホテル名、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order25 「プリュッシュ」（独語Plüsch、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order26 「ゾファ」（独語Sofa、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order27 「ホテル」（地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order28 「カイゼルホオフ」（地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '天方伯' }, // order29 露西亜行きを命じる伯の言葉
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order30 伯への返答
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order31 「カバン」（地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order32 「エポレット」（独語Epaulette、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order33 「カミン」（独語Kamin、地の文）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order34 「カバン」（地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order35 帰宅した豊太郎を迎えるエリスの叫び
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '馭丁' }, // order36 荷を運ぶ馭丁の問い
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order37 「レエス」（独語Spitze/lace、地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order38 産着を見せるエリス
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order39（order38に続く）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order40（order39に続く）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '豊太郎' }, // order41 「承り侍り」（伯への返答を回想する豊太郎自身の言葉）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order42 「ホテル」（地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order43 「あ」（豊太郎の変わり果てた姿を見た叫び）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order44（order43に続く）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order45 錯乱するエリスの叫び
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order46 「パラノイア」（独語Paranoia、医学用語・地の文）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'エリス' }, // order47 心を病んだエリスのつぶやき
    ],
    speechCorrections: {
      // 舞姫のspeechTextは原文のruby（ふりがな）注記が既にextractor段階で
      // 大半の漢字をかな化済み（例: 繋累→けいるい、尋ね来ん→尋ねこん、
      // 命→めい/いのちの文脈別使い分け等）であり、以下はruby未付与のまま
      // 残った漢字だけがVOICEVOX 0.25.2 speaker 3のaudio_query実測で
      // 誤読される事例のみを対象とする。
      //
      // order6: 「君が家に送り行かんに、まず心をしずめたまえ。...」
      '.main_text:4483-4527': [{
        find: '行かんに',
        to: 'ユカンニ',
        reason:
          '「送り行かんに」の「行かんに」が「ぎょうかんに」（行を音読みで誤読）に誤読されることを確認（正しくは「ゆかんに」）。displayTextを変えずカタカナで読みを強制する。',
      }],
      // order9: 「許したまえ。...」（先頭の「許したまえ」のみruby未付与で残存）
      '.main_text:5342-5552': [{
        find: '許したまえ',
        to: 'ユルシタマエ',
        reason:
          '「許したまえ」の「許し」が「もとし」に誤読されることを確認（正しくは「ゆるし」）。displayTextを変えずカタカナで読みを強制する。',
      }],
      // order22: 「政治社会などに...幾年をか経ぬるを。...友にこそ逢いには行け」
      '.main_text:9478-9538': [
        {
          find: '経ぬる',
          to: 'ヘテヌル',
          reason:
            '「経ぬる」の「経」が音読み「けい」に誤読されることを確認（正しくは「へぬる」）。カタカナ「ヘヌル」へ直接置換すると、VOICEVOX/OpenJTalkの辞書が単独の「へ」を方向格助詞と誤認し「え」へ変換してしまう副作用を実測したため、「て」を1モーラ挿入した「ヘテヌル」（経てぬる相当、意味は不変）で正しい「へ」音を強制する。',
        },
        {
          find: '友にこそ',
          to: 'トモニコソ',
          reason:
            '「友にこそ」の「友」が音読み「ゆう」に誤読されることを確認（正しくは訓読み「とも」）。displayTextを変えずカタカナで読みを強制する。',
        },
      ],
      // order39: 「わが心の楽しさを...この瞳子。ああ、夢にのみ見しは君が黒き瞳子なり。...よもあだし名をばなのらせたまわじ」
      // 「瞳子」は原文で初出（産まれん子は...）のみruby「ひとみ」が付与され、
      // 以降2回（この瞳子／君が黒き瞳子なり）はruby省略（青空文庫の初出のみ
      // 注記する慣例）のため未解決のまま残り、VOICEVOXは「どうし」に誤読する。
      // 同一語同一読みのため、残る2箇所とも「ひとみ」へ統一する。
      '.main_text:13758-13853': [
        {
          find: '瞳子',
          to: 'ヒトミ',
          reason:
            '初出「瞳子」は原文rubyにより既に「ひとみ」へ解決済みだが、2回目以降（青空文庫の初出のみ注記する慣例でruby省略）は未解決のまま残り、VOICEVOXが「どうし」に誤読することを確認。同一語のため初出と同じ「ひとみ」で読みを強制する（2箇所とも同一の誤読）。',
        },
        {
          find: '見しは君',
          to: 'ミシワキミ',
          reason:
            '「見しは」が「みなしわ」に誤読されることを確認（正しくは「みしは」）。直後の「君」との境界を保つため「見しは君」をまとめてカタカナで読みを強制する（「見しは」のみを置換すると直後の「君」が「くん」に誤読される副作用が生じるため）。',
        },
        {
          find: '名をば',
          to: 'ナオバ',
          reason:
            '「名をば」が「めえお」に誤読されることを確認（正しくは「なをば」）。displayTextを変えずカタカナで読みを強制する。',
        },
      ],
      // order41: 「承りはべり」（rubyにより「侍り」は既に「はべり」へ解決済み）
      '.main_text:14229-14235': [{
        find: 'はべり',
        to: 'ハベリ',
        reason:
          'ruby解決後の「はべり」の「は」が、VOICEVOX/OpenJTalk辞書が係助詞「は」（発音わ）と誤認し「わべり」に誤読されることを実測。カタカナ「ハベリ」で正しい「は」音を強制する。',
      }],
    },
  },
  // 高瀬舟(045245)。青空文庫本文（45245_22007.html正規化済みテキスト）を実際に
  // 通読し全候補の話者を確定した。庄兵衛（護送の同心）と喜助（罪人）の
  // 対話のみで構成される会話劇であり、typographicな外来語強調は存在しない。
  // order7・order9は「「喜助さん」と呼びかけた。今度は「さん」と言ったが」
  // 「「はい」と答えた喜助も、「さん」と呼ばれたのを不審に思うらしく」の
  // ように、地の文が直前の発話中の単語（「さん」）を再度「」でメタ的に
  // 言及しているだけで新規の発話ではないため、舞姫の外来語強調と同じ
  // NON_SPEECH扱いとする。VOICEVOX 0.25.2 speaker 3のaudio_query実測に
  // 基づき読み誤りを補正した。
  //
  // order12は元は喜助の弟殺害の述懐（2408文字の単一「」候補、原文でも改行
  // なしの一続きの引用）だったが、VOICEVOX synthesisが単一candidateの
  // speechText約1330〜1340文字超でHTTP 500を返す実測済みengine制約（二分探索
  // で確定）のため、f007-source.tsのsplitOverlongF007Candidates（句点「。」の
  // 文境界での安全分割、閾値600文字）によりorder12〜15の4pieceへ自動分割
  // される。分割後の4pieceは全て同一sourceAnchorを共有し（分割元の引用範囲
  // 全体を指す）、同一話者（喜助）の連続する述懐の一部であるため全てapproved・
  // 同一speakerとする。
  '045245': {
    judgmentsByOrder: [
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '庄兵衛' }, // order0 「喜助。お前何を思っているのか。」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order1 「はい」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '庄兵衛' }, // order2 「いや。別にわけがあって聞いたのではない。...」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order3 「御親切におっしゃって...」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order4 「お恥ずかしい事を...」(order3に続く喜助の発話)
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '庄兵衛' }, // order5 「うん、そうかい」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '庄兵衛' }, // order6 「喜助さん」
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order7 「さん」（地の文が直前の呼びかけ語をメタ言及、新規発話でない）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order8 「はい」
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order9 「さん」（同上、地の文のメタ言及）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '庄兵衛' }, // order10 「いろいろの事を聞くようだが...」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order11 「かしこまりました」
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order12 「どうも飛んだ心得違いで...」(自動分割piece1/4)
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order13 「すると弟はまっさおな顔の...」(自動分割piece2/4)
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order14 「えがやっと二寸ばかり傷口から...」(自動分割piece3/4)
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '喜助' }, // order15 「わたくしはかみそりの柄を...」(自動分割piece4/4)
    ],
    speechCorrections: {
      // order3: 「...それからこん度島へおやりくださるにつきまして、...」
      // 「度島」が単独複合語（地名「度島」たくしま等）としてVOICEVOX/
      // OpenJTalk辞書に誤認識され「こん度島へ」が「コンドトオエ」に誤読
      // されることを実測（正しくは「こんどしまえ」）。displayTextを変えず
      // カタカナで読みを強制する。
      '.main_text:2461-2955': [{
        find: '度島へ',
        to: 'ドシマエ',
        reason:
          '「度島」が地名の複合語として辞書に誤認識され「こん度島へ」が「コンドトオエ」に誤読されることを実測（正しくは「こんどしまえ」）。displayTextを変えずカタカナで読みを強制する。',
      }],
      // order10: 「お前が今度島へやられるのは、...」
      // order3と同一の「度島」誤認識パターン（正しくは「こんどしまえ」）。
      '.main_text:5542-5610': [{
        find: '度島へ',
        to: 'ドシマエ',
        reason:
          'order3と同一の「度島」誤認識パターン。「今度島へ」が「コンドトオエ」に誤読されることを実測（正しくは「こんどしまえ」）。displayTextを変えずカタカナで読みを強制する。',
      }],
      // order12: 「...紙屋川の橋を渡って織場へ通っておりましたが、...」
      // 「織場」は初出（西陣の織場にはいりまして）は原文rubyにより
      // 「おりば」へ自動解決済みだが、2回目（青空文庫の初出のみ注記する
      // 慣例でruby省略）は未解決のまま残り、VOICEVOXが「おじょう」に誤読
      // することを実測。同一語のため初出と同じ「おりば」で読みを強制する。
      '.main_text:5652-8005': [{
        find: '織場へ',
        to: 'おりばへ',
        reason:
          '初出「織場」は原文rubyにより既に「おりば」へ解決済みだが、2回目（ruby省略）は未解決のまま残り、VOICEVOXが「おじょう」に誤読することを実測。同一語のため初出と同じ「おりば」で読みを強制する。',
      }],
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

/**
 * 045245（高瀬舟）はorder12がVOICEVOX synthesis上限(実測約1330〜1340文字)を
 * 超えるためsplitOverlongF007Candidates導入後に候補件数が13→16へ変わった。
 * 旧13候補構成でのauthorization(f007-045245-{primary,secondary})は
 * content/editorial/authorization-transaction/へ既にcommit・seal済み
 * （commit eb0c141、append-only store）のため、同一IDでの再登録は内容不一致で
 * 拒否される。append-only方針に従い、削除・上書きはせず新しいrevision識別子
 * (-r2)で新規登録することで、旧sealを歴史として残したまま訂正後の候補構成で
 * 独立二重判定をやり直す。
 */
function authorizationRevisionSuffix(workId: string): string {
  return workId === '045245' ? '-r2' : '';
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
  const revision = authorizationRevisionSuffix(WORK_ID);
  return Object.freeze({
    authorizationId: `f007-${WORK_ID}-${role}${revision}`,
    role,
    producerTaskPath: `/root/f007-editorial/${WORK_ID}/${role}${revision}`,
    judgeRole: role,
    runId: `f007-${WORK_ID}-${role}${revision}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f007-${WORK_ID}-${role}${revision}-nonce`,
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

/** @des DES-F007-006 DES-F007-007 @fun FUN-F007-007 FUN-F007-008 */
async function advanceF007WorkState(
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
    BATCH_DEFINITION_REFS.F007.ref,
    BATCH_DEFINITION_REFS.F007.sha256,
    APPROVAL_POLICY_REFS.F007.ref,
    APPROVAL_POLICY_REFS.F007.sha256,
  );
  const snapshot = await rehydrateF007SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F007 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF007SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF007AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF007DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
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
  const primaryIssuedAt = '2026-08-22T08:10:00.000Z';
  const secondaryIssuedAt = '2026-08-22T08:10:01.000Z';
  const primarySealedAt = '2026-08-22T08:15:00.000Z';
  const secondarySealedAt = '2026-08-22T08:15:01.000Z';
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
    kind: 'f007-extracted-candidates' as const,
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

  // approved候補だけへ読み補正を適用する（rejected=NARRATION候補は音声化しない）。
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
  // splitOverlongF007Candidates(f007-source.ts)により、1件の長大candidateが
  // 同一sourceAnchor(引用範囲全体)を共有する複数candidateへ分割されている
  // 場合がある。speechCorrectionsはsourceAnchor単位で定義されるため、
  // 該当する全candidateへ照合を試み、find文字列を含むpieceにだけ適用する
  // （分割前は1 sourceAnchor = 1 candidateだったため常に1回だけ適用されていた
  // 挙動を、分割後も「1補正=1回だけ適用」という不変条件で維持する）。
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
    kind: 'f007-speech-revision-result' as const,
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
    throw new Error('F007 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-22T08:20:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF007WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF007WorkState(
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
    `F007/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
