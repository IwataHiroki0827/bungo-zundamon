import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exitCodeForDiagnostic } from '../../scripts/content-cli.ts';
import { canonicalJson } from './artifacts.ts';

const execFile = promisify(execFileCallback);
const workspace = resolve('.');
const batchDirectory = join(workspace, 'content', 'batches', 'F998');

afterEach(async () => {
  await Promise.all([
    rm(batchDirectory, { recursive: true, force: true }),
    rm(join(workspace, '.cache', 'batch-review', 'F998'), { recursive: true, force: true }),
    rm(join(workspace, '.cache', 'batch-release', 'F998'), { recursive: true, force: true }),
  ]);
});

describe('content CLI exit code [DES-F001-017][DES-F001-019]', () => {
  it.each([
    ['bibliography', 2], ['select', 3], ['sources', 4], ['provenance', 5],
    ['decode', 6], ['extract', 7], ['normalize', 8],
  ])('PipelineRunError.diagnostic.stage=%sをexit codeへ変換する', (stage, expected) => {
    expect(exitCodeForDiagnostic({ stage, reasonCode: 'PIPELINE_STAGE_FAILED' })).toBe(expected);
  });

  it.each([null, {}, { stage: 'future' }, { stage: 1 }])('未知diagnosticはexit 1にする', (diagnostic) => {
    expect(exitCodeForDiagnostic(diagnostic)).toBe(1);
  });
});

describe('batch CLI production adapter [DES-F002-002][DES-F002-014][DES-F002-015]', () => {
  // @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 @test UT-F002-027
  it('実CLI processがallのmanual review gateをJSON厳密1行で返しmanifestを書き換えない', async () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const completedAt = '2026-07-20T00:00:00Z';
    const manifest = {
      batchId: 'F998',
      feature: 'F998',
      schemaVersion: '1.0.0',
      status: 'rights-verified',
      author: { authorId: '999998', name: '著者', originalName: '著者', slug: 'author-998', identitySha256: hashA },
      workIds: ['990001', '990002', '990003'],
      workProgress: [
        { workId: '990001', status: 'extracted', stageRecords: [{ stage: 'extracted', inputHashes: [hashA], outputHashes: [hashB], toolVersion: 'fixture/1.0.0', count: 1, completedAt }] },
        { workId: '990002', status: 'pending', stageRecords: [] },
        { workId: '990003', status: 'pending', stageRecords: [] },
      ],
      inputPaths: [],
      outputPaths: [],
      stageRecords: [{ stage: 'rights-verified', inputHashes: [hashA], outputHashes: [hashB], toolVersion: 'fixture/1.0.0', count: 1, completedAt }],
      rightsSnapshotIds: ['fixture-rights'],
      voiceConfigRef: 'content/batches/F998/voice-config.json',
      artworkProvenanceRef: 'content/batches/F998/artwork.json',
    };
    await mkdir(batchDirectory, { recursive: true });
    const target = join(batchDirectory, 'batch.json');
    const before = canonicalJson(manifest);
    await writeFile(target, before, 'utf8');
    const { stdout, stderr } = await execFile(process.execPath, [
      '--experimental-transform-types',
      join(workspace, 'scripts', 'content-cli.ts'),
      '--batch', 'F998', '--work', '990001', '--stage', 'all',
    ], { cwd: workspace, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    expect(stderr).toBe('');
    expect(stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(stdout.trim())).toMatchObject({ code: 0, status: 'awaiting_manual_gate', gate: 'review' });
    expect(await readFile(target, 'utf8')).toBe(before);
  });

  it('実CLIのvoice production handlerはunavailableへ逃げず欠落artifactでfail-closedに停止する', async () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const completedAt = '2026-07-20T00:00:00Z';
    const manifest = {
      batchId: 'F998',
      feature: 'F998',
      schemaVersion: '1.0.0',
      status: 'draft',
      author: { authorId: '999998', name: '著者', originalName: '著者', slug: 'author-998', identitySha256: hashA },
      workIds: ['990001', '990002', '990003'],
      workProgress: [
        {
          workId: '990001', status: 'budget-approved', forecastRef: 'content/batches/F998/capacity-forecast/990001.json',
          stageRecords: [
            { stage: 'reviewed', inputHashes: [hashA], outputHashes: [hashB], toolVersion: 'fixture/1.0.0', count: 1, completedAt },
            { stage: 'budget-approved', inputHashes: [hashB], outputHashes: [hashA], toolVersion: 'fixture/1.0.0', count: 1, completedAt },
          ],
        },
        { workId: '990002', status: 'pending', stageRecords: [] },
        { workId: '990003', status: 'pending', stageRecords: [] },
      ],
      inputPaths: [],
      outputPaths: [],
      stageRecords: [],
      rightsSnapshotIds: [],
      voiceConfigRef: 'content/batches/F998/voice-config.json',
      artworkProvenanceRef: 'content/batches/F998/artwork.json',
    };
    await mkdir(batchDirectory, { recursive: true });
    const target = join(batchDirectory, 'batch.json');
    const before = canonicalJson(manifest);
    await writeFile(target, before, 'utf8');

    const error = await execFile(process.execPath, [
      '--experimental-transform-types',
      join(workspace, 'scripts', 'content-cli.ts'),
      '--batch', 'F998', '--work', '990001', '--stage', 'voice',
    ], { cwd: workspace, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } }).catch((reason: unknown) => reason as {
      code: number; stdout: string; stderr: string;
    }) as { code: number; stdout: string; stderr: string };

    expect(error.code).toBe(6);
    expect(error.stdout).toBe('');
    expect(JSON.parse(error.stderr.trim())).toMatchObject({ code: 'BATCH_STAGE_PREREQUISITE', stage: 'voice' });
    expect(error.stderr).not.toContain('後続タスクで接続');
    expect(await readFile(target, 'utf8')).toBe(before);
  });
});
