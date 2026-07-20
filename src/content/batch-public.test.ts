import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { BatchId, BatchManifest, PublishableBatch, ReleasePreparationContext, Sha256, WorkspaceRelativePath } from './batch.ts';
import {
  buildIntegratedPublicTree,
  promoteIntegratedTree,
  type BatchCatalogFragment,
  type F001BaselineBundle,
  type F001ContentInvariantReport,
} from './batch-public.ts';

const execFile = promisify(execFileCallback);

function sha(bytes: Uint8Array | string): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

async function treeDigest(root: string): Promise<Sha256> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (path: string, logical: string): Promise<void> => {
    for (const name of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = join(path, name.name);
      const childLogical = logical ? `${logical}/${name.name}` : name.name;
      if (name.isDirectory()) await walk(child, childLogical);
      else files.push({ path: childLogical, bytes: await readFile(child) });
    }
  };
  await walk(root, '');
  const digest = createHash('sha256');
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  }
  return digest.digest('hex') as Sha256;
}

async function fixture(): Promise<{
  root: string;
  f001: F001BaselineBundle;
  batches: PublishableBatch[];
  batchCatalogs: Readonly<Record<string, BatchCatalogFragment>>;
  preparation: ReleasePreparationContext;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-public-'));
  const baseline = join(root, 'baseline');
  await mkdir(join(baseline, 'artwork'), { recursive: true });
  const artwork = new TextEncoder().encode('f001-artwork');
  await writeFile(join(baseline, 'artwork', 'f001.png'), artwork);
  const f001Audio = new TextEncoder().encode('f001-audio');
  const f001Provenance = new TextEncoder().encode('{"source":"f001"}\n');
  const licenses = new TextEncoder().encode('{"licenses":[]}\n');
  await mkdir(join(baseline, 'audio', 'F001'), { recursive: true });
  await mkdir(join(baseline, 'content', 'provenance', 'F001'), { recursive: true });
  await writeFile(join(baseline, 'audio', 'F001', 'f001-audio.wav'), f001Audio);
  await writeFile(join(baseline, 'content', 'provenance', 'F001', '000127.json'), f001Provenance);
  await writeFile(join(baseline, 'content', 'licenses.json'), licenses);
  const audio = new TextEncoder().encode('accepted-wave');
  const acceptedPath = 'content/batches/F002/accepted-audio/000473/audio-1.wav';
  await mkdir(join(root, 'content', 'batches', 'F002', 'accepted-audio', '000473'), { recursive: true });
  await writeFile(join(root, ...acceptedPath.split('/')), audio);
  const f002Artwork = new TextEncoder().encode('f002-artwork');
  const f002Provenance = new TextEncoder().encode('{"source":"f002"}\n');
  await mkdir(join(root, 'content', 'batches', 'F002', 'public-files'), { recursive: true });
  await writeFile(join(root, 'content', 'batches', 'F002', 'public-files', 'artwork.png'), f002Artwork);
  await writeFile(join(root, 'content', 'batches', 'F002', 'public-files', 'provenance.json'), f002Provenance);
  const manifest = {
    batchId: 'F002', feature: 'feature-2', status: 'accepted', workIds: ['000473'],
    author: {
      authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji', identitySha256: sha('author-2'),
    }, acceptedAt: '2026-07-20T00:00:00.000Z',
  } as unknown as BatchManifest;
  await writeFile(join(root, 'content', 'batches', 'F002', 'batch.json'), canonicalJson(manifest));
  await writeFile(join(root, '.gitignore'), '.cache/\n');
  return {
    root,
    f001: {
      sourceRoot: baseline,
      files: [
        { path: 'artwork/f001.png' as WorkspaceRelativePath, sha256: sha(artwork), bytes: artwork.byteLength },
        { path: 'audio/F001/f001-audio.wav' as WorkspaceRelativePath, sha256: sha(f001Audio), bytes: f001Audio.byteLength },
        { path: 'content/provenance/F001/000127.json' as WorkspaceRelativePath, sha256: sha(f001Provenance), bytes: f001Provenance.byteLength },
        { path: 'content/licenses.json' as WorkspaceRelativePath, sha256: sha(licenses), bytes: licenses.byteLength },
      ],
      catalog: {
        schemaVersion: '2.0.0',
        authors: [{
          authorId: '000879', name: 'あくたがわずんのすけ', originalName: '芥川龍之介', slug: 'akutagawa-zunnosuke',
          artwork: { path: 'artwork/f001.png', alt: 'F001', sha256: sha(artwork) }, introducedByBatchId: 'F001', identitySha256: sha('author-1'),
        }],
        works: [{
          workId: '000127', authorId: '000879', batchId: 'F001', title: '羅生門',
          cardLink: 'https://www.aozora.gr.jp/cards/000879/card127.html',
          source: {
            cardUrl: 'https://www.aozora.gr.jp/cards/000879/card127.html', textUrl: 'https://www.aozora.gr.jp/cards/000879/files/127_15260.html',
            attribution: '青空文庫', baseEdition: '底本', inputter: '入力者', proofreader: '校正者', fetchedAt: '2026-07-19T00:00:00.000Z',
            transformation: '変換', sourceSha256: sha('f001-source'), provenancePath: 'content/provenance/F001/000127.json',
            provenanceSha256: sha(f001Provenance),
          },
          dialogues: [{
            dialogueId: 'f001-dialogue', workId: '000127', order: 0, displayText: '台詞', speechText: '台詞', audioId: 'f001-audio',
            sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
            review: {
              candidateId: 'f001-dialogue', revision: 1, status: 'approved', reasonCode: 'SPOKEN_DIALOGUE', reviewer: 'reviewer',
              reviewedAt: '2026-07-19T00:00:00.000Z', policyCheckedAt: '2026-07-19T00:00:00.000Z',
            },
          }],
        }],
        audioAssets: [{
          audioId: 'f001-audio', batchId: 'F001', path: 'audio/F001/f001-audio.wav', sha256: sha(f001Audio), bytes: f001Audio.byteLength,
          durationMs: 1000, configHash: sha('f001-config'),
        }], batches: [],
        candidateCounts: { total: 1, published: 1, editorialExcluded: 0, audioExcluded: 0, byBatch: { F001: { total: 1, published: 1, editorialExcluded: 0, audioExcluded: 0 } } },
        creditsRef: 'content/licenses.json',
      },
      syntheticBatch: {
        batchId: 'F001', feature: 'F001', status: 'published', authorId: '000879', workIds: ['000127'],
        acceptedAt: '2026-07-19T00:00:00.000Z', publishedAt: '2026-07-19T01:00:00.000Z', evidenceSha256: sha('f001-evidence'),
      },
      baselineSha256: sha('baseline'),
    },
    batches: [{
      manifest, manifestPath: 'content/batches/F002/batch.json' as WorkspaceRelativePath,
      manifestSha256: sha(canonicalJson(manifest)), candidate: true,
      acceptedAudioSources: [{ path: acceptedPath as WorkspaceRelativePath, sha256: sha(audio), bytes: audio.byteLength, configHash: sha('config') }],
    }],
    batchCatalogs: {
      F002: {
        authors: [{
          ...manifest.author,
          artwork: { path: 'artwork/f002.png', alt: 'F002', sha256: sha(f002Artwork) },
          introducedByBatchId: 'F002',
        }],
        works: [{
          workId: '000473', authorId: '000081', batchId: 'F002', title: 'よだかの星',
          cardLink: 'https://www.aozora.gr.jp/cards/000081/card473.html',
          source: {
            cardUrl: 'https://www.aozora.gr.jp/cards/000081/card473.html', textUrl: 'https://www.aozora.gr.jp/cards/000081/files/473_1.html',
            attribution: '青空文庫', baseEdition: '底本', inputter: '入力者', proofreader: '校正者', fetchedAt: '2026-07-20T00:00:00.000Z',
            transformation: '変換', sourceSha256: sha('source'), provenancePath: 'content/provenance/F002/000473.json', provenanceSha256: sha(f002Provenance),
          },
          dialogues: [{
            dialogueId: 'dialogue-1', workId: '000473', order: 0, displayText: '台詞', speechText: '台詞', audioId: 'audio-1',
            sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
            review: {
              candidateId: 'dialogue-1', revision: 1, status: 'approved', reasonCode: 'SPOKEN_DIALOGUE', reviewer: 'reviewer',
              reviewedAt: '2026-07-20T00:00:00.000Z', policyCheckedAt: '2026-07-20T00:00:00.000Z',
            },
          }],
        }],
        audioAssets: [{
          audioId: 'audio-1', batchId: 'F002', path: 'audio/F002/audio-1.wav', sha256: sha(audio), bytes: audio.byteLength,
          durationMs: 1000, configHash: sha('config'),
        }],
        candidateCounts: { total: 1, published: 1, editorialExcluded: 0, audioExcluded: 0 },
        publicFiles: [
          {
            source: 'content/batches/F002/public-files/artwork.png' as WorkspaceRelativePath,
            publicPath: 'artwork/f002.png' as WorkspaceRelativePath, sha256: sha(f002Artwork), bytes: f002Artwork.byteLength,
          },
          {
            source: 'content/batches/F002/public-files/provenance.json' as WorkspaceRelativePath,
            publicPath: 'content/provenance/F002/000473.json' as WorkspaceRelativePath,
            sha256: sha(f002Provenance), bytes: f002Provenance.byteLength,
          },
        ],
      },
    },
    preparation: { releaseCandidateBatchId: 'F002' as BatchId, feature: 'feature-2', sourceCommit: '' },
  };
}

async function promotionFixture(publicAudioOwners: readonly string[]): Promise<{
  value: Awaited<ReturnType<typeof fixture>>;
  staging: string;
  buildSha256: Sha256;
  currentSha256: Sha256;
  invariant: F001ContentInvariantReport;
  preparation: ReleasePreparationContext;
}> {
  const value = await fixture();
  await writeFile(join(value.root, '.gitignore'), '.cache/\n');
  for (const owner of publicAudioOwners) {
    await mkdir(join(value.root, 'public', 'audio', owner), { recursive: true });
    await writeFile(join(value.root, 'public', 'audio', owner, 'existing.wav'), `${owner}-existing`);
  }
  await execFile('git', ['init'], { cwd: value.root });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: value.root });
  await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: value.root });
  await execFile('git', ['add', '.'], { cwd: value.root });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: value.root });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: value.root, encoding: 'utf8' });
  const preparation = { ...value.preparation, sourceCommit: stdout.trim() };
  const staging = join(value.root, '.cache', 'owner-stage');
  await mkdir(staging, { recursive: true });
  const build = await buildIntegratedPublicTree(value.batches, value.f001, staging, {
    mode: 'prepare-release', workspaceRoot: value.root, batchCatalogs: value.batchCatalogs,
  }, undefined, preparation);
  return {
    value,
    staging,
    buildSha256: build.buildSha256,
    currentSha256: await treeDigest(join(value.root, 'public')),
    invariant: {
      result: 'pass', buildSha256: build.buildSha256, stagingSha256: build.buildSha256, baselineSha256: value.f001.baselineSha256,
    },
    preparation,
  };
}

describe('batch public integration', () => {
  it('F001を1回だけ含め、accepted sourceからprepare treeを構築する', async () => {
    const value = await fixture();
    const fragment = value.batchCatalogs.F002!;
    (value.batchCatalogs as Record<string, BatchCatalogFragment>).F002 = {
      ...fragment,
      authors: [fragment.authors[0]!, { ...fragment.authors[0]!, introducedByBatchId: 'F003' }],
    };
    await execFile('git', ['init'], { cwd: value.root });
    await execFile('git', ['config', 'user.name', 'Test'], { cwd: value.root });
    await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: value.root });
    await execFile('git', ['add', '.'], { cwd: value.root });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: value.root });
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: value.root, encoding: 'utf8' });
    const preparation = { ...value.preparation, sourceCommit: stdout.trim() };
    const staging = join(value.root, '.cache', 'stage');
    await mkdir(staging, { recursive: true });
    const result = await buildIntegratedPublicTree(value.batches, value.f001, staging, {
      mode: 'prepare-release', workspaceRoot: value.root, batchCatalogs: value.batchCatalogs,
    }, undefined, preparation);

    expect(await readFile(join(staging, 'audio', 'F002', 'audio-1.wav'), 'utf8')).toBe('accepted-wave');
    const catalog = JSON.parse(await readFile(join(staging, 'content', 'catalog.json'), 'utf8')) as {
      batches: Array<{ batchId: string }>;
      authors: Array<{ authorId: string }>;
      works: Array<{ source: { provenancePath: string } }>;
    };
    expect(catalog.batches.map((batch) => batch.batchId)).toEqual(['F001', 'F002']);
    expect(catalog.authors.map((author) => author.authorId)).toEqual(['000879', '000081']);
    expect(catalog.works.find((work) => work.source.provenancePath.includes('/F002/'))?.source.provenancePath)
      .toBe('content/provenance/F002/000473.json');
    expect(result.buildSha256).toBe(await treeDigest(staging));
  });

  it.each(['old-moved', 'new-moved'] as const)('%s実process停止後にstale lockを回収し二重swapなしで完了する', async (faultPhase) => {
    const value = await fixture();
    await writeFile(join(value.root, '.gitignore'), '.cache/\n');
    await mkdir(join(value.root, 'public'), { recursive: true });
    await writeFile(join(value.root, 'public', 'old.txt'), 'old-public');
    await execFile('git', ['init'], { cwd: value.root });
    await execFile('git', ['config', 'user.name', 'Test'], { cwd: value.root });
    await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: value.root });
    await execFile('git', ['add', '.'], { cwd: value.root });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: value.root });
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: value.root, encoding: 'utf8' });
    const preparation = { ...value.preparation, sourceCommit: stdout.trim() };
    const staging = join(value.root, '.cache', 'stage');
    await mkdir(staging, { recursive: true });
    const build = await buildIntegratedPublicTree(value.batches, value.f001, staging, {
      mode: 'prepare-release', workspaceRoot: value.root, batchCatalogs: value.batchCatalogs,
    }, undefined, preparation);
    const invariant: F001ContentInvariantReport = {
      result: 'pass', buildSha256: build.buildSha256, stagingSha256: build.buildSha256, baselineSha256: value.f001.baselineSha256,
    };
    const current = await treeDigest(join(value.root, 'public'));

    const metadataPath = build.buildMetadataPath as string;
    const originalMetadata = await readFile(metadataPath, 'utf8');
    const changedMetadata = JSON.parse(originalMetadata) as Record<string, unknown>;
    changedMetadata.feature = 'tampered';
    await writeFile(metadataPath, canonicalJson(changedMetadata));
    await expect(promoteIntegratedTree(value.root, staging, build.buildSha256, current, invariant, preparation))
      .rejects.toMatchObject({ code: 'PUBLIC_PROMOTION_CONFLICT' });
    await writeFile(metadataPath, originalMetadata);

    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'content', 'batch-public.ts')).href;
    const source = [
      `import { promoteIntegratedTree } from ${JSON.stringify(moduleUrl)};`,
      `await promoteIntegratedTree(${JSON.stringify(value.root)}, ${JSON.stringify(staging)}, ${JSON.stringify(build.buildSha256)},`,
      `  ${JSON.stringify(current)}, ${JSON.stringify(invariant)}, ${JSON.stringify(preparation)}, {`,
      `  afterPhase(phase) { if (phase === ${JSON.stringify(faultPhase)}) process.kill(process.pid, 'SIGKILL'); },`,
      `});`,
    ].join('\n');
    const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', source], {
      stdio: 'ignore', windowsHide: true,
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    expect(exit.code === 0 && exit.signal === null).toBe(false);
    await promoteIntegratedTree(value.root, staging, build.buildSha256, current, invariant, preparation);

    expect(await treeDigest(join(value.root, 'public'))).toBe(build.buildSha256);
    expect(await readdir(join(value.root, 'public'))).not.toContain('.integrated-build.json');
    await expect(readFile(join(value.root, 'public', 'old.txt'))).rejects.toThrow();
  });

  it('journalのbackupを固定名以外へ差し替えても無関係treeを削除しない', async () => {
    const value = await fixture();
    await writeFile(join(value.root, '.gitignore'), '.cache/\n');
    await mkdir(join(value.root, 'public'), { recursive: true });
    await writeFile(join(value.root, 'public', 'old.txt'), 'old-public');
    await mkdir(join(value.root, 'unrelated'), { recursive: true });
    await writeFile(join(value.root, 'unrelated', 'keep.txt'), 'keep');
    await execFile('git', ['init'], { cwd: value.root });
    await execFile('git', ['config', 'user.name', 'Test'], { cwd: value.root });
    await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: value.root });
    await execFile('git', ['add', '.'], { cwd: value.root });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: value.root });
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: value.root, encoding: 'utf8' });
    const preparation = { ...value.preparation, sourceCommit: stdout.trim() };
    const staging = join(value.root, '.cache', 'stage');
    await mkdir(staging, { recursive: true });
    const build = await buildIntegratedPublicTree(value.batches, value.f001, staging, {
      mode: 'prepare-release', workspaceRoot: value.root, batchCatalogs: value.batchCatalogs,
    }, undefined, preparation);
    const current = await treeDigest(join(value.root, 'public'));
    const invariant: F001ContentInvariantReport = {
      result: 'pass', buildSha256: build.buildSha256, stagingSha256: build.buildSha256, baselineSha256: value.f001.baselineSha256,
    };
    const journalPath = join(value.root, '.cache', 'transactions', 'public-build.json');
    await mkdir(join(value.root, '.cache', 'transactions'), { recursive: true });
    await writeFile(journalPath, canonicalJson({
      schemaVersion: '1.0.0', phase: 'new-moved', staging: '.cache/stage', backup: 'unrelated',
      expectedBuildSha: build.buildSha256, expectedCurrentPublicSha: current, preparation,
    }));

    await expect(promoteIntegratedTree(value.root, staging, build.buildSha256, current, invariant, preparation))
      .rejects.toMatchObject({ code: 'PUBLIC_PROMOTION_CONFLICT' });
    expect(await readFile(join(value.root, 'unrelated', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('F001とcurrent accepted batchのaudio ownerだけを保持してpromotionする', async () => {
    const prepared = await promotionFixture(['F001', 'F002']);
    await promoteIntegratedTree(
      prepared.value.root,
      prepared.staging,
      prepared.buildSha256,
      prepared.currentSha256,
      prepared.invariant,
      prepared.preparation,
    );

    expect(await readdir(join(prepared.value.root, 'public', 'audio'))).toEqual(['F001', 'F002']);
    await expect(readdir(join(prepared.value.root, '.cache', 'quarantine', 'public-audio-owner'))).rejects.toThrow();
  });

  it.each(['999999', 'F002-copy'])('未知または類似audio owner %s をstale判定より先に隔離する', async (unknownOwner) => {
    const prepared = await promotionFixture(['F001', 'F002']);
    const orphan = join(prepared.value.root, 'public', 'audio', unknownOwner);
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'orphan.wav'), 'third-party');

    await expect(promoteIntegratedTree(
      prepared.value.root,
      prepared.staging,
      prepared.buildSha256,
      prepared.currentSha256,
      prepared.invariant,
      prepared.preparation,
    )).rejects.toMatchObject({ code: 'PUBLIC_AUDIO_OWNER_QUARANTINED' });

    expect(await readFile(join(prepared.value.root, 'public', 'audio', 'F001', 'existing.wav'), 'utf8')).toBe('F001-existing');
    expect(await readFile(join(prepared.value.root, 'public', 'audio', 'F002', 'existing.wav'), 'utf8')).toBe('F002-existing');
    await expect(readFile(join(orphan, 'orphan.wav'))).rejects.toThrow();
    const quarantineRoot = join(prepared.value.root, '.cache', 'quarantine', 'public-audio-owner');
    const transactions = await readdir(quarantineRoot);
    expect(transactions).toHaveLength(1);
    expect(await readFile(join(quarantineRoot, transactions[0]!, unknownOwner, 'orphan.wav'), 'utf8')).toBe('third-party');
  });

  it('work-previewはcatalog期待file集合とのsha/bytes完全一致を要求する', async () => {
    const value = await fixture();
    const fragment = value.batchCatalogs.F002!;
    const activeRoot = join(value.root, '.cache', 'active-input');
    await mkdir(activeRoot, { recursive: true });
    const stagedFiles = [] as Array<{ source: string; publicPath: WorkspaceRelativePath; sha256: Sha256; bytes: number }>;
    for (const file of fragment.publicFiles ?? []) {
      const source = join(activeRoot, file.publicPath.replaceAll('/', '-'));
      await copyFile(join(value.root, ...file.source.split('/')), source);
      stagedFiles.push({ source, publicPath: file.publicPath, sha256: file.sha256, bytes: file.bytes });
    }
    for (const asset of fragment.audioAssets) {
      const source = join(activeRoot, `${asset.audioId}.wav`);
      await copyFile(join(value.root, 'content', 'batches', 'F002', 'accepted-audio', '000473', `${asset.audioId}.wav`), source);
      stagedFiles.push({ source, publicPath: asset.path as WorkspaceRelativePath, sha256: asset.sha256 as Sha256, bytes: asset.bytes });
    }
    const active = {
      manifest: {
        ...value.batches[0]!.manifest,
        workIds: ['000473'],
        workProgress: [{ workId: '000473', status: 'voiced', stageRecords: [] }],
      } as unknown as BatchManifest,
      workId: '000473', stagingRoot: activeRoot, catalogFragment: fragment,
      catalogBatch: {
        batchId: 'F002', feature: 'feature-2', status: 'accepted' as const, authorId: '000081', workIds: ['000473'],
        acceptedAt: '2026-07-20T00:00:00.000Z', evidenceSha256: sha('active-evidence'),
      },
      stagedFiles,
    };
    const output = join(value.root, '.cache', 'active-output');
    await mkdir(output, { recursive: true });
    await expect(buildIntegratedPublicTree([], value.f001, output, { mode: 'work-preview', workspaceRoot: value.root }, active)).resolves.toMatchObject({
      activeBatchId: 'F002', activeWorkId: '000473',
    });
    const missingOutput = join(value.root, '.cache', 'active-missing');
    await mkdir(missingOutput, { recursive: true });
    await expect(buildIntegratedPublicTree([], value.f001, missingOutput, { mode: 'work-preview', workspaceRoot: value.root }, {
      ...active, stagedFiles: stagedFiles.slice(1),
    })).rejects.toMatchObject({ code: 'PUBLIC_REFERENCE_MISSING' });

    const laterOutput = join(value.root, '.cache', 'active-later');
    await mkdir(laterOutput, { recursive: true });
    await expect(buildIntegratedPublicTree([], value.f001, laterOutput, { mode: 'work-preview', workspaceRoot: value.root }, {
      ...active, catalogBatch: { ...active.catalogBatch, workIds: ['000473', '043752'] },
    })).rejects.toMatchObject({ code: 'PUBLIC_RELEASE_CANDIDATE_MISMATCH' });

    const priorMissingOutput = join(value.root, '.cache', 'active-prior-missing');
    await mkdir(priorMissingOutput, { recursive: true });
    await expect(buildIntegratedPublicTree([], value.f001, priorMissingOutput, { mode: 'work-preview', workspaceRoot: value.root }, {
      ...active,
      manifest: {
        ...active.manifest,
        workIds: ['000473', '043752'],
        workProgress: [
          { workId: '000473', status: 'accepted', stageRecords: [], acceptedAt: '2026-07-20T00:00:00.000Z', acceptedBy: 'test', acceptedAudioSources: [] },
          { workId: '043752', status: 'voiced', stageRecords: [] },
        ],
      } as unknown as BatchManifest,
      workId: '043752',
      catalogBatch: { ...active.catalogBatch, workIds: ['043752'] },
    })).rejects.toMatchObject({ code: 'PUBLIC_RELEASE_CANDIDATE_MISMATCH' });
  });

  it('work-previewは先行acceptedをcanonical source、現workだけをstagingから累積する', async () => {
    const value = await fixture();
    const baseFragment = value.batchCatalogs.F002!;
    const baseWork = baseFragment.works[0]!;
    const currentBytes = new TextEncoder().encode('current-wave');
    const currentProvenance = new TextEncoder().encode('{"source":"current"}\n');
    const activeRoot = join(value.root, '.cache', 'cumulative-input');
    await mkdir(activeRoot, { recursive: true });
    const currentAudioPath = join(activeRoot, 'audio-2.wav');
    const currentProvenancePath = join(activeRoot, 'current-provenance.json');
    await writeFile(currentAudioPath, currentBytes);
    await writeFile(currentProvenancePath, currentProvenance);
    const stagedFiles = [] as Array<{ source: string; publicPath: WorkspaceRelativePath; sha256: Sha256; bytes: number }>;
    for (const file of baseFragment.publicFiles ?? []) {
      const source = join(activeRoot, `base-${file.publicPath.replaceAll('/', '-')}`);
      await copyFile(join(value.root, ...file.source.split('/')), source);
      stagedFiles.push({ source, publicPath: file.publicPath, sha256: file.sha256, bytes: file.bytes });
    }
    stagedFiles.push({
      source: currentProvenancePath, publicPath: 'content/provenance/F002/043752.json' as WorkspaceRelativePath,
      sha256: sha(currentProvenance), bytes: currentProvenance.byteLength,
    }, {
      source: currentAudioPath, publicPath: 'audio/F002/audio-2.wav' as WorkspaceRelativePath,
      sha256: sha(currentBytes), bytes: currentBytes.byteLength,
    });
    const fragment: BatchCatalogFragment = {
      authors: baseFragment.authors,
      works: [baseWork, {
        ...baseWork, workId: '043752', title: '雪渡り',
        cardLink: 'https://www.aozora.gr.jp/cards/000081/card43752.html',
        source: {
          ...baseWork.source,
          cardUrl: 'https://www.aozora.gr.jp/cards/000081/card43752.html',
          textUrl: 'https://www.aozora.gr.jp/cards/000081/files/43752_1.html',
          provenancePath: 'content/provenance/F002/043752.json', provenanceSha256: sha(currentProvenance),
        },
        dialogues: [{
          ...baseWork.dialogues[0]!, dialogueId: 'dialogue-2', workId: '043752', audioId: 'audio-2',
          review: { ...baseWork.dialogues[0]!.review, candidateId: 'dialogue-2' },
        }],
      }],
      audioAssets: [...baseFragment.audioAssets, {
        audioId: 'audio-2', batchId: 'F002', path: 'audio/F002/audio-2.wav', sha256: sha(currentBytes),
        bytes: currentBytes.byteLength, durationMs: 1000, configHash: sha('config'),
      }],
      candidateCounts: { total: 2, published: 2, editorialExcluded: 0, audioExcluded: 0 },
      publicFiles: [...(baseFragment.publicFiles ?? []), {
        source: 'content/batches/F002/public-files/current-provenance.json' as WorkspaceRelativePath,
        publicPath: 'content/provenance/F002/043752.json' as WorkspaceRelativePath,
        sha256: sha(currentProvenance), bytes: currentProvenance.byteLength,
      }],
    };
    const priorSource = value.batches[0]!.acceptedAudioSources[0]!;
    const active = {
      manifest: {
        ...value.batches[0]!.manifest,
        workIds: ['000473', '043752'],
        workProgress: [{
          workId: '000473', status: 'accepted', stageRecords: [], acceptedAt: '2026-07-20T00:00:00.000Z', acceptedBy: 'test',
          acceptedAudioSources: [priorSource],
        }, { workId: '043752', status: 'voiced', stageRecords: [] }],
      } as unknown as BatchManifest,
      workId: '043752', stagingRoot: activeRoot, catalogFragment: fragment,
      catalogBatch: {
        batchId: 'F002', feature: 'feature-2', status: 'accepted' as const, authorId: '000081', workIds: ['000473', '043752'],
        acceptedAt: '2026-07-20T01:00:00.000Z', evidenceSha256: sha('cumulative'),
      },
      stagedFiles,
    };
    const output = join(value.root, '.cache', 'cumulative-output');
    await mkdir(output, { recursive: true });

    await buildIntegratedPublicTree([], value.f001, output, { mode: 'work-preview', workspaceRoot: value.root }, active);

    expect(await readFile(join(output, 'audio', 'F002', 'audio-1.wav'), 'utf8')).toBe('accepted-wave');
    expect(await readFile(join(output, 'audio', 'F002', 'audio-2.wav'), 'utf8')).toBe('current-wave');
  });
});
