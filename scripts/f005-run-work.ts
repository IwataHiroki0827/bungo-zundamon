import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  ensureJsonArtifactDurable,
  fingerprintArtifact,
  type ArtifactDirectorySync,
  writeJsonArtifactAtomic,
} from '../src/content/artifacts.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkStatus,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  createF005AcceptanceCapacityRecorder,
  finalizeF005WorkAcceptance,
  prepareF005WorkAcceptance,
  prepareF005WorkPreview,
  stageF005WorkAcceptance,
  type F005ArtifactRef,
  type F005AcceptedWork,
  type F005EvidenceKind,
  type F005EvidenceRef,
  type F005PreviewArtifactKind,
  type F005PreviewArtifacts,
  type F005StagedWork,
} from '../src/content/f005-acceptance.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import {
  loadV040Baseline,
  type CapacityEntry,
  type CapacityForecastV3,
} from '../src/content/f005-foundation.ts';
import {
  flushF005ArtifactDirectory,
  startF005NativeCapacitySession,
} from '../src/content/f005-native-guard.ts';
import {
  createF005CapacityRecorder,
  createF005NativeCapacityJournalReader,
  generateF005Voice,
  measureF005ActualCapacity,
  planF005VoiceDiff,
  type F005LoopbackEngine,
  type F005SpeechItem,
} from '../src/content/f005-voice.ts';
import { F002_VOICE_CONFIG } from '../src/voice/f003.ts';
import type { VoicevoxSpeaker } from '../src/voice/types.ts';

const WORK_IDS = ['000799', '001076', '001104'] as const;
const MANIFEST_PATH = 'content/batches/F005/batch.json';
const OWNER = 'f005-production-runner';

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (value !== '..' && !value.startsWith(`..\\`) && !value.startsWith('../'));
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function treeDigest(root: string): Promise<Sha256> {
  const rows: Array<{ path: string; bytes: number; sha256: Sha256 }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`public tree内にlinkがあります: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        rows.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: bytes.byteLength,
          sha256: sha(bytes),
        });
      }
    }
  };
  await walk(root);
  return sha(canonicalJson(rows));
}

interface F005TreeMeasurement {
  readonly treeSha256: Sha256;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export const F005_RUNNER_PHASE_ORDER =
  ['voice', 'build', 'preview', 'build', 'accept'] as const;

export function createF005OfflineBuildArtifactPayloads(input: {
  readonly manifestSha256: Sha256;
  readonly baselineDescriptorSha256: Sha256;
  readonly expectedPublicTreeSha256: Sha256;
  readonly publicMeasurement: F005TreeMeasurement;
  readonly distMeasurement: F005TreeMeasurement;
}): Readonly<Record<F005PreviewArtifactKind, unknown>> {
  if (input.publicMeasurement.treeSha256 !== input.expectedPublicTreeSha256 ||
    input.publicMeasurement.fileCount <= 0 || input.publicMeasurement.totalBytes <= 0 ||
    input.distMeasurement.fileCount <= 0 || input.distMeasurement.totalBytes <= 0) {
    throw new Error('offline buildの実測tree bindingが不正です');
  }
  return Object.freeze({
    'content-build': {
      command: 'node scripts/build-offline.mjs',
      manifestSha256: input.manifestSha256,
      public: input.publicMeasurement,
      dist: input.distMeasurement,
    },
    'content-staging': {
      root: 'public',
      manifestSha256: input.manifestSha256,
      measurement: input.publicMeasurement,
    },
    dist: {
      root: 'dist',
      manifestSha256: input.manifestSha256,
      measurement: input.distMeasurement,
    },
    'f001-content-invariant-report': {
      result: 'pass',
      baselineDescriptorSha256: input.baselineDescriptorSha256,
      expectedPublicTreeSha256: input.expectedPublicTreeSha256,
      actualPublicTreeSha256: input.publicMeasurement.treeSha256,
    },
    'f001-dist-invariant-report': {
      result: 'pass',
      baselineDescriptorSha256: input.baselineDescriptorSha256,
      contentBuildSha256: input.publicMeasurement.treeSha256,
      distSha256: input.distMeasurement.treeSha256,
    },
  });
}

export async function writeCanonicalArtifact(
  workspace: string,
  path: string,
  value: unknown,
  directorySync: ArtifactDirectorySync = flushF005ArtifactDirectory,
): Promise<Sha256> {
  const expectedText = canonicalJson(value);
  const initial = await fingerprintArtifact(path);
  if (initial !== null) {
    const current = await readFile(path, 'utf8');
    if (current !== expectedText) {
      throw new Error(`既存artifactが現在のtupleと異なります: ${path}`);
    }
    await ensureJsonArtifactDurable(workspace, path, expectedText, directorySync);
    return sha(current);
  }
  await writeJsonArtifactAtomic(workspace, path, value, {
    directorySync,
    expectedFingerprint: null,
  });
  const actual = await readFile(path, 'utf8');
  if (actual !== expectedText) throw new Error(`artifact post-readが一致しません: ${path}`);
  return sha(actual);
}

async function measureTree(root: string): Promise<F005TreeMeasurement> {
  const rows: Array<{ path: string; bytes: number; sha256: Sha256 }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`build tree内にlinkがあります: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        rows.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: bytes.byteLength,
          sha256: sha(bytes),
        });
      }
    }
  };
  await walk(root);
  return {
    treeSha256: sha(canonicalJson(rows)),
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

export function parseF005RunWorkArguments(argv: readonly string[]): WorkId {
  const flag = argv.indexOf('--work');
  const value = flag >= 0 ? argv[flag + 1] : argv[0];
  if (!value || !WORK_IDS.includes(value as typeof WORK_IDS[number])) {
    throw new Error(`usage: f005-run-work.ts --work ${WORK_IDS.join('|')}`);
  }
  return value as WorkId;
}

export function selectF005CurrentWork(
  manifest: BatchManifest,
  requestedWorkId: WorkId,
): { readonly workId: WorkId; readonly acceptedWorkIds: readonly WorkId[] } {
  const currentIndex = manifest.workProgress.findIndex((work) => work.status !== 'accepted');
  if (currentIndex < 0) throw new Error('F005の全作品はaccepted済みです');
  const current = manifest.workProgress[currentIndex];
  if (!current || current.workId !== requestedWorkId ||
    manifest.workProgress.slice(0, currentIndex).some((work) => work.status !== 'accepted') ||
    manifest.workProgress.slice(currentIndex + 1).some((work) => work.status !== 'pending')) {
    throw new Error('requested workはmanifest順の現在workではありません');
  }
  return {
    workId: requestedWorkId,
    acceptedWorkIds: manifest.workProgress.slice(0, currentIndex).map((work) => work.workId),
  };
}

export async function enterF005ProductionSession<Prepared, Session, Result>(
  readOnly: () => Promise<Prepared>,
  startSession: (prepared: Prepared) => Promise<Session>,
  mutate: (prepared: Prepared, session: Session) => Promise<Result>,
): Promise<Result> {
  const prepared = await readOnly();
  const session = await startSession(prepared);
  return mutate(prepared, session);
}

export async function runOfflineBuild(
  workspace: string,
  runInheritedWorker: (
    executable: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ readonly pid: number; readonly exitCode: number }>,
): Promise<void> {
  const entry = join(workspace, 'scripts', 'build-offline.mjs');
  const result = await runInheritedWorker(process.execPath, [entry], workspace);
  if (result.exitCode !== 0) {
    throw new Error(`offline build failed: ${String(result.exitCode)}`);
  }
}

function loopbackEngine(): F005LoopbackEngine {
  const baseUrl = new URL(process.env.VOICEVOX_URL ?? 'http://127.0.0.1:50021/');
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(new URL(path, baseUrl), init);
    if (!response.ok) throw new Error(`VOICEVOX ${path}: HTTP ${response.status}`);
    return response;
  };
  return Object.freeze({
    baseUrl,
    config: F002_VOICE_CONFIG,
    getVersion: async () => (await request('version')).json() as Promise<string>,
    getSpeakers: async () => (await request('speakers')).json() as Promise<readonly VoicevoxSpeaker[]>,
    createAudioQuery: async (text: string) =>
      (await request(`audio_query?text=${encodeURIComponent(text)}&speaker=3`, { method: 'POST' })).json(),
    synthesize: async (query: unknown) => new Uint8Array(await (await request(
      'synthesis?speaker=3',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
      },
    )).arrayBuffer()),
  });
}

async function main(): Promise<void> {
  const workId = parseF005RunWorkArguments(process.argv.slice(2));
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const publicRoot = join(workspace, 'public');
  const publicBefore = await treeDigest(publicRoot);
  const context = await loadVerifiedF005Definition(workspace);
  const baseline = await loadV040Baseline(workspace, context);
  const [speech, forecastArtifact, candidateText, manifestText] = await Promise.all([
    canonicalArtifact<readonly (F005SpeechItem & Record<string, unknown>)[]>(
      workspace,
      `content/batches/F005/work-artifacts/${workId}/speech-items.json`,
    ),
    canonicalArtifact<{ forecast: CapacityForecastV3 }>(
      workspace,
      `content/batches/F005/capacity-forecast/${workId}.json`,
    ),
    readFile(join(
      workspace,
      'content',
      'batches',
      'F005',
      'work-artifacts',
      workId,
      'candidates.json',
    ), 'utf8'),
    readFile(join(workspace, ...MANIFEST_PATH.split('/')), 'utf8'),
  ]);
  const checkedManifest = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checkedManifest.ok || canonicalJson(checkedManifest.value) !== manifestText) {
    throw new Error('F005 manifestがcanonicalではありません');
  }
  const selected = selectF005CurrentWork(checkedManifest.value, workId);
  const speechItems = speech.value.map((item): F005SpeechItem => ({
    candidateId: item.candidateId,
    speechText: item.speechText,
    speechSha256: item.speechSha256,
    approved: true,
  }));
  const plan = planF005VoiceDiff(speechItems, F002_VOICE_CONFIG, { entries: [] });

  // この呼出しがproductionの最初のmutation境界。ETW権限がなければ何も変更せず停止する。
  const candidateSha256 = forecastArtifact.value.forecast.candidateSha256 as Sha256;
  let candidateValue: unknown;
  try {
    candidateValue = JSON.parse(candidateText) as unknown;
  } catch {
    throw new Error('candidate artifact JSONが不正です');
  }
  if (canonicalJson(candidateValue) !== candidateText || sha(candidateText) !== candidateSha256) {
    throw new Error('capacity forecastのcandidate SHAがcanonical候補実体と一致しません');
  }
  const session = await enterF005ProductionSession(
    async () => ({ workspace, owner: OWNER, workId, candidateSha256 }),
    (tuple) => startF005NativeCapacitySession(tuple),
    async (_tuple, startedSession) => startedSession,
  );
  const identity = {
    journalId: session.journalId as Sha256,
    owner: session.owner,
    sessionNonce: session.sessionNonce as Sha256,
    workerPid: session.workerPid,
  };
  const voiceRecorder = createF005CapacityRecorder(identity, session.voiceBackend);
  const acceptanceRecorder = createF005AcceptanceCapacityRecorder(identity, session.acceptanceBackend);
  const runRoot = join(workspace, '.cache', 'f005-run', session.journalId, workId);
  const voiceRoot = join(workspace, '.cache', `f005-voice-${workId}-${session.journalId}`);
  let buildSequence = 0;
  try {
    const voice = await generateF005Voice(
      plan,
      loopbackEngine(),
      voiceRoot,
      voiceRecorder,
      workId,
    );

    const formalPhase = sha(`${session.journalId}\0${workId}\0formal-build`);
    buildSequence = 0;
    const formalNotice = async (
      kind: 'create' | 'rename' | 'delete',
      path: string,
      targetPath: string | null,
      bytes: number,
      digest: Sha256 | null,
    ): Promise<void> => {
      if (!inside(workspace, path) || path.startsWith(publicRoot) ||
        (targetPath !== null && (!inside(workspace, targetPath) || targetPath.startsWith(publicRoot)))) {
        throw new Error('runner build mutation pathがallowlist外です');
      }
      buildSequence += 1;
      await session.observeMutation({
        noticeId: sha(`${formalPhase}\0${buildSequence}\0${kind}\0${path}\0${targetPath ?? ''}`),
        sequence: buildSequence,
        phase: 'build',
        phaseInstanceId: formalPhase,
        kind,
        path,
        targetPath,
        sha256: digest,
        bytes,
      });
    };
    await session.beginPhase('build', workId, formalPhase);
    await mkdir(runRoot, { recursive: true });
    await formalNotice('create', runRoot, null, 0, null);
    const writeCanonical = async (path: string, value: unknown): Promise<Sha256> => {
      if (!inside(workspace, path) || path.startsWith(publicRoot)) throw new Error('publicへのwriteは拒否します');
      return writeCanonicalArtifact(workspace, path, value);
    };
    const voiceEvidencePath =
      `content/batches/F005/work-artifacts/${workId}/runs/${session.journalId}/voice-generation.json`;
    const voiceEvidenceSha = await writeCanonical(join(workspace, ...voiceEvidencePath.split('/')), {
      schemaVersion: '1.0.0',
      kind: 'f005-voice-generation',
      workId,
      journalId: session.journalId,
      payload: voice,
    });
    const sourceSha = candidateSha256;
    const reviewSha = sha(await readFile(join(
      workspace,
      'content',
      'batches',
      'F005',
      'work-artifacts',
      workId,
      'review-agreement.json',
    )));
    const forecastSha = sha(forecastArtifact.text);
    let manifest: BatchManifest = checkedManifest.value;
    const stageOrder = ['pending', 'extracted', 'reviewed', 'budget-approved', 'voiced'] as const;
    const advance = (stage: 'extracted' | 'reviewed' | 'budget-approved' | 'voiced',
      output: Sha256, extra: Partial<StageEvidence> = {}): void => {
      const current = manifest.workProgress[manifest.workIds.indexOf(workId)];
      if (!current) throw new Error('current workがmanifestにありません');
      const currentRank = stageOrder.indexOf(current.status as typeof stageOrder[number]);
      const nextRank = stageOrder.indexOf(stage);
      if (currentRank >= nextRank) return;
      if (nextRank !== currentRank + 1) throw new Error('runner stage順が不正です');
      const expectedManifestSha = hashBatchManifest(manifest);
      manifest = transitionWorkState(manifest, workId, stage, {
        kind: 'stage',
        stage,
        expectedManifestSha,
        workId,
        result: 'pass',
        inputHashes: [expectedManifestSha],
        outputHashes: [output],
        count: stage === 'voiced' ? voice.assets.length : speechItems.length,
        toolVersion: 'f005-production-runner-v1',
        completedAt: new Date().toISOString(),
        ...extra,
      });
    };
    advance('extracted', sourceSha);
    advance('reviewed', reviewSha, { pendingCount: 0 });
    advance('budget-approved', forecastSha, {
      forecastRef:
        `content/batches/F005/capacity-forecast/${workId}.json` as StageEvidence['forecastRef'],
    });
    advance('voiced', voiceEvidenceSha, {
      voiceEvidenceRef: voiceEvidencePath as StageEvidence['voiceEvidenceRef'],
    });
    let persisted = checkedManifest.value;
    for (const next of manifest.workProgress[manifest.workIds.indexOf(workId)]?.stageRecords ?? []) {
      const current = persisted.workProgress[manifest.workIds.indexOf(workId)];
      if (current?.stageRecords.some((record) =>
        record.stage === next.stage && canonicalJson(record) === canonicalJson(next))) continue;
      const stage = next.stage as WorkStatus;
      const target = transitionWorkState(persisted, workId, stage, {
        kind: 'stage',
        stage,
        expectedManifestSha: hashBatchManifest(persisted),
        workId,
        result: 'pass',
        inputHashes: next.inputHashes,
        outputHashes: next.outputHashes,
        count: next.count,
        toolVersion: next.toolVersion,
        completedAt: next.completedAt,
        ...(stage === 'reviewed' ? { pendingCount: 0 } : {}),
        ...(stage === 'budget-approved' ? {
          forecastRef:
            `content/batches/F005/capacity-forecast/${workId}.json` as StageEvidence['forecastRef'],
        } : {}),
        ...(stage === 'voiced' ? {
          voiceEvidenceRef: voiceEvidencePath as StageEvidence['voiceEvidenceRef'],
        } : {}),
      });
      await writeBatchManifestAtomic(
        workspace,
        MANIFEST_PATH as WorkspaceRelativePath,
        target,
        hashBatchManifest(persisted),
      );
      persisted = target;
    }
    manifest = persisted;
    const voicedManifestSha = hashBatchManifest(manifest);

    await runOfflineBuild(
      workspace,
      (executable, args, cwd) => session.runInheritedWorker(executable, args, cwd),
    );
    const distRoot = join(workspace, 'dist');
    const [publicMeasurement, distMeasurement] = await Promise.all([
      measureTree(publicRoot),
      measureTree(distRoot),
    ]);
    if (publicMeasurement.treeSha256 !== publicBefore) {
      throw new Error('offline buildがpublic treeを変更しました');
    }
    const previewRoot = join(workspace, '.cache', 'f005-preview', `${workId}-${session.journalId}`);
    const artifactDirectory = join(runRoot, 'preview-artifacts');
    await mkdir(artifactDirectory, { recursive: true });
    await formalNotice('create', artifactDirectory, null, 0, null);
    const previewKinds: readonly F005PreviewArtifactKind[] = [
      'content-build',
      'content-staging',
      'dist',
      'f001-content-invariant-report',
      'f001-dist-invariant-report',
    ];
    const previewRefs = new Map<F005PreviewArtifactKind, F005ArtifactRef<F005PreviewArtifactKind>>();
    const buildPayloads = createF005OfflineBuildArtifactPayloads({
      manifestSha256: voicedManifestSha,
      baselineDescriptorSha256: baseline.descriptorSha256 as Sha256,
      expectedPublicTreeSha256: publicBefore,
      publicMeasurement,
      distMeasurement,
    });
    for (const kind of previewKinds) {
      const path = join(artifactDirectory, `${kind}.json`);
      const logical = relative(workspace, path).replaceAll('\\', '/');
      const digest = await writeCanonical(path, {
        schemaVersion: '1.0.0',
        kind,
        workId,
        payload: buildPayloads[kind],
      });
      previewRefs.set(kind, { kind, path: logical, sha256: digest });
    }
    await session.endPhase('build', formalPhase);
    const artifacts: F005PreviewArtifacts = {
      workspaceRoot: workspace,
      previewRoot,
      contentBuild: previewRefs.get('content-build') as F005ArtifactRef<'content-build'>,
      contentStaging: previewRefs.get('content-staging') as F005ArtifactRef<'content-staging'>,
      dist: previewRefs.get('dist') as F005ArtifactRef<'dist'>,
      f001ContentInvariantReport:
        previewRefs.get('f001-content-invariant-report') as F005ArtifactRef<'f001-content-invariant-report'>,
      f001DistInvariantReport:
        previewRefs.get('f001-dist-invariant-report') as F005ArtifactRef<'f001-dist-invariant-report'>,
    };
    const staged: F005StagedWork = {
      mode: 'staged',
      workId,
      files: voice.assets.map((asset) => ({
        sourcePath: asset.path,
        targetPath: `content/batches/F005/accepted-audio/${workId}/${asset.audioId}.wav`,
        sha256: asset.sha256 as Sha256,
        bytes: asset.bytes,
        configHash: plan.configHash as Sha256,
      })),
    };
    const acceptedWorks: F005AcceptedWork[] = selected.acceptedWorkIds.map((acceptedWorkId) => {
      const progress = manifest.workProgress[manifest.workIds.indexOf(acceptedWorkId)];
      if (!progress?.acceptedAudioSources?.length) {
        throw new Error(`先行accepted workのaudio sourceがありません: ${acceptedWorkId}`);
      }
      return {
        mode: 'accepted',
        workId: acceptedWorkId,
        files: progress.acceptedAudioSources.map((source) => ({
          sourcePath: join(workspace, ...source.path.split('/')),
          targetPath: source.path,
          sha256: source.sha256,
          bytes: source.bytes,
          configHash: source.configHash,
        })),
      };
    });
    const preview = await prepareF005WorkPreview(
      context,
      baseline,
      acceptedWorks,
      staged,
      artifacts,
      acceptanceRecorder,
    );

    const evidencePhase = sha(`${session.journalId}\0${workId}\0evidence-build`);
    buildSequence = 0;
    await session.beginPhase('build', workId, evidencePhase);
    const evidenceRefs: F005EvidenceRef[] = [];
    const evidenceKinds: readonly F005EvidenceKind[] =
      ['source', 'review', 'audio', 'license', 'notice', 'artwork'];
    for (const kind of evidenceKinds) {
      const logical =
        `content/batches/F005/work-artifacts/${workId}/runs/${session.journalId}/acceptance-${kind}.json`;
      const path = join(workspace, ...logical.split('/'));
      const value = {
        schemaVersion: '1.0.0',
        kind,
        workId,
        previewSha256: preview.previewSha256,
        payload: {
          sourceSha256: sourceSha,
          reviewSha256: reviewSha,
          voiceEvidenceSha256: voice.evidenceSha256,
          forecastSha256: forecastSha,
          baselineDescriptorSha256: baseline.descriptorSha256,
        },
      };
      const evidenceSha = await writeCanonicalArtifact(workspace, path, value);
      evidenceRefs.push({ kind, path: logical, sha256: evidenceSha });
    }
    await session.endPhase('build', evidencePhase);
    const prepared = await prepareF005WorkAcceptance(
      workspace,
      context,
      workId,
      evidenceRefs,
      preview,
      acceptanceRecorder,
    );
    const promoted = await stageF005WorkAcceptance(
      workspace,
      prepared,
      voicedManifestSha,
      acceptanceRecorder,
      forecastArtifact.value.forecast.candidateSha256 as Sha256,
    );
    const closed = await session.close();
    const actualAudioEntries = voice.assets.map((asset) => ({
      kind: 'path' as const,
      bucket: 'audio' as const,
      path: `content/batches/F005/accepted-audio/${workId}/${asset.audioId}.wav`,
      bytes: asset.bytes,
      sha256: asset.sha256,
    }));
    const inventory: Array<CapacityEntry & {
      bucket: 'artifact' | 'repository' | 'object';
    }> = [];
    for (const bucket of forecastArtifact.value.forecast.buckets) {
      if (bucket.kind === 'artifact' || bucket.kind === 'repository' || bucket.kind === 'object') {
        const kind = bucket.kind;
        inventory.push(...bucket.entries.map((entry) => ({ ...entry, bucket: kind })));
      }
    }
    const reader = createF005NativeCapacityJournalReader({
      journalId: closed.journalId,
      journalPath: closed.journalPath,
      journalSha256: closed.journalSha256,
      workId,
      candidateSha256: forecastArtifact.value.forecast.candidateSha256,
      workspaceRoot: workspace,
      distRoot,
      entries: [
        ...actualAudioEntries,
        ...inventory,
        ...actualAudioEntries.map((entry) => ({ ...entry, bucket: 'workspace-peak' as const })),
      ],
    });
    const actual = await measureF005ActualCapacity(
      workspace,
      distRoot,
      actualAudioEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
      reader,
      workId,
    );
    if (actual.journalId !== session.journalId || actual.journalSha256 !== closed.journalSha256) {
      throw new Error('actual capacityとclosed native journalが一致しません');
    }
    const actualLogical = `content/batches/F005/capacity-actual/${workId}/${session.journalId}.json`;
    const actualPath = join(workspace, ...actualLogical.split('/'));
    const actualValue = {
      schemaVersion: '1.0.0',
      kind: 'actual-capacity-report',
      workId,
      journalId: session.journalId,
      payload: actual,
    };
    const actualArtifactSha = await writeCanonicalArtifact(workspace, actualPath, actualValue);
    const accepted = await finalizeF005WorkAcceptance(
      workspace,
      promoted,
      {
        kind: 'actual-capacity-report',
        path: actualLogical,
        sha256: actualArtifactSha,
        candidateSha256: actual.candidateSha256 as Sha256,
        journalId: actual.journalId as Sha256,
        journalSha256: actual.journalSha256 as Sha256,
      },
      voicedManifestSha,
    );
    const publicAfter = await treeDigest(publicRoot);
    if (publicAfter !== publicBefore) throw new Error('runnerがpublic treeを変更しました');
    process.stdout.write(canonicalJson({
      ok: true,
      workId,
      status: accepted.workProgress[accepted.workIds.indexOf(workId)]?.status,
      journalId: actual.journalId,
      actualCapacityReport: actualLogical,
      publicTreeSha256: publicAfter,
    }));
  } catch (error) {
    await session.abort();
    if (await treeDigest(publicRoot) !== publicBefore) {
      throw new Error('失敗経路でpublic treeが変化しました', { cause: error });
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
