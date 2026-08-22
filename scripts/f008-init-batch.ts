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
 * F008（江戸川乱歩3作品追加）のdraft batch.jsonを新規作成する。
 * F007のbatch.jsonはT-160実施時に本関数と同じ`createBatchManifestFromApprovedContext`
 * 経路で作成された（commit 66896bf）。`writeBatchManifestAtomic`は既存ファイルの
 * 更新専用（ENOENTでBATCH_WRITE_CONFLICT、batch.test.tsの`before`セットアップと
 * 同様の直接writeFileが初回作成の precedent）のため、初回作成はcanonical JSONの
 * 直接writeFileで行う。F007向けの専用init scriptは残されておらず
 * batch.jsonのみが直接commitされていたため、本scriptをF008向けに新規実装し、
 * 生成過程を再現可能にする。
 * @des DES-F008-001 @fun FUN-F008-001
 */
async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F008.ref,
    BATCH_DEFINITION_REFS.F008.sha256,
    APPROVAL_POLICY_REFS.F008.ref,
    APPROVAL_POLICY_REFS.F008.sha256,
  );
  const manifest = createBatchManifestFromApprovedContext(context, {
    requirements: 'docs/srs/SRS-F008.md' as WorkspaceRelativePath,
    design: 'docs/design/DD-F008.md' as WorkspaceRelativePath,
    testspec: 'docs/tests/ut/UT-F008.md' as WorkspaceRelativePath,
    release: 'docs/evidence/release/F008-approval.json' as WorkspaceRelativePath,
  });
  const checked = validateBatchManifest(manifest);
  if (!checked.ok) throw new Error(`生成したmanifestがvalidationに失敗しました: ${checked.error.code} ${checked.error.message}`);
  const manifestPath = 'content/batches/F008/batch.json' as WorkspaceRelativePath;
  const target = resolve(workspace, ...manifestPath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(manifest), 'utf8');
  process.stdout.write(canonicalJson({ ok: true, workIds: manifest.workIds, status: manifest.status }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
