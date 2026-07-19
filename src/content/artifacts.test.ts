import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactWriteError,
  fingerprintArtifact,
  writeJsonArtifactAtomic,
  writeJsonArtifactTreeAtomic,
} from './artifacts.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bungo-artifacts-'));
  temporaryDirectories.push(path);
  return path;
}

describe('production artifactのatomic writer [DES-F001-017][DES-F001-019]', () => {
  it('key順を固定したUTF-8 JSONへatomicに置換する', async () => {
    const root = await workspace();
    const target = join(root, 'data', 'record.json');
    await writeJsonArtifactAtomic(root, target, { z: 1, a: '本文' });
    expect(await readFile(target, 'utf8')).toBe('{\n  "a": "本文",\n  "z": 1\n}\n');
  });

  it('commit直前の競合を検出し、競合側のbytesを上書きしない', async () => {
    const root = await workspace();
    const target = join(root, 'data', 'record.json');
    await mkdir(join(root, 'data'));
    await writeFile(target, '{"owner":"original"}\n', 'utf8');
    const expectedFingerprint = await fingerprintArtifact(target);
    await expect(writeJsonArtifactAtomic(root, target, { owner: 'pipeline' }, {
      expectedFingerprint,
      beforeCommit: async () => writeFile(target, '{"owner":"modified"}\n', 'utf8'),
    })).rejects.toEqual(expect.objectContaining<Partial<ArtifactWriteError>>({ code: 'ARTIFACT_CONFLICT' }));
    expect(await readFile(target, 'utf8')).toBe('{"owner":"modified"}\n');
  });

  it('tree内のworkspace逸脱pathと重複pathを拒否する', async () => {
    const root = await workspace();
    await expect(writeJsonArtifactTreeAtomic(root, join(root, 'data'), [
      { path: '../outside.json', value: {} },
    ])).rejects.toEqual(expect.objectContaining<Partial<ArtifactWriteError>>({ code: 'ARTIFACT_INVALID_PATH' }));
    await expect(writeJsonArtifactTreeAtomic(root, join(root, 'data'), [
      { path: 'same.json', value: {} },
      { path: 'same.json', value: {} },
    ])).rejects.toEqual(expect.objectContaining<Partial<ArtifactWriteError>>({ code: 'ARTIFACT_INVALID_PATH' }));
  });
});
