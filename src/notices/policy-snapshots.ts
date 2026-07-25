import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkServerIdentity } from 'node:tls';

import { isPublicAddress } from '../content/source.ts';

export const POLICY_MAX_RESPONSE_BYTES = 8_388_608;
export const POLICY_TIMEOUT_MS = 15_000;
export const POLICY_TRANSPORT_VERSION = 'policy-https-pinned-v1';

const BATCH_ID = /^F[0-9]{3}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ALLOWED_MEDIA_TYPES = Object.freeze(['text/html', 'text/plain', 'application/xhtml+xml'] as const);

const POLICY_ALLOWLIST = Object.freeze({
  'aozora-handling': Object.freeze({
    url: 'https://www.aozora.gr.jp/guide/kijyunn.html',
    versionOrLabel: '青空文庫 収録ファイルの取り扱い規準',
  }),
  'voicevox-terms': Object.freeze({
    url: 'https://voicevox.hiroshiba.jp/term/',
    versionOrLabel: 'VOICEVOX 利用規約',
  }),
  'zundamon-audio-terms': Object.freeze({
    url: 'https://zunko.jp/con_ongen_kiyaku.html',
    versionOrLabel: '東北ずん子・ずんだもんプロジェクト 音源利用規約',
  }),
  'zundamon-character-guideline': Object.freeze({
    url: 'https://zunko.jp/guideline.html',
    versionOrLabel: '東北ずん子・ずんだもんプロジェクト キャラクター利用ガイドライン',
  }),
  'openai-terms': Object.freeze({
    url: 'https://openai.com/policies/terms-of-use/',
    versionOrLabel: 'OpenAI Terms of Use',
  }),
} as const);

export type PolicyId = keyof typeof POLICY_ALLOWLIST;
export type PolicyImpactArea = 'dialogue' | 'audio' | 'artwork' | 'credit';

export interface PolicyDefinition {
  readonly policyId: PolicyId;
  readonly batchId: string;
  readonly url: string;
  readonly versionOrLabel: string;
  readonly allowedMediaTypes: readonly string[];
  readonly trustedProjectRoot: string;
  readonly workspace: string;
}

export interface PolicySecurityProof {
  readonly dnsAddresses: readonly string[];
  readonly connectedAddress: string;
  readonly tlsAuthorized: true;
  readonly hostnameVerified: true;
  readonly redirectsFollowed: 0;
  readonly proxyUsed: false;
  readonly attempts: 1;
}

export interface PolicyTransportResponse {
  readonly status: number;
  readonly mediaType: string;
  readonly body: Uint8Array;
  readonly finalUrl: string;
  readonly elapsedMs: number;
  readonly fetchedAt: string;
  readonly transportVersion: string;
  readonly security: PolicySecurityProof;
}

export interface SafePolicyTransport {
  request(definition: PolicyDefinition): Promise<PolicyTransportResponse>;
}

export interface FetchedPolicyResponse extends PolicyTransportResponse {
  readonly policyId: PolicyId;
  readonly requestedUrl: string;
}

export interface PolicyObservation {
  readonly batchId: string;
  readonly policyId: PolicyId;
  readonly url: string;
  readonly finalUrl: string;
  readonly status: 200;
  readonly mediaType: string;
  readonly responseBytes: number;
  readonly fetchedAt: string;
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly transportVersion: string;
  readonly versionOrLabel: string;
  readonly reviewer: string;
  readonly decisionSummary: string;
  readonly phase: 'selection' | 'predeploy';
  readonly releaseCommit?: string;
  readonly runId?: string;
}

export interface ImpactReview {
  readonly policyId: PolicyId;
  readonly selectionSha256: string;
  readonly predeploySha256: string;
  readonly releaseCommit: string;
  readonly runId: string;
  readonly impacts: readonly PolicyImpactArea[];
  readonly decision: 'approved';
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly summary: string;
}

export interface PolicyDecision {
  readonly status: 'unchanged' | 'changed-reviewed' | 'blocked';
  readonly releaseCommit: string;
  readonly runId: string;
  readonly impacts: readonly PolicyImpactArea[];
  readonly evidence: readonly {
    policyId: PolicyId;
    selectionSha256: string;
    predeploySha256: string;
    status: 'unchanged' | 'changed-reviewed' | 'blocked';
  }[];
  readonly reasonCodes: readonly string[];
}

export interface PolicyPinnedRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostHeader: string;
  readonly serverName: string;
  readonly rejectUnauthorized: true;
  readonly checkServerIdentity: true;
  readonly followRedirects: false;
  readonly useEnvironmentProxy: false;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export interface ProductionPolicyTransportOptions {
  readonly resolver?: (hostname: string) => Promise<readonly { address: string; family?: 4 | 6 }[]>;
  readonly pinnedSocketFactory?: (request: PolicyPinnedRequest) => Promise<PolicyTransportResponse>;
  readonly clock?: () => number;
  readonly proxy?: false;
}

export class PolicySnapshotError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PolicySnapshotError';
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

function containsSecret(value: string): boolean {
  return /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|https:\/\/[^/\s:]+:[^@\s]+@)/u.test(value);
}

function validGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA.test(value);
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value) && !containsSecret(value);
}

function normalizedMediaType(value: unknown): string {
  return typeof value === 'string' ? value.split(';', 1)[0]?.trim().toLowerCase() ?? '' : '';
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort((left, right) => left.localeCompare(right, 'en')).join('\0') ===
    [...expected].sort((left, right) => left.localeCompare(right, 'en')).join('\0');
}

function expectedPolicy(policyId: string): (typeof POLICY_ALLOWLIST)[PolicyId] | undefined {
  return Object.prototype.hasOwnProperty.call(POLICY_ALLOWLIST, policyId)
    ? POLICY_ALLOWLIST[policyId as PolicyId]
    : undefined;
}

function assertCanonicalDefinition(definition: PolicyDefinition): URL {
  const expected = expectedPolicy(definition.policyId);
  if (!expected || definition.url !== expected.url || definition.versionOrLabel !== expected.versionOrLabel ||
    !BATCH_ID.test(definition.batchId) || !isAbsolute(definition.trustedProjectRoot) ||
    !isAbsolute(definition.workspace) ||
    definition.allowedMediaTypes.length !== ALLOWED_MEDIA_TYPES.length ||
    definition.allowedMediaTypes.some((value, index) => value !== ALLOWED_MEDIA_TYPES[index])) {
    throw new PolicySnapshotError('POLICY_URL_NOT_ALLOWED', '規約定義がexact allowlistと一致しません');
  }
  let url: URL;
  try { url = new URL(definition.url); } catch (error) {
    throw new PolicySnapshotError('POLICY_URL_NOT_ALLOWED', '規約URLが不正です', { cause: error });
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || url.href !== expected.url) {
    throw new PolicySnapshotError('POLICY_URL_NOT_ALLOWED', '規約URLはexact canonical HTTPSである必要があります');
  }
  return url;
}

/** @des DES-F002-009 DES-F002-012 @fun FUN-F002-010 FUN-F002-035 */
export function createPolicyDefinitions(
  trustedProjectRoot: string,
  workspace: string,
  batchId = 'F002',
): readonly PolicyDefinition[] {
  if (!isAbsolute(trustedProjectRoot) || !isAbsolute(workspace) || !BATCH_ID.test(batchId)) {
    throw new PolicySnapshotError('POLICY_URL_NOT_ALLOWED', 'trusted project root、workspace、batch IDが不正です');
  }
  return Object.freeze(Object.entries(POLICY_ALLOWLIST).map(([policyId, value]) => Object.freeze({
    policyId: policyId as PolicyId,
    batchId,
    url: value.url,
    versionOrLabel: value.versionOrLabel,
    allowedMediaTypes: ALLOWED_MEDIA_TYPES,
    trustedProjectRoot: resolve(trustedProjectRoot),
    workspace: resolve(workspace),
  })));
}

function validateSecurityProof(definition: PolicyDefinition, response: PolicyTransportResponse): void {
  const proof = response && typeof response === 'object'
    ? (response as { security?: Partial<PolicySecurityProof> }).security
    : undefined;
  if (!proof || !hasExactKeys(proof, [
    'attempts', 'connectedAddress', 'dnsAddresses', 'hostnameVerified',
    'proxyUsed', 'redirectsFollowed', 'tlsAuthorized',
  ])) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', 'transport security proof schemaが不正です');
  }
  const addresses = proof?.dnsAddresses;
  if (!Array.isArray(addresses) || addresses.length === 0 ||
    addresses.some((address) => typeof address !== 'string' || !isPublicAddress(address))) {
    throw new PolicySnapshotError('POLICY_DNS_PRIVATE', 'DNS全回答がpublic addressではありません');
  }
  if (typeof proof?.connectedAddress !== 'string' || !isPublicAddress(proof.connectedAddress) ||
    !addresses.includes(proof.connectedAddress)) {
    throw new PolicySnapshotError('POLICY_DNS_REBIND', '接続IPが検証済みDNS回答と一致しません');
  }
  if (proof.tlsAuthorized !== true || proof.hostnameVerified !== true) {
    throw new PolicySnapshotError('POLICY_TLS_INVALID', 'TLSまたはhostname検証が不正です');
  }
  if (proof.redirectsFollowed !== 0 || response.finalUrl !== definition.url) {
    throw new PolicySnapshotError('POLICY_REDIRECTED', '規約取得のredirect/final URL差分を拒否しました');
  }
  if (proof.proxyUsed !== false) {
    throw new PolicySnapshotError('POLICY_PROXY_FORBIDDEN', '規約取得でproxyは使用できません');
  }
  if (proof.attempts !== 1) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', '規約取得はretryなしの1試行である必要があります');
  }
}

function validateFetchedResponse(definition: PolicyDefinition, response: PolicyTransportResponse): string {
  if (!response || typeof response !== 'object' || !isByteArray(response.body)) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', '規約response schema/body bindingが不正です');
  }
  validateSecurityProof(definition, response);
  if (!Number.isSafeInteger(response.status)) {
    throw new PolicySnapshotError('POLICY_STATUS_INVALID', '規約取得HTTP statusが整数ではありません');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new PolicySnapshotError('POLICY_REDIRECTED', '規約取得のredirect responseを拒否しました');
  }
  if (response.status !== 200) {
    throw new PolicySnapshotError('POLICY_STATUS_INVALID', `規約取得HTTP statusが不正です: ${response.status}`);
  }
  const mediaType = normalizedMediaType(response.mediaType);
  if (!definition.allowedMediaTypes.includes(mediaType)) {
    throw new PolicySnapshotError('POLICY_MEDIA_INVALID', `規約media typeが不正です: ${mediaType}`);
  }
  if (response.body.byteLength > POLICY_MAX_RESPONSE_BYTES) {
    throw new PolicySnapshotError('POLICY_TOO_LARGE', '規約responseが8 MiBを超えています');
  }
  if (!Number.isFinite(response.elapsedMs) || response.elapsedMs < 0 || response.elapsedMs >= POLICY_TIMEOUT_MS) {
    throw new PolicySnapshotError('POLICY_TIMEOUT', '規約取得が15秒の境界へ到達しました');
  }
  if (typeof response.fetchedAt !== 'string' || !validInstant(response.fetchedAt) ||
    response.transportVersion !== POLICY_TRANSPORT_VERSION || response.finalUrl !== definition.url) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', '規約responseのURL/取得時刻/transport版が不正です');
  }
  return mediaType;
}

/** @des DES-F002-009 DES-F002-012 DES-F002-015 @fun FUN-F002-035 */
export async function fetchPolicyObservation(
  definition: PolicyDefinition,
  transport: SafePolicyTransport,
): Promise<FetchedPolicyResponse> {
  assertCanonicalDefinition(definition);
  const response = await transport.request(definition);
  const mediaType = validateFetchedResponse(definition, response);
  return Object.freeze({
    ...response,
    body: new Uint8Array(response.body),
    mediaType,
    policyId: definition.policyId,
    requestedUrl: definition.url,
  });
}

async function safeWorkspace(trustedProjectRoot: string, workspace: string): Promise<string> {
  if (!isAbsolute(trustedProjectRoot) || !isAbsolute(workspace)) {
    throw new PolicySnapshotError('POLICY_SNAPSHOT_WRITE_FAILED', 'project root/workspaceは絶対pathが必要です');
  }
  const projectRoot = resolve(trustedProjectRoot);
  const root = resolve(workspace);
  const pathComponents = root.split(sep).map((part) => part.toLowerCase());
  if (pathComponents.includes('public') || pathComponents.includes('content')) {
    throw new PolicySnapshotError('POLICY_SNAPSHOT_WRITE_FAILED', 'public/content配下を規約snapshot workspaceにはできません');
  }
  try {
    const [projectInfo, workspaceInfo, projectReal, workspaceReal] = await Promise.all([
      lstat(projectRoot), lstat(root), realpath(projectRoot), realpath(root),
    ]);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink() ||
      !workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() ||
      projectReal !== projectRoot || workspaceReal !== root ||
      projectReal !== workspaceReal || projectRoot !== root) {
      throw new Error('workspace is not exact trusted project root');
    }
  } catch (error) {
    throw new PolicySnapshotError('POLICY_SNAPSHOT_WRITE_FAILED', 'workspaceがtrusted project root実体と完全一致しません', { cause: error });
  }
  return root;
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('unsafe cache directory');
}

async function writeRawSnapshot(definition: PolicyDefinition, digest: string, body: Uint8Array): Promise<void> {
  const root = await safeWorkspace(definition.trustedProjectRoot, definition.workspace);
  const components = ['.cache', 'rights', definition.batchId, definition.policyId];
  let directory = root;
  let temporary: string | undefined;
  try {
    for (const component of components) {
      directory = join(directory, component);
      await ensureDirectory(directory);
    }
    const target = join(directory, `${digest}.snapshot`);
    const relation = relative(root, target);
    if (relation.startsWith(`..${sep}`) || relation === '..' || relation.split(sep).includes('public')) {
      throw new Error('snapshot escaped cache');
    }
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink() || sha256(await readFile(target)) !== digest) {
        throw new Error('existing snapshot mismatch');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    temporary = undefined;
    const persisted = await lstat(target);
    if (!persisted.isFile() || persisted.isSymbolicLink() || sha256(await readFile(target)) !== digest) {
      throw new Error('persisted snapshot mismatch');
    }
  } catch (error) {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    throw new PolicySnapshotError('POLICY_SNAPSHOT_WRITE_FAILED', 'raw規約snapshotをatomic保存できません', { cause: error });
  }
}

/** @des DES-F002-009 DES-F002-012 DES-F002-015 @fun FUN-F002-010 */
export async function capturePolicyObservation(
  policy: PolicyDefinition,
  response: FetchedPolicyResponse,
  context: { phase: 'selection' | 'predeploy'; releaseCommit?: string; runId?: string },
  now: Date,
  reviewer: string,
  decisionSummary: string,
): Promise<PolicyObservation> {
  assertCanonicalDefinition(policy);
  const mediaType = validateFetchedResponse(policy, response);
  if (!hasExactKeys(response, [
    'body', 'elapsedMs', 'fetchedAt', 'finalUrl', 'mediaType', 'policyId',
    'requestedUrl', 'security', 'status', 'transportVersion',
  ]) || response.policyId !== policy.policyId || response.requestedUrl !== policy.url) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', '安全transport responseが規約定義へ完全結合されていません');
  }
  const selectionContext = context.phase === 'selection' && context.releaseCommit === undefined && context.runId === undefined;
  const predeployContext = context.phase === 'predeploy' && validGitSha(context.releaseCommit) && validRunId(context.runId);
  if (!selectionContext && !predeployContext) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', 'selection/predeploy candidate contextが不正です');
  }
  const observedAt = now.getTime();
  if (!nonBlank(reviewer) || !nonBlank(decisionSummary) || containsSecret(reviewer) ||
    containsSecret(decisionSummary) || !Number.isFinite(observedAt) || observedAt < Date.parse(response.fetchedAt)) {
    throw new PolicySnapshotError('POLICY_RESPONSE_UNBOUND', 'reviewer/decision/clockが不正です');
  }
  const digest = sha256(response.body);
  await writeRawSnapshot(policy, digest, response.body);
  return Object.freeze({
    batchId: policy.batchId,
    policyId: policy.policyId,
    url: policy.url,
    finalUrl: response.finalUrl,
    status: 200,
    mediaType,
    responseBytes: response.body.byteLength,
    fetchedAt: response.fetchedAt,
    observedAt: now.toISOString(),
    contentSha256: digest,
    transportVersion: response.transportVersion,
    versionOrLabel: policy.versionOrLabel,
    reviewer,
    decisionSummary,
    phase: context.phase,
    ...(context.phase === 'predeploy' ? { releaseCommit: context.releaseCommit, runId: context.runId } : {}),
  });
}

function validObservation(
  value: unknown,
  phase: 'selection' | 'predeploy',
  expected: { releaseCommit: string; runId: string; batchId: string },
): value is PolicyObservation {
  if (!value || typeof value !== 'object') return false;
  const observation = value as Partial<PolicyObservation>;
  const commonKeys = [
    'batchId', 'contentSha256', 'decisionSummary', 'fetchedAt', 'finalUrl', 'mediaType',
    'observedAt', 'phase', 'policyId', 'responseBytes', 'reviewer', 'status',
    'transportVersion', 'url', 'versionOrLabel',
  ];
  const keys = phase === 'predeploy' ? [...commonKeys, 'releaseCommit', 'runId'] : commonKeys;
  const policy = typeof observation.policyId === 'string' ? expectedPolicy(observation.policyId) : undefined;
  if (!hasExactKeys(value, keys) || !policy || observation.batchId !== expected.batchId ||
    observation.url !== policy.url || observation.finalUrl !== policy.url ||
    observation.versionOrLabel !== policy.versionOrLabel || observation.status !== 200 ||
    normalizedMediaType(observation.mediaType) !== observation.mediaType ||
    !ALLOWED_MEDIA_TYPES.includes(observation.mediaType as (typeof ALLOWED_MEDIA_TYPES)[number]) ||
    !Number.isSafeInteger(observation.responseBytes) || (observation.responseBytes ?? -1) < 0 ||
    (observation.responseBytes ?? POLICY_MAX_RESPONSE_BYTES + 1) > POLICY_MAX_RESPONSE_BYTES ||
    typeof observation.contentSha256 !== 'string' || !SHA256.test(observation.contentSha256) ||
    observation.transportVersion !== POLICY_TRANSPORT_VERSION ||
    typeof observation.fetchedAt !== 'string' || !validInstant(observation.fetchedAt) ||
    typeof observation.observedAt !== 'string' || !validInstant(observation.observedAt) ||
    Date.parse(observation.observedAt) < Date.parse(observation.fetchedAt) ||
    !nonBlank(observation.reviewer) || containsSecret(observation.reviewer) ||
    !nonBlank(observation.decisionSummary) || containsSecret(observation.decisionSummary) ||
    observation.phase !== phase) {
    return false;
  }
  if (phase === 'selection') {
    return observation.releaseCommit === undefined && observation.runId === undefined;
  }
  return observation.releaseCommit === expected.releaseCommit && observation.runId === expected.runId &&
    validGitSha(observation.releaseCommit) && validRunId(observation.runId);
}

function uniqueByPolicy(
  observations: readonly PolicyObservation[],
  phase: 'selection' | 'predeploy',
  expected: { releaseCommit: string; runId: string; batchId: string },
): Map<PolicyId, PolicyObservation> | null {
  if (!Array.isArray(observations)) return null;
  const values = new Map<PolicyId, PolicyObservation>();
  for (const observation of observations) {
    if (!validObservation(observation, phase, expected) || values.has(observation.policyId)) return null;
    values.set(observation.policyId, observation);
  }
  return values;
}

/** @des DES-F002-009 DES-F002-015 @fun FUN-F002-010 */
export function validateSelectionPolicySnapshots(
  observations: readonly PolicyObservation[],
  batchId = 'F002',
): readonly PolicyObservation[] {
  if (!BATCH_ID.test(batchId)) {
    throw new PolicySnapshotError('POLICY_OBSERVATION_INVALID', 'selection規約観測のbatch IDが不正です');
  }
  const values = uniqueByPolicy(observations, 'selection', {
    releaseCommit: '',
    runId: '',
    batchId,
  });
  const policyIds = Object.keys(POLICY_ALLOWLIST) as PolicyId[];
  if (!values || values.size !== policyIds.length) {
    throw new PolicySnapshotError('POLICY_OBSERVATION_INVALID', 'selection規約観測が欠損・重複・改変しています');
  }
  return Object.freeze(policyIds.map((policyId) => Object.freeze({ ...values.get(policyId)! })));
}

function validImpactReview(
  value: unknown,
  policyId: PolicyId,
  before: PolicyObservation,
  after: PolicyObservation,
  expected: { releaseCommit: string; runId: string },
): value is ImpactReview {
  if (!value || typeof value !== 'object') return false;
  const review = value as Partial<ImpactReview>;
  const validImpacts = new Set<PolicyImpactArea>(['dialogue', 'audio', 'artwork', 'credit']);
  return hasExactKeys(value, [
    'decision', 'impacts', 'policyId', 'predeploySha256', 'releaseCommit',
    'reviewedAt', 'reviewer', 'runId', 'selectionSha256', 'summary',
  ]) &&
    review.policyId === policyId && review.selectionSha256 === before.contentSha256 &&
    review.predeploySha256 === after.contentSha256 && review.releaseCommit === expected.releaseCommit &&
    review.runId === expected.runId && review.decision === 'approved' &&
    Array.isArray(review.impacts) && review.impacts.length > 0 &&
    new Set(review.impacts).size === review.impacts.length &&
    review.impacts.every((impact) => validImpacts.has(impact)) &&
    nonBlank(review.reviewer) && !containsSecret(review.reviewer) &&
    nonBlank(review.summary) && !containsSecret(review.summary) &&
    typeof review.reviewedAt === 'string' && validInstant(review.reviewedAt) &&
    Date.parse(review.reviewedAt) >= Date.parse(after.observedAt);
}

/** @des DES-F002-009 DES-F002-015 DES-F002-016 @fun FUN-F002-011 */
export function comparePolicySnapshots(
  selection: readonly PolicyObservation[],
  predeploy: readonly PolicyObservation[],
  reviews: readonly ImpactReview[],
  expected: { releaseCommit: string; runId: string; batchId?: string },
): PolicyDecision {
  const reasons = new Set<string>();
  const impacts = new Set<PolicyImpactArea>();
  const evidence: PolicyDecision['evidence'][number][] = [];
  const impactReviews = Array.isArray(reviews) ? reviews : [];
  if (!Array.isArray(reviews)) reasons.add('POLICY_REVIEW_STALE');
  const context = {
    releaseCommit: expected.releaseCommit,
    runId: expected.runId,
    batchId: expected.batchId ?? 'F002',
  };
  const contextValid = validGitSha(context.releaseCommit) && validRunId(context.runId) && BATCH_ID.test(context.batchId);
  const selected = contextValid ? uniqueByPolicy(selection, 'selection', context) : null;
  const deployed = contextValid ? uniqueByPolicy(predeploy, 'predeploy', context) : null;
  if (!contextValid) reasons.add('POLICY_REVIEW_STALE');
  if ((Array.isArray(selection) && selection.length > 0 && !selected) ||
    (Array.isArray(predeploy) && predeploy.length > 0 && !deployed)) {
    reasons.add('POLICY_OBSERVATION_INVALID');
  }
  if (!selected || !deployed ||
    selected.size !== Object.keys(POLICY_ALLOWLIST).length || deployed.size !== Object.keys(POLICY_ALLOWLIST).length) {
    reasons.add('POLICY_OBSERVATION_MISSING');
  }
  for (const policyId of Object.keys(POLICY_ALLOWLIST) as PolicyId[]) {
    const before = selected?.get(policyId);
    const after = deployed?.get(policyId);
    let status: 'unchanged' | 'changed-reviewed' | 'blocked' = 'blocked';
    if (!before || !after) {
      reasons.add('POLICY_OBSERVATION_MISSING');
    } else if (before.contentSha256 === after.contentSha256) {
      status = 'unchanged';
    } else {
      const review = impactReviews.find((item) => item?.policyId === policyId);
      if (!validImpactReview(review, policyId, before, after, expected)) {
        reasons.add(review ? 'POLICY_REVIEW_STALE' : 'POLICY_HASH_CHANGED_UNREVIEWED');
      } else {
        status = 'changed-reviewed';
        review.impacts.forEach((impact) => impacts.add(impact));
      }
    }
    evidence.push({
      policyId,
      selectionSha256: before?.contentSha256 ?? '',
      predeploySha256: after?.contentSha256 ?? '',
      status,
    });
  }
  const changed = evidence.some((item) => item.status === 'changed-reviewed');
  return Object.freeze({
    status: reasons.size > 0 ? 'blocked' : changed ? 'changed-reviewed' : 'unchanged',
    releaseCommit: expected.releaseCommit,
    runId: expected.runId,
    impacts: Object.freeze([...impacts].sort()),
    evidence: Object.freeze(evidence.map((item) => Object.freeze(item))),
    reasonCodes: Object.freeze([...reasons].sort()),
  });
}

/** @des DES-F002-009 DES-F002-012 DES-F002-015 @fun FUN-F002-035 */
export class ProductionPolicyTransport implements SafePolicyTransport {
  private readonly options: Required<Pick<ProductionPolicyTransportOptions, 'resolver' | 'pinnedSocketFactory'>> &
    Pick<ProductionPolicyTransportOptions, 'clock'>;

  constructor(options: ProductionPolicyTransportOptions = {}) {
    if (options.proxy !== undefined && options.proxy !== false) {
      throw new PolicySnapshotError('POLICY_PROXY_FORBIDDEN', '規約取得でproxyは使用できません');
    }
    this.options = {
      resolver: options.resolver ?? defaultResolver,
      pinnedSocketFactory: options.pinnedSocketFactory ?? defaultPinnedSocketFactory,
      clock: options.clock,
    };
  }

  async request(definition: PolicyDefinition): Promise<PolicyTransportResponse> {
    const url = assertCanonicalDefinition(definition);
    const addresses = await this.options.resolver(url.hostname);
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new PolicySnapshotError('POLICY_DNS_PRIVATE', 'DNS全回答にprivate/予約addressがあります');
    }
    const pinned = addresses[0];
    if (!pinned) throw new PolicySnapshotError('POLICY_DNS_PRIVATE', 'DNS回答が空です');
    const family = pinned.family ?? isIP(pinned.address);
    if (family !== 4 && family !== 6) throw new PolicySnapshotError('POLICY_DNS_PRIVATE', 'DNS回答のIP形式が不正です');
    const controller = new AbortController();
    const startedAt = this.options.clock?.() ?? Date.now();
    const timeout = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
    try {
      const response = await this.options.pinnedSocketFactory({
        url,
        address: pinned.address,
        family,
        hostHeader: url.hostname,
        serverName: url.hostname,
        rejectUnauthorized: true,
        checkServerIdentity: true,
        followRedirects: false,
        useEnvironmentProxy: false,
        signal: controller.signal,
        maxBytes: POLICY_MAX_RESPONSE_BYTES,
      });
      const completed = {
        ...response,
        elapsedMs: response.elapsedMs ?? (this.options.clock?.() ?? Date.now()) - startedAt,
        security: {
          ...response.security,
          dnsAddresses: addresses.map(({ address }) => address),
          connectedAddress: response.security.connectedAddress || pinned.address,
        },
      };
      validateSecurityProof(definition, completed);
      return completed;
    } catch (error) {
      if (controller.signal.aborted) throw new PolicySnapshotError('POLICY_TIMEOUT', '規約取得がtimeoutしました');
      if (error instanceof PolicySnapshotError) throw error;
      throw new PolicySnapshotError('POLICY_TLS_INVALID', 'TLS pinned transportが失敗しました', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function defaultResolver(hostname: string): Promise<readonly { address: string; family: 4 | 6 }[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) throw new PolicySnapshotError('POLICY_DNS_PRIVATE', 'DNS familyが不正です');
    return { address, family };
  });
}

function headerMediaType(headers: Readonly<Record<string, string | string[] | undefined>>): string {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return (Array.isArray(value) ? value.join(', ') : value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function defaultPinnedSocketFactory(input: PolicyPinnedRequest): Promise<PolicyTransportResponse> {
  return new Promise((resolveResponse, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = httpsRequest(input.url, {
      agent: false,
      family: input.family,
      headers: { Host: input.hostHeader, Connection: 'close', 'User-Agent': 'bungo-zundamon-policy-snapshot/1.0' },
      lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
      servername: input.serverName,
      rejectUnauthorized: input.rejectUnauthorized,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(input.serverName, certificate),
      signal: input.signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxBytes) {
          request.destroy(new PolicySnapshotError('POLICY_TOO_LARGE', '規約responseが8 MiBを超えています'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        const socket = response.socket;
        resolveResponse({
          status: response.statusCode ?? 0,
          mediaType: headerMediaType(response.headers),
          body: new Uint8Array(Buffer.concat(chunks)),
          finalUrl: input.url.href,
          elapsedMs: Date.now() - startedAt,
          fetchedAt: new Date().toISOString(),
          transportVersion: POLICY_TRANSPORT_VERSION,
          security: {
            dnsAddresses: [input.address],
            connectedAddress: socket.remoteAddress ?? input.address,
            tlsAuthorized: true,
            hostnameVerified: true,
            redirectsFollowed: 0,
            proxyUsed: false,
            attempts: 1,
          },
        });
      });
    });
    request.once('error', fail);
    request.end();
  });
}
