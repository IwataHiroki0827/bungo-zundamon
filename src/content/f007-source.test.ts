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
  F007SourceError,
  F007_WORKS,
  collectF007SourceSnapshot,
  defineF007AuthorAndWorkRegistry,
  evaluateF007PolicyClauses,
  evaluateF007RightsAndUsage,
  extractF007DialogueCandidates,
  isVerifiedF007Author,
  normalizeF007AozoraXhtmlEntities,
  parseF007BibliographyV2,
  parseF007SourceRecord,
  rehydrateF007SelectionSnapshot,
  verifyF007AuthorIdentity,
  type F007WorkRegistry,
} from './f007-source.ts';
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
    fetchedAt: '2026-08-21T00:00:00.000Z',
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
        fetchedAt: '2026-08-21T00:00:00.000Z',
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

async function realF007Context() {
  return loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F007.ref,
    BATCH_DEFINITION_REFS.F007.sha256,
    APPROVAL_POLICY_REFS.F007.ref,
    APPROVAL_POLICY_REFS.F007.sha256,
  );
}

/** 既に永続化済みの実データ（実HTTPS取得結果）をfixtureとして再利用する。 */
async function realArtifactBytes(relativeDataPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(workspace, relativeDataPath)));
}

async function realResponsesQueue(): Promise<TransportResponse[]> {
  const [archive, authorPage, ...works] = await Promise.all([
    realArtifactBytes('data/batches/F007/source-snapshots/selection/bibliography.zip'),
    realArtifactBytes('data/batches/F007/source-snapshots/selection/author-page.html'),
    ...F007_WORKS.flatMap((work) => [
      realArtifactBytes(`data/batches/F007/source-snapshots/selection/works/${work.workId}/card.html`),
      realArtifactBytes(`data/batches/F007/source-snapshots/selection/works/${work.workId}/source.raw`),
    ]),
  ]);
  const queue = [response(archive, 'application/zip'), response(authorPage, 'text/html')];
  for (let index = 0; index < F007_WORKS.length; index += 1) {
    queue.push(response(works[index * 2]!, 'text/html'));
    queue.push(response(works[index * 2 + 1]!, 'text/html'));
  }
  return queue;
}

describe('F007原典・書誌・権利判定（f007-source.ts）', () => {
  /** @des DES-F007-004 @fun FUN-F007-005 @ut UT-F007-005 */
  it('VOICEVOX/ずんだもん3規約の固定clauseをallow/blocked/unknownへ判定する', () => {
    const allow = evaluateF007PolicyClauses('voicevox-terms', POLICY_BODIES[0]!);
    expect(allow.decision).toBe('allow');
    expect(allow.requiredCredit).toBe('VOICEVOX:ずんだもん');

    const missing = evaluateF007PolicyClauses(
      'zundamon-audio-terms',
      new TextEncoder().encode(
        '<html><body>東北ずん子・ずんだもんプロジェクト 音源利用規約。詳細な利用条件についてはこの文書を参照してください。' +
        'クレジット表記に関する規定は別途定めます。</body></html>',
      ),
    );
    expect(missing.decision).toBe('blocked');
    expect(missing.clauses.some((clause) => clause.status === 'missing')).toBe(true);

    const unknown = evaluateF007PolicyClauses('zundamon-character-guideline', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(unknown.decision).toBe('blocked');
    expect(unknown.clauses.every((clause) => clause.status === 'unknown')).toBe(true);

    expect(() => evaluateF007PolicyClauses('aozora-handling' as never, POLICY_BODIES[0]!))
      .toThrow(F007SourceError);
  });

  /** @des DES-F007-004 @fun FUN-F007-005 @ut UT-F007-005 */
  it('校正者が非nullの場合だけ書誌V2を受理する', () => {
    const parsed = parseF007BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '058126');
    expect(parsed.proofreader).toBe('校正者1');

    expect(() => parseF007BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: null,
    }, '058126')).toThrow(F007SourceError);
    expect(() => parseF007BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '999999' as never)).toThrow(F007SourceError);
  });

  /** @des DES-F007-004 @fun FUN-F007-005 @ut UT-F007-005 */
  it('production transport以外・context不一致・phase不正を拒否する', async () => {
    const context = await realF007Context();
    const notProductionTransport = { request: async () => { throw new Error('unused'); } };
    await expect(collectF007SourceSnapshot(
      notProductionTransport as unknown as ProductionAozoraTransport,
      context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F007_TRANSPORT_REQUIRED' });

    await expect(collectF007SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'unknown-phase' as never,
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F007_CONTEXT_INVALID' });

    const f004Context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );
    await expect(collectF007SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      f004Context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F007_CONTEXT_INVALID' });
  });

  /** @des DES-F007-004 @fun FUN-F007-005 @ut UT-F007-005 */
  it('実際に取得済みの公式artifactを再生した固定応答で3作品分のselection snapshotを固定する', async () => {
    const context = await realF007Context();
    const snapshot = await collectF007SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'selection',
      () => new Date('2026-08-21T06:52:21.272Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    expect(snapshot.authorId).toBe('000129');
    expect(snapshot.works.map((work) => work.workId)).toEqual(['058126', '045245', '000689']);
    expect(snapshot.policies.every((policy) => policy.decision.decision === 'allow')).toBe(true);

    const rights = evaluateF007RightsAndUsage(snapshot, {
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
    expect(() => evaluateF007RightsAndUsage(
      structuredClone(snapshot) as never,
      {
        free: true, advertising: false, payments: false,
        sponsorship: false, unofficial: true, voiceCredit: 'VOICEVOX:ずんだもん',
      },
    )).toThrow(F007SourceError);
  });

  /** @des DES-F007-005 @fun FUN-F007-006 @ut UT-F007-006 */
  it('未定義entity（&nbsp;等）を含むXHTMLをfail-closedで拒否する', async () => {
    const context = await realF007Context();
    const queue = await realResponsesQueue();
    // 山椒大夫(000689)のXHTML raw fixtureへ未承認の&nbsp;を混入させる。
    const tampered = queue[7]!;
    const injected = new TextDecoder('shift_jis').decode(tampered.body)
      .replace('<body>', '<body>&nbsp;');
    queue[7] = response(new TextEncoder().encode(injected).length > 0
      ? Buffer.from(injected, 'latin1')
      : tampered.body, 'text/html');

    const snapshot = await collectF007SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-21T06:52:21.272Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '000689')!;
    const record = parseF007SourceRecord(workSnapshot, '000689');
    expect(() => normalizeF007AozoraXhtmlEntities(record.raw.bytes, record))
      .toThrow(F007SourceError);
  });

  /**
   * 2026-08-22訂正: DOMAIN-F007.md初版は3作品とも未定義entity0件と記載していたが、
   * 実HTTPS取得の結果、舞姫（058126）の本文外gaiji_list注記表内に固定context
   * `<td>&nbsp;&nbsp;</td>`で`&nbsp;`が2件存在することが判明した（DD-F007.md
   * FUN-F007-006訂正記載）。高瀬舟・山椒大夫は引き続きpassthrough。
   * @des DES-F007-004 DES-F007-005 @fun FUN-F007-005 FUN-F007-006 @ut UT-F007-005 UT-F007-006
   */
  it('実際に永続化済みの公式snapshotを再mintし、舞姫のみ承認済みnbsp等長置換・残り2作品はpassthroughで決定的抽出を確認する', async () => {
    const context = await realF007Context();
    const snapshot = await rehydrateF007SelectionSnapshot(workspace, context);
    expect(snapshot.works.map((work) => work.workId)).toEqual(['058126', '045245', '000689']);

    const expected2: Record<string, { variant: 'passthrough' | 'entity'; replacements: number; candidates: number }> = {
      '058126': { variant: 'entity', replacements: 2, candidates: 48 },
      // order12（喜助の弟殺害の述懐、2408文字の単一「」候補）がVOICEVOX
      // synthesis上限（実測約1330〜1340文字）を超えるため、
      // splitOverlongF007Candidatesにより4pieceへ自動分割される
      // （13→16、うち原order12分は+3）。
      '045245': { variant: 'passthrough', replacements: 0, candidates: 16 },
      '000689': { variant: 'passthrough', replacements: 0, candidates: 120 },
    };
    for (const expected of F007_WORKS) {
      const workSnapshot = snapshot.works.find((work) => work.workId === expected.workId)!;
      const record = parseF007SourceRecord(workSnapshot, expected.workId);
      expect(record.bibliography.proofreader).not.toBeNull();

      const normalization = normalizeF007AozoraXhtmlEntities(record.raw.bytes, record);
      const want = expected2[expected.workId]!;
      expect(normalization.variant).toBe(want.variant);
      expect(normalization.replacements).toHaveLength(want.replacements);

      const first = extractF007DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      const second = extractF007DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      expect(first.result.ok).toBe(true);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.result.candidates.length).toBe(want.candidates);
    }
  });

  /** @des DES-F007-004 @fun FUN-F007-005 @ut UT-F007-005 */
  it('rehydrateはworkspace外・改変されたpersisted snapshotを拒否する', async () => {
    const context = await realF007Context();
    const root = await mkdtemp(join(tmpdir(), 'bungo-f007-rehydrate-tamper-'));
    temporaryDirectories.push(root);
    await mkdir(resolve(root, 'content/batches/F007/source-snapshots'), { recursive: true });
    await writeFile(
      resolve(root, 'content/batches/F007/source-snapshots/selection.json'),
      JSON.stringify({ not: 'canonical' }),
      'utf8',
    );
    await expect(rehydrateF007SelectionSnapshot(root, context)).rejects.toThrow(F007SourceError);
  });
});

describe('森鴎外author identity registry（f007-source.ts）', () => {
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

  /** @des DES-F007-003 @fun FUN-F007-004 @ut UT-F007-004 */
  it('defineF007AuthorAndWorkRegistryはexact authorId/name/slugとwork順3件を返す', () => {
    const registry: F007WorkRegistry = defineF007AuthorAndWorkRegistry();
    expect(registry.authorId).toBe('000129');
    expect(registry.name).toBe('もりおうがい');
    expect(registry.originalName).toBe('森鴎外');
    expect(registry.slug).toBe('mori-ogai');
    expect(registry.authorMode).toBe('introduce');
    expect(registry.works.map((work) => work.workId)).toEqual(['058126', '045245', '000689']);
    expect(registry.works.map((work) => work.order)).toEqual([1, 2, 3]);
    expect(registry.works.map((work) => work.title)).toEqual(['舞姫', '高瀬舟', '山椒大夫']);
    expect(registry.identitySha256).toMatch(/^[0-9a-f]{64}$/u);
    // 再呼出しでも同一identitySha256（決定的）
    expect(defineF007AuthorAndWorkRegistry().identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F007-003 @fun FUN-F007-004 @ut UT-F007-004 */
  it('verifyF007AuthorIdentityはbaseline非衝突時だけVerifiedAuthorをmintする', () => {
    const registry = defineF007AuthorAndWorkRegistry();
    const verified = verifyF007AuthorIdentity(registry, baselineCatalog());
    expect(isVerifiedF007Author(verified)).toBe(true);
    expect(verified.authorId).toBe('000129');
    expect(verified.identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F007-003 @fun FUN-F007-004 @ut UT-F007-004 */
  it('未mintのregistryはverifyF007AuthorIdentityで拒否される', () => {
    const fakeRegistry = { ...defineF007AuthorAndWorkRegistry() };
    expect(() => verifyF007AuthorIdentity(fakeRegistry, baselineCatalog())).toThrow(F007SourceError);
  });

  /** @des DES-F007-003 @fun FUN-F007-004 @ut UT-F007-004 */
  it('既存4作者との衝突（authorId/name/slug一致）はF007_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF007AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      authors: [
        { authorId: '000129', name: 'x', originalName: 'y', slug: 'z', artwork: { path: 'a.png', alt: 'a', sha256: 'a'.repeat(64) }, introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64) },
      ],
    });
    expect(() => verifyF007AuthorIdentity(registry, conflicting)).toThrow(F007SourceError);
    try {
      verifyF007AuthorIdentity(registry, conflicting);
    } catch (error) {
      expect((error as F007SourceError).code).toBe('F007_REGISTRY_MISMATCH');
    }
  });

  /** @des DES-F007-003 @fun FUN-F007-004 @ut UT-F007-004 */
  it('既存作品のauthorId衝突もF007_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF007AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      works: [{ authorId: '000129' } as CatalogV2['works'][number]],
    });
    expect(() => verifyF007AuthorIdentity(registry, conflicting)).toThrow(F007SourceError);
  });
});
