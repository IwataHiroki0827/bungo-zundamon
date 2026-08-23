import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import { canonicalJson } from '../src/content/artifacts.ts';
import {
  collectF009SourceSnapshot,
  evaluateF009RightsAndUsage,
  persistF009SourceSnapshot,
} from '../src/content/f009-source.ts';
import { ProductionAozoraTransport } from '../src/content/source.ts';
import { ProductionPolicyTransport } from '../src/notices/policy-snapshots.ts';

/**
 * F009（夢野久作3作品追加）のselection段階原典・書誌・規約を実HTTPS取得し、
 * content/batches/F009/source-snapshots/selection.json + data/batches/F009/
 * source-snapshots/selection/配下へ永続化する。f008-collect-source.tsと
 * 同じ構成（native guard/ETW不使用）。
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
  const snapshot = await collectF009SourceSnapshot(
    new ProductionAozoraTransport(),
    context,
    'selection',
    () => new Date(),
    {
      policyTransport: new ProductionPolicyTransport(),
      trustedProjectRoot: workspace,
      workspace,
    },
  );
  const rights = evaluateF009RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  if (rights.decision !== 'allow') {
    throw new Error(`F009 rights/usageがblockedです: ${rights.reasons.join(',')}`);
  }
  const targetPath = await persistF009SourceSnapshot(workspace, snapshot);
  process.stdout.write(canonicalJson({
    ok: true,
    observedAt: snapshot.observedAt,
    rightsDecision: rights.decision,
    works: snapshot.works.map((work) => ({ workId: work.workId, title: work.title, xhtmlSha256: work.xhtml.sha256 })),
    targetPath,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
