import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeF005TemporaryFile } from './f005-postcondition-write.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (path) => rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-f005-pcwrite-'));
  temporaryDirectories.push(root);
  return root;
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

describe('F005事後検証の一時書込み [CHG-F005-072][DES-F005-006][FUN-F005-047][UT-F005-047]', () => {
  it('排他作成して読み戻し照合しrenameで最終pathへ移す', async () => {
    const root = await workspace();
    const temporary = join(root, '.tmp');
    const destination = join(root, 'a.wav');
    const lease = await writeF005TemporaryFile(temporary, WAV, sha(WAV));
    expect(lease.producerPid).toBe(process.pid);
    expect(lease.nativeIdentity).toMatch(/^[0-9a-f]{8}:[0-9a-f]{16}$/u);
    await lease.rename(destination);
    await lease.commit();
    expect(new Uint8Array(await readFile(destination))).toEqual(WAV);
  });

  it('digest不一致のbytesを書き込まずに拒否する', async () => {
    const root = await workspace();
    await expect(writeF005TemporaryFile(join(root, '.tmp'), WAV, sha(new Uint8Array([9]))))
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_WRITE_VERIFY_FAILED' });
  });

  it('既存pathへの上書きを拒否する', async () => {
    const root = await workspace();
    const temporary = join(root, '.tmp');
    await writeFile(temporary, 'existing', 'utf8');
    await expect(writeF005TemporaryFile(temporary, WAV, sha(WAV)))
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_WRITE_EXISTS' });
  });

  it('rename先が不正ならfail-closedする', async () => {
    const root = await workspace();
    const lease = await writeF005TemporaryFile(join(root, '.tmp'), WAV, sha(WAV));
    await expect(lease.rename(join(root, 'missing-dir', 'a.wav')))
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_WRITE_RENAME_FAILED' });
  });

  it('abortで一時ファイルを回収する', async () => {
    const root = await workspace();
    const temporary = join(root, '.tmp');
    const lease = await writeF005TemporaryFile(temporary, WAV, sha(WAV));
    await lease.abort();
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commit後のrename・commitを拒否する', async () => {
    const root = await workspace();
    const lease = await writeF005TemporaryFile(join(root, '.tmp'), WAV, sha(WAV));
    await lease.commit();
    await expect(lease.rename(join(root, 'b.wav')))
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_WRITE_SETTLED' });
    await expect(lease.commit())
      .rejects.toMatchObject({ code: 'F005_POSTCONDITION_WRITE_SETTLED' });
  });

  it('abort後のabortは無害で、commit済みは削除しない', async () => {
    const root = await workspace();
    const destination = join(root, 'a.wav');
    const lease = await writeF005TemporaryFile(join(root, '.tmp'), WAV, sha(WAV));
    await lease.rename(destination);
    await lease.commit();
    await lease.abort();
    expect(new Uint8Array(await readFile(destination))).toEqual(WAV);
  });
});
