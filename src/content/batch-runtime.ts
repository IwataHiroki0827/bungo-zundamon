import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, writeJsonArtifactAtomic } from './artifacts.ts';
import {
  type BatchManifest,
  type BatchId,
  type ReleaseBuildContext,
  type ReleasePreparationContext,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkspaceRelativePath,
  hashBatchManifest,
  loadAcceptedBatches,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
} from './batch.ts';
import {
  type BatchDependencies,
  type BatchStageExecution,
  BatchCommandError,
} from './batch-command.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  type BatchSourceDependencies,
  runBatchSourceStages,
} from './batch-production.ts';
import { applyWorkReviews, extractDialogueCandidates, type Candidate, type ReviewRecord, type WorkReviewResult } from './processing.ts';
import {
  AOZORA_BIBLIOGRAPHY_URL,
  AOZORA_ORIGIN,
  AOZORA_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  ProductionAozoraTransport,
  decodeAozoraSource,
  fetchAozoraBibliography,
  parseAozoraBibliography,
  selectBatchWorks,
  type BatchSelectionManifest,
  type SourceRecord,
} from './source.ts';
import { ProductionVoicevoxClient } from '../voice/client.ts';
import { canonicalVoiceConfigV2, type VoiceConfigV2 } from '../voice/cache.ts';
import {
  authorizeVoiceDiffPlan,
  generateVoiceDiff,
  planVoiceDiff,
  verifyVoiceCompleteness,
  type VoiceCapacityAuthorization,
  type VoiceCompletenessReport,
  type VoiceDiffGenerationResult,
  type VoiceDiffPlan,
} from '../voice/generation.ts';
import {
  forecastCapacity,
  measureGitRepository,
  verifyActualCapacity,
  type CapacityForecast,
} from '../voice/budget.ts';
import {
  promoteVerifiedWorkArtifacts,
  type ActualCapacityReport,
  type DistPreview,
  type F001DistInvariantReport,
} from './batch-acceptance.ts';
import {
  buildIntegratedPublicTree,
  promoteIntegratedTree,
  type BatchCatalogFragment,
  type F001BaselineBundle,
  type F001ContentInvariantReport,
  type IntegratedBuild,
} from './batch-public.ts';
import { buildPagesPreview, type PagesDistPreview } from './pages-preview.ts';
import { loadAndVerifyF001Baseline, verifyF001DistInvariant, verifyF001Invariant, type F001Baseline } from './baseline.ts';
import { validateCatalogV2 } from '../ui/catalog-loader.ts';

const execFile = promisify(execFileCallback);

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function header(headers: Headers | Readonly<Record<string, string | undefined>>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

function charset(contentType: string | null): 'Shift_JIS' | 'UTF-8' | null {
  const match = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase();
  if (!match) return null;
  if (['shift_jis', 'shift-jis', 'sjis', 'windows-31j'].includes(match)) return 'Shift_JIS';
  if (['utf-8', 'utf8'].includes(match)) return 'UTF-8';
  return null;
}

function requireEditionRules(manifest: BatchManifest): BatchSelectionManifest {
  if (!manifest.editionRules || manifest.editionRules.length !== manifest.workIds.length) {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 3, 'source compositeにはhash拘束済みeditionRulesが必要です', 'normalize');
  }
  return { ...manifest, editionRules: manifest.editionRules };
}

function createSourceDependencies(transport: ProductionAozoraTransport): BatchSourceDependencies {
  return {
    async loadBibliography(context, scratch) {
      // runner所有random scratchだけへ取得し、成功時だけwork-artifactsへatomic昇格する。
      const output = join(scratch.root, 'bibliography-snapshot');
      const snapshot = await fetchAozoraBibliography(new URL(AOZORA_BIBLIOGRAPHY_URL), output, transport, {
        workspaceRoot: context.workspace,
        clock: context.clock,
      });
      const [csv, archive] = await Promise.all([
        readFile(join(output, snapshot.csvPath)),
        readFile(join(output, snapshot.archivePath)),
      ]);
      return { snapshot, csv, archive, rows: parseAozoraBibliography(csv) };
    },
    async selectWorks(bibliography, context) {
      return selectBatchWorks(
        bibliography.rows as ReturnType<typeof parseAozoraBibliography>,
        requireEditionRules(context.manifest),
        context.clock(),
        { sha256: bibliography.snapshot.csvSha256, fetchedAt: bibliography.snapshot.fetchedAt },
      );
    },
    async fetchSource(work, context) {
      const url = new URL(work.sourceUrl);
      const prefix = `/cards/${context.manifest.author.authorId}/files/`;
      if (url.origin !== AOZORA_ORIGIN || !url.pathname.startsWith(prefix) || url.search || url.hash) {
        throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 3, 'manifest選定外のsource URLです', 'normalize');
      }
      const response = await transport.request(url, {
        pathPrefix: prefix,
        allowedMediaTypes: ['application/xhtml+xml', 'text/html'],
        maxBytes: MAX_SOURCE_BYTES,
        timeoutMs: AOZORA_TIMEOUT_MS,
      });
      const mediaType = header(response.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (response.status !== 200 || !['application/xhtml+xml', 'text/html'].includes(mediaType) ||
        response.body.byteLength === 0 || response.body.byteLength > MAX_SOURCE_BYTES) {
        throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 3, 'source responseのstatus/media/bytesが不正です', 'normalize');
      }
      const record: SourceRecord = {
        workId: work.workId,
        rawPath: `${work.workId}/source.raw`,
        rawSha256: sha256(response.body),
        mediaType,
        httpCharset: charset(header(response.headers, 'content-type')),
        bibliographyCharset: work.charset,
        fetchedAt: response.fetchedAt ?? context.clock().toISOString(),
        sourceUrl: url.href,
      };
      return { record, raw: response.body.slice() };
    },
    decodeSource: (record, raw) => decodeAozoraSource(record, raw),
    extractCandidates(source, workId, context) {
      const extraction = extractDialogueCandidates(source, workId, new Set(context.manifest.workIds));
      if (!extraction.ok) throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 3, 'dialogue抽出診断がFAILです', 'normalize');
      return extraction.candidates;
    },
  };
}

async function loadManifest(workspace: string, batchId: string): Promise<BatchManifest> {
  if (!isAbsolute(workspace)) throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 1, 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 1, 'workspace実体が不正です');
  }
  const target = join(root, 'content', 'batches', batchId, 'batch.json');
  const relation = relative(root, target);
  const targetInfo = await lstat(target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation) ||
    !targetInfo.isFile() || targetInfo.isSymbolicLink() || await realpath(target) !== target) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 1, 'manifest path実体が不正です');
  }
  const value = JSON.parse(await readFile(target, 'utf8')) as unknown;
  const result = validateBatchManifest(value);
  if (!result.ok) throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 1, `${result.error.code}: ${result.error.message}`);
  return result.value;
}

interface VerifiedReviewInputs {
  readonly candidates: Candidate[];
  readonly candidateHashes: readonly Sha256[];
  readonly treeDigest: Sha256;
}

async function assertDescendantWithoutLinks(workspace: string, target: string, expected: 'file' | 'directory'): Promise<void> {
  const root = resolve(workspace);
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'review artifact pathがworkspace外です', 'review');
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'review artifact pathにlink/reparseがあります', 'review');
    }
  }
  const info = await lstat(target);
  if ((expected === 'file' && !info.isFile()) || (expected === 'directory' && !info.isDirectory())) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'review artifactはregular file/directoryである必要があります', 'review');
  }
  const actual = await realpath(target);
  const actualRelation = relative(root, actual);
  if (!actualRelation || actualRelation === '..' || actualRelation.startsWith(`..${sep}`) || isAbsolute(actualRelation) || actual !== target) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'review artifact実体がcanonical pathと一致しません', 'review');
  }
}

function sourceTreeDigest(entries: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Sha256 {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    hash.update(entry.path, 'utf8').update('\0').update(String(entry.bytes.byteLength), 'ascii').update('\0').update(entry.bytes);
  }
  return hash.digest('hex') as Sha256;
}

async function verifyReviewInputs(workspace: string, manifest: BatchManifest, workId: WorkId): Promise<VerifiedReviewInputs> {
  const artifactRoot = join(workspace, 'data', 'batches', manifest.batchId, 'work-artifacts', workId);
  await assertDescendantWithoutLinks(workspace, artifactRoot, 'directory');
  const sourcePath = join(artifactRoot, 'bibliography', 'source.json');
  await assertDescendantWithoutLinks(workspace, sourcePath, 'file');
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'bibliography snapshot JSONが不正です', 'review');
  }
  const safeName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
    !value.includes('/') && !value.includes('\\') && !value.includes(':') && value !== '.' && value !== '..' &&
    !value.endsWith('.') && !value.endsWith(' ') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value) &&
    !/%(?:0[0-9a-f]|1[0-9a-f]|2e|2f|5c|7f)/i.test(value) &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127);
  if (!safeName(snapshot.csvEntry) || snapshot.csvPath !== snapshot.csvEntry || !safeName(snapshot.archivePath) ||
    snapshot.archivePath === snapshot.csvEntry || typeof snapshot.csvSha256 !== 'string' ||
    typeof snapshot.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.csvSha256) ||
    !/^[0-9a-f]{64}$/.test(snapshot.archiveSha256) || !Number.isSafeInteger(snapshot.csvBytes) ||
    (snapshot.csvBytes as number) <= 0 || !Number.isSafeInteger(snapshot.archiveBytes) || (snapshot.archiveBytes as number) <= 0) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'bibliography snapshot path/hash/bytesが不正です', 'review');
  }
  const expectedPaths = [
    'bibliography/source.json',
    `bibliography/${snapshot.csvEntry}`,
    `bibliography/${snapshot.archivePath}`,
    'selected-works.json',
    `sources/${workId}/source.json`,
    `sources/${workId}/source.raw`,
    `intermediate/${workId}/decoded.json`,
    `intermediate/${workId}/raw-candidates.json`,
    `intermediate/${workId}/candidates.json`,
  ].sort((left, right) => left.localeCompare(right, 'en'));
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (current: string, logical: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'source artifact treeにlink/reparseがあります', 'review');
    }
    if (info.isFile()) {
      entries.push({ path: logical, bytes: await readFile(current) });
      return;
    }
    if (!info.isDirectory()) {
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'source artifact treeはregular fileだけを許可します', 'review');
    }
    for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right, 'en'))) {
      await walk(join(current, name), logical ? `${logical}/${name}` : name);
    }
  };
  await walk(artifactRoot, '');
  const actualPaths = entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'source artifact treeのfile集合がcanonical allowlistと一致しません', 'review');
  }
  const csvEntry = entries.find((entry) => entry.path === `bibliography/${snapshot.csvEntry}`);
  const archiveEntry = entries.find((entry) => entry.path === `bibliography/${snapshot.archivePath}`);
  if (!csvEntry || !archiveEntry || csvEntry.bytes.byteLength !== snapshot.csvBytes ||
    archiveEntry.bytes.byteLength !== snapshot.archiveBytes || sha256(csvEntry.bytes) !== snapshot.csvSha256 ||
    sha256(archiveEntry.bytes) !== snapshot.archiveSha256) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'bibliography CSV/archive実体がsnapshotと一致しません', 'review');
  }
  const candidateEntry = entries.find((entry) => entry.path === `intermediate/${workId}/candidates.json`);
  if (!candidateEntry) throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'candidates artifactがありません', 'review');
  let candidates: Candidate[];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(candidateEntry.bytes)) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not-array');
    candidates = parsed as Candidate[];
  } catch {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'candidates artifact JSONが不正です', 'review');
  }
  const candidateHashes = candidates.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'candidateがobjectではありません', 'review');
    }
    const value = candidate as Candidate & { readonly revisions?: unknown; readonly sha256?: unknown };
    const { revisions, sha256: declared, ...core } = value;
    void revisions;
    const computed = sha256(canonicalJson(core));
    if (declared !== computed || value.workId !== workId || value.order !== index) {
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'candidate SHA/work/orderが不正です', 'review');
    }
    return computed;
  });
  const digest = sourceTreeDigest(entries);
  const workIndex = manifest.workIds.indexOf(workId);
  const extracted = manifest.workProgress[workIndex]?.stageRecords.at(-1);
  const expectedOutputs = [digest, ...candidateHashes];
  if (!extracted || extracted.stage !== 'extracted' || extracted.count !== candidates.length ||
    canonicalJson(extracted.outputHashes) !== canonicalJson(expectedOutputs)) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'extracted evidenceがtree/candidate SHAと完全一致しません', 'review');
  }
  return { candidates, candidateHashes, treeDigest: digest };
}

async function executeReview(workspace: string, manifest: BatchManifest, workId: WorkId): Promise<BatchStageExecution> {
  const reviewPath = join(workspace, 'content', 'batches', manifest.batchId, 'reviews', `${workId}.json`);
  await assertDescendantWithoutLinks(workspace, reviewPath, 'file');
  const verified = await verifyReviewInputs(workspace, manifest, workId);
  const candidates = verified.candidates;
  const reviews = JSON.parse(await readFile(reviewPath, 'utf8')) as ReviewRecord[];
  const reviewed = applyWorkReviews(workId, candidates, reviews);
  if (reviewed.pending.length !== 0) throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 4, 'review pendingが残っています', 'review');
  const inputHashes = [
    hashBatchManifest(manifest),
    verified.treeDigest,
    ...verified.candidateHashes,
    sha256(canonicalJson(reviews)),
  ] as const;
  const outputHashes = [sha256(canonicalJson(reviewed))] as const;
  const completedAt = reviewed.all.map((item) => item.review.reviewedAt).sort().at(-1) ?? new Date().toISOString();
  const evidence: StageEvidence = {
    kind: 'stage',
    expectedManifestSha: hashBatchManifest(manifest),
    workId,
    stage: 'reviewed',
    inputHashes,
    outputHashes,
    toolVersion: 'batch-runtime-review/1.0.0',
    count: reviewed.all.length,
    completedAt,
    result: 'pass',
    pendingCount: 0,
  };
  const nextManifest = transitionWorkState(manifest, workId, 'reviewed', evidence);
  // manifest競合時のorphanをcanonical treeへ残さない。review結果は再生成可能cacheへ置く。
  await writeJsonArtifactAtomic(
    workspace,
    join(workspace, '.cache', 'batch-review', manifest.batchId, workId, 'review-result.json'),
    reviewed,
  );
  return { nextManifest, inputHashes, outputHashes, count: reviewed.all.length };
}

type RuntimeArtifactStage = 'capacity-forecast' | 'voice' | 'capacity-actual' | 'accept' | 'prepare-release' | 'release-verify';

const RUNTIME_EXIT_CODE: Readonly<Record<RuntimeArtifactStage, 6 | 7 | 8>> = {
  'capacity-forecast': 6,
  voice: 6,
  'capacity-actual': 7,
  accept: 7,
  'prepare-release': 8,
  'release-verify': 8,
};

function prerequisite(stage: RuntimeArtifactStage, message: string): BatchCommandError {
  return new BatchCommandError('BATCH_STAGE_PREREQUISITE', RUNTIME_EXIT_CODE[stage], message, stage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function digestArtifact(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}

async function readCanonicalRuntimeArtifact<T>(
  workspace: string,
  path: string,
  label: string,
  stage: RuntimeArtifactStage,
): Promise<T> {
  const root = resolve(workspace);
  const target = isAbsolute(path) ? resolve(path) : join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw prerequisite(stage, `${label}がworkspace外です`);
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw prerequisite(stage, `${label}がありません`);
      throw error;
    }
    if (info.isSymbolicLink()) throw prerequisite(stage, `${label} pathにlink/reparseがあります`);
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 16_777_216 || await realpath(target) !== target) {
    throw prerequisite(stage, `${label}実体が不正です`);
  }
  const text = await readFile(target, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw prerequisite(stage, `${label} JSONが不正です: ${error instanceof Error ? error.message : 'parse error'}`);
  }
  if (canonicalJson(value) !== text) throw prerequisite(stage, `${label}がcanonical JSONではありません`);
  return value as T;
}

export interface VoiceAuthorizationArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'voice-capacity-authorization';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly preTreeDigest: Sha256;
  readonly reviewSha256: Sha256;
  readonly configSha256: Sha256;
  readonly plan: VoiceDiffPlan;
  readonly authorization: VoiceCapacityAuthorization;
}

export interface VoiceGenerationRuntimeArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'voice-generation-runtime';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly preVoiceManifestSha: Sha256;
  readonly voicedManifestSha: Sha256;
  readonly generationSha256: Sha256;
  readonly generation: VoiceDiffGenerationResult;
}

interface MeasuredRuntimeTree {
  readonly bytes: number;
  readonly uniqueBytes: number;
  readonly files: readonly string[];
  readonly digest: Sha256;
}

async function measureRuntimeTree(root: string, allowMissing = false, excluded?: string): Promise<MeasuredRuntimeTree> {
  const resolvedRoot = resolve(root);
  try {
    const rootInfo = await lstat(resolvedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(resolvedRoot) !== resolvedRoot) throw new Error('unsafe root');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bytes: 0, uniqueBytes: 0, files: [], digest: sha256('') };
    }
    throw prerequisite('capacity-forecast', `容量計測rootが不正です: ${resolvedRoot}`);
  }
  const excludedRoot = excluded === undefined ? undefined : resolve(excluded);
  const measured: Array<{ path: string; bytes: number; sha256: Sha256 }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (excludedRoot && (target === excludedRoot || target.startsWith(`${excludedRoot}${sep}`))) continue;
      if (entry.isSymbolicLink()) throw prerequisite('capacity-forecast', `容量計測treeにlink/reparseがあります: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const info = await lstat(target);
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.isSymbolicLink() || await realpath(target) !== target) {
          throw prerequisite('capacity-forecast', `容量計測fileが不正です: ${target}`);
        }
        const relativePath = relative(resolvedRoot, target).split(sep).join('/');
        const fileDigest = createHash('sha256');
        for await (const chunk of createReadStream(target)) fileDigest.update(chunk as Uint8Array);
        const after = await lstat(target);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) {
          throw prerequisite('capacity-forecast', `容量計測中にfileが変化しました: ${target}`);
        }
        measured.push({ path: relativePath, bytes: info.size, sha256: fileDigest.digest('hex') as Sha256 });
      } else throw prerequisite('capacity-forecast', `容量計測treeにregular file以外があります: ${target}`);
    }
  };
  await walk(resolvedRoot);
  measured.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  let bytes = 0;
  let uniqueBytes = 0;
  const uniqueHashes = new Set<string>();
  const digest = createHash('sha256');
  for (const file of measured) {
    bytes += file.bytes;
    if (!Number.isSafeInteger(bytes)) throw prerequisite('capacity-forecast', '容量計測値がoverflowしました');
    if (!uniqueHashes.has(file.sha256)) {
      uniqueHashes.add(file.sha256);
      uniqueBytes += file.bytes;
      if (!Number.isSafeInteger(uniqueBytes)) throw prerequisite('capacity-forecast', 'unique容量計測値がoverflowしました');
    }
    digest.update(file.path, 'utf8').update('\0').update(String(file.bytes), 'ascii').update('\0').update(file.sha256, 'ascii');
  }
  return { bytes, uniqueBytes, files: measured.map((file) => join(resolvedRoot, ...file.path.split('/'))), digest: digest.digest('hex') as Sha256 };
}

async function measuredFreeBytes(workspace: string): Promise<number> {
  const stats = await statfs(workspace);
  const free = stats.bavail * stats.bsize;
  if (!Number.isSafeInteger(free) || free < 0) throw prerequisite('capacity-forecast', '作業drive空き容量を整数byteで計測できません');
  return free;
}

async function deriveRepositoryMeasurements(workspace: string, candidates: readonly string[]) {
  const fixed = await measureRuntimeTree(workspace, false, join(workspace, '.git', 'objects'));
  const objects = await measureGitRepository(workspace, candidates);
  return { repositoryNonObjectBytes: fixed.bytes, gitObjects: objects };
}

async function changedRepositoryCandidates(workspace: string): Promise<string[]> {
  const commands = [
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ] as const;
  const outputs = await Promise.all(commands.map((args) => execFile('git', [...args], { cwd: workspace, encoding: 'utf8' })));
  const candidates = new Set<string>();
  for (const { stdout } of outputs) {
    for (const relativePath of stdout.split('\0').filter(Boolean)) {
      const target = resolve(workspace, relativePath);
      const relation = relative(resolve(workspace), target);
      if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw prerequisite('capacity-actual', 'Git変更pathがworkspace外です');
      }
      try {
        const info = await lstat(target);
        if (info.isFile() && !info.isSymbolicLink()) candidates.add(target);
        else if (!info.isDirectory()) throw new Error('unsafe candidate');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw prerequisite('capacity-actual', `Git変更pathが不正です: ${relation}`);
      }
    }
  }
  return [...candidates].sort((left, right) => left.localeCompare(right, 'en'));
}

interface CapacityForecastInputsArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'capacity-forecast-inputs';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly plannedPagesBytes: number;
  readonly repositoryCandidateFiles: readonly string[];
  readonly liveWriteUpperBounds: number;
  readonly rollbackBackupBytes: number;
}

function validateForecastInputs(value: unknown, manifest: BatchManifest, workId: WorkId): CapacityForecastInputsArtifact {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'batchId', 'workId', 'expectedManifestSha', 'plannedPagesBytes',
    'repositoryCandidateFiles', 'liveWriteUpperBounds', 'rollbackBackupBytes',
  ]) || value.schemaVersion !== '1.0.0' || value.kind !== 'capacity-forecast-inputs' ||
    value.batchId !== manifest.batchId || value.workId !== workId || value.expectedManifestSha !== hashBatchManifest(manifest) ||
    !Number.isSafeInteger(value.plannedPagesBytes) || (value.plannedPagesBytes as number) < 0 ||
    !Number.isSafeInteger(value.liveWriteUpperBounds) || (value.liveWriteUpperBounds as number) < 0 ||
    !Number.isSafeInteger(value.rollbackBackupBytes) || (value.rollbackBackupBytes as number) < 0 ||
    !Array.isArray(value.repositoryCandidateFiles) || !value.repositoryCandidateFiles.every((item) => typeof item === 'string')) {
    throw prerequisite('capacity-forecast', 'capacity forecast inputs schema/tupleが不正です');
  }
  return value as unknown as CapacityForecastInputsArtifact;
}

async function executeCapacityForecast(
  workspace: string,
  manifest: BatchManifest,
  workId: WorkId,
  operations: ProductionBatchRuntimeOperations,
): Promise<BatchStageExecution> {
  const reviewUnknown = await readCanonicalRuntimeArtifact<unknown>(
    workspace, `.cache/batch-review/${manifest.batchId}/${workId}/review-result.json`, 'review result', 'capacity-forecast',
  );
  const review = validateReviewArtifact(reviewUnknown, manifest, workId);
  const config = await readCanonicalRuntimeArtifact<VoiceConfigV2>(workspace, manifest.voiceConfigRef, 'voice config', 'capacity-forecast');
  try { canonicalVoiceConfigV2(config); } catch (error) {
    throw prerequisite('capacity-forecast', `voice config schemaが不正です: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  const inputPath = `.cache/batch-capacity/${manifest.batchId}/${workId}/forecast-inputs.json`;
  const inputUnknown = await readCanonicalRuntimeArtifact<unknown>(workspace, inputPath, 'capacity forecast inputs', 'capacity-forecast');
  const inputs = validateForecastInputs(inputUnknown, manifest, workId);
  const acceptedAudio = await measureRuntimeTree(join(workspace, 'content', 'batches', manifest.batchId, 'accepted-audio'), true);
  const currentPages = await measureRuntimeTree(join(workspace, 'public'), false);
  const repositoryCandidates = [...new Set([...await changedRepositoryCandidates(workspace), ...inputs.repositoryCandidateFiles])];
  const repository = await deriveRepositoryMeasurements(workspace, repositoryCandidates);
  const freeBytes = await measuredFreeBytes(workspace);
  const items = review.approved.map(({ candidate }) => ({
    candidateId: candidate.candidateId, workId, speechText: candidate.speechText, approved: true,
  }));
  const plan = await operations.planVoice(items, config, join(workspace, '.cache', 'voice'), {
    batchId: manifest.batchId, workId, expectedManifestSha: inputs.expectedManifestSha, preTreeDigest: acceptedAudio.digest,
  });
  let report: CapacityForecast;
  try {
    report = await operations.forecastCapacity({
      plan,
      expectedManifestSha: inputs.expectedManifestSha,
      preTreeDigest: acceptedAudio.digest,
      planDigest: plan.planDigest,
      alreadyGeneratedUniqueAudioBytes: acceptedAudio.uniqueBytes,
      currentPagesBytes: currentPages.bytes,
      plannedPagesBytes: inputs.plannedPagesBytes,
      repositoryNonObjectBytes: repository.repositoryNonObjectBytes,
      gitObjects: repository.gitObjects,
      disk: {
        liveWriteUpperBounds: inputs.liveWriteUpperBounds,
        rollbackBackupBytes: inputs.rollbackBackupBytes,
        freeBytes,
      },
    });
  } catch (error) {
    throw prerequisite('capacity-forecast', `capacity forecastに失敗しました: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  if (report.result === 'blocked' || !report.canGenerate || report.actualCapacitySatisfied !== false ||
    report.planDigest !== plan.planDigest) {
    throw prerequisite('capacity-forecast', 'blockedまたはplan不一致のcapacity forecastです');
  }
  const authorization: VoiceCapacityAuthorization = {
    result: report.result,
    planDigest: report.planDigest,
    remainingResponseBytes: report.remainingResponseBytes,
    minimumFreeBytesAfterWrite: report.minimumFreeBytesAfterWrite,
  };
  // authorize関数にも通し、後続voiceが受理できないauthorizationを永続化しない。
  try { operations.authorizeVoice(plan, authorization); } catch (error) {
    throw prerequisite('capacity-forecast', `capacity authorizationが不正です: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  const forecastRef = `content/batches/${manifest.batchId}/capacity-forecast/${workId}.json` as WorkspaceRelativePath;
  const artifact: VoiceAuthorizationArtifact = {
    schemaVersion: '1.0.0', kind: 'voice-capacity-authorization', batchId: manifest.batchId, workId,
    expectedManifestSha: inputs.expectedManifestSha, preTreeDigest: acceptedAudio.digest,
    reviewSha256: digestArtifact(review), configSha256: digestArtifact(config), plan, authorization,
  };
  const evidencePath = join(workspace, '.cache', 'batch-capacity', manifest.batchId, workId, 'forecast-report.json');
  await Promise.all([
    writeJsonArtifactAtomic(workspace, join(workspace, ...forecastRef.split('/')), artifact),
    writeJsonArtifactAtomic(workspace, evidencePath, report),
  ]);
  const inputHashes = [hashBatchManifest(manifest), digestArtifact(review), digestArtifact(config), digestArtifact(inputs)];
  const outputHashes = [digestArtifact(artifact), digestArtifact(report)];
  const evidence: StageEvidence = {
    kind: 'stage', expectedManifestSha: hashBatchManifest(manifest), workId, stage: 'budget-approved',
    inputHashes, outputHashes, toolVersion: 'batch-runtime-capacity/1.0.0', count: plan.missCount,
    completedAt: new Date().toISOString(), result: report.result, forecastRef,
  };
  return { nextManifest: transitionWorkState(manifest, workId, 'budget-approved', evidence), inputHashes, outputHashes, count: plan.missCount };
}

function validateReviewArtifact(value: unknown, manifest: BatchManifest, workId: WorkId): WorkReviewResult {
  if (!isRecord(value) || value.workId !== workId || !Array.isArray(value.approved) || value.approved.length === 0 ||
    !Array.isArray(value.rejected) || !Array.isArray(value.pending) || value.pending.length !== 0 || !Array.isArray(value.all) ||
    value.all.length !== value.approved.length + value.rejected.length ||
    value.all.some((item) => !isRecord(item) || !isRecord(item.candidate) || item.candidate.workId !== workId ||
      !isRecord(item.review) || item.review.workId !== workId)) {
    throw prerequisite('voice', 'review result schema/tupleが不正です');
  }
  const work = manifest.workProgress[manifest.workIds.indexOf(workId)];
  const reviewed = work?.stageRecords.findLast((record) => record.stage === 'reviewed');
  const reviewSha = digestArtifact(value);
  if (!reviewed || !reviewed.outputHashes.includes(reviewSha)) {
    throw prerequisite('voice', 'review result hashがmanifest evidenceと一致しません');
  }
  return value as unknown as WorkReviewResult;
}

function validateVoiceAuthorization(
  value: unknown,
  manifest: BatchManifest,
  workId: WorkId,
  review: WorkReviewResult,
  config: VoiceConfigV2,
): VoiceAuthorizationArtifact {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'batchId', 'workId', 'expectedManifestSha', 'preTreeDigest',
    'reviewSha256', 'configSha256', 'plan', 'authorization',
  ]) || value.schemaVersion !== '1.0.0' || value.kind !== 'voice-capacity-authorization' ||
    value.batchId !== manifest.batchId || value.workId !== workId || value.expectedManifestSha !== hashBatchManifest(manifest) ||
    !isSha256(value.preTreeDigest) || value.reviewSha256 !== digestArtifact(review) ||
    value.configSha256 !== digestArtifact(config) || !isRecord(value.plan) || !isRecord(value.authorization)) {
    throw prerequisite('voice', 'capacity authorization schema/tuple/hashが不正です');
  }
  const artifact = value as unknown as VoiceAuthorizationArtifact;
  if (artifact.plan.batchId !== manifest.batchId || artifact.plan.workId !== workId ||
    artifact.plan.expectedManifestSha !== artifact.expectedManifestSha || artifact.plan.preTreeDigest !== artifact.preTreeDigest ||
    artifact.authorization.planDigest !== artifact.plan.planDigest ||
    !['pass', 'pass_with_warning'].includes(artifact.authorization.result)) {
    throw prerequisite('voice', 'voice plan/capacity authorization tupleが不正です');
  }
  return artifact;
}

export interface ProductionBatchRuntimeOperations {
  readonly planVoice: typeof planVoiceDiff;
  readonly authorizeVoice: typeof authorizeVoiceDiffPlan;
  readonly generateVoice: typeof generateVoiceDiff;
  readonly verifyVoice: typeof verifyVoiceCompleteness;
  readonly forecastCapacity: typeof forecastCapacity;
  readonly verifyActualCapacity: typeof verifyActualCapacity;
  readonly buildPagesPreview: typeof buildPagesPreview;
  readonly verifyF001Invariant: typeof verifyF001Invariant;
  readonly verifyF001DistInvariant: typeof verifyF001DistInvariant;
  readonly loadBaseline: typeof loadAndVerifyF001Baseline;
  readonly validateCatalog: typeof validateCatalogV2;
  readonly createVoiceClient: (workspace: string, config: VoiceConfigV2) => ProductionVoicevoxClient;
  readonly promoteWork: typeof promoteVerifiedWorkArtifacts;
  readonly loadBatches: typeof loadAcceptedBatches;
  readonly buildTree: typeof buildIntegratedPublicTree;
  readonly promoteTree: typeof promoteIntegratedTree;
}

const DEFAULT_RUNTIME_OPERATIONS: ProductionBatchRuntimeOperations = {
  planVoice: planVoiceDiff,
  authorizeVoice: authorizeVoiceDiffPlan,
  generateVoice: generateVoiceDiff,
  verifyVoice: verifyVoiceCompleteness,
  forecastCapacity,
  verifyActualCapacity,
  buildPagesPreview,
  verifyF001Invariant,
  verifyF001DistInvariant,
  loadBaseline: loadAndVerifyF001Baseline,
  validateCatalog: validateCatalogV2,
  createVoiceClient: (workspace, config) => new ProductionVoicevoxClient({
    baseUrl: 'http://127.0.0.1:50021', config, workspaceRoot: workspace, timeoutMs: 60_000, proxy: false,
  }),
  promoteWork: promoteVerifiedWorkArtifacts,
  loadBatches: loadAcceptedBatches,
  buildTree: buildIntegratedPublicTree,
  promoteTree: promoteIntegratedTree,
};

async function executeVoice(
  workspace: string,
  manifest: BatchManifest,
  workId: WorkId,
  operations: ProductionBatchRuntimeOperations,
): Promise<BatchStageExecution> {
  const index = manifest.workIds.indexOf(workId);
  const work = manifest.workProgress[index];
  if (!work?.forecastRef) throw prerequisite('voice', 'voiceにはcapacity authorization artifactが必要です');
  const reviewUnknown = await readCanonicalRuntimeArtifact<unknown>(
    workspace, `.cache/batch-review/${manifest.batchId}/${workId}/review-result.json`, 'review result', 'voice',
  );
  const review = validateReviewArtifact(reviewUnknown, manifest, workId);
  const config = await readCanonicalRuntimeArtifact<VoiceConfigV2>(workspace, manifest.voiceConfigRef, 'voice config', 'voice');
  try {
    canonicalVoiceConfigV2(config);
  } catch (error) {
    throw prerequisite('voice', `voice config schemaが不正です: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  const authorizationUnknown = await readCanonicalRuntimeArtifact<unknown>(workspace, work.forecastRef, 'voice capacity authorization', 'voice');
  const authorization = validateVoiceAuthorization(authorizationUnknown, manifest, workId, review, config);
  const items = review.approved.map(({ candidate }) => ({
    candidateId: candidate.candidateId,
    workId,
    speechText: candidate.speechText,
    approved: true,
  }));
  const reconstructed = await operations.planVoice(items, config, join(workspace, '.cache', 'voice'), {
    batchId: manifest.batchId,
    workId,
    expectedManifestSha: authorization.expectedManifestSha,
    preTreeDigest: authorization.preTreeDigest,
  });
  if (reconstructed.planDigest !== authorization.plan.planDigest ||
    canonicalJson(reconstructed) !== canonicalJson(authorization.plan)) {
    throw prerequisite('voice', 'voice planがreview/config/cacheの現在値と一致しません');
  }
  let authorized: VoiceDiffPlan;
  try {
    authorized = operations.authorizeVoice(reconstructed, authorization.authorization);
  } catch (error) {
    throw prerequisite('voice', `capacity authorizationがplanと一致しません: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  const staging = join(workspace, '.cache', `.voice-stage-${randomUUID()}-${workId}`);
  const generation = await operations.generateVoice(authorized, operations.createVoiceClient(workspace, config), staging);
  const candidateAudio = Object.fromEntries(
    generation.assets.flatMap((asset) => asset.candidateIds.map((candidateId) => [candidateId, asset.audioId])),
  );
  const completeness = await operations.verifyVoice(
    { batchId: manifest.batchId, workId, approved: review.approved, pending: review.pending },
    generation,
    { assets: generation.assets, candidateAudio },
    { allowedRoots: [generation.stagingRoot, join(workspace, '.cache', 'voice')] },
  );
  const voiceEvidenceRef = `content/batches/${manifest.batchId}/voice-evidence/${workId}.json` as WorkspaceRelativePath;
  const priorOutputHashes = work.stageRecords.at(-1)?.outputHashes ?? [];
  const inputHashes = [...new Set([
    authorization.expectedManifestSha,
    ...priorOutputHashes,
    generation.planDigest as Sha256,
    generation.authorizationDigest as Sha256,
  ])];
  const outputHashes = [generation.generationDigest as Sha256, completeness.completenessDigest as Sha256];
  const evidence: StageEvidence = {
    kind: 'stage',
    expectedManifestSha: authorization.expectedManifestSha,
    workId,
    stage: 'voiced',
    inputHashes,
    outputHashes,
    toolVersion: 'batch-runtime-voice/1.0.0',
    count: generation.assets.length,
    completedAt: new Date().toISOString(),
    result: 'pass',
    voiceEvidenceRef,
  };
  const nextManifest = transitionWorkState(manifest, workId, 'voiced', evidence);
  const voicedManifestSha = hashBatchManifest(nextManifest);
  const generationArtifact: VoiceGenerationRuntimeArtifact = {
    schemaVersion: '1.0.0',
    kind: 'voice-generation-runtime',
    batchId: manifest.batchId,
    workId,
    preVoiceManifestSha: authorization.expectedManifestSha,
    voicedManifestSha,
    generationSha256: digestArtifact(generation),
    generation,
  };
  const acceptanceRoot = join(workspace, '.cache', 'batch-accept', manifest.batchId, workId);
  await Promise.all([
    writeJsonArtifactAtomic(workspace, join(acceptanceRoot, 'voice-generation.json'), generationArtifact),
    writeJsonArtifactAtomic(workspace, join(acceptanceRoot, 'voice-completeness.json'), completeness),
    writeJsonArtifactAtomic(workspace, join(workspace, ...voiceEvidenceRef.split('/')), {
      schemaVersion: '1.0.0',
      batchId: manifest.batchId,
      workId,
      preVoiceManifestSha: authorization.expectedManifestSha,
      voicedManifestSha,
      planDigest: generation.planDigest,
      authorizationDigest: generation.authorizationDigest,
      generationDigest: generation.generationDigest,
      completenessDigest: completeness.completenessDigest,
    }),
  ]);
  return {
    nextManifest,
    inputHashes,
    outputHashes,
    count: generation.assets.length,
  };
}

interface CapacityActualInputsArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'capacity-actual-inputs';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly voicedManifestSha: Sha256;
  readonly liveWriteUpperBounds: number;
  readonly rollbackBackupBytes: number;
}

function validateActualInputs(value: unknown, manifest: BatchManifest, workId: WorkId): CapacityActualInputsArtifact {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'batchId', 'workId', 'voicedManifestSha',
    'liveWriteUpperBounds', 'rollbackBackupBytes',
  ]) || value.schemaVersion !== '1.0.0' || value.kind !== 'capacity-actual-inputs' || value.batchId !== manifest.batchId ||
    value.workId !== workId || value.voicedManifestSha !== hashBatchManifest(manifest) ||
    !Number.isSafeInteger(value.liveWriteUpperBounds) || (value.liveWriteUpperBounds as number) < 0 ||
    !Number.isSafeInteger(value.rollbackBackupBytes) || (value.rollbackBackupBytes as number) < 0) {
    throw prerequisite('capacity-actual', 'capacity actual inputs schema/tupleが不正です');
  }
  return value as unknown as CapacityActualInputsArtifact;
}

function appendActualEvidence(
  manifest: BatchManifest,
  workId: WorkId,
  evidence: StageEvidence,
): BatchManifest {
  const index = manifest.workIds.indexOf(workId);
  const current = manifest.workProgress[index];
  if (!current || current.status !== 'voiced' || evidence.expectedManifestSha !== hashBatchManifest(manifest)) {
    throw prerequisite('capacity-actual', 'capacity actual evidenceが現在のvoiced workと一致しません');
  }
  const record = {
    stage: evidence.stage, inputHashes: [...evidence.inputHashes], toolVersion: evidence.toolVersion,
    outputHashes: [...evidence.outputHashes], count: evidence.count, completedAt: evidence.completedAt,
  };
  const works = manifest.workProgress.map((work, workIndex) => workIndex === index ? {
    ...work, stageRecords: [...work.stageRecords, record], actualCapacityRef: evidence.actualCapacityRef,
  } : work);
  const candidate = { ...manifest, workProgress: works };
  const checked = validateBatchManifest(candidate);
  if (!checked.ok) throw prerequisite('capacity-actual', `capacity actual manifestが不正です: ${checked.error.code}`);
  return checked.value;
}

async function executeCapacityActual(
  workspace: string,
  manifest: BatchManifest,
  workId: WorkId,
  operations: ProductionBatchRuntimeOperations,
): Promise<BatchStageExecution> {
  const root = `.cache/batch-accept/${manifest.batchId}/${workId}`;
  const [generationArtifact, completeness, preview, baselineBundle, inputs] = await Promise.all([
    readCanonicalRuntimeArtifact<VoiceGenerationRuntimeArtifact>(workspace, `${root}/voice-generation.json`, 'voice generation', 'capacity-actual'),
    readCanonicalRuntimeArtifact<VoiceCompletenessReport>(workspace, `${root}/voice-completeness.json`, 'voice completeness', 'capacity-actual'),
    readCanonicalRuntimeArtifact<IntegratedBuild>(workspace, `${root}/content-preview.json`, 'content preview', 'capacity-actual'),
    operations.loadBaseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    readCanonicalRuntimeArtifact<unknown>(workspace, `${root}/capacity-actual-inputs.json`, 'capacity actual inputs', 'capacity-actual'),
  ]);
  const baseline = {
    baselineSha256: baselineBundle.baselineSha256,
    catalog: baselineBundle.catalog,
    files: baselineBundle.files,
  } as unknown as F001Baseline;
  const actualInputs = validateActualInputs(inputs, manifest, workId);
  const generation = generationArtifact.generation;
  if (generationArtifact.voicedManifestSha !== hashBatchManifest(manifest) || generationArtifact.batchId !== manifest.batchId ||
    generationArtifact.workId !== workId || generationArtifact.generationSha256 !== digestArtifact(generation) ||
    preview.mode !== 'work-preview' || preview.activeBatchId !== manifest.batchId || preview.activeWorkId !== workId ||
    preview.buildSha256 === undefined) {
    throw prerequisite('capacity-actual', 'voice/content preview tupleが現在のvoiced manifestと一致しません');
  }
  const catalogPath = join(preview.stagingRoot, 'content', 'catalog.json');
  const catalogBytes = await readFile(catalogPath);
  let catalogUnknown: unknown;
  try { catalogUnknown = JSON.parse(catalogBytes.toString('utf8')); } catch (error) {
    throw prerequisite('capacity-actual', `content preview catalogが不正です: ${error instanceof Error ? error.message : 'parse error'}`);
  }
  const catalog = operations.validateCatalog(catalogUnknown, catalogBytes.byteLength);
  if (!catalog.ok) throw prerequisite('capacity-actual', `content preview catalog schemaが不正です: ${catalog.error.code}`);
  const generationFiles = generation.assets.map((asset) => asset.sourcePath);
  if (generationFiles.some((file) => typeof file !== 'string') || new Set(generationFiles).size !== generation.assets.length) {
    throw prerequisite('capacity-actual', 'generation asset path集合が不正です');
  }
  const acceptedAudio = await measureRuntimeTree(join(workspace, 'content', 'batches', manifest.batchId, 'accepted-audio'), true);
  const pagesCacheRoot = join(workspace, '.cache');
  const pagesOutputRoot = join(pagesCacheRoot, `.work-pages-${randomUUID()}`);
  await mkdir(pagesCacheRoot, { recursive: true });
  await mkdir(pagesOutputRoot, { recursive: false });
  try {
    let contentInvariant;
    let pages: PagesDistPreview;
    let distInvariant;
    try {
      contentInvariant = await operations.verifyF001Invariant(catalog.value, preview.stagingRoot, baseline);
      if (contentInvariant.buildSha256 !== preview.buildSha256 || contentInvariant.stagingSha256 !== preview.buildSha256) {
        throw new Error('content invariant/build SHA mismatch');
      }
      pages = await operations.buildPagesPreview(preview, workspace, pagesOutputRoot, true);
      if (pages.batchId !== manifest.batchId || pages.workId !== workId || pages.contentBuildSha256 !== preview.buildSha256) {
        throw new Error('Pages preview tuple mismatch');
      }
      distInvariant = await operations.verifyF001DistInvariant(pages, baseline, contentInvariant);
    } catch (error) {
      throw prerequisite('capacity-actual', `preview/invariant検証に失敗しました: ${error instanceof Error ? error.message : 'invalid'}`);
    }
    const repositoryCandidates = [...new Set([...await changedRepositoryCandidates(workspace), ...generationFiles])];
    const repository = await deriveRepositoryMeasurements(workspace, repositoryCandidates);
    const freeBytes = await measuredFreeBytes(workspace);
    let actual;
    try {
      actual = await operations.verifyActualCapacity({
        phase: 'work-preview', batchId: manifest.batchId, workId,
        workspaceRoot: workspace, repositoryRoot: workspace,
        expectedManifestSha: generation.expectedManifestSha, preTreeDigest: generation.preTreeDigest,
        contentStagingSha256: contentInvariant.stagingSha256,
        voiceConfigHash: generation.configHash, planDigest: generation.planDigest,
        authorizationDigest: generation.authorizationDigest, generation, completeness,
        additionalAudioFiles: [...new Set([...acceptedAudio.files, ...generationFiles])],
        repositoryCandidateFiles: repositoryCandidates,
        repositoryNonObjectBytes: repository.repositoryNonObjectBytes,
        gitObjects: repository.gitObjects,
        disk: {
          liveWriteUpperBounds: actualInputs.liveWriteUpperBounds,
          rollbackBackupBytes: actualInputs.rollbackBackupBytes,
          freeBytes,
        },
      }, pages);
    } catch (error) {
      throw prerequisite('capacity-actual', `capacity actualに失敗しました: ${error instanceof Error ? error.message : 'invalid'}`);
    }
    if (actual.result === 'blocked') throw prerequisite('capacity-actual', 'capacity actualがblockedです');
    const actualCapacityRef = `content/batches/${manifest.batchId}/capacity-actual/${workId}.json` as WorkspaceRelativePath;
    await Promise.all([
      writeJsonArtifactAtomic(workspace, join(workspace, ...actualCapacityRef.split('/')), actual),
      writeJsonArtifactAtomic(workspace, join(workspace, root, 'dist-preview.json'), pages),
      writeJsonArtifactAtomic(workspace, join(workspace, root, 'f001-content-invariant.json'), contentInvariant),
      writeJsonArtifactAtomic(workspace, join(workspace, root, 'f001-dist-invariant.json'), distInvariant),
    ]);
    const inputHashes = [hashBatchManifest(manifest), generation.generationDigest as Sha256,
      completeness.completenessDigest as Sha256, preview.buildSha256, digestArtifact(actualInputs)];
    const outputHashes = [digestArtifact(actual), pages.distSha256, digestArtifact(contentInvariant), digestArtifact(distInvariant)];
    const evidence: StageEvidence = {
      kind: 'stage', expectedManifestSha: hashBatchManifest(manifest), workId, stage: 'capacity-actual',
      inputHashes, outputHashes, toolVersion: 'batch-runtime-capacity/1.0.0', count: actual.additionalAudio.includedPaths.length,
      completedAt: new Date().toISOString(), result: actual.result, actualCapacityRef,
    };
    return {
      nextManifest: appendActualEvidence(manifest, workId, evidence), inputHashes, outputHashes,
      count: evidence.count, actualCapacityResult: actual.result,
    };
  } finally {
    await rm(pagesOutputRoot, { recursive: true, force: true });
  }
}

interface AcceptanceArtifacts {
  readonly generationArtifact: VoiceGenerationRuntimeArtifact;
  readonly generation: VoiceDiffGenerationResult;
  readonly completeness: VoiceCompletenessReport;
  readonly actual: ActualCapacityReport;
  readonly preview: IntegratedBuild;
  readonly pages: DistPreview;
  readonly contentInvariant: F001ContentInvariantReport;
  readonly distInvariant: F001DistInvariantReport;
}

function validateAcceptanceArtifacts(value: AcceptanceArtifacts, manifest: BatchManifest, workId: WorkId): void {
  const voicedManifestSha = hashBatchManifest(manifest);
  const { generationArtifact, generation, completeness, actual, preview, pages, contentInvariant, distInvariant } = value;
  const voicedEvidence = manifest.workProgress[manifest.workIds.indexOf(workId)]?.stageRecords.findLast(
    (record) => record.stage === 'voiced',
  );
  if (!isRecord(generationArtifact) || !exactKeys(generationArtifact, [
    'schemaVersion', 'kind', 'batchId', 'workId', 'preVoiceManifestSha', 'voicedManifestSha', 'generationSha256', 'generation',
  ]) || generationArtifact.schemaVersion !== '1.0.0' || generationArtifact.kind !== 'voice-generation-runtime' ||
    generationArtifact.batchId !== manifest.batchId || generationArtifact.workId !== workId ||
    generationArtifact.voicedManifestSha !== voicedManifestSha || generationArtifact.generationSha256 !== digestArtifact(generation) ||
    !isRecord(generation) || generation.schemaVersion !== '2' || generation.batchId !== manifest.batchId ||
    generation.workId !== workId || generation.expectedManifestSha !== generationArtifact.preVoiceManifestSha ||
    !isSha256(generation.generationDigest) || !voicedEvidence || voicedEvidence.stage !== 'voiced' ||
    !voicedEvidence.inputHashes.some((value) => value === generationArtifact.preVoiceManifestSha) ||
    !voicedEvidence.outputHashes.some((value) => value === generation.generationDigest) ||
    !isRecord(completeness) || completeness.batchId !== manifest.batchId || completeness.workId !== workId ||
    completeness.expectedManifestSha !== generationArtifact.preVoiceManifestSha || completeness.result !== 'pass' ||
    !isSha256(completeness.completenessDigest) ||
    !voicedEvidence.outputHashes.some((value) => value === completeness.completenessDigest) ||
    !isRecord(actual) || actual.batchId !== manifest.batchId || actual.workId !== workId ||
    !['pass', 'pass_with_warning'].includes(actual.result) || !isRecord(preview) || preview.mode !== 'work-preview' ||
    preview.activeBatchId !== manifest.batchId || preview.activeWorkId !== workId || !isSha256(preview.buildSha256) ||
    !isRecord(pages) || pages.batchId !== manifest.batchId || pages.workId !== workId || !isSha256(pages.distSha256) ||
    !isRecord(contentInvariant) || contentInvariant.result !== 'pass' || !isRecord(distInvariant) || distInvariant.result !== 'pass') {
    throw prerequisite('accept', 'accept artifact schema/tuple/PASSが不正です');
  }
  if (actual.contentBuildSha256 !== preview.buildSha256 || pages.contentBuildSha256 !== preview.buildSha256 ||
    actual.distSha256 !== pages.distSha256 || contentInvariant.buildSha256 !== preview.buildSha256 ||
    contentInvariant.stagingSha256 !== preview.buildSha256 || distInvariant.contentBuildSha256 !== preview.buildSha256 ||
    distInvariant.distSha256 !== pages.distSha256 || actual.generationDigest !== generation.generationDigest ||
    actual.completenessDigest !== completeness.completenessDigest || actual.planDigest !== generation.planDigest ||
    actual.authorizationDigest !== generation.authorizationDigest) {
    throw prerequisite('accept', 'accept artifact hash chainが一致しません');
  }
}

async function acceptWorkFromArtifacts(
  workspace: string,
  manifest: BatchManifest,
  workId: WorkId,
  operations: ProductionBatchRuntimeOperations,
) {
  const root = `.cache/batch-accept/${manifest.batchId}/${workId}`;
  const [generationArtifact, completeness, actual, preview, pages, contentInvariant, distInvariant] = await Promise.all([
    readCanonicalRuntimeArtifact<VoiceGenerationRuntimeArtifact>(workspace, `${root}/voice-generation.json`, 'voice generation', 'accept'),
    readCanonicalRuntimeArtifact<VoiceCompletenessReport>(workspace, `${root}/voice-completeness.json`, 'voice completeness', 'accept'),
    readCanonicalRuntimeArtifact<ActualCapacityReport>(workspace, `content/batches/${manifest.batchId}/capacity-actual/${workId}.json`, 'actual capacity', 'accept'),
    readCanonicalRuntimeArtifact<IntegratedBuild>(workspace, `${root}/content-preview.json`, 'content preview', 'accept'),
    readCanonicalRuntimeArtifact<DistPreview>(workspace, `${root}/dist-preview.json`, 'dist preview', 'accept'),
    readCanonicalRuntimeArtifact<F001ContentInvariantReport>(workspace, `${root}/f001-content-invariant.json`, 'F001 content invariant', 'accept'),
    readCanonicalRuntimeArtifact<F001DistInvariantReport>(workspace, `${root}/f001-dist-invariant.json`, 'F001 dist invariant', 'accept'),
  ]);
  const generation = generationArtifact.generation;
  const artifacts = { generationArtifact, generation, completeness, actual, preview, pages, contentInvariant, distInvariant };
  validateAcceptanceArtifacts(artifacts, manifest, workId);
  const evidence = await operations.promoteWork(
    workspace, manifest.batchId, workId, generation, completeness, actual, preview, pages, contentInvariant, distInvariant,
  );
  const next = await loadManifest(workspace, manifest.batchId);
  return {
    manifest: next,
    inputHashes: [evidence.expectedManifestSha, evidence.contentBuildSha, evidence.distSha],
    outputHashes: [evidence.postTreeDigest, hashBatchManifest(next)],
    count: evidence.acceptedSources.length,
    actualCapacityResult: actual.result,
  } as const;
}

interface ReleaseRuntimePayload {
  readonly context: ReleasePreparationContext | ReleaseBuildContext;
  readonly f001: F001BaselineBundle;
  readonly batchCatalogs: Readonly<Record<string, BatchCatalogFragment>>;
  readonly expectedCurrentPublicSha256?: Sha256;
  readonly contentInvariant?: F001ContentInvariantReport;
  readonly candidate?: ReleaseCandidateArtifactBinding;
  readonly candidateArtifactPath?: WorkspaceRelativePath;
  readonly capacity?: ReleaseCapacityPlan;
}

interface ReleaseCapacityPlan {
  readonly repositoryCandidateFiles: readonly string[];
  readonly liveWriteUpperBounds: number;
  readonly rollbackBackupBytes: number;
}

export interface ReleaseCandidateArtifactBinding {
  readonly releaseCandidateBatchId: BatchId;
  readonly feature: string;
  readonly releaseCommit: string;
  readonly contentBuildSha256: Sha256;
  readonly distSha256: Sha256;
  readonly artifactDigest: Sha256;
  readonly evidenceSha256: Sha256;
}

export interface ReleaseRuntimeArtifact extends ReleaseRuntimePayload {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'prepare-release-inputs' | 'release-verify-inputs';
  readonly batchId: BatchId;
  readonly expectedManifestSha: Sha256;
  readonly payloadSha256: Sha256;
}

function validateContext(
  value: unknown,
  mode: 'prepare-release' | 'release-verify',
  manifest: BatchManifest,
  commit: string,
): ReleasePreparationContext | ReleaseBuildContext {
  if (!isRecord(value)) throw prerequisite(mode, 'release contextがobjectではありません');
  const preparation = mode === 'prepare-release';
  const keys = preparation
    ? ['releaseCandidateBatchId', 'feature', 'sourceCommit']
    : ['releaseCandidateBatchId', 'feature', 'releaseCommit', 'distSha256', 'artifactDigest'];
  if (!exactKeys(value, keys) || value.releaseCandidateBatchId !== manifest.batchId || value.feature !== manifest.feature ||
    value[preparation ? 'sourceCommit' : 'releaseCommit'] !== commit ||
    (!preparation && (!isSha256(value.distSha256) || !isSha256(value.artifactDigest)))) {
    throw prerequisite(mode, 'release context schema/candidate tupleがCLI/manifestと一致しません');
  }
  return value as unknown as ReleasePreparationContext | ReleaseBuildContext;
}

async function hashRuntimeCandidateArtifact(
  workspace: string,
  path: WorkspaceRelativePath,
): Promise<Sha256> {
  const root = resolve(workspace);
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw prerequisite('release-verify', 'candidate artifactがworkspace外です');
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw prerequisite('release-verify', 'candidate artifactがありません');
      throw error;
    }
    if (info.isSymbolicLink()) throw prerequisite('release-verify', 'candidate artifact pathにlink/reparseがあります');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || await realpath(target) !== target) {
    throw prerequisite('release-verify', 'candidate artifact実体が不正です');
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(target)) digest.update(chunk as Uint8Array);
  return digest.digest('hex') as Sha256;
}

function validateReleaseCandidateBinding(
  value: unknown,
  context: ReleaseBuildContext,
): ReleaseCandidateArtifactBinding {
  if (!isRecord(value) || !exactKeys(value, [
    'releaseCandidateBatchId', 'feature', 'releaseCommit', 'contentBuildSha256', 'distSha256', 'artifactDigest', 'evidenceSha256',
  ])) {
    throw prerequisite('release-verify', 'release candidate binding schemaが不正です');
  }
  const { evidenceSha256, ...core } = value;
  if (value.releaseCandidateBatchId !== context.releaseCandidateBatchId || value.feature !== context.feature ||
    value.releaseCommit !== context.releaseCommit || value.distSha256 !== context.distSha256 ||
    value.artifactDigest !== context.artifactDigest || !isSha256(value.contentBuildSha256) ||
    !isSha256(evidenceSha256) || evidenceSha256 !== digestArtifact(core)) {
    throw prerequisite('release-verify', 'release candidate bindingのtuple/hashがcontextと一致しません');
  }
  return value as unknown as ReleaseCandidateArtifactBinding;
}

async function loadReleaseRuntimeArtifact(
  workspace: string,
  manifest: BatchManifest,
  commit: string,
  mode: 'prepare-release' | 'release-verify',
): Promise<ReleaseRuntimeArtifact> {
  const path = `.cache/batch-release/${manifest.batchId}/${mode}-inputs.json`;
  const unknown = await readCanonicalRuntimeArtifact<unknown>(workspace, path, `${mode} inputs`, mode);
  const preparation = mode === 'prepare-release';
  const expectedKeys = [
    'schemaVersion', 'kind', 'batchId', 'expectedManifestSha', 'payloadSha256', 'context', 'f001', 'batchCatalogs',
    ...(preparation ? ['expectedCurrentPublicSha256', 'contentInvariant'] : ['candidate', 'candidateArtifactPath', 'capacity']),
  ];
  if (!isRecord(unknown) || !exactKeys(unknown, expectedKeys) || unknown.schemaVersion !== '1.0.0' ||
    unknown.kind !== `${mode}-inputs` || unknown.batchId !== manifest.batchId ||
    unknown.expectedManifestSha !== hashBatchManifest(manifest) || !isSha256(unknown.payloadSha256) ||
    !isRecord(unknown.f001) || !isRecord(unknown.batchCatalogs)) {
    throw prerequisite(mode, `${mode} inputs schema/manifest tupleが不正です`);
  }
  const context = validateContext(unknown.context, mode, manifest, commit);
  const payload: ReleaseRuntimePayload = {
    context,
    f001: unknown.f001 as unknown as F001BaselineBundle,
    batchCatalogs: unknown.batchCatalogs as Readonly<Record<string, BatchCatalogFragment>>,
    ...(preparation ? {
      expectedCurrentPublicSha256: unknown.expectedCurrentPublicSha256 as Sha256,
      contentInvariant: unknown.contentInvariant as F001ContentInvariantReport,
    } : {
      candidate: validateReleaseCandidateBinding(unknown.candidate, context as ReleaseBuildContext),
      candidateArtifactPath: unknown.candidateArtifactPath as WorkspaceRelativePath,
      capacity: unknown.capacity as unknown as ReleaseCapacityPlan,
    }),
  };
  if (unknown.payloadSha256 !== digestArtifact(payload) || !isSha256(payload.f001.baselineSha256) ||
    !isAbsolute(payload.f001.sourceRoot) || !Array.isArray(payload.f001.files) || !isRecord(payload.f001.catalog) ||
    !isRecord(payload.f001.syntheticBatch) || payload.f001.syntheticBatch.batchId !== 'F001' ||
    (preparation && (!isSha256(payload.expectedCurrentPublicSha256) || !isRecord(payload.contentInvariant) ||
      payload.contentInvariant.result !== 'pass')) || (!preparation &&
      (typeof payload.candidateArtifactPath !== 'string' || !isRecord(payload.candidate) || !isRecord(payload.capacity) ||
        !exactKeys(payload.capacity, ['repositoryCandidateFiles', 'liveWriteUpperBounds', 'rollbackBackupBytes']) ||
        !Array.isArray(payload.capacity.repositoryCandidateFiles) ||
        !payload.capacity.repositoryCandidateFiles.every((item) => typeof item === 'string') ||
        !Number.isSafeInteger(payload.capacity.liveWriteUpperBounds) || payload.capacity.liveWriteUpperBounds < 0 ||
        !Number.isSafeInteger(payload.capacity.rollbackBackupBytes) || payload.capacity.rollbackBackupBytes < 0))) {
    throw prerequisite(mode, `${mode} baseline/fragment/context hash chainが不正です`);
  }
  if (!preparation) {
    const candidatePath = payload.candidateArtifactPath as string;
    if (candidatePath.startsWith('/') || candidatePath.includes('\\') || candidatePath.includes(':') ||
      candidatePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw prerequisite('release-verify', 'candidate artifact pathが安全なworkspace相対pathではありません');
    }
    const actualArtifactDigest = await hashRuntimeCandidateArtifact(workspace, payload.candidateArtifactPath as WorkspaceRelativePath);
    if (actualArtifactDigest !== (context as ReleaseBuildContext).artifactDigest) {
      throw prerequisite('release-verify', 'candidate artifact実体digestがrelease contextと一致しません');
    }
  }
  return unknown as unknown as ReleaseRuntimeArtifact;
}

async function executeReleaseBuild(
  workspace: string,
  manifest: BatchManifest,
  commit: string,
  mode: 'prepare-release' | 'release-verify',
  operations: ProductionBatchRuntimeOperations,
) {
  const artifact = await loadReleaseRuntimeArtifact(workspace, manifest, commit, mode);
  const preparation = mode === 'prepare-release' ? artifact.context as ReleasePreparationContext : undefined;
  const release = mode === 'release-verify' ? artifact.context as ReleaseBuildContext : undefined;
  if (release) {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
      execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
    ]);
    if (head.trim() !== release.releaseCommit || status.trim() !== '') {
      throw prerequisite('release-verify', 'release-verifyにはexact clean releaseCommitが必要です');
    }
  }
  const verifiedBaseline = release
    ? await operations.loadBaseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    )
    : artifact.f001;
  if (release && verifiedBaseline.baselineSha256 !== artifact.f001.baselineSha256) {
    throw prerequisite('release-verify', '固定F001 baseline実体がrelease artifact bindingと一致しません');
  }
  const batches = await operations.loadBatches(workspace, preparation ? { preparation } : { release });
  const expectedBatchIds = batches.map((batch) => batch.manifest.batchId).sort((left, right) => left.localeCompare(right, 'en'));
  const fragmentIds = Object.keys(artifact.batchCatalogs).sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(expectedBatchIds) !== canonicalJson(fragmentIds)) {
    throw prerequisite(mode, 'batch fragments集合がloadAcceptedBatches結果と一致しません');
  }
  const staging = join(workspace, '.cache', `.public-stage-${randomUUID()}`);
  await mkdir(staging, { recursive: false });
  let promoted = false;
  let pagesOutputRoot: string | undefined;
  try {
    const build = await operations.buildTree(batches, verifiedBaseline, staging, {
      mode,
      workspaceRoot: workspace,
      batchCatalogs: artifact.batchCatalogs,
      ...(release ? { trackedPublicRoot: join(workspace, 'public') } : {}),
    }, undefined, preparation, release);
    if (release && artifact.candidate?.contentBuildSha256 !== build.buildSha256) {
      throw prerequisite('release-verify', '再生成content build SHAがcandidate bindingと一致しません');
    }
    if (preparation) {
      const invariant = artifact.contentInvariant as F001ContentInvariantReport;
      if (invariant.result !== 'pass' || invariant.buildSha256 !== build.buildSha256 || invariant.stagingSha256 !== build.buildSha256) {
        throw prerequisite(mode, 'F001 content invariantがprepare buildと一致しません');
      }
      await operations.promoteTree(
        workspace,
        staging,
        build.buildSha256,
        artifact.expectedCurrentPublicSha256 as Sha256,
        invariant,
        preparation,
      );
      promoted = true;
    } else if (release) {
      const capacity = artifact.capacity as ReleaseCapacityPlan;
      const baseline = {
        baselineSha256: verifiedBaseline.baselineSha256,
        catalog: verifiedBaseline.catalog,
        files: verifiedBaseline.files,
      } as unknown as F001Baseline;
      const catalogBytes = await readFile(join(build.stagingRoot, 'content', 'catalog.json'));
      let catalogUnknown: unknown;
      try { catalogUnknown = JSON.parse(catalogBytes.toString('utf8')); } catch (error) {
        throw prerequisite('release-verify', `release catalog JSONが不正です: ${error instanceof Error ? error.message : 'parse error'}`);
      }
      const catalog = operations.validateCatalog(catalogUnknown, catalogBytes.byteLength);
      if (!catalog.ok) throw prerequisite('release-verify', `release CatalogV2が不正です: ${catalog.error.code}`);
      const contentInvariant = await operations.verifyF001Invariant(catalog.value, build.stagingRoot, baseline);
      if (contentInvariant.result !== 'pass' || contentInvariant.buildSha256 !== build.buildSha256 ||
        contentInvariant.stagingSha256 !== build.buildSha256) {
        throw prerequisite('release-verify', 'release F001 content invariantがbuildと一致しません');
      }
      pagesOutputRoot = join(workspace, '.cache', `.release-pages-${randomUUID()}`);
      await mkdir(pagesOutputRoot, { recursive: false });
      const pages = await operations.buildPagesPreview(build, workspace, pagesOutputRoot, true);
      if (pages.batchId !== undefined || pages.workId !== undefined || pages.contentBuildSha256 !== build.buildSha256 ||
        pages.distSha256 !== release.distSha256 || artifact.candidate?.distSha256 !== pages.distSha256) {
        throw prerequisite('release-verify', 'release Pages preview tuple/distがcandidateと一致しません');
      }
      const distInvariant = await operations.verifyF001DistInvariant(pages, baseline, contentInvariant);
      const acceptedAudio = await measureRuntimeTree(join(workspace, 'content', 'batches', manifest.batchId, 'accepted-audio'), true);
      const plannedCandidates = capacity.repositoryCandidateFiles.map((value) => resolve(workspace, value));
      const candidateArtifact = join(workspace, ...(artifact.candidateArtifactPath as string).split('/'));
      const repositoryCandidates = [...new Set([...await changedRepositoryCandidates(workspace), ...plannedCandidates, candidateArtifact])];
      const repository = await deriveRepositoryMeasurements(workspace, repositoryCandidates);
      const freeBytes = await measuredFreeBytes(workspace);
      const actual = await operations.verifyActualCapacity({
        phase: 'release', releaseCandidateBatchId: release.releaseCandidateBatchId, feature: release.feature,
        releaseCommit: release.releaseCommit, artifactDigest: release.artifactDigest,
        contentBuildSha256: build.buildSha256, contentStagingSha256: contentInvariant.stagingSha256,
        workspaceRoot: workspace, repositoryRoot: workspace, additionalAudioFiles: acceptedAudio.files,
        repositoryCandidateFiles: repositoryCandidates, repositoryNonObjectBytes: repository.repositoryNonObjectBytes,
        gitObjects: repository.gitObjects,
        disk: {
          liveWriteUpperBounds: capacity.liveWriteUpperBounds,
          rollbackBackupBytes: capacity.rollbackBackupBytes,
          freeBytes,
        },
      }, pages);
      if (actual.phase !== 'release' || actual.result === 'blocked' || actual.releaseCommit !== release.releaseCommit ||
        actual.distSha256 !== pages.distSha256 || actual.artifactDigest !== release.artifactDigest) {
        throw prerequisite('release-verify', 'release capacity actualがblockedまたはcandidate tuple不一致です');
      }
      const reportRoot = join(workspace, '.cache', 'batch-release', manifest.batchId, 'release-reports');
      await Promise.all([
        writeJsonArtifactAtomic(workspace, join(reportRoot, 'f001-content-invariant.json'), contentInvariant),
        writeJsonArtifactAtomic(workspace, join(reportRoot, 'dist-preview.json'), pages),
        writeJsonArtifactAtomic(workspace, join(reportRoot, 'f001-dist-invariant.json'), distInvariant),
        writeJsonArtifactAtomic(workspace, join(reportRoot, 'capacity-actual.json'), actual),
      ]);
      return {
        inputHashes: [artifact.expectedManifestSha, artifact.payloadSha256, verifiedBaseline.baselineSha256],
        outputHashes: [build.buildSha256, pages.distSha256, digestArtifact(contentInvariant), digestArtifact(distInvariant), digestArtifact(actual)],
        count: build.files.length,
        actualCapacityResult: actual.result,
      } as const;
    }
    return {
      inputHashes: [artifact.expectedManifestSha, artifact.payloadSha256, artifact.f001.baselineSha256],
      outputHashes: [build.buildSha256],
      count: build.files.length,
    } as const;
  } finally {
    if (pagesOutputRoot) await rm(pagesOutputRoot, { recursive: true, force: true });
    if (!promoted) await rm(staging, { recursive: true, force: true });
  }
}

/** @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 production CLI dependency */
export function createProductionBatchDependencies(
  overrides: Partial<ProductionBatchRuntimeOperations> = {},
): BatchDependencies {
  const transport = new ProductionAozoraTransport();
  const sourceDependencies = createSourceDependencies(transport);
  const operations: ProductionBatchRuntimeOperations = { ...DEFAULT_RUNTIME_OPERATIONS, ...overrides };
  return {
    loadManifest: (workspace, batchId) => loadManifest(workspace, batchId),
    async executeStage(request) {
      if (request.stage === 'normalize') {
        if (!request.workId) throw new BatchCommandError('BATCH_WORK_REQUIRED', 1, 'normalizeには--workが必要です', 'normalize');
        const source = await runBatchSourceStages({
          workspace: request.workspace,
          manifest: request.manifest,
          workId: request.workId,
          speechRules: DEFAULT_BATCH_SPEECH_RULES,
          toolVersion: 'batch-runtime-source/1.0.0',
          clock: () => new Date(),
          dependencies: sourceDependencies,
        }, 'normalize');
        return {
          nextManifest: source.manifest,
          inputHashes: source.evidence.inputHashes,
          outputHashes: source.evidence.outputHashes,
          count: source.evidence.count,
        };
      }
      if (request.stage === 'review' && request.workId) return executeReview(request.workspace, request.manifest, request.workId);
      if (request.stage === 'capacity-forecast' && request.workId) {
        return executeCapacityForecast(request.workspace, request.manifest, request.workId, operations);
      }
      if (request.stage === 'voice' && request.workId) {
        return executeVoice(request.workspace, request.manifest, request.workId, operations);
      }
      if (request.stage === 'capacity-actual' && request.workId) {
        return executeCapacityActual(request.workspace, request.manifest, request.workId, operations);
      }
      throw new BatchCommandError(
        'BATCH_DEPENDENCY_FAILED',
        request.stage === 'rights' ? 2 : 3,
        'production sourceはnormalize compositeで実行します。架空のsubstage evidenceは生成しません',
        request.stage,
      );
    },
    persistManifest: ({ workspace, manifestPath, next, expectedSha256 }) =>
      writeBatchManifestAtomic(workspace, manifestPath, next, expectedSha256),
    acceptWork: ({ workspace, manifest, workId }) => acceptWorkFromArtifacts(workspace, manifest, workId, operations),
    prepareRelease: ({ workspace, manifest, commit }) =>
      executeReleaseBuild(workspace, manifest, commit, 'prepare-release', operations),
    verifyRelease: ({ workspace, manifest, commit }) =>
      executeReleaseBuild(workspace, manifest, commit, 'release-verify', operations),
    async verifyCommit({ workspace, commit }) {
      const [{ stdout: head }, { stdout: status }] = await Promise.all([
        execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
        execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
      ]);
      return head.trim() === commit && status.trim() === '';
    },
  };
}
