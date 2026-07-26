import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../content/artifacts.ts';
import type { PolicyId } from './policy-snapshots.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9._/-]+$/u;
const EXPECTED_POLICY_URLS = Object.freeze({
  'openai-terms': 'https://openai.com/policies/terms-of-use/',
  'zundamon-character-guideline': 'https://zunko.jp/guideline.html',
} as const);
const trustedCoordinatorRecords = new WeakSet<object>();
const TRUSTED_COORDINATOR_BINDINGS = Object.freeze({
  'artwork-F003-000035-v1': Object.freeze({
    batchId: 'F003',
    authorId: '000035',
    outputPath: 'artwork/dazai-zundamon.png',
    recordPath: 'content/batches/F003/artwork-machine-review.json',
    recordSha256: 'f6076f11d63a542f2117fbeed463adce2e9ef079c79c11b8a83f06e2ebf4d4d1',
  }),
} as const);

export interface ArtworkPolicyReference {
  readonly policyId: PolicyId;
  readonly url: string;
  readonly contentSha256: string;
  readonly fetchedAt: string;
  readonly decisionSummary: string;
}

export interface ArtworkProvenanceInputV2 {
  readonly inputId: string;
  readonly path: string;
  readonly sha256: string;
  readonly source: string;
  readonly license: string;
  readonly redistributionAllowed: boolean;
  readonly thirdPartyDerivative: boolean;
}

export interface ArtworkProvenanceV2 {
  readonly schemaVersion: '2.0.0';
  readonly manifestId: string;
  readonly batchId: 'F002';
  readonly authorId: '000081';
  readonly creationMethod: 'original-generation';
  readonly generatedOn: string;
  readonly generation: {
    readonly provider: 'OpenAI';
    readonly tool: 'built-in image_gen';
    readonly model: 'not exposed by built-in tool';
    readonly modelVersion: 'not exposed by built-in tool';
    readonly inputImageCount: 0;
    readonly prompt: string;
    readonly promptSha256: string;
    readonly recipe: string;
    readonly recipeSha256: string;
    readonly providerTerms: ArtworkPolicyReference;
  };
  readonly inputAllowlist: readonly string[];
  readonly inputs: readonly ArtworkProvenanceInputV2[];
  readonly output: {
    readonly sourcePath: string;
    readonly publicPath: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly mediaType: 'image/png';
    readonly width: number;
    readonly height: number;
    readonly bitDepth: 8;
    readonly colorType: 'RGB';
  };
  readonly characterGuideline: ArtworkPolicyReference & {
    readonly decision: 'allowed-original-fan-art';
  };
  readonly humanReview: {
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly promptConformance: true;
    readonly noRealPhotographOrIdentifiableFace: true;
    readonly noThirdPartyMaterial: true;
    readonly noThirdPartyDerivative: true;
    readonly noTrademarkOrLogo: true;
    readonly noTextSignatureOrWatermark: true;
    readonly handsNatural: true;
    readonly decision: 'approved';
    readonly summary: string;
  };
  readonly credit: string;
}

export interface ArtworkMachineReview {
  readonly reviewerKind: 'project-factory-agent';
  readonly producerTaskPath: string;
  readonly runId: string;
  readonly modelClass: 'image-generation';
  readonly imageSha256: string;
  readonly policySha256: string;
  readonly promptSha256: string;
  readonly toolSha256: string;
  readonly decision: 'approved';
  readonly reviewedAt: string;
  readonly artifactSha256: string;
}

export interface ArtworkProvenanceV3 extends Omit<ArtworkProvenanceV2,
  'schemaVersion' | 'batchId' | 'authorId' | 'humanReview'> {
  readonly schemaVersion: '3.0.0';
  readonly batchId: string;
  readonly authorId: string;
  readonly machineReview: ArtworkMachineReview;
}

export interface ArtworkManifestIdentity {
  readonly manifestId: string;
  readonly batchId: string;
  readonly authorId: string;
  readonly outputPath: string;
}

export interface TrustedArtworkMachineReviewRecord extends ArtworkManifestIdentity {
  readonly schemaVersion: '1.0.0';
  readonly machineReview: ArtworkMachineReview;
  readonly recordSha256: string;
}

export interface ArtworkV3TrustContext {
  readonly identity: ArtworkManifestIdentity;
  readonly coordinatorRecord: TrustedArtworkMachineReviewRecord;
}

export interface ArtworkDecision {
  readonly result: 'pass';
  readonly manifestId: string;
  readonly authorId: string;
  readonly outputPath: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly inputCount: 0;
  readonly reasoning: readonly string[];
}

export class ArtworkProvenanceError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtworkProvenanceError';
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validatePolicyReference(reference: ArtworkPolicyReference, expectedId: keyof typeof EXPECTED_POLICY_URLS): void {
  if (reference.policyId !== expectedId || reference.url !== EXPECTED_POLICY_URLS[expectedId] ||
    !SHA256.test(reference.contentSha256) || !validInstant(reference.fetchedAt) ||
    !nonBlank(reference.decisionSummary)) {
    throw new ArtworkProvenanceError(
      expectedId === 'openai-terms' ? 'ARTWORK_PROVIDER_TERMS_MISSING' : 'ARTWORK_RIGHTS_MISSING',
      '画像生成時の規約観測が不完全です',
    );
  }
}

async function safeWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe workspace');
  } catch (error) {
    throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', 'workspace実体が安全ではありません', { cause: error });
  }
  return root;
}

async function readSafeOutput(root: string, path: string): Promise<Uint8Array> {
  if (!SAFE_PATH.test(path)) throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', '画像workspace pathが不正です');
  // manifest pathはここでworkspaceへ一度だけresolveし、以後同じ絶対pathを使う。
  const target = resolve(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', '画像pathがworkspace外です');
  }
  let cursor = root;
  try {
    for (const part of relation.split(sep)) {
      cursor = `${cursor}${sep}${part}`;
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', '画像pathにreparse pointがあります');
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
      throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', '画像が通常fileではありません');
    }
    return new Uint8Array(await readFile(target));
  } catch (error) {
    if (error instanceof ArtworkProvenanceError) throw error;
    throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', '画像実体を安全に読めません', { cause: error });
  }
}

function pngMetadata(bytes: Uint8Array): { width: number; height: number; bitDepth: number; colorType: string } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 26 || signature.some((value, index) => bytes[index] !== value) ||
    new TextDecoder().decode(bytes.slice(12, 16)) !== 'IHDR') {
    throw new ArtworkProvenanceError('ARTWORK_HASH_MISMATCH', '画像実体がPNGではありません');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = bytes[25] === 2 ? 'RGB' : `PNG-${bytes[25] ?? -1}`;
  return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: bytes[24] ?? -1, colorType };
}

function validateGeneration(manifest: ArtworkProvenanceV2 | ArtworkProvenanceV3): void {
  const generation = manifest.generation;
  if (manifest.creationMethod !== 'original-generation' || generation.provider !== 'OpenAI' ||
    generation.tool !== 'built-in image_gen' || generation.model !== 'not exposed by built-in tool' ||
    generation.modelVersion !== 'not exposed by built-in tool' || generation.inputImageCount !== 0 ||
    !nonBlank(generation.prompt) || !nonBlank(generation.recipe) ||
    generation.promptSha256 !== sha256(generation.prompt) || generation.recipeSha256 !== sha256(generation.recipe)) {
    throw new ArtworkProvenanceError('ARTWORK_RIGHTS_MISSING', '画像生成prompt/recipe/provider/model記録が不正です');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(manifest.generatedOn) || Number.isNaN(Date.parse(`${manifest.generatedOn}T00:00:00Z`))) {
    throw new ArtworkProvenanceError('ARTWORK_RIGHTS_MISSING', '画像生成日は実日付が必要です');
  }
  validatePolicyReference(generation.providerTerms, 'openai-terms');
}

function machineReviewCore(review: ArtworkMachineReview): Omit<ArtworkMachineReview, 'artifactSha256'> {
  const { artifactSha256: _artifactSha256, ...core } = review;
  void _artifactSha256;
  return core;
}

function coordinatorRecordCore(
  record: TrustedArtworkMachineReviewRecord,
): Omit<TrustedArtworkMachineReviewRecord, 'recordSha256'> {
  const { recordSha256: _recordSha256, ...core } = record;
  void _recordSha256;
  return core;
}

export function hashArtworkMachineReview(review: Omit<ArtworkMachineReview, 'artifactSha256'>): string {
  return sha256(canonicalJson(review));
}

export function hashTrustedArtworkMachineReviewRecord(
  record: Omit<TrustedArtworkMachineReviewRecord, 'recordSha256'>,
): string {
  return sha256(canonicalJson(record));
}

function validateMachineJudgment(
  manifest: ArtworkProvenanceV3,
  trust: ArtworkV3TrustContext | undefined,
): void {
  if (!trust || !isRecord(trust) || !isRecord(trust.identity) || !isRecord(trust.coordinatorRecord) ||
    !trustedCoordinatorRecords.has(trust.coordinatorRecord)) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'trusted machine review contextがありません');
  }
  const review = manifest.machineReview;
  const identity = trust.identity;
  const record = trust.coordinatorRecord;
  const expectedPolicySha256 = sha256(canonicalJson({
    characterGuideline: manifest.characterGuideline,
    providerTerms: manifest.generation.providerTerms,
  }));
  const expectedToolSha256 = sha256(canonicalJson({
    model: manifest.generation.model,
    modelVersion: manifest.generation.modelVersion,
    provider: manifest.generation.provider,
    tool: manifest.generation.tool,
  }));
  if (!isRecord(review) || !exactKeys(review, [
    'artifactSha256', 'decision', 'imageSha256', 'modelClass', 'policySha256',
    'producerTaskPath', 'promptSha256', 'reviewedAt', 'reviewerKind', 'runId', 'toolSha256',
  ]) ||
    review.reviewerKind !== 'project-factory-agent' ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(review.producerTaskPath) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(review.runId) ||
    review.modelClass !== 'image-generation' || review.decision !== 'approved' ||
    !validInstant(review.reviewedAt) ||
    review.imageSha256 !== manifest.output.sha256 ||
    review.policySha256 !== expectedPolicySha256 ||
    review.promptSha256 !== manifest.generation.promptSha256 ||
    review.toolSha256 !== expectedToolSha256 ||
    review.artifactSha256 !== hashArtworkMachineReview(machineReviewCore(review))) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'machine reviewのidentity/hash chainが不正です');
  }
  if (!exactKeys(identity, ['authorId', 'batchId', 'manifestId', 'outputPath']) ||
    identity.manifestId !== manifest.manifestId || identity.batchId !== manifest.batchId ||
    identity.authorId !== manifest.authorId || identity.outputPath !== manifest.output.publicPath) {
    throw new ArtworkProvenanceError('ARTWORK_RIGHTS_MISSING', 'manifest identityがtrusted contextと一致しません');
  }
  if (!exactKeys(record, [
    'authorId', 'batchId', 'machineReview', 'manifestId', 'outputPath', 'recordSha256', 'schemaVersion',
  ]) || record.schemaVersion !== '1.0.0' ||
    record.manifestId !== identity.manifestId || record.batchId !== identity.batchId ||
    record.authorId !== identity.authorId || record.outputPath !== identity.outputPath ||
    canonicalJson(record.machineReview) !== canonicalJson(review) ||
    record.recordSha256 !== hashTrustedArtworkMachineReviewRecord(coordinatorRecordCore(record))) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'trusted coordinator記録とmachine reviewが一致しません');
  }
}

/**
 * ProjectFactoryが固定したrecord bindingからmachine reviewを再検証して信頼済みobjectを返す。
 * @des DES-F003-009 @fun FUN-F003-024 @ut UT-F003-024
 */
export async function loadAndVerifyTrustedArtworkMachineReview(
  workspace: string,
  identity: ArtworkManifestIdentity,
): Promise<ArtworkV3TrustContext> {
  if (!exactKeys(identity, ['authorId', 'batchId', 'manifestId', 'outputPath'])) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'artwork identity exact schemaが不正です');
  }
  const binding = TRUSTED_COORDINATOR_BINDINGS[
    identity.manifestId as keyof typeof TRUSTED_COORDINATOR_BINDINGS
  ];
  if (!binding || binding.batchId !== identity.batchId || binding.authorId !== identity.authorId ||
    binding.outputPath !== identity.outputPath) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'ProjectFactory bindingにないartwork identityです');
  }
  const root = await safeWorkspace(workspace);
  const bytes = await readSafeOutput(root, binding.recordPath);
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error('not canonical');
  } catch {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'coordinator recordがcanonical JSONではありません');
  }
  if (!isRecord(value) || !exactKeys(value, [
    'authorId', 'batchId', 'machineReview', 'manifestId', 'outputPath', 'recordSha256', 'schemaVersion',
  ]) || value.schemaVersion !== '1.0.0' || value.manifestId !== identity.manifestId ||
    value.batchId !== identity.batchId || value.authorId !== identity.authorId ||
    value.outputPath !== identity.outputPath || value.recordSha256 !== binding.recordSha256 ||
    !isRecord(value.machineReview)) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'coordinator recordが固定bindingと一致しません');
  }
  const record = value as unknown as TrustedArtworkMachineReviewRecord;
  if (record.machineReview.artifactSha256 !==
      hashArtworkMachineReview(machineReviewCore(record.machineReview)) ||
    record.recordSha256 !== hashTrustedArtworkMachineReviewRecord(coordinatorRecordCore(record))) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', 'coordinator recordのhash chainが不正です');
  }
  const restored: TrustedArtworkMachineReviewRecord = Object.freeze({
    schemaVersion: '1.0.0',
    manifestId: record.manifestId,
    batchId: record.batchId,
    authorId: record.authorId,
    outputPath: record.outputPath,
    machineReview: Object.freeze({ ...record.machineReview }),
    recordSha256: record.recordSha256,
  });
  trustedCoordinatorRecords.add(restored);
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    coordinatorRecord: restored,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validateHumanJudgment(manifest: ArtworkProvenanceV2): void {
  const review = manifest.humanReview;
  if (!nonBlank(review.reviewer) || !validInstant(review.reviewedAt) || review.decision !== 'approved' ||
    review.promptConformance !== true || review.noRealPhotographOrIdentifiableFace !== true ||
    review.noThirdPartyMaterial !== true || review.noThirdPartyDerivative !== true ||
    review.noTrademarkOrLogo !== true || review.noTextSignatureOrWatermark !== true ||
    review.handsNatural !== true || !nonBlank(review.summary) || !nonBlank(manifest.credit)) {
    throw new ArtworkProvenanceError('ARTWORK_REVIEW_MISSING', '画像の人による目視判断またはcreditが不完全です');
  }
}

/** @des DES-F002-010 DES-F002-012 @fun FUN-F002-012 */
export async function validateArtworkProvenance(
  manifest: ArtworkProvenanceV2 | ArtworkProvenanceV3,
  workspace: string,
  trust?: ArtworkV3TrustContext,
): Promise<ArtworkDecision> {
  const isV2 = manifest.schemaVersion === '2.0.0';
  const isV3 = manifest.schemaVersion === '3.0.0';
  if ((!isV2 && !isV3) || !nonBlank(manifest.manifestId) ||
    isV2 && (manifest.batchId !== 'F002' || manifest.authorId !== '000081')) {
    throw new ArtworkProvenanceError('ARTWORK_RIGHTS_MISSING', '作者別画像provenance identityが不正です');
  }
  if (isV3 && !exactKeys(manifest, [
    'authorId', 'batchId', 'characterGuideline', 'creationMethod', 'credit', 'generatedOn',
    'generation', 'inputAllowlist', 'inputs', 'machineReview', 'manifestId', 'output', 'schemaVersion',
  ])) {
    throw new ArtworkProvenanceError('ARTWORK_RIGHTS_MISSING', 'ArtworkProvenanceV3 exact schemaが不正です');
  }
  validateGeneration(manifest);
  if (manifest.characterGuideline.decision !== 'allowed-original-fan-art') {
    throw new ArtworkProvenanceError('ARTWORK_RIGHTS_MISSING', 'ずんだもんガイドライン判断がありません');
  }
  validatePolicyReference(manifest.characterGuideline, 'zundamon-character-guideline');
  if (manifest.inputAllowlist.length !== 0 || manifest.inputs.length !== 0 || manifest.generation.inputImageCount !== 0) {
    const thirdParty = manifest.inputs.some((input) => input.thirdPartyDerivative);
    throw new ArtworkProvenanceError(
      thirdParty ? 'ARTWORK_THIRD_PARTY_DERIVATIVE' : 'ARTWORK_INPUT_UNTRUSTED',
      '独自生成画像は参照入力0件である必要があります',
    );
  }
  if (isV2) validateHumanJudgment(manifest);
  else validateMachineJudgment(manifest, trust);
  const expectedSourcePath = `content/batches/${manifest.batchId}/public-files/${manifest.output.publicPath}`;
  if (manifest.output.sourcePath !== expectedSourcePath ||
    isV2 && manifest.output.publicPath !== 'artwork/miyazawa-zundamon.png' ||
    !SAFE_PATH.test(manifest.output.publicPath) || !SHA256.test(manifest.output.sha256) ||
    !Number.isSafeInteger(manifest.output.bytes) || manifest.output.bytes <= 0 ||
    manifest.output.mediaType !== 'image/png') {
    throw new ArtworkProvenanceError('ARTWORK_PATH_UNSAFE', '画像workspace/public path契約が不正です');
  }
  const root = await safeWorkspace(workspace);
  const bytes = await readSafeOutput(root, manifest.output.sourcePath);
  const metadata = pngMetadata(bytes);
  if (sha256(bytes) !== manifest.output.sha256 || bytes.byteLength !== manifest.output.bytes ||
    metadata.width !== manifest.output.width || metadata.height !== manifest.output.height ||
    metadata.bitDepth !== manifest.output.bitDepth || metadata.colorType !== manifest.output.colorType) {
    throw new ArtworkProvenanceError('ARTWORK_HASH_MISMATCH', '画像実体のhash/bytes/PNG metadataがmanifestと一致しません');
  }
  return Object.freeze({
    result: 'pass',
    manifestId: manifest.manifestId,
    authorId: manifest.authorId,
    outputPath: manifest.output.publicPath,
    outputSha256: manifest.output.sha256,
    outputBytes: manifest.output.bytes,
    inputCount: 0,
    reasoning: Object.freeze([
      manifest.generation.providerTerms.decisionSummary,
      manifest.characterGuideline.decisionSummary,
      isV2 ? manifest.humanReview.summary : `machine review: ${manifest.machineReview.artifactSha256}`,
    ]),
  });
}
