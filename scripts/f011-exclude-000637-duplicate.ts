import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';

/**
 * F011専用の一時運用script(1回限り)。手袋を買いに(000637)のspeech-revisions.json
 * から、v0.10.0固定baseline(F008公開済み)の既存音声とWAVバイト内容が偶然一致する
 * 1候補を音声合成前に除外する。
 *
 * CHG-F011-001(000628)とは根本原因が異なる: audioId(text+config内容hash、
 * createVoiceCacheKey、src/voice/cache.ts)自体は衝突しておらず、VOICEVOX合成結果の
 * WAVバイト列がたまたま一致した(候補: workId 000637、candidateId
 * PZmXbdvjp3qGWT0xGU3bSIXS1SevkBxRog70My_3brE、text「あっ」)。詳細は
 * docs/changes/changes.yaml CHG-F011-002参照。
 *
 * candidates.json・reviews/000637.json・review-reconciliation.jsonは変更しない
 * (この候補は編集上approvedのまま、音声段階でのみ除外するため)。
 */
const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const SPEECH_PATH = resolve(WORKSPACE, 'content', 'batches', 'F011', 'work-artifacts', '000637', 'speech-revisions.json');
const EXCLUDED_CANDIDATE_IDS = new Set(['PZmXbdvjp3qGWT0xGU3bSIXS1SevkBxRog70My_3brE']);

interface SpeechRecord {
  readonly candidateId: string;
  readonly displayText: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly revisionCount: number;
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(SPEECH_PATH, 'utf8')) as Record<string, unknown> & { readonly speech: readonly SpeechRecord[] };
  const before = raw.speech.length;
  const nextSpeech = raw.speech.filter((item) => !EXCLUDED_CANDIDATE_IDS.has(item.candidateId));
  if (nextSpeech.length !== before - EXCLUDED_CANDIDATE_IDS.size) {
    throw new Error(`除外対象candidateがspeech-revisions.jsonに想定数見つかりません: before=${before} after=${nextSpeech.length}`);
  }
  await writeJsonArtifactAtomic(WORKSPACE, SPEECH_PATH, { ...raw, speech: nextSpeech });
  process.stdout.write(canonicalJson({ ok: true, before, after: nextSpeech.length }));
}

await main();
