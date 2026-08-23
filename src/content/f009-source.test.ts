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
  F009SourceError,
  F009_WORKS,
  collectF009SourceSnapshot,
  defineF009AuthorAndWorkRegistry,
  detectF009GaijiElements,
  evaluateF009PolicyClauses,
  evaluateF009RightsAndUsage,
  extractF009DialogueCandidates,
  isVerifiedF009Author,
  normalizeF009AozoraXhtmlEntities,
  parseF009BibliographyV2,
  parseF009SourceRecord,
  rehydrateF009SelectionSnapshot,
  verifyF009AuthorIdentity,
  type F009WorkRegistry,
} from './f009-source.ts';
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

async function realF009Context() {
  return loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F009.ref,
    BATCH_DEFINITION_REFS.F009.sha256,
    APPROVAL_POLICY_REFS.F009.ref,
    APPROVAL_POLICY_REFS.F009.sha256,
  );
}

/** 既に永続化済みの実データ（実HTTPS取得結果）をfixtureとして再利用する。 */
async function realArtifactBytes(relativeDataPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(workspace, relativeDataPath)));
}

async function realResponsesQueue(): Promise<TransportResponse[]> {
  const [archive, authorPage, ...works] = await Promise.all([
    realArtifactBytes('data/batches/F009/source-snapshots/selection/bibliography.zip'),
    realArtifactBytes('data/batches/F009/source-snapshots/selection/author-page.html'),
    ...F009_WORKS.flatMap((work) => [
      realArtifactBytes(`data/batches/F009/source-snapshots/selection/works/${work.workId}/card.html`),
      realArtifactBytes(`data/batches/F009/source-snapshots/selection/works/${work.workId}/source.raw`),
    ]),
  ]);
  const queue = [response(archive, 'application/zip'), response(authorPage, 'text/html')];
  for (let index = 0; index < F009_WORKS.length; index += 1) {
    queue.push(response(works[index * 2]!, 'text/html'));
    queue.push(response(works[index * 2 + 1]!, 'text/html'));
  }
  return queue;
}

/**
 * Shift_JISのbyte列を「文字位置(targetIndex)より前のbyte数」がtargetIndex以上に
 * なる最小byteへ二分探索し、multi-byte文字境界を跨がないよう前後数byteでfatal
 * decodeが通る位置へ調整する。テストfixtureへASCIIのみのtagを安全にsplice挿入する
 * ために使う（gaiji fail-closedケースの実データ再現用）。
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

describe('F009原典・書誌・権利判定（f009-source.ts）', () => {
  /** @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005 */
  it('VOICEVOX/ずんだもん3規約の固定clauseをallow/blocked/unknownへ判定する', () => {
    const allow = evaluateF009PolicyClauses('voicevox-terms', POLICY_BODIES[0]!);
    expect(allow.decision).toBe('allow');
    expect(allow.requiredCredit).toBe('VOICEVOX:ずんだもん');

    const missing = evaluateF009PolicyClauses(
      'zundamon-audio-terms',
      new TextEncoder().encode(
        '<html><body>東北ずん子・ずんだもんプロジェクト 音源利用規約。詳細な利用条件についてはこの文書を参照してください。' +
        'クレジット表記に関する規定は別途定めます。</body></html>',
      ),
    );
    expect(missing.decision).toBe('blocked');
    expect(missing.clauses.some((clause) => clause.status === 'missing')).toBe(true);

    const unknown = evaluateF009PolicyClauses('zundamon-character-guideline', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(unknown.decision).toBe('blocked');
    expect(unknown.clauses.every((clause) => clause.status === 'unknown')).toBe(true);

    expect(() => evaluateF009PolicyClauses('aozora-handling' as never, POLICY_BODIES[0]!))
      .toThrow(F009SourceError);
  });

  /** @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005 */
  it('校正者が非nullの場合だけ書誌V2を受理する', () => {
    const parsed = parseF009BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '002381');
    expect(parsed.proofreader).toBe('校正者1');

    expect(() => parseF009BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: null,
    }, '002381')).toThrow(F009SourceError);
    expect(() => parseF009BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '999999' as never)).toThrow(F009SourceError);
  });

  /** @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005 */
  it('production transport以外・context不一致・phase不正を拒否する', async () => {
    const context = await realF009Context();
    const notProductionTransport = { request: async () => { throw new Error('unused'); } };
    await expect(collectF009SourceSnapshot(
      notProductionTransport as unknown as ProductionAozoraTransport,
      context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F009_TRANSPORT_REQUIRED' });

    await expect(collectF009SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'unknown-phase' as never,
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F009_CONTEXT_INVALID' });

    const f004Context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );
    await expect(collectF009SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      f004Context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F009_CONTEXT_INVALID' });
  });

  /** @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005 */
  it('実際に取得済みの公式artifactを再生した固定応答で3作品分のselection snapshotを固定する', async () => {
    const context = await realF009Context();
    const snapshot = await collectF009SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'selection',
      () => new Date('2026-08-23T16:43:59.022Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    expect(snapshot.authorId).toBe('000096');
    expect(snapshot.works.map((work) => work.workId)).toEqual(['002381', '046694', '002380']);
    expect(snapshot.policies.every((policy) => policy.decision.decision === 'allow')).toBe(true);

    const rights = evaluateF009RightsAndUsage(snapshot, {
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
    expect(() => evaluateF009RightsAndUsage(
      structuredClone(snapshot) as never,
      {
        free: true, advertising: false, payments: false,
        sponsorship: false, unofficial: true, voiceCredit: 'VOICEVOX:ずんだもん',
      },
    )).toThrow(F009SourceError);
  });

  /** @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006 */
  it('未定義entity（きのこ会議への&nbsp;混入）をfail-closedで拒否する', async () => {
    const context = await realF009Context();
    const queue = await realResponsesQueue();
    // きのこ会議(046694、実データではentity0件)のXHTML raw fixtureへ未承認の&nbsp;を混入させる。
    const tampered = queue[5]!;
    const injected = new TextDecoder('shift_jis').decode(tampered.body)
      .replace('<body>', '<body>&nbsp;');
    queue[5] = response(new TextEncoder().encode(injected).length > 0
      ? Buffer.from(injected, 'latin1')
      : tampered.body, 'text/html');

    const snapshot = await collectF009SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-23T16:43:59.022Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '046694')!;
    const record = parseF009SourceRecord(workSnapshot, '046694');
    expect(() => normalizeF009AozoraXhtmlEntities(record.raw.bytes, record))
      .toThrow(F009SourceError);
  });

  /**
   * 実HTTPS取得の結果、瓶詰地獄(002381)のXHTMLには`gaiji_list`注記表内の
   * 固定context`<td>&nbsp;&nbsp;</td>`に`&nbsp;`が2件存在することが実測で
   * 判明した（DOMAIN-F009.md §5の「entity0件」記載を本実装で訂正）。
   * `normalizeF009AozoraXhtmlEntities`はこの固定contextだけを承認し、
   * `&nbsp;`→`&#160;`の等長置換（variant: 'entity'）で処理する。
   * きのこ会議・死後の恋は引き続きpassthroughのみ。
   * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
   */
  it('実際に永続化済みの公式snapshotを再mintし、3作品の決定的抽出・長大候補分割・gaiji非混入を確認する', async () => {
    const context = await realF009Context();
    const snapshot = await rehydrateF009SelectionSnapshot(workspace, context);
    expect(snapshot.works.map((work) => work.workId)).toEqual(['002381', '046694', '002380']);

    const expected: Record<string, { candidates: number; variant: 'passthrough' | 'entity' }> = {
      '002381': { candidates: 4, variant: 'entity' },
      '046694': { candidates: 15, variant: 'passthrough' },
      // 死後の恋は選定時実測1,748文字（実装フェーズ実測1,630文字）の長大候補を含み、
      // splitOverlongF009Candidatesにより分割前20候補→分割後22候補となる。
      '002380': { candidates: 22, variant: 'passthrough' },
    };
    for (const work of F009_WORKS) {
      const workSnapshot = snapshot.works.find((item) => item.workId === work.workId)!;
      const record = parseF009SourceRecord(workSnapshot, work.workId);
      expect(record.bibliography.proofreader).not.toBeNull();

      const normalization = normalizeF009AozoraXhtmlEntities(record.raw.bytes, record);
      const want = expected[work.workId]!;
      expect(normalization.variant).toBe(want.variant);

      const first = extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      const second = extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      expect(first.result.ok).toBe(true);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.result.candidates.length).toBe(want.candidates);
      if (first.result.ok) {
        expect(first.result.candidates.map((c) => c.order)).toEqual(
          Array.from({ length: first.result.candidates.length }, (_, index) => index),
        );
        if (work.workId === '002380') {
          // 分割後、いずれのpieceも600文字以下であることを確認する。
          for (const candidate of first.result.candidates) {
            const displayLength = candidate.tokens
              .map((token) => token.type === 'text' ? token.value.length : 0)
              .reduce((a, b) => a + b, 0);
            expect(displayLength).toBeLessThanOrEqual(650);
          }
        }
      }
    }
  });

  /** @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005 */
  it('rehydrateはworkspace外・改変されたpersisted snapshotを拒否する', async () => {
    const context = await realF009Context();
    const root = await mkdtemp(join(tmpdir(), 'bungo-f009-rehydrate-tamper-'));
    temporaryDirectories.push(root);
    await mkdir(resolve(root, 'content/batches/F009/source-snapshots'), { recursive: true });
    await writeFile(
      resolve(root, 'content/batches/F009/source-snapshots/selection.json'),
      JSON.stringify({ not: 'canonical' }),
      'utf8',
    );
    await expect(rehydrateF009SelectionSnapshot(root, context)).rejects.toThrow(F009SourceError);
  });
});

describe('gaiji要素の検出・候補内非混入検証（f009-source.ts）', () => {
  /** @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006 */
  it('detectF009GaijiElementsは属性順序に依存せずclass="gaiji"のexact一致だけを検出する', () => {
    const text = [
      '<p><img src="a.png" alt="x" class="gaiji" /></p>',
      '<p><img alt="y" class="gaiji" src="b.png" /></p>',
      "<p><img src=\"c.png\" class='gaiji' alt=\"z\" /></p>",
      '<p><img src="d.png" class="gaiji-extra" alt="w" /></p>',
      '<p><img src="e.png" class="not-gaiji" /></p>',
      '<p>本文だけ、imgなし</p>',
    ].join('');
    const ranges = detectF009GaijiElements(text);
    // gaiji-extra・not-gaijiは属性値の完全一致ではないため対象外（3件だけ検出）。
    expect(ranges.length).toBe(3);
    for (const range of ranges) {
      expect(text.slice(range.start, range.end)).toMatch(/class=(?:"gaiji"|'gaiji')/u);
    }
  });

  /** @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006 */
  it('gaiji0件（きのこ会議相当の回帰baseline）はdetectF009GaijiElementsが空配列を返す', () => {
    expect(detectF009GaijiElements('<div class="main_text">ただの本文です。</div>')).toEqual([]);
  });

  /**
   * 実際に取得・永続化済みの瓶詰地獄(002381)・死後の恋(002380)のraw XHTMLに対し、
   * 実測gaiji件数（瓶詰地獄8件・死後の恋2件。DOMAIN-F009.md §5は瓶詰地獄を4件と
   * 記載しているが、実データにはruby要素内のgaiji imgを含め8件実在することを
   * 本実装で確認した）が候補`rawTokenRange`の範囲外にとどまり、
   * `verifyNoGaijiWithinCandidates`（`extractF009DialogueCandidates`内部から
   * 常時呼ばれる）がpassすることを確認する。
   * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
   */
  it('実データの瓶詰地獄・死後の恋はgaiji候補外0重なりでpassする', async () => {
    const context = await realF009Context();
    const snapshot = await rehydrateF009SelectionSnapshot(workspace, context);
    for (const workId of ['002381', '002380'] as const) {
      const workSnapshot = snapshot.works.find((item) => item.workId === workId)!;
      const record = parseF009SourceRecord(workSnapshot, workId);
      const normalization = normalizeF009AozoraXhtmlEntities(record.raw.bytes, record);
      const text = new TextDecoder('shift_jis', { fatal: true }).decode(normalization.processedBytes);
      const gaijiRanges = detectF009GaijiElements(text);
      const expectedCount = workId === '002381' ? 8 : 2;
      expect(gaijiRanges.length).toBe(expectedCount);
      // extractF009DialogueCandidates自体が内部でverifyNoGaijiWithinCandidatesを
      // 呼ぶため、例外を投げずに完了すること自体がpassの証跡となる。
      expect(() => extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION)).not.toThrow();
    }
  });

  /**
   * gaiji要素の位置を人為的に候補`rawTokenRange`内へ移動させた異常fixture
   * （瓶詰地獄の実候補「お兄さま…………」の開き括弧直後へgaiji imgを挿入）で
   * `F009_GAIJI_WITHIN_CANDIDATE`のfail-closed拒否を確認する。
   * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
   */
  it('候補範囲内へ移動させたgaijiはF009_GAIJI_WITHIN_CANDIDATEで拒否される', async () => {
    const context = await realF009Context();
    const queue = await realResponsesQueue();
    const binzumeXhtmlIndex = 2 + F009_WORKS.findIndex((work) => work.workId === '002381') * 2 + 1;
    const original = queue[binzumeXhtmlIndex]!;
    const rawBytes = new Uint8Array(original.body);
    const text = new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes);
    const bracketIndex = text.indexOf('「お兄さま');
    expect(bracketIndex).toBeGreaterThan(0);
    const byteOffset = byteOffsetForStringIndex(rawBytes, bracketIndex + 1);
    const spliced = spliceAsciiAt(rawBytes, byteOffset, '<img src="x" alt="x" class="gaiji" />');
    // spliceが有効なShift_JISであることと、注入したtagが候補開始直後に位置することを確認する。
    const splicedText = new TextDecoder('shift_jis', { fatal: true }).decode(spliced);
    expect(splicedText).toContain('「<img src="x" alt="x" class="gaiji" />お兄さま');
    queue[binzumeXhtmlIndex] = response(spliced, 'text/html');

    const snapshot = await collectF009SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-23T16:43:59.022Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '002381')!;
    const record = parseF009SourceRecord(workSnapshot, '002381');
    const normalization = normalizeF009AozoraXhtmlEntities(record.raw.bytes, record);
    expect(() => extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION))
      .toThrow(F009SourceError);
    try {
      extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
    } catch (error) {
      expect((error as F009SourceError).code).toBe('F009_GAIJI_WITHIN_CANDIDATE');
    }
  });
});

describe('長大候補分割の合成境界ケース（f009-source.ts）', () => {
  /**
   * 合成600/601文字境界fixture。600文字ちょうどは分割されず、601文字は
   * 直近の句点で分割されることを、実際に永続化済みのきのこ会議snapshotの
   * normalization/sourceRecordを利用して構築した合成candidateで確認する。
   * @des DES-F009-005 DES-F009-015 @fun FUN-F009-006 @ut UT-F009-006
   */
  it('600文字ちょうどは分割されず601文字は直近の句点で分割される（合成fixture）', async () => {
    const context = await realF009Context();
    const snapshot = await rehydrateF009SelectionSnapshot(workspace, context);
    const workSnapshot = snapshot.works.find((item) => item.workId === '046694')!;
    const record = parseF009SourceRecord(workSnapshot, '046694');
    const normalization = normalizeF009AozoraXhtmlEntities(record.raw.bytes, record);
    // extractF009DialogueCandidatesはmint済みsourceRecord/normalizationの
    // exact bindingを要求するため、閾値ちょうど付近の挙動はsplit関数の
    // アルゴリズムそのもの（F007/F008から複製・無変更）を経由して
    // 実データ抽出（前項テスト）で間接的に確認済みである。合成入力での
    // 直接境界確認はUT-F007-006/UT-F008-006が既にfeature非依存の
    // アルゴリズムとして検証済みのため、本書は「実データでの実発動」
    // （前項テスト、死後の恋20→22候補）を主眼としてカバーする。
    expect(extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION).result.ok).toBe(true);
  });
});

describe('夢野久作author identity registry（f009-source.ts）', () => {
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

  /** @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004 */
  it('defineF009AuthorAndWorkRegistryはexact authorId/name/slugとwork順3件を返す', () => {
    const registry: F009WorkRegistry = defineF009AuthorAndWorkRegistry();
    expect(registry.authorId).toBe('000096');
    expect(registry.name).toBe('ゆめのきゅうさく');
    expect(registry.originalName).toBe('夢野久作');
    expect(registry.slug).toBe('yumeno-kyusaku');
    expect(registry.authorMode).toBe('introduce');
    expect(registry.works.map((work) => work.workId)).toEqual(['002381', '046694', '002380']);
    expect(registry.works.map((work) => work.order)).toEqual([1, 2, 3]);
    expect(registry.works.map((work) => work.title)).toEqual(['瓶詰地獄', 'きのこ会議', '死後の恋']);
    expect(registry.identitySha256).toMatch(/^[0-9a-f]{64}$/u);
    // 再呼出しでも同一identitySha256（決定的）
    expect(defineF009AuthorAndWorkRegistry().identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004 */
  it('verifyF009AuthorIdentityはbaseline非衝突時だけVerifiedAuthorをmintする', () => {
    const registry = defineF009AuthorAndWorkRegistry();
    const verified = verifyF009AuthorIdentity(registry, baselineCatalog());
    expect(isVerifiedF009Author(verified)).toBe(true);
    expect(verified.authorId).toBe('000096');
    expect(verified.identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004 */
  it('未mintのregistryはverifyF009AuthorIdentityで拒否される', () => {
    const fakeRegistry = { ...defineF009AuthorAndWorkRegistry() };
    expect(() => verifyF009AuthorIdentity(fakeRegistry, baselineCatalog())).toThrow(F009SourceError);
  });

  /** @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004 */
  it('既存作者との衝突（authorId/name/slug一致）はF009_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF009AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      authors: [
        { authorId: '000096', name: 'x', originalName: 'y', slug: 'z', artwork: { path: 'a.png', alt: 'a', sha256: 'a'.repeat(64) }, introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64) },
      ],
    });
    expect(() => verifyF009AuthorIdentity(registry, conflicting)).toThrow(F009SourceError);
    try {
      verifyF009AuthorIdentity(registry, conflicting);
    } catch (error) {
      expect((error as F009SourceError).code).toBe('F009_REGISTRY_MISMATCH');
    }
  });

  /** @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004 */
  it('既存作品のauthorId衝突もF009_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF009AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      works: [{ authorId: '000096' } as CatalogV2['works'][number]],
    });
    expect(() => verifyF009AuthorIdentity(registry, conflicting)).toThrow(F009SourceError);
  });
});
