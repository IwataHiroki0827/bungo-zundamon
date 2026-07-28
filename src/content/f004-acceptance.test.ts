import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkAcceptanceEvidence } from './batch-acceptance.ts';
import type { Sha256 } from './batch.ts';
import { canonicalJson } from './artifacts.ts';
import {
  acceptF004Work,
  prepareF004WorkAcceptance,
  recoverF004WorkAcceptance,
} from './f004-acceptance.ts';

const sourceRoot = resolve(process.cwd());
const cachedFixtureRoot = resolve(sourceRoot, 'tests/fixtures/f004-acceptance');
const publishedV030Commit = '79d12825b83459b92da58e14a32f853bae6d92d9';
const workId = '001918';
const paths = [
  'content/batches/F004/batch.json',
  `content/batches/F004/capacity-actual/${workId}.json`,
  `.cache/batch-accept/F004/${workId}/voice-generation.json`,
  `.cache/batch-accept/F004/${workId}/voice-completeness.json`,
  `.cache/batch-accept/F004/${workId}/content-preview.json`,
  `.cache/batch-accept/F004/${workId}/dist-preview.json`,
  `.cache/batch-accept/F004/${workId}/f001-content-invariant.json`,
  `.cache/batch-accept/F004/${workId}/published-content-invariant.json`,
  `.cache/batch-accept/F004/${workId}/f001-dist-invariant.json`,
  `content/batches/F004/work-artifacts/${workId}/review-reconciliation.json`,
  `content/batches/F004/work-artifacts/${workId}/speech-items.json`,
  `.cache/batch-review/F004/${workId}/review-result.json`,
  `content/batches/F004/candidate-safety/${workId}.json`,
  `content/batches/F004/capacity-forecast/${workId}.json`,
  `content/batches/F004/voice-evidence/${workId}.json`,
  'content/batches/F004/voice-config.json',
  'content/baselines/F004-v0.3.0.json',
  'public/content/catalog.json',
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function cachedFixturePath(path: string): string {
  if (!path.startsWith('.cache/')) throw new Error(`cache fixture pathが不正です: ${path}`);
  return join(cachedFixtureRoot, 'cache', ...path.slice('.cache/'.length).split('/'));
}

async function normalizePreviewFixture(root: string): Promise<void> {
  const previewPath = `.cache/batch-accept/F004/${workId}/content-preview.json`;
  const pagesPath = `.cache/batch-accept/F004/${workId}/dist-preview.json`;
  const actualPath = `content/batches/F004/capacity-actual/${workId}.json`;
  const contentInvariantPath = `.cache/batch-accept/F004/${workId}/f001-content-invariant.json`;
  const publishedInvariantPath = `.cache/batch-accept/F004/${workId}/published-content-invariant.json`;
  const distInvariantPath = `.cache/batch-accept/F004/${workId}/f001-dist-invariant.json`;
  const stageRoot = join(root, '.cache', 'fixture-preview');
  const fixtureBytes = new TextEncoder().encode('F004 acceptance fixture\n');
  const fixtureFile = {
    bytes: fixtureBytes.byteLength,
    path: 'fixture.txt',
    sha256: sha256(fixtureBytes),
  };
  const digest = createHash('sha256')
    .update(fixtureFile.path)
    .update('\0')
    .update(String(fixtureFile.bytes))
    .update('\0')
    .update(fixtureBytes)
    .digest('hex');
  await mkdir(stageRoot, { recursive: true });
  await writeFile(join(stageRoot, fixtureFile.path), fixtureBytes);

  const read = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(root, ...path.split('/')), 'utf8')) as Record<string, unknown>;
  const write = async (path: string, value: Record<string, unknown>): Promise<void> => {
    await writeFile(join(root, ...path.split('/')), canonicalJson(value), 'utf8');
  };
  const preview = await read(previewPath);
  const previousBuildSha = String(preview.buildSha256);
  preview.stagingRoot = stageRoot;
  preview.buildSha256 = digest;
  preview.files = [fixtureFile];
  await write(previewPath, preview);

  const pages = await read(pagesPath);
  pages.contentBuildSha256 = digest;
  await write(pagesPath, pages);

  const actual = await read(actualPath);
  const previousActualSha = sha256(canonicalJson(actual));
  actual.contentBuildSha256 = digest;
  actual.contentStagingSha256 = digest;
  await write(actualPath, actual);
  const actualSha = sha256(canonicalJson(actual));

  const contentInvariant = await read(contentInvariantPath);
  contentInvariant.buildSha256 = digest;
  contentInvariant.stagingSha256 = digest;
  await write(contentInvariantPath, contentInvariant);
  const publishedInvariant = await read(publishedInvariantPath);
  publishedInvariant.inputTreeSha256 = digest;
  publishedInvariant.actualTreeSha256 = digest;
  await write(publishedInvariantPath, publishedInvariant);
  const distInvariant = await read(distInvariantPath);
  distInvariant.contentBuildSha256 = digest;
  await write(distInvariantPath, distInvariant);

  const manifestPath = 'content/batches/F004/batch.json';
  const manifest = await read(manifestPath);
  const workProgress = manifest.workProgress as Array<Record<string, unknown>>;
  const progress = workProgress.find((item) => item.workId === workId);
  const stageRecords = progress?.stageRecords as Array<Record<string, unknown>> | undefined;
  const stage = stageRecords?.findLast((item) => item.stage === 'capacity-actual');
  if (!stage) throw new Error('fixture capacity stageがありません');
  stage.inputHashes = (stage.inputHashes as string[])
    .map((hash) => hash === previousBuildSha ? digest : hash);
  stage.outputHashes = (stage.outputHashes as string[])
    .map((hash) => hash === previousBuildSha ? digest : hash === previousActualSha ? actualSha : hash);
  await write(manifestPath, manifest);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f004-acceptance-'));
  for (const path of paths) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const bytes = path === 'public/content/catalog.json'
      ? execFileSync(
        'git',
        ['show', `${publishedV030Commit}:public/content/catalog.json`],
        { cwd: sourceRoot, maxBuffer: 16 * 1024 * 1024 },
      )
      : await readFile(path.startsWith('.cache/')
        ? cachedFixturePath(path)
        : join(sourceRoot, ...path.split('/')));
    await writeFile(target, bytes);
  }
  const transaction = `.cache/transactions/accepted-audio/F004-${workId}.json`;
  const transactionTarget = join(root, ...transaction.split('/'));
  await mkdir(dirname(transactionTarget), { recursive: true });
  await writeFile(
    transactionTarget,
    await readFile(cachedFixturePath(transaction)),
  );
  await normalizePreviewFixture(root);
  return root;
}

async function rewrite(root: string, path: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const target = join(root, ...path.split('/'));
  const value = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  mutate(value);
  await writeFile(target, canonicalJson(value), 'utf8');
}

describe('F004 acceptance facade [DES-F004-006]', () => {
  /** @fun FUN-F004-018 @ut UT-F004-018 */
  it('canonical allowlistだけからpreparedをmintし、order/preview差を拒否する', async () => {
    const valid = await fixture();
    const prepared = await prepareF004WorkAcceptance(
      valid,
      'content/batches/F004/batch.json',
      workId,
    );
    expect(prepared).toMatchObject({
      __brand: 'PreparedF004WorkAcceptance',
      batchId: 'F004',
      workId,
    });

    await expect(prepareF004WorkAcceptance(
      valid,
      'content/batches/F004/batch.json',
      '045679',
    )).rejects.toMatchObject({ code: 'F004_WORK_ORDER' });

    const mismatched = await fixture();
    await rewrite(
      mismatched,
      `.cache/batch-accept/F004/${workId}/content-preview.json`,
      (value) => { value.buildSha256 = 'f'.repeat(64); },
    );
    await expect(prepareF004WorkAcceptance(
      mismatched,
      'content/batches/F004/batch.json',
      workId,
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_PREVIEW_MISMATCH' });
  });

  /** @fun FUN-F004-018 @ut UT-F004-018 */
  it('原証跡の欠落・canonical差・schema/SHA/semantic差を拒否する', async () => {
    const missing = await fixture();
    await unlink(join(
      missing,
      'content', 'batches', 'F004', 'work-artifacts', workId, 'review-reconciliation.json',
    ));
    await expect(prepareF004WorkAcceptance(
      missing, 'content/batches/F004/batch.json', workId,
    )).rejects.toBeDefined();

    const oneByte = await fixture();
    const safetyPath = join(oneByte, 'content', 'batches', 'F004', 'candidate-safety', `${workId}.json`);
    await writeFile(safetyPath, `${await readFile(safetyPath, 'utf8')} `, 'utf8');
    await expect(prepareF004WorkAcceptance(
      oneByte, 'content/batches/F004/batch.json', workId,
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_ARTIFACT' });

    const semantic = await fixture();
    await rewrite(
      semantic,
      `content/batches/F004/work-artifacts/${workId}/speech-items.json`,
      (value) => {
        const first = (value as unknown as Array<Record<string, unknown>>)[0]!;
        first.speechText = `${String(first.speechText)}改変`;
      },
    );
    await expect(prepareF004WorkAcceptance(
      semantic, 'content/batches/F004/batch.json', workId,
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_PREVIEW_MISMATCH' });

    const forecastMismatch = await fixture();
    await rewrite(
      forecastMismatch,
      `content/batches/F004/capacity-forecast/${workId}.json`,
      (value) => {
        (value.plan as Record<string, unknown>).planDigest = 'f'.repeat(64);
      },
    );
    await expect(prepareF004WorkAcceptance(
      forecastMismatch, 'content/batches/F004/batch.json', workId,
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_PREVIEW_MISMATCH' });

    const baselineMismatch = await fixture();
    await rewrite(
      baselineMismatch,
      'public/content/catalog.json',
      (value) => { value.schemaVersion = 'forged'; },
    );
    await expect(prepareF004WorkAcceptance(
      baselineMismatch, 'content/batches/F004/batch.json', workId,
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_PREVIEW_MISMATCH' });
  });

  /** @fun FUN-F004-019 @ut UT-F004-019 */
  it('callerが自己申告したpreparedをatomic primitiveへ渡さない', async () => {
    const valid = await fixture();
    const prepared = await prepareF004WorkAcceptance(
      valid,
      'content/batches/F004/batch.json',
      workId,
    );
    const forged = { ...prepared };
    const promote = vi.fn();
    await expect(acceptF004Work(
      valid,
      forged,
      forged.expectedManifestSha,
      {},
      { promote: promote as never },
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_PREPARED_UNTRUSTED' });
    expect(promote).not.toHaveBeenCalled();
  });

  /** @fun FUN-F004-019 @fun FUN-F004-020 @ut UT-F004-019 @ut UT-F004-020 */
  it('fault後に同じprepared/manifest tupleでrecoveryを再開する', async () => {
    const valid = await fixture();
    const prepared = await prepareF004WorkAcceptance(
      valid,
      'content/batches/F004/batch.json',
      workId,
    );
    const journal = JSON.parse(await readFile(
      join(valid, '.cache', 'transactions', 'accepted-audio', `F004-${workId}.json`),
      'utf8',
    )) as { evidence: WorkAcceptanceEvidence };
    const fault = vi.fn(async () => {
      throw new Error('injected after prepared');
    });
    await expect(acceptF004Work(
      valid,
      prepared,
      prepared.expectedManifestSha,
      {},
      { promote: fault as never },
    )).rejects.toThrow('injected after prepared');

    const resume = vi.fn(async () => journal.evidence);
    const recovered = await recoverF004WorkAcceptance(
      valid,
      prepared,
      prepared.expectedManifestSha as Sha256,
      {},
      { promote: resume as never },
    );
    expect(fault).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(recovered.manifest.workProgress[0]?.status).toBe('accepted');
    expect(recovered.evidence.postTreeDigest).toBe(journal.evidence.postTreeDigest);
  });
});
