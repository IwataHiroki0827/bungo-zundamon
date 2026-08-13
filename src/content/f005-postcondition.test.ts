import { mkdtemp, mkdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  F005PostconditionError,
  foldF005Declarations,
  scanF005Workspace,
  verifyF005Postconditions,
  type F005DeclaredMutation,
  type F005ScanEntry,
  type F005Snapshot,
} from './f005-postcondition.ts';
import type { Sha256 } from './batch.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (path) => rm(path, { recursive: true, force: true }),
  ));
});

function sha(value: string): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function entry(value: string): F005ScanEntry {
  return { bytes: Buffer.byteLength(value), sha256: sha(value), identity: '1:1' };
}

function snapshot(items: Record<string, string>): F005Snapshot {
  return new Map(Object.entries(items).map(([path, value]) => [path, entry(value)]));
}

function create(sequence: number, path: string, value: string): F005DeclaredMutation {
  return {
    sequence,
    kind: 'create',
    path,
    targetPath: null,
    sha256: sha(value),
    bytes: Buffer.byteLength(value),
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-f005-postcondition-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'content'), { recursive: true });
  return root;
}

describe('F005事後検証 [CHG-F005-072][DES-F005-006][DES-F005-012][FUN-F005-047][UT-F005-047]', () => {
  it('宣言どおりの差分だけならPASSする', () => {
    const baseline = snapshot({ 'content/a.txt': 'a' });
    const actual = snapshot({ 'content/a.txt': 'a', 'content/b.wav': 'b' });
    expect(() => verifyF005Postconditions(
      baseline, actual, [create(1, 'content/b.wav', 'b')],
    )).not.toThrow();
  });

  it('宣言のない新規ファイルを件数付きで拒否する', () => {
    const baseline = snapshot({});
    const actual = snapshot({ 'content/x': 'x', 'content/y': 'y' });
    expect(() => verifyF005Postconditions(baseline, actual, []))
      .toThrow(expect.objectContaining({
        code: 'F005_POSTCONDITION_UNDECLARED_CREATE',
        count: 2,
      }));
  });

  it('宣言のない既存ファイルの改変を拒否する', () => {
    const baseline = snapshot({ 'content/a': 'a' });
    const actual = snapshot({ 'content/a': 'tampered' });
    expect(() => verifyF005Postconditions(baseline, actual, []))
      .toThrow(expect.objectContaining({
        code: 'F005_POSTCONDITION_UNDECLARED_MODIFY',
        count: 1,
      }));
  });

  it('宣言のない削除を拒否する', () => {
    const baseline = snapshot({ 'content/a': 'a' });
    expect(() => verifyF005Postconditions(baseline, snapshot({}), []))
      .toThrow(expect.objectContaining({
        code: 'F005_POSTCONDITION_UNDECLARED_DELETE',
        count: 1,
      }));
  });

  it('宣言したのに存在しないファイルを拒否する', () => {
    expect(() => verifyF005Postconditions(
      snapshot({}), snapshot({}), [create(1, 'content/b', 'b')],
    )).toThrow(expect.objectContaining({
      code: 'F005_POSTCONDITION_DECLARED_MISSING',
      count: 1,
    }));
  });

  it('宣言と内容が違うファイルを拒否する', () => {
    expect(() => verifyF005Postconditions(
      snapshot({}), snapshot({ 'content/b': 'different' }),
      [create(1, 'content/b', 'b')],
    )).toThrow(expect.objectContaining({
      code: 'F005_POSTCONDITION_CONTENT_MISMATCH',
      count: 1,
    }));
  });

  it('rename宣言をsequence順に畳み込む', () => {
    const baseline = snapshot({ 'content/tmp': 'v' });
    const actual = snapshot({ 'content/final': 'v' });
    expect(() => verifyF005Postconditions(baseline, actual, [{
      sequence: 1,
      kind: 'rename',
      path: 'content/tmp',
      targetPath: 'content/final',
      sha256: sha('v'),
      bytes: 1,
    }])).not.toThrow();
  });

  it('delete宣言を畳み込む', () => {
    expect(() => verifyF005Postconditions(
      snapshot({ 'content/a': 'a' }), snapshot({}),
      [{ sequence: 1, kind: 'delete', path: 'content/a', targetPath: null, sha256: null, bytes: 0 }],
    )).not.toThrow();
  });

  it('sequence不連続・不正noticeを拒否する', () => {
    expect(() => foldF005Declarations(snapshot({}), [create(2, 'content/a', 'a')]))
      .toThrow(expect.objectContaining({ code: 'F005_POSTCONDITION_NOTICE_SEQUENCE' }));
    expect(() => foldF005Declarations(snapshot({}), [
      { ...create(1, 'content/a', 'a'), sha256: null },
    ])).toThrow(expect.objectContaining({ code: 'F005_POSTCONDITION_NOTICE_INVALID' }));
    expect(() => foldF005Declarations(snapshot({}), [
      { ...create(1, 'content\\a', 'a') },
    ])).toThrow(expect.objectContaining({ code: 'F005_POSTCONDITION_NOTICE_INVALID' }));
  });

  it('実ファイルを再帰走査してworkspace相対POSIX pathで返す', async () => {
    const root = await workspace();
    await mkdir(join(root, 'content', 'nested'), { recursive: true });
    await writeFile(join(root, 'content', 'a.txt'), 'a', 'utf8');
    await writeFile(join(root, 'content', 'nested', 'b.txt'), 'b', 'utf8');
    const scanned = await scanF005Workspace(root, ['content']);
    expect([...scanned.keys()].sort()).toEqual([
      'content/a.txt',
      'content/nested/b.txt',
    ]);
    expect(scanned.get('content/a.txt')).toMatchObject({ bytes: 1, sha256: sha('a') });
  });

  it('存在しないrootは空として扱う', async () => {
    const root = await workspace();
    const scanned = await scanF005Workspace(root, ['data', 'public']);
    expect(scanned.size).toBe(0);
  });

  it('reparse pointを件数付きで拒否する', async () => {
    const root = await workspace();
    await writeFile(join(root, 'content', 'real.txt'), 'r', 'utf8');
    try {
      await symlink(join(root, 'content', 'real.txt'), join(root, 'content', 'link.txt'));
    } catch {
      return; // 権限がない環境ではskip相当
    }
    await expect(scanF005Workspace(root, ['content']))
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_REPARSE_POINT', count: 1 });
  });

  it('hardlinkを件数付きで拒否する', async () => {
    const root = await workspace();
    await writeFile(join(root, 'content', 'real.txt'), 'r', 'utf8');
    try {
      await link(join(root, 'content', 'real.txt'), join(root, 'content', 'hard.txt'));
    } catch {
      return;
    }
    await expect(scanF005Workspace(root, ['content']))
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_HARDLINK' });
  });

  it('実走査とverifyを結合して宣言外書込みを検出する', async () => {
    const root = await workspace();
    await writeFile(join(root, 'content', 'a.txt'), 'a', 'utf8');
    const baseline = await scanF005Workspace(root, ['content']);
    await writeFile(join(root, 'content', 'declared.wav'), 'd', 'utf8');
    await writeFile(join(root, 'content', 'sneaky.txt'), 's', 'utf8');
    const actual = await scanF005Workspace(root, ['content']);
    expect(() => verifyF005Postconditions(
      baseline, actual, [create(1, 'content/declared.wav', 'd')],
    )).toThrow(F005PostconditionError);
  });
});
