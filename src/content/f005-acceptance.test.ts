import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ minted: new WeakSet<object>() }));
vi.mock('./f005-context.ts', () => ({
  isMintedF005ApprovedBatchContext(value: unknown) {
    return value !== null && typeof value === 'object' && contextMock.minted.has(value);
  },
}));

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
  acceptF005Work,
  createF005AcceptanceCapacityRecorder,
  F005AcceptanceError,
  prepareF005WorkAcceptance,
  prepareF005WorkPreview,
  recoverF005WorkAcceptance,
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
  return createF005AcceptanceCapacityRecorder({
    journalId: H(`${label}-journal`),
    owner: 'acceptance-worker',
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
      actualCapacityReport: await previewArtifact('actual-capacity-report'),
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

describe('UT-F005-022/023 logical acceptance and recovery [DES-F005-006][FUN-F005-022][FUN-F005-023]', () => {
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
      'f005-accept',
      `000799-${manifestChanged.capacity.journalId}`,
    );
    await writeFile(
      join(manifestChanged.root, ...'content/batches/F005/batch.json'.split('/')),
      await readFile(join(transactionDirectory, 'manifest-old.json')),
    );
    await expect(recoverF005WorkAcceptance(manifestChanged.root))
      .rejects.toMatchObject({ code: 'F005_ACCEPTANCE_RECOVERY_CONFLICT' });
  });
});
