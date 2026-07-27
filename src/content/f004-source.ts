import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import type { WorkspaceRelativePath } from './batch.ts';
import {
  isMintedApprovedBatchContext,
  type ApprovedBatchContext,
} from './batch-candidate.ts';
import {
  fixBatchSource,
  observeBatchBibliography,
  type BatchWorkRightsObservation,
  type BibliographyObservationContext,
  type FixedBatchSource,
} from './f003-reuse.ts';
import {
  decodeAozoraSource,
  ProductionAozoraTransport,
  type BatchSelectionManifest,
  type BibliographySnapshot,
  type DecodedSource,
  type SelectedWork,
  type SourceRecord,
  type WorkRightsObservation,
} from './source.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))[A-Za-z0-9._/-]+$/u;
const RIGHTS_PATH = 'content/batches/F004/rights-selection.json' as WorkspaceRelativePath;
const SOURCE_INDEX_PATH = 'content/batches/F004/source-index.json' as WorkspaceRelativePath;
const WORK_IDS = Object.freeze(['000466', '045679', '001918']);

export class F004SourceError extends Error {
  constructor(
    public readonly code: 'F004_RIGHTS_INELIGIBLE' | 'F004_SOURCE_DRIFT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F004SourceError';
  }
}

export interface VerifiedF004Rights {
  readonly __brand: 'VerifiedF004Rights';
  readonly works: readonly SelectedWork[];
  readonly observation: WorkRightsObservation;
  readonly bibliographySnapshot: Readonly<Record<string, unknown>>;
  readonly artifactSha256: string;
}

export interface F004SourceIndexWork {
  readonly workId: string;
  readonly title: string;
  readonly cardUrl: string;
  readonly sourceUrl: string;
  readonly recordPath: WorkspaceRelativePath;
  readonly rawPath: WorkspaceRelativePath;
  readonly rawSha256: string;
  readonly rawBytes: number;
  readonly bibliographyCharset: 'Shift_JIS';
  readonly baseEdition: string;
  readonly inputter: string;
  readonly proofreader: string;
  readonly sourceUpdatedAt: string;
  readonly fetchedAt: string;
}

export interface FixedF004Source {
  readonly __brand: 'FixedF004Source';
  readonly work: Readonly<F004SourceIndexWork>;
  readonly record: Readonly<SourceRecord>;
  readonly decoded: Readonly<DecodedSource>;
  readonly bodySelector: '.main_text';
  readonly sourceSha256: string;
}

const verifiedRights = new WeakSet<object>();

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sorted = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function safePath(value: unknown): value is WorkspaceRelativePath {
  return typeof value === 'string' && SAFE_PATH.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function safeRead(workspace: string, path: WorkspaceRelativePath): Promise<Uint8Array> {
  if (!isAbsolute(workspace) || !safePath(path)) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'workspaceまたはsource pathが不正です');
  }
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'workspace実体が不正です');
  }
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'source pathがworkspace外です');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new F004SourceError('F004_SOURCE_DRIFT', 'source pathにreparseがあります');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'source実体が通常fileではありません');
  }
  return new Uint8Array(await readFile(target));
}

function parseCanonicalJson(
  raw: Uint8Array,
  code: F004SourceError['code'],
  requireCanonical = true,
): unknown {
  const text = new TextDecoder().decode(raw);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new F004SourceError(code, 'F004 artifact JSONが不正です', { cause: error });
  }
  if (requireCanonical && text !== canonicalJson(value)) {
    throw new F004SourceError(code, 'F004 artifactがcanonical JSONではありません');
  }
  return value;
}

function validSelectedWork(value: unknown, index: number): value is SelectedWork {
  const workId = WORK_IDS[index];
  return isRecord(value) && exactKeys(value, [
    'baseEdition', 'cardUrl', 'charset', 'copyright', 'edition', 'inputter', 'language',
    'orthography', 'personCopyright', 'personId', 'proofreader', 'role', 'selectionReason',
    'sourceUrl', 'status', 'title', 'workId',
  ]) &&
    value.workId === workId && value.personId === '000081' && value.role === '著者' &&
    value.personCopyright === 'なし' && value.copyright === 'なし' &&
    value.status === '公開中' && value.language === '日本語原著' &&
    value.orthography === '新字新仮名' && value.charset === 'Shift_JIS' &&
    typeof value.cardUrl === 'string' && typeof value.sourceUrl === 'string';
}

/**
 * 取得済み公式書誌snapshotと3作品の権利条件をproduction artifactから再検算する。
 * @des DES-F004-003 @fun FUN-F004-006 @ut UT-F004-006
 */
export async function observeF004RightsSelection(workspace: string): Promise<VerifiedF004Rights> {
  const raw = await safeRead(workspace, RIGHTS_PATH);
  const value = parseCanonicalJson(raw, 'F004_RIGHTS_INELIGIBLE');
  if (!isRecord(value) || !exactKeys(value, ['batchId', 'bibliographySnapshot', 'kind', 'schemaVersion', 'selection']) ||
    value.batchId !== 'F004' || value.kind !== 'work-rights-selection' || value.schemaVersion !== '1.0.0' ||
    !isRecord(value.bibliographySnapshot) || !isRecord(value.selection) ||
    !exactKeys(value.selection, ['observation', 'works']) ||
    !Array.isArray(value.selection.works) || value.selection.works.length !== 3 ||
    !value.selection.works.every(validSelectedWork) || !isRecord(value.selection.observation)) {
    throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'F004権利selection schemaが不正です');
  }
  const observation = value.selection.observation;
  const selectedWorks = value.selection.works;
  if (!exactKeys(observation, ['bibliographySha256', 'observedAt', 'phase', 'works']) ||
    observation.phase !== 'selection' || !SHA256.test(String(observation.bibliographySha256)) ||
    !Array.isArray(observation.works) || observation.works.length !== 3 ||
    observation.works.some((entry, index) => {
      const selected = selectedWorks[index] as SelectedWork;
      return !isRecord(entry) || entry.workId !== selected.workId || entry.title !== selected.title ||
        entry.personId !== selected.personId || entry.personCopyright !== 'なし' ||
        entry.workCopyright !== 'なし' || entry.role !== '著者' || entry.translatorPresent !== false ||
        entry.status !== '公開中' || entry.orthography !== '新字新仮名' ||
        entry.cardUrl !== selected.cardUrl || entry.sourceUrl !== selected.sourceUrl;
    }) ||
    value.bibliographySnapshot.csvSha256 !== observation.bibliographySha256) {
    throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'F004権利観測と選定作品が一致しません');
  }
  const verified = deepFreeze({
    __brand: 'VerifiedF004Rights' as const,
    works: structuredClone(selectedWorks) as SelectedWork[],
    observation: structuredClone(observation) as unknown as WorkRightsObservation,
    bibliographySnapshot: structuredClone(value.bibliographySnapshot),
    artifactSha256: sha256(raw),
  });
  verifiedRights.add(verified);
  return verified;
}

function validIndexWork(value: unknown, index: number, selected: SelectedWork): value is F004SourceIndexWork {
  return isRecord(value) && exactKeys(value, [
    'baseEdition', 'bibliographyCharset', 'cardUrl', 'fetchedAt', 'inputter', 'proofreader',
    'rawBytes', 'rawPath', 'rawSha256', 'recordPath', 'sourceUpdatedAt', 'sourceUrl', 'title', 'workId',
  ]) &&
    value.workId === WORK_IDS[index] && value.workId === selected.workId && value.title === selected.title &&
    value.cardUrl === selected.cardUrl && value.sourceUrl === selected.sourceUrl &&
    value.baseEdition === selected.baseEdition && value.inputter === selected.inputter &&
    value.proofreader === selected.proofreader && value.bibliographyCharset === 'Shift_JIS' &&
    safePath(value.recordPath) && safePath(value.rawPath) && SHA256.test(String(value.rawSha256)) &&
    Number.isSafeInteger(value.rawBytes) && (value.rawBytes as number) > 0 &&
    typeof value.sourceUpdatedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.sourceUpdatedAt) &&
    typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt));
}

/**
 * rightsと結合した固定raw/recordを再読込しfatal decode・selector・hashを検証する。
 * @des DES-F004-003 @fun FUN-F004-007 @ut UT-F004-007
 */
export async function loadAndVerifyFixedF004Source(
  workspace: string,
  workId: string,
  rights: VerifiedF004Rights,
): Promise<FixedF004Source> {
  if (!isRecord(rights) || !verifiedRights.has(rights) || rights.__brand !== 'VerifiedF004Rights') {
    throw new F004SourceError('F004_SOURCE_DRIFT', '検証済みrightsが必要です');
  }
  const indexRaw = await safeRead(workspace, SOURCE_INDEX_PATH);
  const index = parseCanonicalJson(indexRaw, 'F004_SOURCE_DRIFT');
  if (!isRecord(index) || !exactKeys(index, ['batchId', 'bodySelector', 'rightsRef', 'schemaVersion', 'works']) ||
    index.batchId !== 'F004' || index.schemaVersion !== '1.0.0' || index.bodySelector !== '.main_text' ||
    index.rightsRef !== RIGHTS_PATH || !Array.isArray(index.works) || index.works.length !== 3 ||
    index.works.some((work, position) => !validIndexWork(work, position, rights.works[position]!))) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'F004 source indexが不正です');
  }
  const position = WORK_IDS.indexOf(workId);
  const work = index.works[position] as unknown as F004SourceIndexWork | undefined;
  if (position < 0 || !work) throw new F004SourceError('F004_SOURCE_DRIFT', '未承認work IDです');
  const [recordRaw, sourceRaw] = await Promise.all([
    safeRead(workspace, work.recordPath),
    safeRead(workspace, work.rawPath),
  ]);
  const recordValue = parseCanonicalJson(recordRaw, 'F004_SOURCE_DRIFT', false);
  if (!isRecord(recordValue) || !exactKeys(recordValue, [
    'bibliographyCharset', 'fetchedAt', 'httpCharset', 'mediaType', 'rawPath',
    'rawSha256', 'sourceUrl', 'workId',
  ]) ||
    recordValue.workId !== work.workId ||
    recordValue.rawPath !== `${work.workId}/source.raw` ||
    recordValue.rawSha256 !== work.rawSha256 || recordValue.sourceUrl !== work.sourceUrl ||
    recordValue.bibliographyCharset !== work.bibliographyCharset ||
    recordValue.fetchedAt !== work.fetchedAt || recordValue.mediaType !== 'text/html' ||
    sourceRaw.byteLength !== work.rawBytes || sha256(sourceRaw) !== work.rawSha256) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'F004 SourceRecord/raw tupleが一致しません');
  }
  let decoded: DecodedSource;
  try {
    decoded = decodeAozoraSource(recordValue as unknown as SourceRecord, sourceRaw);
  } catch (error) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'F004原典をfatal decodeできません', { cause: error });
  }
  if (!/<(?:div|main|section)\b[^>]*\bclass=["'][^"']*\bmain_text\b[^"']*["'][^>]*>/iu.test(decoded.text)) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'F004本文selectorがありません');
  }
  return deepFreeze({
    __brand: 'FixedF004Source' as const,
    work: structuredClone(work),
    record: structuredClone(recordValue) as unknown as SourceRecord,
    decoded: { ...decoded },
    bodySelector: '.main_text' as const,
    sourceSha256: sha256(canonicalJson({
      work,
      record: recordValue,
      bodySelector: '.main_text',
    })),
  });
}

function assertF004ManifestContext(
  context: ApprovedBatchContext,
  manifest: BatchSelectionManifest,
): void {
  if (!isMintedApprovedBatchContext(context) || context.definition.feature !== 'F004' ||
    manifest.batchId !== 'F004' || manifest.feature !== 'F004' ||
    manifest.author.authorId !== context.candidate.author.authorId ||
    canonicalJson(manifest.workIds) !== canonicalJson(context.definition.workIds) ||
    canonicalJson(manifest.workIds) !==
      canonicalJson(context.candidate.works.map((work) => work.workId))) {
    throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'F004 manifestとApprovedBatchContextが一致しません');
  }
}

/**
 * ProductionAozoraTransportでselection/predeployを再観測し、承認候補と同じ3作品だけを受理する。
 * @des DES-F004-003 @fun FUN-F004-006 @ut UT-F004-006
 */
export async function observeF004Rights(
  context: ApprovedBatchContext,
  manifest: BatchSelectionManifest,
  phase: 'selection' | 'predeploy',
  observationContext: BibliographyObservationContext,
): Promise<BatchWorkRightsObservation> {
  assertF004ManifestContext(context, manifest);
  if (!(observationContext.transport instanceof ProductionAozoraTransport)) {
    throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'production transportが必要です');
  }
  let result: BatchWorkRightsObservation;
  try {
    result = await observeBatchBibliography(manifest, phase, observationContext);
  } catch (error) {
    throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'F004権利観測に失敗しました', { cause: error });
  }
  if (result.phase === 'selection') {
    if (canonicalJson(result.works.map((work) => work.workId)) !== canonicalJson(context.definition.workIds) ||
      result.works.some((work, index) => {
        const candidate = context.candidate.works[index];
        const rights = result.observation.works[index];
        return !candidate || !rights ||
          work.workId !== candidate.workId || work.title !== candidate.title ||
          work.personId !== '000081' || work.personCopyright !== 'なし' || work.copyright !== 'なし' ||
          work.role !== '著者' || work.status !== '公開中' || work.orthography !== '新字新仮名' ||
          work.cardUrl !== candidate.cardUrl || work.sourceUrl !== candidate.xhtmlUrl ||
          rights.translatorPresent !== false;
      })) {
      throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'production書誌が承認候補と一致しません');
    }
  } else if (result.decision.result !== 'unchanged') {
    throw new F004SourceError('F004_RIGHTS_INELIGIBLE', 'predeploy権利観測でdriftを検出しました');
  }
  return result;
}

/**
 * Verified rightsとApprovedBatchContextへ結合した1作品をproduction取得し、atomic directoryへ固定する。
 * @des DES-F004-003 @fun FUN-F004-007 @ut UT-F004-007
 */
export async function freezeF004Source(
  workspace: string,
  context: ApprovedBatchContext,
  workId: string,
  rights: VerifiedF004Rights,
  transport: ProductionAozoraTransport,
): Promise<FixedBatchSource> {
  if (!isMintedApprovedBatchContext(context) || context.definition.feature !== 'F004' ||
    !isRecord(rights) || !verifiedRights.has(rights) || rights.__brand !== 'VerifiedF004Rights' ||
    !(transport instanceof ProductionAozoraTransport)) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'production source固定入力が不正です');
  }
  const index = context.definition.workIds.indexOf(workId);
  const work = rights.works[index];
  const candidate = context.candidate.works[index];
  if (index < 0 || !work || !candidate || work.workId !== candidate.workId ||
    work.title !== candidate.title || work.cardUrl !== candidate.cardUrl ||
    work.sourceUrl !== candidate.xhtmlUrl || work.personId !== '000081') {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'source workがApprovedBatchContextと一致しません');
  }
  const outputDir = join(resolve(workspace), 'data', 'batches', 'F004', 'fixed-sources', workId);
  try {
    return await fixBatchSource(work, transport, {
      workspaceRoot: resolve(workspace),
      outputDir,
      observation: rights.observation,
      snapshot: rights.bibliographySnapshot as unknown as BibliographySnapshot,
      toolVersion: 'bungo-zundamon-source-v1',
      changeNotice: '原文抽出・台詞選定・ずんだもん音声化を実施。加工部分はCC BY 4.0。',
    });
  } catch (error) {
    throw new F004SourceError('F004_SOURCE_DRIFT', 'F004 sourceのatomic固定に失敗しました', { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
