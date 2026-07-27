import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/content/artifacts.ts';
import {
  hashBatchManifest,
  transitionBatchState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  loadAndVerifyFixedF004Source,
  observeF004RightsSelection,
} from '../src/content/f004-source.ts';

const MANIFEST_PATH = 'content/batches/F004/batch.json' as WorkspaceRelativePath;
const RIGHTS_PATH = 'content/batches/F004/rights-selection.json' as WorkspaceRelativePath;
const SOURCE_INDEX_PATH = 'content/batches/F004/source-index.json' as WorkspaceRelativePath;

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [manifestArtifact, rightsArtifact, sourceIndexArtifact] = await Promise.all([
    canonicalArtifact<BatchManifest>(workspace, MANIFEST_PATH),
    canonicalArtifact<unknown>(workspace, RIGHTS_PATH),
    canonicalArtifact<unknown>(workspace, SOURCE_INDEX_PATH),
  ]);
  const checked = validateBatchManifest(manifestArtifact.value);
  if (!checked.ok) throw new Error(`F004 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  if (manifest.status === 'rights-verified' || manifest.status === 'sources-fixed') {
    process.stdout.write(canonicalJson({
      ok: true,
      resumed: true,
      status: manifest.status,
      manifestSha256: hashBatchManifest(manifest),
    }));
    return;
  }
  if (manifest.status !== 'draft' || manifest.stageRecords.length !== 0) {
    throw new Error(`rights進行前のmanifest状態が不正です: ${manifest.status}`);
  }
  const rights = await observeF004RightsSelection(workspace);
  const fixed = await Promise.all(manifest.workIds.map((workId) =>
    loadAndVerifyFixedF004Source(workspace, workId, rights)));
  const expectedManifestSha = hashBatchManifest(manifest);
  const completedAt = [...fixed].map((source) => source.work.fetchedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1)!;
  const evidence: StageEvidence = {
    kind: 'stage',
    expectedManifestSha,
    stage: 'rights-verified',
    inputHashes: [
      expectedManifestSha,
      sha256(rightsArtifact.text),
      sha256(sourceIndexArtifact.text),
    ],
    outputHashes: fixed.map((source) => source.sourceSha256 as Sha256),
    toolVersion: 'f004-fixed-source-rights/1.0.0',
    count: fixed.length,
    completedAt,
    result: 'pass',
  };
  const transitioned = transitionBatchState(manifest, 'rights-verified', evidence);
  const candidate = {
    ...transitioned,
    inputPaths: [...new Set([...transitioned.inputPaths, RIGHTS_PATH, SOURCE_INDEX_PATH])],
    outputPaths: [...new Set([...transitioned.outputPaths,
      ...fixed.flatMap((source) => [source.work.recordPath, source.work.rawPath])])],
    rightsSnapshotIds: [
      `aozora-selection:${rights.observation.bibliographySha256}`,
      ...fixed.map((source) => `fixed-source:${source.work.workId}:${source.work.rawSha256}`),
    ],
  };
  const next = validateBatchManifest(candidate);
  if (!next.ok) throw new Error(`rights遷移後manifestが不正です: ${next.error.code}`);
  const manifestSha256 = await writeBatchManifestAtomic(
    workspace,
    MANIFEST_PATH,
    next.value,
    expectedManifestSha,
  );
  process.stdout.write(canonicalJson({
    ok: true,
    status: next.value.status,
    manifestSha256,
    evidenceSha256: sha256(canonicalJson(evidence)),
    count: evidence.count,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
