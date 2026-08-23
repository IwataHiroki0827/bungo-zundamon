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
  collectF010SourceSnapshot,
  evaluateF010RightsAndUsage,
  persistF010SourceSnapshot,
} from '../src/content/f010-source.ts';
import { ProductionAozoraTransport } from '../src/content/source.ts';
import { ProductionPolicyTransport } from '../src/notices/policy-snapshots.ts';

/**
 * F010（梶井基次郎3作品追加）のselection段階原典・書誌・規約を実HTTPS取得し、
 * content/batches/F010/source-snapshots/selection.json + data/batches/F010/
 * source-snapshots/selection/配下へ永続化する。f009-collect-source.tsと
 * 同じ構成（native guard/ETW不使用）。
 * @des DES-F010-004 @fun FUN-F010-005
 */
async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F010.ref,
    BATCH_DEFINITION_REFS.F010.sha256,
    APPROVAL_POLICY_REFS.F010.ref,
    APPROVAL_POLICY_REFS.F010.sha256,
  );
  const snapshot = await collectF010SourceSnapshot(
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
  const rights = evaluateF010RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  if (rights.decision !== 'allow') {
    throw new Error(`F010 rights/usageがblockedです: ${rights.reasons.join(',')}`);
  }
  const targetPath = await persistF010SourceSnapshot(workspace, snapshot);
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
