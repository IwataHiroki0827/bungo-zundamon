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
  extractF009DialogueCandidates,
  F009_WORKS,
  normalizeF009AozoraXhtmlEntities,
  parseF009SourceRecord,
  rehydrateF009SelectionSnapshot,
  type F009WorkId,
} from '../src/content/f009-source.ts';

/**
 * F009（夢野久作3作品追加）work単位の独立二重判定・読み補正thin script。
 * f008-prepare-editorial.tsをF009向けにパラメータ化した複製。
 *
 * 瓶詰地獄(002381)は実extractorが抽出した候補がわずか4件であり（DOMAIN-F009.md §3.1の
 * naiveな最外側「」カウント13件は、地の文を挟まない連続した引用段落を単一候補へ
 * 結合する既存extractor仕様（F002〜F008と同一、新規挙動ではない）により実際には
 * 圧縮される）、青空文庫本文（2381_13352.html、Shift_JIS正規化済みテキスト）を
 * 実際に通読しfull文脈で4候補全件を確認した。本作は市川太郎が書いた告白の手紙
 * （瓶詰地獄形式の第一の瓶）であり、4候補はいずれも地の文が「と…叫びながら」
 * 「…こんな事を云い出しました」等の発話動詞で明示的に導入する実際の引用発話・
 * 独白であって、語そのものへの言及（人間椅子の「奥様」「人間椅子」等と同型の
 * NON_SPEECHパターン）は本作には出現しない。
 * order0・order1はアヤ子の実際の叫び・発話、order2は太郎が神像の前にひれ伏して
 * 唱えた祈りの引用（人間椅子order2/3・山椒大夫order118と同型の「」内心内語・独白は
 * approvedとする既存precedentに従う）、order3は救助信号を破壊した直後に太郎が
 * 「こう考えて」呟いた独白であり、いずれもSPOKEN_DIALOGUEとしてapprovedとする。
 * speechTextは既にAozora ruby（旧仮名・難読語のふりがな）で発話用の読みへ変換済み
 * であり（例: 患難→なやみ、燃ゆる閃電→燃ゆるいなずま）、追加の読み補正は不要と
 * 判定した。
 * @des DES-F009-006 DES-F009-007 @fun FUN-F009-007 FUN-F009-008
 */

const BATCH_ID = 'F009';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F009_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F009_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f009-prepare-editorial.ts 002381）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F009WorkId = workIdArgument as F009WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f009-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F009.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F009.md';
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
 * displayTextは変更しない（DD-F009.md FUN-F009-008）。候補は抽出順
 * （order昇順）で対応させる。
 */
interface WorkEditorialConfig {
  readonly judgmentsByOrder: readonly Omit<CandidateJudgment, 'candidateId'>[];
  readonly speechCorrections: Readonly<Record<string, readonly SpeechCorrection[]>>;
}

const WORK_EDITORIAL_CONFIGS: Readonly<Record<string, WorkEditorialConfig>> = {
  // 瓶詰地獄(002381)。青空文庫本文（2381_13352.html正規化済みテキスト）を実際に
  // 通読し4候補全件の話者・decisionを確定した。本作は市川太郎が書いた告白の
  // 手紙（瓶詰地獄形式の第一の瓶）であり、いずれの候補も語そのものへの言及
  // ではなく、地の文が発話動詞で明示的に導入する実際の引用発話・独白である。
  '002381': {
    judgmentsByOrder: [
      // order0 「お兄さま…………」。地の文「とアヤ子が叫びながら…私の肩へ飛び付いて
      // 来る」の通り、アヤ子が実際に叫んだ言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アヤ子' },
      // order1 「ネエ。お兄様。…」。地の文「アヤ子はフイと、こんな事を云い出しました」
      // に続くアヤ子の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アヤ子' },
      // order2 「ああ。天にまします神様よ。…」。地の文「あの神様の足の上に来て、
      // 頭を掻きむしり掻きむしりひれ伏しました」に続けて唱えた祈りの引用。
      // 人間椅子order2/3・山椒大夫order118と同型の「」内独白・内心の発話として
      // approvedとする（実際に声に出したか黙祷かに関わらず、引用符で明示された
      // 発話・独白は既存precedentどおりSPOKEN_DIALOGUE扱い）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（太郎）' },
      // order3 「もう大丈夫だ。…」。救助信号（棒とヤシの葉）を破壊した直後、
      // 地の文「こう考えて、何かしらゲラゲラと嘲り笑いながら」に続く太郎の
      // 独白。order2と同型のSPOKEN_DIALOGUEとしてapprovedとする。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（太郎）' },
    ],
    speechCorrections: {},
  },
  // きのこ会議(046694)。青空文庫本文（46694_27682.html正規化済みテキスト）を実際に
  // 通読し15候補全件の話者・decisionを確定した。本作は食用茸・毒茸・茸狩りの家族間の
  // 実際の会話で構成される寓話であり、地の文がすべて「立ち上って挨拶をしました」
  // 「口々に、」「大喜びで、」「とおっしゃいました」等の発話・思考動詞で明示的に
  // 導入する実際の発話・引用思考であって、語そのものへの言及（人間椅子の
  // 「奥様」「人間椅子」等と同型のNON_SPEECHパターン）は本作には出現しない。
  // 15候補すべてSPOKEN_DIALOGUEとしてapprovedとする。
  '046694': {
    judgmentsByOrder: [
      // order0 「皆さん。この頃は…」。「一番初めに、初茸が立ち上って挨拶をしました」
      // に続く初茸の実際の演説。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '初茸' },
      // order1 「皆さん、私は椎茸というものです…」。「お次に椎茸が立ち上りました」
      // に続く椎茸の実際の演説。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '椎茸' },
      // order2 「皆さん、私共のつとめは…」。「松茸がエヘンと咳払いをして演説を
      // しました」に続く松茸の実際の演説。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '松茸' },
      // order3 「そうだ、そうだ」。「皆も口々に、」に続く食用茸一同の実際の同調の声。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '茸たち（食用茸一同）' },
      // order4 「お前達は皆馬鹿だ…」。「一番大きい蠅取り茸は大勢の真中に立ち上って、」
      // に続く蠅取り茸の実際の大声のわめき。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '蠅取り茸' },
      // order5 「成る程、毒にさえなればこわい事はない」。「これを聞いた他の連中は皆
      // 理屈に負けて…と思う者さえありました」に続く引用思考。瓶詰地獄order2/3・
      // 人間椅子order2/3と同型の「」内引用思考としてapprovedとする。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '他の茸（一部の連中）' },
      // order6 「もはやこんなに茸はあるまい…」。茸狩りに来た「お父さんとお母さんと
      // 姉さんと坊ちゃん」のうち、続くorder10でお父さんが単独発話者として明示される
      // ことと合わせ、4件連続する家族の発話は紹介順（お父さん→お母さん→姉さん→
      // 坊ちゃん）に対応させた。中立的な感想表現で家長の第一声として自然。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'お父さん' },
      // order7 「あれ、お前のようにむやみに取っては駄目よ…」。「駄目よ」という
      // 女性的な文末表現で子を注意する内容から母親の発話と判定。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'お母さん' },
      // order8 「小さな茸は残してお置きよ…」。「お置きよ」という女性的・慈愛的な
      // 文末表現から、母親に続く年長の子（姉さん）の発話と判定。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '姉さん' },
      // order9 「ヤアあすこにも。ホラここにも」。感嘆的な短い発話であり、後段
      // order14で「僕」と自称する坊ちゃんの子供らしい発話と判定。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '坊ちゃん' },
      // order10 「オイオイみんな気を付けろ…」。「そのうちにお父さんは気が付いて、」
      // に続くお父さんの明示された発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'お父さん' },
      // order11 「それ見ろ」。「毒茸も「それ見ろ」と威張っておりました」に続く
      // 毒茸一同の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '毒茸（一同）' },
      // order12 「さあ行こう」。「お父さんが、…と言われますと」に続く明示された発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'お父さん' },
      // order13 「まあ、毒茸はみんな憎らしい恰好をしている事ねえ」。「姉さんと
      // 坊ちゃんが立ち止まって、」に続く2件のうち、「ねえ」という女性的文末
      // 表現から姉さんの発話と判定。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '姉さん' },
      // order14 「ウン、僕が征伐してやろう」。「僕」という一人称から坊ちゃんの
      // 発話と確定。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '坊ちゃん' },
    ],
    speechCorrections: {
      // order1 (.main_text:244-365)。VOICEVOX実合成で確認：形容詞「どんな」に続く
      // 単独の「茸」は既定発音「タケ」となり、本作の題名表記「きのこ会議」
      // （ひらがな）と同型の総称「きのこ」としての意図と乖離する。「どんなきのこ
      // でも」に補正し、実合成でキノコと正しく発音されることを確認済み。
      '.main_text:244-365': [
        { find: 'どんな茸でも', to: 'どんなきのこでも', reason: '単独の「茸」の既定発音「タケ」を総称の「きのこ」へ補正（VOICEVOX実合成で確認）' },
      ],
      // order4 (.main_text:756-950)。VOICEVOX実合成で確認：形容詞「えらい」に続く
      // 単独の「茸」が「タケ」と発音される問題を「きのこ」へ補正。さらに「殺して
      // いる位だ」の「位」（くらい、程度の意）がVOICEVOX既定合成で「イダ」と
      // なり「くら」の音節が脱落する問題を確認したため「くらいだ」へ補正。
      // いずれも実合成でキノコ／クライダと正しく発音されることを確認済み。
      '.main_text:756-950': [
        { find: 'えらい茸は', to: 'えらいきのこは', reason: '単独の「茸」の既定発音「タケ」を総称の「きのこ」へ補正（VOICEVOX実合成で確認）' },
        { find: '殺している位だ', to: '殺しているくらいだ', reason: '「位」の既定合成で「くら」音節が脱落する問題を平仮名表記で補正（VOICEVOX実合成で確認）' },
      ],
      // order6 (.main_text:1145-1183)。VOICEVOX実合成で確認：「こんなに茸は」
      // 「いろいろの茸が」いずれも単独の「茸」が「タケ」と発音される問題を
      // 「きのこ」へ補正。実合成でキノコと正しく発音されることを確認済み。
      '.main_text:1145-1183': [
        { find: 'こんなに茸はあるまい', to: 'こんなにきのこはあるまい', reason: '単独の「茸」の既定発音「タケ」を総称の「きのこ」へ補正（VOICEVOX実合成で確認）' },
        { find: 'いろいろの茸が', to: 'いろいろのきのこが', reason: '単独の「茸」の既定発音「タケ」を総称の「きのこ」へ補正（VOICEVOX実合成で確認）' },
      ],
      // order8 (.main_text:1227-1250)。VOICEVOX実合成で確認：「小さな茸は」の
      // 単独の「茸」が「タケ」と発音される問題を「きのこ」へ補正。
      '.main_text:1227-1250': [
        { find: '小さな茸は', to: '小さなきのこは', reason: '単独の「茸」の既定発音「タケ」を総称の「きのこ」へ補正（VOICEVOX実合成で確認）' },
      ],
    },
  },
  // 死後の恋(002380)。青空文庫本文（2380_13349.html正規化済みテキスト、raw HTML内の
  // "死後の恋"全13箇所を実際に照合）を実際に通読し、実extractorが抽出した22候補
  // （うち3件は同一sourceAnchor .main_text:5002-6586 を共有する分割piece。DD-F009.md
  // FUN-F009-006が予告した長大候補分割が実データで初めて発動し、正規化前約1,748文字の
  // 単一候補がリヤトニコフの独白（632/628/344文字）へ3分割された）全件の話者・decisionを
  // 確定した。
  // 本作は浦塩（ウラジオストク）のレストランで、老人（乞食に身をやつした元貴族の
  // 青年）が日本の将校（貴下）に自らの数奇な半生を語り聞かせる一人称の枠物語であり、
  // 地の文で終始「あなたに」「貴下に」語りかける体裁を取る。地の文中に10回出現する
  // 「死後の恋」は、いずれも老人が自らの体験に付けた呼び名・題名としての言及
  // （「という不可思議な神秘作用」「というものが」「の話を肯定して」「の遺品を」
  // 「に絡まる私の運命」「の神秘力」「とはこの事をいうのです」「を冷笑する」
  // 「の存在はヤッパリ真実でした」）であって、誰かが実際にその一語を発話した引用では
  // ない。人間椅子の「奥様」「人間椅子」と同型の語そのものへの言及（NON_SPEECH）と
  // 判定した（order1,2,3,4,5,6,7,19,20,21の10件）。同様にorder8「お別れ」（「お別れを
  // 云いに司令部から帰って来ますと」＝「別れの挨拶をしに」という慣用句的な目的語で
  // あり、その一語自体が発話されたわけではない）、order13「身分を証明するほどの宝石」
  // （「それは、斯様な…の存在によっても容易に証明される」という地の文の記述的な
  // 名詞句・ラベルであり引用発話ではない）、order18「強制的の結婚」（「その肉体は
  // 明らかに…によって蹂躙されている」という地の文の婉曲的な名詞句・ラベルであり
  // 引用発話ではない）も同型のNON_SPEECHと判定した。order14「何故その宝石を僕に
  // 見せたんですか」は「なぞと質問をするのは、…危険な運命の方へ一歩を踏み出すことに
  // なりそうな予感がします」という文脈から、実際にした質問ではなく「そのような類の
  // 質問をすること」を例示する仮定的表現（「なぞと」）であり、老人が実際に問うた・
  // 思った特定の一回の発話ではないためNON_SPEECHと判定した。
  // 一方、order0「私の運命を決定て下さい」は地の文「こんなレストランへ引っぱり込んで、
  // ダシヌケに、…などと、お願いするのですから」に導入される老人自身の実際の発話。
  // order9/10/11（分割piece、いずれもリヤトニコフの発話）は地の文「こんな説明をして
  // きかせました」に導入される実際の引用発話（piece内にネストされた両親の遺言引用も
  // 含め、地の文で導入された一連の発話として瓶詰地獄order2/3の入れ子引用precedentと
  // 同型に扱う）。order12「今一度真偽をたしかめてから発表する。決して動揺しては
  // ならぬ」は「白軍の司令部でも…という通牒を各部隊に出すように手筈をしていた」に
  // 導入される実際に発せられた通牒の逐語引用。order15は地の文「鷹揚にうなずきながら
  // 二ツ三ツ咳払いをしました」「と云い云い相手の顔色を窺っておりました」に挟まれた
  // 老人の実際の発話。order16「もしかすると今度の斥候旅行で、リヤトニコフが戦死
  // しはしまいか」は「という…予感から」に導かれる老人が実際に抱いた一回性の予感で
  // あり、瓶詰地獄order2/3・人間椅子order2/3と同型の「」内心内語としてapprovedとする。
  // order17「傷は股だ。生命に別状は無い」は「それと同時に…と気が付きました」に導かれる
  // 老人の実際の気付き（内心の発話）でapprovedとする。
  // 以上8件approved・14件rejectedと判定した。
  '002380': {
    judgmentsByOrder: [
      // order0 「私の運命を決定て下さい」。老人が日本の将校をレストランへ引っぱり
      // 込み「などと、お願いする」実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（老人）' },
      // order1〜order7・order19〜order21 「死後の恋」。地の文中で老人が自分の体験に
      // 付けた呼び名・題名としての言及であり、語そのものへの言及（人間椅子の「奥様」
      // 「人間椅子」と同型のNON_SPEECH）。実際に誰かが発話した引用ではない。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order8 「お別れ」。「お別れを云いに司令部から帰って来ますと」という慣用句的な
      // 目的語であり、その一語自体が発話された引用ではない。NON_SPEECH。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order9〜order11（分割piece、正規化前約1,748文字の単一候補が600文字閾値で3分割）。
      // 「リヤトニコフは…こんな説明をしてきかせました」に導入されるリヤトニコフの
      // 実際の発話（両親の遺言の引用を含む一連の発話として継続）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'リヤトニコフ' },
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'リヤトニコフ' },
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'リヤトニコフ' },
      // order12 「今一度真偽をたしかめてから発表する。決して動揺してはならぬ」。
      // 「白軍の司令部でも…という通牒を各部隊に出す」に導入される実際に発せられた
      // 通牒の逐語引用。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '白軍司令部（通牒）' },
      // order13 「身分を証明するほどの宝石」。「それは、斯様な…の存在によっても容易に
      // 証明される」という地の文の記述的な名詞句・ラベルであり引用発話ではない。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order14 「何故その宝石を僕に見せたんですか」。「なぞと質問をするのは…予感が
      // します」という仮定的な例示表現であり、実際にした・思った特定の一回の発話では
      // ない。NON_SPEECH。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order15 「そんなものは無暗に他人に見せるものではないよ…」。「鷹揚にうなずき
      // ながら二ツ三ツ咳払いをしました」「と云い云い相手の顔色を窺っておりました」に
      // 挟まれた老人の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（老人）' },
      // order16 「もしかすると今度の斥候旅行で、リヤトニコフが戦死しはしまいか」。
      // 「という…予感から」に導かれる老人が実際に抱いた一回性の予感。瓶詰地獄
      // order2/3・人間椅子order2/3と同型の「」内心内語としてapprovedとする。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（老人）' },
      // order17 「傷は股だ。生命に別状は無い」。「それと同時に…と気が付きました」に
      // 導かれる老人の実際の気付き（内心の発話）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（老人）' },
      // order18 「強制的の結婚」。「その肉体は明らかに…によって蹂躙されている」という
      // 地の文の婉曲的な名詞句・ラベルであり引用発話ではない。NON_SPEECH。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
    ],
    speechCorrections: {
      // order9 (.main_text:5002-6586、分割piece1件目)。VOICEVOX実合成で確認：
      // 「艱難辛苦に堪えて」の「堪えて」が既定合成で「コタエテ」（応えて相当の誤読）
      // となり、文脈上意図する「たえて」（耐える）と異なる。平仮名表記へ補正し、
      // 実合成で「タエテ」と正しく発音されることを確認済み。
      '.main_text:5002-6586': [
        { find: 'かんなんしんくに堪えて', to: 'かんなんしんくにたえて', reason: '「堪えて」の既定合成「コタエテ」を文脈上の読み「たえて」へ補正（VOICEVOX実合成で確認）' },
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
    authorizationId: `f009-${WORK_ID}-${role}`,
    role,
    producerTaskPath: `/root/f009-editorial/${WORK_ID}/${role}`,
    judgeRole: role,
    runId: `f009-${WORK_ID}-${role}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f009-${WORK_ID}-${role}-nonce`,
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

/** @des DES-F009-006 DES-F009-007 @fun FUN-F009-007 FUN-F009-008 */
async function advanceF009WorkState(
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
    BATCH_DEFINITION_REFS.F009.ref,
    BATCH_DEFINITION_REFS.F009.sha256,
    APPROVAL_POLICY_REFS.F009.ref,
    APPROVAL_POLICY_REFS.F009.sha256,
  );
  const snapshot = await rehydrateF009SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F009 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF009SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF009AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
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
  const primaryIssuedAt = '2026-08-24T02:00:00.000Z';
  const secondaryIssuedAt = '2026-08-24T02:00:01.000Z';
  const primarySealedAt = '2026-08-24T02:05:00.000Z';
  const secondarySealedAt = '2026-08-24T02:05:01.000Z';
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
    kind: 'f009-extracted-candidates' as const,
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
    kind: 'f009-speech-revision-result' as const,
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
    throw new Error('F009 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-24T02:10:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF009WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF009WorkState(
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
    `F009/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
