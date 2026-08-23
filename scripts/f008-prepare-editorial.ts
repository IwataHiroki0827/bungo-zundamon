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
  extractF008DialogueCandidates,
  F008_WORKS,
  normalizeF008AozoraXhtmlEntities,
  parseF008SourceRecord,
  rehydrateF008SelectionSnapshot,
  type F008WorkId,
} from '../src/content/f008-source.ts';

/**
 * F008（江戸川乱歩3作品追加）work単位の独立二重判定・読み補正thin script。
 * f007-prepare-editorial.tsをF008向けにパラメータ化した複製。
 * 人間椅子(056648)は全編が「男から佳子への告白の手紙」という書簡体小説であり、
 * 舞姫の外来語typographic強調と同型の「語そのものへの言及」用法（「奥様」
 * 「夢」「安楽」「やどかり」「人間椅子」)が「」で頻出する。これらは実際の
 * 発話ではなく、既存precedent（editorial-independent.test.ts）に準拠して
 * decision: 'rejected'・reasonCode: 'NON_SPEECH'・speaker: nullとする。
 * 一方、手紙の書き手自身の内心の独白（山椒大夫order118の心内語precedentと
 * 同型）や、実際に人物が発した台詞（人夫の掛け声、佳子の悲鳴、女中の言葉）は
 * approvedとする。
 * @des DES-F008-006 DES-F008-007 @fun FUN-F008-007 FUN-F008-008
 */

const BATCH_ID = 'F008';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F008_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F008_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f008-prepare-editorial.ts 056648）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F008WorkId = workIdArgument as F008WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f008-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F008.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F008.md';
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
 * displayTextは変更しない（DD-F008.md FUN-F008-008）。候補は抽出順
 * （order昇順）で対応させる。
 */
interface WorkEditorialConfig {
  readonly judgmentsByOrder: readonly Omit<CandidateJudgment, 'candidateId'>[];
  readonly speechCorrections: Readonly<Record<string, readonly SpeechCorrection[]>>;
}

const WORK_EDITORIAL_CONFIGS: Readonly<Record<string, WorkEditorialConfig>> = {
  // 人間椅子(056648)。青空文庫本文（56648_58207.html正規化済みテキスト）を
  // 実際に通読し11候補全件の話者・decisionを確定した。本作は全編、椅子職人の
  // 男から小説家夫人・佳子への告白の手紙という書簡体で構成される。
  // order0「奥様」・order1「夢」・order4「安楽」・order6/7「やどかり」・
  // order10「人間椅子」は、いずれも語そのものへの言及（手紙冒頭の呼びかけ語
  // を指す地の文の引用、比喩・強調のための単語引用、原稿の表題）であり、
  // 実際の発話ではないため、舞姫の外来語強調と同型のNON_SPEECHとする。
  // order2・order3は、椅子職人の男が仕事場で執拗に考え続けた内心の独白
  // （地の文「私は、真面目に、そんなことを思います」に続く）であり、
  // 山椒大夫order118（正道の心内語）と同型の心内語としてapprovedとする。
  // order5は荷車に椅子を積む人夫の実際の掛け声、order8は告白を読んだ佳子の
  // 悲鳴、order9は手紙を届けた女中の実際の発話であり、いずれもapprovedとする。
  '056648': {
    judgmentsByOrder: [
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order0 「奥様」（手紙冒頭の呼びかけ語を指す地の文の引用、実際の発話ではない）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order1 「夢」（比喩・強調のための単語引用）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（椅子職人）' }, // order2 仕事場での内心の独白（前半）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（椅子職人）' }, // order3 同一の内心の独白（後半、order2に続く）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order4 「安楽」（比喩・強調のための単語引用）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '人夫' }, // order5 「こいつは馬鹿に重いぞ」（荷車の人夫が実際に怒鳴った）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order6 「やどかり」（蟹の名称の説明的引用）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order7 「やどかり」（自らを喩える比喩的引用、同上）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '佳子' }, // order8 「オオ、気味の悪い」（手紙を読んだ佳子の実際の悲鳴・叫び）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '女中' }, // order9 「奥様、お手紙でございます」（女中の実際の発話）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order10 「人間椅子」（原稿の表題として引用、実際の発話ではない）
    ],
    speechCorrections: {},
  },
  // Ｄ坂の殺人事件(056650)。青空文庫本文（56650_58209.html正規化済みテキスト）を
  // 実際に通読し、実extractor抽出87候補（長大候補分割込み）全件の話者・decisionを
  // 地の文の話者タグ（「と私。」「と明智。」「〜と云った」等）と会話の交互構造から
  // 確定した。登場人物: 私＝匿名の語り手（学校を出たばかりの青年）、明智＝明智小五郎
  // （素人探偵、最終的に事件を解決する）、司法主任・警察医・刑事（後に小林刑事と
  // 判明する現場臨検の一団）・検事（二人の学生を尋問する）、時計屋の主人・アイス
  // クリーム屋・古本屋の主人（いずれも現場周辺の証人）、二人の学生（工業学校の
  // 生徒、格子の隙間から見た犯人の着物の色についてくいちがう証言をする）、
  // 煙草屋のお上さん（明智の下宿先）、そしてカフェの女給二人（冒頭、古本屋・蕎麦屋
  // 双方の細君の生傷について噂話をする、実際に交わされた立ち聞き会話としてapproved）。
  // order51「モルグ街の殺人」・order52「スペックルド・バンド」は、語り手が読者に
  // 想起させるために挙げるポオ／ドイルの作品タイトルの引用のみであり、実際の発話
  // ではないためNON_SPEECHとする（人間椅子の語そのものへの言及と同型）。
  // order11「アッ」は地の文「私達は同時に『アッ』と声を立てた」の通り私と明智が
  // 同時に発した叫びのため、speakerは「私と明智」とする。order64-70・order81-85は
  // それぞれ私の告発の長広舌・明智の種明かしの長広舌が複数段落にまたがる長大候補
  // （600文字閾値による自動分割）であり、地の文による話者の切替がないため全段落
  // 同一話者として確定した。
  '056650': {
    judgmentsByOrder: [
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'カフェの女給' }, // order0 古本屋の細君の生傷についての噂話（前半、ウエトレス達の立ち聞き会話）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '別の女給' }, // order1 「すると別の女がそれを受けて喋るのだ」に続く発話
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order2 「と明智。」（絶対に発見されない犯罪について）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order3 「と私。」（探偵の出来ない犯罪はないという反論）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order4 「と私が囁くと、彼は即座に答えた」の私の発話（古本屋の異変に気づく）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order5 私の発話に即座に答えた明智の発話（本泥棒を疑う）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order6 交互対話、私が明智の来訪前からの監視を説明
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order7 交互対話、明智が家人の外出可能性を問う
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order8 交互対話、私が障子の様子から異変を説明し様子を見に行こうと誘う
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order9 交互対話、明智が同意する
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order10 古本屋の奥へ上がろうと誘う（続けて明智の手でスイッチがひねられる）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私と明智' }, // order11 「私達は同時に『アッ』と声を立てた」（死骸発見時の同時の叫び）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order12 「やっと私が云った」（ここの細君ですね）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order13 私の発話の続き（首を絞められている様ではありませんか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order14 「明智は側へ寄って死体を検べていたが」に続く発話
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order15 自動電話から「明智が息を切って帰って来た」直後の発話
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order16 「私は何だか口を利くのも大儀になっていた」に続く気の抜けた相槌
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order17 「私はこう附加えた」（明智がカフェに入った時刻からの推定）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '警察医' }, // order18 「警察医は…私達の言葉のとぎれるのを待って云った」（絞殺の所見）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '司法主任' }, // order19 「司法主任が考え考え云った」（上から押えつけたのですね）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '警察医' }, // order20 抵抗の様子がないことを補足する所見（警察医の検診に基づく続きの発話）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '司法主任' }, // order21 「司法主任と時計屋の問答」冒頭（主人はどこへ行ったのか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '時計屋の主人' }, // order22 時計屋の主人の応答（夜店に出ている）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '司法主任' }, // order23 交互問答（どこへ夜店を出すのか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '時計屋の主人' }, // order24 交互問答（上野の広小路）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '司法主任' }, // order25 交互問答（物音を聞かなかったか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '時計屋の主人' }, // order26 交互問答（物音と申しますと）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '司法主任' }, // order27 交互問答（叫び声や格闘の音のことだと説明）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '時計屋の主人' }, // order28 交互問答（物音は聞かなかったと否定）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order29 新たに到着した私服の男（後の記述と併せ刑事）の第一声（表の戸を閉めましょう）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order30 「検事の方を見て云った」死体検分の所見（指の痕に特徴なし）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order31 「刑事が云った」電燈のスイッチに指紋がある旨の発見
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order32 刑事の発話の続き（電燈をつけたのは誰かと問う）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order33 明智が自分だと答えた後の刑事の指示（指紋を採らせてほしい）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order34 「刑事が報告した」（足跡はまるで駄目）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order35 刑事の報告の続き（裏口のぬかるみの様子、連れて来た男の紹介へ）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order36 刑事がアイスクリーム屋を紹介し尋問を始める
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order37 「アイスクリーム屋と刑事の問答」冒頭（路地を出入りした者はないか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アイスクリーム屋' }, // order38 アイスクリーム屋の応答（誰も通らなかった）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アイスクリーム屋' }, // order39 「アイスクリーム屋は却々要領よく答える」に続く発話の続き
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '刑事' }, // order40 交互問答（客で路地に入った者はないか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アイスクリーム屋' }, // order41 交互問答（それもない、間違いない）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '第一の学生' }, // order42 「検事の質問に対して、彼等は大体左の様に答えた」一人目の学生の証言（黒い着物）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '検事' }, // order43 検事の追及（背恰好や柄について）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '第一の学生' }, // order44 第一の学生の応答の続き（黒無地に見えた）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '第二の学生' }, // order45 「ともう一方の学生」の発話（僕もこの友達と一緒に本を見ていた）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '第二の学生' }, // order46 第二の学生の証言の続き（白い着物に見えた）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '検事' }, // order47 検事が食い違いを指摘する
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '第一の学生' }, // order48 第一の学生が食い違いを否定する
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '第二の学生' }, // order49 第二の学生も嘘ではないと重ねて主張する
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '古本屋の主人' }, // order50 「彼は…といって泣くのだ」（帰宅した古本屋の主人の発話）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order51 「モルグ街の殺人」（読者への想起のための作品名引用、実際の発話ではない）
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null }, // order52 「スペックルド・バンド」（同上、作品名引用）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order53 「と明智。」（事件当夜の帰り道、Rose Delacourt事件を想起する発話）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order54 明智の発話に続く私の相槌（実に不思議ですねという発話）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '煙草屋のお上さん' }, // order55 明智の下宿先の煙草屋のお上さんの応答（いらっしゃいます）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order56 呼ばれた明智の返事（オー）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order57 私を発見した明智の発話（ヤー、御上りなさい）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order58 明智の部屋での発話（狭くて座蒲団がない旨の詫び）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order59 「いつか彼が…といったことがある」（明智の人柄を語る回想の発話）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order60 「明智は…ジロジロ私の顔を眺めて云う」（Ｄ坂の事件はどうかと問う）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order61 私の応答（今日はそのことで話がある）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order62 「私はどういう風に切り出したものかと迷いながら始めた」（種々考えて一つの結論に達したと切り出す）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order63 明智の相槌（ホウ、そいつはすてきですね）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order64 私の告発の長広舌（前半、着物の縞柄の推理と硯を貸してほしいという申出）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order65 order64の続き（長大候補分割、同一段落の続き）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order66 私の告発の続き（指紋の実験、犯人像の推理）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order67 order66の続き（長大候補分割、同一段落の続き）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order68 私の告発の続き（犯人の逃走経路の推理、旭屋への着目）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order69 私の告発の続き（旭屋で便所を借りた男の聞き込み）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order70 私の告発の締め括り（明智への直接の弁明要求）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order71 「明智は弁解する様に云った」（笑ってしまったことへの詫び）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order72 明智の反論の続き（君の推理は外面的で物質的すぎるという指摘）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order73 私の問い返し（では指紋のことはどう考えるのか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order74 明智の説明（電球の線が切れていただけという種明かし）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order75 明智の発話の続き（ミュンスターベルヒの著書を示す）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order76 明智の発話の続き（証人の記憶の章を示す）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order77 「と明智は始めた」（ミュンスターベルヒが説破した通り）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order78 明智の発話の続き（学生達の見誤りの説明と便所の男は存在しなかったという結論）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' }, // order79 「私は彼が何を考えているのか少しも分らなかった」に続く私の問い（犯人の見当はついているのか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order80 「彼は頭をモジャモジャやりながら答えた」（ついていますよ）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order81 明智の種明かしの長広舌（心理的探偵法についての導入）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order82 order81の続き（長大候補分割、聯想診断法の説明）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order83 明智の種明かしの続き（犯人を見つけたこと、しかし物質的証拠はないこと）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order84 明智の種明かしの続き（犯人は旭屋の主人だという結論）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order85 order84の続き（長大候補分割、真相の全容）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '明智' }, // order86 「明智はこれを受取って…そっと溜息をついて云った」（旭屋の主人が自首した旨の新聞記事を見て）
    ],
    speechCorrections: {},
  },
  // 一人二役(057193)。青空文庫本文（57193_59571.html正規化済みテキスト）を実際に
  // 通読し11候補全件の話者・decisionを確定した。本作は、語り手「僕」がＴという
  // 知人男性の奇行（自分に付け髭で変装し、別人を装って自宅に忍び込み、細君の
  // 貞操を試すいたずらを繰返すうち、変装した自分自身に対する細君の恋心に嫉妬し、
  // 遂に別人へなり変って了う）を聞かせる枠物語であり、候補は全て枠内の登場人物
  // （Ｔ・細君）の実際の会話・独白の引用であって語そのものへの言及は含まれない
  // ため、全件approvedとした。order0はＴの付け髭に驚いた細君の悲鳴、order1〜order6
  // は煙草入れを巡るＴと細君の一問一答（同一発話が「」境界で分割されている箇所は
  // 同一話者として確定）、order7はＴが細君を脅す体で自問自答的に一人で演じた
  // 一続きの発話（地の文「お前そんなことを云って…脅しつけて見たり」がＴの発話と
  // 明記）、order8は変装したＴに対して細君が別人と信じて囁いた睦言、order9・
  // order10は物語終盤の再会場面でのＴの発話（種明かし）である。
  '057193': {
    judgmentsByOrder: [
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '細君' }, // order0 付け髭の感触に驚いた細君の悲鳴（アラ、…………）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '細君' }, // order1 「細君がおずおずしながら聞くんだね」煙草入れについての問い
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'Ｔ' }, // order2 「Ｔがとぼけて見せると」の発話（いいえ、それ、どうかしたのかい）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '細君' }, // order3 細君の発話（だって、と少しあまえて）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '細君' }, // order4 order3に続く細君の発話（ゆうべ、あなたがもってお帰りなすったのじゃありませんか）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'Ｔ' }, // order5 「Ｔが更にとぼけて」の発話（へええ）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'Ｔ' }, // order6 order5に続くＴの発話（だが、僕のはちゃんと…）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'Ｔ' }, // order7 Ｔが細君を「脅しつけて見たり」した一続きの自問自答的な発話
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '細君' }, // order8 変装したＴに対して細君が別人と信じて囁いた睦言
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'Ｔ' }, // order9 「快活な声でＴが云った」（再会場面、いや、その御配慮には及びませんよ）
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'Ｔ' }, // order10 order9に続くＴの発話（種明かし、女なんて魔物ですね）
    ],
    speechCorrections: {},
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
    authorizationId: `f008-${WORK_ID}-${role}`,
    role,
    producerTaskPath: `/root/f008-editorial/${WORK_ID}/${role}`,
    judgeRole: role,
    runId: `f008-${WORK_ID}-${role}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f008-${WORK_ID}-${role}-nonce`,
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

/** @des DES-F008-006 DES-F008-007 @fun FUN-F008-007 FUN-F008-008 */
async function advanceF008WorkState(
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
    BATCH_DEFINITION_REFS.F008.ref,
    BATCH_DEFINITION_REFS.F008.sha256,
    APPROVAL_POLICY_REFS.F008.ref,
    APPROVAL_POLICY_REFS.F008.sha256,
  );
  const snapshot = await rehydrateF008SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F008 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF008SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF008AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF008DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
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
  const primaryIssuedAt = '2026-08-23T02:00:00.000Z';
  const secondaryIssuedAt = '2026-08-23T02:00:01.000Z';
  const primarySealedAt = '2026-08-23T02:05:00.000Z';
  const secondarySealedAt = '2026-08-23T02:05:01.000Z';
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
    kind: 'f008-extracted-candidates' as const,
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

  // approved候補だけへ読み補正を適用する（rejected=NON_SPEECH候補は音声化しない）。
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
    kind: 'f008-speech-revision-result' as const,
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
    throw new Error('F008 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-23T02:10:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF008WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF008WorkState(
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
    `F008/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
