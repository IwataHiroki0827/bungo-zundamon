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

export const VOICE_CACHE_SCHEMA_V2 = '2' as const;

export interface VoiceConfigV2 extends VoiceConfig {
  /** 省略時もv2として扱う。将来版を誤ってv2 keyへ混入させないため、指定時は2のみ許可する。 */
  cacheSchemaVersion?: string;
}

function v2Error(code: string, message: string): never {
  throw new VoiceContractError(code, message);
}

function requiredV2(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return v2Error('VOICE_CONFIG_INCOMPLETE', `${name}がありません`);
  }
  return value;
}

function numericV2(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number') return v2Error('VOICE_CONFIG_INCOMPLETE', `${name}がありません`);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return v2Error('VOICE_CONFIG_RANGE_INVALID', `${name}は${minimum}..${maximum}で指定してください`);
  }
  return value;
}

/** @des DD-F002 @fun FUN-F002-013 */
export function canonicalVoiceConfigV2(config: VoiceConfigV2): string {
  if (!config || typeof config !== 'object') return v2Error('VOICE_CONFIG_INCOMPLETE', 'VoiceConfigがありません');
  if (config.cacheSchemaVersion !== undefined && config.cacheSchemaVersion !== VOICE_CACHE_SCHEMA_V2) {
    return v2Error('VOICE_CACHE_SCHEMA_UNSUPPORTED', '未対応のvoice cache schemaです');
  }
  const engineVersion = requiredV2(config.engineVersion, 'engineVersion');
  const speakerUuid = requiredV2(config.speakerUuid, 'speakerUuid').toLowerCase();
  const speakerName = requiredV2(config.speakerName, 'speakerName');
  const styleName = requiredV2(config.styleName, 'styleName');
  const presetVersion = requiredV2(config.presetVersion, 'presetVersion');
  if (!Number.isSafeInteger(config.styleId) || config.styleId < 0) {
    if (config.styleId === undefined || config.styleId === null) return v2Error('VOICE_CONFIG_INCOMPLETE', 'styleIdがありません');
    return v2Error('VOICE_CONFIG_RANGE_INVALID', 'styleIdは0以上の整数で指定してください');
  }
  const outputSamplingRate = numericV2(config.outputSamplingRate, 24_000, 48_000, 'outputSamplingRate');
  if (outputSamplingRate !== 24_000 && outputSamplingRate !== 48_000) {
    return v2Error('VOICE_CONFIG_RANGE_INVALID', 'outputSamplingRateは24000または48000で指定してください');
  }
  return JSON.stringify({
    schemaVersion: VOICE_CACHE_SCHEMA_V2,
    engineVersion,
    speakerUuid,
    speakerName,
    styleId: config.styleId,
    styleName,
    speedScale: numericV2(config.speedScale, 0.5, 2, 'speedScale'),
    pitchScale: numericV2(config.pitchScale, -0.15, 0.15, 'pitchScale'),
    intonationScale: numericV2(config.intonationScale, 0, 2, 'intonationScale'),
    volumeScale: numericV2(config.volumeScale, 0, 2, 'volumeScale'),
    outputSamplingRate,
    presetVersion,
  });
}

export function voiceConfigHashV2(config: VoiceConfigV2): string {
  return createHash('sha256').update(canonicalVoiceConfigV2(config), 'utf8').digest('hex');
}

/** @des DD-F002 @fun FUN-F002-013 */
export function createVoiceCacheKeyV2(text: string, config: VoiceConfigV2): string {
  if (typeof text !== 'string' || text.trim() === '' || text.includes('\0') || /[\uD800-\uDFFF]/u.test(text)) {
    return v2Error('VOICE_TEXT_INVALID', '読み上げ文が不正です');
  }
  const canonical = JSON.stringify({
    schemaVersion: VOICE_CACHE_SCHEMA_V2,
    text: text.normalize('NFC'),
    config: JSON.parse(canonicalVoiceConfigV2(config)) as unknown,
  });
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
