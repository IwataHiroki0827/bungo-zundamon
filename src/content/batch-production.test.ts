import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  BatchProductionError,
  normalizeBatchCandidate,
  promoteBatchSourceArtifactTree,
  recoverBatchSourceArtifactPromotion,
  runBatchSourceStages,
  type BatchContext,
  type BatchSourceDependencies,
  type SpeechRevision,
} from './batch-production.ts';
import { type BatchManifest, type Sha256, type WorkId, type WorkspaceRelativePath } from './batch.ts';
import { EXTRACTOR_VERSION, type RawCandidate } from './processing.ts';
import {
  AOZORA_BIBLIOGRAPHY_ENTRY,
  AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS,
  AOZORA_BIBLIOGRAPHY_URL,
  parseAozoraBibliography,
  type BibliographyRow,
  type SelectedWork,
  type SelectedWorkResult,
} from './source.ts';

const temporaryDirectories: string[] = [];
const HASH_A = 'a'.repeat(64) as Sha256;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function path(value: string): WorkspaceRelativePath {
  return value as WorkspaceRelativePath;
}

function manifest(): BatchManifest {
  return {
    batchId: 'F002' as BatchManifest['batchId'], feature: 'F002', schemaVersion: '1.0.0', status: 'draft',
    author: { authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji', identitySha256: HASH_A },
    workIds: ['000473', '043752', '043754'] as unknown as BatchManifest['workIds'],
    workProgress: [
      { workId: '000473' as WorkId, status: 'pending', stageRecords: [] },
      { workId: '043752' as WorkId, status: 'pending', stageRecords: [] },
      { workId: '043754' as WorkId, status: 'pending', stageRecords: [] },
    ],
    inputPaths: [path('data/batches/F002/selected-works.json')],
    outputPaths: [path('content/batches/F002/provenance.json')], stageRecords: [],
    rightsSnapshotIds: ['aozora-selection-2026-07-20'],
    voiceConfigRef: path('content/batches/F002/voice-config.json'),
    artworkProvenanceRef: path('content/batches/F002/artwork-provenance.json'),
  };
}

function rawCandidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    workId: '000473', rawSourceSha256: 'b'.repeat(64), order: 0,
    rawTokenRange: { start: 1, end: 4 },
    tokens: [{ type: 'text', value: '「よだかは' }, { type: 'ruby', base: '星', reading: 'ほし' }, { type: 'text', value: 'です」' }],
    contextBefore: '前', contextAfter: '後',
    sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 4 },
    extractorVersion: EXTRACTOR_VERSION,
    ...overrides,
  };
}

function selected(overrides: Partial<SelectedWork> = {}): SelectedWork {
  return {
    workId: '000473', title: 'よだかの星', personId: '000081', role: '著者', copyright: 'なし',
    personCopyright: 'なし', status: '公開中', language: '日本語原著', orthography: '新字新仮名',
    sourceUrl: 'https://www.aozora.gr.jp/cards/000081/files/473_1.html',
    cardUrl: 'https://www.aozora.gr.jp/cards/000081/card473.html', charset: 'UTF-8', selectionReason: 'manifest版',
    baseEdition: '底本', inputter: '入力者', proofreader: '校正者',
    ...overrides,
  };
}

function rows(): BibliographyRow[] {
  return [
    selected(),
    selected({
      workId: '043752', title: 'どんぐりと山猫',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000081/files/43752_1.html',
      cardUrl: 'https://www.aozora.gr.jp/cards/000081/card43752.html',
    }),
    selected({
      workId: '043754', title: '注文の多い料理店',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000081/files/43754_1.html',
      cardUrl: 'https://www.aozora.gr.jp/cards/000081/card43754.html',
    }),
  ];
}

function bibliographyCsv(items: readonly BibliographyRow[]): Uint8Array {
  const records = items.map((item) => AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map((column) => ({
    作品ID: String(Number(item.workId)), 作品名: item.title, 文字遣い種別: item.orthography ?? '',
    作品著作権フラグ: item.copyright, 図書カードURL: item.cardUrl ?? '', 人物ID: String(Number(item.personId)),
    人物著作権フラグ: item.personCopyright ?? '', 役割フラグ: item.role, 底本名1: item.baseEdition ?? '',
    入力者: item.inputter ?? '', 校正者: item.proofreader ?? '', 'XHTML/HTMLファイルURL': item.sourceUrl,
    'XHTML/HTMLファイル符号化方式': item.charset ?? '', 'XHTML/HTMLファイル文字集合': item.charset ?? '',
  } as Record<string, string>)[column] ?? '').join(','));
  return new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${records.join('\n')}\n`);
}

function dependencies(overrides: Partial<BatchSourceDependencies> = {}): BatchSourceDependencies {
  const bytes = new TextEncoder().encode('<html>fixture</html>');
  const rawSha = createHash('sha256').update(bytes).digest('hex');
  const bibliographyRows = rows();
  const csv = bibliographyCsv(bibliographyRows);
  const csvSha = createHash('sha256').update(csv).digest('hex');
  const works = rows() as SelectedWork[];
  const selection: SelectedWorkResult = {
    works,
    observation: {
      phase: 'selection', bibliographySha256: csvSha, observedAt: '2026-07-20T00:00:00Z',
      works: works.map((work) => ({
        workId: work.workId, title: work.title, personId: work.personId,
        personCopyright: work.personCopyright!, workCopyright: work.copyright, role: work.role,
        translatorPresent: false, status: work.status, orthography: work.orthography!,
        cardUrl: work.cardUrl!, sourceUrl: work.sourceUrl,
      })),
    },
  };
  return {
    loadBibliography: async () => ({
      snapshot: {
        sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
        archivePath: 'list.zip', archiveSha256: 'c'.repeat(64), archiveBytes: 10,
        csvPath: AOZORA_BIBLIOGRAPHY_ENTRY, csvEntry: AOZORA_BIBLIOGRAPHY_ENTRY, csvSha256: csvSha, csvBytes: csv.byteLength,
        mediaType: 'application/zip', fetchedAt: '2026-07-20T00:00:00Z', schemaVersion: '1',
      },
      csv,
      rows: parseAozoraBibliography(csv),
    }),
    selectWorks: async () => selection,
    fetchSource: async () => ({
      raw: bytes,
      record: {
        workId: '000473', rawPath: '000473/source.raw', rawSha256: rawSha,
        mediaType: 'application/xhtml+xml', httpCharset: 'UTF-8', bibliographyCharset: 'UTF-8',
        fetchedAt: '2026-07-20T00:00:00Z', sourceUrl: selected().sourceUrl,
      },
    }),
    decodeSource: (record) => ({ workId: record.workId, rawSha256: record.rawSha256, adoptedCharset: 'UTF-8', text: '<div class="main_text">fixture</div>' }),
    extractCandidates: (_source, workId) => [rawCandidate({ workId, rawSourceSha256: rawSha })],
    ...overrides,
  };
}

async function context(overrides: Partial<BatchContext> = {}): Promise<BatchContext> {
  const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-production-'));
  temporaryDirectories.push(workspace);
  return {
    workspace, manifest: manifest(), workId: '000473' as WorkId,
    speechRules: DEFAULT_BATCH_SPEECH_RULES, toolVersion: 'batch-source/1.0.0',
    clock: () => new Date('2026-07-20T00:00:00Z'), dependencies: dependencies(),
    ...overrides,
  };
}

describe('batch source stage [DES-F002-004][DES-F002-014][DES-F002-015]', () => {
  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it('同一入力を作品単位でatomic昇格し決定的な候補・evidenceを返す', async () => {
    const firstContext = await context();
    const first = await runBatchSourceStages(firstContext, 'normalize');
    const second = await runBatchSourceStages(firstContext, 'normalize');
    expect(first.artifactSha256).toBe(second.artifactSha256);
    expect(first.candidates.map((item) => item.candidateId)).toEqual(second.candidates.map((item) => item.candidateId));
    expect(first.manifest.workProgress.map((item) => item.status)).toEqual(['extracted', 'pending', 'pending']);
    expect(first.evidence).toMatchObject({ stage: 'extracted', workId: '000473', count: 1 });
    expect(await readFile(join(firstContext.workspace, ...first.artifactPaths.sourceRaw.split('/')))).toEqual(
      Buffer.from('<html>fixture</html>', 'utf8'),
    );
    const persistedCsv = await readFile(join(firstContext.workspace, ...first.artifactPaths.bibliographyCsv.split('/')));
    expect(createHash('sha256').update(persistedCsv).digest('hex')).toBe(first.evidence.inputHashes[1]);
  });

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it('stage失敗時は既存treeを維持し、先行未acceptedの後続workを拒否する', async () => {
    const initial = await context();
    const accepted = await runBatchSourceStages(initial, 'normalize');
    const existing = await readFile(join(initial.workspace, ...accepted.artifactPaths.candidates.split('/')), 'utf8');
    const failure = {
      ...initial,
      dependencies: dependencies({
        extractCandidates: (source, workId) => [rawCandidate({
          workId, rawSourceSha256: source.rawSha256, contextBefore: '変更入力',
        })],
        beforePromotion: () => { throw new Error('fault'); },
      }),
    };
    await expect(runBatchSourceStages(failure, 'normalize')).rejects.toThrow('fault');
    expect(await readFile(join(initial.workspace, ...accepted.artifactPaths.candidates.split('/')), 'utf8')).toBe(existing);
    expect((await readdir(dirname(join(initial.workspace, ...accepted.artifactRoot.split('/')))))
      .some((name) => name.includes('.stage-') || name.includes('promotion-journal'))).toBe(false);

    const later = { ...initial, workId: '043752' as WorkId };
    await expect(runBatchSourceStages(later, 'normalize')).rejects.toMatchObject({ code: 'BATCH_STAGE_ORDER_MISMATCH' });
  });

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it('書誌rows/snapshot、selection observation、source URL差替えをfail-closedで拒否する', async () => {
    const base = dependencies();
    const cases: BatchSourceDependencies[] = [
      {
        ...base,
        loadBibliography: async (value, scratch) => {
          const bibliography = await base.loadBibliography(value, scratch);
          return { ...bibliography, rows: bibliography.rows.map((row, index) => index === 0 ? { ...row, title: '差替え' } : row) };
        },
      },
      {
        ...base,
        selectWorks: async (bibliography, value, scratch) => {
          const selection = await base.selectWorks(bibliography, value, scratch);
          return { ...selection, observation: { ...selection.observation, bibliographySha256: 'f'.repeat(64) } };
        },
      },
      {
        ...base,
        fetchSource: async (work, value, scratch) => {
          const fetched = await base.fetchSource(work, value, scratch);
          return { ...fetched, record: { ...fetched.record, sourceUrl: 'https://www.aozora.gr.jp/cards/000081/files/43752_1.html' } };
        },
      },
    ];
    for (const injected of cases) {
      const value = await context({ dependencies: injected });
      await expect(runBatchSourceStages(value, 'normalize')).rejects.toBeInstanceOf(BatchProductionError);
    }
  });

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it('process kill後にjournalからcanonical新版へrestart recoveryする', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-crash-'));
    temporaryDirectories.push(workspace);
    const artifactRoot = 'data/batches/F002/work-artifacts/000473' as WorkspaceRelativePath;
    const target = join(workspace, ...artifactRoot.split('/'));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'value.bin'), 'old-value', 'utf8');
    const worker = resolve(process.cwd(), 'src/content/batch-production-crash-worker.ts');
    const child = spawn(process.execPath, ['--experimental-transform-types', worker, workspace, artifactRoot], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('old-moved')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!output.includes('old-moved')) reject(new Error(`worker exited before phase: ${code}`));
      });
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    await recoverBatchSourceArtifactPromotion(workspace, artifactRoot);
    expect(await readFile(join(target, 'value.bin'), 'utf8')).toBe('new-value');
    expect((await readdir(dirname(target))).some((name) => name.includes('promotion-journal'))).toBe(false);
  });

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it('restart時の第三者staging値をquarantineしcanonical旧版を復元する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-quarantine-'));
    temporaryDirectories.push(workspace);
    const artifactRoot = 'data/batches/F002/work-artifacts/000473' as WorkspaceRelativePath;
    const target = join(workspace, ...artifactRoot.split('/'));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'value.bin'), 'old-value', 'utf8');
    await expect(promoteBatchSourceArtifactTree(
      workspace,
      artifactRoot,
      [{ path: 'value.bin', bytes: new TextEncoder().encode('new-value') }],
      { afterPhase: (current) => { if (current === 'old-moved') throw new Error('simulated stop'); } },
    )).rejects.toThrow('simulated stop');
    const parent = dirname(target);
    const stagingName = (await readdir(parent)).find((name) => name.includes('.000473.stage-'));
    expect(stagingName).toBeTruthy();
    await writeFile(join(parent, stagingName!, 'value.bin'), 'third-party', 'utf8');
    await expect(recoverBatchSourceArtifactPromotion(workspace, artifactRoot)).rejects.toMatchObject({
      code: 'BATCH_ARTIFACT_QUARANTINED',
    });
    expect(await readFile(join(target, 'value.bin'), 'utf8')).toBe('old-value');
    expect((await readdir(parent)).some((name) => name.includes('quarantine-'))).toBe(true);
  });

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it.each(['..', '.', 'other-stage', '.000473.stage-good/child'])(
    '悪意journal stagingName=%sをtarget解決前に拒否する',
    async (stagingName) => {
      const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-journal-path-'));
      temporaryDirectories.push(workspace);
      const artifactRoot = 'data/batches/F002/work-artifacts/000473' as WorkspaceRelativePath;
      const target = join(workspace, ...artifactRoot.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(join(dirname(target), '.000473.promotion-journal.json'), JSON.stringify({
        version: 1, phase: 'prepared', targetName: '000473', stagingName,
        backupName: '.000473.backup-00000000-0000-4000-8000-000000000000',
        expectedOldSha256: null, expectedNewSha256: 'a'.repeat(64),
      }), 'utf8');
      await expect(recoverBatchSourceArtifactPromotion(workspace, artifactRoot)).rejects.toMatchObject({
        code: 'BATCH_ARTIFACT_JOURNAL_INVALID',
      });
    },
  );

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it.each(['dir:name/value.bin', 'CON/file.bin', 'aux.txt', `control${String.fromCharCode(1)}.bin`])(
    '危険なWindows artifact path %sを拒否してstagingを残さない',
    async (entryPath) => {
      const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-entry-path-'));
      temporaryDirectories.push(workspace);
      const artifactRoot = 'data/batches/F002/work-artifacts/000473' as WorkspaceRelativePath;
      await expect(promoteBatchSourceArtifactTree(workspace, artifactRoot, [
        { path: entryPath, bytes: new Uint8Array([1]) },
      ])).rejects.toMatchObject({ code: 'BATCH_ARTIFACT_PATH_INVALID' });
      const parent = join(workspace, 'data', 'batches', 'F002', 'work-artifacts');
      expect((await readdir(parent)).some((name) => name.includes('.stage-'))).toBe(false);
    },
  );

  /** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 @test UT-F002-007 */
  it('journalが指すjunction/symlink stagingを拒否する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bungo-batch-journal-link-'));
    temporaryDirectories.push(workspace);
    const artifactRoot = 'data/batches/F002/work-artifacts/000473' as WorkspaceRelativePath;
    const target = join(workspace, ...artifactRoot.split('/'));
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'bungo-batch-link-outside-'));
    temporaryDirectories.push(outside);
    const stageName = '.000473.stage-abcdef';
    try {
      await symlink(outside, join(parent, stageName), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await writeFile(join(parent, '.000473.promotion-journal.json'), JSON.stringify({
      version: 1, phase: 'prepared', targetName: '000473', stagingName: stageName,
      backupName: '.000473.backup-00000000-0000-4000-8000-000000000000',
      expectedOldSha256: null, expectedNewSha256: 'a'.repeat(64),
    }), 'utf8');
    await expect(recoverBatchSourceArtifactPromotion(workspace, artifactRoot)).rejects.toMatchObject({
      code: 'BATCH_WORKSPACE_MISMATCH',
    });
  });
});

describe('batch candidate normalization [DES-F002-004]', () => {
  /** @des DES-F002-004 @fun FUN-F002-008 @test UT-F002-008 */
  it('ruby表示と読みを分離し同一入力から同じID/hashを作る', () => {
    const first = normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES);
    const second = normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES);
    expect(first).toMatchObject({ displayText: '「よだかは星です」', speechText: '「よだかはほしです」', revisions: [] });
    expect(first.candidateId).toBe(second.candidateId);
    expect(first.sha256).toBe(second.sha256);
  });

  /** @des DES-F002-004 @fun FUN-F002-008 @test UT-F002-008 */
  it('revision gap・before不一致・旧candidate ID転用を拒否する', () => {
    const base = normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES);
    const revision = (overrides: Partial<SpeechRevision> = {}): SpeechRevision => ({
      candidateId: base.candidateId, revision: 1, before: base.speechText, after: `${base.speechText}。`,
      reason: '読み補正', reviewer: 'reviewer', reviewedAt: '2026-07-20T00:00:00Z', ...overrides,
    });
    expect(() => normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES, [revision({ revision: 2 })]))
      .toThrowError(expect.objectContaining({ code: 'SPEECH_REVISION_GAP' }));
    expect(() => normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES, [revision({ before: '別文' })]))
      .toThrowError(expect.objectContaining({ code: 'SPEECH_REVISION_MISMATCH' }));
    expect(() => normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES, [revision()]))
      .toThrowError(expect.objectContaining({ code: 'SPEECH_REVISION_MISMATCH' }));
    expect(() => normalizeBatchCandidate(rawCandidate(), DEFAULT_BATCH_SPEECH_RULES, [revision({
      after: 'あ'.repeat(32_769), reviewedAt: '2026-07-20 00:00:00',
    })])).toThrowError(expect.objectContaining({ code: 'SPEECH_REVISION_MISMATCH' }));
  });
});
