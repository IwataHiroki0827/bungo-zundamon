import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, writeJsonArtifactAtomic } from './artifacts.ts';
import {
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  hashBatchManifest,
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
import { applyWorkReviews, extractDialogueCandidates, type Candidate, type ReviewRecord } from './processing.ts';
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

/** @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 production CLI dependency */
export function createProductionBatchDependencies(): BatchDependencies {
  const transport = new ProductionAozoraTransport();
  const sourceDependencies = createSourceDependencies(transport);
  const unavailable = async (): Promise<never> => {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 8, 'このstageのproduction実装は後続タスクで接続されます');
  };
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
      throw new BatchCommandError(
        'BATCH_DEPENDENCY_FAILED',
        request.stage === 'rights' ? 2 : 3,
        'production sourceはnormalize compositeで実行します。架空のsubstage evidenceは生成しません',
        request.stage,
      );
    },
    persistManifest: ({ workspace, manifestPath, next, expectedSha256 }) =>
      writeBatchManifestAtomic(workspace, manifestPath, next, expectedSha256),
    acceptWork: unavailable,
    prepareRelease: unavailable,
    verifyRelease: unavailable,
    async verifyCommit({ workspace, commit }) {
      const [{ stdout: head }, { stdout: status }] = await Promise.all([
        execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
        execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
      ]);
      return head.trim() === commit && status.trim() === '';
    },
  };
}
