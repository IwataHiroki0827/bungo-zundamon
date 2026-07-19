import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PIPELINE_REASON_CODES,
  PipelineRunError,
  UPDATE_STAGES,
  mapPipelineError,
  runContentUpdate,
  writeProvenanceAtomic,
  type ProvenanceManifest,
  type UpdateStage,
} from './pipeline';

const workspaces: string[] = [];
const HASH = 'a'.repeat(64);

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'bungo-pipeline-'));
  workspaces.push(path);
  return path;
}

function manifest(): ProvenanceManifest {
  const bibliography = {
    sourceUrl: 'https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip',
    archiveSha256: 'b'.repeat(64),
    archiveBytes: 2_092_030,
    csvEntry: 'list_person_all_extended_utf8.csv',
    csvSha256: 'c'.repeat(64),
    csvBytes: 17_153_006,
    schemaVersion: 'schema-1',
  };
  return {
    schemaVersion: 1,
    bibliography,
    works: [
      { workId: '000127', bibliography },
      { workId: '000092', bibliography },
      { workId: '043015', bibliography },
    ],
    sourceHashes: { '000127': HASH, '000092': HASH, '043015': HASH },
    toolVersions: { extractor: '1.0.0' },
    generatedAt: '2026-07-18T00:00:00Z',
    transformations: ['charset decode', 'dialogue extraction'],
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('runContentUpdate [UT-F001-033]', () => {
  it('11 stageを固定順で実行しhashと件数を返す', async () => {
    const root = workspace();
    const called: UpdateStage[] = [];
    const summary = await runContentUpdate({
      workspace: root,
      runner: (stage) => {
        called.push(stage);
        return { hash: HASH, count: called.length };
      },
    });

    expect(called).toEqual(UPDATE_STAGES);
    expect(summary.stages).toHaveLength(11);
    expect(summary.hashes.build).toBe(HASH);
    expect(summary.counts.build).toBe(11);
  });

  it('単一stageを実行でき、voice失敗はbuildへ安全な除外情報として渡す', async () => {
    const root = workspace();
    const buildSpy = vi.fn();
    await runContentUpdate({
      workspace: root,
      stages: ['voice', 'build'],
      runner: (stage, context) => {
        if (stage === 'voice') {
          return {
            hash: HASH,
            count: 1,
            voiceFailures: [{ audioId: 'audio-1', candidateIds: ['candidate-1'], reasonCode: 'WAV_INVALID' }],
          };
        }
        buildSpy(context.voiceFailures);
        return { hash: HASH, count: 0 };
      },
    });
    expect(buildSpy).toHaveBeenCalledWith([
      { audioId: 'audio-1', candidateIds: ['candidate-1'], reasonCode: 'WAV_INVALID' },
    ]);
  });

  it('致命失敗後のstageを呼ばずworkspace外pathと未知stageを拒否する', async () => {
    const root = workspace();
    const runner = vi.fn((stage: UpdateStage) => {
      if (stage === 'sources') throw Object.assign(new Error('secret stack'), { code: 'ETIMEDOUT' });
      return { hash: HASH, count: 1 };
    });
    await expect(runContentUpdate({ workspace: root, runner })).rejects.toMatchObject({
      diagnostic: { stage: 'sources', reasonCode: 'PIPELINE_NETWORK_TIMEOUT', retryable: true },
    });
    expect(runner).toHaveBeenCalledTimes(3);

    await expect(runContentUpdate({
      workspace: root,
      inputPaths: [join(root, '..', 'outside.json')],
      runner,
    })).rejects.toBeInstanceOf(PipelineRunError);
    await expect(runContentUpdate({
      workspace: root,
      stages: ['not-a-stage' as UpdateStage],
      runner,
    })).rejects.toMatchObject({ diagnostic: { reasonCode: 'PIPELINE_UNSUPPORTED_STAGE' } });
  });

  it('公開treeをswapし、新tree rename失敗時は旧treeを復元する', async () => {
    const root = workspace();
    const target = join(root, 'public');
    const staging = join(root, '.staging');
    mkdirSync(target);
    mkdirSync(staging);
    writeFileSync(join(target, 'catalog.json'), 'old');
    writeFileSync(join(staging, 'catalog.json'), 'new');

    let renameCount = 0;
    const { lstat, realpath, rename, rm } = await import('node:fs/promises');
    await expect(runContentUpdate({
      workspace: root,
      stage: 'build',
      fileSystem: {
        lstat,
        realpath,
        rename: async (from, to) => {
          renameCount += 1;
          if (renameCount === 2) throw Object.assign(new Error('rename failed'), { code: 'EBUSY' });
          await rename(from, to);
        },
        rm: (path) => rm(path, { recursive: true, force: true }),
      },
      runner: () => ({
        hash: HASH,
        count: 1,
        publicTree: { stagingPath: staging, targetPath: target },
      }),
    })).rejects.toMatchObject({ diagnostic: { reasonCode: 'PIPELINE_FILESYSTEM_BUSY' } });
    expect(readFileSync(join(target, 'catalog.json'), 'utf8')).toBe('old');
  });
});

describe('writeProvenanceAtomic [UT-F001-034]', () => {
  it('UTF-8・安定キー順で完全fileへ置換する', () => {
    const root = workspace();
    const target = join(root, 'content', 'provenance.json');
    writeProvenanceAtomic(target, manifest(), { workspace: root });
    const bytes = readFileSync(target);
    const text = bytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('"bibliography"')).toBeLessThan(text.indexOf('"schemaVersion"'));
    expect(JSON.parse(text)).toEqual(manifest());
  });

  /** @des DES-F001-004 DES-F001-012 DES-F001-017 @fun FUN-F001-008 @test UT-F001-008 */
  it('manifestと全3作品の書誌ZIP/CSV由来が一致しない場合は公開artifactを作らない', () => {
    const root = workspace();
    const target = join(root, 'content', 'provenance.json');
    const valid = manifest();
    const mismatch: ProvenanceManifest = {
      ...valid,
      works: valid.works.map((work, index) => index === 2
        ? { ...work, bibliography: { ...work.bibliography, csvSha256: 'd'.repeat(64) } }
        : work),
    };
    expect(() => writeProvenanceAtomic(target, mismatch, { workspace: root })).toThrow();
    expect(() => readFileSync(target)).toThrow();

    const missingWork: ProvenanceManifest = { ...valid, works: valid.works.slice(0, 2) };
    expect(() => writeProvenanceAtomic(target, missingWork, { workspace: root })).toThrow();
    expect(() => readFileSync(target)).toThrow();
  });

  it('mtime競合とrename失敗では元bytesを保持しtmpを残さない', () => {
    const root = workspace();
    const content = join(root, 'content');
    const target = join(content, 'provenance.json');
    mkdirSync(content);
    writeFileSync(target, 'old');

    expect(() => writeProvenanceAtomic(target, manifest(), {
      workspace: root,
      beforeCommit: () => writeFileSync(target, 'concurrent'),
    })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('concurrent');

    writeFileSync(target, 'old');
    expect(() => writeProvenanceAtomic(target, manifest(), {
      workspace: root,
      rename: () => { throw Object.assign(new Error('rename failed'), { code: 'EBUSY' }); },
    })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(content)).toEqual(['provenance.json']);
  });

  it('固定path逸脱とsymlinkを拒否する', () => {
    const root = workspace();
    expect(() => writeProvenanceAtomic(join(root, 'other.json'), manifest(), { workspace: root })).toThrow();
    const external = workspace();
    symlinkSync(external, join(root, 'content'), 'junction');
    expect(() => writeProvenanceAtomic(join(root, 'content', 'provenance.json'), manifest(), { workspace: root })).toThrow();
    expect(readdirSync(external)).not.toContain('provenance.json');
    expect(() => writeProvenanceAtomic(join(root, 'content', 'provenance.json'), manifest(), {
      workspace: 'relative-workspace',
    })).toThrow();
  });
});

describe('mapPipelineError [UT-F001-036]', () => {
  it.each(UPDATE_STAGES)('%s stageでallowlist済み3項目だけを返す', (stage) => {
    const diagnostic = mapPipelineError(Object.assign(new Error('token=secret'), {
      code: 'ETIMEDOUT',
      stack: 'STACK_SECRET',
      response: { body: '<html>SECRET</html>' },
      env: { TOKEN: 'SECRET' },
    }), stage);
    expect(Object.keys(diagnostic).sort()).toEqual(['reasonCode', 'retryable', 'stage']);
    expect(PIPELINE_REASON_CODES).toContain(diagnostic.reasonCode);
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|stack|html|token/i);
  });

  it('未知Errorは安全な非retry診断へ倒す', () => {
    expect(mapPipelineError('credential=SECRET', 'build')).toEqual({
      reasonCode: 'PIPELINE_UNKNOWN',
      stage: 'build',
      retryable: false,
    });
  });
});
