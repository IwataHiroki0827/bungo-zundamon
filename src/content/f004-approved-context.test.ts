import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  createBatchManifestFromApprovedContext,
  loadAndVerifyBatchCandidate,
  verifyExistingAuthorIdentity,
  type ApprovedBatchContext,
  type BatchCandidateRegistry,
} from './batch-candidate.ts';
import { canonicalJson } from './artifacts.ts';
import { F004_V030_PINS, loadPublishedV030Baseline } from './f004-baseline.ts';
import type { BatchApprovalGateRefs, Sha256, WorkspaceRelativePath } from './batch.ts';

const workspace = resolve('.');
const temporaryRoots: string[] = [];
const gates: BatchApprovalGateRefs = {
  requirements: 'docs/srs/SRS-F004.md' as WorkspaceRelativePath,
  design: 'docs/design/DD-F004.md' as WorkspaceRelativePath,
  testspec: 'docs/tests/ut/UT-F004.md' as WorkspaceRelativePath,
  release: 'docs/evidence/release/F004-approval.json' as WorkspaceRelativePath,
};

async function tamperedRegistryWorkspace(
  field: 'title' | 'cardUrl' | 'xhtmlUrl',
  replacement: string,
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'bungo-f004-definition-'));
  temporaryRoots.push(root);
  for (const directory of ['content/batch-definitions', 'content/approval-policies']) {
    await mkdir(resolve(root, directory), { recursive: true });
  }
  await Promise.all([
    copyFile(
      resolve(workspace, BATCH_DEFINITION_REFS.F004.ref),
      resolve(root, BATCH_DEFINITION_REFS.F004.ref),
    ),
    copyFile(
      resolve(workspace, APPROVAL_POLICY_REFS.F004.ref),
      resolve(root, APPROVAL_POLICY_REFS.F004.ref),
    ),
  ]);
  const registry = JSON.parse(
    await readFile(resolve(workspace, 'content/batch-candidates.json'), 'utf8'),
  ) as BatchCandidateRegistry;
  const mutated = {
    ...registry,
    candidates: registry.candidates.map((candidate) => candidate.feature === 'F004'
      ? {
          ...candidate,
          works: candidate.works.map((work, index) => index === 0
            ? { ...work, [field]: replacement }
            : work),
        }
      : candidate),
  };
  await writeFile(resolve(root, 'content/batch-candidates.json'), canonicalJson(mutated), 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('F004 ApprovedBatchContext', () => {
  /** @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @test UT-F004-001 */
  it('canonical definition/policyからだけimmutable contextをmintする', async () => {
    const context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );

    expect(context.__brand).toBe('ApprovedBatchContext');
    expect(context.definition).toMatchObject({
      __brand: 'VerifiedBatchDefinition',
      authorExpectation: 'reuse',
      works: [
        { workId: '000466', title: 'オツベルと象' },
        { workId: '045679', title: '雪渡り' },
        { workId: '001918', title: 'カイロ団長' },
      ],
    });
    expect(context.policy.__brand).toBe('VerifiedApprovalBindingPolicy');
    expect(context.candidate.works.map((work) => work.title))
      .toEqual(['オツベルと象', '雪渡り', 'カイロ団長']);
    expect(Object.isFrozen(context)).toBe(true);
  });

  /** @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @test UT-F004-001 */
  it('definition/policyのSHA差とcross-feature refを拒否する', async () => {
    await expect(loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      '0'.repeat(64) as Sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    )).rejects.toMatchObject({ code: 'CANDIDATE_REGISTRY_INVALID' });
    await expect(loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F003.ref,
      APPROVAL_POLICY_REFS.F003.sha256,
    )).rejects.toMatchObject({ code: 'CANDIDATE_REGISTRY_INVALID' });
  });

  /** @des DES-F004-001 @fun FUN-F004-001 @test UT-F004-001 */
  it.each([
    ['title', '差替え作品'],
    ['cardUrl', 'https://www.aozora.gr.jp/cards/000081/card999999.html'],
    ['xhtmlUrl', 'https://www.aozora.gr.jp/cards/000081/files/999999_99999.html'],
  ] as const)('同じwork IDでも%s改ざんを拒否する', async (field, replacement) => {
    const root = await tamperedRegistryWorkspace(field, replacement);
    await expect(loadAndVerifyBatchCandidate(
      root,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    )).rejects.toMatchObject({ code: 'CANDIDATE_REGISTRY_INVALID' });
  });

  /** @des DES-F004-001 @fun FUN-F004-005 @test UT-F004-005 */
  it('mint済みcontextだけを3作品pending manifestへ変換する', async () => {
    const context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );
    const manifest = createBatchManifestFromApprovedContext(context, gates);
    expect(manifest.workIds).toEqual(['000466', '045679', '001918']);
    expect(manifest.workProgress.map((work) => work.status)).toEqual(['pending', 'pending', 'pending']);
    expect(() => createBatchManifestFromApprovedContext(
      structuredClone(context) as ApprovedBatchContext,
      gates,
    )).toThrow(expect.objectContaining({ code: 'CANDIDATE_APPROVAL_INVALID' }));
  });

  /** @des DES-F004-001 @des DES-F004-007 @fun FUN-F004-004 @test UT-F004-004 */
  it('公開v0.3.0 Catalogの宮沢identity exact 1件へ結合する', async () => {
    const [context, baseline] = await Promise.all([
      loadAndVerifyBatchCandidate(
        workspace,
        BATCH_DEFINITION_REFS.F004.ref,
        BATCH_DEFINITION_REFS.F004.sha256,
        APPROVAL_POLICY_REFS.F004.ref,
        APPROVAL_POLICY_REFS.F004.sha256,
      ),
      loadPublishedV030Baseline(workspace, F004_V030_PINS),
    ]);
    expect(verifyExistingAuthorIdentity(context, baseline.catalog)).toMatchObject({
      __brand: 'ExistingAuthorIdentity',
      introducedByBatchId: 'F002',
      author: {
        authorId: '000081',
        identitySha256: 'f7b658e3729e6adb3bba4ac11a0ba2657779ab21e84e47f467db244adf6b1bac',
      },
    });
  });
});
