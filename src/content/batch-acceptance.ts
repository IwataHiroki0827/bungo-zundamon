import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  assertVoiceAcceptanceTuple,
  type VoiceCompletenessReport,
  type VoiceDiffGenerationResult,
} from '../voice/generation.ts';
import { canonicalJson, fingerprintArtifact, writeJsonArtifactAtomic } from './artifacts.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type AcceptedAudioSource,
  type BatchId,
  type BatchManifest,
  type PreparedWorkAcceptanceEvidence,
  type Sha256,
  type WorkId,
  type WorkspaceRelativePath,
} from './batch.ts';
import type { F001ContentInvariantReport, IntegratedBuild } from './batch-public.ts';

export type { VoiceCompletenessReport } from '../voice/generation.ts';

export interface ActualCapacityReport {
  readonly result: 'pass' | 'pass_with_warning' | 'blocked';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly contentBuildSha256: Sha256;
  readonly distSha256: Sha256;
  readonly voiceConfigHash: Sha256;
  readonly planDigest: Sha256;
  readonly authorizationDigest: Sha256;
  readonly generationDigest: Sha256;
  readonly completenessDigest: Sha256;
  readonly [key: string]: unknown;
}

export interface DistPreview {
  readonly distSha256: Sha256;
  readonly contentBuildSha256: Sha256;
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly [key: string]: unknown;
}

export interface F001DistInvariantReport {
  readonly result: 'pass' | 'blocked';
  readonly distSha256: Sha256;
  readonly contentBuildSha256: Sha256;
  readonly reportSha256?: Sha256;
}

export type WorkAcceptanceEvidence = PreparedWorkAcceptanceEvidence;

export interface WorkPromotionOptions {
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
  readonly afterPhase?: (phase: 'prepared' | 'source-moved' | 'manifest-updated' | 'verified') => void | Promise<void>;
}

export class WorkPromotionError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkPromotionError';
  }
}

interface AcceptanceJournal {
  readonly schemaVersion: '1.0.0';
  readonly phase: 'prepared' | 'source-moved' | 'manifest-updated' | 'verified';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly staging: string;
  readonly target: string;
  readonly evidence: PreparedWorkAcceptanceEvidence;
  readonly nextManifestSha256: Sha256;
  readonly lockToken: string;
}

interface AcceptanceLock {
  readonly schemaVersion: '1.0.0';
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
  readonly batchId: BatchId;
}

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function workspaceRoot(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_PATH_UNSAFE', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_PATH_UNSAFE', 'workspace実体が不正です');
  }
  return root;
}

async function assertPath(root: string, target: string, allowMissing = false): Promise<void> {
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_PATH_UNSAFE', 'pathがworkspace外です');
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_PATH_UNSAFE', 'pathにlink/reparseがあります');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EINVAL', 'EISDIR', 'EBADF', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  } finally { await handle?.close(); }
}

async function loadManifest(root: string, batchId: BatchId): Promise<BatchManifest> {
  const path = join(root, 'content', 'batches', batchId, 'batch.json');
  await assertPath(root, path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new WorkPromotionError('WORK_PROMOTION_INPUT_STALE', 'manifest実体が不正です');
  }
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const result = validateBatchManifest(value);
  if (!result.ok || canonicalJson(result.value) !== await readFile(path, 'utf8')) {
    throw new WorkPromotionError('WORK_PROMOTION_INPUT_STALE', 'manifestがcanonical schemaではありません');
  }
  return result.value;
}

async function acceptedTree(root: string, batchId: BatchId): Promise<{ digest: Sha256; entries: Map<string, { sha256: Sha256; bytes: number }> }> {
  const base = join(root, 'content', 'batches', batchId, 'accepted-audio');
  if (!await exists(base)) return { digest: sha(''), entries: new Map() };
  await assertPath(root, base);
  const entries = new Map<string, { sha256: Sha256; bytes: number }>();
  for (const work of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!work.isDirectory() || work.isSymbolicLink() || !/^[0-9]{6}$/u.test(work.name)) {
      throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_ORPHAN_MISMATCH', `accepted-audioに未知entryがあります: ${work.name}`);
    }
    const directory = join(base, work.name);
    await assertPath(root, directory);
    for (const file of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!file.isFile() || file.isSymbolicLink() || !/^[A-Za-z0-9_-]+\.wav$/u.test(file.name)) {
        throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_ORPHAN_MISMATCH', `accepted-audioに未知fileがあります: ${work.name}/${file.name}`);
      }
      const path = join(directory, file.name);
      const bytes = new Uint8Array(await readFile(path));
      entries.set(`${work.name}/${file.name}`, { sha256: sha(bytes), bytes: bytes.byteLength });
    }
  }
  const digest = createHash('sha256');
  for (const [path, entry] of entries) digest.update(path).update('\0').update(String(entry.bytes)).update('\0').update(entry.sha256);
  return { digest: digest.digest('hex') as Sha256, entries };
}

function reportHash(value: unknown): Sha256 {
  return sha(canonicalJson(value));
}

function inside(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function resolveStoredStaging(root: string, batchId: BatchId, workId: WorkId, value: string): string {
  const expected = new RegExp(`^content/batches/${batchId}/\\.accepted-audio-staging-[0-9a-f-]{36}-${workId}$`, 'u');
  if (!expected.test(value)) throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', 'journal staging pathが不正です');
  return join(root, ...value.split('/'));
}

function parseJournal(text: string, batchId: BatchId, workId: WorkId, expectedTarget: string): AcceptanceJournal {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', 'journal JSONが不正です'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value) !== text) {
    throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', 'journalがcanonical objectではありません');
  }
  const record = value as Record<string, unknown>;
  const keys = ['batchId', 'evidence', 'lockToken', 'nextManifestSha256', 'phase', 'schemaVersion', 'staging', 'target', 'workId'];
  if (Object.keys(record).sort((a, b) => a.localeCompare(b, 'en')).join('\0') !== keys.join('\0') || record.schemaVersion !== '1.0.0' ||
    record.batchId !== batchId || record.workId !== workId || !['prepared', 'source-moved', 'manifest-updated', 'verified'].includes(String(record.phase)) ||
    typeof record.staging !== 'string' || record.target !== expectedTarget || typeof record.lockToken !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(record.lockToken) || typeof record.nextManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.nextManifestSha256) || record.evidence === null || typeof record.evidence !== 'object') {
    throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', 'journal schema/tupleが不正です');
  }
  return value as AcceptanceJournal;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function acquireLock(
  root: string,
  lockPath: string,
  journalPath: string,
  batchId: BatchId,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; token: string }> {
  let token: string = randomUUID();
  if (await exists(journalPath)) {
    try {
      const existing = JSON.parse(await readFile(journalPath, 'utf8')) as { lockToken?: unknown };
      if (typeof existing.lockToken === 'string' && /^[0-9a-f-]{36}$/u.test(existing.lockToken)) token = existing.lockToken;
    } catch {
      // journal本体の厳格検証はlock取得後に行い、ここではtoken候補だけを読む。
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      const value: AcceptanceLock = { schemaVersion: '1.0.0', pid: process.pid, startedAt: new Date().toISOString(), token, batchId };
      await handle.writeFile(canonicalJson(value), 'utf8');
      await handle.sync();
      await syncDirectory(dirname(lockPath));
      return { handle, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt !== 0) {
        throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_LOCKED', 'batch受入lockを取得できません');
      }
      let stale: AcceptanceLock;
      try {
        const text = await readFile(lockPath, 'utf8');
        stale = JSON.parse(text) as AcceptanceLock;
        if (canonicalJson(stale) !== text || stale.schemaVersion !== '1.0.0' || stale.batchId !== batchId ||
          !Number.isSafeInteger(stale.pid) || stale.pid <= 0 || !/^[0-9a-f-]{36}$/u.test(stale.token) || !Number.isFinite(Date.parse(stale.startedAt))) {
          throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_LOCKED', '既存lockのowner schemaが不正です', { cause: error });
        }
      } catch (error) {
        throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_LOCKED', '既存lockのowner情報が不正です', { cause: error });
      }
      if (processAlive(stale.pid)) throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_LOCKED', '生存中ownerがbatch受入lockを保持しています');
      if (await exists(journalPath)) {
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { lockToken?: unknown };
        if (journal.lockToken !== stale.token) throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_LOCKED', 'stale lockとjournal tokenが一致しません');
      }
      token = stale.token;
      await rm(lockPath, { force: true });
      await syncDirectory(dirname(lockPath));
    }
  }
  throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_LOCKED', 'batch受入lockを取得できません');
}

async function writeJournal(root: string, path: string, value: AcceptanceJournal): Promise<void> {
  await writeJsonArtifactAtomic(root, path, value, { expectedFingerprint: await fingerprintArtifact(path) });
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

function assertInputs(
  manifest: BatchManifest,
  workId: WorkId,
  stagedVoice: VoiceDiffGenerationResult,
  completeness: VoiceCompletenessReport,
  actual: ActualCapacityReport,
  preview: IntegratedBuild,
  pages: DistPreview,
  contentInvariant: F001ContentInvariantReport,
  distInvariant: F001DistInvariantReport,
): void {
  try {
    assertVoiceAcceptanceTuple(stagedVoice, completeness);
  } catch (error) {
    throw new WorkPromotionError('WORK_VOICE_INCOMPLETE', error instanceof Error ? error.message : 'voice tupleが不正です', { cause: error });
  }
  const work = manifest.workProgress[manifest.workIds.indexOf(workId)];
  if (!work || work.status !== 'voiced') throw new WorkPromotionError('WORK_PROMOTION_INPUT_STALE', '対象workはvoicedではありません');
  const voicedEvidence = work.stageRecords.at(-1);
  if (!voicedEvidence || voicedEvidence.stage !== 'voiced' ||
    !voicedEvidence.inputHashes.some((value) => value === stagedVoice.expectedManifestSha) ||
    !voicedEvidence.outputHashes.some((value) => value === stagedVoice.generationDigest) ||
    !voicedEvidence.outputHashes.some((value) => value === completeness.completenessDigest)) {
    throw new WorkPromotionError('WORK_PROMOTION_INPUT_STALE', 'voice artifactがpre-voice manifestと現voiced manifestのstage evidenceへ結合されていません');
  }
  if (stagedVoice.failed !== 0 || stagedVoice.failures.length !== 0 || completeness.result !== 'pass' ||
    completeness.uniqueAudioCount !== stagedVoice.assets.length || completeness.approvedCount <= 0 ||
    stagedVoice.batchId !== manifest.batchId || stagedVoice.workId !== workId ||
    ![stagedVoice.planDigest, stagedVoice.authorizationDigest, stagedVoice.generationDigest].every((value) => /^[a-f0-9]{64}$/u.test(value))) {
    throw new WorkPromotionError('WORK_VOICE_INCOMPLETE', '音声完全性PASSが一致しません');
  }
  if (actual.result !== 'pass' && actual.result !== 'pass_with_warning') throw new WorkPromotionError('WORK_CAPACITY_BLOCKED', '容量actualがblockedです');
  if (preview.mode !== 'work-preview' || preview.activeBatchId !== manifest.batchId || preview.activeWorkId !== workId ||
    pages.batchId !== manifest.batchId || pages.workId !== workId || pages.contentBuildSha256 !== preview.buildSha256 ||
    actual.batchId !== manifest.batchId || actual.workId !== workId || actual.contentBuildSha256 !== preview.buildSha256 ||
    actual.distSha256 !== pages.distSha256 || actual.voiceConfigHash !== stagedVoice.configHash || actual.planDigest !== stagedVoice.planDigest ||
    actual.authorizationDigest !== stagedVoice.authorizationDigest || actual.generationDigest !== stagedVoice.generationDigest ||
    actual.completenessDigest !== completeness.completenessDigest ||
    contentInvariant.result !== 'pass' ||
    contentInvariant.buildSha256 !== preview.buildSha256 || contentInvariant.stagingSha256 !== preview.buildSha256 ||
    distInvariant.result !== 'pass' || distInvariant.distSha256 !== pages.distSha256 || distInvariant.contentBuildSha256 !== preview.buildSha256) {
    throw new WorkPromotionError('WORK_PREVIEW_INVALID', 'preview/invariant tupleが一致しません');
  }
}

/** @des DES-F002-005 DES-F002-006 DES-F002-011 DES-F002-015 @fun FUN-F002-033 */
export async function promoteVerifiedWorkArtifacts(
  workspace: string,
  batchId: BatchId,
  workId: WorkId,
  stagedVoice: VoiceDiffGenerationResult,
  completeness: VoiceCompletenessReport,
  actual: ActualCapacityReport,
  preview: IntegratedBuild,
  pages: DistPreview,
  contentInvariant: F001ContentInvariantReport,
  distInvariant: F001DistInvariantReport,
  options: WorkPromotionOptions = {},
): Promise<WorkAcceptanceEvidence> {
  const root = await workspaceRoot(workspace);
  let manifest = await loadManifest(root, batchId);
  const initialWork = manifest.workProgress[manifest.workIds.indexOf(workId)];
  if (initialWork?.status === 'voiced') {
    assertInputs(manifest, workId, stagedVoice, completeness, actual, preview, pages, contentInvariant, distInvariant);
  } else if (initialWork?.status !== 'accepted') {
    throw new WorkPromotionError('WORK_PROMOTION_INPUT_STALE', '対象workはvoiced/acceptedではありません');
  }
  const expectedManifestSha = hashBatchManifest(manifest);
  const lockPath = join(root, '.cache', 'locks', `accepted-audio-${batchId}.lock`);
  const journalPath = join(root, '.cache', 'transactions', 'accepted-audio', `${batchId}-${workId}.json`);
  await mkdir(dirname(lockPath), { recursive: true });
  await assertPath(root, dirname(lockPath));
  const lock = await acquireLock(root, lockPath, journalPath, batchId);
  const target = join(root, 'content', 'batches', batchId, 'accepted-audio', workId);
  let staging = join(dirname(dirname(target)), `.accepted-audio-staging-${randomUUID()}-${workId}`);
  let sourceMoved = false;
  try {
    const journalExists = await exists(journalPath);
    if (!journalExists && await exists(target)) {
      const quarantine = join(root, '.cache', 'quarantine', 'accepted-audio', `${batchId}-${workId}-${randomUUID()}`);
      await mkdir(dirname(quarantine), { recursive: true });
      await rename(target, quarantine);
      await Promise.all([syncDirectory(dirname(target)), syncDirectory(dirname(quarantine))]);
      throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_ORPHAN_MISMATCH', `journalなしのwork directoryを隔離しました: ${relative(root, quarantine)}`);
    }
    const preTree = await acceptedTree(root, batchId);
    if (stagedVoice.preTreeDigest !== preTree.digest && initialWork?.status !== 'accepted' && !journalExists) {
      throw new WorkPromotionError('WORK_PROMOTION_INPUT_STALE', 'voice preTreeDigestが現在treeと一致しません');
    }
    let journal: AcceptanceJournal | undefined;
    if (journalExists) {
      const text = await readFile(journalPath, 'utf8');
      const value = parseJournal(text, batchId, workId, relative(root, target).replaceAll('\\', '/'));
      staging = resolveStoredStaging(root, batchId, workId, value.staging);
      await assertPath(root, staging, value.phase !== 'prepared');
      if (value.evidence.expectedManifestSha !== expectedManifestSha && hashBatchManifest(manifest) !== value.nextManifestSha256) {
        throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', '既存journal tupleが一致しません');
      }
      journal = value;
      sourceMoved = ['source-moved', 'manifest-updated', 'verified'].includes(journal.phase);
    }
    let evidence: PreparedWorkAcceptanceEvidence;
    let nextManifest: BatchManifest;
    if (journal) {
      evidence = journal.evidence;
      nextManifest = transitionWorkState(manifest, workId, 'accepted', evidence);
      if (journal.phase === 'prepared') {
        if (!await exists(staging) || await exists(target)) {
          throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', 'prepared recoveryのsource/target状態が不正です');
        }
        await rename(staging, target);
        sourceMoved = true;
        journal = { ...journal, phase: 'source-moved' };
        await writeJournal(root, journalPath, journal);
        await syncDirectory(dirname(target));
        await options.afterPhase?.('source-moved');
      }
    } else {
      await mkdir(staging, { recursive: false });
      await assertPath(root, staging);
      const acceptedSources: AcceptedAudioSource[] = [];
      for (const asset of [...stagedVoice.assets].sort((a, b) => a.audioId.localeCompare(b.audioId, 'en'))) {
        if (!/^[A-Za-z0-9_-]+$/u.test(asset.audioId) || asset.configHash !== stagedVoice.configHash || !isAbsolute(asset.sourcePath)) {
          throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_PATH_UNSAFE', 'voice asset metadataが不正です');
        }
        const allowedSourceRoot = asset.source === 'staging' ? stagedVoice.stagingRoot : join(root, '.cache', 'voice');
        if (!isAbsolute(allowedSourceRoot) || !inside(allowedSourceRoot, asset.sourcePath)) {
          throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_PATH_UNSAFE', `voice asset kind/rootが一致しません: ${asset.audioId}`);
        }
        await assertPath(root, resolve(asset.sourcePath));
        const info = await lstat(asset.sourcePath);
        const bytes = new Uint8Array(await readFile(asset.sourcePath));
        if (!info.isFile() || info.isSymbolicLink() || bytes.byteLength !== asset.bytes || sha(bytes) !== asset.sha256) {
          throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_HASH_MISMATCH', `voice assetが変化しています: ${asset.audioId}`);
        }
        const priorMatch = [...preTree.entries].find(([path]) => basename(path) === `${asset.audioId}.wav`);
        if (priorMatch && priorMatch[1].sha256 !== asset.sha256) {
          throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_CONFLICT', `同一audioIdのhashが異なります: ${asset.audioId}`);
        }
        if (priorMatch) {
          acceptedSources.push({
            path: `content/batches/${batchId}/accepted-audio/${priorMatch[0]}` as WorkspaceRelativePath,
            sha256: asset.sha256 as Sha256, bytes: asset.bytes, configHash: asset.configHash as Sha256,
          });
          continue;
        }
        const output = join(staging, `${asset.audioId}.wav`);
        await copyFile(asset.sourcePath, output);
        const handle = await open(output, 'r+');
        await handle.sync();
        await handle.close();
        acceptedSources.push({
          path: `content/batches/${batchId}/accepted-audio/${workId}/${asset.audioId}.wav` as WorkspaceRelativePath,
          sha256: asset.sha256 as Sha256, bytes: asset.bytes, configHash: asset.configHash as Sha256,
        });
      }
      await syncDirectory(staging);
      const stagedEntries = new Map(preTree.entries);
      for (const source of acceptedSources) {
        const currentPrefix = `content/batches/${batchId}/accepted-audio/${workId}/`;
        if (source.path.startsWith(currentPrefix)) {
          stagedEntries.set(`${workId}/${basename(source.path)}`, { sha256: source.sha256, bytes: source.bytes });
        }
      }
      const digest = createHash('sha256');
      for (const [path, entry] of [...stagedEntries].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        digest.update(path).update('\0').update(String(entry.bytes)).update('\0').update(entry.sha256);
      }
      const acceptedAt = options.acceptedAt ?? new Date().toISOString();
      evidence = {
        kind: 'accepted', batchId, workId, expectedManifestSha, acceptedSources,
        preTreeDigest: preTree.digest, postTreeDigest: digest.digest('hex') as Sha256,
        contentBuildSha: preview.buildSha256, contentStagingSha: preview.buildSha256, distSha: pages.distSha256,
        actualCapacityReportSha: reportHash(actual), f001ContentInvariantReportSha: reportHash(contentInvariant),
        f001DistInvariantReportSha: reportHash(distInvariant), journalId: randomUUID(), acceptedAt,
        acceptedBy: options.acceptedBy ?? 'content-acceptance-transaction',
      };
      nextManifest = transitionWorkState(manifest, workId, 'accepted', evidence);
      journal = {
        schemaVersion: '1.0.0', phase: 'prepared', batchId, workId,
        staging: relative(root, staging).replaceAll('\\', '/'), target: relative(root, target).replaceAll('\\', '/'), evidence,
        nextManifestSha256: hashBatchManifest(nextManifest), lockToken: lock.token,
      };
      await writeJournal(root, journalPath, journal);
      await options.afterPhase?.('prepared');
      await mkdir(dirname(target), { recursive: true });
      await rename(staging, target);
      sourceMoved = true;
      journal = { ...journal, phase: 'source-moved' };
      await writeJournal(root, journalPath, journal);
      await syncDirectory(dirname(target));
      await options.afterPhase?.('source-moved');
    }
    if ((await acceptedTree(root, batchId)).digest !== evidence.postTreeDigest) {
      throw new WorkPromotionError('WORK_ACCEPTED_AUDIO_HASH_MISMATCH', 'accepted tree digestが一致しません');
    }
    if (hashBatchManifest(manifest) !== journal.nextManifestSha256) {
      await writeBatchManifestAtomic(root, `content/batches/${batchId}/batch.json` as WorkspaceRelativePath, nextManifest, evidence.expectedManifestSha);
      manifest = await loadManifest(root, batchId);
      journal = { ...journal, phase: 'manifest-updated' };
      await writeJournal(root, journalPath, journal);
      await options.afterPhase?.('manifest-updated');
    }
    if (hashBatchManifest(manifest) !== journal.nextManifestSha256) throw new WorkPromotionError('WORK_MANIFEST_COMMIT_FAILED', 'manifest更新後hashが一致しません');
    journal = { ...journal, phase: 'verified' };
    await writeJournal(root, journalPath, journal);
    await options.afterPhase?.('verified');
    return evidence;
  } catch (error) {
    if (!sourceMoved) await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.handle.close();
    await rm(lockPath, { force: true });
  }
}
