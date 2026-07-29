import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactWriteError,
  canonicalJson,
  ensureJsonArtifactDurable,
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

  it('temp fsync→rename→native directory flush→post-readのdurability順を固定する', async () => {
    const root = await workspace();
    const target = join(root, 'data', 'durable.json');
    const phases: string[] = [];
    await writeJsonArtifactAtomic(root, target, { durable: true }, {
      directorySync: (workspaceRoot, directory) => {
        expect(workspaceRoot).toBe(root);
        expect(directory).toBe(join(root, 'data'));
        phases.push('native-directory-flush');
      },
      expectedFingerprint: null,
      onDurabilityPhase: (phase) => { phases.push(phase); },
    });
    expect(phases).toEqual([
      'temporary-synced',
      'renamed',
      'native-directory-flush',
      'directory-synced',
      'post-read-verified',
    ]);
    expect(await readFile(target, 'utf8')).toBe(canonicalJson({ durable: true }));
  });

  it('rename前faultはtargetを残さず、rename後faultは同一bytesのdurabilityを再確立できる', async () => {
    const root = await workspace();
    const beforeRename = join(root, 'data', 'before.json');
    await expect(writeJsonArtifactAtomic(root, beforeRename, { state: 'before' }, {
      expectedFingerprint: null,
      onDurabilityPhase: (phase) => {
        if (phase === 'temporary-synced') throw new Error('fault-before-rename');
      },
    })).rejects.toThrow(/fault-before-rename/u);
    expect(await readdir(join(root, 'data'))).toEqual([]);

    const afterRename = join(root, 'data', 'after.json');
    const bytes = canonicalJson({ state: 'after' });
    await expect(writeJsonArtifactAtomic(root, afterRename, { state: 'after' }, {
      expectedFingerprint: null,
      onDurabilityPhase: (phase) => {
        if (phase === 'renamed') throw new Error('fault-after-rename');
      },
    })).rejects.toThrow(/fault-after-rename/u);
    expect(await readFile(afterRename, 'utf8')).toBe(bytes);
    await expect(ensureJsonArtifactDurable(root, afterRename, bytes)).resolves.toBeUndefined();
    await expect(ensureJsonArtifactDurable(root, afterRename, canonicalJson({ state: 'tampered' })))
      .rejects.toEqual(expect.objectContaining<Partial<ArtifactWriteError>>({ code: 'ARTIFACT_CONFLICT' }));
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
