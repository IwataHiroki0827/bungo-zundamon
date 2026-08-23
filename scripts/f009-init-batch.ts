import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  createBatchManifestFromApprovedContext,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import { canonicalJson } from '../src/content/artifacts.ts';
import { validateBatchManifest, type WorkspaceRelativePath } from '../src/content/batch.ts';

/**
 * F009（夢野久作3作品追加）のdraft batch.jsonを新規作成する。F006〜F008と同じく
 * `createBatchManifestFromApprovedContext`経路で作成する（F008向けscripts/f008-init-batch.ts
 * の複製・F009向けパラメータ化）。
 * @des DES-F009-001 @fun FUN-F009-001
 */
async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F009.ref,
    BATCH_DEFINITION_REFS.F009.sha256,
    APPROVAL_POLICY_REFS.F009.ref,
    APPROVAL_POLICY_REFS.F009.sha256,
  );
  const manifest = createBatchManifestFromApprovedContext(context, {
    requirements: 'docs/srs/SRS-F009.md' as WorkspaceRelativePath,
    design: 'docs/design/DD-F009.md' as WorkspaceRelativePath,
    testspec: 'docs/tests/ut/UT-F009.md' as WorkspaceRelativePath,
    release: 'docs/evidence/release/F009-approval.json' as WorkspaceRelativePath,
  });
  const checked = validateBatchManifest(manifest);
  if (!checked.ok) throw new Error(`生成したmanifestがvalidationに失敗しました: ${checked.error.code} ${checked.error.message}`);
  const manifestPath = 'content/batches/F009/batch.json' as WorkspaceRelativePath;
  const target = resolve(workspace, ...manifestPath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(manifest), 'utf8');
  process.stdout.write(canonicalJson({ ok: true, workIds: manifest.workIds, status: manifest.status }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
