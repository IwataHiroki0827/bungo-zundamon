import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelineRunError, UPDATE_STAGES, runContentUpdate, type UpdateStage } from './pipeline';

const HASH = 'a'.repeat(64);
const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-it-rollback-'));
  workspaces.push(root);
  await mkdir(join(root, 'content'), { recursive: true });
  await mkdir(join(root, 'public/content'), { recursive: true });
  await mkdir(join(root, 'public/audio/F001'), { recursive: true });
  await writeFile(join(root, 'content/provenance.json'), '{"release":"stable"}\n', 'utf8');
  await writeFile(join(root, 'public/content/catalog.json'), '{"release":"stable"}\n', 'utf8');
  await writeFile(join(root, 'public/audio/F001/stable.wav'), Buffer.from('RIFF-stable-audio'));
  return root;
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const logical = relative(root, path).replaceAll('\\', '/');
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\0${logical}\0`);
      if (entry.isDirectory()) await walk(path);
      else hash.update(await readFile(path));
    }
  };
  await walk(root);
  return hash.digest('hex');
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('更新失敗のロールバックと診断連鎖 [IT-F001-005]', () => {
  /** @des DES-F001-004 DES-F001-008 DES-F001-017 DES-F001-019 @test IT-F001-005 */
  it.each(UPDATE_STAGES)('%s致命失敗で後続停止・安定tree保護・秘密非露出・temp cleanupを満たす', async (faultStage) => {
    const root = await makeWorkspace();
    const stablePaths = ['content', 'public/content', 'public/audio'] as const;
    const before = await Promise.all(stablePaths.map((path) => treeHash(join(root, path))));
    const called: UpdateStage[] = [];

    let failure: unknown;
    try {
      await runContentUpdate({
        workspace: root,
        runner: async (stage, context) => {
          called.push(stage);
          const temporary = join(root, 'build', `.it-stage-${stage}`);
          context.registerTemporaryPath!(temporary);
          await mkdir(temporary, { recursive: true });
          await writeFile(join(temporary, 'partial.json'), '{"credential":"TOP-SECRET"}', 'utf8');
          if (stage === faultStage) {
            throw Object.assign(new Error('credential=TOP-SECRET'), {
              code: stage === 'sources' ? 'ETIMEDOUT' : 'EIO',
              response: { token: 'TOP-SECRET' },
            });
          }
          return { hash: HASH, count: 1 };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PipelineRunError);
    expect((failure as PipelineRunError).diagnostic.stage).toBe(faultStage);
    expect((failure as Error).message).not.toMatch(/TOP-SECRET|credential|token/i);
    expect(JSON.stringify(failure)).not.toMatch(/TOP-SECRET|credential|token/i);
    expect(called).toEqual(UPDATE_STAGES.slice(0, UPDATE_STAGES.indexOf(faultStage) + 1));
    await expect(lstat(join(root, 'build', `.it-stage-${faultStage}`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(Promise.all(stablePaths.map((path) => treeHash(join(root, path))))).resolves.toEqual(before);
  });

  /** @des DES-F001-008 DES-F001-017 DES-F001-019 @test IT-F001-005 */
  it('台詞単位voice失敗はbuildへ理由付きで渡し、文字artifactと成功cacheを維持する', async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, '.cache/voice/F001'), { recursive: true });
    await writeFile(join(root, '.cache/voice/F001/success.wav'), Buffer.from('cached-success'));
    await writeFile(join(root, 'content/reviewed-content.json'), '{"review":"stable"}\n', 'utf8');
    const preserved = await Promise.all([
      treeHash(join(root, '.cache/voice')),
      treeHash(join(root, 'content')),
    ]);
    const build = vi.fn();

    const summary = await runContentUpdate({
      workspace: root,
      stages: ['voice', 'build'],
      runner: async (stage, context) => {
        if (stage === 'voice') {
          return {
            hash: HASH,
            count: 1,
            voiceFailures: [{ audioId: 'failed-audio', candidateIds: ['candidate-1'], reasonCode: 'VOICE_TIMEOUT' }],
          };
        }
        build(context.voiceFailures);
        return { hash: HASH, count: 0 };
      },
    });

    expect(build).toHaveBeenCalledWith([
      { audioId: 'failed-audio', candidateIds: ['candidate-1'], reasonCode: 'VOICE_TIMEOUT' },
    ]);
    expect(summary.voiceFailures).toHaveLength(1);
    await expect(Promise.all([
      treeHash(join(root, '.cache/voice')),
      treeHash(join(root, 'content')),
    ])).resolves.toEqual(preserved);
  });

  /** @des DES-F001-017 DES-F001-019 @test IT-F001-005 */
  it.each([1, 2])('public tree swapのrename境界%d失敗で旧treeを復元しstagingを除去する', async (faultAt) => {
    const root = await makeWorkspace();
    const target = join(root, 'public');
    const staging = join(root, 'build/public-candidate');
    await mkdir(join(staging, 'content'), { recursive: true });
    await writeFile(join(staging, 'content/catalog.json'), '{"release":"candidate"}\n', 'utf8');
    const before = await treeHash(target);
    let renameCount = 0;

    await expect(runContentUpdate({
      workspace: root,
      stage: 'build',
      fileSystem: {
        lstat,
        realpath,
        rename: async (from, to) => {
          renameCount += 1;
          if (renameCount === faultAt) throw Object.assign(new Error('swap secret'), { code: 'EBUSY' });
          await rename(from, to);
        },
        rm: (path) => rm(path, { recursive: true, force: true }),
      },
      runner: () => ({
        hash: HASH,
        count: 1,
        publicTree: { stagingPath: staging, targetPath: target },
      }),
    })).rejects.toMatchObject({
      diagnostic: { stage: 'build', reasonCode: 'PIPELINE_FILESYSTEM_BUSY', retryable: true },
    });

    await expect(treeHash(target)).resolves.toBe(before);
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
