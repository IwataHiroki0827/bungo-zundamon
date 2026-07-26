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
