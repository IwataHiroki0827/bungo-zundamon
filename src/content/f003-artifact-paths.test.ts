import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  projectDistPreviewPaths,
  projectIntegratedBuildPaths,
  projectVoiceDiffPlanPaths,
  projectVoiceGenerationPaths,
  resolveVoiceDiffPlanPaths,
  resolveVoiceGenerationPaths,
} from './f003-artifact-paths.ts';
import type { DistPreview } from './batch-acceptance.ts';
import type { IntegratedBuild } from './batch-public.ts';
import type { VoiceDiffGenerationResult, VoiceDiffPlan } from '../voice/generation.ts';

const ROOT = resolve('tmp', 'f003-workspace');

describe('F003永続artifact path projection', () => {
  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it('voice planのcache/pathをworkspace相対POSIXへ投影しruntime時だけ絶対pathへ戻す', () => {
    const plan = {
      cacheRoot: join(ROOT, '.cache', 'voice'),
      entries: [{
        wavPath: join(ROOT, '.cache', 'voice', 'config', 'audio.wav'),
        metadataPath: join(ROOT, '.cache', 'voice', 'config', 'audio.json'),
      }],
    } as unknown as VoiceDiffPlan;
    const persisted = projectVoiceDiffPlanPaths(ROOT, plan);
    expect(persisted.cacheRoot).toBe('.cache/voice');
    expect(persisted.entries[0]).toMatchObject({
      wavPath: '.cache/voice/config/audio.wav',
      metadataPath: '.cache/voice/config/audio.json',
    });
    expect(JSON.stringify(persisted)).not.toMatch(/[A-Za-z]:|\\\\|workspace/iu);
    const runtime = resolveVoiceDiffPlanPaths(ROOT, persisted);
    expect(runtime.cacheRoot).toBe(join(ROOT, '.cache', 'voice'));
    expect(runtime.entries[0]!.wavPath).toBe(join(ROOT, '.cache', 'voice', 'config', 'audio.wav'));
  });

  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it('generation/preview rootを相対化し、generationだけ安全にruntime resolveする', () => {
    const generation = {
      stagingRoot: join(ROOT, '.cache', 'voice-stage'),
      assets: [{ sourcePath: join(ROOT, '.cache', 'voice-stage', 'audio.wav') }],
    } as unknown as VoiceDiffGenerationResult;
    const persisted = projectVoiceGenerationPaths(ROOT, generation);
    expect(persisted.stagingRoot).toBe('.cache/voice-stage');
    expect(persisted.assets[0]!.sourcePath).toBe('.cache/voice-stage/audio.wav');
    expect(resolveVoiceGenerationPaths(ROOT, persisted).assets[0]!.sourcePath)
      .toBe(join(ROOT, '.cache', 'voice-stage', 'audio.wav'));

    const content = projectIntegratedBuildPaths(ROOT, {
      stagingRoot: join(ROOT, '.cache', 'preview'),
    } as IntegratedBuild);
    const dist = projectDistPreviewPaths(ROOT, {
      outputRoot: join(ROOT, '.cache', 'pages'),
    } as unknown as DistPreview);
    expect(content.stagingRoot).toBe('.cache/preview');
    expect(dist.outputRoot).toBe('.cache/pages');
  });

  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it.each([
    'C:\\Users\\owner\\secret.wav',
    '../outside.wav',
    '.cache\\voice\\audio.wav',
    '/absolute/audio.wav',
    '//server/share/audio.wav',
    '.cache/voice//audio.wav',
    '.cache/voice/file?x',
    '.cache/voice/file#x',
    '.cache/voice/file:stream',
    '.cache/voice/%2foutside.wav',
    '.cache/voice/%5Coutside.wav',
    '.cache/voice/%00audio.wav',
    '.cache/voice/audio\n.wav',
  ])('永続artifactの絶対path・逸脱・backslashを拒否する: %s', (unsafe) => {
    const persisted = {
      cacheRoot: '.cache/voice',
      entries: [{ wavPath: unsafe, metadataPath: '.cache/voice/audio.json' }],
    } as unknown as VoiceDiffPlan;
    expect(() => resolveVoiceDiffPlanPaths(ROOT, persisted)).toThrow();
  });

  /** @des DES-F003-008 @fun FUN-F003-019 @test UT-F003-019 */
  it('workspace外の絶対pathを投影しない', () => {
    const generation = {
      stagingRoot: join(ROOT, '.cache', 'voice-stage'),
      assets: [{ sourcePath: resolve(ROOT, '..', 'outside', 'audio.wav') }],
    } as unknown as VoiceDiffGenerationResult;
    expect(() => projectVoiceGenerationPaths(ROOT, generation)).toThrow();
  });
});
