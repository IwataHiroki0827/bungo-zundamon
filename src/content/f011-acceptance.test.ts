import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { hashBatchManifest, validateBatchManifest, type WorkId } from './batch.ts';
import {
  acceptF011Work,
  F011AcceptanceError,
  prepareF011WorkAcceptance,
  recoverF011WorkAcceptance,
} from './f011-acceptance.ts';

/**
 * UT-F011-010: F011 work単位atomic受入。src/content/f010-acceptance.test.tsの
 * F011向けパラメータ化複製（skip()付きfixtureパターンを踏襲）。
 *
 * F011の3作品（手袋を買いに000637・ごん狐000628・二ひきの蛙004718）は
 * 全てaccepted済みである。assertOrderは対象workIdより後続のworkがaccepted
 * であることを許さないため、manifest末尾（最後にaccept遷移した）work IDの
 * みが再検証対象になり得る（F006〜F010と同型の制約）。
 *
 * mint保護・work順・path allowlist・workId形式の4ケースは、accepted work
 * artifactを必要とせず実workspace（content/batches/F011/batch.json、
 * 3作品ともmanifestに存在しworkIds順を持つ）だけで実行可能なため、
 * mock無しで実際に検証する。
 * @des DES-F011-009 @fun FUN-F011-010 @ut UT-F011-010
 */

const workspace = resolve(process.cwd());
const MANIFEST_PATH = 'content/batches/F011/batch.json';
// F011の3作品は全てaccepted済みのため、work順違反(F011_WORK_ORDER)なく
// 再検証できるのはmanifest末尾（最後にaccept遷移した）work IDのみ。
const TARGET_WORK_ID = '004718' as WorkId;
// manifestに存在しないwork IDでのwork順違反（F011_WORK_ORDER）は、
// accepted work artifactを必要とせず常に再現できる。
const UNKNOWN_WORK_ID = '999999' as WorkId;

/**
 * capacity-actual/content-preview等、accept前提の永続canonical artifactが
 * まだ生成されていないことを示す（先行工程未完了時の保険）。
 * このケースはこのテスト自身では再現不能なため、呼出元でtestをskipする。
 */
class ArtifactsMissingError extends Error {
  constructor(public readonly missingPath: string) {
    super(`accept前提artifactがまだ存在しません: ${missingPath}`);
  }
}

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
 * `.cache/batch-accept/F011/{id}`配下4ファイル（gitignore対象・非committed）と
 * `.cache/transactions/accepted-audio/F011-{id}.json`（journal、同じくgitignore
 * 対象）を、実workspaceのcanonical artifactから導出できる値だけを用いて
 * 一時workspace内へ新規構築する。src/content/f010-acceptance.test.tsの
 * `buildCacheFixtures`と同一構造の複製。
 * @des DES-F011-009 @fun FUN-F011-010
 */
async function buildCacheFixtures(root: string): Promise<void> {
  const id = TARGET_WORK_ID;
  const actualPath = `content/batches/F011/capacity-actual/${id}.json`;
  const manifestPath = MANIFEST_PATH;
  let actual: Record<string, unknown>;
  try {
    actual = await readJson(root, actualPath);
  } catch {
    throw new ArtifactsMissingError(resolve(workspace, ...actualPath.split('/')));
  }
  const previousBuildSha = String(actual.contentBuildSha256);
  const distSha256 = String(actual.distSha256);

  const stageRoot = join(root, '.cache', 'fixture-preview');
  await mkdir(stageRoot, { recursive: true });
  const fixtureBytes = new TextEncoder().encode('F011 acceptance fixture\n');
  await writeFile(join(stageRoot, 'fixture.txt'), fixtureBytes);
  const fixtureFile = { bytes: fixtureBytes.byteLength, path: 'fixture.txt', sha256: sha256(fixtureBytes) };
  const digest = createHash('sha256')
    .update(fixtureFile.path).update('\0')
    .update(String(fixtureFile.bytes)).update('\0')
    .update(fixtureBytes)
    .digest('hex');

  await writeJson(root, `.cache/batch-accept/F011/${id}/content-preview.json`, {
    activeBatchId: 'F011',
    activeWorkId: id,
    buildSha256: digest,
    files: [fixtureFile],
    mode: 'work-preview',
    stagingRoot: stageRoot,
  });
  await writeJson(root, `.cache/batch-accept/F011/${id}/dist-preview.json`, {
    batchId: 'F011',
    contentBuildSha256: digest,
    distSha256,
    workId: id,
  });
  await writeJson(root, `.cache/batch-accept/F011/${id}/f001-content-invariant.json`, {
    baselineSha256: 'a'.repeat(64),
    buildSha256: digest,
    result: 'pass',
    stagingSha256: digest,
  });
  await writeJson(root, `.cache/batch-accept/F011/${id}/f001-dist-invariant.json`, {
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
  // 新buildSha256へ置換する（prepareF011WorkAcceptanceが
  // capacityEvidence.inputHashes.includes(preview.buildSha256)を要求するため）。
  const manifest = await readJson(root, manifestPath);
  const workProgress = manifest.workProgress as Array<Record<string, unknown>>;
  const progress = workProgress.find((item) => item.workId === id);
  const stageRecords = progress?.stageRecords as Array<Record<string, unknown>> | undefined;
  const capacityStage = stageRecords?.findLast((item) => item.stage === 'capacity-actual');
  if (!capacityStage) throw new ArtifactsMissingError(`${manifestPath}#workProgress[${id}].stageRecords[capacity-actual]`);
  capacityStage.inputHashes = (capacityStage.inputHashes as string[])
    .map((hash) => (hash === previousBuildSha ? digest : hash));
  await writeJson(root, manifestPath, manifest);

  // journal（`.cache/transactions/accepted-audio/F011-{id}.json`）。既にaccepted済み
  // workのみ再現可能（f010版と同型の既知パターン）。
  const sourceJournalPath = resolve(workspace, '.cache', 'transactions', 'accepted-audio', `F011-${id}.json`);
  let evidence: Record<string, unknown>;
  try {
    evidence = (JSON.parse(await readFile(sourceJournalPath, 'utf8')) as { evidence: Record<string, unknown> }).evidence;
  } catch {
    throw new ArtifactsMissingError(sourceJournalPath);
  }
  const rewrittenManifestText = await readFile(join(root, ...manifestPath.split('/')), 'utf8');
  const checkedManifest = validateBatchManifest(JSON.parse(rewrittenManifestText) as unknown);
  if (!checkedManifest.ok) throw new Error('fixture manifestがinvalidです');
  await writeJson(root, `.cache/transactions/accepted-audio/F011-${id}.json`, {
    batchId: 'F011',
    evidence,
    lockToken: randomUUID(),
    nextManifestSha256: hashBatchManifest(checkedManifest.value),
    phase: 'verified',
    schemaVersion: '1.0.0',
    staging: `content/batches/F011/.accepted-audio-staging-${randomUUID()}-${id}`,
    target: `content/batches/F011/accepted-audio/${id}`,
    workId: id,
  });
}

/**
 * 一時workspaceへ、prepareF011WorkAcceptance/acceptF011Workが読む
 * canonical artifact（batch.json・voice-evidence・work-artifacts・
 * capacity-actual・accepted-audio）を複製し、gitignore対象の`.cache`
 * fixtureを追加構築する。
 * @des DES-F011-009 @fun FUN-F011-010
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f011-acceptance-'));
  const id = TARGET_WORK_ID;
  const paths = [
    MANIFEST_PATH,
    `content/batches/F011/voice-evidence/${id}.json`,
    `content/batches/F011/work-artifacts/${id}/voice-generation.json`,
    `content/batches/F011/work-artifacts/${id}/voice-completeness.json`,
    `content/batches/F011/capacity-actual/${id}.json`,
  ] as const;
  for (const path of paths) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, await readFile(join(workspace, ...path.split('/'))));
    } catch {
      throw new ArtifactsMissingError(resolve(workspace, ...path.split('/')));
    }
  }
  // acceptedTree検証(postTreeDigest照合)はbatch全体のaccepted-audioを対象にする。
  await cp(
    join(workspace, 'content', 'batches', 'F011', 'accepted-audio'),
    join(root, 'content', 'batches', 'F011', 'accepted-audio'),
    { recursive: true },
  ).catch(() => undefined);
  await buildCacheFixtures(root);
  return root;
}

describe('f011-acceptance', () => {
  it('永続化済みcanonical artifactからprepareし、accepted workをbrandedに再検証できる', async ({ skip }) => {
    let root: string;
    try {
      root = await fixture();
    } catch (error) {
      if (error instanceof ArtifactsMissingError) {
        skip(`accept前提artifact未生成のためskip: ${error.missingPath}`);
        return;
      }
      throw error;
    }
    const manifestText = await readFile(resolve(root, ...MANIFEST_PATH.split('/')), 'utf8');
    const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.workProgress[checked.value.workIds.indexOf(TARGET_WORK_ID)]?.status).toBe('accepted');

    const prepared = await prepareF011WorkAcceptance(root, MANIFEST_PATH, TARGET_WORK_ID);
    expect(prepared.batchId).toBe('F011');
    expect(prepared.workId).toBe(TARGET_WORK_ID);
    expect(prepared.actual.result === 'pass' || prepared.actual.result === 'pass_with_warning').toBe(true);
    expect(prepared.contentInvariant.result).toBe('pass');
    expect(prepared.distInvariant.result).toBe('pass');

    const expectedManifestSha = hashBatchManifest(checked.value);
    const result = await acceptF011Work(root, prepared, expectedManifestSha);
    expect(result.evidence.kind).toBe('accepted');
    expect(result.manifest.workProgress[result.manifest.workIds.indexOf(TARGET_WORK_ID)]?.status).toBe('accepted');

    // 同一tupleでの再開（journal verifiedからの冪等再検証）も成功する。
    const recovered = await recoverF011WorkAcceptance(root, prepared, expectedManifestSha);
    expect(recovered.evidence.kind).toBe('accepted');
  }, 30_000);

  it('mintされていないprepared値では受入を拒否する', async () => {
    const manifestText = await readFile(resolve(workspace, ...MANIFEST_PATH.split('/')), 'utf8');
    const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
    if (!checked.ok) throw new Error('fixture manifest invalid');
    const expectedManifestSha = hashBatchManifest(checked.value);
    const forged = {
      __brand: 'PreparedF011WorkAcceptance',
      batchId: 'F011',
      workId: TARGET_WORK_ID,
      manifestPath: MANIFEST_PATH,
      expectedManifestSha,
    } as unknown as Parameters<typeof acceptF011Work>[1];
    await expect(acceptF011Work(workspace, forged, expectedManifestSha)).rejects.toThrow(F011AcceptanceError);
  });

  it('manifestに存在しないwork IDはwork順違反として拒否する', async () => {
    await expect(prepareF011WorkAcceptance(workspace, MANIFEST_PATH, UNKNOWN_WORK_ID))
      .rejects.toMatchObject({ code: 'F011_WORK_ORDER' });
  });

  it('manifest pathがallowlist外なら拒否する', async () => {
    await expect(prepareF011WorkAcceptance(workspace, 'content/batches/F002/batch.json', TARGET_WORK_ID))
      .rejects.toMatchObject({ code: 'F011_ACCEPTANCE_PATH' });
  });

  it('workId形式が不正なら拒否する', async () => {
    await expect(prepareF011WorkAcceptance(workspace, MANIFEST_PATH, 'not-a-work-id'))
      .rejects.toMatchObject({ code: 'F011_ACCEPTANCE_PATH' });
  });
});
