import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

import { canonicalJson } from '../src/content/artifacts.ts';
import { hashBatchManifest, validateBatchManifest, type WorkId } from '../src/content/batch.ts';
import { acceptF011Work, prepareF011WorkAcceptance } from '../src/content/f011-acceptance.ts';

/**
 * F011 work単位atomic受入CLI。src/content/f011-acceptance.tsのprepare/accept
 * ラッパーをそのまま呼ぶだけの薄いentrypoint。
 * @des DES-F011-009 @fun FUN-F011-010
 */

const MANIFEST_PATH = 'content/batches/F011/batch.json';
const workIdArgument = process.argv[2];
if (!workIdArgument || !/^[0-9]{6}$/u.test(workIdArgument)) throw new Error('6桁のwork IDが必要です');

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const manifestText = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(workspace, ...MANIFEST_PATH.split('/')), 'utf8'));
  const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checked.ok) throw new Error(`F011 manifestが不正です: ${checked.error.code}`);
  const expectedManifestSha = hashBatchManifest(checked.value);

  const prepared = await prepareF011WorkAcceptance(workspace, MANIFEST_PATH, workIdArgument as WorkId);
  const result = await acceptF011Work(workspace, prepared, expectedManifestSha);
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
