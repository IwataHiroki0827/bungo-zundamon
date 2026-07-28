import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import { validateBatchManifest } from '../src/content/batch.ts';
import {
  observeF004Rights,
  observeF004RightsSelection,
} from '../src/content/f004-source.ts';
import {
  ProductionAozoraTransport,
  type BatchSelectionManifest,
} from '../src/content/source.ts';

const execFile = promisify(execFileCallback);
const EVIDENCE_PATH = 'docs/evidence/qt/QT-F004-rights-predeploy.json';
const CANDIDATE_PATH = '.cache/batch-release/F004/candidate-paths.json';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readCanonical<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [{ stdout: headRaw }, { stdout: status }, candidateArtifact, manifestArtifact] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8' }),
    readCanonical<{
      schemaVersion: '1.0.0';
      batchId: 'F004';
      sourceCommit: string;
      contentBuildSha256: string;
      distSha256: string;
    }>(workspace, CANDIDATE_PATH),
    readCanonical<BatchSelectionManifest>(workspace, 'content/batches/F004/batch.json'),
  ]);
  const head = headRaw.trim();
  if (status !== '') throw new Error('権利再確認にはclean worktreeが必要です');
  if (!/^[0-9a-f]{40}$/u.test(head) || candidateArtifact.value.sourceCommit !== head) {
    throw new Error('権利再確認のHEADとexact candidateが一致しません');
  }
  const checked = validateBatchManifest(manifestArtifact.value);
  if (!checked.ok || manifestArtifact.value.batchId !== 'F004' ||
    !Array.isArray(manifestArtifact.value.editionRules)) {
    throw new Error('F004 selection manifestが不正です');
  }

  const [context, selection] = await Promise.all([
    loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    ),
    observeF004RightsSelection(workspace),
  ]);
  const runId = `F004-predeploy-${head.slice(0, 12)}`;
  const observed = await observeF004Rights(
    context,
    manifestArtifact.value,
    'predeploy',
    {
      transport: new ProductionAozoraTransport(),
      clock: () => new Date(),
      selection: selection.observation,
      releaseCommit: head,
      runId,
    },
  );
  if (observed.phase !== 'predeploy' || observed.decision.result !== 'unchanged' ||
    observed.decision.releaseCommit !== head || observed.decision.runId !== runId ||
    observed.decision.reasons.length !== 0 || !observed.decision.predeploy) {
    throw new Error('F004 predeploy権利判定がunchangedではありません');
  }
  const evidence = {
    schemaVersion: '1.0.0',
    kind: 'f004-predeploy-rights-evidence',
    batchId: 'F004',
    result: 'pass',
    sourceCommit: head,
    runId,
    selectionArtifact: {
      path: 'content/batches/F004/rights-selection.json',
      sha256: selection.artifactSha256,
      bibliographySha256: selection.observation.bibliographySha256,
    },
    candidate: {
      contentBuildSha256: candidateArtifact.value.contentBuildSha256,
      distSha256: candidateArtifact.value.distSha256,
    },
    decision: observed.decision,
  } as const;
  await writeJsonArtifactAtomic(workspace, join(workspace, ...EVIDENCE_PATH.split('/')), evidence);
  process.stdout.write(canonicalJson({
    ok: true,
    path: EVIDENCE_PATH,
    sha256: sha256(canonicalJson(evidence)),
    sourceCommit: head,
    result: observed.decision.result,
    bibliographySha256: observed.decision.predeploy.bibliographySha256,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
