import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './artifacts.ts';
import {
  BatchCandidateError,
  loadAndVerifyClosedApproval,
  selectApprovedBatchCandidateAndCreateTemplate,
  validateBatchCandidateRegistry,
  writeBatchCandidateRegistryAtomic,
  type BatchCandidateRegistry,
} from './batch-candidate.ts';
import type {
  BatchApprovalGateRefs,
  BatchAuthor,
  BatchId,
  Sha256,
  WorkspaceRelativePath,
} from './batch.ts';

const roots: string[] = [];
const path = (value: string): WorkspaceRelativePath => value as WorkspaceRelativePath;
const sha = (value: string | Uint8Array): Sha256 =>
  createHash('sha256').update(value).digest('hex') as Sha256;

function registry(
  evidenceSha = 'a'.repeat(64) as Sha256,
  approvalItemSha = 'b'.repeat(64) as Sha256,
  srsSha = 'c'.repeat(64) as Sha256,
  qtSha = 'd'.repeat(64) as Sha256,
): BatchCandidateRegistry {
  const authorCore = {
    authorId: '000035',
    name: 'だざいおさむ',
    originalName: '太宰治',
    slug: 'dazai-osamu',
  };
  const author: BatchAuthor = {
    ...authorCore,
    identitySha256: sha(canonicalJson(authorCore)),
  };
  return {
    schemaVersion: '1.0.0',
    candidates: [{
      batchId: 'F003',
      feature: 'F003',
      author,
      works: [
        {
          workId: '000275',
          title: '女生徒',
          order: 1,
          cardUrl: 'https://www.aozora.gr.jp/cards/000035/card275.html',
          xhtmlUrl: 'https://www.aozora.gr.jp/cards/000035/files/275_20169.html',
        },
        {
          workId: '001567',
          title: '走れメロス',
          order: 2,
          cardUrl: 'https://www.aozora.gr.jp/cards/000035/card1567.html',
          xhtmlUrl: 'https://www.aozora.gr.jp/cards/000035/files/1567_14913.html',
        },
        {
          workId: '000258',
          title: 'グッド・バイ',
          order: 3,
          cardUrl: 'https://www.aozora.gr.jp/cards/000035/card258.html',
          xhtmlUrl: 'https://www.aozora.gr.jp/cards/000035/files/258_20179.html',
        },
      ],
      approvalBinding: {
        queueId: 'Q-017',
        approvalItemSha256: approvalItemSha,
        documents: [
          { path: path('docs/srs/SRS-F003.md'), sha256: srsSha },
          { path: path('docs/tests/qt/QT-F003.md'), sha256: qtSha },
        ],
        evidenceRef: path('docs/evidence/requirements/F003-approval-binding.json'),
        evidenceSha256: evidenceSha,
      },
    }],
  };
}

const gateRefs: BatchApprovalGateRefs = {
  requirements: path('docs/srs/SRS-F003.md'),
  design: path('docs/design/DD-F003.md'),
  testspec: path('docs/tests/ut/UT-F003.md'),
  release: path('docs/evidence/release/F003-approval.json'),
};

const f004GateRefs: BatchApprovalGateRefs = {
  requirements: path('docs/srs/SRS-F004.md'),
  design: path('docs/design/DD-F004.md'),
  testspec: path('docs/tests/ut/UT-F004.md'),
  release: path('docs/evidence/release/F004-approval.json'),
};

async function fixture(): Promise<{
  readonly root: string;
  readonly queueSha: Sha256;
  readonly evidenceSha: Sha256;
  readonly registry: BatchCandidateRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-candidate-'));
  roots.push(root);
  await mkdir(join(root, 'docs', 'srs'), { recursive: true });
  await mkdir(join(root, 'docs', 'tests', 'qt'), { recursive: true });
  await mkdir(join(root, 'docs', 'evidence', 'requirements'), { recursive: true });
  const srs = '---\nfeature: F003\nstatus: Approved\n---\n# SRS\n';
  const qt = '---\nfeature: F003\nstatus: Approved\n---\n# QT\n';
  await writeFile(join(root, 'docs', 'srs', 'SRS-F003.md'), srs, 'utf8');
  await writeFile(join(root, 'docs', 'tests', 'qt', 'QT-F003.md'), qt, 'utf8');
  const queue = [
    'items:',
    '- id: Q-017',
    '  type: approval',
    '  status: closed',
    '  target: docs/srs/SRS-F003.md',
    '  target_mode: document',
    '  answer: 承認',
    "  approved_at: '2026-07-26T03:28:20+09:00'",
    '',
  ].join('\n');
  await writeFile(join(root, 'queue.yaml'), queue, 'utf8');
  const projection = {
    id: 'Q-017',
    type: 'approval',
    status: 'closed',
    target: 'docs/srs/SRS-F003.md',
    target_mode: 'document',
    answer: '承認',
    approved_at: '2026-07-26T03:28:20+09:00',
  };
  const evidence = {
    approvalItemSha256: sha(canonicalJson(projection)),
    approvalProjectionFields: ['id', 'type', 'status', 'target', 'target_mode', 'answer', 'approved_at'],
    changes: [{ id: 'CHG-F003-001', level: 'testspec', status: 'done' }],
    documents: [
      { path: 'docs/srs/SRS-F003.md', sha256: sha(srs) },
      { path: 'docs/tests/qt/QT-F003.md', sha256: sha(qt) },
    ],
    feature: 'F003',
    migratedAt: '2026-07-26T15:35:00+09:00',
    queueId: 'Q-017',
    queuePath: 'queue.yaml',
    queueSha256AtMigration: sha(queue),
    schemaVersion: '1.0.0',
  };
  const evidenceRaw = canonicalJson(evidence);
  await writeFile(
    join(root, 'docs', 'evidence', 'requirements', 'F003-approval-binding.json'),
    evidenceRaw,
    'utf8',
  );
  const value = registry(
    sha(evidenceRaw),
    evidence.approvalItemSha256,
    evidence.documents[0]!.sha256,
    evidence.documents[1]!.sha256,
  );
  return { root, queueSha: sha(queue), evidenceSha: sha(evidenceRaw), registry: value };
}

async function f004Fixture(): Promise<{
  readonly root: string;
  readonly queueSha: Sha256;
  readonly evidenceSha: Sha256;
  readonly registry: BatchCandidateRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-f004-candidate-'));
  roots.push(root);
  await mkdir(join(root, 'docs', 'srs'), { recursive: true });
  await mkdir(join(root, 'docs', 'tests', 'qt'), { recursive: true });
  await mkdir(join(root, 'docs', 'changes'), { recursive: true });
  await mkdir(join(root, 'docs', 'evidence', 'requirements'), { recursive: true });
  const srs = '---\nfeature: F004\nstatus: Approved\n---\n# SRS\n';
  const qt = '---\nfeature: F004\nstatus: Approved\n---\n# QT\n';
  const change = [
    '---',
    'id: CHG-F004-001',
    'feature: F004',
    'level: requirement',
    'status: in-review',
    '---',
    '# CHG',
    '',
  ].join('\n');
  await writeFile(join(root, 'docs', 'srs', 'SRS-F004.md'), srs, 'utf8');
  await writeFile(join(root, 'docs', 'tests', 'qt', 'QT-F004.md'), qt, 'utf8');
  await writeFile(join(root, 'docs', 'changes', 'CHG-F004-001.md'), change, 'utf8');
  const approvedAt = '2026-07-27T00:00:00+09:00';
  const queue = [
    'items:',
    '- id: Q-022',
    '  type: approval',
    '  status: closed',
    '  target: docs/srs/SRS-F004.md',
    '  target_mode: document',
    '  answer: 承認',
    `  approved_at: '${approvedAt}'`,
    '- id: Q-023',
    '  type: approval',
    '  status: closed',
    '  target: docs/changes/CHG-F004-001.md',
    '  target_mode: document',
    '  answer: 承認',
    `  approved_at: '${approvedAt}'`,
    '',
  ].join('\n');
  await writeFile(join(root, 'queue.yaml'), queue, 'utf8');
  const approvalSha = (queueId: 'Q-022' | 'Q-023', target: string): Sha256 =>
    sha(canonicalJson({
      id: queueId,
      type: 'approval',
      status: 'closed',
      target,
      target_mode: 'document',
      answer: '承認',
      approved_at: approvedAt,
    }));
  const approvalItemSha256s = {
    'Q-022': approvalSha('Q-022', 'docs/srs/SRS-F004.md'),
    'Q-023': approvalSha('Q-023', 'docs/changes/CHG-F004-001.md'),
  };
  const documents = [
    { path: 'docs/srs/SRS-F004.md', sha256: sha(srs) },
    { path: 'docs/tests/qt/QT-F004.md', sha256: sha(qt) },
    { path: 'docs/changes/CHG-F004-001.md', sha256: sha(change) },
  ];
  const evidence = {
    approvalProjectionFields: ['id', 'type', 'status', 'target', 'target_mode', 'answer', 'approved_at'],
    approvals: [
      { queueId: 'Q-022', approvalItemSha256: approvalItemSha256s['Q-022'] },
      { queueId: 'Q-023', approvalItemSha256: approvalItemSha256s['Q-023'] },
    ],
    changes: [{ id: 'CHG-F004-001', level: 'requirement', status: 'in-review' }],
    documents,
    feature: 'F004',
    migratedAt: '2026-07-27T00:10:00+09:00',
    queuePath: 'queue.yaml',
    queueSha256AtMigration: sha(queue),
    schemaVersion: '1.1.0',
  };
  const evidenceRaw = canonicalJson(evidence);
  await writeFile(
    join(root, 'docs', 'evidence', 'requirements', 'F004-approval-binding.json'),
    evidenceRaw,
    'utf8',
  );
  const authorCore = {
    authorId: '000081',
    name: 'みやざわずんじ',
    originalName: '宮沢賢治',
    slug: 'miyazawa-zunji',
  };
  const value: BatchCandidateRegistry = {
    schemaVersion: '1.0.0',
    candidates: [{
      batchId: 'F004',
      feature: 'F004',
      author: {
        ...authorCore,
        identitySha256: 'f7b658e3729e6adb3bba4ac11a0ba2657779ab21e84e47f467db244adf6b1bac' as Sha256,
      },
      works: [
        {
          workId: '000466',
          title: 'オツベルと象',
          order: 1,
          cardUrl: 'https://www.aozora.gr.jp/cards/000081/card466.html',
          xhtmlUrl: 'https://www.aozora.gr.jp/cards/000081/files/466_42316.html',
        },
        {
          workId: '045679',
          title: '雪渡り',
          order: 2,
          cardUrl: 'https://www.aozora.gr.jp/cards/000081/card45679.html',
          xhtmlUrl: 'https://www.aozora.gr.jp/cards/000081/files/45679_22349.html',
        },
        {
          workId: '001918',
          title: 'カイロ団長',
          order: 3,
          cardUrl: 'https://www.aozora.gr.jp/cards/000081/card1918.html',
          xhtmlUrl: 'https://www.aozora.gr.jp/cards/000081/files/1918_17630.html',
        },
      ],
      approvalBinding: {
        queueIds: ['Q-022', 'Q-023'],
        approvalItemSha256s,
        documents: documents.map((document) => ({
          path: path(document.path),
          sha256: document.sha256,
        })),
        evidenceRef: path('docs/evidence/requirements/F004-approval-binding.json'),
        evidenceSha256: sha(evidenceRaw),
      },
    }],
  };
  return { root, queueSha: sha(queue), evidenceSha: sha(evidenceRaw), registry: value };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('F003 candidate registry [DES-F003-001]', () => {
  // @des DES-F003-001 @fun FUN-F003-001 @ut UT-F003-001
  it('exact schema・3作品順序・author identityを検証する', () => {
    expect(validateBatchCandidateRegistry(registry())).toMatchObject({ ok: true });
    const unknown = structuredClone(registry()) as unknown as Record<string, unknown>;
    unknown.published = true;
    expect(validateBatchCandidateRegistry(unknown)).toMatchObject({
      ok: false,
      code: 'CANDIDATE_REGISTRY_INVALID',
    });
    const duplicate = structuredClone(registry()) as unknown as {
      candidates: Array<{ works: Array<{ workId: string }> }>;
    };
    duplicate.candidates[0]!.works[1]!.workId = '000275';
    expect(validateBatchCandidateRegistry(duplicate)).toMatchObject({
      ok: false,
      code: 'CANDIDATE_DUPLICATE',
    });
  });

  // @des DES-F003-001 @fun FUN-F003-001 @ut UT-F003-001
  it('expected old SHA付きでcanonical registryをatomic保存する', async () => {
    const { root, registry: value } = await fixture();
    const writtenSha = await writeBatchCandidateRegistryAtomic(
      root,
      path('content/batch-candidates.json'),
      value,
      null,
    );
    const raw = await readFile(join(root, 'content', 'batch-candidates.json'), 'utf8');
    expect(raw).toBe(canonicalJson(value));
    expect(writtenSha).toBe(sha(raw));
    await expect(writeBatchCandidateRegistryAtomic(
      root,
      path('content/batch-candidates.json'),
      value,
      'f'.repeat(64) as Sha256,
    )).rejects.toMatchObject({ code: 'CANDIDATE_APPROVAL_CONFLICT' });
  });

  // @des DES-F003-001 @fun FUN-F003-002 @ut UT-F003-002
  it('Q-017 projection・queue全体expected SHA・Approved文書実体を再検算する', async () => {
    const input = await fixture();
    const approval = await loadAndVerifyClosedApproval(
      input.root,
      path('queue.yaml'),
      input.queueSha,
      {
        path: path('docs/evidence/requirements/F003-approval-binding.json'),
        sha256: input.evidenceSha,
      },
    );
    expect(approval).toMatchObject({
      __brand: 'VerifiedClosedApproval',
      queueId: 'Q-017',
      feature: 'F003',
    });
    await expect(loadAndVerifyClosedApproval(
      input.root,
      path('queue.yaml'),
      '0'.repeat(64) as Sha256,
      {
        path: path('docs/evidence/requirements/F003-approval-binding.json'),
        sha256: input.evidenceSha,
      },
    )).rejects.toMatchObject({ code: 'CANDIDATE_APPROVAL_CONFLICT' });
    await writeFile(join(input.root, 'docs', 'srs', 'SRS-F003.md'), 'changed', 'utf8');
    await expect(loadAndVerifyClosedApproval(
      input.root,
      path('queue.yaml'),
      input.queueSha,
      {
        path: path('docs/evidence/requirements/F003-approval-binding.json'),
        sha256: input.evidenceSha,
      },
    )).rejects.toMatchObject({ code: 'CANDIDATE_APPROVAL_CONFLICT' });
  });

  // @des DES-F003-001 @fun FUN-F003-003 @ut UT-F003-003
  it('検証済み承認と一致する一意候補だけをgeneric templateへ変換する', async () => {
    const input = await fixture();
    const approval = await loadAndVerifyClosedApproval(
      input.root,
      path('queue.yaml'),
      input.queueSha,
      {
        path: path('docs/evidence/requirements/F003-approval-binding.json'),
        sha256: input.evidenceSha,
      },
    );
    const manifest = selectApprovedBatchCandidateAndCreateTemplate(
      input.registry,
      approval,
      'F003' as BatchId,
      gateRefs,
    );
    expect(manifest).toMatchObject({
      batchId: 'F003',
      feature: 'F003',
      status: 'draft',
      workIds: ['000275', '001567', '000258'],
    });
    expect(manifest.workProgress.map((work) => work.status)).toEqual(['pending', 'pending', 'pending']);
    expect(manifest.inputPaths).toEqual([]);
    expect(manifest.outputPaths).toEqual([]);
    const forgedApproval = structuredClone(approval);
    expect(() => selectApprovedBatchCandidateAndCreateTemplate(
      input.registry,
      forgedApproval,
      'F003' as BatchId,
      gateRefs,
    )).toThrow(expect.objectContaining<Partial<BatchCandidateError>>({
      code: 'CANDIDATE_APPROVAL_INVALID',
    }));
    const changed = structuredClone(input.registry) as unknown as {
      candidates: Array<{ approvalBinding: { evidenceSha256: Sha256 } }>;
    };
    changed.candidates[0]!.approvalBinding.evidenceSha256 = 'e'.repeat(64) as Sha256;
    expect(() => selectApprovedBatchCandidateAndCreateTemplate(
      changed,
      approval,
      'F003' as BatchId,
      gateRefs,
    )).toThrow(expect.objectContaining<Partial<BatchCandidateError>>({
      code: 'CANDIDATE_APPROVAL_CONFLICT',
    }));
  });
});

describe('F004 generic approval policy [DES-F004-001][DES-F004-011]', () => {
  // @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @ut UT-F004-001
  it('Q-022/Q-023とSRS/QT/CHGを静的policyでまとめて検証する', async () => {
    const input = await f004Fixture();
    expect(validateBatchCandidateRegistry(input.registry)).toMatchObject({ ok: true });
    const approval = await loadAndVerifyClosedApproval(
      input.root,
      path('queue.yaml'),
      input.queueSha,
      {
        path: path('docs/evidence/requirements/F004-approval-binding.json'),
        sha256: input.evidenceSha,
      },
    );
    expect(approval).toMatchObject({
      __brand: 'VerifiedClosedApproval',
      feature: 'F004',
      queueIds: ['Q-022', 'Q-023'],
      targets: [
        'docs/srs/SRS-F004.md',
        'docs/changes/CHG-F004-001.md',
      ],
    });
    expect(Object.keys(approval.approvalItemSha256s)).toEqual(['Q-022', 'Q-023']);
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Object.isFrozen(approval.queueIds)).toBe(true);
    expect(Object.isFrozen(approval.approvalItemSha256s)).toBe(true);
  });

  // @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @ut UT-F004-001
  it('approval state・順序・CHG state・未許可evidence pathの差替えを拒否する', async () => {
    const open = await f004Fixture();
    const openQueuePath = join(open.root, 'queue.yaml');
    const openQueue = (await readFile(openQueuePath, 'utf8'))
      .replace('status: closed', 'status: open');
    await writeFile(openQueuePath, openQueue, 'utf8');
    await expect(loadAndVerifyClosedApproval(
      open.root,
      path('queue.yaml'),
      sha(openQueue),
      {
        path: path('docs/evidence/requirements/F004-approval-binding.json'),
        sha256: open.evidenceSha,
      },
    )).rejects.toMatchObject({ code: 'F004_APPROVAL_MISMATCH' });

    const changed = await f004Fixture();
    await writeFile(
      join(changed.root, 'docs', 'changes', 'CHG-F004-001.md'),
      '---\nid: CHG-F004-001\nfeature: F004\nlevel: requirement\nstatus: done\n---\n',
      'utf8',
    );
    await expect(loadAndVerifyClosedApproval(
      changed.root,
      path('queue.yaml'),
      changed.queueSha,
      {
        path: path('docs/evidence/requirements/F004-approval-binding.json'),
        sha256: changed.evidenceSha,
      },
    )).rejects.toMatchObject({ code: 'F004_APPROVAL_MISMATCH' });

    await expect(loadAndVerifyClosedApproval(
      changed.root,
      path('queue.yaml'),
      changed.queueSha,
      {
        path: path('docs/evidence/requirements/forged.json'),
        sha256: changed.evidenceSha,
      },
    )).rejects.toMatchObject({ code: 'CANDIDATE_APPROVAL_INVALID' });

    const reordered = structuredClone(changed.registry) as unknown as {
      candidates: Array<{ approvalBinding: { queueIds: string[] } }>;
    };
    reordered.candidates[0]!.approvalBinding.queueIds.reverse();
    expect(validateBatchCandidateRegistry(reordered)).toMatchObject({
      ok: false,
      code: 'CANDIDATE_REGISTRY_INVALID',
    });
  });

  // @des DES-F004-001 @fun FUN-F004-001 @fun FUN-F004-005 @ut UT-F004-001 @ut UT-F004-005
  it('旧caller registry APIからのF004 template生成を拒否する', async () => {
    const input = await f004Fixture();
    const approval = await loadAndVerifyClosedApproval(
      input.root,
      path('queue.yaml'),
      input.queueSha,
      {
        path: path('docs/evidence/requirements/F004-approval-binding.json'),
        sha256: input.evidenceSha,
      },
    );
    expect(() => selectApprovedBatchCandidateAndCreateTemplate(
      input.registry,
      approval,
      'F004' as BatchId,
      f004GateRefs,
    )).toThrow(expect.objectContaining<Partial<BatchCandidateError>>({
      code: 'CANDIDATE_APPROVAL_INVALID',
    }));

    const forgedApproval = structuredClone(approval);
    expect(() => selectApprovedBatchCandidateAndCreateTemplate(
      input.registry,
      forgedApproval,
      'F004' as BatchId,
      f004GateRefs,
    )).toThrow(expect.objectContaining<Partial<BatchCandidateError>>({
      code: 'CANDIDATE_APPROVAL_INVALID',
    }));
  });
});
