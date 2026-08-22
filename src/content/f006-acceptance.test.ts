import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { hashBatchManifest, validateBatchManifest, type WorkId } from './batch.ts';
import {
  acceptF006Work,
  F006AcceptanceError,
  prepareF006WorkAcceptance,
  recoverF006WorkAcceptance,
} from './f006-acceptance.ts';

/**
 * IT-F006-006（完全, 山月記(000624)・名人伝(000621)・弟子(001738)全3作品分）:
 * F006 work単位atomic受入。実プロジェクトの永続化済みcanonical artifact
 * （T-151/T-152/T-153で3作品ともaccepted済み）を対象に、
 * prepareF006WorkAcceptance/acceptF006Work/recoverF006WorkAcceptanceが
 * mock無しの実データで冪等に動作すること、およびallowlist/work順違反を
 * 拒否することを検証する。T-153（弟子）完了により3作品全てがaccepted済みと
 * なったため、「work順違反」ケースはmanifestに存在しないworkId（未voiced/
 * 未accepted相当の代替）で再現する。
 *
 * 「prepareし、accepted workをbrandedに再検証できる」ケースは、work-preview
 * のstaging tree（965ファイル・数百MB、`.cache/`配下でgitignore対象かつ
 * ローカル開発でのみ偶然残存）に依存させず、CI(フレッシュcheckout)でも
 * 再現可能な自己完結fixtureを都度構築する。手法はf004-acceptance.test.ts
 * のfixture()/normalizePreviewFixture()パターンを踏襲する: 実際にgit管理
 * されているcanonical artifact（batch.json・capacity-actual・voice-evidence・
 * work-artifacts・accepted-audio）を一時workspaceへ複製し、gitignore対象の
 * `.cache/batch-accept`配下4ファイルだけをtest内で新規構築、work-preview
 * stagingを1ファイルの小さなfixture treeへ差し替えてbuildSha256を再計算する。
 * 再計算後のbuildSha256はcapacity-actual/batch.jsonのcapacity-actual
 * stage recordのinputHashesへも伝播させ、prepareF006WorkAcceptance自身の
 * tuple一致検証（preview/actual/invariant/manifest間の相互ハッシュ照合）を
 * 満たす。すでにaccepted済みworkはpromoteVerifiedWorkArtifacts側の
 * assertInputs（voiced限定）をスキップし、journal（`.cache/transactions/
 * accepted-audio/F006-{id}.json`、これもgitignore対象のためtest内で
 * 実際のevidence値を用いて再構築）のnextManifestSha256が現在のmanifest
 * hashと一致する限り副作用なく検証を通す。accepted-audioの実音声file
 * （55ファイル・約17MB、gitignore対象ではなくgit管理下）はそのまま複製し、
 * postTreeDigest照合を実データで満たす。
 * @des DES-F006-009 @fun FUN-F006-010 @ut UT-F006-010
 */

const workspace = resolve(process.cwd());
const MANIFEST_PATH = 'content/batches/F006/batch.json';
// assertOrderは対象workIdより後続のworkがacceptedであることを許さないため、
// 3作品全acceptedとなった今はmanifest末尾（最後にaccept遷移した）work IDのみが
// 再検証対象になり得る。
const ACCEPTED_WORK_ID = '001738' as WorkId;
// F006の3作品（000624/000621/001738）は全てaccepted済みのため、
// work順違反（F006_WORK_ORDER）はmanifestに存在しないwork IDで再現する
// （assertOrderはindex<0も同一エラーコードで拒否する）。
const UNKNOWN_WORK_ID = '999999' as WorkId;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(root: string, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ...path.split('/')), 'utf8')) as Record<string, unknown>;
}

async function writeJson(root: string, path: string, value: Record<string, unknown>): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(value), 'utf8');
}

/**
 * `.cache/batch-accept/F006/{id}`配下4ファイル（gitignore対象・非committed）と
 * `.cache/transactions/accepted-audio/F006-{id}.json`（journal、同じくgitignore
 * 対象）を、実workspaceのcanonical artifactから導出できる値だけを用いて
 * 一時workspace内へ新規構築する。
 * @des DES-F006-009 @fun FUN-F006-010
 */
async function buildCacheFixtures(root: string): Promise<void> {
  const id = ACCEPTED_WORK_ID;
  const actualPath = `content/batches/F006/capacity-actual/${id}.json`;
  const manifestPath = MANIFEST_PATH;
  const actual = await readJson(root, actualPath);
  const previousBuildSha = String(actual.contentBuildSha256);
  const distSha256 = String(actual.distSha256);

  const stageRoot = join(root, '.cache', 'fixture-preview');
  await mkdir(stageRoot, { recursive: true });
  const fixtureBytes = new TextEncoder().encode('F006 acceptance fixture\n');
  await writeFile(join(stageRoot, 'fixture.txt'), fixtureBytes);
  const fixtureFile = { bytes: fixtureBytes.byteLength, path: 'fixture.txt', sha256: sha256(fixtureBytes) };
  const digest = createHash('sha256')
    .update(fixtureFile.path).update('\0')
    .update(String(fixtureFile.bytes)).update('\0')
    .update(fixtureBytes)
    .digest('hex');

  await writeJson(root, `.cache/batch-accept/F006/${id}/content-preview.json`, {
    activeBatchId: 'F006',
    activeWorkId: id,
    buildSha256: digest,
    files: [fixtureFile],
    mode: 'work-preview',
    stagingRoot: stageRoot,
  });
  await writeJson(root, `.cache/batch-accept/F006/${id}/dist-preview.json`, {
    batchId: 'F006',
    contentBuildSha256: digest,
    distSha256,
    workId: id,
  });
  await writeJson(root, `.cache/batch-accept/F006/${id}/f001-content-invariant.json`, {
    baselineSha256: 'a'.repeat(64),
    buildSha256: digest,
    result: 'pass',
    stagingSha256: digest,
  });
  await writeJson(root, `.cache/batch-accept/F006/${id}/f001-dist-invariant.json`, {
    contentBuildSha256: digest,
    distSha256,
    result: 'pass',
  });

  // capacity-actualのcontentBuildSha256/contentStagingSha256を、
  // 差し替えたwork-preview buildSha256へ揃える。
  actual.contentBuildSha256 = digest;
  actual.contentStagingSha256 = digest;
  await writeJson(root, actualPath, actual);

  // manifestのcapacity-actual stage record inputHashesに含まれる旧buildSha256を
  // 新buildSha256へ置換する（prepareF006WorkAcceptanceが
  // capacityEvidence.inputHashes.includes(preview.buildSha256)を要求するため）。
  const manifest = await readJson(root, manifestPath);
  const workProgress = manifest.workProgress as Array<Record<string, unknown>>;
  const progress = workProgress.find((item) => item.workId === id);
  const stageRecords = progress?.stageRecords as Array<Record<string, unknown>> | undefined;
  const capacityStage = stageRecords?.findLast((item) => item.stage === 'capacity-actual');
  if (!capacityStage) throw new Error('fixture capacity-actual stageがありません');
  capacityStage.inputHashes = (capacityStage.inputHashes as string[])
    .map((hash) => (hash === previousBuildSha ? digest : hash));
  await writeJson(root, manifestPath, manifest);

  // journal（`.cache/transactions/accepted-audio/F006-{id}.json`）。
  // workは既にaccepted済みのため、promoteVerifiedWorkArtifactsはこのjournalの
  // evidenceをそのまま返す（accepted-audio treeのpostTreeDigest照合のみ実施）。
  // evidence自体は実際に確定したacceptedSources/preTreeDigest/postTreeDigestを
  // 使う必要があるため、実workspace（複製元）に残る実transaction journalから
  // 複製する。手元に存在しない場合（フレッシュcheckoutでの複製元不在）は
  // このテストをskipし、原因を明示する。
  const sourceJournalPath = resolve(process.cwd(), '.cache', 'transactions', 'accepted-audio', `F006-${id}.json`);
  let evidence: Record<string, unknown>;
  try {
    evidence = (JSON.parse(await readFile(sourceJournalPath, 'utf8')) as { evidence: Record<string, unknown> }).evidence;
  } catch {
    throw new Error(
      `journal fixtureの複製元がありません: ${sourceJournalPath}（accept-work scriptを再実行してください）`,
    );
  }
  const rewrittenManifestText = await readFile(join(root, ...manifestPath.split('/')), 'utf8');
  const checkedManifest = validateBatchManifest(JSON.parse(rewrittenManifestText) as unknown);
  if (!checkedManifest.ok) throw new Error('fixture manifestがinvalidです');
  await writeJson(root, `.cache/transactions/accepted-audio/F006-${id}.json`, {
    batchId: 'F006',
    evidence,
    lockToken: randomUUID(),
    nextManifestSha256: hashBatchManifest(checkedManifest.value),
    phase: 'verified',
    schemaVersion: '1.0.0',
    staging: `content/batches/F006/.accepted-audio-staging-${randomUUID()}-${id}`,
    target: `content/batches/F006/accepted-audio/${id}`,
    workId: id,
  });
}

/**
 * 一時workspaceへ、prepareF006WorkAcceptance/acceptF006Workが読む
 * canonical artifact（batch.json・voice-evidence・work-artifacts・
 * capacity-actual・accepted-audio）を複製し、gitignore対象の`.cache`
 * fixtureを追加構築する。
 * @des DES-F006-009 @fun FUN-F006-010
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f006-acceptance-'));
  const id = ACCEPTED_WORK_ID;
  const paths = [
    MANIFEST_PATH,
    `content/batches/F006/voice-evidence/${id}.json`,
    `content/batches/F006/work-artifacts/${id}/voice-generation.json`,
    `content/batches/F006/work-artifacts/${id}/voice-completeness.json`,
    `content/batches/F006/capacity-actual/${id}.json`,
  ] as const;
  for (const path of paths) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(workspace, ...path.split('/'))));
  }
  // acceptedTree検証(postTreeDigest照合)はbatch全体のaccepted-audioを対象にする。
  await cp(
    join(workspace, 'content', 'batches', 'F006', 'accepted-audio'),
    join(root, 'content', 'batches', 'F006', 'accepted-audio'),
    { recursive: true },
  );
  await buildCacheFixtures(root);
  return root;
}

describe('f006-acceptance', () => {
  it('永続化済みcanonical artifactからprepareし、accepted workをbrandedに再検証できる', async () => {
    const root = await fixture();
    const manifestText = await readFile(resolve(root, ...MANIFEST_PATH.split('/')), 'utf8');
    const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.workProgress[checked.value.workIds.indexOf(ACCEPTED_WORK_ID)]?.status).toBe('accepted');

    const prepared = await prepareF006WorkAcceptance(root, MANIFEST_PATH, ACCEPTED_WORK_ID);
    expect(prepared.batchId).toBe('F006');
    expect(prepared.workId).toBe(ACCEPTED_WORK_ID);
    expect(prepared.actual.result === 'pass' || prepared.actual.result === 'pass_with_warning').toBe(true);
    expect(prepared.contentInvariant.result).toBe('pass');
    expect(prepared.distInvariant.result).toBe('pass');

    const expectedManifestSha = hashBatchManifest(checked.value);
    const result = await acceptF006Work(root, prepared, expectedManifestSha);
    expect(result.evidence.kind).toBe('accepted');
    expect(result.manifest.workProgress[result.manifest.workIds.indexOf(ACCEPTED_WORK_ID)]?.status).toBe('accepted');

    // 同一tupleでの再開（journal verifiedからの冪等再検証）も成功する。
    const recovered = await recoverF006WorkAcceptance(root, prepared, expectedManifestSha);
    expect(recovered.evidence.kind).toBe('accepted');
  }, 30_000);

  it('mintされていないprepared値では受入を拒否する', async () => {
    const manifestText = await readFile(resolve(workspace, ...MANIFEST_PATH.split('/')), 'utf8');
    const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
    if (!checked.ok) throw new Error('fixture manifest invalid');
    const expectedManifestSha = hashBatchManifest(checked.value);
    const forged = {
      __brand: 'PreparedF006WorkAcceptance',
      batchId: 'F006',
      workId: ACCEPTED_WORK_ID,
      manifestPath: MANIFEST_PATH,
      expectedManifestSha,
    } as unknown as Parameters<typeof acceptF006Work>[1];
    await expect(acceptF006Work(workspace, forged, expectedManifestSha)).rejects.toThrow(F006AcceptanceError);
  });

  it('manifestに存在しないwork IDはwork順違反として拒否する', async () => {
    await expect(prepareF006WorkAcceptance(workspace, MANIFEST_PATH, UNKNOWN_WORK_ID))
      .rejects.toMatchObject({ code: 'F006_WORK_ORDER' });
  });

  it('manifest pathがallowlist外なら拒否する', async () => {
    await expect(prepareF006WorkAcceptance(workspace, 'content/batches/F002/batch.json', ACCEPTED_WORK_ID))
      .rejects.toMatchObject({ code: 'F006_ACCEPTANCE_PATH' });
  });

  it('workId形式が不正なら拒否する', async () => {
    await expect(prepareF006WorkAcceptance(workspace, MANIFEST_PATH, 'not-a-work-id'))
      .rejects.toMatchObject({ code: 'F006_ACCEPTANCE_PATH' });
  });
});
