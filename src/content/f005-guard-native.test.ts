import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  verifyF005NativeGuardBuildEvidence,
  type F005NativeGuardBuildEvidence,
} from './f005-source.ts';

const PROJECT_ROOT = resolve('.');
const NATIVE_ROOT = join(PROJECT_ROOT, 'native', 'f005-guard');
const GUARD_EXE = join(PROJECT_ROOT, '.cache', 'dotnet-f005', 'publish', 'f005-guard.exe');
const temporaryDirectories: string[] = [];

interface GuardReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

class GuardClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly replies: Array<(value: GuardReply) => void> = [];

  constructor() {
    this.process = spawn(GUARD_EXE, [], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      const resolveReply = this.replies.shift();
      if (resolveReply) resolveReply(JSON.parse(line) as GuardReply);
    });
  }

  command(value: Readonly<Record<string, unknown>>): Promise<GuardReply> {
    return new Promise((resolveReply, reject) => {
      this.replies.push(resolveReply);
      this.process.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) reject(error);
      });
    });
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    await new Promise<void>((resolveExit, reject) => {
      this.process.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`guard exit ${code}`)));
      this.process.once('error', reject);
    });
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

beforeAll(async () => {
  await expect(readFile(GUARD_EXE)).resolves.not.toHaveLength(0);
});

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('F005 native Windows handle guard', () => {
  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('SDK/runtime固定build evidenceを実sourceと70MiB self-contained binaryで検証する', async () => {
    const [evidenceRaw, program, project, globalJson, binary] = await Promise.all([
      readFile(join(NATIVE_ROOT, 'build-evidence.json'), 'utf8'),
      readFile(join(NATIVE_ROOT, 'Program.cs')),
      readFile(join(NATIVE_ROOT, 'F005Guard.csproj')),
      readFile(join(NATIVE_ROOT, 'global.json')),
      readFile(GUARD_EXE),
    ]);
    const evidence = JSON.parse(evidenceRaw) as F005NativeGuardBuildEvidence;
    expect(verifyF005NativeGuardBuildEvidence(evidence, {
      program,
      project,
      globalJson,
      apphost: binary,
      outputBinary: binary,
    })).toEqual(evidence);
    const tampered = new Uint8Array(binary);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => verifyF005NativeGuardBuildEvidence(evidence, {
      program,
      project,
      globalJson,
      apphost: binary,
      outputBinary: tampered,
    })).toThrowError(/binary pin/u);

    const client = new GuardClient();
    await expect(client.command({ op: 'hello' })).resolves.toMatchObject({
      ok: true,
      abi: 'f005-guard-jsonl-v1',
      rid: 'win-x64',
      runtimeVersion: '9.0.18',
    });
    await client.close();
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('open handleをprocess内保持してsource/parent swapを止め、同じhandleをread・renameする', async () => {
    const root = await temporaryRoot('f005-native-barrier-');
    await mkdir(join(root, 'content'));
    const source = join(root, 'content', 'source.txt');
    await writeFile(source, 'held-original');
    const client = new GuardClient();
    await expect(client.command({
      op: 'open',
      capabilityId: 'held',
      root,
      relativePath: 'content/source.txt',
    })).resolves.toMatchObject({ ok: true, bytes: 13 });

    await expect(rename(source, join(root, 'content', 'attacker.txt'))).rejects.toBeDefined();
    await expect(rename(join(root, 'content'), join(root, 'attacker-content'))).rejects.toBeDefined();
    const read = await client.command({ op: 'read', capabilityId: 'held' });
    expect(Buffer.from(String(read.bodyBase64), 'base64').toString('utf8')).toBe('held-original');
    await expect(client.command({
      op: 'rename',
      capabilityId: 'held',
      relativeTarget: 'content/renamed.txt',
    })).resolves.toMatchObject({ ok: true, relativePath: 'content/renamed.txt' });
    await expect(readFile(join(root, 'content', 'renamed.txt'), 'utf8')).resolves.toBe('held-original');
    await expect(client.command({ op: 'read', capabilityId: 'held' }))
      .resolves.toMatchObject({ ok: true, bytes: 13 });
    await client.command({ op: 'close', capabilityId: 'held' });
    await client.close();
    await expect(rename(
      join(root, 'content', 'renamed.txt'),
      join(root, 'content', 'after-close.txt'),
    )).resolves.toBeUndefined();
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('hardlink・junction/reparse・Windows危険pathをnative syscall境界で拒否する', async () => {
    const root = await temporaryRoot('f005-native-negative-');
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'file.txt'), 'data');
    await link(join(root, 'real', 'file.txt'), join(root, 'real', 'hardlink.txt'));
    await symlink(join(root, 'real'), join(root, 'junction'), 'junction');
    const client = new GuardClient();
    await expect(client.command({
      op: 'open', capabilityId: 'hard', root, relativePath: 'real/file.txt',
    })).resolves.toMatchObject({ ok: false, error: 'HARDLINK_REJECTED' });
    await expect(client.command({
      op: 'open', capabilityId: 'junction', root, relativePath: 'junction/file.txt',
    })).resolves.toMatchObject({ ok: false, error: 'REPARSE_REJECTED' });
    for (const [index, relativePath] of [
      '../outside', 'C:/outside', '//server/share', 'a\\b', 'file:ads', 'CON',
      'COM1.txt', 'LPT9', 'a/%2f/b', 'trailing.', 'trailing ', 'e\u0301.txt',
    ].entries()) {
      await expect(client.command({
        op: 'open',
        capabilityId: `bad-${index}`,
        root,
        relativePath,
      })).resolves.toMatchObject({ ok: false, error: 'PATH_INVALID' });
    }
    await client.close();
  });
});
