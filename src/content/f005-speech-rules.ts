import { DEFAULT_BATCH_SPEECH_RULES } from './batch-production.ts';
import type { SpeechRules } from './processing.ts';

/**
 * CHG-F005-073: 作品固有の外字読み規則。
 *
 * JIS X 0213にない文字を底本は「※［＃…］」で示すが、注記spanは本文抽出時に
 * 除外されるため、読み上げ文には裸の「※」だけが残り正規化がunknown-gaijiで停止する。
 *
 * この規則はcandidateIdとspeechSha256の導出に入るため、候補抽出(collect-source)と
 * レビュー認可・封緘(f005-review)が同一の規則を使わなければ再現性が壊れる。
 * 一箇所で定義して両者から参照する。
 *
 * @des DES-F005-002
 */
const F005_WORK_SPEECH_RULES: Readonly<Record<string, SpeechRules>> = Object.freeze({
  // 趣味の遺伝: 浩一の手控にある「残念※」の※は［＃感嘆符三つ、231-5］であり、
  // 感嘆符は読み上げないため文字ごと落とす。
  '001104': Object.freeze({
    ...DEFAULT_BATCH_SPEECH_RULES,
    gaiji: Object.freeze({ '残念※': '残念' }),
  }),
});

/** 作品IDに対応する読み上げ規則を返す。固有規則がなければ既定を返す。 */
export function resolveF005SpeechRules(workId: string): SpeechRules {
  return F005_WORK_SPEECH_RULES[workId] ?? DEFAULT_BATCH_SPEECH_RULES;
}
