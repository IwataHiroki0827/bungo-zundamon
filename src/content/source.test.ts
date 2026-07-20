import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  AOZORA_BIBLIOGRAPHY_ENTRY,
  AOZORA_TIMEOUT_MS,
  AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS,
  AOZORA_BIBLIOGRAPHY_URL,
  AOZORA_USER_AGENT,
  INITIAL_EDITION_RULES,
  MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
  MAX_BIBLIOGRAPHY_CSV_BYTES,
  ProductionAozoraTransport,
  SourcePipelineError,
  buildProvenance,
  decodeAozoraSource,
  extractVerifiedBibliographyCsv,
  fetchAozoraBibliography,
  fetchAozoraSources,
  isPublicAddress,
  parseAozoraBibliography,
  resolveEdition,
  revalidateWorkRights,
  selectBatchWorks,
  selectEligibleWorks,
  type BatchSelectionManifest,
  type BibliographyRow,
  type BibliographySnapshot,
  type EditionRule,
  type PinnedRequest,
  type SelectedWork,
  type SourceRecord,
  type TransportResponse,
  type WorkRightsObservation,
} from './source';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bungo-source-ut-'));
  temporaryDirectories.push(path);
  return path;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const TEST_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function testCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (TEST_CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

interface ZipFixtureOptions {
  readonly entryName?: string;
  readonly localEntryName?: string;
  readonly method?: number;
  readonly flags?: number;
  readonly localFlags?: number;
  readonly localMethod?: number;
  readonly crc?: number;
  readonly localCrc?: number;
  readonly declaredCsvBytes?: number;
  readonly localDeclaredCsvBytes?: number;
  readonly declaredCompressedBytes?: number;
  readonly localDeclaredCompressedBytes?: number;
  readonly entries?: number;
  readonly disk?: number;
  readonly versionMadeBy?: number;
  readonly externalAttributes?: number;
  readonly centralExtra?: Uint8Array;
  readonly localExtra?: Uint8Array;
}

function zipFixture(csv: Uint8Array, options: ZipFixtureOptions = {}): Uint8Array {
  const name = Buffer.from(options.entryName ?? AOZORA_BIBLIOGRAPHY_ENTRY, 'utf8');
  const localName = Buffer.from(options.localEntryName ?? options.entryName ?? AOZORA_BIBLIOGRAPHY_ENTRY, 'utf8');
  const method = options.method ?? 8;
  const compressed = method === 0 ? Buffer.from(csv) : deflateRawSync(csv);
  const crc = options.crc ?? testCrc32(csv);
  const centralExtra = Buffer.from(options.centralExtra ?? []);
  const localExtra = Buffer.from(options.localExtra ?? []);
  const declaredCsvBytes = options.declaredCsvBytes ?? csv.byteLength;
  const declaredCompressedBytes = options.declaredCompressedBytes ?? compressed.byteLength;

  const local = Buffer.alloc(30 + localName.byteLength + localExtra.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(options.localFlags ?? options.flags ?? 0, 6);
  local.writeUInt16LE(options.localMethod ?? method, 8);
  local.writeUInt32LE(options.localCrc ?? crc, 14);
  local.writeUInt32LE(options.localDeclaredCompressedBytes ?? declaredCompressedBytes, 18);
  local.writeUInt32LE(options.localDeclaredCsvBytes ?? declaredCsvBytes, 22);
  local.writeUInt16LE(localName.byteLength, 26);
  local.writeUInt16LE(localExtra.byteLength, 28);
  localName.copy(local, 30);
  localExtra.copy(local, 30 + localName.byteLength);

  const centralOffset = local.byteLength + compressed.byteLength;
  const central = Buffer.alloc(46 + name.byteLength + centralExtra.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(options.versionMadeBy ?? 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(options.flags ?? 0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(declaredCompressedBytes, 20);
  central.writeUInt32LE(declaredCsvBytes, 24);
  central.writeUInt16LE(name.byteLength, 28);
  central.writeUInt16LE(centralExtra.byteLength, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(options.disk ?? 0, 34);
  central.writeUInt32LE(options.externalAttributes ?? 0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  centralExtra.copy(central, 46 + name.byteLength);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.disk ?? 0, 4);
  eocd.writeUInt16LE(options.disk ?? 0, 6);
  eocd.writeUInt16LE(options.entries ?? 1, 8);
  eocd.writeUInt16LE(options.entries ?? 1, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

function bibliographySnapshot(overrides: Partial<BibliographySnapshot> = {}): BibliographySnapshot {
  return {
    sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
    archivePath: 'list_person_all_extended_utf8.zip',
    archiveSha256: 'b'.repeat(64),
    archiveBytes: 2_092_030,
    csvPath: AOZORA_BIBLIOGRAPHY_ENTRY,
    csvEntry: AOZORA_BIBLIOGRAPHY_ENTRY,
    csvSha256: 'c'.repeat(64),
    csvBytes: 17_153_006,
    mediaType: 'application/zip',
    fetchedAt: '2026-07-18T00:00:00.000Z',
    schemaVersion: 'schema-1',
    ...overrides,
  };
}

function row(overrides: Partial<BibliographyRow> = {}): BibliographyRow {
  return {
    workId: '000127',
    title: '羅生門',
    personId: '000879',
    role: '著者',
    copyright: '著作権なし',
    status: '公開中',
    language: '日本語原著',
    sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/127_15260.html',
    cardUrl: 'https://www.aozora.gr.jp/cards/000879/card127.html',
    charset: 'UTF-8',
    ...overrides,
  };
}

function selected(overrides: Partial<SelectedWork> = {}): SelectedWork {
  return {
    ...row(),
    charset: 'UTF-8',
    selectionReason: '新字新仮名版を優先',
    ...overrides,
  };
}

const MIYAZAWA_MANIFEST: BatchSelectionManifest = Object.freeze({
  batchId: 'F002',
  feature: 'F002',
  schemaVersion: '1.0.0',
  status: 'draft',
  author: Object.freeze({
    authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji',
    identitySha256: 'a'.repeat(64),
  }),
  workIds: Object.freeze(['000473', '043752', '043754']),
  workProgress: Object.freeze([
    Object.freeze({ workId: '000473', status: 'pending', stageRecords: Object.freeze([]) }),
    Object.freeze({ workId: '043752', status: 'pending', stageRecords: Object.freeze([]) }),
    Object.freeze({ workId: '043754', status: 'pending', stageRecords: Object.freeze([]) }),
  ]),
  inputPaths: Object.freeze(['data/batches/F002/selected-works.json']),
  outputPaths: Object.freeze(['content/batches/F002/provenance.json']),
  stageRecords: Object.freeze([]),
  rightsSnapshotIds: Object.freeze(['aozora-selection-2026-07-20']),
  voiceConfigRef: 'content/batches/F002/voice-config.json',
  artworkProvenanceRef: 'content/batches/F002/artwork-provenance.json',
  editionRules: Object.freeze([
    Object.freeze({ title: 'よだかの星', preferredWorkId: '000473', allowedWorkIds: Object.freeze(['000473']), reason: '承認済み代表作' }),
    Object.freeze({ title: 'どんぐりと山猫', preferredWorkId: '043752', allowedWorkIds: Object.freeze(['043752']), reason: '承認済み代表作' }),
    Object.freeze({ title: '注文の多い料理店', preferredWorkId: '043754', allowedWorkIds: Object.freeze(['043754']), reason: '承認済み代表作' }),
  ]),
} as unknown as BatchSelectionManifest);

function miyazawaRows(): BibliographyRow[] {
  return [
    ['000473', 'よだかの星', '473_00001.html'],
    ['043752', 'どんぐりと山猫', '43752_00001.html'],
    ['043754', '注文の多い料理店', '43754_00001.html'],
  ].map(([workId = '', title = '', file = '']) => ({
    workId,
    title,
    personId: '000081',
    personCopyright: 'なし',
    role: '著者',
    copyright: 'なし',
    status: '公開中',
    language: '日本語原著',
    orthography: '新字新仮名',
    sourceUrl: `https://www.aozora.gr.jp/cards/000081/files/${file}`,
    cardUrl: `https://www.aozora.gr.jp/cards/000081/card${Number(workId)}.html`,
    charset: 'UTF-8',
    edition: '新字新仮名版',
  }));
}

function bibliographyCsv(rows: readonly BibliographyRow[]): Uint8Array {
  const records = rows.map((item) => AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map((column) => ({
    作品ID: String(Number(item.workId)),
    作品名: item.title,
    文字遣い種別: item.orthography ?? '',
    作品著作権フラグ: item.copyright,
    図書カードURL: item.cardUrl ?? '',
    人物ID: String(Number(item.personId)),
    人物著作権フラグ: item.personCopyright ?? '',
    役割フラグ: item.role,
    底本名1: item.edition ?? '',
    入力者: item.inputter ?? '入力者',
    校正者: item.proofreader ?? '校正者',
    'XHTML/HTMLファイルURL': item.sourceUrl,
    'XHTML/HTMLファイル符号化方式': item.charset ?? '',
    'XHTML/HTMLファイル文字集合': item.charset ?? '',
  } as Record<string, string>)[column] ?? '').join(','));
  return new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${records.join('\n')}\n`);
}

function productionTransport(response: TransportResponse | Error): {
  transport: ProductionAozoraTransport;
  socket: ReturnType<typeof vi.fn<(request: PinnedRequest) => Promise<TransportResponse>>>;
} {
  const socket = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    transport: new ProductionAozoraTransport({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      pinnedSocketFactory: socket,
    }),
    socket,
  };
}

// IT-F001-001: 書誌選定、固定URLの原典取得、由来記録を結合して追跡する。
describe('原典選定・取得・由来', () => {
  /** @des DES-F001-003 @fun FUN-F001-005 @test UT-F001-005 */
  it('適格な書誌行だけを安定順序で残し、不正行を診断する', () => {
    const diagnostics: Parameters<typeof selectEligibleWorks>[1] = [];
    const result = selectEligibleWorks([
      row({ workId: '043015', title: '杜子春' }),
      row({ workId: '000092', title: '蜘蛛の糸' }),
      row({ workId: '000004', role: '翻訳者' }),
      row({ workId: '000005', copyright: 'afterlife' }),
      row({ workId: '000006', status: '非公開' }),
      row({ workId: '000007', language: '翻訳' }),
      row({ workId: '000008', role: '未知役割' }),
    ], diagnostics);

    expect(result.map(({ workId }) => workId)).toEqual(['000092', '043015']);
    expect(diagnostics).toEqual([{ row: 6, code: 'UNKNOWN_ROLE', field: 'role', value: '未知役割' }]);
    expect(() => selectEligibleWorks([])).toThrowError(expect.objectContaining({ code: 'NO_ELIGIBLE_WORKS' }));
    expect(() => selectEligibleWorks([row({ copyright: '未知' })])).toThrowError(
      expect.objectContaining({ code: 'NO_ELIGIBLE_WORKS' }),
    );
  });

  /** @des DES-F001-003 @fun FUN-F001-006 @test UT-F001-006 */
  it('明示した作品ID規則で3作品の版を解決し、同名別作品や異常規則を拒否する', () => {
    const candidates = [
      row({ workId: '000127', title: '羅生門' }),
      row({ workId: '000092', title: '蜘蛛の糸' }),
      row({ workId: '043015', title: '杜子春' }),
      row({ workId: '099999', title: '仙人' }),
    ].map((item) => ({ ...item, charset: 'UTF-8' as const }));
    const rules: EditionRule[] = INITIAL_EDITION_RULES.map((rule) => ({ ...rule, allowedWorkIds: [...rule.allowedWorkIds] }));

    expect(resolveEdition(candidates, rules).map(({ workId }) => workId)).toEqual(['000127', '000092', '043015']);
    expect(() => resolveEdition(candidates, [{ ...rules[0]!, preferredWorkId: '' }, rules[1]!, rules[2]!])).toThrowError(
      expect.objectContaining({ code: 'TITLE_ONLY_EDITION_RULE' }),
    );
    expect(() => resolveEdition(candidates, [{ ...rules[0]!, preferredWorkId: '099999' }, rules[1]!, rules[2]!])).toThrowError(
      expect.objectContaining({ code: 'WORK_NOT_ALLOWED' }),
    );
    expect(() => resolveEdition(candidates, [{ ...rules[0]!, fallbackWorkIds: ['000127'] }, rules[1]!, rules[2]!])).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_EDITION_ID' }),
    );
    expect(() => resolveEdition(candidates, [
      { ...rules[0]!, allowedWorkIds: ['000127', '099999'] }, rules[1]!, rules[2]!,
    ])).toThrowError(expect.objectContaining({ code: 'WORK_NOT_ALLOWED' }));
  });

  /** @des DES-F002-004 DES-F002-009 @fun FUN-F002-006 @test UT-F002-006 */
  it('manifestの宮沢作者・3作品allowlist順で選定しselection権利観測へ固定する', () => {
    const rows = miyazawaRows();
    const raw = bibliographyCsv(rows);
    const result = selectBatchWorks(rows.toReversed(), MIYAZAWA_MANIFEST, new Date('2026-07-20T01:00:00.000Z'), {
      sha256: hash(raw),
    });

    expect(result.works.map(({ workId }) => workId)).toEqual(['000473', '043752', '043754']);
    expect(result.observation).toMatchObject({
      phase: 'selection',
      bibliographySha256: hash(raw),
      observedAt: '2026-07-20T01:00:00.000Z',
      works: [
        { workId: '000473', personId: '000081', translatorPresent: false, orthography: '新字新仮名' },
        { workId: '043752', personId: '000081', translatorPresent: false, orthography: '新字新仮名' },
        { workId: '043754', personId: '000081', translatorPresent: false, orthography: '新字新仮名' },
      ],
    });
    expect(result.observation).not.toHaveProperty('releaseCommit');
    expect(result.observation).not.toHaveProperty('runId');
  });

  /** @des DES-F002-004 DES-F002-009 @fun FUN-F002-006 @test UT-F002-006 */
  it.each([
    ['別人物', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, personId: '000879' }; }, 'WORK_ALLOWLIST_MISMATCH'],
    ['別作者著者行混入', (rows: BibliographyRow[]) => { rows.push({ ...rows[0]!, personId: '000879' }); }, 'WORK_ALLOWLIST_MISMATCH'],
    ['役割違い', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, role: '編者' }; }, 'WORK_ROLE_INVALID'],
    ['翻訳者あり', (rows: BibliographyRow[]) => { rows.push({ ...rows[0]!, role: '翻訳者', personId: '000999' }); }, 'WORK_TRANSLATOR_PRESENT'],
    ['作品著作権あり', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, copyright: 'あり' }; }, 'WORK_RIGHTS_INELIGIBLE'],
    ['人物著作権あり', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, personCopyright: 'あり' }; }, 'WORK_RIGHTS_INELIGIBLE'],
    ['非公開', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, status: '非公開' }; }, 'WORK_RIGHTS_INELIGIBLE'],
    ['旧字旧仮名', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, orthography: '旧字旧仮名' }; }, 'WORK_RIGHTS_INELIGIBLE'],
    ['同順位複数版', (rows: BibliographyRow[]) => { rows.push({ ...rows[0]! }); }, 'WORK_EDITION_AMBIGUOUS'],
    ['URLとID混線', (rows: BibliographyRow[]) => { rows[0] = { ...rows[0]!, sourceUrl: rows[1]!.sourceUrl }; }, 'WORK_ALLOWLIST_MISMATCH'],
  ])('%sを全体停止する', (_label, mutate, code) => {
    const rows = miyazawaRows();
    mutate(rows);
    expect(() => selectBatchWorks(rows, MIYAZAWA_MANIFEST, new Date('2026-07-20T01:00:00.000Z')))
      .toThrowError(expect.objectContaining({ code }));
  });

  /** @des DES-F002-004 DES-F002-009 DES-F002-016 @fun FUN-F002-036 @test UT-F002-036 */
  it('deploy直前に公式書誌を再取得しselectionと同じrelease commit/runへ結合する', async () => {
    const rows = miyazawaRows();
    const raw = bibliographyCsv(rows);
    const selection = selectBatchWorks(rows, MIYAZAWA_MANIFEST, new Date('2026-07-20T01:00:00.000Z'), {
      sha256: hash(raw),
    }).observation;
    const { transport, socket } = productionTransport({
      status: 200,
      headers: { 'content-type': 'application/zip' },
      body: zipFixture(raw),
      elapsedMs: AOZORA_TIMEOUT_MS - 1,
      fetchedAt: '2026-07-20T02:00:00.000Z',
    });

    const decision = await revalidateWorkRights(MIYAZAWA_MANIFEST, 'a'.repeat(40), 'release-F002-1', transport, selection);
    expect(decision).toMatchObject({
      result: 'unchanged',
      releaseCommit: 'a'.repeat(40),
      runId: 'release-F002-1',
      reasons: [],
      predeploy: {
        phase: 'predeploy', releaseCommit: 'a'.repeat(40), runId: 'release-F002-1',
        observedAt: '2026-07-20T02:00:00.000Z',
      },
    });
    expect(socket).toHaveBeenCalledTimes(1);
  });

  /** @des DES-F002-004 DES-F002-014 @fun FUN-F002-007 @test UT-F002-007 */
  it('manifest由来allowlistでF002作品を既存安全transportから取得する', async () => {
    const workspace = await temporaryWorkspace();
    const work = selectBatchWorks(miyazawaRows(), MIYAZAWA_MANIFEST, new Date('2026-07-20T01:00:00Z')).works[0]!;
    const { transport, socket } = productionTransport({
      status: 200, headers: { 'content-type': 'application/xhtml+xml; charset=UTF-8' },
      body: new TextEncoder().encode('<html>よだか</html>'), fetchedAt: '2026-07-20T01:00:00Z',
    });
    const records = await fetchAozoraSources([work], join(workspace, 'sources'), {
      transport, workspaceRoot: workspace,
      allowlist: {
        authorId: '000081',
        works: { '000473': { sourceUrl: work.sourceUrl, cardUrl: work.cardUrl! } },
      },
    });
    expect(records[0]).toMatchObject({ workId: '000473', sourceUrl: work.sourceUrl });
    expect(socket).toHaveBeenCalledWith(expect.objectContaining({ url: new URL(work.sourceUrl) }));
  });

  /** @des DES-F002-004 DES-F002-009 DES-F002-016 @fun FUN-F002-036 @test UT-F002-036 */
  it('権利条件変更とselection観測のpredeploy再利用をblockedにする', async () => {
    const rows = miyazawaRows();
    const raw = bibliographyCsv(rows);
    const selection = selectBatchWorks(rows, MIYAZAWA_MANIFEST, new Date('2026-07-20T01:00:00.000Z'), {
      sha256: hash(raw),
    }).observation;
    const changedRows = miyazawaRows();
    changedRows[0] = { ...changedRows[0]!, copyright: 'あり' };
    const changedRaw = bibliographyCsv(changedRows);
    const { transport } = productionTransport({
      status: 200,
      headers: { 'content-type': 'application/zip' },
      body: zipFixture(changedRaw),
      fetchedAt: '2026-07-20T02:00:00.000Z',
    });
    await expect(revalidateWorkRights(MIYAZAWA_MANIFEST, 'b'.repeat(40), 'release-F002-2', transport, selection))
      .resolves.toMatchObject({ result: 'blocked', reasons: ['WORK_RIGHTS_CHANGED'] });

    const stale = { ...selection, releaseCommit: 'b'.repeat(40), runId: 'old-run' } satisfies WorkRightsObservation;
    await expect(revalidateWorkRights(MIYAZAWA_MANIFEST, 'b'.repeat(40), 'release-F002-2', transport, stale))
      .resolves.toMatchObject({ result: 'blocked', reasons: ['WORK_RIGHTS_OBSERVATION_STALE'] });

    const malformed = { ...selection, bibliographySha256: 'short' } satisfies WorkRightsObservation;
    await expect(revalidateWorkRights(MIYAZAWA_MANIFEST, 'b'.repeat(40), 'release-F002-2', transport, malformed))
      .resolves.toMatchObject({ result: 'blocked', reasons: ['WORK_RIGHTS_SELECTION_MISSING'] });
    await expect(revalidateWorkRights(MIYAZAWA_MANIFEST, 'not-a-sha', 'release-F002-2', transport, selection))
      .rejects.toMatchObject({ code: 'WORK_RIGHTS_COMMIT_MISMATCH' });
    await expect(revalidateWorkRights(MIYAZAWA_MANIFEST, 'b'.repeat(40), '../unsafe run', transport, selection))
      .rejects.toMatchObject({ code: 'WORK_RIGHTS_OBSERVATION_STALE' });
  });

  /** @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 @test UT-F001-007 */
  it('production transportがDNS pinとTLS hostname検証を維持し、要求を直列化する', async () => {
    const pinnedRequests: PinnedRequest[] = [];
    let active = 0;
    let maxActive = 0;
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]);
    const transport = new ProductionAozoraTransport({
      resolver,
      pinnedSocketFactory: async (request) => {
        pinnedRequests.push(request);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          status: 200,
          headers: { 'content-type': 'application/xhtml+xml; charset=UTF-8' },
          body: new TextEncoder().encode('<html/>'),
          elapsedMs: AOZORA_TIMEOUT_MS - 1,
        };
      },
    });
    const policy = {
      pathPrefix: '/cards/000879/files/',
      allowedMediaTypes: ['application/xhtml+xml'],
      maxBytes: 8_388_608,
      timeoutMs: AOZORA_TIMEOUT_MS,
    };
    await Promise.all([
      transport.request(new URL('https://www.aozora.gr.jp/cards/000879/files/a.html'), policy),
      transport.request(new URL('https://www.aozora.gr.jp/cards/000879/files/b.html'), policy),
    ]);

    expect(maxActive).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(pinnedRequests).toHaveLength(2);
    expect(pinnedRequests[0]).toMatchObject({
      address: '8.8.8.8',
      hostHeader: 'www.aozora.gr.jp',
      serverName: 'www.aozora.gr.jp',
      rejectUnauthorized: true,
      checkServerIdentity: true,
      followRedirects: false,
      useEnvironmentProxy: false,
      userAgent: AOZORA_USER_AGENT,
    });
    expect(pinnedRequests.map(({ userAgent }) => userAgent)).toEqual([AOZORA_USER_AGENT, AOZORA_USER_AGENT]);
    expect(AOZORA_USER_AGENT).not.toMatch(/[\r\n]/u);

    const blocked = new ProductionAozoraTransport({
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      pinnedSocketFactory: vi.fn(),
    });
    await expect(blocked.request(new URL('https://www.aozora.gr.jp/cards/000879/files/a.html'), policy)).rejects.toMatchObject({
      code: 'UNSAFE_RESOLVED_ADDRESS',
    });
  });

  /** @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 @test UT-F001-007 */
  it.each([
    ['127.0.0.1', false],
    ['169.254.1.1', false],
    ['8.8.8.8', true],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['::192.168.1.1', false],
    ['64:ff9b::c0a8:101', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['2001:db8::1', false],
    ['2002:c0a8:101::1', false],
    ['2606:4700:4700::1111', true],
  ])('DNS pin候補 %s のpublic判定は %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  /** @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 @test UT-F001-007 */
  it('原典rawとSourceRecordをまとめて採用し、失敗時は既存artifactを保持する', async () => {
    const workspace = await temporaryWorkspace();
    const output = join(workspace, 'sources');
    const body = new TextEncoder().encode('<meta charset="UTF-8"><p>本文</p>');
    const { transport, socket } = productionTransport({
      status: 200,
      headers: { 'Content-Type': 'application/xhtml+xml; charset=UTF-8' },
      body,
      fetchedAt: '2026-07-18T00:00:00.000Z',
      elapsedMs: 100,
    });
    const records = await fetchAozoraSources([selected()], output, { transport, workspaceRoot: workspace });

    expect(records[0]).toMatchObject({ workId: '000127', rawSha256: hash(body), httpCharset: 'UTF-8' });
    expect(await readFile(join(output, '000127', 'source.raw'))).toEqual(Buffer.from(body));
    expect(JSON.parse(await readFile(join(output, '000127', 'source.json'), 'utf8'))).toEqual(records[0]);
    expect(socket).toHaveBeenCalledTimes(1);

    await writeFile(join(output, 'sentinel.txt'), '保持対象', 'utf8');
    const failed = productionTransport(new SourcePipelineError('TLS_FAILURE', '証明書異常')).transport;
    await expect(fetchAozoraSources([selected()], output, { transport: failed, workspaceRoot: workspace })).rejects.toMatchObject({
      code: 'TLS_FAILURE',
    });
    expect(await readFile(join(output, 'sentinel.txt'), 'utf8')).toBe('保持対象');
  });

  /** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-006 FUN-F001-007 @test UT-F001-006 UT-F001-007 */
  it('杜子春No.43015をcanonical ID 043015と公式XHTML URLで取得する', async () => {
    const workspace = await temporaryWorkspace();
    const body = new TextEncoder().encode('<meta charset="Shift_JIS"><div class="main_text">本文</div>');
    const { transport, socket } = productionTransport({
      status: 200,
      headers: { 'content-type': 'application/xhtml+xml; charset=Shift_JIS' },
      body,
      fetchedAt: '2026-07-18T00:00:00.000Z',
    });
    const records = await fetchAozoraSources([selected({
      workId: '043015',
      title: '杜子春',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/43015_17432.html',
      cardUrl: 'https://www.aozora.gr.jp/cards/000879/card43015.html',
      charset: 'Shift_JIS',
    })], join(workspace, 'sources'), { transport, workspaceRoot: workspace });

    expect(records[0]).toMatchObject({
      workId: '043015',
      rawPath: '043015/source.raw',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/43015_17432.html',
      bibliographyCharset: 'Shift_JIS',
    });
    expect(socket).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL('https://www.aozora.gr.jp/cards/000879/files/43015_17432.html'),
    }));
  });

  /** @des DES-F001-003 DES-F001-004 @fun FUN-F001-006 FUN-F001-007 @test UT-F001-006 UT-F001-007 */
  it.each([
    ['XHTML', { sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/127_other.html' }, 'SOURCE_URL_MISMATCH'],
    ['図書カード', { cardUrl: 'https://www.aozora.gr.jp/cards/000879/card92.html' }, 'CARD_URL_MISMATCH'],
  ])('作品IDと固定%s URLの不一致を取得前に拒否する', async (_label, overrides, code) => {
    const workspace = await temporaryWorkspace();
    const { transport, socket } = productionTransport({ status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array([1]) });
    await expect(fetchAozoraSources([selected(overrides)], join(workspace, 'sources'), {
      transport,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code });
    expect(socket).not.toHaveBeenCalled();
  });

  /** @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 FUN-F001-041 @test UT-F001-007 UT-F001-041 */
  it('任意transportをcastしてもproduction取得入口を迂回できない', async () => {
    const workspace = await temporaryWorkspace();
    const fake = { request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) };
    await expect(fetchAozoraSources([selected()], join(workspace, 'sources'), {
      transport: fake as unknown as ProductionAozoraTransport,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'PRODUCTION_TRANSPORT_REQUIRED' });
    await expect(fetchAozoraBibliography(
      new URL('https://www.aozora.gr.jp/index_pages/list.csv'),
      join(workspace, 'bibliography'),
      fake as unknown as ProductionAozoraTransport,
      { workspaceRoot: workspace },
    )).rejects.toMatchObject({ code: 'PRODUCTION_TRANSPORT_REQUIRED' });
  });

  /** @des DES-F001-004 DES-F001-012 DES-F001-017 @fun FUN-F001-008 @test UT-F001-008 */
  it('由来の必須情報とhash一致、CC BY 4.0変更表示を検証する', () => {
    const rawSha256 = 'a'.repeat(64);
    const source: SourceRecord = {
      workId: '000127',
      rawPath: '000127/source.raw',
      rawSha256,
      mediaType: 'application/xhtml+xml',
      httpCharset: 'UTF-8',
      bibliographyCharset: 'UTF-8',
      fetchedAt: '2026-07-18T00:00:00.000Z',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/000127.html',
    };
    const metadata = {
      stableCardUrl: 'https://www.aozora.gr.jp/cards/000879/card1.html',
      baseEdition: '底本 初版',
      inputter: '入力者',
      proofreader: '校正者',
      toolVersion: '1.0.0',
      transformation: 'rubyを中間tokenへ変換',
      changeNotice: 'CC BY 4.0に基づく変更: 台詞抽出と音声用正規化',
      sourceSha256: rawSha256,
    };
    const bibliography = bibliographySnapshot();
    expect(buildProvenance(source, metadata, bibliography)).toMatchObject({
      workId: '000127',
      sourceSha256: rawSha256,
      bibliography: {
        sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
        archiveSha256: bibliography.archiveSha256,
        archiveBytes: bibliography.archiveBytes,
        csvEntry: AOZORA_BIBLIOGRAPHY_ENTRY,
        csvSha256: bibliography.csvSha256,
        csvBytes: bibliography.csvBytes,
        schemaVersion: bibliography.schemaVersion,
      },
    });
    expect(() => buildProvenance(source, { ...metadata, inputter: ' ' }, bibliography)).toThrowError(
      expect.objectContaining({ code: 'PROVENANCE_MISSING' }),
    );
    expect(() => buildProvenance(source, { ...metadata, sourceSha256: 'b'.repeat(64) }, bibliography)).toThrowError(
      expect.objectContaining({ code: 'PROVENANCE_HASH_MISMATCH' }),
    );
    expect(() => buildProvenance(source, { ...metadata, changeNotice: '変更あり' }, bibliography)).toThrowError(
      expect.objectContaining({ code: 'CHANGE_NOTICE_MISSING' }),
    );
    for (const field of [
      'stableCardUrl', 'baseEdition', 'inputter', 'proofreader', 'toolVersion',
      'transformation', 'changeNotice', 'sourceSha256',
    ] as const) {
      expect(() => buildProvenance(source, { ...metadata, [field]: ' ' }, bibliography), field).toThrowError(
        expect.objectContaining({ code: 'PROVENANCE_MISSING' }),
      );
    }
    expect(() => buildProvenance({ ...source, sourceUrl: ' ' }, metadata, bibliography)).toThrowError(
      expect.objectContaining({ code: 'PROVENANCE_MISSING' }),
    );
    expect(() => buildProvenance({ ...source, fetchedAt: ' ' }, metadata, bibliography)).toThrowError(
      expect.objectContaining({ code: 'PROVENANCE_MISSING' }),
    );
    for (const invalid of [
      bibliographySnapshot({ sourceUrl: 'https://www.aozora.gr.jp/index_pages/other.zip' }),
      bibliographySnapshot({ archiveSha256: '' }),
      bibliographySnapshot({ archiveBytes: 0 }),
      bibliographySnapshot({ csvEntry: 'other.csv' }),
      bibliographySnapshot({ csvSha256: '0' }),
      bibliographySnapshot({ csvBytes: -1 }),
      bibliographySnapshot({ schemaVersion: ' ' }),
    ]) {
      expect(() => buildProvenance(source, metadata, invalid)).toThrowError(
        expect.objectContaining({ code: 'PROVENANCE_BIBLIOGRAPHY_INVALID' }),
      );
    }
  });
});

describe('charset decodeと公式書誌snapshot', () => {
  function record(raw: Uint8Array, overrides: Partial<SourceRecord> = {}): SourceRecord {
    return {
      workId: '000127',
      rawPath: '000127/source.raw',
      rawSha256: hash(raw),
      mediaType: 'application/xhtml+xml',
      httpCharset: null,
      bibliographyCharset: 'UTF-8',
      fetchedAt: '2026-07-18T00:00:00.000Z',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/000127.html',
      ...overrides,
    };
  }

  /** @des DES-F001-004 DES-F001-005 DES-F001-019 @fun FUN-F001-040 @test UT-F001-040 */
  it('一致するHTTP→meta→書誌charsetを採用し、UTF-8とShift_JISをfatal decodeする', () => {
    const utf8 = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><meta charset="utf_8"><p>本文</p>');
    const decoded = decodeAozoraSource(record(utf8, { httpCharset: 'UTF-8' }), utf8);
    expect(decoded).toMatchObject({ adoptedCharset: 'UTF-8', metaCharset: 'UTF-8' });
    expect(decoded.text).toContain('本文');

    const ascii = new TextEncoder().encode('<meta charset="Shift_JIS"><p>');
    const suffix = new TextEncoder().encode('</p>');
    const shiftJis = Uint8Array.from([...ascii, 0x82, 0xa0, ...suffix]);
    const shiftDecoded = decodeAozoraSource(record(shiftJis, { bibliographyCharset: 'Shift_JIS' }), shiftJis);
    expect(shiftDecoded.adoptedCharset).toBe('Shift_JIS');
    expect(shiftDecoded.text).toContain('あ');
  });

  /** @des DES-F001-004 DES-F001-005 DES-F001-019 @fun FUN-F001-040 @test UT-F001-040 */
  it('hash、宣言欠落・不一致・非allowlist・decode異常を理由付きで拒否しrawを変えない', () => {
    const raw = new TextEncoder().encode('<meta charset="UTF-8"><p>本文</p>');
    const before = raw.slice();
    expect(() => decodeAozoraSource(record(raw, { rawSha256: '0'.repeat(64) }), raw)).toThrowError(
      expect.objectContaining({ code: 'RAW_HASH_MISMATCH' }),
    );
    expect(() => decodeAozoraSource(record(raw, { httpCharset: 'Shift_JIS' }), raw)).toThrowError(
      expect.objectContaining({ code: 'CHARSET_CONFLICT' }),
    );
    expect(() => decodeAozoraSource(record(raw, { bibliographyCharset: 'ISO-2022-JP' as never }), raw)).toThrowError(
      expect.objectContaining({ code: 'CHARSET_NOT_ALLOWED' }),
    );
    const noDeclaration = new TextEncoder().encode('<p>本文</p>');
    expect(() => decodeAozoraSource(record(noDeclaration, { bibliographyCharset: null }), noDeclaration)).toThrowError(
      expect.objectContaining({ code: 'CHARSET_MISSING' }),
    );
    const invalidUtf8 = Uint8Array.from([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x55, 0x54, 0x46, 0x2d, 0x38, 0x3e, 0xff]);
    expect(() => decodeAozoraSource(record(invalidUtf8), invalidUtf8)).toThrowError(
      expect.objectContaining({ code: 'DECODE_FAILED' }),
    );
    expect(raw).toEqual(before);
  });

  /** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-041 @test UT-F001-041 */
  it('公式書誌ZIPと固定CSVを検証してatomic snapshot化し、異常時は既存snapshotを維持する', async () => {
    const workspace = await temporaryWorkspace();
    const output = join(workspace, 'bibliography');
    const raw = new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map(() => '値').join(',')}\n`);
    const archive = zipFixture(raw);
    const { transport, socket } = productionTransport({
      status: 200,
      headers: { 'content-type': 'application/zip' },
      body: archive,
      elapsedMs: AOZORA_TIMEOUT_MS - 1,
      fetchedAt: '2026-07-18T00:00:00.000Z',
    });
    const snapshot = await fetchAozoraBibliography(
      new URL(AOZORA_BIBLIOGRAPHY_URL),
      output,
      transport,
      { workspaceRoot: workspace },
    );
    expect(snapshot).toMatchObject({
      archiveSha256: hash(archive), archiveBytes: archive.byteLength,
      csvSha256: hash(raw), csvBytes: raw.byteLength,
      csvEntry: AOZORA_BIBLIOGRAPHY_ENTRY, mediaType: 'application/zip',
    });
    expect(await readFile(join(output, snapshot.archivePath))).toEqual(Buffer.from(archive));
    expect(await readFile(join(output, snapshot.csvPath))).toEqual(Buffer.from(raw));
    expect(socket).toHaveBeenCalledTimes(1);

    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'sentinel.txt'), 'byte不変', 'utf8');
    const badSchema = productionTransport({
      status: 200,
      headers: { 'content-type': 'application/zip' },
      body: zipFixture(new TextEncoder().encode('壊れたheaderだけ')),
    });
    await expect(fetchAozoraBibliography(
      new URL(AOZORA_BIBLIOGRAPHY_URL),
      output,
      badSchema.transport,
      { workspaceRoot: workspace },
    )).rejects.toMatchObject({ code: 'BIBLIOGRAPHY_SCHEMA' });
    expect(await readFile(join(output, 'sentinel.txt'), 'utf8')).toBe('byte不変');
  });

  /** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-041 @test UT-F001-041 */
  it('store/deflateの固定entryとCRCを受理し、危険なZIP構造を理由付きで拒否する', () => {
    const csv = new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n値,値\n`);
    expect(Buffer.from(extractVerifiedBibliographyCsv(zipFixture(csv, { method: 0 })))).toEqual(Buffer.from(csv));
    expect(Buffer.from(extractVerifiedBibliographyCsv(zipFixture(csv, { method: 8 })))).toEqual(Buffer.from(csv));
    expect(Buffer.from(extractVerifiedBibliographyCsv(zipFixture(csv, {
      versionMadeBy: (3 << 8) | 20,
      externalAttributes: ((0x8000 | 0x1a4) << 16) >>> 0,
    })))).toEqual(Buffer.from(csv));

    const zip64Extra = Uint8Array.from([1, 0, 0, 0]);
    const cases: Array<[string, Uint8Array]> = [
      ['entry追加', zipFixture(csv, { entries: 2 })],
      ['multi-disk', zipFixture(csv, { disk: 1 })],
      ['暗号化', zipFixture(csv, { flags: 1, localFlags: 1 })],
      ['masked header', zipFixture(csv, { flags: 0x2000, localFlags: 0x2000 })],
      ['data descriptor', zipFixture(csv, { flags: 8, localFlags: 8 })],
      ['ZIP64', zipFixture(csv, { centralExtra: zip64Extra, localExtra: zip64Extra })],
      ['symlink', zipFixture(csv, { versionMadeBy: (3 << 8) | 20, externalAttributes: (0xa000 << 16) >>> 0 })],
      ['未知creator OS', zipFixture(csv, { versionMadeBy: (2 << 8) | 20 })],
      ['絶対path', zipFixture(csv, { entryName: '/list_person_all_extended_utf8.csv' })],
      ['親path', zipFixture(csv, { entryName: '../list_person_all_extended_utf8.csv' })],
      ['backslash', zipFixture(csv, { entryName: 'dir\\list_person_all_extended_utf8.csv' })],
      ['別entry', zipFixture(csv, { entryName: 'other.csv' })],
      ['unsupported method', zipFixture(csv, { method: 12 })],
      ['header flag不一致', zipFixture(csv, { flags: 0, localFlags: 0x800 })],
      ['header name不一致', zipFixture(csv, { localEntryName: `x${AOZORA_BIBLIOGRAPHY_ENTRY.slice(1)}` })],
      ['header method不一致', zipFixture(csv, { method: 8, localMethod: 0 })],
      ['header CRC不一致', zipFixture(csv, { localCrc: 0 })],
      ['header compressed size不一致', zipFixture(csv, { localDeclaredCompressedBytes: deflateRawSync(csv).byteLength + 1 })],
      ['header uncompressed size不一致', zipFixture(csv, { localDeclaredCsvBytes: csv.byteLength + 1 })],
      ['CRC異常', zipFixture(csv, { crc: 0 })],
      ['32MiB超過宣言', zipFixture(csv, { declaredCsvBytes: 33_554_433, localDeclaredCsvBytes: 33_554_433 })],
      ['展開率20超過', zipFixture(csv, { declaredCsvBytes: 1_000, localDeclaredCsvBytes: 1_000, declaredCompressedBytes: 1, localDeclaredCompressedBytes: 1 })],
      ['local header前data', Buffer.concat([Uint8Array.of(0), zipFixture(csv)])],
    ];
    for (const [label, archive] of cases) {
      expect(() => extractVerifiedBibliographyCsv(archive), label).toThrowError(SourcePipelineError);
    }
  });

  /** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-041 @test UT-F001-041 */
  it('展開比20.0ちょうどを受理し、20をわずかでも超える実deflate streamを拒否する', () => {
    const ratioCsv = (randomBytes: number): Uint8Array => {
      const bytes = new Uint8Array(20_000);
      let random = 0x12345678;
      for (let index = 0; index < randomBytes; index += 1) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        bytes[index] = random & 0xff;
      }
      return bytes;
    };
    const exact = ratioCsv(880);
    const over = ratioCsv(879);
    expect(deflateRawSync(exact).byteLength).toBe(1_000);
    expect(exact.byteLength / deflateRawSync(exact).byteLength).toBe(20);
    expect(extractVerifiedBibliographyCsv(zipFixture(exact)).byteLength).toBe(exact.byteLength);

    expect(deflateRawSync(over).byteLength).toBe(999);
    expect(over.byteLength / deflateRawSync(over).byteLength).toBeGreaterThan(20);
    expect(() => extractVerifiedBibliographyCsv(zipFixture(over))).toThrowError(
      expect.objectContaining({ code: 'BIBLIOGRAPHY_ZIP_BOMB' }),
    );
  });

  /** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-041 @test UT-F001-041 */
  it('圧縮ZIP 8MiBと展開CSV 32MiBの上限値を受理する', () => {
    const overhead = zipFixture(Uint8Array.of(1), { method: 0 }).byteLength - 1;
    const archiveBoundaryCsv = new Uint8Array(MAX_BIBLIOGRAPHY_ARCHIVE_BYTES - overhead);
    const archiveBoundary = zipFixture(archiveBoundaryCsv, { method: 0 });
    expect(archiveBoundary.byteLength).toBe(MAX_BIBLIOGRAPHY_ARCHIVE_BYTES);
    expect(extractVerifiedBibliographyCsv(archiveBoundary).byteLength).toBe(archiveBoundaryCsv.byteLength);

    const csvBoundary = new Uint8Array(MAX_BIBLIOGRAPHY_CSV_BYTES);
    let random = 0x12345678;
    for (let index = 0; index < csvBoundary.length; index += 7) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      csvBoundary[index] = random & 0xff;
    }
    const csvBoundaryArchive = zipFixture(csvBoundary);
    expect(csvBoundaryArchive.byteLength).toBeLessThanOrEqual(MAX_BIBLIOGRAPHY_ARCHIVE_BYTES);
    expect(extractVerifiedBibliographyCsv(csvBoundaryArchive).byteLength).toBe(MAX_BIBLIOGRAPHY_CSV_BYTES);
  }, 20_000);

  /** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-041 @test UT-F001-041 */
  it('固定URL、application/zip、圧縮8MiB境界をfail-closedで検証する', async () => {
    const workspace = await temporaryWorkspace();
    const validCsv = new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map(() => '値').join(',')}\n`);
    const invalidUrlTransport = productionTransport({ status: 200, headers: { 'content-type': 'application/zip' }, body: zipFixture(validCsv) });
    await expect(fetchAozoraBibliography(
      new URL('https://www.aozora.gr.jp/index_pages/other.zip'),
      join(workspace, 'bibliography'), invalidUrlTransport.transport, { workspaceRoot: workspace },
    )).rejects.toMatchObject({ code: 'BIBLIOGRAPHY_URL' });
    expect(invalidUrlTransport.socket).not.toHaveBeenCalled();

    for (const [headers, body, code] of [
      [{ 'content-type': 'text/csv' }, zipFixture(validCsv), 'UNEXPECTED_MEDIA_TYPE'],
      [{ 'content-type': 'application/zip' }, new Uint8Array(8_388_609), 'SOURCE_TOO_LARGE'],
    ] as const) {
      const current = productionTransport({ status: 200, headers, body });
      await expect(fetchAozoraBibliography(
        new URL(AOZORA_BIBLIOGRAPHY_URL), join(workspace, `bibliography-${code}`), current.transport, { workspaceRoot: workspace },
      )).rejects.toMatchObject({ code });
    }
  });

  /** @des DES-F001-003 @fun FUN-F001-005 @test UT-F001-005 */
  it('公式書誌の役割列から原著・翻訳・不明をfail-closedで分類する', () => {
    const makeRecord = (role: string): string => AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map((column) => ({
      作品ID: '127', 作品名: '羅生門', 文字遣い種別: '新字新仮名', 作品著作権フラグ: 'なし',
      図書カードURL: 'https://www.aozora.gr.jp/cards/000879/card127.html', 人物ID: '879', 役割フラグ: role,
      底本名1: '底本', 入力者: '入力者', 校正者: '校正者',
      'XHTML/HTMLファイルURL': 'https://www.aozora.gr.jp/cards/000879/files/127.html',
      'XHTML/HTMLファイル符号化方式': 'UTF-8', 'XHTML/HTMLファイル文字集合': 'UTF-8',
    } as Record<string, string>)[column]).join(',');
    const raw = new TextEncoder().encode(
      `${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${makeRecord('著者')}\n${makeRecord('翻訳者')}\n${makeRecord('未知')}\n`,
    );
    expect(parseAozoraBibliography(raw).map((item) => item.language)).toEqual(['日本語原著', '翻訳', '不明']);
  });
});
