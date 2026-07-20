import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyF001BaselinePreflight } from './verify-project.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('verify-project F001 baseline preflight [DES-F002-003][DES-F002-006][DES-F002-016][FUN-F002-005]', () => {
  it('projectRootから絶対public/baselineを渡し、固定baseline実体を受理する', async () => {
    await expect(verifyF001BaselinePreflight(projectRoot)).resolves.toEqual({ ok: true, errors: [] });

    const calls = [];
    await expect(verifyF001BaselinePreflight(projectRoot, async (sourceRoot, baselinePath, rawCatalogPath) => {
      calls.push({ sourceRoot, baselinePath, rawCatalogPath });
    })).resolves.toEqual({ ok: true, errors: [] });
    expect(calls).toEqual([{
      sourceRoot: path.join(projectRoot, 'public'),
      baselinePath: path.join(projectRoot, 'content', 'baselines', 'F001-v0.1.0.json'),
      rawCatalogPath: path.join(projectRoot, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    }]);
    expect(path.isAbsolute(calls[0].sourceRoot)).toBe(true);
    expect(path.isAbsolute(calls[0].baselinePath)).toBe(true);
    expect(path.isAbsolute(calls[0].rawCatalogPath)).toBe(true);
  });

  it('改変baselineを安全な理由codeで停止する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'verify-baseline-'));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(path.join(root, 'public'), { recursive: true }),
      mkdir(path.join(root, 'content', 'baselines'), { recursive: true }),
    ]);
    const original = await readFile(
      path.join(projectRoot, 'content', 'baselines', 'F001-v0.1.0.json'),
      'utf8',
    );
    await writeFile(path.join(root, 'content', 'baselines', 'F001-v0.1.0.json'), `${original}\n`);

    await expect(verifyF001BaselinePreflight(root)).resolves.toEqual({
      ok: false,
      errors: ['F001_BASELINE_IDENTITY_INVALID'],
    });
  });

  it('未知例外からmessage・stack・payloadを公開せずgeneric codeへ変換する', async () => {
    const error = Object.assign(new Error('token=secret 未公開payload'), {
      code: 'INTERNAL_SECRET_FAILURE',
      stack: 'secret/internal/path',
    });
    const result = await verifyF001BaselinePreflight(projectRoot, async () => { throw error; });
    expect(result).toEqual({ ok: false, errors: ['F001_BASELINE_PREFLIGHT_FAILED'] });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('payload');
  });
});
