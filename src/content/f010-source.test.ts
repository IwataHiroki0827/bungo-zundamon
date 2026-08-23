import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from './batch-candidate.ts';
import { EXTRACTOR_VERSION } from './processing.ts';
import {
  ProductionAozoraTransport,
  type TransportResponse,
} from './source.ts';
import {
  POLICY_TRANSPORT_VERSION,
  ProductionPolicyTransport,
  type PolicyTransportResponse,
} from '../notices/policy-snapshots.ts';
import {
  F010SourceError,
  F010_WORKS,
  collectF010SourceSnapshot,
  defineF010AuthorAndWorkRegistry,
  detectF010GaijiElements,
  evaluateF010PolicyClauses,
  evaluateF010RightsAndUsage,
  extractF010DialogueCandidates,
  isVerifiedF010Author,
  normalizeF010AozoraXhtmlEntities,
  parseF010BibliographyV2,
  parseF010SourceRecord,
  rehydrateF010SelectionSnapshot,
  verifyF010AuthorIdentity,
  type F010WorkRegistry,
} from './f010-source.ts';
import type { CatalogV2 } from './processing.ts';

const workspace = resolve('.');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function response(body: Uint8Array, contentType: string): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': contentType },
    body,
    elapsedMs: 14_999,
    fetchedAt: '2026-08-23T00:00:00.000Z',
    complete: true,
    peerAddress: '157.7.107.24',
    socketSecurity: { tlsAuthorized: true, hostnameVerified: true },
  };
}

function fakeAozoraTransport(responses: readonly TransportResponse[]): ProductionAozoraTransport {
  const queue = [...responses];
  return new ProductionAozoraTransport({
    resolver: async () => [{ address: '157.7.107.24', family: 4 }],
    pinnedSocketFactory: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error('unexpected aozora request');
      return next;
    }),
  });
}

const POLICY_BODIES = Object.freeze([
  new TextEncoder().encode(
    '<html><body>VOICEVOX 利用規約。本サービスは無料利用できます。' +
    'VOICEVOXを利用したことがわかるクレジット表記が必要です。</body></html>',
  ),
  new TextEncoder().encode(
    '<html><body>東北ずん子・ずんだもんプロジェクト 音源利用規約。' +
    'ずんだもん音源は非商用利用できます。名前とクレジット表記をしてください。</body></html>',
  ),
  new TextEncoder().encode(
    '<html><body>東北ずん子・ずんだもんプロジェクト キャラクター利用ガイドライン。' +
    'ずんだもんの個人利用はできます。二次創作の非公式ファンサイトとして利用できます。</body></html>',
  ),
]);

function fakePolicyTransport(bodies: readonly Uint8Array[] = POLICY_BODIES): ProductionPolicyTransport {
  let index = 0;
  return new ProductionPolicyTransport({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    pinnedSocketFactory: async (request): Promise<PolicyTransportResponse> => {
      const body = bodies[index];
      index += 1;
      if (!body) throw new Error('unexpected policy request');
      return {
        status: 200,
        mediaType: 'text/html',
        body,
        finalUrl: request.url.href,
        elapsedMs: 14_999,
        fetchedAt: '2026-08-23T00:00:00.000Z',
        transportVersion: POLICY_TRANSPORT_VERSION,
        security: {
          dnsAddresses: ['93.184.216.34'],
          connectedAddress: '93.184.216.34',
          tlsAuthorized: true,
          hostnameVerified: true,
          redirectsFollowed: 0,
          proxyUsed: false,
          attempts: 1,
        },
      };
    },
  });
}

async function realF010Context() {
  return loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F010.ref,
    BATCH_DEFINITION_REFS.F010.sha256,
    APPROVAL_POLICY_REFS.F010.ref,
    APPROVAL_POLICY_REFS.F010.sha256,
  );
}

/** 既に永続化済みの実データ（実HTTPS取得結果）をfixtureとして再利用する。 */
async function realArtifactBytes(relativeDataPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(workspace, relativeDataPath)));
}

async function realResponsesQueue(): Promise<TransportResponse[]> {
  const [archive, authorPage, ...works] = await Promise.all([
    realArtifactBytes('data/batches/F010/source-snapshots/selection/bibliography.zip'),
    realArtifactBytes('data/batches/F010/source-snapshots/selection/author-page.html'),
    ...F010_WORKS.flatMap((work) => [
      realArtifactBytes(`data/batches/F010/source-snapshots/selection/works/${work.workId}/card.html`),
      realArtifactBytes(`data/batches/F010/source-snapshots/selection/works/${work.workId}/source.raw`),
    ]),
  ]);
  const queue = [response(archive, 'application/zip'), response(authorPage, 'text/html')];
  for (let index = 0; index < F010_WORKS.length; index += 1) {
    queue.push(response(works[index * 2]!, 'text/html'));
    queue.push(response(works[index * 2 + 1]!, 'text/html'));
  }
  return queue;
}

/**
 * Shift_JISのbyte列を「文字位置(targetIndex)より前のbyte数」がtargetIndex以上に
 * なる最小byteへ二分探索し、multi-byte文字境界を跨がないよう前後数byteでfatal
 * decodeが通る位置へ調整する。テストfixtureへASCIIのみのtagを安全にsplice挿入する
 * ために使う（gaiji fail-closedケース・長大候補no-opケースの実データ再現用）。
 */
function byteOffsetForStringIndex(rawBytes: Uint8Array, targetIndex: number): number {
  let low = 0;
  let high = rawBytes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const decodedLen = new TextDecoder('shift_jis').decode(rawBytes.subarray(0, mid)).length;
    if (decodedLen < targetIndex) low = mid + 1; else high = mid;
  }
  for (let delta = 0; delta <= 4; delta += 1) {
    for (const candidate of [low + delta, low - delta]) {
      if (candidate < 0 || candidate > rawBytes.length) continue;
      try {
        new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes.subarray(0, candidate));
        return candidate;
      } catch {
        // continue scanning
      }
    }
  }
  throw new Error('clean Shift_JIS byte boundary not found');
}

function spliceAsciiAt(rawBytes: Uint8Array, byteOffset: number, ascii: string): Uint8Array {
  const injectionBytes = new TextEncoder().encode(ascii);
  const spliced = new Uint8Array(rawBytes.length + injectionBytes.length);
  spliced.set(rawBytes.subarray(0, byteOffset), 0);
  spliced.set(injectionBytes, byteOffset);
  spliced.set(rawBytes.subarray(byteOffset), byteOffset + injectionBytes.length);
  return spliced;
}

describe('F010原典・書誌・権利判定（f010-source.ts）', () => {
  /** @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005 */
  it('VOICEVOX/ずんだもん3規約の固定clauseをallow/blocked/unknownへ判定する', () => {
    const allow = evaluateF010PolicyClauses('voicevox-terms', POLICY_BODIES[0]!);
    expect(allow.decision).toBe('allow');
    expect(allow.requiredCredit).toBe('VOICEVOX:ずんだもん');

    const missing = evaluateF010PolicyClauses(
      'zundamon-audio-terms',
      new TextEncoder().encode(
        '<html><body>東北ずん子・ずんだもんプロジェクト 音源利用規約。詳細な利用条件についてはこの文書を参照してください。' +
        'クレジット表記に関する規定は別途定めます。</body></html>',
      ),
    );
    expect(missing.decision).toBe('blocked');
    expect(missing.clauses.some((clause) => clause.status === 'missing')).toBe(true);

    const unknown = evaluateF010PolicyClauses('zundamon-character-guideline', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(unknown.decision).toBe('blocked');
    expect(unknown.clauses.every((clause) => clause.status === 'unknown')).toBe(true);

    expect(() => evaluateF010PolicyClauses('aozora-handling' as never, POLICY_BODIES[0]!))
      .toThrow(F010SourceError);
  });

  /** @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005 */
  it('校正者が非nullの場合だけ書誌V2を受理する', () => {
    const parsed = parseF010BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '000424');
    expect(parsed.proofreader).toBe('校正者1');

    expect(() => parseF010BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: null,
    }, '000424')).toThrow(F010SourceError);
    expect(() => parseF010BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '999999' as never)).toThrow(F010SourceError);
  });

  /** @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005 */
  it('production transport以外・context不一致・phase不正を拒否する', async () => {
    const context = await realF010Context();
    const notProductionTransport = { request: async () => { throw new Error('unused'); } };
    await expect(collectF010SourceSnapshot(
      notProductionTransport as unknown as ProductionAozoraTransport,
      context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F010_TRANSPORT_REQUIRED' });

    await expect(collectF010SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'unknown-phase' as never,
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F010_CONTEXT_INVALID' });

    const f004Context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );
    await expect(collectF010SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      f004Context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F010_CONTEXT_INVALID' });
  });

  /** @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005 */
  it('実際に取得済みの公式artifactを再生した固定応答で3作品分のselection snapshotを固定する', async () => {
    const context = await realF010Context();
    const snapshot = await collectF010SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'selection',
      () => new Date('2026-08-23T19:43:00.225Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    expect(snapshot.authorId).toBe('000074');
    expect(snapshot.works.map((work) => work.workId)).toEqual(['000424', '000419', '000411']);
    expect(snapshot.policies.every((policy) => policy.decision.decision === 'allow')).toBe(true);

    const rights = evaluateF010RightsAndUsage(snapshot, {
      free: true,
      advertising: false,
      payments: false,
      sponsorship: false,
      unofficial: true,
      voiceCredit: 'VOICEVOX:ずんだもん',
    });
    expect(rights.decision).toBe('allow');
    expect(rights.reasons).toEqual([]);

    // 未検証snapshot（mint済みでない値）は権利判定を拒否する（fail-closed）。
    expect(() => evaluateF010RightsAndUsage(
      structuredClone(snapshot) as never,
      {
        free: true, advertising: false, payments: false,
        sponsorship: false, unofficial: true, voiceCredit: 'VOICEVOX:ずんだもん',
      },
    )).toThrow(F010SourceError);
  });

  /**
   * F010は3作品とも実測entity0件（DOMAIN-F010.md §5）で常にpassthroughとなる。
   * ここではＫの昇天(000419)相当の固定応答へ未承認の`&nbsp;`を人為的に混入させ、
   * fail-closed拒否を確認する。
   * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
   */
  it('未定義entity（Ｋの昇天への&nbsp;混入）をfail-closedで拒否する', async () => {
    const context = await realF010Context();
    const queue = await realResponsesQueue();
    const kNoShoutenXhtmlIndex = 2 + F010_WORKS.findIndex((work) => work.workId === '000419') * 2 + 1;
    const tampered = queue[kNoShoutenXhtmlIndex]!;
    const injected = new TextDecoder('shift_jis').decode(tampered.body)
      .replace('<body>', '<body>&nbsp;');
    queue[kNoShoutenXhtmlIndex] = response(Buffer.from(injected, 'latin1'), 'text/html');

    const snapshot = await collectF010SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-23T19:43:00.225Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '000419')!;
    const record = parseF010SourceRecord(workSnapshot, '000419');
    expect(() => normalizeF010AozoraXhtmlEntities(record.raw.bytes, record))
      .toThrow(F010SourceError);
  });

  /** @des DES-F010-005 @des DES-F010-015 @fun FUN-F010-006 @fun FUN-F010-018 @ut UT-F010-006 */
  it('実際に永続化済みの公式snapshotを再mintし、3作品の決定的抽出・gaiji非混入・長大候補非発動を確認する', async () => {
    const context = await realF010Context();
    const snapshot = await rehydrateF010SelectionSnapshot(workspace, context);
    expect(snapshot.works.map((work) => work.workId)).toEqual(['000424', '000419', '000411']);

    // 実測値（本実装時の実HTTPS取得結果）。全作品passthrough・gaiji 1/0/0、
    // 実測最大候補長は133〜135文字程度で600文字閾値・約1,335文字失敗境界の
    // いずれにも遠く達しない（長大候補分割は発動しない）。
    const expected: Record<string, { candidates: number; gaiji: number }> = {
      '000424': { candidates: 8, gaiji: 1 },
      '000419': { candidates: 21, gaiji: 0 },
      '000411': { candidates: 9, gaiji: 0 },
    };
    for (const work of F010_WORKS) {
      const workSnapshot = snapshot.works.find((item) => item.workId === work.workId)!;
      const record = parseF010SourceRecord(workSnapshot, work.workId);
      expect(record.bibliography.proofreader).not.toBeNull();

      const normalization = normalizeF010AozoraXhtmlEntities(record.raw.bytes, record);
      expect(normalization.variant).toBe('passthrough');

      const first = extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      const second = extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      expect(first.result.ok).toBe(true);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      const want = expected[work.workId]!;
      expect(first.result.candidates.length).toBe(want.candidates);
      if (first.result.ok) {
        expect(first.result.candidates.map((c) => c.order)).toEqual(
          Array.from({ length: first.result.candidates.length }, (_, index) => index),
        );
        // 実測最大候補長は600文字閾値を大きく下回り、長大候補分割は発動しない。
        for (const candidate of first.result.candidates) {
          const displayLength = candidate.tokens
            .map((token) => token.type === 'text' ? token.value.length : 0)
            .reduce((a, b) => a + b, 0);
          expect(displayLength).toBeLessThan(200);
        }
      }

      const text = new TextDecoder('shift_jis', { fatal: true }).decode(normalization.processedBytes);
      const gaijiRanges = detectF010GaijiElements(text);
      expect(gaijiRanges.length).toBe(want.gaiji);
    }
  });

  /** @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005 */
  it('rehydrateはworkspace外・改変されたpersisted snapshotを拒否する', async () => {
    const context = await realF010Context();
    const root = await mkdtemp(join(tmpdir(), 'bungo-f010-rehydrate-tamper-'));
    temporaryDirectories.push(root);
    await mkdir(resolve(root, 'content/batches/F010/source-snapshots'), { recursive: true });
    await writeFile(
      resolve(root, 'content/batches/F010/source-snapshots/selection.json'),
      JSON.stringify({ not: 'canonical' }),
      'utf8',
    );
    await expect(rehydrateF010SelectionSnapshot(root, context)).rejects.toThrow(F010SourceError);
  });
});

describe('gaiji要素の検出・候補内非混入検証（f010-source.ts）', () => {
  /** @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006 */
  it('detectF010GaijiElementsは属性順序に依存せずclass="gaiji"のexact一致だけを検出する', () => {
    const text = [
      '<p><img src="a.png" alt="x" class="gaiji" /></p>',
      '<p><img alt="y" class="gaiji" src="b.png" /></p>',
      "<p><img src=\"c.png\" class='gaiji' alt=\"z\" /></p>",
      '<p><img src="d.png" class="gaiji-extra" alt="w" /></p>',
      '<p><img src="e.png" class="not-gaiji" /></p>',
      '<p>本文だけ、imgなし</p>',
    ].join('');
    const ranges = detectF010GaijiElements(text);
    // gaiji-extra・not-gaijiは属性値の完全一致ではないため対象外（3件だけ検出）。
    expect(ranges.length).toBe(3);
    for (const range of ranges) {
      expect(text.slice(range.start, range.end)).toMatch(/class=(?:"gaiji"|'gaiji')/u);
    }
  });

  /** @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006 */
  it('gaiji0件（Ｋの昇天・愛撫相当の回帰baseline）はdetectF010GaijiElementsが空配列を返す', () => {
    expect(detectF010GaijiElements('<div class="main_text">ただの本文です。</div>')).toEqual([]);
  });

  /**
   * 実際に取得・永続化済みの檸檬(000424)・Ｋの昇天(000419)・愛撫(000411)の
   * raw XHTMLに対し、実測gaiji件数（檸檬1件・他2作品0件、DOMAIN-F010.md §5と
   * 一致）が候補`rawTokenRange`の範囲外にとどまり、
   * `verifyF010NoGaijiWithinCandidates`（`extractF010DialogueCandidates`内部から
   * 常時呼ばれる）がpassすることを確認する。
   * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
   */
  it('実データの3作品はgaiji候補外の重なり0件でpassする（檸檬1件・他2作品0件）', async () => {
    const context = await realF010Context();
    const snapshot = await rehydrateF010SelectionSnapshot(workspace, context);
    const expectedCounts: Record<string, number> = { '000424': 1, '000419': 0, '000411': 0 };
    for (const workId of ['000424', '000419', '000411'] as const) {
      const workSnapshot = snapshot.works.find((item) => item.workId === workId)!;
      const record = parseF010SourceRecord(workSnapshot, workId);
      const normalization = normalizeF010AozoraXhtmlEntities(record.raw.bytes, record);
      const text = new TextDecoder('shift_jis', { fatal: true }).decode(normalization.processedBytes);
      const gaijiRanges = detectF010GaijiElements(text);
      expect(gaijiRanges.length).toBe(expectedCounts[workId]);
      // extractF010DialogueCandidates自体が内部でverifyF010NoGaijiWithinCandidatesを
      // 呼ぶため、例外を投げずに完了すること自体がpassの証跡となる。
      expect(() => extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION)).not.toThrow();
    }
  });

  /**
   * gaiji要素の位置を人為的に候補`rawTokenRange`内へ移動させた異常fixture
   * （檸檬の実候補の開き括弧直後へgaiji imgを挿入）で
   * `F010_GAIJI_WITHIN_CANDIDATE`のfail-closed拒否を確認する。
   * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
   */
  it('候補範囲内へ移動させたgaijiはF010_GAIJI_WITHIN_CANDIDATEで拒否される', async () => {
    const context = await realF010Context();
    const queue = await realResponsesQueue();
    const lemonXhtmlIndex = 2 + F010_WORKS.findIndex((work) => work.workId === '000424') * 2 + 1;
    const original = queue[lemonXhtmlIndex]!;
    const rawBytes = new Uint8Array(original.body);
    const text = new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes);
    const bracketIndex = text.indexOf('「');
    expect(bracketIndex).toBeGreaterThan(0);
    const byteOffset = byteOffsetForStringIndex(rawBytes, bracketIndex + 1);
    const spliced = spliceAsciiAt(rawBytes, byteOffset, '<img src="x" alt="x" class="gaiji" />');
    const splicedText = new TextDecoder('shift_jis', { fatal: true }).decode(spliced);
    expect(splicedText).toContain('「<img src="x" alt="x" class="gaiji" />');
    queue[lemonXhtmlIndex] = response(spliced, 'text/html');

    const snapshot = await collectF010SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-23T19:43:00.225Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '000424')!;
    const record = parseF010SourceRecord(workSnapshot, '000424');
    const normalization = normalizeF010AozoraXhtmlEntities(record.raw.bytes, record);
    expect(() => extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION))
      .toThrow(F010SourceError);
    try {
      extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
    } catch (error) {
      expect((error as F010SourceError).code).toBe('F010_GAIJI_WITHIN_CANDIDATE');
    }
  });
});

describe('長大候補分割の非発動確認（f010-source.ts、防御的no-op）', () => {
  /**
   * DES-F010-015・DD-F010.md §6のとおり、F010は長大候補分割ロジックを
   * 実装しない（`splitOverlongF010Candidates`のような関数はmoduleに存在しない）。
   * 合成600/601文字境界fixture（愛撫の実候補の1つへ長大な追加文を挿入して
   * 単一候補を600/601文字超に膨張させる）を投入しても、分割されず単一candidateの
   * まま生成されることを確認する（F009のように複数pieceへ分割されないことが
   * F010の正しい挙動）。
   * @des DES-F010-005 @des DES-F010-015 @fun FUN-F010-006 @fun FUN-F010-018 @ut UT-F010-006
   */
  it('600/601文字境界の合成candidateは分割されず単一candidateのまま生成される', async () => {
    const context = await realF010Context();
    const queue = await realResponsesQueue();
    const aibuXhtmlIndex = 2 + F010_WORKS.findIndex((work) => work.workId === '000411') * 2 + 1;
    const original = queue[aibuXhtmlIndex]!;
    const rawBytes = new Uint8Array(original.body);
    const text = new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes);
    const bracketIndex = text.indexOf('「');
    expect(bracketIndex).toBeGreaterThan(0);
    // 開き括弧の直後へ601文字のASCII filler（句点を含まない、単一文として扱われる）を挿入する。
    const filler = 'a'.repeat(601);
    const byteOffset = byteOffsetForStringIndex(rawBytes, bracketIndex + 1);
    const spliced = spliceAsciiAt(rawBytes, byteOffset, filler);
    queue[aibuXhtmlIndex] = response(spliced, 'text/html');

    const snapshot = await collectF010SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-23T19:43:00.225Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '000411')!;
    const record = parseF010SourceRecord(workSnapshot, '000411');
    const normalization = normalizeF010AozoraXhtmlEntities(record.raw.bytes, record);
    const candidateSet = extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
    expect(candidateSet.result.ok).toBe(true);
    if (candidateSet.result.ok) {
      const lengths = candidateSet.result.candidates.map((candidate) =>
        candidate.tokens.map((token) => token.type === 'text' ? token.value.length : 0).reduce((a, b) => a + b, 0));
      // 膨張させた候補が600文字を超えて存在するにもかかわらず、分割によって
      // order/件数が不連続に増えていないことを確認する（分割ロジック不在の証跡）。
      expect(lengths.some((length) => length > 600)).toBe(true);
      expect(candidateSet.result.candidates.map((c) => c.order)).toEqual(
        Array.from({ length: candidateSet.result.candidates.length }, (_, index) => index),
      );
    }
  });

  it('f010-source.tsモジュールは長大候補分割関数をexportしない（構造確認）', async () => {
    const module = await import('./f010-source.ts');
    expect('splitOverlongF010Candidates' in module).toBe(false);
  });
});

describe('梶井基次郎author identity registry（f010-source.ts）', () => {
  function baselineCatalog(overrides: Partial<Pick<CatalogV2, 'authors' | 'works'>> = {}): CatalogV2 {
    return {
      schemaVersion: '2.0.0',
      authors: overrides.authors ?? [
        { authorId: '000879', name: 'あくたがわりゅうのすけ', originalName: '芥川龍之介', slug: 'akutagawa-ryunosuke', artwork: { path: 'a.png', alt: 'a', sha256: 'a'.repeat(64) }, introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64) },
      ],
      works: overrides.works ?? [{ authorId: '000879' } as CatalogV2['works'][number]],
      audioAssets: [],
      batches: [],
      candidateCounts: { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0, byBatch: {} },
      creditsRef: 'content/credits.json',
    };
  }

  /** @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004 */
  it('defineF010AuthorAndWorkRegistryはexact authorId/name/slugとwork順3件を返す', () => {
    const registry: F010WorkRegistry = defineF010AuthorAndWorkRegistry();
    expect(registry.authorId).toBe('000074');
    expect(registry.name).toBe('かじいもとじろう');
    expect(registry.originalName).toBe('梶井基次郎');
    expect(registry.slug).toBe('kajii-motojiro');
    expect(registry.authorMode).toBe('introduce');
    expect(registry.works.map((work) => work.workId)).toEqual(['000424', '000419', '000411']);
    expect(registry.works.map((work) => work.order)).toEqual([1, 2, 3]);
    expect(registry.works.map((work) => work.title)).toEqual(['檸檬', 'Ｋの昇天', '愛撫']);
    expect(registry.identitySha256).toMatch(/^[0-9a-f]{64}$/u);
    // 再呼出しでも同一identitySha256（決定的）
    expect(defineF010AuthorAndWorkRegistry().identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004 */
  it('verifyF010AuthorIdentityはbaseline非衝突時だけVerifiedAuthorをmintする', () => {
    const registry = defineF010AuthorAndWorkRegistry();
    const verified = verifyF010AuthorIdentity(registry, baselineCatalog());
    expect(isVerifiedF010Author(verified)).toBe(true);
    expect(verified.authorId).toBe('000074');
    expect(verified.identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004 */
  it('未mintのregistryはverifyF010AuthorIdentityで拒否される', () => {
    const fakeRegistry = { ...defineF010AuthorAndWorkRegistry() };
    expect(() => verifyF010AuthorIdentity(fakeRegistry, baselineCatalog())).toThrow(F010SourceError);
  });

  /** @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004 */
  it('既存作者との衝突（authorId/name/slug一致）はF010_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF010AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      authors: [
        { authorId: '000074', name: 'x', originalName: 'y', slug: 'z', artwork: { path: 'a.png', alt: 'a', sha256: 'a'.repeat(64) }, introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64) },
      ],
    });
    expect(() => verifyF010AuthorIdentity(registry, conflicting)).toThrow(F010SourceError);
    try {
      verifyF010AuthorIdentity(registry, conflicting);
    } catch (error) {
      expect((error as F010SourceError).code).toBe('F010_REGISTRY_MISMATCH');
    }
  });

  /** @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004 */
  it('既存作品のauthorId衝突もF010_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF010AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      works: [{ authorId: '000074' } as CatalogV2['works'][number]],
    });
    expect(() => verifyF010AuthorIdentity(registry, conflicting)).toThrow(F010SourceError);
  });
});
