import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import {
  capacityWarnings,
  createF005CapacityPlan,
  discoverF005CapacityInventory,
  forecastF005Capacity,
  loadV040Baseline,
} from '../src/content/f005-foundation.ts';

const WORK_ID = process.argv[2] ?? '000799';
if (!/^(?:000799|001076|001104)$/u.test(WORK_ID)) {
  throw new Error('F005の対象work IDが不正です');
}
const VOICE_PLAN_PATH = `content/batches/F005/voice-plans/${WORK_ID}.json`;
const FORECAST_PATH = `content/batches/F005/capacity-forecast/${WORK_ID}.json`;

interface PersistedVoicePlan {
  readonly kind: 'f005-voice-diff-plan';
  readonly batchId: 'F005';
  readonly workId: string;
  readonly plan: {
    readonly planSha256: string;
    readonly entries: readonly {
      readonly audioId: string;
      readonly speechSha256: string;
      readonly action: 'reuse' | 'generate';
      readonly estimatedBytes: number;
    }[];
    readonly estimatedGenerateBytes: number;
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const voicePlanText = await readFile(
    resolve(workspace, ...VOICE_PLAN_PATH.split('/')),
    'utf8',
  );
  const voicePlan = JSON.parse(voicePlanText) as PersistedVoicePlan;
  if (
    canonicalJson(voicePlan) !== voicePlanText ||
    voicePlan.kind !== 'f005-voice-diff-plan' ||
    voicePlan.batchId !== 'F005' ||
    voicePlan.workId !== WORK_ID ||
    !/^[0-9a-f]{64}$/u.test(voicePlan.plan.planSha256) ||
    !Array.isArray(voicePlan.plan.entries)
  ) {
    throw new Error('canonical voice plan artifactが不正です');
  }
  const generateEntries = voicePlan.plan.entries.filter((entry) => entry.action === 'generate');
  const estimatedGenerateBytes = generateEntries.reduce(
    (sum, entry) => sum + entry.estimatedBytes,
    0,
  );
  if (
    !Number.isSafeInteger(estimatedGenerateBytes) ||
    estimatedGenerateBytes !== voicePlan.plan.estimatedGenerateBytes
  ) {
    throw new Error('voice planのgenerate容量合計が一致しません');
  }

  const context = await loadVerifiedF005Definition(workspace);
  const baseline = await loadV040Baseline(workspace, context);
  const inventory = await discoverF005CapacityInventory(workspace, context, baseline);
  const capacityPlan = createF005CapacityPlan(context, baseline, inventory, {
    planSha256: voicePlan.plan.planSha256,
    entries: generateEntries.map((entry) => ({
      audioId: entry.audioId,
      speechSha256: entry.speechSha256,
      estimatedBytes: entry.estimatedBytes,
    })),
  });
  const forecast = await forecastF005Capacity(workspace, capacityPlan, baseline, {
    candidateSha256: capacityPlan.candidateSha256,
    claims: capacityPlan.expectedClaims,
  });
  const artifact = {
    schemaVersion: '1.0.0',
    kind: 'f005-capacity-forecast',
    batchId: 'F005',
    workId: WORK_ID,
    voicePlanPath: VOICE_PLAN_PATH,
    voicePlanArtifactSha256: sha256(voicePlanText),
    voicePlanSha256: voicePlan.plan.planSha256,
    plannedGenerateAudioBytes: estimatedGenerateBytes,
    capacityPlan,
    forecast,
    warnings: capacityWarnings(forecast),
  };
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...FORECAST_PATH.split('/')),
    artifact,
  );
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    forecastPath: FORECAST_PATH,
    forecastSha256: sha256(canonicalJson(artifact)),
    plannedGenerateAudioBytes: estimatedGenerateBytes,
    predictedPeakBytes: forecast.predictedPeakBytes,
    freeAfterPeakBytes: forecast.freeAfterPeakBytes,
    warnings: artifact.warnings,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
