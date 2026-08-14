import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ minted: new WeakSet<object>() }));
const nativeMock = vi.hoisted(() => ({
  journals: new Map<string, {
    state: 'closed';
    owner: string;
    workId: string;
    candidateSha256: string;
    sessionNonce: string;
    minimumObservedFreeBytes: number;
    peakLiveBytes: number;
  }>(),
  directorySyncCalls: [] as string[],
  durabilityEvents: [] as string[],
  failDirectorySync: false,
  failDirectorySyncDirectory: null as string | null,
  beforeNativeDelete: null as null | ((relativePath: string) => void | Promise<void>),
  beforeNativeRename: null as null | ((relativePath: string) => void | Promise<void>),
  beforeNativeResolve: null as null | ((
    relativePath: string,
    operation: 'read' | 'rename-source' | 'delete-source',
  ) => void | Promise<void>),
}));
vi.mock('./f005-context.ts', () => ({
  isMintedF005ApprovedBatchContext(value: unknown) {
    return value !== null && typeof value === 'object' && contextMock.minted.has(value);
  },
}));
vi.mock('./f005-native-guard.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./f005-native-guard.ts')>();
  return {
    ...actual,
    flushF005ArtifactDirectory: async (_root: string, directory: string) => {
      nativeMock.directorySyncCalls.push(directory);
      nativeMock.durabilityEvents.push(`flush:${directory}`);
      if (nativeMock.failDirectorySync ||
        nativeMock.failDirectorySyncDirectory === directory) {
        throw new Error('mocked native directory sync failure');
      }
    },
    readF005NativeCapacityJournalFile: async (_root: string, path: string) => {
      const value = nativeMock.journals.get(path);
      if (!value) throw new Error('missing mocked native journal');
      return value;
    },
  };
});
vi.mock('./f005-source.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./f005-source.ts')>();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const states = new WeakMap<object, {
    root: string;
    relativePath: string;
    sha256: string;
    dev: number;
    ino: number;
    bytes: number;
    nativeIdentity: `${string}:${string}`;
    active: boolean;
  }>();
  return {
    ...actual,
    resolveSafeWorkspaceFile: async (
      root: string,
      relativePath: string,
      operation: 'read' | 'rename-source' | 'delete-source',
      expectedNativeIdentity?: `${string}:${string}`,
    ) => {
      await nativeMock.beforeNativeResolve?.(relativePath, operation);
      const target = path.join(root, ...relativePath.split('/'));
      const bytes = await fs.readFile(target);
      const info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe');
      const nativeIdentity =
        `${info.dev.toString(16).padStart(8, '0').slice(-8)}` +
        `:${info.ino.toString(16).padStart(16, '0').slice(-16)}` as `${string}:${string}`;
      if (expectedNativeIdentity !== undefined &&
        expectedNativeIdentity !== nativeIdentity) {
        throw new Error('expected native identity changed');
      }
      const value = {
        __brand: 'SafeFileCapability' as const,
        relativePosixPath: relativePath,
        operation,
        exists: true,
        contentSha256: H(bytes),
        nativeIdentity,
        identity: { dev: 'test', ino: H(bytes), size: bytes.byteLength, mtimeMs: 0 },
        parentIdentity: { dev: 'test', ino: 'parent', size: 0, mtimeMs: 0 },
      };
      states.set(value, {
        root,
        relativePath,
        sha256: H(bytes),
        dev: info.dev,
        ino: info.ino,
        bytes: bytes.byteLength,
        nativeIdentity,
        active: true,
      });
      return value;
    },
    assertSafeWorkspaceFileCapability: async (capability: object) => {
      if (!states.get(capability)?.active) throw new Error('inactive capability');
    },
    snapshotSafeWorkspaceFileCapability: (capability: object) => {
      const state = states.get(capability);
      if (!state?.active) throw new Error('inactive capability');
      return {
        relativePosixPath: state.relativePath,
        byteLength: state.bytes,
        contentSha256: state.sha256,
        nativeIdentity: state.nativeIdentity,
      };
    },
    renameSafeWorkspaceFile: async (
      capability: object,
      relativeTarget: string,
      expectedNativeIdentity: `${string}:${string}`,
    ) => {
      const state = states.get(capability);
      if (!state?.active || state.nativeIdentity !== expectedNativeIdentity) {
        throw new Error('inactive capability');
      }
      await nativeMock.beforeNativeRename?.(state.relativePath);
      const source = path.join(state.root, ...state.relativePath.split('/'));
      const target = path.join(state.root, ...relativeTarget.split('/'));
      const sourceBytes = await fs.readFile(source);
      const sourceInfo = await fs.lstat(source);
      if (H(sourceBytes) !== state.sha256 ||
        sourceInfo.dev !== state.dev || sourceInfo.ino !== state.ino) {
        throw new Error('rename identity changed');
      }
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.rename(source, target);
      nativeMock.durabilityEvents.push(
        `rename:${state.relativePath}->${relativeTarget}`,
      );
      state.active = false;
    },
    deleteSafeWorkspaceFile: async (
      capability: object,
      expectedNativeIdentity: `${string}:${string}`,
    ) => {
      const state = states.get(capability);
      if (!state?.active || state.nativeIdentity !== expectedNativeIdentity) {
        throw new Error('inactive capability');
      }
      await nativeMock.beforeNativeDelete?.(state.relativePath);
      const target = path.join(state.root, ...state.relativePath.split('/'));
      const bytes = await fs.readFile(target);
      const info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        H(bytes) !== state.sha256 || info.dev !== state.dev || info.ino !== state.ino) {
        throw new Error('delete identity changed');
      }
      await fs.unlink(target);
      nativeMock.durabilityEvents.push(`delete:${state.relativePath}`);
      state.active = false;
    },
    closeSafeWorkspaceFile: async (capability: object) => {
      const state = states.get(capability);
      if (state) state.active = false;
    },
  };
});

import { canonicalJson } from './artifacts.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkId,
  type WorkStatus,
  type WorkspaceRelativePath,
} from './batch.ts';
import {
  createF005AcceptanceCapacityRecorder,
  F005AcceptanceError,
  finalizeF005WorkAcceptance,
  prepareF005WorkAcceptance,
  prepareF005WorkPreview,
  recoverF005WorkAcceptance,
  stageF005WorkAcceptance,
  type F005AcceptanceCapacityBackend,
  type F005AcceptanceCapacityRecorder,
  type F005AcceptedWork,
  type F005EvidenceKind,
  type F005EvidenceRef,
  type F005PreviewArtifacts,
  type F005StagedWork,
} from './f005-acceptance.ts';
import type { F005ApprovedBatchContext } from './f005-context.ts';
import type { V040Baseline } from './f005-foundation.ts';

const H = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex') as Sha256;
const WORK_IDS = ['000799', '001076', '001104'] as const;
const temporaryDirectories: string[] = [];

function durableTempPath(target: string, text: string, filenameSha = H(text)): string {
  return join(dirname(target), `.${basename(target)}.${filenameSha}.tmp`);
}

async function liveProcessStartIdentity(pid: number): Promise<Sha256> {
  if (process.platform !== 'win32') {
    return H(`${pid}\0live-unverified\0process-start-v1`);
  }
  const reader = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$value=Get-Process -Id ${pid} -ErrorAction Stop;` +
        '[Console]::Out.Write($value.StartTime.ToUniversalTime().Ticks)',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  reader.stdout!.setEncoding('utf8');
  reader.stdout!.on('data', (chunk: string) => { output += chunk; });
  const [exitCode] = await once(reader, 'exit');
  expect(exitCode).toBe(0);
  return H(`${pid}\0${output.trim()}\0process-start-v1`);
}

function context(): F005ApprovedBatchContext {
  const value = Object.freeze({
    __brand: 'ApprovedBatchContext',
    candidate: { batchId: 'F005' },
    definition: { workIds: WORK_IDS },
    policy: { requirementApprovalSnapshot: H('approval') },
  }) as unknown as F005ApprovedBatchContext;
  contextMock.minted.add(value);
  return value;
}

const BASELINE = Object.freeze({
  __brand: 'V040Baseline',
  descriptorSha256: H('baseline'),
}) as unknown as V040Baseline;

function work(workId: string, status: WorkStatus) {
  return {
    workId: workId as WorkId,
    status,
    stageRecords: status === 'voiced'
      ? [{
          stage: 'voiced',
          inputHashes: [H('voice-input')],
          outputHashes: [H('voice-output')],
          toolVersion: 'fixture/1.0.0',
          count: 1,
          completedAt: '2026-07-29T00:00:00.000Z',
        }]
      : [],
    ...(status === 'accepted' ? {
      acceptedAudioSources: [{
        path: `content/batches/F005/accepted-audio/${workId}/old.wav` as WorkspaceRelativePath,
        sha256: H(`accepted-${workId}`),
        bytes: 92,
        configHash: H('config'),
      }],
      acceptedAt: '2026-07-29T00:00:00.000Z',
      acceptedBy: 'fixture',
    } : {}),
  };
}

function manifest(statuses: readonly [WorkStatus, WorkStatus, WorkStatus]): BatchManifest {
  const raw = {
    schemaVersion: '1.0.0',
    batchId: 'F005',
    feature: 'F005',
    status: statuses.every((status) => status === 'accepted') ? 'accepted' : 'draft',
    author: {
      authorId: '000148',
      name: 'なつめそうせき',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
      identitySha256: H('author'),
    },
    workIds: WORK_IDS,
    workProgress: [
      work(WORK_IDS[0], statuses[0]),
      work(WORK_IDS[1], statuses[1]),
      work(WORK_IDS[2], statuses[2]),
    ],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: ['rights'],
    voiceConfigRef: 'content/batches/F005/voice-config.json',
    artworkProvenanceRef: 'content/batches/F005/artwork.json',
  } as unknown;
  const checked = validateBatchManifest(raw);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

function backend(
  nonce: Sha256,
  calls: string[],
  failNotice = false,
): F005AcceptanceCapacityBackend {
  return {
    beginPhase: async (phase) => { calls.push(`begin:${phase}`); },
    observeMutation: async (notice) => {
      calls.push(`${notice.phase}:${notice.kind}`);
      if (failNotice) throw new Error('ETW missing');
      return {
        noticeId: notice.noticeId,
        sessionNonce: nonce,
        sequence: notice.sequence,
        workerPid: process.pid,
        matchedEtw: true,
      };
    },
    endPhase: async (phase) => { calls.push(`end:${phase}`); },
  };
}

function recorder(label: string, calls: string[], failNotice = false): F005AcceptanceCapacityRecorder {
  const nonce = H(`${label}-nonce`);
  const owner = 'acceptance-worker';
  const candidateSha256 = H('candidate');
  return createF005AcceptanceCapacityRecorder({
    journalId: H(
      `${nonce}\0${owner}\0${'000799'}\0${candidateSha256}\0f005-capacity-v3`,
    ),
    owner,
    sessionNonce: nonce,
    workerPid: process.pid,
  }, backend(nonce, calls, failNotice));
}

async function file(root: string, relativePath: string, value: Uint8Array | string): Promise<string> {
  const path = join(root, ...relativePath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, value);
  return path;
}

interface Fixture {
  readonly root: string;
  readonly context: F005ApprovedBatchContext;
  readonly staged: F005StagedWork;
  readonly artifacts: F005PreviewArtifacts;
}

async function fixture(statuses: readonly [WorkStatus, WorkStatus, WorkStatus] = ['voiced', 'pending', 'pending']): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'f005-acceptance-'));
  temporaryDirectories.push(root);
  await file(root, 'content/batches/F005/batch.json', canonicalJson(manifest(statuses)));
  const audio = new Uint8Array(92);
  audio.set(Buffer.from('RIFF'), 0);
  const sourcePath = await file(root, '.cache/voice-stage/audio.wav', audio);
  const previewArtifact = async <Kind extends string>(kind: Kind) => {
    const path = `.cache/f005-preview-inputs/000799/${kind}.json`;
    const text = canonicalJson({
      schemaVersion: '1.0.0',
      kind,
      workId: '000799',
      payload: { result: 'pass', artifactSha256: H(kind) },
    });
    await file(root, path, text);
    return { kind, path, sha256: H(text) };
  };
  await mkdir(join(root, '.cache', 'f005-preview'), { recursive: true });
  await mkdir(join(root, '.cache', 'transactions', 'f005-accept'), { recursive: true });
  await mkdir(join(root, 'content', 'batches', 'F005', 'accepted-audio', '000799'), { recursive: true });
  return {
    root,
    context: context(),
    staged: {
      mode: 'staged',
      workId: '000799' as WorkId,
      files: [{
        sourcePath,
        targetPath: 'content/batches/F005/accepted-audio/000799/audio.wav',
        sha256: H(audio),
        bytes: audio.byteLength,
        configHash: H('config'),
      }],
    },
    artifacts: {
      workspaceRoot: root,
      previewRoot: join(root, '.cache', 'f005-preview', '000799'),
      contentBuild: await previewArtifact('content-build'),
      contentStaging: await previewArtifact('content-staging'),
      dist: await previewArtifact('dist'),
      f001ContentInvariantReport: await previewArtifact('f001-content-invariant-report'),
      f001DistInvariantReport: await previewArtifact('f001-dist-invariant-report'),
    },
  };
}

async function acceptanceEvidence(
  root: string,
  workId: WorkId,
  previewSha256: Sha256,
): Promise<readonly F005EvidenceRef[]> {
  const kinds: readonly F005EvidenceKind[] =
    ['source', 'review', 'audio', 'license', 'notice', 'artwork'];
  return Promise.all(kinds.map(async (kind) => {
    const path = `content/batches/F005/work-artifacts/${workId}/acceptance-${kind}.json`;
    const text = canonicalJson({
      schemaVersion: '1.0.0',
      kind,
      workId,
      previewSha256,
      payload: { result: 'pass', evidenceSha256: H(kind) },
    });
    await file(root, path, text);
    return { kind, path, sha256: H(text) };
  }));
}

async function tree(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (directory: string, logical: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = join(directory, entry.name);
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child, path);
      else result.push(`${path}:${H(new Uint8Array(await readFile(child)))}`);
    }
  };
  await visit(root, '');
  return result;
}

afterEach(async () => {
  nativeMock.directorySyncCalls.splice(0);
  nativeMock.durabilityEvents.splice(0);
    nativeMock.failDirectorySync = false;
    nativeMock.failDirectorySyncDirectory = null;
    nativeMock.beforeNativeDelete = null;
    nativeMock.beforeNativeRename = null;
    nativeMock.beforeNativeResolve = null;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('UT-F005-020 non-destructive preview [DES-F005-006][DES-F005-007][FUN-F005-020]', () => {
  it('accepted 0＋staged 1だけをpreviewへcopyし、source/publicを変更しない', async () => {
    const value = await fixture();
    const before = await tree(value.root);
    const calls: string[] = [];
    const preview = await prepareF005WorkPreview(
      value.context,
      BASELINE,
      [],
      value.staged,
      value.artifacts,
      recorder('preview', calls),
    );
    expect(preview).toMatchObject({
      mode: 'work-preview',
      workId: '000799',
      acceptedWorkIds: [],
      files: [{ ownerWorkId: '000799' }],
    });
    expect(calls).toEqual(['begin:preview', 'preview:create', 'preview:create', 'end:preview']);
    const after = await tree(value.root);
    expect(after.filter((entry) => !entry.startsWith('.cache/f005-preview/')))
      .toEqual(before.filter((entry) => !entry.startsWith('.cache/f005-preview/')));
  });

  it('順序差、Final brand混入、noticeのみでETW欠落を拒否する', async () => {
    const value = await fixture();
    const accepted = [{ mode: 'accepted', workId: '001076', files: value.staged.files }] as unknown as F005AcceptedWork[];
    await expect(prepareF005WorkPreview(
      value.context, BASELINE, accepted, value.staged, value.artifacts, recorder('order', []),
    )).rejects.toMatchObject({ code: 'F005_PREVIEW_INVALID' });
    await expect(prepareF005WorkPreview(
      value.context,
      BASELINE,
      [],
      { ...value.staged, mode: 'final' } as unknown as F005StagedWork,
      { ...value.artifacts, previewRoot: join(value.root, '.cache', 'f005-preview', 'final') },
      recorder('final', []),
    )).rejects.toMatchObject({ code: 'F005_PREVIEW_INVALID' });
    await expect(prepareF005WorkPreview(
      value.context,
      BASELINE,
      [],
      value.staged,
      { ...value.artifacts, previewRoot: join(value.root, '.cache', 'f005-preview', 'lost') },
      recorder('lost', [], true),
    )).rejects.toMatchObject({ code: 'F005_PREVIEW_INVALID' });
  });

  it('6種preview artifactを実path・canonical schema・kind・実SHAへ結合する', async () => {
    const badSha = await fixture();
    await expect(prepareF005WorkPreview(
      badSha.context,
      BASELINE,
      [],
      badSha.staged,
      {
        ...badSha.artifacts,
        contentBuild: { ...badSha.artifacts.contentBuild, sha256: H('caller-claim') },
      },
      recorder('artifact-sha', []),
    )).rejects.toMatchObject({ code: 'F005_PREVIEW_INVALID' });

    const badKind = await fixture();
    await expect(prepareF005WorkPreview(
      badKind.context,
      BASELINE,
      [],
      badKind.staged,
      {
        ...badKind.artifacts,
        contentBuild: {
          ...badKind.artifacts.contentBuild,
          kind: 'dist',
        },
      } as unknown as F005PreviewArtifacts,
      recorder('artifact-kind', []),
    )).rejects.toMatchObject({ code: 'F005_PREVIEW_INVALID' });

    const changed = await fixture();
    await writeFile(
      join(changed.root, ...changed.artifacts.contentBuild.path.split('/')),
      canonicalJson({
        schemaVersion: '1.0.0',
        kind: 'content-build',
        workId: '000799',
        payload: { result: 'changed' },
      }),
    );
    await expect(prepareF005WorkPreview(
      changed.context,
      BASELINE,
      [],
      changed.staged,
      changed.artifacts,
      recorder('artifact-changed', []),
    )).rejects.toMatchObject({ code: 'F005_PREVIEW_INVALID' });
  });
});

describe('UT-F005-021 read-only prepare [DES-F005-006][FUN-F005-021]', () => {
  it('canonical evidenceとmanifest順を再読込しmutation 0でpreparedをmintする', async () => {
    const value = await fixture();
    const calls: string[] = [];
    const capacity = recorder('prepare', calls);
    const preview = await prepareF005WorkPreview(
      value.context, BASELINE, [], value.staged, value.artifacts, capacity,
    );
    const evidenceRefs = await acceptanceEvidence(value.root, value.staged.workId, preview.previewSha256);
    calls.splice(0);
    const before = await tree(value.root);
    const prepared = await prepareF005WorkAcceptance(
      value.root, value.context, '000799', evidenceRefs, preview, capacity,
    );
    expect(prepared).toMatchObject({
      __brand: 'PreparedF005WorkAcceptance',
      workId: '000799',
      recorderJournalId: capacity.journalId,
    });
    expect(calls).toEqual([]);
    expect(await tree(value.root)).toEqual(before);
  });

  it('evidence hash差・preview clone・recorder差を拒否する', async () => {
    const value = await fixture();
    const capacity = recorder('prepare-negative', []);
    const preview = await prepareF005WorkPreview(
      value.context, BASELINE, [], value.staged, value.artifacts, capacity,
    );
    const evidenceRefs = await acceptanceEvidence(value.root, value.staged.workId, preview.previewSha256);
    await expect(prepareF005WorkAcceptance(
      value.root,
      value.context,
      '000799',
      evidenceRefs.map((ref, index) => index === 0 ? { ...ref, sha256: H('bad') } : ref),
      preview,
      capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });
    await expect(prepareF005WorkAcceptance(
      value.root, value.context, '000799', evidenceRefs, { ...preview }, capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });
    await expect(prepareF005WorkAcceptance(
      value.root, value.context, '000799', evidenceRefs, preview, recorder('other', []),
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });
  });

  it('source/review/audio/license/notice/artworkのexact集合・schema・preview SHAを必須にする', async () => {
    const value = await fixture();
    const capacity = recorder('evidence-contract', []);
    const preview = await prepareF005WorkPreview(
      value.context, BASELINE, [], value.staged, value.artifacts, capacity,
    );
    const evidenceRefs = await acceptanceEvidence(value.root, value.staged.workId, preview.previewSha256);
    await expect(prepareF005WorkAcceptance(
      value.root, value.context, '000799', evidenceRefs.slice(0, -1), preview, capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });
    await expect(prepareF005WorkAcceptance(
      value.root,
      value.context,
      '000799',
      [...evidenceRefs.slice(0, -1), { ...evidenceRefs[4]!, path: evidenceRefs[5]!.path }],
      preview,
      capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });

    const stale = await fixture();
    const staleCapacity = recorder('evidence-preview-sha', []);
    const stalePreview = await prepareF005WorkPreview(
      stale.context, BASELINE, [], stale.staged, stale.artifacts, staleCapacity,
    );
    const staleRefs = await acceptanceEvidence(stale.root, stale.staged.workId, H('other-preview'));
    await expect(prepareF005WorkAcceptance(
      stale.root, stale.context, '000799', staleRefs, stalePreview, staleCapacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });
  });
});

async function writeActualCapacity(
  root: string,
  workId: WorkId,
  capacity: F005AcceptanceCapacityRecorder,
  candidateSha256: Sha256,
) {
  const nativeJournalText = canonicalJson({ test: 'closed-native-journal' });
  const journalSha256 = H(nativeJournalText);
  await file(root, `.cache/f005-capacity/${capacity.journalId}.json`, nativeJournalText);
  const acceptedAudioPath = `content/batches/F005/accepted-audio/${workId}/audio.wav`;
  const acceptedAudio = new Uint8Array(await readFile(
    join(root, ...acceptedAudioPath.split('/')),
  ));
  const path =
    `content/batches/F005/capacity-actual/${workId}/${capacity.journalId}.json`;
  const text = canonicalJson({
    schemaVersion: '1.0.0',
    kind: 'actual-capacity-report',
    workId,
    journalId: capacity.journalId,
    payload: {
      schemaVersion: 3,
      workId,
      candidateSha256,
      journalId: capacity.journalId,
      journalSha256,
      minimumObservedFreeBytes: 1,
      peakLiveBytes: 1,
      buckets: [
        {
          kind: 'audio',
          entries: [{
            kind: 'path',
            path: acceptedAudioPath,
            bytes: acceptedAudio.byteLength,
            sha256: H(acceptedAudio),
          }],
          totalBytes: acceptedAudio.byteLength,
        },
        { kind: 'artifact', entries: [], totalBytes: 0 },
        { kind: 'repository', entries: [], totalBytes: 0 },
        { kind: 'object', entries: [], totalBytes: 0 },
        { kind: 'workspace-peak', entries: [], totalBytes: 1 },
        { kind: 'free-after-peak', entries: [], totalBytes: 1 },
      ],
      state: 'closed',
    },
  });
  await file(root, path, text);
  nativeMock.journals.set(`.cache/f005-capacity/${capacity.journalId}.json`, {
    state: 'closed',
    owner: capacity.owner,
    workId,
    candidateSha256,
    sessionNonce: capacity.sessionNonce,
    minimumObservedFreeBytes: 1,
    peakLiveBytes: 1,
  });
  return {
    kind: 'actual-capacity-report' as const,
    path,
    sha256: H(text),
    candidateSha256,
    journalId: capacity.journalId,
    journalSha256,
  };
}

async function acceptF005Work(
  root: string,
  prepared: Awaited<ReturnType<typeof prepareF005WorkAcceptance>>,
  expectedManifestSha: Sha256,
  capacity: F005AcceptanceCapacityRecorder,
  options: {
    readonly now?: () => string;
    readonly afterPhase?: (
      phase:
        | 'prepared'
        | 'artifacts-committed'
        | 'actual-saved'
        | 'capacity-measured'
        | 'manifest-renamed'
        | 'manifest-committed'
        | 'closed'
    ) => void;
  } = {},
): Promise<BatchManifest> {
  const candidateSha256 = H('candidate');
  const promoted = await stageF005WorkAcceptance(
    root, prepared, expectedManifestSha, capacity, candidateSha256,
  );
  try {
    options.afterPhase?.('artifacts-committed');
  } catch (error) {
    throw new F005AcceptanceError('F005_ACCEPTANCE_TRANSACTION_INVALID', 'simulated stage crash', {
      cause: error,
    });
  }
  const actualRef = await writeActualCapacity(
    root,
    prepared.workId,
    capacity,
    candidateSha256,
  );
  options.afterPhase?.('actual-saved');
  return finalizeF005WorkAcceptance(root, promoted, actualRef, expectedManifestSha, {
    now: options.now,
    afterPhase: (phase) => options.afterPhase?.(phase),
  });
}

describe('二段acceptance fault matrix [CHG-F005-002]', () => {
  async function preparedFixture(label: string) {
    const value = await fixture();
    const calls: string[] = [];
    const capacity = recorder(label, calls);
    const preview = await prepareF005WorkPreview(
      value.context, BASELINE, [], value.staged, value.artifacts, capacity,
    );
    const evidenceRefs = await acceptanceEvidence(value.root, value.staged.workId, preview.previewSha256);
    const prepared = await prepareF005WorkAcceptance(
      value.root, value.context, '000799', evidenceRefs, preview, capacity,
    );
    return { ...value, calls, capacity, prepared };
  }

  async function stopAfterPreparedTarget(
    value: Awaited<ReturnType<typeof preparedFixture>>,
  ): Promise<{ directory: string; target: string; text: string }> {
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        afterPhase: (phase) => {
          if (phase === 'prepared') throw new Error('stop-after-prepared');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    const directory = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
    );
    const target = join(directory, 'prepared.json');
    return { directory, target, text: await readFile(target, 'utf8') };
  }

  it('artifact→manifest CAS→post-read→closedの順でacceptedへ遷移する', async () => {
    const value = await preparedFixture('accept');
    value.calls.splice(0);
    const accepted = await acceptF005Work(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      { now: () => '2026-07-29T01:00:00.000Z' },
    );
    expect(accepted.workProgress[0]).toMatchObject({ workId: '000799', status: 'accepted' });
    expect(value.calls.at(0)).toBe('begin:accept');
    expect(value.calls.at(-1)).toBe('end:accept');
    await expect(readFile(join(
      value.root,
      'content',
      'batches',
      'F005',
      'accepted-audio',
      '000799',
      'audio.wav',
    ))).resolves.toHaveLength(92);
  });

  it('FLT-07A 一部audio rename直後の停止を旧stageへrollbackする', async () => {
    const value = await preparedFixture('fault-prepared');
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        afterArtifactRename: (index) => {
          if (index === 0) throw new Error('fault:partial-rename');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    await expect(readFile(join(
      value.root,
      ...value.prepared.operations[0]!.targetPath.split('/'),
    ))).resolves.toHaveLength(92);
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'rolled-back',
      recoveredWorkIds: ['000799'],
    });
    await expect(readFile(value.prepared.operations[0]!.sourcePath)).resolves.toHaveLength(92);
  });

  it('stage rename直前に第三者targetが出現しても置換しない', async () => {
    const value = await preparedFixture('stage-target-race');
    const targetPath = join(
      value.root,
      ...value.prepared.operations[0]!.targetPath.split('/'),
    );
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        beforeArtifactRename: async () => {
          await writeFile(targetPath, 'third-party-stage-target', { flag: 'wx' });
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('third-party-stage-target');
    await expect(readFile(value.prepared.operations[0]!.sourcePath)).resolves.toHaveLength(92);
  });

  it('rollback先staged pathに第三者fileが出現しても置換しない', async () => {
    const value = await preparedFixture('rollback-staged-race');
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        afterArtifactRename: () => {
          throw new Error('fault:after-artifact-rename');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    await writeFile(
      value.prepared.operations[0]!.sourcePath,
      'third-party-staged-target',
      { flag: 'wx' },
    );
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(value.prepared.operations[0]!.sourcePath, 'utf8'))
      .resolves.toBe('third-party-staged-target');
    await expect(readFile(join(
      value.root,
      ...value.prepared.operations[0]!.targetPath.split('/'),
    ))).resolves.toHaveLength(92);
  });

  it('transaction directory作成直後・prepared前停止の空directoryだけを安全回収する', async () => {
    const value = await preparedFixture('bootstrap-empty');
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        afterTransactionDirectory: () => {
          throw new Error('fault:bootstrap-empty');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'rolled-back',
      recoveredWorkIds: ['000799'],
    });
    await expect(readFile(value.prepared.operations[0]!.sourcePath)).resolves.toHaveLength(92);
  });

  it('prepared target不在でもwhole-SHA canonical tempをbootstrap昇格してrollbackする', async () => {
    const value = await preparedFixture('prepared-temp-bootstrap');
    const stopped = await stopAfterPreparedTarget(value);
    await rm(stopped.target);
    const temporary = durableTempPath(stopped.target, stopped.text);
    await writeFile(temporary, stopped.text, { flag: 'wx' });
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'rolled-back',
      recoveredWorkIds: ['000799'],
    });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(value.prepared.operations[0]!.sourcePath)).resolves.toHaveLength(92);
  });

  it('prepared targetと同一bytesのcanonical tempをnative discardして回復する', async () => {
    const value = await preparedFixture('prepared-temp-identical');
    const stopped = await stopAfterPreparedTarget(value);
    const temporary = durableTempPath(stopped.target, stopped.text);
    await writeFile(temporary, stopped.text, { flag: 'wx' });
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'rolled-back',
      recoveredWorkIds: ['000799'],
    });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('temp→recovery-trash rename後・delete reopen前の同SHA replacementを保持する', async () => {
    const value = await preparedFixture('prepared-temp-discard-replacement');
    const stopped = await stopAfterPreparedTarget(value);
    const temporary = durableTempPath(stopped.target, stopped.text);
    await writeFile(temporary, stopped.text, { flag: 'wx' });
    let replacementPath: string | undefined;
    let heldOldPath: string | undefined;
    nativeMock.beforeNativeResolve = async (relativePath, operation) => {
      if (operation !== 'delete-source' ||
        !relativePath.startsWith('.cache/recovery-trash/f005/discard-')) {
        return;
      }
      nativeMock.beforeNativeResolve = null;
      replacementPath = join(value.root, ...relativePath.split('/'));
      heldOldPath = `${replacementPath}.held-old`;
      const bytes = await readFile(replacementPath);
      await rename(replacementPath, heldOldPath);
      await writeFile(replacementPath, bytes, { flag: 'wx' });
    };
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    expect(replacementPath).toBeDefined();
    await expect(readFile(replacementPath!, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(heldOldPath!, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(stopped.target, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prepared canonical temp複数を削除せずconflictにする', async () => {
    const value = await preparedFixture('prepared-temp-multiple');
    const stopped = await stopAfterPreparedTarget(value);
    await rm(stopped.target);
    const first = durableTempPath(stopped.target, stopped.text);
    const secondText = canonicalJson({ thirdParty: true });
    const second = durableTempPath(stopped.target, secondText);
    await writeFile(first, stopped.text, { flag: 'wx' });
    await writeFile(second, secondText, { flag: 'wx' });
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(first, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(second, 'utf8')).resolves.toBe(secondText);
  });

  it.each(['target-diff', 'filename-sha', 'unknown-temp'] as const)(
    'prepared canonical tempの%sを第三者値を保持して拒否する',
    async (fault) => {
      const value = await preparedFixture(`prepared-temp-${fault}`);
      const stopped = await stopAfterPreparedTarget(value);
      await rm(stopped.target);
      const temporary = fault === 'unknown-temp'
        ? join(stopped.directory, '.intruder.tmp')
        : durableTempPath(
            stopped.target,
            stopped.text,
            fault === 'filename-sha' ? H('wrong-filename-sha') : H(stopped.text),
          );
      await writeFile(temporary, stopped.text, { flag: 'wx' });
      if (fault === 'target-diff') {
        await writeFile(stopped.target, 'third-party-target', { flag: 'wx' });
      }
      await expect(recoverF005WorkAcceptance(value.root))
        .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
      await expect(readFile(temporary, 'utf8')).resolves.toBe(stopped.text);
      if (fault === 'target-diff') {
        await expect(readFile(stopped.target, 'utf8')).resolves.toBe('third-party-target');
      }
    },
  );

  it('valid prepared tempとunknown file共存時はpre-scanで全path/bytesを不変保持する', async () => {
    const value = await preparedFixture('prepared-temp-with-unknown');
    const stopped = await stopAfterPreparedTarget(value);
    await rm(stopped.target);
    const preparedTemp = durableTempPath(stopped.target, stopped.text);
    const unknownPath = join(stopped.directory, 'third-party.bin');
    await writeFile(preparedTemp, stopped.text, { flag: 'wx' });
    await writeFile(unknownPath, 'third-party-bytes', { flag: 'wx' });
    const before = new Map(
      await Promise.all((await readdir(stopped.directory)).map(async (name) => [
        name,
        await readFile(join(stopped.directory, name), 'utf8'),
      ] as const)),
    );
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    const after = new Map(
      await Promise.all((await readdir(stopped.directory)).map(async (name) => [
        name,
        await readFile(join(stopped.directory, name), 'utf8'),
      ] as const)),
    );
    expect(after).toEqual(before);
    await expect(readFile(stopped.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prepared tempとinvalid later-phase temp共存時はpreparedも昇格せず全bytesを保持する', async () => {
    const value = await preparedFixture('prepared-temp-with-invalid-later');
    const stopped = await stopAfterPreparedTarget(value);
    await rm(stopped.target);
    const preparedTemp = durableTempPath(stopped.target, stopped.text);
    const invalidText = canonicalJson({ phase: 'capacity-measured', attacker: true });
    const laterTarget = join(stopped.directory, 'capacity-measured.json');
    const invalidLaterTemp = durableTempPath(laterTarget, invalidText);
    await writeFile(preparedTemp, stopped.text, { flag: 'wx' });
    await writeFile(invalidLaterTemp, invalidText, { flag: 'wx' });
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(preparedTemp, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(invalidLaterTemp, 'utf8')).resolves.toBe(invalidText);
    await expect(readFile(stopped.target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(laterTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalid canonical actualとvalid prepared temp共存時はtrashを含む全path/bytesを不変保持する', async () => {
    const value = await preparedFixture('prepared-temp-with-invalid-actual');
    const stopped = await stopAfterPreparedTarget(value);
    await rm(stopped.target);
    const preparedTemp = durableTempPath(stopped.target, stopped.text);
    await writeFile(preparedTemp, stopped.text, { flag: 'wx' });
    const invalidActual = canonicalJson({ invalidActual: true });
    const actualPath = join(
      value.root,
      'content',
      'batches',
      'F005',
      'capacity-actual',
      '000799',
      `${value.capacity.journalId}.json`,
    );
    await mkdir(dirname(actualPath), { recursive: true });
    await writeFile(actualPath, invalidActual, { flag: 'wx' });
    const trashBytes = canonicalJson({ mustRemain: true });
    const trashPath = join(
      value.root,
      '.cache',
      'recovery-trash',
      'f005',
      `discard-${H('invalid-actual-source')}-${H(trashBytes)}` +
        '-00000000-0000-4000-8000-000000000101.tmp',
    );
    await mkdir(dirname(trashPath), { recursive: true });
    await writeFile(trashPath, trashBytes, { flag: 'wx' });
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(preparedTemp, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(actualPath, 'utf8')).resolves.toBe(invalidActual);
    await expect(readFile(trashPath, 'utf8')).resolves.toBe(trashBytes);
    await expect(readFile(stopped.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pre-scan後・rename capability再open前の同SHA replacementを保持してconflictにする', async () => {
    const value = await preparedFixture('prepared-temp-rename-replacement');
    const stopped = await stopAfterPreparedTarget(value);
    await rm(stopped.target);
    const preparedTemp = durableTempPath(stopped.target, stopped.text);
    const heldOld = `${preparedTemp}.held-old`;
    await writeFile(preparedTemp, stopped.text, { flag: 'wx' });
    const relativeTemp = preparedTemp.slice(value.root.length + 1).replace(/\\/gu, '/');
    nativeMock.beforeNativeResolve = async (current, operation) => {
      if (current !== relativeTemp || operation !== 'rename-source') return;
      nativeMock.beforeNativeResolve = null;
      await rename(preparedTemp, heldOld);
      await writeFile(preparedTemp, stopped.text, { flag: 'wx' });
    };
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(preparedTemp, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(heldOld, 'utf8')).resolves.toBe(stopped.text);
    await expect(readFile(stopped.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('WorkAcceptanceJournalV3をexact field・nullable・whole-file SHA chainで保存する', async () => {
    const value = await preparedFixture('journal-v3-exact');
    await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
    );
    const directory = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
    );
    const preparedText = await readFile(join(directory, 'prepared.json'), 'utf8');
    const committedText = await readFile(join(directory, 'artifacts-committed.json'), 'utf8');
    const prepared = JSON.parse(preparedText) as Record<string, unknown>;
    const committed = JSON.parse(committedText) as Record<string, unknown>;
    expect(Object.keys(prepared).sort()).toEqual([
      'actualCapacityReportPath',
      'actualCapacityReportSha256',
      'candidateSha256',
      'capacityJournalPath',
      'capacityJournalSha256',
      'entries',
      'evidenceRefs',
      'expectedManifestSha256',
      'journalSha256',
      'manifestBackupPath',
      'manifestNextPath',
      'manifestPath',
      'nextManifestSha256',
      'owner',
      'phase',
      'previousPhaseJournalSha256',
      'recorderJournalId',
      'schemaVersion',
      'workId',
    ]);
    expect(prepared).toMatchObject({
      schemaVersion: 3,
      phase: 'prepared',
      previousPhaseJournalSha256: null,
      nextManifestSha256: null,
      capacityJournalSha256: null,
      actualCapacityReportSha256: null,
    });
    expect(committed.previousPhaseJournalSha256).toBe(H(preparedText));
    expect(committed.previousPhaseJournalSha256).not.toBe(prepared.journalSha256);
  });

  it('path traversalをself-resealしても拒否し、workspace外を変更しない', async () => {
    const value = await preparedFixture('journal-traversal');
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        afterArtifactRename: () => {
          throw new Error('fault:after-rename');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    const directory = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
    );
    const preparedPath = join(directory, 'prepared.json');
    const prepared = JSON.parse(await readFile(preparedPath, 'utf8')) as {
      journalSha256: Sha256;
      entries: { path: string }[];
      [key: string]: unknown;
    };
    prepared.entries[0]!.path = '../outside.wav';
    const core = Object.fromEntries(
      Object.entries(prepared).filter(([key]) => key !== 'journalSha256'),
    );
    prepared.journalSha256 = H(canonicalJson(core));
    await writeFile(preparedPath, canonicalJson(prepared));
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(join(value.root, '..', 'outside.wav')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('単独phaseの改ざんをself-resealしてもwhole-file hash chainで拒否する', async () => {
    const value = await preparedFixture('journal-reseal');
    await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
    );
    const preparedPath = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
      'prepared.json',
    );
    const prepared = JSON.parse(await readFile(preparedPath, 'utf8')) as {
      owner: string;
      journalSha256: Sha256;
      [key: string]: unknown;
    };
    prepared.owner = 'resealed-attacker';
    const core = Object.fromEntries(
      Object.entries(prepared).filter(([key]) => key !== 'journalSha256'),
    );
    prepared.journalSha256 = H(canonicalJson(core));
    await writeFile(preparedPath, canonicalJson(prepared));
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
  });

  it('prepared clone・expected SHA差・notice/ETW欠落をfail-closedにする', async () => {
    const value = await preparedFixture('accept-negative');
    await expect(acceptF005Work(
      value.root, { ...value.prepared }, value.prepared.expectedManifestSha, value.capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    await expect(acceptF005Work(
      value.root, value.prepared, H('stale'), value.capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });

    const changedEvidence = await preparedFixture('changed-evidence');
    await writeFile(
      join(changedEvidence.root, ...changedEvidence.prepared.evidenceRefs[0]!.path.split('/')),
      canonicalJson({
        schemaVersion: '1.0.0',
        kind: 'source',
        workId: '000799',
        previewSha256: changedEvidence.prepared.previewSha256,
        payload: { result: 'changed-after-prepare' },
      }),
    );
    await expect(acceptF005Work(
      changedEvidence.root,
      changedEvidence.prepared,
      changedEvidence.prepared.expectedManifestSha,
      changedEvidence.capacity,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });

    const lostValue = await fixture();
    const good = recorder('lost-preview', []);
    const preview = await prepareF005WorkPreview(
      lostValue.context, BASELINE, [], lostValue.staged, lostValue.artifacts, good,
    );
    const lost = recorder('lost-accept', [], true);
    const evidenceRefs = await acceptanceEvidence(
      lostValue.root,
      lostValue.staged.workId,
      preview.previewSha256,
    );
    await expect(prepareF005WorkAcceptance(
      lostValue.root, lostValue.context, '000799', evidenceRefs, preview, lost,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_PREPARE_INVALID' });
  });

  it('artifacts-committed crashを旧版へrollbackし、第三者変更を上書きしない', async () => {
    const value = await preparedFixture('recovery');
    await expect(acceptF005Work(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      {
        now: () => '2026-07-29T01:00:00.000Z',
        afterPhase: (phase) => {
          if (phase === 'artifacts-committed') throw new Error('simulated crash');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    const recovered = await recoverF005WorkAcceptance(value.root);
    expect(recovered).toMatchObject({ result: 'rolled-back', recoveredWorkIds: ['000799'] });
    const restoredManifest = JSON.parse(await readFile(
      join(value.root, ...'content/batches/F005/batch.json'.split('/')),
      'utf8',
    )) as BatchManifest;
    expect(hashBatchManifest(restoredManifest)).toBe(value.prepared.expectedManifestSha);
    await expect(readFile(value.prepared.operations[0]!.sourcePath)).resolves.toHaveLength(92);

    const conflict = await preparedFixture('recovery-conflict');
    await expect(acceptF005Work(
      conflict.root,
      conflict.prepared,
      conflict.prepared.expectedManifestSha,
      conflict.capacity,
      {
        afterPhase: (phase) => {
          if (phase === 'artifacts-committed') throw new Error('simulated crash');
        },
      },
    )).rejects.toBeInstanceOf(F005AcceptanceError);
    await writeFile(join(
      conflict.root,
      'content',
      'batches',
      'F005',
      'accepted-audio',
      '000799',
      'audio.wav',
    ), 'third-party');
    await expect(recoverF005WorkAcceptance(conflict.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
  });

  it('closed recoveryもmanifest/backup/target実SHAを再検証してからcompletedにする', async () => {
    const completed = await preparedFixture('closed-completed');
    await acceptF005Work(
      completed.root,
      completed.prepared,
      completed.prepared.expectedManifestSha,
      completed.capacity,
      { now: () => '2026-07-29T01:00:00.000Z' },
    );
    await expect(recoverF005WorkAcceptance(completed.root)).resolves.toMatchObject({
      result: 'completed',
      recoveredWorkIds: ['000799'],
    });

    const targetChanged = await preparedFixture('closed-target-changed');
    await acceptF005Work(
      targetChanged.root,
      targetChanged.prepared,
      targetChanged.prepared.expectedManifestSha,
      targetChanged.capacity,
    );
    await writeFile(join(
      targetChanged.root,
      ...targetChanged.prepared.operations[0]!.targetPath.split('/'),
    ), 'third-party-after-close');
    await expect(recoverF005WorkAcceptance(targetChanged.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });

    const manifestChanged = await preparedFixture('closed-manifest-changed');
    await acceptF005Work(
      manifestChanged.root,
      manifestChanged.prepared,
      manifestChanged.prepared.expectedManifestSha,
      manifestChanged.capacity,
    );
    const transactionDirectory = join(
      manifestChanged.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${manifestChanged.capacity.journalId}`,
    );
    await writeFile(
      join(manifestChanged.root, ...'content/batches/F005/batch.json'.split('/')),
      await readFile(join(transactionDirectory, 'manifest-old.json')),
    );
    await expect(recoverF005WorkAcceptance(manifestChanged.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
  });

  it.each(['actual', 'native', 'backup'] as const)(
    'closed recoveryは%s実体の第三者変更を再検証して拒否する',
    async (kind) => {
      const value = await preparedFixture(`closed-${kind}-changed`);
      await acceptF005Work(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
      );
      const directory = join(
        value.root,
        '.cache',
        'transactions',
        'f005-promote',
        `000799-${value.capacity.journalId}`,
      );
      const changedPath = kind === 'actual'
        ? join(
            value.root,
            ...`content/batches/F005/capacity-actual/000799/${value.capacity.journalId}.json`
              .split('/'),
          )
        : kind === 'native'
          ? join(value.root, '.cache', 'f005-capacity', `${value.capacity.journalId}.json`)
          : join(directory, 'manifest-old.json');
      await writeFile(changedPath, `third-party-${kind}`);
      await expect(recoverF005WorkAcceptance(value.root))
        .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    },
  );

  it('未知transaction fileを再帰削除せずconflictとして保持する', async () => {
    const value = await preparedFixture('unknown-transaction-file');
    await expect(stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      H('candidate'),
      {
        afterArtifactRename: () => {
          throw new Error('fault:partial-rename');
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    const unknownPath = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
      'attacker-owned.txt',
    );
    await writeFile(unknownPath, 'keep-me');
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(unknownPath, 'utf8')).resolves.toBe('keep-me');
  });

  it.each(['actual-saved', 'capacity-measured', 'manifest-renamed', 'manifest-committed'] as const)(
    'FLT-07C-E durable fsync境界%s停止をactual結合済みcompletedへroll-forwardする',
    async (faultPhase) => {
      const value = await preparedFixture(`fault-${faultPhase}`);
      await expect(acceptF005Work(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
        {
          now: () => '2026-07-29T01:00:00.000Z',
          afterPhase: (phase) => {
            if (phase === faultPhase) throw new Error(`fault:${faultPhase}`);
          },
        },
      )).rejects.toThrow(`fault:${faultPhase}`);
      await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
        result: 'completed',
        recoveredWorkIds: ['000799'],
      });
      const recovered = JSON.parse(await readFile(
        join(value.root, ...'content/batches/F005/batch.json'.split('/')),
        'utf8',
      )) as BatchManifest;
      expect(recovered.workProgress[0]?.status).toBe('accepted');
    },
  );

  it('capacity phaseのfile fsync直後・directory fsync前のfaultからroll-forwardする', async () => {
    const value = await preparedFixture('capacity-fsync-fault');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
      {
        afterFileSync: (artifact) => {
          if (artifact === 'capacity-measured') throw new Error('fault:capacity-file-fsync');
        },
      },
    )).rejects.toThrow('fault:capacity-file-fsync');
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'completed',
      recoveredWorkIds: ['000799'],
    });
  });

  it.each(['manifest-next', 'capacity-measured'] as const)(
    '%s target不在のcanonical tempを検証・昇格してphase chainをroll-forwardする',
    async (artifact) => {
      const value = await preparedFixture(`canonical-temp-${artifact}`);
      const candidateSha256 = H('candidate');
      const promoted = await stageF005WorkAcceptance(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
        candidateSha256,
      );
      const actualRef = await writeActualCapacity(
        value.root,
        value.prepared.workId,
        value.capacity,
        candidateSha256,
      );
      const directory = join(
        value.root,
        '.cache',
        'transactions',
        'f005-promote',
        `000799-${value.capacity.journalId}`,
      );
      const target = join(directory, `${artifact}.json`);
      let stoppedText: string | undefined;
      await expect(finalizeF005WorkAcceptance(
        value.root,
        promoted,
        actualRef,
        value.prepared.expectedManifestSha,
        {
          afterFileSync: async (current) => {
            if (current !== artifact) return;
            const name = (await readdir(directory))
              .find((entry) => entry.startsWith(`.${artifact}.json.`) && entry.endsWith('.tmp'));
            expect(name).toBeDefined();
            stoppedText = await readFile(join(directory, name!), 'utf8');
            throw new Error(`stop-after-${artifact}-temp-fsync`);
          },
        },
      )).rejects.toThrow(`stop-after-${artifact}-temp-fsync`);
      expect(stoppedText).toBeDefined();
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      const temporary = durableTempPath(target, stoppedText!);
      await writeFile(temporary, stoppedText!, { flag: 'wx' });
      await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
        result: 'completed',
        recoveredWorkIds: ['000799'],
      });
      const recovered = JSON.parse(await readFile(
        join(value.root, ...'content/batches/F005/batch.json'.split('/')),
        'utf8',
      )) as BatchManifest;
      expect(recovered.workProgress[0]?.status).toBe('accepted');
      await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['missing-next', 'invalid-live-backup-next'] as const)(
    'capacity-measured存在時のmanifest状態%sをglobal pre-scanでmutation前に拒否する',
    async (fault) => {
      const value = await preparedFixture(`capacity-state-${fault}`);
      const candidateSha256 = H('candidate');
      const promoted = await stageF005WorkAcceptance(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
        candidateSha256,
      );
      const actualRef = await writeActualCapacity(
        value.root,
        value.prepared.workId,
        value.capacity,
        candidateSha256,
      );
      await expect(finalizeF005WorkAcceptance(
        value.root,
        promoted,
        actualRef,
        value.prepared.expectedManifestSha,
        {
          afterPhase: (phase) => {
            if (phase === 'capacity-measured') {
              throw new Error(`stop-capacity-${fault}`);
            }
          },
        },
      )).rejects.toThrow(`stop-capacity-${fault}`);
      const directory = join(
        value.root,
        '.cache',
        'transactions',
        'f005-promote',
        `000799-${value.capacity.journalId}`,
      );
      const nextPath = join(directory, 'manifest-next.json');
      const backupPath = join(directory, 'manifest-old.json');
      const manifestPath = join(value.root, ...'content/batches/F005/batch.json'.split('/'));
      const capacityPath = join(directory, 'capacity-measured.json');
      const capacityText = await readFile(capacityPath, 'utf8');
      const manifestText = await readFile(manifestPath, 'utf8');
      if (fault === 'missing-next') {
        await rm(nextPath);
      } else {
        await writeFile(backupPath, manifestText, { flag: 'wx' });
      }
      const nextText = fault === 'missing-next' ? null : await readFile(nextPath, 'utf8');
      await expect(recoverF005WorkAcceptance(value.root))
        .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
      await expect(readFile(capacityPath, 'utf8')).resolves.toBe(capacityText);
      await expect(readFile(manifestPath, 'utf8')).resolves.toBe(manifestText);
      if (nextText === null) {
        await expect(readFile(nextPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(readFile(nextPath, 'utf8')).resolves.toBe(nextText);
        await expect(readFile(backupPath, 'utf8')).resolves.toBe(manifestText);
      }
    },
  );

  it('CAS後unlink前に残ったknown recovery-trashを次回回復でbounded清掃する', async () => {
    const value = await fixture();
    const bytes = canonicalJson({ stoppedAfterDiscardCas: true });
    const directory = join(value.root, '.cache', 'recovery-trash', 'f005');
    await mkdir(directory, { recursive: true });
    const trash = join(
      directory,
      `discard-${H('source-path')}-${H(bytes)}-00000000-0000-4000-8000-000000000099.tmp`,
    );
    await writeFile(trash, bytes, { flag: 'wx' });
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'no-op',
    });
    await expect(readFile(trash)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([128, 129] as const)(
    'known recovery-trash %i件の保持上限境界を適用する',
    async (count) => {
      const value = await fixture();
      const bytes = canonicalJson({ boundedTrash: true });
      const directory = join(value.root, '.cache', 'recovery-trash', 'f005');
      await mkdir(directory, { recursive: true });
      const paths: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const uuid =
          `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        const path = join(
          directory,
          `discard-${H(`source-${index}`)}-${H(bytes)}-${uuid}.tmp`,
        );
        await writeFile(path, bytes, { flag: 'wx' });
        paths.push(path);
      }
      if (count === 128) {
        await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
          result: 'no-op',
        });
        await expect(readdir(directory)).resolves.toEqual([]);
      } else {
        await expect(recoverF005WorkAcceptance(value.root))
          .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
        await expect(readdir(directory)).resolves.toHaveLength(129);
        await expect(readFile(paths[0]!, 'utf8')).resolves.toBe(bytes);
      }
    },
  );

  it('recovery-trash検証後の同名replacementをheld native deleteで保持してconflictにする', async () => {
    const value = await fixture();
    const bytes = canonicalJson({ replacementRace: true });
    const relativePath =
      `.cache/recovery-trash/f005/discard-${H('race-source')}-${H(bytes)}` +
      '-00000000-0000-4000-8000-000000000100.tmp';
    const target = join(value.root, ...relativePath.split('/'));
    const heldOld = `${target}.held-old`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    nativeMock.beforeNativeResolve = async (current, operation) => {
      if (current !== relativePath || operation !== 'delete-source') return;
      nativeMock.beforeNativeResolve = null;
      await rename(target, heldOld);
      await writeFile(target, bytes, { flag: 'wx' });
    };
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(target, 'utf8')).resolves.toBe(bytes);
    await expect(readFile(heldOld, 'utf8')).resolves.toBe(bytes);
  });

  it('manifest-nextをtemp fsync→native rename→pinned directory flushの順で永続化する', async () => {
    const value = await preparedFixture('native-directory-order');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    nativeMock.durabilityEvents.splice(0);
    const accepted = await finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
      {
        afterFileSync: (artifact) => {
          if (artifact === 'manifest-next') {
            nativeMock.durabilityEvents.push('temp-synced:manifest-next');
          }
        },
      },
    );
    expect(accepted.workProgress[0]?.status).toBe('accepted');
    const syncedIndex = nativeMock.durabilityEvents.indexOf('temp-synced:manifest-next');
    const renameIndex = nativeMock.durabilityEvents.findIndex((event) =>
      event.includes('.manifest-next.json.') && event.endsWith('->.cache/transactions/' +
        `f005-promote/000799-${value.capacity.journalId}/manifest-next.json`));
    const transactionDirectory = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
    );
    const flushIndex = nativeMock.durabilityEvents.findIndex(
      (event, index) => index > renameIndex && event === `flush:${transactionDirectory}`,
    );
    expect(syncedIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(syncedIndex);
    expect(flushIndex).toBeGreaterThan(renameIndex);
  });

  it('native directory flush失敗を成功扱いせずmanifest voicedのまま停止する', async () => {
    const value = await preparedFixture('native-directory-failure');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    const transactionDirectory = join(
      value.root,
      '.cache',
      'transactions',
      'f005-promote',
      `000799-${value.capacity.journalId}`,
    );
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
      {
        afterFileSync: (artifact) => {
          if (artifact === 'manifest-next') {
            nativeMock.failDirectorySyncDirectory = transactionDirectory;
          }
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TX_DURABLE_WRITE' });
    const manifest = JSON.parse(await readFile(
      join(value.root, ...'content/batches/F005/batch.json'.split('/')),
      'utf8',
    )) as BatchManifest;
    expect(manifest.workProgress[0]?.status).toBe('voiced');
    nativeMock.failDirectorySyncDirectory = null;
    await expect(recoverF005WorkAcceptance(value.root)).resolves.toMatchObject({
      result: 'completed',
      recoveredWorkIds: ['000799'],
    });
  });

  it.each(['bucket-total', 'unsafe-integer', 'missing-bucket'] as const)(
    'actual payloadの%s破損をmetadata CAS前に拒否する',
    async (fault) => {
      const value = await preparedFixture(`actual-${fault}`);
      const candidateSha256 = H('candidate');
      const promoted = await stageF005WorkAcceptance(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
        candidateSha256,
      );
      const actualRef = await writeActualCapacity(
        value.root,
        value.prepared.workId,
        value.capacity,
        candidateSha256,
      );
      const actualPath = join(value.root, ...actualRef.path.split('/'));
      const actual = JSON.parse(await readFile(actualPath, 'utf8')) as {
        payload: {
          minimumObservedFreeBytes: number;
          buckets: { totalBytes: number }[];
        };
      };
      if (fault === 'bucket-total') actual.payload.buckets[0]!.totalBytes = 1;
      if (fault === 'unsafe-integer') {
        actual.payload.minimumObservedFreeBytes = Number.MAX_SAFE_INTEGER + 1;
      }
      if (fault === 'missing-bucket') actual.payload.buckets.pop();
      const changedText = canonicalJson(actual);
      await writeFile(actualPath, changedText);
      await expect(finalizeF005WorkAcceptance(
        value.root,
        promoted,
        { ...actualRef, sha256: H(changedText) },
        value.prepared.expectedManifestSha,
      )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    },
  );

  it.each(['missing', 'extra', 'path', 'sha', 'bytes', 'planned-audio'] as const)(
    'actual audio bucketの%s差を昇格artifact exact set検証で拒否する',
    async (fault) => {
      const value = await preparedFixture(`actual-audio-${fault}`);
      const candidateSha256 = H('candidate');
      const promoted = await stageF005WorkAcceptance(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
        candidateSha256,
      );
      const actualRef = await writeActualCapacity(
        value.root,
        value.prepared.workId,
        value.capacity,
        candidateSha256,
      );
      const actualPath = join(value.root, ...actualRef.path.split('/'));
      const actual = JSON.parse(await readFile(actualPath, 'utf8')) as {
        payload: {
          buckets: {
            kind: string;
            entries: Record<string, unknown>[];
            totalBytes: number;
          }[];
        };
      };
      const audio = actual.payload.buckets[0]!;
      const entry = audio.entries[0]!;
      if (fault === 'missing') {
        audio.entries = [];
        audio.totalBytes = 0;
      } else if (fault === 'extra') {
        audio.entries.push({
          kind: 'path',
          path: 'content/batches/F005/accepted-audio/000799/extra.wav',
          bytes: 1,
          sha256: H('extra-audio'),
        });
        audio.totalBytes += 1;
      } else if (fault === 'path') {
        entry.path = 'content/batches/F005/accepted-audio/000799/other.wav';
      } else if (fault === 'sha') {
        entry.sha256 = H('other-audio');
      } else if (fault === 'bytes') {
        entry.bytes = 93;
        audio.totalBytes = 93;
      } else {
        entry.kind = 'planned-audio';
        entry.planSha256 = H('forbidden-plan');
      }
      const changedText = canonicalJson(actual);
      await writeFile(actualPath, changedText);
      await expect(finalizeF005WorkAcceptance(
        value.root,
        promoted,
        { ...actualRef, sha256: H(changedText) },
        value.prepared.expectedManifestSha,
      )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    },
  );

  it('native journalのowner/session-derived recorder tuple差を拒否する', async () => {
    const value = await preparedFixture('native-outer-binding');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    const nativePath = `.cache/f005-capacity/${value.capacity.journalId}.json`;
    const native = nativeMock.journals.get(nativePath)!;
    nativeMock.journals.set(nativePath, { ...native, owner: 'different-owner' });
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
  });

  it('old→backup後に第三者liveが出現したら上書き・backup復元せずconflictにする', async () => {
    const value = await preparedFixture('manifest-live-race');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    const manifestPath = join(value.root, ...'content/batches/F005/batch.json'.split('/'));
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
      {
        afterManifestOldRenamed: async () => {
          await writeFile(manifestPath, 'third-party-live', { flag: 'wx' });
        },
      },
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe('third-party-live');
    await expect(recoverF005WorkAcceptance(value.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe('third-party-live');
  });

  it('exclusive finalize lock競合ではmetadata CASを開始しない', async () => {
    const value = await preparedFixture('finalize-lock');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    const lockPath = join(value.root, '.cache', 'locks', 'f005-accept-000799.lock');
    await mkdir(join(value.root, '.cache', 'locks'), { recursive: true });
    await writeFile(lockPath, 'competing-owner', { flag: 'wx' });
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    const manifest = JSON.parse(await readFile(
      join(value.root, ...'content/batches/F005/batch.json'.split('/')),
      'utf8',
    )) as BatchManifest;
    expect(manifest.workProgress[0]?.status).toBe('voiced');
  });

  it('生存processのsealed finalize lockを拒否し、先行finalizeだけを完了する', async () => {
    const value = await preparedFixture('live-finalize-lock');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let reachedGate!: () => void;
    const reached = new Promise<void>((resolve) => { reachedGate = resolve; });
    const first = finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
      {
        afterFileSync: async (artifact) => {
          if (artifact === 'manifest-next') {
            reachedGate();
            await gate;
          }
        },
      },
    );
    await reached;
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
    releaseGate();
    const accepted = await first;
    expect(accepted.workProgress[0]).toMatchObject({
      workId: '000799',
      status: 'accepted',
    });
  });

  it('実child process停止後に残置したsealed finalize lockをnative CAS回収する', async () => {
    const value = await preparedFixture('stale-finalize-lock');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { windowsHide: true, stdio: 'ignore' },
    );
    await once(child, 'spawn');
    const pid = child.pid!;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    const lockCore = {
      schemaVersion: 1,
      pid,
      processStartIdentity: H('stopped-child-start'),
      token: '00000000-0000-4000-8000-000000000001',
      workId: '000799',
      recorderJournalId: value.capacity.journalId,
    };
    const lockText = canonicalJson({
      ...lockCore,
      sealSha256: H(canonicalJson(lockCore)),
    });
    await file(value.root, '.cache/locks/f005-accept-000799.lock', lockText);
    const accepted = await finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
    );
    expect(accepted.workProgress[0]).toMatchObject({
      workId: '000799',
      status: 'accepted',
    });
    await expect(readFile(join(
      value.root,
      '.cache',
      'locks',
      'f005-accept-000799.lock',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['stale', 'live', 'canonical-conflict'] as const)(
    'sealed finalize lock tempの%sをPID/start/token/tupleで判定し第三者値を保持する',
    async (state) => {
      const value = await preparedFixture(`finalize-lock-temp-${state}`);
      const candidateSha256 = H('candidate');
      const promoted = await stageF005WorkAcceptance(
        value.root,
        value.prepared,
        value.prepared.expectedManifestSha,
        value.capacity,
        candidateSha256,
      );
      const actualRef = await writeActualCapacity(
        value.root,
        value.prepared.workId,
        value.capacity,
        candidateSha256,
      );
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { windowsHide: true, stdio: 'ignore' },
      );
      await once(child, 'spawn');
      const pid = child.pid!;
      const processStartIdentity = await liveProcessStartIdentity(pid);
      if (state !== 'live') {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      const lockCore = {
        schemaVersion: 1,
        pid,
        processStartIdentity,
        token: '00000000-0000-4000-8000-000000000002',
        workId: '000799',
        recorderJournalId: value.capacity.journalId,
      };
      const lockText = canonicalJson({
        ...lockCore,
        sealSha256: H(canonicalJson(lockCore)),
      });
      const lockPath = join(value.root, '.cache', 'locks', 'f005-accept-000799.lock');
      await mkdir(dirname(lockPath), { recursive: true });
      const temporary = durableTempPath(lockPath, lockText);
      await writeFile(temporary, lockText, { flag: 'wx' });
      if (state === 'canonical-conflict') {
        await writeFile(lockPath, lockText, { flag: 'wx' });
      }
      try {
        if (state === 'stale') {
          await expect(finalizeF005WorkAcceptance(
            value.root,
            promoted,
            actualRef,
            value.prepared.expectedManifestSha,
          )).resolves.toMatchObject({
            workProgress: expect.arrayContaining([
              expect.objectContaining({ workId: '000799', status: 'accepted' }),
            ]),
          });
          await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          await expect(finalizeF005WorkAcceptance(
            value.root,
            promoted,
            actualRef,
            value.prepared.expectedManifestSha,
          )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
          await expect(readFile(temporary, 'utf8')).resolves.toBe(lockText);
          if (state === 'canonical-conflict') {
            await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockText);
          }
        }
      } finally {
        if (state === 'live') {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        }
      }
    },
  );

  it('actual reportのhardlink aliasを検出してmetadata finalizeを拒否する', async () => {
    const value = await preparedFixture('actual-hardlink');
    const candidateSha256 = H('candidate');
    const promoted = await stageF005WorkAcceptance(
      value.root,
      value.prepared,
      value.prepared.expectedManifestSha,
      value.capacity,
      candidateSha256,
    );
    const actualRef = await writeActualCapacity(
      value.root,
      value.prepared.workId,
      value.capacity,
      candidateSha256,
    );
    await link(
      join(value.root, ...actualRef.path.split('/')),
      join(value.root, '.cache', 'actual-hardlink-alias.json'),
    );
    await expect(finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      value.prepared.expectedManifestSha,
    )).rejects.toMatchObject({ code: 'F005_ACCEPTANCE_TRANSACTION_INVALID' });
  });
});

describe('UT-F005-022 two-stage acceptance [CHG-F005-002]', () => {
  it('ETW内stageではvoicedを維持し、closed actual後のmetadata CASだけでacceptedにする', async () => {
    const value = await fixture();
    const calls: string[] = [];
    const capacity = recorder('two-stage', calls);
    const preview = await prepareF005WorkPreview(
      value.context, BASELINE, [], value.staged, value.artifacts, capacity,
    );
    const refs = await acceptanceEvidence(value.root, value.staged.workId, preview.previewSha256);
    const prepared = await prepareF005WorkAcceptance(
      value.root, value.context, value.staged.workId, refs, preview, capacity,
    );
    const promoted = await stageF005WorkAcceptance(
      value.root, prepared, prepared.expectedManifestSha, capacity, H('candidate'),
    );
    const stillVoiced = JSON.parse(await readFile(
      join(value.root, ...'content/batches/F005/batch.json'.split('/')),
      'utf8',
    )) as BatchManifest;
    expect(stillVoiced.workProgress[0]?.status).toBe('voiced');
    expect(calls.at(0)).toBe('begin:preview');
    expect(calls.at(-1)).toBe('end:accept');

    const candidateSha256 = H('candidate');
    const actualRef = await writeActualCapacity(
      value.root,
      prepared.workId,
      capacity,
      candidateSha256,
    );
    const accepted = await finalizeF005WorkAcceptance(
      value.root,
      promoted,
      actualRef,
      prepared.expectedManifestSha,
      { now: () => '2026-07-29T01:00:00.000Z' },
    );
    expect(accepted.workProgress[0]?.status).toBe('accepted');
    expect(accepted.workProgress[0]?.stageRecords.at(-1)?.inputHashes)
      .toContain(actualRef.sha256);
  });
});
