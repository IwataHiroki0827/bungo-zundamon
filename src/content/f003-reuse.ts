import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';
import { promoteBatchSourceArtifactTree } from './batch-production.ts';
import {
  AOZORA_BIBLIOGRAPHY_ENTRY,
  AOZORA_BIBLIOGRAPHY_URL,
  AOZORA_TIMEOUT_MS,
  MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
  MAX_BIBLIOGRAPHY_CSV_BYTES,
  ProductionAozoraTransport,
  decodeAozoraSource,
  extractVerifiedBibliographyCsv,
  fetchAozoraSources,
  parseAozoraBibliography,
  revalidateWorkRights,
  selectBatchWorks,
  type AozoraMetadata,
  type BatchSelectionManifest,
  type BibliographySnapshot,
  type DecodedSource,
  type Provenance,
  type SelectedWork,
  type WorkRightsDecision,
  type WorkRightsObservation,
} from './source.ts';
import {
  EXTRACTOR_VERSION,
  SOURCE_TRANSFORMATION,
  extractDialogueCandidates,
  type RawCandidate,
} from './processing.ts';
import type { SpeechItem } from '../voice/types.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const F002_RELEASE_COMMIT = '84c985f382910216e381a96901f6fd569165a27e';
const F002_VOICE_CONFIG_HASH = '0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691';
const F002_VOICE_SOURCE_SET_SHA256 = '0951c2da012c91d646b2a435b96ea6c7d9fa18809e84419245191114cf2605ff';
const F002_VOICE_PROFILE_SHA256 = 'f3d23c29a03d140e9203360923caaacb5a42c805990c81fe7593850559b298b0';
const PROFILE_KEYS = [
  'schemaVersion',
  'sourceReleaseCommit',
  'sourceSetSha256',
  'configHash',
  'sampleCount',
  'secondsPerCharacter',
  'safetyFactor',
  'observedEstimatedBytes',
  'observedActualBytes',
  'observedRelativeError',
  'maxRelativeError',
  'outputSamplingRate',
  'bitDepth',
  'channels',
  'wavHeaderBytes',
  'calibratedAt',
  'artifactSha256',
] as const;

export class F003ReuseError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F003ReuseError';
  }
}

export interface BibliographyObservationContext {
  readonly transport: ProductionAozoraTransport;
  readonly clock: () => Date;
  readonly selection?: WorkRightsObservation;
  readonly releaseCommit?: string;
  readonly runId?: string;
}

export type BatchWorkRightsObservation =
  | {
      readonly phase: 'selection';
      readonly works: readonly SelectedWork[];
      readonly observation: WorkRightsObservation;
    }
  | {
      readonly phase: 'predeploy';
      readonly decision: WorkRightsDecision;
    };

export interface FixedBibliographyExpectation {
  readonly workspaceRoot: string;
  readonly outputDir: string;
  readonly observation: WorkRightsObservation;
  readonly snapshot: BibliographySnapshot;
  readonly toolVersion: string;
  readonly changeNotice: string;
}

export interface FixedBatchSource {
  readonly record: Readonly<{
    workId: string;
    rawPath: string;
    rawSha256: string;
    mediaType: string;
    httpCharset: string | null;
    bibliographyCharset: string | null;
    fetchedAt: string;
    sourceUrl: string;
  }>;
  readonly raw: Uint8Array;
  readonly decoded: Readonly<DecodedSource>;
  readonly metadata: Readonly<AozoraMetadata>;
  readonly provenance: Readonly<Provenance>;
  readonly wrapper: Readonly<{
    schemaVersion: '1.0.0';
    workId: string;
    rawPath: string;
    rawSha256: Sha256;
    sourceRecordSha256: Sha256;
    metadataSha256: Sha256;
    provenanceSha256: Sha256;
    bodySelector: '.main_text';
    httpCharset: string | null;
    metaCharset: string | null;
    bibliographyCharset: string | null;
    adoptedCharset: string;
  }>;
  readonly bodySelector: '.main_text';
  readonly sourceSha256: Sha256;
}

export interface CandidateSet {
  readonly extractorVersion: string;
  readonly sourceSha256: Sha256;
  readonly candidates: readonly RawCandidate[];
  readonly excluded: readonly Readonly<{ code: string; message: string }>[];
  readonly sha256: Sha256;
}

export interface ApprovedSpeechCandidate {
  readonly candidateId: string;
  readonly displayText: string;
  readonly speechText: string;
}

export interface SpeechRevisionV2 {
  readonly candidateId: string;
  readonly revision: number;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  readonly inputSha256: Sha256;
  readonly outputSha256: Sha256;
}

export interface RevisedSpeechItem extends SpeechItem {
  readonly candidateId: string;
  readonly displayText: string;
  readonly speechText: string;
  readonly approved: true;
  readonly revisionCount: number;
  readonly speechSha256: Sha256;
}

export interface VoiceEstimateProfileV2 {
  readonly schemaVersion: '2.0.0';
  readonly sourceReleaseCommit: string;
  readonly sourceSetSha256: Sha256;
  readonly configHash: Sha256;
  readonly sampleCount: 151;
  readonly secondsPerCharacter: number;
  readonly safetyFactor: number;
  readonly observedEstimatedBytes: number;
  readonly observedActualBytes: number;
  readonly observedRelativeError: number;
  readonly maxRelativeError: 0.2;
  readonly outputSamplingRate: 24_000;
  readonly bitDepth: 16;
  readonly channels: 1;
  readonly wavHeaderBytes: 44;
  readonly calibratedAt: string;
  readonly artifactSha256: Sha256;
}

export interface CandidateSafetyReport {
  readonly result: 'pass' | 'blocked';
  readonly candidateId: string;
  readonly profileSha256: string;
  readonly configHash: Sha256;
  readonly speechSha256: Sha256;
  readonly codePoints: number;
  readonly durationMs: number;
  readonly wavBytes: number;
  readonly limits: Readonly<{
    codePoints: 500;
    durationMs: 120_000;
    wavBytes: 5_760_044;
  }>;
  readonly reasons: readonly string[];
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sorted = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function safeText(value: string): boolean {
  return value.length > 0 && value === value.normalize('NFC') && !/[\uD800-\uDFFF]/u.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
    });
}

/**
 * F002のproduction transportと書誌選定をF003候補へ接続する。
 * @des DES-F003-003 @fun FUN-F003-006 @ut UT-F003-006
 */
export async function observeBatchBibliography(
  candidate: BatchSelectionManifest,
  phase: 'selection' | 'predeploy',
  context: BibliographyObservationContext,
): Promise<BatchWorkRightsObservation> {
  if (!(context.transport instanceof ProductionAozoraTransport)) {
    throw new F003ReuseError('PRODUCTION_TRANSPORT_REQUIRED', '書誌観測にはProductionAozoraTransportが必要です');
  }
  if (phase === 'predeploy') {
    if (!context.selection || !context.releaseCommit || !context.runId) {
      throw new F003ReuseError('WORK_RIGHTS_PREDEPLOY_MISSING', 'predeploy contextが不足しています');
    }
    const decision = await revalidateWorkRights(
      candidate,
      context.releaseCommit,
      context.runId,
      context.transport,
      context.selection,
    );
    return Object.freeze({ phase, decision });
  }
  if (context.selection || context.releaseCommit || context.runId) {
    throw new F003ReuseError('WORK_RIGHTS_OBSERVATION_STALE', 'selection contextへrelease値を混在できません');
  }
  const response = await context.transport.request(new URL(AOZORA_BIBLIOGRAPHY_URL), {
    pathPrefix: '/index_pages/',
    allowedMediaTypes: ['application/zip'],
    maxBytes: MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
    timeoutMs: AOZORA_TIMEOUT_MS,
  });
  const csv = extractVerifiedBibliographyCsv(response.body);
  const observedAt = response.fetchedAt ? new Date(response.fetchedAt) : context.clock();
  const selected = selectBatchWorks(parseAozoraBibliography(csv), candidate, observedAt, { sha256: sha256(csv) });
  return Object.freeze({
    phase,
    works: Object.freeze(selected.works.map((work) => Object.freeze({ ...work }))),
    observation: selected.observation,
  });
}

function validateBibliographySnapshot(snapshot: BibliographySnapshot): void {
  const expectedArchivePath = AOZORA_BIBLIOGRAPHY_ENTRY.replace(/\.csv$/u, '.zip');
  if (!exactKeys(snapshot, [
    'sourceUrl', 'archivePath', 'archiveSha256', 'archiveBytes', 'csvPath', 'csvEntry',
    'csvSha256', 'csvBytes', 'mediaType', 'fetchedAt', 'schemaVersion',
  ]) ||
    snapshot.sourceUrl !== AOZORA_BIBLIOGRAPHY_URL ||
    snapshot.archivePath !== expectedArchivePath ||
    snapshot.csvPath !== AOZORA_BIBLIOGRAPHY_ENTRY ||
    snapshot.csvEntry !== AOZORA_BIBLIOGRAPHY_ENTRY ||
    snapshot.mediaType !== 'application/zip' ||
    !SHA256.test(snapshot.archiveSha256) || !SHA256.test(snapshot.csvSha256) ||
    !Number.isSafeInteger(snapshot.archiveBytes) || snapshot.archiveBytes <= 0 ||
    snapshot.archiveBytes > MAX_BIBLIOGRAPHY_ARCHIVE_BYTES ||
    !Number.isSafeInteger(snapshot.csvBytes) || snapshot.csvBytes <= 0 ||
    snapshot.csvBytes > MAX_BIBLIOGRAPHY_CSV_BYTES ||
    !validInstant(snapshot.fetchedAt) || !safeText(snapshot.schemaVersion)) {
    throw new F003ReuseError('SOURCE_BIBLIOGRAPHY_INVALID', '書誌snapshotがexact schemaと一致しません');
  }
}

function expectedRights(
  work: SelectedWork,
  observation: WorkRightsObservation,
  snapshot: BibliographySnapshot,
): void {
  validateBibliographySnapshot(snapshot);
  if (observation.phase !== 'selection' || observation.releaseCommit !== undefined ||
    observation.runId !== undefined || observation.bibliographySha256 !== snapshot.csvSha256 ||
    !validInstant(observation.observedAt) ||
    observation.works.length !== 3 ||
    new Set(observation.works.map((item) => item.workId)).size !== observation.works.length) {
    throw new F003ReuseError('WORK_RIGHTS_SELECTION_MISSING', '原典固定にはselection観測が必要です');
  }
  const right = observation.works.find((item) => item.workId === work.workId);
  if (!right || right.title !== work.title || right.personId !== work.personId ||
    right.personId !== '000035' ||
    right.personCopyright !== work.personCopyright ||
    right.workCopyright !== work.copyright ||
    right.role !== work.role || right.translatorPresent !== false ||
    right.status !== work.status || right.orthography !== work.orthography ||
    right.personCopyright !== 'なし' || right.workCopyright !== 'なし' ||
    right.role !== '著者' || right.status !== '公開中' || right.orthography !== '新字新仮名' ||
    right.cardUrl !== work.cardUrl || right.sourceUrl !== work.sourceUrl ||
    work.charset !== 'UTF-8') {
    throw new F003ReuseError('WORK_ALLOWLIST_MISMATCH', '作品と書誌観測が一致しません');
  }
}

/**
 * F002のallowlist付き取得・charset fatal decode・atomic promotionを1作品へ適用する。
 * @des DES-F003-003 @fun FUN-F003-007 @ut UT-F003-007
 */
export async function fixBatchSource(
  work: SelectedWork,
  transport: ProductionAozoraTransport,
  expectedBibliography: FixedBibliographyExpectation,
): Promise<FixedBatchSource> {
  if (!(transport instanceof ProductionAozoraTransport)) {
    throw new F003ReuseError('PRODUCTION_TRANSPORT_REQUIRED', '原典固定にはProductionAozoraTransportが必要です');
  }
  expectedRights(work, expectedBibliography.observation, expectedBibliography.snapshot);
  const workspace = resolve(expectedBibliography.workspaceRoot);
  const output = resolve(expectedBibliography.outputDir);
  const outputRelation = relative(workspace, output);
  if (!isAbsolute(expectedBibliography.workspaceRoot) || !isAbsolute(expectedBibliography.outputDir) ||
    outputRelation === '' || outputRelation === '..' || outputRelation.startsWith(`..${sep}`) || isAbsolute(outputRelation)) {
    throw new F003ReuseError('SOURCE_OUTPUT_INVALID', '原典固定先はworkspace配下の絶対pathが必要です');
  }
  const artifactRoot = outputRelation.replaceAll(sep, '/');
  const scratchParent = join(workspace, '.cache', 'f003-source-scratch');
  await mkdir(scratchParent, { recursive: true });
  const scratch = join(scratchParent, `${work.workId}-${randomUUID()}`);
  try {
    const records = await fetchAozoraSources([work], scratch, {
      transport,
      workspaceRoot: workspace,
      allowlist: {
        authorId: work.personId,
        works: { [work.workId]: { sourceUrl: work.sourceUrl, cardUrl: work.cardUrl ?? '' } },
      },
    });
    const record = records[0];
    if (!record || records.length !== 1 || record.workId !== work.workId) {
      throw new F003ReuseError('SOURCE_RECORD_MISMATCH', '固定したSourceRecordが作品と一致しません');
    }
    const raw = new Uint8Array(await readFile(join(scratch, record.rawPath)));
    const decoded = decodeAozoraSource(record, raw);
    const extraction = extractDialogueCandidates(decoded, work.workId, new Set([work.workId]));
    if (!extraction.ok) {
      throw new F003ReuseError('SOURCE_SELECTOR_MISSING', '本文selectorを検証できません');
    }
    if (!work.cardUrl?.trim() || !work.baseEdition?.trim() || !work.inputter?.trim() || !work.proofreader?.trim() ||
      !expectedBibliography.toolVersion.trim() || !expectedBibliography.changeNotice.trim()) {
      throw new F003ReuseError('SOURCE_METADATA_MISSING', '書誌metadataが不足しています');
    }
    const metadata: AozoraMetadata = {
      stableCardUrl: work.cardUrl,
      baseEdition: work.baseEdition,
      inputter: work.inputter,
      proofreader: work.proofreader,
      toolVersion: expectedBibliography.toolVersion,
      transformation: SOURCE_TRANSFORMATION,
      changeNotice: expectedBibliography.changeNotice,
      sourceSha256: record.rawSha256,
    };
    const snapshot = expectedBibliography.snapshot;
    const provenance: Provenance = {
      workId: record.workId,
      stableCardUrl: work.cardUrl,
      sourceUrl: record.sourceUrl,
      sourceSha256: record.rawSha256,
      fetchedAt: record.fetchedAt,
      baseEdition: work.baseEdition,
      inputter: work.inputter,
      proofreader: work.proofreader,
      toolVersion: expectedBibliography.toolVersion,
      transformation: SOURCE_TRANSFORMATION,
      changeNotice: expectedBibliography.changeNotice,
      bibliography: {
        sourceUrl: snapshot.sourceUrl,
        archiveSha256: snapshot.archiveSha256,
        archiveBytes: snapshot.archiveBytes,
        csvEntry: snapshot.csvEntry,
        csvSha256: snapshot.csvSha256,
        csvBytes: snapshot.csvBytes,
        schemaVersion: snapshot.schemaVersion,
      },
    };
    const sourceJson = new Uint8Array(await readFile(join(scratch, work.workId, 'source.json')));
    const metadataBytes = new TextEncoder().encode(canonicalJson(metadata));
    const provenanceBytes = new TextEncoder().encode(canonicalJson(provenance));
    const wrapper = Object.freeze({
      schemaVersion: '1.0.0' as const,
      workId: record.workId,
      rawPath: record.rawPath,
      rawSha256: record.rawSha256 as Sha256,
      sourceRecordSha256: sha256(sourceJson),
      metadataSha256: sha256(metadataBytes),
      provenanceSha256: sha256(provenanceBytes),
      bodySelector: '.main_text' as const,
      httpCharset: decoded.httpCharset,
      metaCharset: decoded.metaCharset,
      bibliographyCharset: decoded.bibliographyCharset,
      adoptedCharset: decoded.adoptedCharset,
    });
    const wrapperBytes = new TextEncoder().encode(canonicalJson(wrapper));
    await promoteBatchSourceArtifactTree(workspace, artifactRoot as WorkspaceRelativePath, [
      { path: record.rawPath, bytes: raw },
      { path: `${work.workId}/source.json`, bytes: sourceJson },
      { path: `${work.workId}/metadata.json`, bytes: metadataBytes },
      { path: `${work.workId}/provenance.json`, bytes: provenanceBytes },
      { path: `${work.workId}/fixed-source.json`, bytes: wrapperBytes },
    ]);
    return Object.freeze({
      record: Object.freeze({ ...record }),
      raw: raw.slice(),
      decoded: Object.freeze({ ...decoded }),
      metadata: Object.freeze({ ...metadata }),
      provenance: Object.freeze({ ...provenance }),
      wrapper,
      bodySelector: '.main_text' as const,
      sourceSha256: record.rawSha256 as Sha256,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * F002のinert XHTML tokenizer/外側括弧抽出をF003 work allowlistへ接続する。
 * @des DES-F003-004 @fun FUN-F003-008 @ut UT-F003-008
 */
export function extractOuterDialogueCandidates(source: DecodedSource, extractorVersion: string): CandidateSet {
  if (extractorVersion !== EXTRACTOR_VERSION) {
    throw new F003ReuseError('EXTRACTOR_VERSION_UNSUPPORTED', '固定extractor versionと一致しません');
  }
  const allowed = new Set([source.workId]);
  const first = extractDialogueCandidates(source, source.workId, allowed);
  const second = extractDialogueCandidates(source, source.workId, allowed);
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new F003ReuseError('EXTRACTION_NON_DETERMINISTIC', '同一入力の抽出結果が一致しません');
  }
  const excluded: Array<{ code: string; message: string }> = first.diagnostics.map((item) => ({ ...item }));
  if (first.ok && first.candidates.length === 0 && source.text.includes('『')) {
    excluded.push({ code: 'standalone-inner-bracket', message: '単独の『』は外側台詞候補ではありません' });
  }
  const candidates = first.ok ? first.candidates : [];
  const core = {
    extractorVersion,
    sourceSha256: source.rawSha256.toLowerCase(),
    candidates,
    excluded,
  };
  return Object.freeze({
    ...core,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
      ...candidate,
      rawTokenRange: Object.freeze({ ...candidate.rawTokenRange }),
      tokens: Object.freeze(candidate.tokens.map((token) => Object.freeze({ ...token }))),
      sourceAnchor: Object.freeze({ ...candidate.sourceAnchor }),
    }))),
    excluded: Object.freeze(excluded.map((diagnostic) => Object.freeze({ ...diagnostic }))),
    sha256: sha256(canonicalJson(core)),
  }) as CandidateSet;
}

/**
 * display textを保持し、候補ごとの連続revision chainだけをspeech textへ適用する。
 * @des DES-F003-006 @fun FUN-F003-012 @ut UT-F003-012
 */
export function applySpeechRevisions(
  approved: readonly ApprovedSpeechCandidate[],
  revisions: readonly SpeechRevisionV2[],
): RevisedSpeechItem[] {
  const approvedIds = new Set<string>();
  const revisionsByCandidate = new Map<string, SpeechRevisionV2[]>();
  for (const revision of revisions) {
    if (!approved.some((candidate) => candidate.candidateId === revision.candidateId)) {
      throw new F003ReuseError('SPEECH_REVISION_CHAIN_INVALID', '別candidateのrevisionが混在しています');
    }
    const bucket = revisionsByCandidate.get(revision.candidateId) ?? [];
    bucket.push(revision);
    revisionsByCandidate.set(revision.candidateId, bucket);
  }
  return approved.map((candidate) => {
    if (!candidate.candidateId.trim() || approvedIds.has(candidate.candidateId) ||
      !safeText(candidate.displayText) || !safeText(candidate.speechText)) {
      throw new F003ReuseError('SPEECH_REVISION_CHAIN_INVALID', 'approved candidateが不正です');
    }
    approvedIds.add(candidate.candidateId);
    let speechText = candidate.speechText;
    const chain = (revisionsByCandidate.get(candidate.candidateId) ?? [])
      .toSorted((left, right) => left.revision - right.revision);
    const seenRevisions = new Set<number>();
    for (let index = 0; index < chain.length; index += 1) {
      const revision = chain[index];
      if (!revision || revision.revision !== index + 1 || seenRevisions.has(revision.revision) ||
        revision.before !== speechText || revision.inputSha256 !== sha256(speechText) ||
        revision.outputSha256 !== sha256(revision.after) || !safeText(revision.after) ||
        !revision.reason.trim()) {
        throw new F003ReuseError('SPEECH_REVISION_CHAIN_INVALID', 'revision chainの連番・本文・hashが一致しません');
      }
      seenRevisions.add(revision.revision);
      speechText = revision.after;
    }
    return Object.freeze({
      candidateId: candidate.candidateId,
      displayText: candidate.displayText,
      speechText,
      approved: true as const,
      revisionCount: chain.length,
      speechSha256: sha256(speechText),
    });
  });
}

export function hashVoiceEstimateProfileV2(
  profile: Omit<VoiceEstimateProfileV2, 'artifactSha256'>,
): Sha256 {
  return sha256(canonicalJson(profile));
}

function validateProfile(profile: VoiceEstimateProfileV2): readonly string[] {
  const reasons: string[] = [];
  if (!exactKeys(profile, PROFILE_KEYS) || profile.schemaVersion !== '2.0.0' ||
    profile.sourceReleaseCommit !== F002_RELEASE_COMMIT || profile.sampleCount !== 151 ||
    profile.sourceSetSha256 !== F002_VOICE_SOURCE_SET_SHA256 ||
    profile.configHash !== F002_VOICE_CONFIG_HASH ||
    !SHA256.test(profile.artifactSha256) || profile.maxRelativeError !== 0.2 ||
    profile.outputSamplingRate !== 24_000 || profile.bitDepth !== 16 ||
    profile.channels !== 1 || profile.wavHeaderBytes !== 44 ||
    !validInstant(profile.calibratedAt)) {
    reasons.push('VOICE_PROFILE_SCHEMA_INVALID');
    return reasons;
  }
  const numbers = [
    profile.secondsPerCharacter,
    profile.safetyFactor,
    profile.observedEstimatedBytes,
    profile.observedActualBytes,
    profile.observedRelativeError,
  ];
  if (numbers.some((value) => !Number.isFinite(value) || !Number.isSafeInteger(value) && value !== profile.secondsPerCharacter &&
      value !== profile.safetyFactor && value !== profile.observedRelativeError) ||
    profile.secondsPerCharacter <= 0 || profile.safetyFactor < 1 ||
    !Number.isSafeInteger(profile.observedEstimatedBytes) || profile.observedEstimatedBytes <= 0 ||
    !Number.isSafeInteger(profile.observedActualBytes) || profile.observedActualBytes <= 0) {
    reasons.push('VOICE_PROFILE_VALUE_INVALID');
  }
  const error = Math.abs(profile.observedActualBytes - profile.observedEstimatedBytes) / profile.observedEstimatedBytes;
  if (!Number.isFinite(error) || Math.abs(error - profile.observedRelativeError) > Number.EPSILON ||
    profile.observedRelativeError < 0 || profile.observedRelativeError > profile.maxRelativeError) {
    reasons.push('VOICE_PROFILE_STALE');
  }
  if (numbers.every((value) => Number.isFinite(value))) {
    const core: Omit<VoiceEstimateProfileV2, 'artifactSha256'> = {
      schemaVersion: profile.schemaVersion,
      sourceReleaseCommit: profile.sourceReleaseCommit,
      sourceSetSha256: profile.sourceSetSha256,
      configHash: profile.configHash,
      sampleCount: profile.sampleCount,
      secondsPerCharacter: profile.secondsPerCharacter,
      safetyFactor: profile.safetyFactor,
      observedEstimatedBytes: profile.observedEstimatedBytes,
      observedActualBytes: profile.observedActualBytes,
      observedRelativeError: profile.observedRelativeError,
      maxRelativeError: profile.maxRelativeError,
      outputSamplingRate: profile.outputSamplingRate,
      bitDepth: profile.bitDepth,
      channels: profile.channels,
      wavHeaderBytes: profile.wavHeaderBytes,
      calibratedAt: profile.calibratedAt,
    };
    if (profile.artifactSha256 !== hashVoiceEstimateProfileV2(core)) reasons.push('VOICE_PROFILE_HASH_MISMATCH');
  }
  if (profile.artifactSha256 !== F002_VOICE_PROFILE_SHA256 && !reasons.includes('VOICE_PROFILE_STALE')) {
    reasons.push('VOICE_PROFILE_STALE');
  }
  return reasons;
}

/**
 * F002校正profileを再検算し、F003単一候補の3つのinclusive上限を予測する。
 * @des DES-F003-006 @fun FUN-F003-013 @ut UT-F003-013
 */
export function forecastCandidateSafety(
  item: Pick<RevisedSpeechItem, 'candidateId' | 'speechText' | 'speechSha256'>,
  calibratedProfile: VoiceEstimateProfileV2,
): CandidateSafetyReport {
  const limits = Object.freeze({ codePoints: 500 as const, durationMs: 120_000 as const, wavBytes: 5_760_044 as const });
  const reasons = [...validateProfile(calibratedProfile)];
  const normalized = item.speechText.normalize('NFC');
  const speechSha256 = sha256(normalized);
  if (!item.candidateId.trim() || !safeText(item.speechText) || item.speechText !== normalized ||
    item.speechSha256 !== speechSha256) {
    reasons.push('CANDIDATE_SPEECH_INVALID');
  }
  const codePoints = Array.from(normalized).length;
  const rawDuration = codePoints * calibratedProfile.secondsPerCharacter * calibratedProfile.safetyFactor * 1_000;
  const durationMs = Number.isFinite(rawDuration) && Number.isSafeInteger(Math.ceil(rawDuration))
    ? Math.ceil(rawDuration)
    : Number.MAX_SAFE_INTEGER;
  const pcmBytesPerMillisecond = calibratedProfile.outputSamplingRate *
    calibratedProfile.channels * (calibratedProfile.bitDepth / 8) / 1_000;
  const rawWavBytes = durationMs * pcmBytesPerMillisecond;
  const wavBytes = Number.isFinite(rawWavBytes) && Number.isSafeInteger(Math.ceil(rawWavBytes))
    ? calibratedProfile.wavHeaderBytes + Math.ceil(rawWavBytes)
    : Number.MAX_SAFE_INTEGER;
  if (codePoints > limits.codePoints) reasons.push('CANDIDATE_CODE_POINT_LIMIT');
  if (durationMs > limits.durationMs) reasons.push('CANDIDATE_DURATION_LIMIT');
  if (wavBytes > limits.wavBytes) reasons.push('CANDIDATE_WAV_LIMIT');
  return Object.freeze({
    result: reasons.length === 0 ? 'pass' : 'blocked',
    candidateId: item.candidateId,
    profileSha256: calibratedProfile.artifactSha256,
    configHash: calibratedProfile.configHash,
    speechSha256,
    codePoints,
    durationMs,
    wavBytes,
    limits,
    reasons: Object.freeze(reasons),
  });
}

export const F003_BIBLIOGRAPHY_ARTIFACT = AOZORA_BIBLIOGRAPHY_ENTRY;
