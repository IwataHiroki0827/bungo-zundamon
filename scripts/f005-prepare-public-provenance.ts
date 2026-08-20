/**
 * f005-final-integration.tsのreferencedPublicEvidence(src/content/batch-public.ts)は、
 * BatchCatalogFragment.publicFiles[].sourceを「実ワークスペース上に既に存在する実ファイル」
 * として検証する(lstat/realpathでsymlink・非regular fileを拒否)。
 *
 * F005の公開provenanceは封緘済み選定snapshot(selection.json)と原典source-record.jsonから
 * buildF005SourceProvenance()で決定的に組み立てられる値であり、F001 baselineの凍結対象では
 * ない(リリースごとに再生成してよい)。しかしf005-final-integration.ts自体はexact clean
 * source commit・loadAcceptedBatches内のverifyGitCheckoutでgit HEADのclean性を複数回検査する
 * ため、実行中に新規ファイルを実ワークスペースへ書き込むとその場でtreeがdirty化し、後続の
 * clean-tree検査に失敗する(2026-08-20/21に実測)。
 *
 * そのため、このscriptを最終統合の「事前準備」として一度だけ実行し、
 * content/batches/F005/public-files/provenance/{workId}.jsonへ永続化・commitしておく。
 * f005-final-integration.tsはこのファイルを読取専用参照し、都度再計算した値とのhash一致だけ
 * 検証する(F004のcontent/batches/F004/public-files/provenance/踏襲)。
 *
 * 値は決定的なので、選定snapshotが不変である限り再実行しても同一内容が書かれる(冪等)。
 * 実行後もこのファイルは記録として残す(削除しない)。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { validateBatchManifest } from '../src/content/batch.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import {
  buildF005SourceProvenance,
  parseF005SourceRecord,
  rehydrateF005SelectionSnapshot,
  type F005WorkId,
} from '../src/content/f005-source.ts';

const WORKSPACE = resolve(import.meta.dirname, '..');
const BATCH_ID = 'F005';

async function readCanonicalJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`canonical JSONではありません: ${path}`);
  return value;
}

async function main(): Promise<void> {
  const manifestPath = join(WORKSPACE, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readCanonicalJson<unknown>(manifestPath));
  if (!checked.ok || checked.value.status !== 'accepted' ||
    checked.value.workProgress.some((work) => work.status !== 'accepted')) {
    throw new Error('F005全作品がacceptedではありません');
  }
  const manifest = checked.value;

  const context = await loadVerifiedF005Definition(WORKSPACE);
  const snapshot = await rehydrateF005SelectionSnapshot(WORKSPACE, context);

  const outDirectory = join(WORKSPACE, 'content', 'batches', BATCH_ID, 'public-files', 'provenance');
  const before = new Set(
    (await readdir(outDirectory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  for (const workId of manifest.workIds as readonly F005WorkId[]) {
    const workSnapshot = snapshot.works.find((work) => work.workId === workId);
    if (!workSnapshot) throw new Error(`selection snapshotに${workId}がありません`);
    const source = parseF005SourceRecord(workSnapshot, workId);
    const provenanceValue = buildF005SourceProvenance(source, snapshot);
    const target = join(outDirectory, `${workId}.json`);
    await writeJsonArtifactAtomic(WORKSPACE, target, provenanceValue);
    console.log(`書込み完了: content/batches/${BATCH_ID}/public-files/provenance/${workId}.json`);
    before.delete(`${workId}.json`);
  }
  if (before.size > 0) {
    console.warn(`警告: manifest.workIdsに存在しない既存evidenceファイルが残っています: ${[...before].join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
