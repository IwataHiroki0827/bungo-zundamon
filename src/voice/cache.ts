import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { VoiceContractError, type VoiceConfig } from './types.ts';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(value: string, name: string): string {
  if (!value.trim()) throw new VoiceContractError('voice-config-unfixed', `${name}を固定してください`);
  return value;
}

function inRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new VoiceContractError('voice-config-out-of-range', `${name}は${minimum}..${maximum}で指定してください`);
  }
  return value;
}

/** @des DES-F001-006,DES-F001-008 @fun FUN-F001-016 */
export function validateVoiceConfig(config: VoiceConfig): VoiceConfig {
  const engineVersion = required(config.engineVersion, 'engineVersion');
  const speakerUuid = required(config.speakerUuid, 'speakerUuid');
  const speakerName = required(config.speakerName, 'speakerName');
  const styleName = required(config.styleName, 'styleName');
  const presetVersion = required(config.presetVersion, 'presetVersion');
  if (!SEMVER.test(engineVersion) || !SEMVER.test(presetVersion)) {
    throw new VoiceContractError('voice-config-unfixed', 'ENGINE版とpreset版はsemverで固定してください');
  }
  if (!UUID.test(speakerUuid)) {
    throw new VoiceContractError('voice-config-unfixed', 'speaker UUIDは固定UUIDで指定してください');
  }
  if (!Number.isSafeInteger(config.styleId) || config.styleId < 0) {
    throw new VoiceContractError('voice-config-out-of-range', 'styleIdは0以上の整数で指定してください');
  }
  if (![24_000, 48_000].includes(config.outputSamplingRate)) {
    throw new VoiceContractError('voice-config-out-of-range', 'sampling rateは24000または48000で指定してください');
  }
  return {
    engineVersion,
    speakerUuid: speakerUuid.toLowerCase(),
    speakerName,
    styleId: config.styleId,
    styleName,
    speedScale: inRange(config.speedScale, 0.5, 2, 'speedScale'),
    pitchScale: inRange(config.pitchScale, -0.15, 0.15, 'pitchScale'),
    intonationScale: inRange(config.intonationScale, 0, 2, 'intonationScale'),
    volumeScale: inRange(config.volumeScale, 0, 2, 'volumeScale'),
    outputSamplingRate: config.outputSamplingRate,
    presetVersion,
  };
}

export function canonicalVoiceConfig(config: VoiceConfig): string {
  const value = validateVoiceConfig(config);
  return JSON.stringify([
    value.engineVersion,
    value.speakerUuid,
    value.speakerName,
    value.styleId,
    value.styleName,
    value.speedScale,
    value.pitchScale,
    value.intonationScale,
    value.volumeScale,
    value.outputSamplingRate,
    value.presetVersion,
  ]);
}

export function voiceConfigHash(config: VoiceConfig): string {
  return createHash('sha256').update(canonicalVoiceConfig(config), 'utf8').digest('hex');
}

/** @des DES-F001-006,DES-F001-008 @fun FUN-F001-016 */
export function createVoiceCacheKey(text: string, config: VoiceConfig): string {
  if (!text.trim()) throw new VoiceContractError('voice-text-empty', '読み上げ文は空にできません');
  if (text.includes('\0') || /[\uD800-\uDFFF]/u.test(text)) {
    throw new VoiceContractError('voice-text-invalid', '読み上げ文に不正な文字が含まれます');
  }
  const canonical = JSON.stringify([text.normalize('NFC'), JSON.parse(canonicalVoiceConfig(config))]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface VoiceFileSystem {
  prepareCache(cacheDir: string, workspaceRoot: string): Promise<string>;
  read(filePath: string): Promise<Uint8Array | null>;
  writeAtomic(filePath: string, value: Uint8Array): Promise<void>;
  remove(filePath: string): Promise<void>;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertNoReparsePoint(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new VoiceContractError('workspace-reparse-point', 'workspaceがreparse pointです');
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new VoiceContractError('cache-reparse-point', 'cache pathにreparse pointがあります');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
}

/** @des DES-F001-008,DES-F001-017,DES-F001-019 @fun FUN-F001-017 */
export class NodeVoiceFileSystem implements VoiceFileSystem {
  async prepareCache(cacheDir: string, workspaceRoot: string): Promise<string> {
    const root = await realpath(path.resolve(workspaceRoot));
    const target = path.resolve(cacheDir);
    if (!isInside(root, target)) throw new VoiceContractError('cache-outside-workspace', 'cacheはworkspace内に必要です');
    await assertNoReparsePoint(root, target);
    await mkdir(target, { recursive: true });
    const actual = await realpath(target);
    if (!isInside(root, actual)) throw new VoiceContractError('cache-outside-workspace', 'cache実体がworkspace外です');
    await assertNoReparsePoint(root, actual);
    return actual;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new VoiceContractError('cache-reparse-point', 'cache fileは通常fileである必要があります');
      }
      return new Uint8Array(await readFile(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeAtomic(filePath: string, value: Uint8Array): Promise<void> {
    const directory = path.dirname(filePath);
    const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temp, value, { flag: 'wx' });
      const info = await stat(temp);
      if (info.size !== value.byteLength) throw new VoiceContractError('cache-write-short', 'cache一時fileが不完全です');
      await rename(temp, filePath);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async remove(filePath: string): Promise<void> {
    await rm(filePath, { force: true });
  }
}
