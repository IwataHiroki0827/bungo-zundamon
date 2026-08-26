import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';

/**
 * F011専用の一時運用script(1回限り)。ごん狐(000628)のspeech-revisions.jsonから、
 * v0.10.0固定baselineの既公開音声とaudioIdが衝突する2候補を音声合成前に除外する
 * (CHG-F008-004と同型の対応、詳細はdocs/changes/changes.yaml参照)。
 * candidates.json・reviews/000628.json・review-reconciliation.jsonは変更しない
 * (この2候補は編集上approvedのまま、音声段階でのみ除外するため)。
 */
const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const SPEECH_PATH = resolve(WORKSPACE, 'content', 'batches', 'F011', 'work-artifacts', '000628', 'speech-revisions.json');
const EXCLUDED_CANDIDATE_IDS = new Set([
  'IYovdjGtidDGIWvhWi-C4JXJ0V6O0DECy4hNqUURksk',
  'FG3i_rrQnSDmNhuVmH1X2iVqIbbF5NldebR3V6_eb8I',
]);

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
