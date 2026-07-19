import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  fingerprintArtifact,
  readJsonArtifact,
  writeJsonArtifactAtomic,
  writeJsonArtifactTreeAtomic,
  canonicalJson,
} from './artifacts.ts';
import {
  EXTRACTOR_VERSION,
  SUPPORTED_SPEECH_RULE_VERSION,
  createCandidateId,
  extractDialogueCandidates,
  normalizeDisplayText,
  normalizeSpeechText,
  type Candidate,
  type DecodedSource as ProcessingDecodedSource,
  type RawCandidate,
  type ReviewRecord,
  type SpeechRules,
} from './processing.ts';
import type { StageResult, StageRunner, UpdateStage } from './pipeline.ts';
import { writeProvenanceAtomic, type ProvenanceManifest } from './pipeline.ts';
import {
  AOZORA_BIBLIOGRAPHY_URL,
  AOZORA_BIBLIOGRAPHY_ENTRY,
  INITIAL_EDITION_RULES,
  INITIAL_WORK_SOURCE_URLS,
  INITIAL_WORK_IDS,
  MAX_SOURCE_BYTES,
  ProductionAozoraTransport,
  SourcePipelineError,
  assertInitialWorkSource,
  buildProvenance,
  decodeAozoraSource,
  fetchAozoraBibliography,
  fetchAozoraSources,
  parseAozoraBibliography,
  resolveEdition,
  selectEligibleWorks,
  type BibliographySnapshot,
  type DecodedSource,
  type SelectedWork,
  type SourceRecord,
} from './source.ts';

export const PRODUCTION_CONTENT_STAGES = [
  'bibliography',
  'select',
  'sources',
  'provenance',
  'decode',
  'extract',
  'normalize',
] as const satisfies readonly UpdateStage[];

export const PRODUCTION_ARTIFACTS = Object.freeze({
  bibliography: 'data/bibliography',
  selectedWorks: 'data/selected-works.json',
  sources: 'data/sources',
  intermediate: 'data/intermediate',
  reviews: 'content/reviews',
  provenance: 'content/provenance.json',
  evidence: 'docs/evidence/content/CONTENT-F001-production-extraction.json',
});

const SPEECH_RULES: SpeechRules = Object.freeze({
  version: SUPPORTED_SPEECH_RULE_VERSION,
  gaiji: Object.freeze({}),
  lineBreak: 'space',
  collapseWhitespace: true,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const WORK_TITLES: Readonly<Record<(typeof INITIAL_WORK_IDS)[number], string>> = Object.freeze({
  '000127': '羅生門',
  '000092': '蜘蛛の糸',
  '043015': '杜子春',
});

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function hashValues(values: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(hashValue(value), 'ascii');
  return hash.digest('hex');
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedTextHash(displayText: string, speechText: string): string {
  return createHash('sha256')
    .update(JSON.stringify([displayText, speechText]), 'utf8')
    .digest('hex');
}

async function assertRegularArtifact(workspace: string, path: string): Promise<void> {
  const root = resolve(workspace);
  const target = resolve(path);
  const relation = relative(root, target);
  if (!isAbsolute(root) || !relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new SourcePipelineError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifactがworkspace外です');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SourcePipelineError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifactはregular fileが必要です');
  }
  const [physicalRoot, physicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  const physicalRelation = relative(physicalRoot, physicalTarget);
  if (!physicalRelation || physicalRelation === '..' || physicalRelation.startsWith(`..${sep}`) || isAbsolute(physicalRelation)) {
    throw new SourcePipelineError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifact実体がworkspace外です');
  }
}

async function readProductionJson<T>(workspace: string, path: string): Promise<T> {
  await assertRegularArtifact(workspace, path);
  return readJsonArtifact<T>(path);
}

function ensureProductionMetadata(work: SelectedWork): void {
  assertInitialWorkSource(work);
  const fields = [work.baseEdition, work.inputter, work.proofreader];
  if (fields.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new SourcePipelineError('PROVENANCE_MISSING', `書誌由来metadataが欠落しています: ${work.workId}`);
  }
}

async function bibliographySnapshot(workspace: string): Promise<BibliographySnapshot> {
  const snapshot = await readProductionJson<BibliographySnapshot>(workspace, join(workspace, PRODUCTION_ARTIFACTS.bibliography, 'source.json'));
  if (
    snapshot === null || typeof snapshot !== 'object' ||
    snapshot.sourceUrl !== AOZORA_BIBLIOGRAPHY_URL ||
    snapshot.archivePath !== 'list_person_all_extended_utf8.zip' ||
    snapshot.csvPath !== AOZORA_BIBLIOGRAPHY_ENTRY || snapshot.csvEntry !== AOZORA_BIBLIOGRAPHY_ENTRY ||
    !SHA256.test(snapshot.archiveSha256) || !SHA256.test(snapshot.csvSha256) ||
    !Number.isSafeInteger(snapshot.archiveBytes) || snapshot.archiveBytes <= 0 ||
    !Number.isSafeInteger(snapshot.csvBytes) || snapshot.csvBytes <= 0 ||
    snapshot.mediaType !== 'application/zip' || !validInstant(snapshot.fetchedAt) ||
    typeof snapshot.schemaVersion !== 'string' || snapshot.schemaVersion.length === 0
  ) {
    throw new SourcePipelineError('BIBLIOGRAPHY_ARTIFACT_INVALID', '書誌snapshot artifactが不正です');
  }
  return snapshot;
}

async function readVerifiedBibliographyCsv(workspace: string, snapshot: BibliographySnapshot): Promise<Uint8Array> {
  const path = join(workspace, PRODUCTION_ARTIFACTS.bibliography, AOZORA_BIBLIOGRAPHY_ENTRY);
  await assertRegularArtifact(workspace, path);
  const csv = await readFile(path);
  if (csv.byteLength !== snapshot.csvBytes || sha256Bytes(csv) !== snapshot.csvSha256) {
    throw new SourcePipelineError('BIBLIOGRAPHY_ARTIFACT_INVALID', '書誌CSVがsnapshotと一致しません');
  }
  return csv;
}

export async function loadProductionSelectedWorks(workspace: string): Promise<SelectedWork[]> {
  const works = await readProductionJson<SelectedWork[]>(workspace, join(workspace, PRODUCTION_ARTIFACTS.selectedWorks));
  if (!Array.isArray(works) || works.length !== INITIAL_WORK_IDS.length) {
    throw new SourcePipelineError('SELECTED_WORK_COUNT', '選定済み作品は固定3件が必要です');
  }
  const seen = new Set<string>();
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const expected = INITIAL_WORK_IDS[index];
    const work = works[index];
    if (
      !expected || !work || work.workId !== expected || seen.has(work.workId) || work.title !== WORK_TITLES[expected] ||
      work.personId !== '000879' || !['著者', 'author'].includes(work.role) ||
      !['なし', '著作権なし', 'expired', 'public-domain'].includes(work.copyright) || work.status !== '公開中' ||
      work.language !== '日本語原著' || !['Shift_JIS', 'UTF-8'].includes(work.charset ?? '') ||
      typeof work.selectionReason !== 'string' || work.selectionReason.trim().length === 0
    ) {
      throw new SourcePipelineError('SELECTED_WORK_INVALID', `選定済み作品artifactが不正です: ${expected}`);
    }
    seen.add(work.workId);
    ensureProductionMetadata(work);
  }
  return works;
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

function validCharset(value: unknown): boolean {
  return value === null || value === 'Shift_JIS' || value === 'UTF-8';
}

function validateSourceRecord(record: SourceRecord, workId: (typeof INITIAL_WORK_IDS)[number]): void {
  if (
    record === null || typeof record !== 'object' || record.workId !== workId ||
    record.rawPath !== `${workId}/source.raw` || record.sourceUrl !== INITIAL_WORK_SOURCE_URLS[workId] ||
    !SHA256.test(record.rawSha256) || !['application/xhtml+xml', 'text/html'].includes(record.mediaType) ||
    !validCharset(record.httpCharset) || !validCharset(record.bibliographyCharset) || !validInstant(record.fetchedAt)
  ) {
    throw new SourcePipelineError('SOURCE_RECORD_MISMATCH', `原典record artifactが不正です: ${workId}`);
  }
}

export async function loadProductionSourceRecords(workspace: string): Promise<SourceRecord[]> {
  const records = await Promise.all(INITIAL_WORK_IDS.map((workId) =>
    readProductionJson<SourceRecord>(workspace, join(workspace, PRODUCTION_ARTIFACTS.sources, workId, 'source.json'))));
  const seen = new Set<string>();
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const expected = INITIAL_WORK_IDS[index];
    const record = records[index];
    if (!expected || !record || seen.has(record.workId)) {
      throw new SourcePipelineError('SOURCE_RECORD_MISMATCH', '原典recordの順序または重複が不正です');
    }
    validateSourceRecord(record, expected);
    seen.add(record.workId);
  }
  return records;
}

async function readProductionSourceRaw(workspace: string, record: SourceRecord): Promise<Uint8Array> {
  const workId = INITIAL_WORK_IDS.find((value) => value === record.workId);
  if (!workId) throw new SourcePipelineError('SOURCE_RECORD_MISMATCH', '原典recordの作品IDがallowlist外です');
  validateSourceRecord(record, workId);
  const path = join(workspace, PRODUCTION_ARTIFACTS.sources, workId, 'source.raw');
  await assertRegularArtifact(workspace, path);
  const raw = await readFile(path);
  if (raw.byteLength === 0 || raw.byteLength > MAX_SOURCE_BYTES || sha256Bytes(raw) !== record.rawSha256) {
    throw new SourcePipelineError('SOURCE_RAW_MISMATCH', `原典raw bytesがrecordと一致しません: ${workId}`);
  }
  return raw;
}

function validateDecodedSource(decoded: DecodedSource, source: SourceRecord, workId: (typeof INITIAL_WORK_IDS)[number]): void {
  if (
    decoded === null || typeof decoded !== 'object' || decoded.workId !== workId ||
    decoded.rawSha256 !== source.rawSha256 || !validCharset(decoded.httpCharset) ||
    !validCharset(decoded.metaCharset) || !validCharset(decoded.bibliographyCharset) ||
    !['Shift_JIS', 'UTF-8'].includes(decoded.adoptedCharset) || typeof decoded.text !== 'string' ||
    decoded.text.length === 0 || decoded.text.length > MAX_SOURCE_BYTES || decoded.text.includes('\uFFFD')
  ) {
    throw new SourcePipelineError('DECODED_SOURCE_MISMATCH', `decode artifactが不正です: ${workId}`);
  }
}

export async function loadProductionDecodedSources(workspace: string, sources?: readonly SourceRecord[]): Promise<DecodedSource[]> {
  const records = sources ?? await loadProductionSourceRecords(workspace);
  const decoded = await Promise.all(INITIAL_WORK_IDS.map((workId) =>
    readProductionJson<DecodedSource>(workspace, join(workspace, PRODUCTION_ARTIFACTS.intermediate, workId, 'decoded.json'))));
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const workId = INITIAL_WORK_IDS[index];
    const decodedSource = decoded[index];
    const source = records[index];
    if (!workId || !decodedSource || !source) throw new SourcePipelineError('DECODED_SOURCE_MISMATCH', 'decode artifact件数が不正です');
    validateDecodedSource(decodedSource, source, workId);
  }
  return decoded;
}

function validateRawCandidate(item: RawCandidate, source: SourceRecord, workId: string, order: number): void {
  const tokensValid = Array.isArray(item?.tokens) && item.tokens.every((token) => {
    if (token === null || typeof token !== 'object' || typeof token.type !== 'string') return false;
    if (token.type === 'lineBreak') return Object.keys(token).length === 1;
    if (token.type === 'text') return typeof token.value === 'string';
    if (token.type === 'ruby') return typeof token.base === 'string' && typeof token.reading === 'string';
    return false;
  });
  if (
    item === null || typeof item !== 'object' || item.workId !== workId || item.rawSourceSha256 !== source.rawSha256 ||
    item.order !== order || !Number.isSafeInteger(item.rawTokenRange?.start) || !Number.isSafeInteger(item.rawTokenRange?.end) ||
    item.rawTokenRange.start < 0 || item.rawTokenRange.end <= item.rawTokenRange.start || !tokensValid ||
    typeof item.contextBefore !== 'string' || typeof item.contextAfter !== 'string' ||
    item.sourceAnchor?.bodySelector !== '.main_text' || item.sourceAnchor.startToken !== item.rawTokenRange.start ||
    item.sourceAnchor.endToken !== item.rawTokenRange.end || item.extractorVersion !== EXTRACTOR_VERSION
  ) {
    throw new SourcePipelineError('RAW_CANDIDATE_MISMATCH', `raw candidate artifactが不正です: ${workId}/${order}`);
  }
}

export async function loadProductionRawCandidates(workspace: string, sources?: readonly SourceRecord[]): Promise<RawCandidate[][]> {
  const records = sources ?? await loadProductionSourceRecords(workspace);
  const groups = await Promise.all(INITIAL_WORK_IDS.map((workId) =>
    readProductionJson<RawCandidate[]>(workspace, join(workspace, PRODUCTION_ARTIFACTS.intermediate, workId, 'raw-candidates.json'))));
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const workId = INITIAL_WORK_IDS[index];
    const group = groups[index];
    const source = records[index];
    if (!workId || !Array.isArray(group) || !source) throw new SourcePipelineError('RAW_CANDIDATE_MISMATCH', 'raw candidate件数が不正です');
    group.forEach((item, order) => validateRawCandidate(item, source, workId, order));
  }
  return groups;
}

function validateCandidate(item: Candidate, raw: RawCandidate, order: number): void {
  if (
    item === null || typeof item !== 'object' || typeof item.displayText !== 'string' || typeof item.speechText !== 'string'
  ) {
    throw new SourcePipelineError('CANDIDATE_MISMATCH', `candidate artifactが不正です: ${raw.workId}/${order}`);
  }
  const expectedId = createCandidateId(
    raw.workId,
    raw.rawSourceSha256,
    raw.rawTokenRange,
    raw.extractorVersion,
    SUPPORTED_SPEECH_RULE_VERSION,
    normalizedTextHash(item.displayText, item.speechText),
  );
  if (
    item.candidateId !== expectedId || item.workId !== raw.workId ||
    item.rawSourceSha256 !== raw.rawSourceSha256 || item.order !== order ||
    item.rawTokenRange?.start !== raw.rawTokenRange.start || item.rawTokenRange?.end !== raw.rawTokenRange.end ||
    item.contextBefore !== raw.contextBefore || item.contextAfter !== raw.contextAfter ||
    item.sourceAnchor?.bodySelector !== raw.sourceAnchor.bodySelector ||
    item.sourceAnchor.startToken !== raw.sourceAnchor.startToken || item.sourceAnchor.endToken !== raw.sourceAnchor.endToken ||
    item.extractorVersion !== raw.extractorVersion || item.normalizerVersion !== SUPPORTED_SPEECH_RULE_VERSION
  ) {
    throw new SourcePipelineError('CANDIDATE_MISMATCH', `candidate artifactが不正です: ${raw.workId}/${order}`);
  }
}

export async function loadProductionCandidates(workspace: string): Promise<Candidate[][]> {
  const sources = await loadProductionSourceRecords(workspace);
  const raw = await loadProductionRawCandidates(workspace, sources);
  const groups = await Promise.all(INITIAL_WORK_IDS.map((workId) =>
    readProductionJson<Candidate[]>(workspace, join(workspace, PRODUCTION_ARTIFACTS.intermediate, workId, 'candidates.json'))));
  const seen = new Set<string>();
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const workId = INITIAL_WORK_IDS[index];
    const group = groups[index];
    const rawGroup = raw[index];
    if (!workId || !Array.isArray(group) || !rawGroup || group.length !== rawGroup.length) {
      throw new SourcePipelineError('CANDIDATE_MISMATCH', 'candidate件数がraw candidateと一致しません');
    }
    group.forEach((item, order) => {
      const rawItem = rawGroup[order];
      if (!rawItem || seen.has(item.candidateId)) throw new SourcePipelineError('CANDIDATE_MISMATCH', 'candidate IDが重複しています');
      validateCandidate(item, rawItem, order);
      seen.add(item.candidateId);
    });
  }
  return groups;
}

function assertRecordCorrespondence(records: readonly SourceRecord[]): void {
  if (records.length !== INITIAL_WORK_IDS.length) throw new SourcePipelineError('SOURCE_COUNT', '原典recordは固定3件が必要です');
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const expected = INITIAL_WORK_IDS[index];
    const record = records[index];
    if (!record || record.workId !== expected || !SHA256.test(record.rawSha256)) {
      throw new SourcePipelineError('SOURCE_RECORD_MISMATCH', `原典record対応が不正です: ${expected}`);
    }
  }
}

function provenanceMetadata(work: SelectedWork, source: SourceRecord) {
  ensureProductionMetadata(work);
  return {
    stableCardUrl: work.cardUrl as string,
    baseEdition: work.baseEdition as string,
    inputter: work.inputter as string,
    proofreader: work.proofreader as string,
    toolVersion: 'bungo-zundamon-content/0.1.0',
    transformation: '公式XHTMLを宣言charsetでdecodeし、「」候補を抽出して表示文・読み上げ文へ決定的に正規化',
    changeNotice: '書誌metadata（CC BY 4.0）の由来を保持し、本文は青空文庫の利用条件に従って加工内容を表示',
    sourceSha256: source.rawSha256,
  };
}

function intermediateEntries(
  decoded: readonly DecodedSource[],
  raw?: readonly RawCandidate[][],
  candidates?: readonly Candidate[][],
) {
  return INITIAL_WORK_IDS.flatMap((workId, index) => {
    const decodedSource = decoded[index];
    if (!decodedSource || decodedSource.workId !== workId) {
      throw new SourcePipelineError('DECODED_SOURCE_MISMATCH', `decode artifact対応が不正です: ${workId}`);
    }
    const entries: Array<{ path: string; value: unknown }> = [
      { path: `${workId}/decoded.json`, value: decodedSource },
    ];
    if (raw) entries.push({ path: `${workId}/raw-candidates.json`, value: raw[index] ?? [] });
    if (candidates) entries.push({ path: `${workId}/candidates.json`, value: candidates[index] ?? [] });
    return entries;
  });
}

function makePendingReviews(candidates: readonly Candidate[], generatedAt: string): ReviewRecord[] {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    revision: 1,
    status: 'pending',
    reasonCode: 'PENDING_EDITORIAL_REVIEW',
    note: '実原典から生成した未判定候補。文脈を確認してapprovedまたはrejectedへ更新すること。',
    reviewer: 'pending-editorial-review',
    reviewedAt: generatedAt,
    policyCheckedAt: generatedAt,
  }));
}

function candidateIdSet(records: readonly ReviewRecord[]): string[] {
  return records.map(({ candidateId }) => candidateId).sort((left, right) => left.localeCompare(right, 'en'));
}

async function writeReviewDrafts(
  workspace: string,
  candidates: readonly Candidate[][],
  generatedAt: string,
): Promise<void> {
  const target = join(workspace, PRODUCTION_ARTIFACTS.reviews);
  const expectedFingerprint = await fingerprintArtifact(target);
  const allowedFiles = new Set(INITIAL_WORK_IDS.map((workId) => `${workId}.json`));
  let existingFiles: string[] = [];
  try {
    existingFiles = await readdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existingFiles.some((file) => !allowedFiles.has(file))) {
    throw new SourcePipelineError('REVIEW_ARTIFACT_UNKNOWN', '固定3作品以外のreview artifactがあります');
  }
  const entries: Array<{ path: string; value: ReviewRecord[] }> = [];
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const workId = INITIAL_WORK_IDS[index];
    const currentCandidates = candidates[index] ?? [];
    const path = join(target, `${workId}.json`);
    let records: ReviewRecord[];
    if (existingFiles.includes(`${workId}.json`)) {
      records = await readProductionJson<ReviewRecord[]>(workspace, path);
      const expected = currentCandidates.map(({ candidateId }) => candidateId).sort((left, right) => left.localeCompare(right, 'en'));
      if (!Array.isArray(records) || JSON.stringify(candidateIdSet(records)) !== JSON.stringify(expected)) {
        throw new SourcePipelineError('REVIEW_CANDIDATE_MISMATCH', `既存reviewと候補集合が一致しません: ${workId}`);
      }
    } else {
      records = makePendingReviews(currentCandidates, generatedAt);
    }
    entries.push({ path: `${workId}.json`, value: records });
  }
  await writeJsonArtifactTreeAtomic(workspace, target, entries, { expectedFingerprint });
}

function evidenceRecord(
  snapshot: BibliographySnapshot,
  works: readonly SelectedWork[],
  sources: readonly SourceRecord[],
  candidates: readonly Candidate[][],
) {
  const counts = Object.fromEntries(INITIAL_WORK_IDS.map((workId, index) => [workId, candidates[index]?.length ?? 0]));
  return {
    schemaVersion: '1.0.0',
    generatedAt: snapshot.fetchedAt,
    bibliography: {
      sourceUrl: snapshot.sourceUrl,
      archiveSha256: snapshot.archiveSha256,
      archiveBytes: snapshot.archiveBytes,
      csvSha256: snapshot.csvSha256,
      csvBytes: snapshot.csvBytes,
      csvEntry: snapshot.csvEntry,
      schemaVersion: snapshot.schemaVersion,
    },
    works: works.map((work, index) => ({
      workId: work.workId,
      title: work.title,
      cardUrl: work.cardUrl,
      sourceUrl: work.sourceUrl,
      rawSha256: sources[index]?.rawSha256,
      rawBytesPath: `${PRODUCTION_ARTIFACTS.sources}/${work.workId}/source.raw`,
      baseEdition: work.baseEdition,
      inputter: work.inputter,
      proofreader: work.proofreader,
      candidateCount: candidates[index]?.length ?? 0,
    })),
    candidateCounts: {
      byWork: counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    },
    normalizedCandidateSetSha256: hashValues(candidates),
    normalizedTextHashContract: 'sha256(UTF8(JSON.stringify([displayText,speechText])))',
    artifacts: [
      `${PRODUCTION_ARTIFACTS.bibliography}/source.json`,
      `${PRODUCTION_ARTIFACTS.bibliography}/list_person_all_extended_utf8.zip`,
      `${PRODUCTION_ARTIFACTS.bibliography}/list_person_all_extended_utf8.csv`,
      PRODUCTION_ARTIFACTS.selectedWorks,
      PRODUCTION_ARTIFACTS.sources,
      PRODUCTION_ARTIFACTS.intermediate,
      PRODUCTION_ARTIFACTS.reviews,
      PRODUCTION_ARTIFACTS.provenance,
      PRODUCTION_ARTIFACTS.evidence,
    ],
  };
}

/** @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-033 */
export function createProductionStageRunner(transport = new ProductionAozoraTransport()): StageRunner {
  return async (stage, context): Promise<StageResult> => {
    const workspace = context.workspace;
    if (stage === 'bibliography') {
      const snapshot = await fetchAozoraBibliography(
        new URL(AOZORA_BIBLIOGRAPHY_URL),
        join(workspace, PRODUCTION_ARTIFACTS.bibliography),
        transport,
        { workspaceRoot: workspace },
      );
      return { hash: snapshot.archiveSha256, count: 1 };
    }

    if (stage === 'select') {
      const snapshot = await bibliographySnapshot(workspace);
      const csv = await readVerifiedBibliographyCsv(workspace, snapshot);
      const works = resolveEdition(selectEligibleWorks(parseAozoraBibliography(csv)), INITIAL_EDITION_RULES);
      for (const work of works) ensureProductionMetadata(work);
      await writeJsonArtifactAtomic(workspace, join(workspace, PRODUCTION_ARTIFACTS.selectedWorks), works);
      return { hash: hashValue(works), count: works.length };
    }

    if (stage === 'sources') {
      const works = await loadProductionSelectedWorks(workspace);
      const records = await fetchAozoraSources(works, join(workspace, PRODUCTION_ARTIFACTS.sources), {
        transport,
        workspaceRoot: workspace,
      });
      assertRecordCorrespondence(records);
      return { hash: hashValues(records), count: records.length };
    }

    if (stage === 'provenance') {
      const [snapshot, works, records] = await Promise.all([
        bibliographySnapshot(workspace), loadProductionSelectedWorks(workspace), loadProductionSourceRecords(workspace),
      ]);
      assertRecordCorrespondence(records);
      const provenance = works.map((work, index) => {
        const source = records[index];
        if (!source || source.workId !== work.workId) throw new SourcePipelineError('SOURCE_RECORD_MISMATCH', '由来対応が不正です');
        return buildProvenance(source, provenanceMetadata(work, source), snapshot);
      });
      const manifestBibliography = provenance[0]?.bibliography;
      if (!manifestBibliography) throw new SourcePipelineError('PROVENANCE_MISSING', '作品由来情報が0件です');
      const manifest: ProvenanceManifest = {
        schemaVersion: '1.0.0',
        bibliography: manifestBibliography,
        works: provenance.map((item) => ({ ...item })),
        sourceHashes: Object.fromEntries(provenance.map((item) => [item.workId, item.sourceSha256])),
        toolVersions: { contentPipeline: '0.1.0', extractor: EXTRACTOR_VERSION, normalizer: SUPPORTED_SPEECH_RULE_VERSION },
        generatedAt: snapshot.fetchedAt,
        transformations: ['decode-declared-charset', 'extract-japanese-dialogue-brackets', 'normalize-display-and-speech'],
      };
      writeProvenanceAtomic(join(workspace, PRODUCTION_ARTIFACTS.provenance), manifest, { workspace });
      return { hash: hashValue(manifest), count: provenance.length };
    }

    if (stage === 'decode') {
      const target = join(workspace, PRODUCTION_ARTIFACTS.intermediate);
      const expectedFingerprint = await fingerprintArtifact(target);
      const records = await loadProductionSourceRecords(workspace);
      assertRecordCorrespondence(records);
      const decoded = await Promise.all(records.map(async (record) =>
        decodeAozoraSource(record, await readProductionSourceRaw(workspace, record))));
      await writeJsonArtifactTreeAtomic(workspace, target, intermediateEntries(decoded), {
        expectedFingerprint,
      });
      return { hash: hashValues(decoded), count: decoded.length };
    }

    if (stage === 'extract') {
      const target = join(workspace, PRODUCTION_ARTIFACTS.intermediate);
      const expectedFingerprint = await fingerprintArtifact(target);
      const sources = await loadProductionSourceRecords(workspace);
      const decoded = await loadProductionDecodedSources(workspace, sources);
      const extracted = decoded.map((source, index) => {
        const workId = INITIAL_WORK_IDS[index];
        if (!workId) throw new SourcePipelineError('DECODED_SOURCE_MISMATCH', '対象作品indexが不正です');
        const result = extractDialogueCandidates(source as ProcessingDecodedSource, workId);
        if (!result.ok) throw new SourcePipelineError('DIALOGUE_EXTRACTION_FAILED', `台詞抽出に失敗しました: ${workId}`, result.diagnostics);
        return result.candidates;
      });
      await writeJsonArtifactTreeAtomic(workspace, target, intermediateEntries(decoded, extracted), { expectedFingerprint });
      return { hash: hashValues(extracted), count: extracted.reduce((sum, items) => sum + items.length, 0) };
    }

    if (stage === 'normalize') {
      const target = join(workspace, PRODUCTION_ARTIFACTS.intermediate);
      const expectedFingerprint = await fingerprintArtifact(target);
      const [snapshot, works, sources] = await Promise.all([
        bibliographySnapshot(workspace), loadProductionSelectedWorks(workspace), loadProductionSourceRecords(workspace),
      ]);
      const decoded = await loadProductionDecodedSources(workspace, sources);
      const raw = await loadProductionRawCandidates(workspace, sources);
      assertRecordCorrespondence(sources);
      const candidates = raw.map((items) => items.map((item): Candidate => {
        const displayText = normalizeDisplayText(item.tokens);
        const speechText = normalizeSpeechText(item.tokens, SPEECH_RULES);
        return {
          candidateId: createCandidateId(
            item.workId,
            item.rawSourceSha256,
            item.rawTokenRange,
            item.extractorVersion,
            SUPPORTED_SPEECH_RULE_VERSION,
            normalizedTextHash(displayText, speechText),
          ),
          workId: item.workId,
          rawSourceSha256: item.rawSourceSha256,
          order: item.order,
          rawTokenRange: item.rawTokenRange,
          displayText,
          speechText,
          contextBefore: item.contextBefore,
          contextAfter: item.contextAfter,
          sourceAnchor: item.sourceAnchor,
          extractorVersion: item.extractorVersion,
          normalizerVersion: SUPPORTED_SPEECH_RULE_VERSION,
        };
      }));
      await writeJsonArtifactTreeAtomic(workspace, target, intermediateEntries(decoded, raw, candidates), { expectedFingerprint });
      await writeReviewDrafts(workspace, candidates, snapshot.fetchedAt);
      const evidence = evidenceRecord(snapshot, works, sources, candidates);
      await writeJsonArtifactAtomic(workspace, join(workspace, PRODUCTION_ARTIFACTS.evidence), evidence);
      return { hash: hashValues(candidates), count: candidates.reduce((sum, items) => sum + items.length, 0) };
    }

    throw new SourcePipelineError('PRODUCTION_STAGE_UNSUPPORTED', `production前半CLIの対象外stageです: ${stage}`);
  };
}
