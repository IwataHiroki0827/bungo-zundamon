import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

import { canonicalJson } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest, type WorkId } from '../src/content/batch.ts';
import { acceptF008Work, prepareF008WorkAcceptance } from '../src/content/f008-acceptance.ts';

/**
 * F008 work単位atomic受入CLI。src/content/f008-acceptance.tsのprepare/accept
 * ラッパーをそのまま呼ぶだけの薄いentrypoint。
 * @des DES-F008-009 @fun FUN-F008-010
 */

const MANIFEST_PATH = 'content/batches/F008/batch.json';
const workIdArgument = process.argv[2];
if (!workIdArgument || !/^[0-9]{6}$/u.test(workIdArgument)) throw new Error('6桁のwork IDが必要です');

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const manifestText = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(workspace, ...MANIFEST_PATH.split('/')), 'utf8'));
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok) throw new Error(`F008 manifestが不正です: ${checked.error.code}`);
  const expectedManifestSha = hashBatchManifest(checked.value);

  const prepared = await prepareF008WorkAcceptance(workspace, MANIFEST_PATH, workIdArgument as WorkId);
  const result = await acceptF008Work(workspace, prepared, expectedManifestSha);
  process.stdout.write(canonicalJson({
    ok: true,
    workId: workIdArgument,
    status: result.manifest.workProgress[result.manifest.workIds.indexOf(workIdArgument as WorkId)]?.status,
    evidenceKind: result.evidence.kind,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
