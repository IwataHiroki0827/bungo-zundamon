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
const workId = '045679';
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

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f004-acceptance-'));
  for (const path of paths) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(sourceRoot, ...path.split('/'))));
  }
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
    const prepared = await prepareF004WorkAcceptance(
      sourceRoot,
      'content/batches/F004/batch.json',
      workId,
    );
    expect(prepared).toMatchObject({
      __brand: 'PreparedF004WorkAcceptance',
      batchId: 'F004',
      workId,
    });

    await expect(prepareF004WorkAcceptance(
      sourceRoot,
      'content/batches/F004/batch.json',
      '001918',
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
    const prepared = await prepareF004WorkAcceptance(
      sourceRoot,
      'content/batches/F004/batch.json',
      workId,
    );
    const forged = { ...prepared };
    const promote = vi.fn();
    await expect(acceptF004Work(
      sourceRoot,
      forged,
      forged.expectedManifestSha,
      {},
      { promote: promote as never },
    )).rejects.toMatchObject({ code: 'F004_ACCEPTANCE_PREPARED_UNTRUSTED' });
    expect(promote).not.toHaveBeenCalled();
  });

  /** @fun FUN-F004-019 @fun FUN-F004-020 @ut UT-F004-019 @ut UT-F004-020 */
  it('fault後に同じprepared/manifest tupleでrecoveryを再開する', async () => {
    const prepared = await prepareF004WorkAcceptance(
      sourceRoot,
      'content/batches/F004/batch.json',
      workId,
    );
    const journal = JSON.parse(await readFile(
      join(sourceRoot, '.cache', 'transactions', 'accepted-audio', `F004-${workId}.json`),
      'utf8',
    )) as { evidence: WorkAcceptanceEvidence };
    const fault = vi.fn(async () => {
      throw new Error('injected after prepared');
    });
    await expect(acceptF004Work(
      sourceRoot,
      prepared,
      prepared.expectedManifestSha,
      {},
      { promote: fault as never },
    )).rejects.toThrow('injected after prepared');

    const resume = vi.fn(async () => journal.evidence);
    const recovered = await recoverF004WorkAcceptance(
      sourceRoot,
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
