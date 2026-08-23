import { createHash } from 'node:crypto';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  computeDHash64V1,
  F005ArtworkError,
  type DHash64,
} from './f005-artwork.ts';

/**
 * F009（夢野久作3作品追加）専用の作者画像provenance軽量schema。
 *
 * DD-F009.md FUN-F009-014/015のとおり、F001〜F005共有のOpenAI内蔵image_gen
 * ツール専用検証（`src/notices/artwork-provenance.ts`）は一切変更・再利用
 * しない。F009の作者画像もF006〜F008と同様にローカルComfyUI（FLUX.1 schnell）
 * で生成しており、`provider === 'OpenAI'`固定検証を通せないため。
 *
 * PNG decode・dHash64計算だけは`f005-artwork.ts`のfeature非依存pure関数
 * `computeDHash64V1`（内部で`verifyPngjsLockfileIntegrity`・PNG preflight・
 * pngjs decodeを行う）をそのまま再利用する。
 *
 * 本セッション（2026-08-23）はローカルComfyUI（FLUX.1 schnell）で夢野久作の
 * 作者画像を実生成し（`content/batches/F009/public-files/artwork/
 * yumeno-kyusaku-zundamon.png`）、既存8作者画像との非近似重複確認まで完了
 * している。本ファイルはDD-F009.mdが要求するschema/検証関数の実装。
 *
 * @des DES-F009-012 @fun FUN-F009-014 FUN-F009-015
 */

const SHA256 = /^[a-f0-9]{64}$/u;
const sealedProvenances = new WeakSet<object>();
const rehydratedProvenances = new WeakSet<object>();
const artworkAcceptances = new WeakSet<object>();

export type F009ArtworkErrorCode =
  | 'F009_ARTWORK_PROVENANCE_INVALID'
  | 'F009_ARTWORK_BINDING_INVALID'
  | 'F009_ARTWORK_EXISTING_INVALID'
  | 'F009_ARTWORK_NEAR_DUPLICATE';

export class F009ArtworkError extends Error {
  constructor(
    public readonly code: F009ArtworkErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F009ArtworkError';
  }
}

export interface F009ArtworkManifestIdentity {
  readonly batchId: 'F009';
  readonly authorId: '000096';
  readonly outputPath: 'artwork/yumeno-kyusaku-zundamon.png';
}

export interface ArtworkGenerationF009Input {
  readonly generator: 'ComfyUI (local)';
  readonly generatorVersion: string;
  readonly model: string;
  readonly workflow: string;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly seed: number;
  readonly generatedAt: string;
  readonly originalImageBytes: Uint8Array;
}

export interface ArtworkInputsF009 {
  readonly referenceInputs: readonly [];
}

export interface F009FinalArtworkInput {
  readonly sourcePath: 'content/batches/F009/public-files/artwork/yumeno-kyusaku-zundamon.png';
  readonly publicPath: 'artwork/yumeno-kyusaku-zundamon.png';
  readonly credit: string;
  readonly bytes: Uint8Array;
}

export interface ArtworkProvenanceF009 {
  readonly schemaVersion: '1.0.0';
  readonly manifestId: 'artwork-F009-000096-v1';
  readonly identity: F009ArtworkManifestIdentity;
  readonly generation: Readonly<{
    readonly generator: 'ComfyUI (local)';
    readonly generatorVersion: string;
    readonly model: string;
    readonly workflow: string;
    readonly prompt: string;
    readonly promptSha256: Sha256;
    readonly negativePrompt: string;
    readonly negativePromptSha256: Sha256;
    readonly seed: number;
    readonly generatedAt: string;
    readonly originalImageSha256: Sha256;
    readonly originalImageBytes: number;
  }>;
  readonly inputs: Readonly<{
    readonly referenceInputs: readonly [];
  }>;
  readonly output: Readonly<{
    readonly sourcePath: F009FinalArtworkInput['sourcePath'];
    readonly publicPath: F009FinalArtworkInput['publicPath'];
    readonly sha256: Sha256;
    readonly bytes: number;
    readonly mediaType: 'image/png';
    readonly dHash64: DHash64;
  }>;
  readonly credit: string;
  readonly provenanceSha256: Sha256;
}

export interface ExistingArtworkInputF009 {
  readonly authorId: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly dHash64: DHash64;
}

export interface ArtworkAcceptanceF009 {
  readonly result: 'pass';
  readonly path: F009FinalArtworkInput['publicPath'];
  readonly alt: '夢野久作をイメージしたずんだもんの独自イラスト';
  readonly sha256: Sha256;
  readonly dHash64: DHash64;
  readonly sourceProvenancePath: 'content/batches/F009/artwork-provenance.json';
  readonly provenanceSha256: Sha256;
  readonly credit: string;
  readonly comparisons: readonly Readonly<{
    readonly authorId: string;
    readonly path: string;
    readonly byteIdentical: false;
    readonly hammingDistance: number;
  }>[];
  readonly minimumHammingDistance: number;
}

function artworkError(
  code: F009ArtworkErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new F009ArtworkError(code, message, options);
}

function sha256(value: Uint8Array | string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 65_536;
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 65_536;
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

function byteIdentical(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

/** F005実装済みのpngjs decoderを経由してdHash64を求める。decode失敗はF009側codeへ変換する。 */
function safeComputeDHash64(bytes: Uint8Array): DHash64 {
  try {
    return computeDHash64V1(bytes);
  } catch (error) {
    if (error instanceof F005ArtworkError) {
      return artworkError('F009_ARTWORK_PROVENANCE_INVALID', `PNG decodeに失敗しました: ${error.message}`, { cause: error });
    }
    throw error;
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
  value: Omit<ArtworkProvenanceF009, 'provenanceSha256'>,
): Omit<ArtworkProvenanceF009, 'provenanceSha256'> {
  return value;
}

/**
 * exact final image path・参照入力exact []・実際の生成情報のみを記録した
 * ArtworkProvenanceF009をsealする。捏造した値は一切書かず、`generation`引数の
 * 実値だけをcanonical化する。
 * @des DES-F009-012 @fun FUN-F009-014 @ut UT-F009-014
 */
export function sealF009ArtworkProvenance(
  generation: ArtworkGenerationF009Input,
  inputs: ArtworkInputsF009,
  finalImage: F009FinalArtworkInput,
): ArtworkProvenanceF009 {
  if (
    !isRecord(generation) ||
    !exactKeys(generation, [
      'generatedAt', 'generator', 'generatorVersion', 'model', 'negativePrompt',
      'originalImageBytes', 'prompt', 'seed', 'workflow',
    ]) ||
    generation.generator !== 'ComfyUI (local)' ||
    !nonBlank(generation.generatorVersion) || !nonBlank(generation.model) ||
    !nonBlank(generation.workflow) || !nonBlank(generation.prompt) ||
    !boundedString(generation.negativePrompt) ||
    !Number.isInteger(generation.seed) || generation.seed < 0 ||
    !validInstant(generation.generatedAt) ||
    !(generation.originalImageBytes instanceof Uint8Array)
  ) {
    return artworkError('F009_ARTWORK_PROVENANCE_INVALID', 'generation schemaが不正です');
  }
  if (
    !isRecord(inputs) || !exactKeys(inputs, ['referenceInputs']) ||
    !Array.isArray(inputs.referenceInputs) || inputs.referenceInputs.length !== 0
  ) {
    return artworkError('F009_ARTWORK_PROVENANCE_INVALID', 'referenceInputsはexact []が必要です');
  }
  if (
    !isRecord(finalImage) ||
    !exactKeys(finalImage, ['bytes', 'credit', 'publicPath', 'sourcePath']) ||
    finalImage.sourcePath !==
      'content/batches/F009/public-files/artwork/yumeno-kyusaku-zundamon.png' ||
    finalImage.publicPath !== 'artwork/yumeno-kyusaku-zundamon.png' ||
    !nonBlank(finalImage.credit) ||
    /[<>]/u.test(finalImage.credit) ||
    !(finalImage.bytes instanceof Uint8Array)
  ) {
    return artworkError('F009_ARTWORK_PROVENANCE_INVALID', 'final image schema/path/creditが不正です');
  }
  const originalSha256 = sha256(generation.originalImageBytes);
  const outputSha256 = sha256(finalImage.bytes);
  if (
    outputSha256 !== originalSha256 ||
    !byteIdentical(finalImage.bytes, generation.originalImageBytes)
  ) {
    return artworkError(
      'F009_ARTWORK_PROVENANCE_INVALID',
      '生成原本と最終画像のbyte-for-byte一致が取れません',
    );
  }
  const dHash64 = safeComputeDHash64(finalImage.bytes);
  const payload = provenancePayload({
    schemaVersion: '1.0.0',
    manifestId: 'artwork-F009-000096-v1',
    identity: {
      batchId: 'F009',
      authorId: '000096',
      outputPath: finalImage.publicPath,
    },
    generation: {
      generator: generation.generator,
      generatorVersion: generation.generatorVersion,
      model: generation.model,
      workflow: generation.workflow,
      prompt: generation.prompt,
      promptSha256: sha256(generation.prompt),
      negativePrompt: generation.negativePrompt,
      negativePromptSha256: sha256(generation.negativePrompt),
      seed: generation.seed,
      generatedAt: generation.generatedAt,
      originalImageSha256: originalSha256,
      originalImageBytes: generation.originalImageBytes.byteLength,
    },
    inputs: {
      referenceInputs: [],
    },
    output: {
      sourcePath: finalImage.sourcePath,
      publicPath: finalImage.publicPath,
      sha256: outputSha256,
      bytes: finalImage.bytes.byteLength,
      mediaType: 'image/png',
      dHash64,
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
export function serializeF009ArtworkProvenance(
  provenance: ArtworkProvenanceF009,
): string {
  if (!sealedProvenances.has(provenance) && !rehydratedProvenances.has(provenance)) {
    return artworkError('F009_ARTWORK_BINDING_INVALID', 'mintされていないprovenanceです');
  }
  return canonicalJson(provenance);
}

/**
 * 再起動後にcanonical artifactと生成入力から同じsealを再計算できた場合だけ、
 * production用brandへrehydrateする。
 */
export function parseAndRehydrateF009ArtworkProvenance(
  canonicalArtifact: string,
  generation: ArtworkGenerationF009Input,
  inputs: ArtworkInputsF009,
  finalImage: F009FinalArtworkInput,
): ArtworkProvenanceF009 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalArtifact);
  } catch (error) {
    return artworkError(
      'F009_ARTWORK_PROVENANCE_INVALID',
      'provenance artifactを解析できません',
      { cause: error },
    );
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== canonicalArtifact) {
    return artworkError('F009_ARTWORK_PROVENANCE_INVALID', 'provenance artifactがcanonical JSONではありません');
  }
  const expected = sealF009ArtworkProvenance(generation, inputs, finalImage);
  if (canonicalJson(expected) !== canonicalArtifact) {
    return artworkError(
      'F009_ARTWORK_PROVENANCE_INVALID',
      'provenance artifactをgeneration/inputs/sealへ再結合できません',
    );
  }
  const restored = freezeDeep(parsed as unknown as ArtworkProvenanceF009);
  rehydratedProvenances.add(restored);
  return restored;
}

export function isMintedF009ArtworkProvenance(
  value: unknown,
): value is ArtworkProvenanceF009 {
  return isRecord(value) && (sealedProvenances.has(value) || rehydratedProvenances.has(value));
}

/**
 * 既存7作者画像を実体から再計算し、byte一致とdHash距離8以下を
 * `F009_ARTWORK_NEAR_DUPLICATE`として拒否する。authorId `000096`が既存7作者と
 * 衝突しないことも検証する。既存作者数の判定はF006がF007統合時に踏んだ実バグ
 * （`existingArtwork.length !== N`のexact一致チェックが将来の作者追加で
 * 破綻した、2026-08-22 commit `cd5ecc8`）を踏まえ、F008に続き実装当初から
 * `existingArtwork.length < 7`（下限判定）とする。
 * @des DES-F009-012 @fun FUN-F009-015 @ut UT-F009-015
 */
export function verifyF009ArtworkAgainstCatalog(
  provenance: ArtworkProvenanceF009,
  finalImage: Uint8Array,
  existingArtwork: readonly ExistingArtworkInputF009[],
): ArtworkAcceptanceF009 {
  if (
    !(sealedProvenances.has(provenance) || rehydratedProvenances.has(provenance)) ||
    !(finalImage instanceof Uint8Array) ||
    sha256(finalImage) !== provenance.output.sha256 ||
    finalImage.byteLength !== provenance.output.bytes ||
    safeComputeDHash64(finalImage) !== provenance.output.dHash64 ||
    provenance.provenanceSha256 !== sha256(canonicalJson(
      Object.fromEntries(Object.entries(provenance).filter(([key]) => key !== 'provenanceSha256')),
    ))
  ) {
    return artworkError('F009_ARTWORK_BINDING_INVALID', 'provenance/final image bindingが不正です');
  }
  // 既存作者数は下限判定（`< 7`）とし、将来のF010統合時に既存作者数が8に増えても
  // 再修正不要となるようにする（FUN-F009-014の設計判断を参照）。
  if (!Array.isArray(existingArtwork) || existingArtwork.length < 7) {
    return artworkError('F009_ARTWORK_EXISTING_INVALID', '既存7作者以上の画像が必要です');
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
      !nonBlank(authorId) || authorId === '000096' ||
      identities.has(authorId) ||
      typeof path !== 'string' || path.length === 0 || paths.has(path) ||
      !(existing.bytes instanceof Uint8Array) ||
      typeof claimedSha256 !== 'string' || !SHA256.test(claimedSha256)
    ) {
      return artworkError('F009_ARTWORK_EXISTING_INVALID', '既存画像identity/path/schemaが不正です');
    }
    identities.add(authorId);
    paths.add(path);
    const actualSha256 = sha256(existing.bytes);
    const actualDHash = safeComputeDHash64(existing.bytes);
    if (actualSha256 !== claimedSha256 || actualDHash !== existing.dHash64) {
      return artworkError('F009_ARTWORK_EXISTING_INVALID', '既存画像の自己申告hashが実体と一致しません');
    }
    const identical = byteIdentical(finalImage, existing.bytes) ||
      provenance.output.sha256 === actualSha256;
    const distance = hammingDistance(provenance.output.dHash64, actualDHash);
    if (identical || distance <= 8) {
      return artworkError(
        'F009_ARTWORK_NEAR_DUPLICATE',
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
    alt: '夢野久作をイメージしたずんだもんの独自イラスト' as const,
    sha256: provenance.output.sha256,
    dHash64: provenance.output.dHash64,
    sourceProvenancePath: 'content/batches/F009/artwork-provenance.json' as const,
    provenanceSha256: provenance.provenanceSha256,
    credit: provenance.credit,
    comparisons,
    minimumHammingDistance: Math.min(...comparisons.map((comparison) => comparison.hammingDistance)),
  });
  artworkAcceptances.add(acceptance);
  return acceptance;
}

export function isMintedF009ArtworkAcceptance(
  value: unknown,
): value is ArtworkAcceptanceF009 {
  return isRecord(value) && artworkAcceptances.has(value);
}
