import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { DistPreview } from './batch-acceptance.ts';
import type { IntegratedBuild } from './batch-public.ts';
import type {
  VoiceDiffGenerationResult,
  VoiceDiffPlan,
} from '../voice/generation.ts';

export class F003ArtifactPathError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'F003ArtifactPathError';
  }
}

function fail(code: string, message: string): never {
  throw new F003ArtifactPathError(code, message);
}

function rootOf(workspace: string): string {
  if (!isAbsolute(workspace)) return fail('F003_ARTIFACT_WORKSPACE_UNSAFE', 'workspaceは絶対pathが必要です');
  return resolve(workspace);
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function validRelativePosix(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !/^[A-Za-z]:/u.test(value) &&
    !containsControl(value) && !/[%:?#\\]/u.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}

function descendant(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/** runtime absolute pathを永続artifact用workspace相対POSIX pathへ写像する。 */
export function projectWorkspaceArtifactPath(workspace: string, runtimePath: string): string {
  const root = rootOf(workspace);
  if (validRelativePosix(runtimePath)) return runtimePath;
  if (!isAbsolute(runtimePath)) {
    return fail('F003_ARTIFACT_PATH_UNSAFE', 'runtime pathは絶対pathまたは正規相対POSIX pathが必要です');
  }
  const target = resolve(runtimePath);
  if (!descendant(root, target)) {
    return fail('F003_ARTIFACT_PATH_UNSAFE', 'workspace外pathをartifactへ保存できません');
  }
  const projected = relative(root, target).split(sep).join('/');
  if (!validRelativePosix(projected)) {
    return fail('F003_ARTIFACT_PATH_UNSAFE', 'artifact pathを相対POSIXへ正規化できません');
  }
  return projected;
}

/** 永続artifact pathをfilesystem API直前にだけworkspace絶対pathへ解決する。 */
export function resolveWorkspaceArtifactPath(workspace: string, persistedPath: string): string {
  const root = rootOf(workspace);
  if (!validRelativePosix(persistedPath)) {
    return fail('F003_ARTIFACT_PATH_UNSAFE', '永続artifactに絶対path・backslash・逸脱があります');
  }
  const target = resolve(root, ...persistedPath.split('/'));
  if (!descendant(root, target)) {
    return fail('F003_ARTIFACT_PATH_UNSAFE', '永続artifact pathがworkspace外です');
  }
  return target;
}

/** @des DES-F003-008 @fun FUN-F003-019 */
export function projectVoiceDiffPlanPaths(workspace: string, plan: VoiceDiffPlan): VoiceDiffPlan {
  return {
    ...plan,
    cacheRoot: projectWorkspaceArtifactPath(workspace, plan.cacheRoot),
    entries: plan.entries.map((entry) => ({
      ...entry,
      wavPath: projectWorkspaceArtifactPath(workspace, entry.wavPath),
      metadataPath: projectWorkspaceArtifactPath(workspace, entry.metadataPath),
    })),
  };
}

/** @des DES-F003-008 @fun FUN-F003-019 */
export function resolveVoiceDiffPlanPaths(workspace: string, plan: VoiceDiffPlan): VoiceDiffPlan {
  return {
    ...plan,
    cacheRoot: resolveWorkspaceArtifactPath(workspace, plan.cacheRoot),
    entries: plan.entries.map((entry) => ({
      ...entry,
      wavPath: resolveWorkspaceArtifactPath(workspace, entry.wavPath),
      metadataPath: resolveWorkspaceArtifactPath(workspace, entry.metadataPath),
    })),
  };
}

/** @des DES-F003-008 @fun FUN-F003-019 */
export function projectVoiceGenerationPaths(
  workspace: string,
  generation: VoiceDiffGenerationResult,
): VoiceDiffGenerationResult {
  return {
    ...generation,
    stagingRoot: projectWorkspaceArtifactPath(workspace, generation.stagingRoot),
    assets: generation.assets.map((asset) => ({
      ...asset,
      sourcePath: projectWorkspaceArtifactPath(workspace, asset.sourcePath),
    })),
  };
}

/** @des DES-F003-008 @fun FUN-F003-019 */
export function resolveVoiceGenerationPaths(
  workspace: string,
  generation: VoiceDiffGenerationResult,
): VoiceDiffGenerationResult {
  return {
    ...generation,
    stagingRoot: resolveWorkspaceArtifactPath(workspace, generation.stagingRoot),
    assets: generation.assets.map((asset) => ({
      ...asset,
      sourcePath: resolveWorkspaceArtifactPath(workspace, asset.sourcePath),
    })),
  };
}

/** @des DES-F003-008 @fun FUN-F003-019 */
export function projectIntegratedBuildPaths(workspace: string, build: IntegratedBuild): IntegratedBuild {
  return {
    ...build,
    stagingRoot: projectWorkspaceArtifactPath(workspace, build.stagingRoot),
  };
}

/** @des DES-F003-008 @fun FUN-F003-019 */
export function projectDistPreviewPaths(workspace: string, preview: DistPreview): DistPreview {
  if (typeof preview.outputRoot !== 'string') {
    return fail('F003_ARTIFACT_PATH_UNSAFE', 'dist preview outputRootがありません');
  }
  return {
    ...preview,
    outputRoot: projectWorkspaceArtifactPath(workspace, preview.outputRoot),
  };
}
