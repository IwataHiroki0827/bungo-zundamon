import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContentUpdate, type UpdateStage } from '../src/content/pipeline.ts';
import {
  COMPLETE_PRODUCTION_CONTENT_STAGES,
  createCompleteProductionStageRunner,
} from '../src/content/production-final.ts';
import { BatchCommandError, runBatchCommand, serializeBatchCommandResult } from '../src/content/batch-command.ts';
import { createProductionBatchDependencies } from '../src/content/batch-runtime.ts';

const EXIT_CODES: Readonly<Record<(typeof COMPLETE_PRODUCTION_CONTENT_STAGES)[number], number>> = Object.freeze({
  bibliography: 2,
  select: 3,
  sources: 4,
  provenance: 5,
  decode: 6,
  extract: 7,
  normalize: 8,
  review: 9,
  'voice-preflight': 10,
  voice: 11,
  build: 12,
});

export function requestedStages(argument: string | undefined): readonly UpdateStage[] {
  if (argument === undefined || argument === 'all') return COMPLETE_PRODUCTION_CONTENT_STAGES;
  if ((COMPLETE_PRODUCTION_CONTENT_STAGES as readonly string[]).includes(argument)) return [argument as UpdateStage];
  throw new Error('CLI_ARGUMENT_INVALID');
}

export function exitCodeForDiagnostic(value: unknown): number {
  if (value === null || typeof value !== 'object' || !('stage' in value)) return 1;
  const stage = (value as { stage?: unknown }).stage;
  return typeof stage === 'string' && stage in EXIT_CODES
    ? EXIT_CODES[stage as keyof typeof EXIT_CODES]
    : 1;
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const arguments_ = process.argv.slice(2);
  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027
  if (arguments_.includes('--batch')) {
    try {
      const result = await runBatchCommand(arguments_, workspace, createProductionBatchDependencies());
      process.stdout.write(serializeBatchCommandResult(result));
    } catch (error) {
      const diagnostic = error instanceof BatchCommandError
        ? { ok: false, code: error.code, stage: error.stage, message: error.message }
        : { ok: false, code: 'BATCH_RUNTIME_FAILURE', message: error instanceof Error ? error.message : 'unknown error' };
      process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
      process.exitCode = error instanceof BatchCommandError ? error.exitCode : 1;
    }
    return;
  }
  const stages = requestedStages(arguments_[0]);
  try {
    const summary = await runContentUpdate({
      workspace,
      runner: createCompleteProductionStageRunner(),
      stages,
      outputPaths: [
        'data/bibliography',
        'data/selected-works.json',
        'data/sources',
        'data/intermediate',
        'content/reviews',
        'content/provenance.json',
        'content/reviewed-content.json',
        'content/voice-config.json',
        'content/voice-preflight.json',
        'content/voice-generation.json',
        'content/asset-manifest.json',
        '.cache/voice/F001',
        'public',
        'docs/evidence/content/CONTENT-F001-production-extraction.json',
        'docs/evidence/content/CONTENT-F001-reviewed.json',
        'docs/evidence/content/CONTENT-F001-voice-generation.json',
        'docs/evidence/content/CONTENT-F001-public-build.json',
      ],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, stages: summary.stages, counts: summary.counts })}\n`);
  } catch (error) {
    const diagnostic = error !== null && typeof error === 'object' && 'diagnostic' in error
      ? (error as { diagnostic: unknown }).diagnostic
      : { reasonCode: 'CLI_INPUT_OR_RUNTIME_FAILURE' };
    process.stderr.write(`${JSON.stringify({ ok: false, diagnostic })}\n`);
    process.exitCode = exitCodeForDiagnostic(diagnostic);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
