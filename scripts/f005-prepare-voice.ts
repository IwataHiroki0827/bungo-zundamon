import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import type { VoiceEstimateProfileV2 } from '../src/content/f003-reuse.ts';
import {
  F005_VOICE_LIMITS,
  planF005VoiceDiff,
  validateF005CandidateSafety,
  type F005SpeechItem,
} from '../src/content/f005-voice.ts';
import type { VoiceConfigV2 } from '../src/voice/cache.ts';

// CHG-F005-073: 音声準備は作品ごとに実施する。
const WORK_ID = process.argv[2] ?? '000799';
if (!/^(?:000799|001076|001104)$/u.test(WORK_ID)) {
  throw new Error('F005の6桁work IDが必要です');
}
const SPEECH_PATH =
  `content/batches/F005/work-artifacts/${WORK_ID}/speech-items.json`;
const PROFILE_PATH = 'content/baselines/F002-voice-estimate-profile.json';
const CONFIG_PATH = 'content/batches/F002/voice-config.json';
const SAFETY_PATH = `content/batches/F005/candidate-safety/${WORK_ID}.json`;
const PLAN_PATH = `content/batches/F005/voice-plans/${WORK_ID}.json`;
const MINIMUM_FREE_BYTES = 5 * 1024 * 1024 * 1024;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function canonicalArtifact<T>(
  workspace: string,
  path: string,
): Promise<{ readonly text: string; readonly value: T }> {
  const text = await readFile(resolve(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function scanExistingPlannedAudio(
  workspace: string,
  audioIds: ReadonlySet<string>,
): Promise<{ readonly wavFiles: number; readonly matches: readonly string[] }> {
  let wavFiles = 0;
  const matches: string[] = [];
  const walk = async (absolute: string, logical: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`audio scan内にlinkがあります: ${logical}/${entry.name}`);
      const nextAbsolute = resolve(absolute, entry.name);
      const nextLogical = `${logical}/${entry.name}`;
      if (entry.isDirectory()) await walk(nextAbsolute, nextLogical);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.wav') {
        wavFiles += 1;
        const audioId = entry.name.slice(0, -4);
        if (audioIds.has(audioId)) matches.push(nextLogical);
      }
    }
  };
  for (const root of ['content', 'public', '.cache']) {
    await walk(resolve(workspace, root), root);
  }
  return { wavFiles, matches: matches.sort((left, right) => left.localeCompare(right, 'en')) };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [speechArtifact, profile, config, disk] = await Promise.all([
    canonicalArtifact<readonly (F005SpeechItem & Readonly<Record<string, unknown>>)[]>(
      workspace,
      SPEECH_PATH,
    ),
    canonicalArtifact<VoiceEstimateProfileV2>(workspace, PROFILE_PATH),
    canonicalArtifact<VoiceConfigV2>(workspace, CONFIG_PATH),
    statfs(workspace, { bigint: true }),
  ]);
  const speechItems: readonly F005SpeechItem[] = speechArtifact.value.map((item) => ({
    candidateId: item.candidateId,
    speechText: item.speechText,
    speechSha256: item.speechSha256,
    approved: true,
  }));
  const safety = validateF005CandidateSafety(speechItems, profile.value, config.value);
  if (safety.result !== 'pass') {
    throw new Error('F005 candidate safetyがblockedです');
  }
  const plan = planF005VoiceDiff(speechItems, config.value, { entries: [] });
  const audioScan = await scanExistingPlannedAudio(
    workspace,
    new Set(plan.entries.map((entry) => entry.audioId)),
  );
  if (audioScan.matches.length !== 0) {
    throw new Error(`既存一致audioを空indexで再生成しようとしています: ${audioScan.matches.join(',')}`);
  }
  const freeBytesBigInt = disk.bavail * disk.bsize;
  if (freeBytesBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('filesystem free bytesがsafe integerを超えました');
  }
  const freeBytes = Number(freeBytesBigInt);
  const freeAfterEstimate = freeBytes - plan.estimatedGenerateBytes;
  if (
    plan.estimatedGenerateBytes > F005_VOICE_LIMITS.addedAudioBytes ||
    freeAfterEstimate < MINIMUM_FREE_BYTES
  ) {
    throw new Error('F005音声の追加容量または空き容量が停止境界を超えます');
  }
  const safetyArtifact = {
    schemaVersion: '1.0.0',
    kind: 'f005-candidate-safety',
    batchId: 'F005',
    workId: WORK_ID,
    speechPath: SPEECH_PATH,
    speechSha256: sha256(speechArtifact.text),
    profilePath: PROFILE_PATH,
    profileSha256: sha256(profile.text),
    configPath: CONFIG_PATH,
    configSha256: sha256(config.text),
    report: safety,
  };
  const planArtifact = {
    schemaVersion: '1.0.0',
    kind: 'f005-voice-diff-plan',
    batchId: 'F005',
    workId: WORK_ID,
    speechSha256: sha256(speechArtifact.text),
    plan,
    preflight: {
      measuredAt: new Date().toISOString(),
      freeBytes,
      estimatedGenerateBytes: plan.estimatedGenerateBytes,
      freeAfterEstimate,
      minimumFreeBytes: MINIMUM_FREE_BYTES,
      scannedRoots: ['content', 'public', '.cache'],
      scannedWavFiles: audioScan.wavFiles,
      existingMatchPaths: audioScan.matches,
    },
  };
  await Promise.all([
    writeJsonArtifactAtomic(
      workspace,
      resolve(workspace, ...SAFETY_PATH.split('/')),
      safetyArtifact,
    ),
    writeJsonArtifactAtomic(
      workspace,
      resolve(workspace, ...PLAN_PATH.split('/')),
      planArtifact,
    ),
  ]);
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    candidateCount: speechItems.length,
    uniqueAudioCount: plan.entries.length,
    reuseCount: plan.reuseCount,
    generateCount: plan.generateCount,
    estimatedGenerateBytes: plan.estimatedGenerateBytes,
    freeBytes,
    freeAfterEstimate,
    safetyPath: SAFETY_PATH,
    safetySha256: sha256(canonicalJson(safetyArtifact)),
    planPath: PLAN_PATH,
    planSha256: sha256(canonicalJson(planArtifact)),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
