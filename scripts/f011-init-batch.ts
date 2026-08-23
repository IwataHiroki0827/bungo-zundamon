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
 * F011（新美南吉3作品追加、10人目・最終目標）のdraft batch.jsonを新規作成する。
 * F006〜F010と同じく`createBatchManifestFromApprovedContext`経路で作成する（F010向け
 * scripts/f010-init-batch.tsの複製・F011向けパラメータ化）。
 * @des DES-F011-001 @fun FUN-F011-001
 */
async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F011.ref,
    BATCH_DEFINITION_REFS.F011.sha256,
    APPROVAL_POLICY_REFS.F011.ref,
    APPROVAL_POLICY_REFS.F011.sha256,
  );
  const manifest = createBatchManifestFromApprovedContext(context, {
    requirements: 'docs/srs/SRS-F011.md' as WorkspaceRelativePath,
    design: 'docs/design/DD-F011.md' as WorkspaceRelativePath,
    testspec: 'docs/tests/ut/UT-F011.md' as WorkspaceRelativePath,
    release: 'docs/evidence/release/F011-approval.json' as WorkspaceRelativePath,
  });
  const checked = validateBatchManifest(manifest);
  if (!checked.ok) throw new Error(`生成したmanifestがvalidationに失敗しました: ${checked.error.code} ${checked.error.message}`);
  const manifestPath = 'content/batches/F011/batch.json' as WorkspaceRelativePath;
  const target = resolve(workspace, ...manifestPath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(manifest), 'utf8');
  process.stdout.write(canonicalJson({ ok: true, workIds: manifest.workIds, status: manifest.status }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
