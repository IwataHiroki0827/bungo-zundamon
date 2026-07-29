import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PNG } from 'pngjs';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  isMintedF005ApprovedBatchContext,
  type F005ApprovedBatchContext,
} from './f005-context.ts';

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNGJS_VERSION = '7.0.0';
const PNGJS_INTEGRITY =
  'sha512-LKWqWJRhstyYo9pGvgor/ivk2w94eSjE3RGVuzLGlr3NmD8bf7RcYGze1mNdEHRP6TRP6rMuDHk5t44hnTRyow==';
const MAX_ENCODED_BYTES = 16_777_216;
const MAX_DIMENSION = 4_096;
const MAX_PIXELS = 16_777_216;
const MAX_RGBA_BYTES = 67_108_864;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH =
  /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?![A-Za-z][A-Za-z0-9+.-]*:)[A-Za-z0-9._/-]+$/u;
const sealedProvenances = new WeakSet<object>();
const rehydratedProvenances = new WeakSet<object>();
const artworkAcceptances = new WeakSet<object>();

declare const dHashBrand: unique symbol;
export type DHash64 = string & { readonly [dHashBrand]: true };

export type F005ArtworkErrorCode =
  | 'F005_PNG_PREFLIGHT_INVALID'
  | 'F005_PNG_DECODER_INTEGRITY_INVALID'
  | 'F005_ARTWORK_PROVENANCE_INVALID'
  | 'F005_ARTWORK_BINDING_INVALID'
  | 'F005_ARTWORK_EXISTING_INVALID'
  | 'F005_ARTWORK_NEAR_DUPLICATE';

export class F005ArtworkError extends Error {
  constructor(
    public readonly code: F005ArtworkErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F005ArtworkError';
  }
}

export interface F005ArtworkPolicySnapshot {
  readonly policyId: 'openai-terms' | 'zundamon-character-guideline';
  readonly url:
    | 'https://openai.com/policies/terms-of-use/'
    | 'https://zunko.jp/guideline.html';
  readonly contentSha256: string;
  readonly fetchedAt: string;
  readonly decision: 'allow' | 'allowed-original-fan-art';
}

export const F005_ARTWORK_POLICY_SNAPSHOTS = Object.freeze({
  providerTerms: Object.freeze({
    policyId: 'openai-terms' as const,
    url: 'https://openai.com/policies/terms-of-use/' as const,
    contentSha256: '043449f1a2b1c49d3fd644449e895ce8971469b45eefbca38771195854288496',
    fetchedAt: '2026-07-25T10:50:10.610Z',
    decision: 'allow' as const,
  }),
  characterGuideline: Object.freeze({
    policyId: 'zundamon-character-guideline' as const,
    url: 'https://zunko.jp/guideline.html' as const,
    contentSha256: 'd1c146255cac9e3d9432b73787c22b6faf33df4454fc314720ceb9c1c0bf115d',
    fetchedAt: '2026-07-25T10:50:10.493Z',
    decision: 'allowed-original-fan-art' as const,
  }),
});

interface PngPreflight {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly orientation: number;
}

interface DecodedRgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly bitDepth: number;
  readonly colorType: number;
}

export interface ArtworkGenerationV4Input {
  readonly generator: string;
  readonly generatorVersion: string;
  readonly tool: string;
  readonly providerTerms: F005ArtworkPolicySnapshot;
  readonly characterGuideline: F005ArtworkPolicySnapshot;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly generatedAt: string;
  readonly originalImageBytes: Uint8Array;
}

export interface ArtworkProcessingInputV4 {
  readonly order: number;
  readonly inputId: string;
  readonly path: string;
  readonly origin: 'generated-original';
  readonly bytes: Uint8Array;
}

export interface ArtworkInputsV4 {
  readonly referenceInputs: readonly [];
  readonly processingInputs: readonly ArtworkProcessingInputV4[];
}

export interface F005FinalArtworkInput {
  readonly sourcePath: 'content/batches/F005/public-files/artwork/natsume-zundamon.png';
  readonly publicPath: 'artwork/natsume-zundamon.png';
  readonly credit: string;
  readonly bytes: Uint8Array;
}

export interface ArtworkProvenanceV4 {
  readonly schemaVersion: '4.0.0';
  readonly manifestId: 'artwork-F005-000148-v1';
  readonly batchId: 'F005';
  readonly authorId: '000148';
  readonly creationMethod: 'original-generation';
  readonly approvalBinding: Readonly<{
    readonly requirementApprovalSnapshot: string;
    readonly definitionSha256: string;
    readonly candidateIdentitySha256: string;
    readonly implementationCommit: string;
  }>;
  readonly authorIdentity: Readonly<{
    readonly authorId: '000148';
    readonly name: 'なつめそうせき';
    readonly originalName: '夏目漱石';
    readonly slug: 'natsume-soseki';
    readonly identitySha256: string;
  }>;
  readonly generation: Readonly<{
    readonly generator: string;
    readonly generatorVersion: string;
    readonly tool: string;
    readonly providerTerms: F005ArtworkPolicySnapshot;
    readonly characterGuideline: F005ArtworkPolicySnapshot;
    readonly prompt: string;
    readonly promptSha256: string;
    readonly negativePrompt: string;
    readonly negativePromptSha256: string;
    readonly generatedAt: string;
    readonly originalImageSha256: Sha256;
    readonly originalImageBytes: number;
  }>;
  readonly inputs: Readonly<{
    readonly referenceInputs: readonly [];
    readonly generatedOriginal: Readonly<{
      readonly sha256: Sha256;
      readonly bytes: number;
    }>;
    readonly processingInputs: readonly Readonly<{
      readonly order: number;
      readonly inputId: string;
      readonly path: string;
      readonly origin: 'generated-original';
      readonly sha256: string;
      readonly bytes: number;
    }>[];
    readonly finalInputSha256: Sha256;
    readonly finalInputBytes: number;
    readonly allInputLineageSha256: Sha256;
  }>;
  readonly output: Readonly<{
    readonly sourcePath: F005FinalArtworkInput['sourcePath'];
    readonly publicPath: F005FinalArtworkInput['publicPath'];
    readonly sha256: Sha256;
    readonly bytes: number;
    readonly mediaType: 'image/png';
    readonly width: number;
    readonly height: number;
    readonly bitDepth: number;
    readonly colorType: number;
    readonly dHash64: DHash64;
  }>;
  readonly credit: string;
  readonly provenanceSha256: Sha256;
}

export interface ExistingArtworkInput {
  readonly authorId: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly dHash64: DHash64;
}

export interface ArtworkAcceptance {
  readonly result: 'pass';
  readonly path: F005FinalArtworkInput['publicPath'];
  readonly alt: '夏目漱石をイメージしたずんだもんの独自イラスト';
  readonly sha256: Sha256;
  readonly dHash64: DHash64;
  readonly sourceProvenancePath: 'content/batches/F005/artwork-provenance.json';
  readonly publicProvenancePath: 'content/artwork-provenance/F005.json';
  readonly provenancePath: 'content/artwork-provenance/F005.json';
  readonly provenanceSha256: Sha256;
  readonly credit: string;
  readonly authorIdentitySha256:
    '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f';
  readonly comparisons: readonly Readonly<{
    readonly authorId: string;
    readonly path: string;
    readonly byteIdentical: false;
    readonly hammingDistance: number;
  }>[];
  readonly minimumHammingDistance: number;
}

function artworkError(
  code: F005ArtworkErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new F005ArtworkError(code, message, options);
}

function sha256(value: Uint8Array | string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 65_536;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value.slice(0, 19));
}

function exactPolicySnapshot(
  actual: unknown,
  expected: F005ArtworkPolicySnapshot,
): actual is F005ArtworkPolicySnapshot {
  return isRecord(actual) &&
    exactKeys(actual, ['contentSha256', 'decision', 'fetchedAt', 'policyId', 'url']) &&
    canonicalJson(actual) === canonicalJson(expected);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function parseExifOrientation(bytes: Uint8Array): number {
  if (bytes.byteLength < 8) return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf TIFF headerが不足しています');
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf byte orderが不正です');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint16 = (offset: number): number => view.getUint16(offset, little);
  const uint32 = (offset: number): number => view.getUint32(offset, little);
  if (uint16(2) !== 42) return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf TIFF magicが不正です');
  const ifdOffset = uint32(4);
  if (ifdOffset > bytes.byteLength - 2) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf IFDが範囲外です');
  }
  const count = uint16(ifdOffset);
  if (count > 4_096 || ifdOffset + 2 + count * 12 > bytes.byteLength) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf IFD entryが範囲外です');
  }
  let orientation: number | null = null;
  for (let index = 0; index < count; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    if (uint16(offset) !== 0x0112) continue;
    if (orientation !== null || uint16(offset + 2) !== 3 || uint32(offset + 4) !== 1) {
      return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf orientation schemaが不正です');
    }
    orientation = uint16(offset + 8);
  }
  if (orientation === null || orientation < 1 || orientation > 8) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIf orientation値が不正です');
  }
  return orientation;
}

function preflightPng(bytes: Uint8Array): PngPreflight {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ENCODED_BYTES ||
    bytes.byteLength < 45 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'PNG signatureまたはencoded上限が不正です');
  }
  let offset = 8;
  let chunkIndex = 0;
  let ihdr: PngPreflight | null = null;
  let idatCount = 0;
  let iendCount = 0;
  let exifCount = 0;
  while (offset <= bytes.byteLength - 12) {
    const length = readUint32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    const next = offset + 12 + length;
    if (next > bytes.byteLength || !/^[A-Za-z]{4}$/u.test(type)) {
      return artworkError('F005_PNG_PREFLIGHT_INVALID', 'PNG chunk境界が不正です');
    }
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) {
      return artworkError('F005_PNG_PREFLIGHT_INVALID', 'IHDRが先頭にありません');
    }
    if (type === 'IHDR') {
      if (ihdr !== null || length !== 13) {
        return artworkError('F005_PNG_PREFLIGHT_INVALID', 'IHDRが重複または不正です');
      }
      const width = readUint32(payload, 0);
      const height = readUint32(payload, 4);
      const pixels = width * height;
      const rgbaBytes = pixels * 4;
      if (
        width < 1 || height < 1 ||
        width > MAX_DIMENSION || height > MAX_DIMENSION ||
        !Number.isSafeInteger(pixels) || pixels > MAX_PIXELS ||
        !Number.isSafeInteger(rgbaBytes) || rgbaBytes > MAX_RGBA_BYTES
      ) {
        return artworkError('F005_PNG_PREFLIGHT_INVALID', 'PNG dimension/pixel/RGBA上限を超えています');
      }
      ihdr = {
        width,
        height,
        bitDepth: payload[8]!,
        colorType: payload[9]!,
        orientation: 1,
      };
    } else if (type === 'IDAT') {
      idatCount += 1;
    } else if (type === 'IEND') {
      if (length !== 0) return artworkError('F005_PNG_PREFLIGHT_INVALID', 'IENDが不正です');
      iendCount += 1;
      if (next !== bytes.byteLength) {
        return artworkError('F005_PNG_PREFLIGHT_INVALID', 'IEND後のtrailing bytesを拒否しました');
      }
    } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      return artworkError('F005_PNG_PREFLIGHT_INVALID', 'animated PNGは許可されません');
    } else if (type === 'eXIf') {
      exifCount += 1;
      if (exifCount !== 1 || !ihdr) {
        return artworkError('F005_PNG_PREFLIGHT_INVALID', 'eXIfが重複または不正位置です');
      }
      const current = ihdr as PngPreflight;
      ihdr = {
        width: current.width,
        height: current.height,
        bitDepth: current.bitDepth,
        colorType: current.colorType,
        orientation: parseExifOrientation(payload),
      };
    }
    offset = next;
    chunkIndex += 1;
  }
  if (!ihdr || idatCount === 0 || iendCount !== 1 || offset !== bytes.byteLength) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'PNG必須chunkが不足しています');
  }
  return Object.freeze(ihdr);
}

/** 設計で固定したpngjs 7.0.0のlockfile integrityを検証する。 */
export function verifyPngjsLockfileIntegrity(lockfileText: string): void {
  let value: unknown;
  try {
    value = JSON.parse(lockfileText);
  } catch (error) {
    return artworkError('F005_PNG_DECODER_INTEGRITY_INVALID', 'package-lock.jsonを解析できません', { cause: error });
  }
  if (!isRecord(value) || !isRecord(value.packages) ||
    !isRecord(value.packages['node_modules/pngjs'])) {
    return artworkError('F005_PNG_DECODER_INTEGRITY_INVALID', 'pngjs lock entryがありません');
  }
  const entry = value.packages['node_modules/pngjs'];
  if (entry.version !== PNGJS_VERSION || entry.integrity !== PNGJS_INTEGRITY) {
    return artworkError('F005_PNG_DECODER_INTEGRITY_INVALID', 'pngjs version/integrityが固定値と一致しません');
  }
}

function decodePng(bytes: Uint8Array): DecodedRgba {
  try {
    verifyPngjsLockfileIntegrity(
      readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8'),
    );
  } catch (error) {
    if (error instanceof F005ArtworkError) throw error;
    return artworkError(
      'F005_PNG_DECODER_INTEGRITY_INVALID',
      'package-lock.jsonを安全に読めません',
      { cause: error },
    );
  }
  const preflight = preflightPng(bytes);
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(bytes), {
      checkCRC: true,
      skipRescale: false,
    });
  } catch (error) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'pngjs decodeに失敗しました', { cause: error });
  }
  if (
    decoded.width !== preflight.width ||
    decoded.height !== preflight.height ||
    decoded.data.byteLength !== decoded.width * decoded.height * 4
  ) {
    return artworkError('F005_PNG_PREFLIGHT_INVALID', 'PNG decode結果がpreflightと一致しません');
  }
  const oriented = applyOrientation(
    decoded.width,
    decoded.height,
    new Uint8Array(decoded.data),
    preflight.orientation,
  );
  return Object.freeze({
    ...oriented,
    bitDepth: preflight.bitDepth,
    colorType: preflight.colorType,
  });
}

function applyOrientation(
  width: number,
  height: number,
  data: Uint8Array,
  orientation: number,
): Pick<DecodedRgba, 'width' | 'height' | 'data'> {
  if (orientation === 1) return { width, height, data };
  const swap = orientation >= 5;
  const outputWidth = swap ? height : width;
  const outputHeight = swap ? width : height;
  const output = new Uint8Array(data.byteLength);
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      let sourceX: number;
      let sourceY: number;
      if (orientation === 2) [sourceX, sourceY] = [width - 1 - x, y];
      else if (orientation === 3) [sourceX, sourceY] = [width - 1 - x, height - 1 - y];
      else if (orientation === 4) [sourceX, sourceY] = [x, height - 1 - y];
      else if (orientation === 5) [sourceX, sourceY] = [y, x];
      else if (orientation === 6) [sourceX, sourceY] = [y, height - 1 - x];
      else if (orientation === 7) [sourceX, sourceY] = [width - 1 - y, height - 1 - x];
      else [sourceX, sourceY] = [width - 1 - y, x];
      const source = (sourceY * width + sourceX) * 4;
      const target = (y * outputWidth + x) * 4;
      output[target] = data[source]!;
      output[target + 1] = data[source + 1]!;
      output[target + 2] = data[source + 2]!;
      output[target + 3] = data[source + 3]!;
    }
  }
  return { width: outputWidth, height: outputHeight, data: output };
}

function compositedLuma(decoded: DecodedRgba): Uint8Array {
  const result = new Uint8Array(decoded.width * decoded.height);
  for (let index = 0; index < result.length; index += 1) {
    const source = index * 4;
    const alpha = decoded.data[source + 3]!;
    const red = Math.floor(
      (decoded.data[source]! * alpha + 255 * (255 - alpha) + 127) / 255,
    );
    const green = Math.floor(
      (decoded.data[source + 1]! * alpha + 255 * (255 - alpha) + 127) / 255,
    );
    const blue = Math.floor(
      (decoded.data[source + 2]! * alpha + 255 * (255 - alpha) + 127) / 255,
    );
    result[index] = Math.floor((299 * red + 587 * green + 114 * blue + 500) / 1_000);
  }
  return result;
}

function fixedCoordinate(output: number, sourceSize: number, outputSize: number): number {
  const denominator = outputSize * 2;
  const numerator = (output * 2 + 1) * sourceSize - outputSize;
  if (numerator <= 0) return 0;
  if (numerator >= (sourceSize - 1) * denominator) return (sourceSize - 1) * 65_536;
  return Math.floor((numerator * 65_536 + denominator / 2) / denominator);
}

function resizeLuma9x8(decoded: DecodedRgba): Uint8Array {
  const source = compositedLuma(decoded);
  const resized = new Uint8Array(9 * 8);
  for (let y = 0; y < 8; y += 1) {
    const fixedY = fixedCoordinate(y, decoded.height, 8);
    const y0 = Math.floor(fixedY / 65_536);
    const y1 = Math.min(decoded.height - 1, y0 + 1);
    const fractionY = fixedY - y0 * 65_536;
    const weightY0 = 65_536 - fractionY;
    for (let x = 0; x < 9; x += 1) {
      const fixedX = fixedCoordinate(x, decoded.width, 9);
      const x0 = Math.floor(fixedX / 65_536);
      const x1 = Math.min(decoded.width - 1, x0 + 1);
      const fractionX = fixedX - x0 * 65_536;
      const weightX0 = 65_536 - fractionX;
      const sum =
        source[y0 * decoded.width + x0]! * weightX0 * weightY0 +
        source[y0 * decoded.width + x1]! * fractionX * weightY0 +
        source[y1 * decoded.width + x0]! * weightX0 * fractionY +
        source[y1 * decoded.width + x1]! * fractionX * fractionY;
      resized[y * 9 + x] = Math.floor((sum + 2_147_483_648) / 4_294_967_296);
    }
  }
  return resized;
}

/**
 * PNG実体から白背景alpha合成、BT.601、9x8 bilinear後のdHash64-v1を求める。
 * @des DES-F005-008 @fun FUN-F005-028
 */
export function computeDHash64V1(pngBytes: Uint8Array): DHash64 {
  const row = resizeLuma9x8(decodePng(pngBytes));
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits <<= 1n;
      if (row[y * 9 + x]! > row[y * 9 + x + 1]!) bits |= 1n;
    }
  }
  return bits.toString(16).padStart(16, '0') as DHash64;
}

function validateContext(context: F005ApprovedBatchContext): void {
  if (
    !isMintedF005ApprovedBatchContext(context) ||
    context.policy.requirementApprovalSnapshot !== '18e3fa50edfe5214480a65ed2e840fe49a663ee2' ||
    context.candidate.author.authorId !== '000148' ||
    context.candidate.author.identitySha256 !==
      '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f'
  ) {
    return artworkError('F005_ARTWORK_BINDING_INVALID', 'mint済みF005 approval contextが必要です');
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function provenancePayload(
  value: Omit<ArtworkProvenanceV4, 'provenanceSha256'>,
): Omit<ArtworkProvenanceV4, 'provenanceSha256'> {
  return value;
}

/**
 * 参照入力0件とapproval/author bindingを固定してArtworkProvenanceV4をsealする。
 * @des DES-F005-008 @fun FUN-F005-029
 */
export function sealF005ArtworkProvenance(
  context: F005ApprovedBatchContext,
  generation: ArtworkGenerationV4Input,
  inputs: ArtworkInputsV4,
  finalImage: F005FinalArtworkInput,
): ArtworkProvenanceV4 {
  validateContext(context);
  if (
    !isRecord(generation) ||
    !exactKeys(generation, [
      'characterGuideline', 'generatedAt', 'generator', 'generatorVersion', 'negativePrompt',
      'originalImageBytes', 'prompt', 'providerTerms', 'tool',
    ]) ||
    !nonBlank(generation.generator) || !nonBlank(generation.generatorVersion) ||
    !nonBlank(generation.tool) || !nonBlank(generation.prompt) ||
    !nonBlank(generation.negativePrompt) || !validInstant(generation.generatedAt) ||
    !(generation.originalImageBytes instanceof Uint8Array) ||
    !exactPolicySnapshot(generation.providerTerms, F005_ARTWORK_POLICY_SNAPSHOTS.providerTerms) ||
    !exactPolicySnapshot(
      generation.characterGuideline,
      F005_ARTWORK_POLICY_SNAPSHOTS.characterGuideline,
    )
  ) {
    return artworkError('F005_ARTWORK_PROVENANCE_INVALID', 'generation schema/bindingが不正です');
  }
  if (!isRecord(inputs) || !exactKeys(inputs, ['processingInputs', 'referenceInputs']) ||
    !Array.isArray(inputs.referenceInputs) || inputs.referenceInputs.length !== 0 ||
    !Array.isArray(inputs.processingInputs)) {
    return artworkError('F005_ARTWORK_PROVENANCE_INVALID', 'referenceInputsはexact []が必要です');
  }
  const original = decodePng(generation.originalImageBytes);
  void original;
  const processingIds = new Set<string>();
  const originalSha256 = sha256(generation.originalImageBytes);
  const processedInputs = inputs.processingInputs.map((input, index) => {
    const inputId = input.inputId;
    const path = input.path;
    if (!isRecord(input) || !exactKeys(input, ['bytes', 'inputId', 'order', 'origin', 'path']) ||
      input.order !== index + 1 ||
      typeof inputId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(inputId) ||
      processingIds.has(inputId) || typeof path !== 'string' || !SAFE_PATH.test(path) ||
      input.origin !== 'generated-original' || !(input.bytes instanceof Uint8Array) ||
      sha256(input.bytes) !== originalSha256 ||
      !byteIdentical(input.bytes, generation.originalImageBytes)) {
      return artworkError('F005_ARTWORK_PROVENANCE_INVALID', 'processing input lineageが不正です');
    }
    processingIds.add(inputId);
    return Object.freeze({
      order: index + 1,
      inputId,
      path,
      origin: 'generated-original' as const,
      sha256: sha256(input.bytes),
      bytes: input.bytes.byteLength,
    });
  });
  if (
    !isRecord(finalImage) ||
    !exactKeys(finalImage, ['bytes', 'credit', 'publicPath', 'sourcePath']) ||
    finalImage.sourcePath !==
      'content/batches/F005/public-files/artwork/natsume-zundamon.png' ||
    finalImage.publicPath !== 'artwork/natsume-zundamon.png' ||
    !nonBlank(finalImage.credit) ||
    /[<>]/u.test(finalImage.credit) ||
    !(finalImage.bytes instanceof Uint8Array)
  ) {
    return artworkError('F005_ARTWORK_PROVENANCE_INVALID', 'final image schema/path/creditが不正です');
  }
  const decoded = decodePng(finalImage.bytes);
  const outputSha256 = sha256(finalImage.bytes);
  if (outputSha256 !== originalSha256 ||
    !byteIdentical(finalImage.bytes, generation.originalImageBytes) ||
    processedInputs.some((input) => input.sha256 !== outputSha256 ||
      input.bytes !== finalImage.bytes.byteLength)) {
    return artworkError(
      'F005_ARTWORK_PROVENANCE_INVALID',
      'original→processing→finalのbyte-for-byte lineageが一致しません',
    );
  }
  const allInputLineageSha256 = sha256(canonicalJson({
    generatedOriginal: Object.freeze({
      bytes: generation.originalImageBytes.byteLength,
      sha256: originalSha256,
    }),
    processingInputs: processedInputs,
    referenceInputs: [],
    finalInput: {
      bytes: finalImage.bytes.byteLength,
      sha256: outputSha256,
    },
  }));
  const payload = provenancePayload({
    schemaVersion: '4.0.0',
    manifestId: 'artwork-F005-000148-v1',
    batchId: 'F005',
    authorId: '000148',
    creationMethod: 'original-generation',
    approvalBinding: {
      requirementApprovalSnapshot: context.policy.requirementApprovalSnapshot,
      definitionSha256: context.definition.sha256,
      candidateIdentitySha256: context.candidate.author.identitySha256,
      implementationCommit: context.implementationControl.implementationCommit,
    },
    authorIdentity: {
      authorId: '000148',
      name: 'なつめそうせき',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
      identitySha256: context.candidate.author.identitySha256,
    },
    generation: {
      generator: generation.generator,
      generatorVersion: generation.generatorVersion,
      tool: generation.tool,
      providerTerms: { ...generation.providerTerms },
      characterGuideline: { ...generation.characterGuideline },
      prompt: generation.prompt,
      promptSha256: sha256(generation.prompt),
      negativePrompt: generation.negativePrompt,
      negativePromptSha256: sha256(generation.negativePrompt),
      generatedAt: generation.generatedAt,
      originalImageSha256: originalSha256,
      originalImageBytes: generation.originalImageBytes.byteLength,
    },
    inputs: {
      referenceInputs: [],
      generatedOriginal: {
        sha256: originalSha256,
        bytes: generation.originalImageBytes.byteLength,
      },
      processingInputs: processedInputs,
      finalInputSha256: outputSha256,
      finalInputBytes: finalImage.bytes.byteLength,
      allInputLineageSha256,
    },
    output: {
      sourcePath: finalImage.sourcePath,
      publicPath: finalImage.publicPath,
      sha256: outputSha256,
      bytes: finalImage.bytes.byteLength,
      mediaType: 'image/png',
      width: decoded.width,
      height: decoded.height,
      bitDepth: decoded.bitDepth,
      colorType: decoded.colorType,
      dHash64: computeDHash64V1(finalImage.bytes),
    },
    credit: finalImage.credit,
  });
  const provenance = freezeDeep({
    ...payload,
    provenanceSha256: sha256(canonicalJson(payload)),
  });
  sealedProvenances.add(provenance);
  return provenance;
}

/** runtime brandをJSONへ混ぜず、永続化対象だけをcanonical JSON化する。 */
export function serializeF005ArtworkProvenance(
  provenance: ArtworkProvenanceV4,
): string {
  if (!sealedProvenances.has(provenance) && !rehydratedProvenances.has(provenance)) {
    return artworkError('F005_ARTWORK_BINDING_INVALID', 'mintされていないprovenanceです');
  }
  return canonicalJson(provenance);
}

/**
 * 再起動後にcanonical artifactと全生成入力をcontextへ再結合し、同じsealを
 * 再計算できたobjectだけをproduction用brandへrehydrateする。
 */
export function parseAndRehydrateF005ArtworkProvenance(
  context: F005ApprovedBatchContext,
  canonicalArtifact: string,
  generation: ArtworkGenerationV4Input,
  inputs: ArtworkInputsV4,
  finalImage: F005FinalArtworkInput,
): ArtworkProvenanceV4 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalArtifact);
  } catch (error) {
    return artworkError(
      'F005_ARTWORK_PROVENANCE_INVALID',
      'provenance artifactを解析できません',
      { cause: error },
    );
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== canonicalArtifact) {
    return artworkError('F005_ARTWORK_PROVENANCE_INVALID', 'provenance artifactがcanonical JSONではありません');
  }
  const expected = sealF005ArtworkProvenance(context, generation, inputs, finalImage);
  if (canonicalJson(expected) !== canonicalArtifact) {
    return artworkError(
      'F005_ARTWORK_PROVENANCE_INVALID',
      'provenance artifactをcontext/input/sealへ再結合できません',
    );
  }
  const restored = freezeDeep(parsed as unknown as ArtworkProvenanceV4);
  rehydratedProvenances.add(restored);
  return restored;
}

export function isMintedF005ArtworkProvenance(
  value: unknown,
): value is ArtworkProvenanceV4 {
  return isRecord(value) && rehydratedProvenances.has(value);
}

function hammingDistance(left: DHash64, right: DHash64): number {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

function byteIdentical(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 既存3作者画像を実体から再計算し、byte/SHA一致とdHash距離8以下を拒否する。
 * @des DES-F005-008 @fun FUN-F005-030
 */
export function verifyF005ArtworkAgainstCatalog(
  provenance: ArtworkProvenanceV4,
  finalImage: Uint8Array,
  existingArtwork: readonly ExistingArtworkInput[],
): ArtworkAcceptance {
  if (!rehydratedProvenances.has(provenance) ||
    !(finalImage instanceof Uint8Array) ||
    sha256(finalImage) !== provenance.output.sha256 ||
    finalImage.byteLength !== provenance.output.bytes ||
    computeDHash64V1(finalImage) !== provenance.output.dHash64 ||
    provenance.provenanceSha256 !== sha256(canonicalJson(
      Object.fromEntries(Object.entries(provenance).filter(([key]) => key !== 'provenanceSha256')),
    ))) {
    return artworkError('F005_ARTWORK_BINDING_INVALID', 'provenance/final image bindingが不正です');
  }
  if (!Array.isArray(existingArtwork) || existingArtwork.length !== 3) {
    return artworkError('F005_ARTWORK_EXISTING_INVALID', '既存3作者画像が必要です');
  }
  const identities = new Set<string>();
  const paths = new Set<string>();
  const comparisons = existingArtwork.map((existing) => {
    const authorId = existing.authorId;
    const path = existing.path;
    const claimedSha256 = existing.sha256;
    if (
      !isRecord(existing) ||
      !exactKeys(existing, ['authorId', 'bytes', 'dHash64', 'path', 'sha256']) ||
      !nonBlank(authorId) || authorId === '000148' ||
      identities.has(authorId) ||
      typeof path !== 'string' || !SAFE_PATH.test(path) || paths.has(path) ||
      !(existing.bytes instanceof Uint8Array) ||
      typeof claimedSha256 !== 'string' || !SHA256.test(claimedSha256)
    ) {
      return artworkError('F005_ARTWORK_EXISTING_INVALID', '既存画像identity/path/schemaが不正です');
    }
    identities.add(authorId);
    paths.add(path);
    const actualSha256 = sha256(existing.bytes);
    const actualDHash = computeDHash64V1(existing.bytes);
    if (actualSha256 !== claimedSha256 || actualDHash !== existing.dHash64) {
      return artworkError('F005_ARTWORK_EXISTING_INVALID', '既存画像の自己申告hashが実体と一致しません');
    }
    const identical = byteIdentical(finalImage, existing.bytes) ||
      provenance.output.sha256 === actualSha256;
    const distance = hammingDistance(provenance.output.dHash64, actualDHash);
    if (identical || distance <= 8) {
      return artworkError(
        'F005_ARTWORK_NEAR_DUPLICATE',
        identical ? '既存画像とbyte/SHAが一致します' : `既存画像とのdHash距離が${distance}です`,
      );
    }
    return Object.freeze({
      authorId,
      path,
      byteIdentical: false as const,
      hammingDistance: distance,
    });
  });
  const acceptance = freezeDeep({
    result: 'pass' as const,
    path: provenance.output.publicPath,
    alt: '夏目漱石をイメージしたずんだもんの独自イラスト' as const,
    sha256: provenance.output.sha256,
    dHash64: provenance.output.dHash64,
    sourceProvenancePath: 'content/batches/F005/artwork-provenance.json' as const,
    publicProvenancePath: 'content/artwork-provenance/F005.json' as const,
    provenancePath: 'content/artwork-provenance/F005.json' as const,
    provenanceSha256: provenance.provenanceSha256,
    credit: provenance.credit,
    authorIdentitySha256:
      '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f' as const,
    comparisons,
    minimumHammingDistance: Math.min(...comparisons.map((comparison) => comparison.hammingDistance)),
  });
  artworkAcceptances.add(acceptance);
  return acceptance;
}

export function isMintedF005ArtworkAcceptance(
  value: unknown,
): value is ArtworkAcceptance {
  return isRecord(value) && artworkAcceptances.has(value);
}
