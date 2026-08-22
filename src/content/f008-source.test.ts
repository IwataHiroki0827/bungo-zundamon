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
  F008SourceError,
  F008_WORKS,
  collectF008SourceSnapshot,
  defineF008AuthorAndWorkRegistry,
  evaluateF008PolicyClauses,
  evaluateF008RightsAndUsage,
  extractF008DialogueCandidates,
  isVerifiedF008Author,
  normalizeF008AozoraXhtmlEntities,
  parseF008BibliographyV2,
  parseF008SourceRecord,
  rehydrateF008SelectionSnapshot,
  verifyF008AuthorIdentity,
  type F008WorkRegistry,
} from './f008-source.ts';
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
    fetchedAt: '2026-08-22T00:00:00.000Z',
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
        fetchedAt: '2026-08-22T00:00:00.000Z',
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

async function realF008Context() {
  return loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F008.ref,
    BATCH_DEFINITION_REFS.F008.sha256,
    APPROVAL_POLICY_REFS.F008.ref,
    APPROVAL_POLICY_REFS.F008.sha256,
  );
}

/** 既に永続化済みの実データ（実HTTPS取得結果）をfixtureとして再利用する。 */
async function realArtifactBytes(relativeDataPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(workspace, relativeDataPath)));
}

async function realResponsesQueue(): Promise<TransportResponse[]> {
  const [archive, authorPage, ...works] = await Promise.all([
    realArtifactBytes('data/batches/F008/source-snapshots/selection/bibliography.zip'),
    realArtifactBytes('data/batches/F008/source-snapshots/selection/author-page.html'),
    ...F008_WORKS.flatMap((work) => [
      realArtifactBytes(`data/batches/F008/source-snapshots/selection/works/${work.workId}/card.html`),
      realArtifactBytes(`data/batches/F008/source-snapshots/selection/works/${work.workId}/source.raw`),
    ]),
  ]);
  const queue = [response(archive, 'application/zip'), response(authorPage, 'text/html')];
  for (let index = 0; index < F008_WORKS.length; index += 1) {
    queue.push(response(works[index * 2]!, 'text/html'));
    queue.push(response(works[index * 2 + 1]!, 'text/html'));
  }
  return queue;
}

describe('F008原典・書誌・権利判定（f008-source.ts）', () => {
  /** @des DES-F008-004 @fun FUN-F008-005 @ut UT-F008-005 */
  it('VOICEVOX/ずんだもん3規約の固定clauseをallow/blocked/unknownへ判定する', () => {
    const allow = evaluateF008PolicyClauses('voicevox-terms', POLICY_BODIES[0]!);
    expect(allow.decision).toBe('allow');
    expect(allow.requiredCredit).toBe('VOICEVOX:ずんだもん');

    const missing = evaluateF008PolicyClauses(
      'zundamon-audio-terms',
      new TextEncoder().encode(
        '<html><body>東北ずん子・ずんだもんプロジェクト 音源利用規約。詳細な利用条件についてはこの文書を参照してください。' +
        'クレジット表記に関する規定は別途定めます。</body></html>',
      ),
    );
    expect(missing.decision).toBe('blocked');
    expect(missing.clauses.some((clause) => clause.status === 'missing')).toBe(true);

    const unknown = evaluateF008PolicyClauses('zundamon-character-guideline', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(unknown.decision).toBe('blocked');
    expect(unknown.clauses.every((clause) => clause.status === 'unknown')).toBe(true);

    expect(() => evaluateF008PolicyClauses('aozora-handling' as never, POLICY_BODIES[0]!))
      .toThrow(F008SourceError);
  });

  /** @des DES-F008-004 @fun FUN-F008-005 @ut UT-F008-005 */
  it('校正者が非nullの場合だけ書誌V2を受理する', () => {
    const parsed = parseF008BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '056648');
    expect(parsed.proofreader).toBe('校正者1');

    expect(() => parseF008BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: null,
    }, '056648')).toThrow(F008SourceError);
    expect(() => parseF008BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '999999' as never)).toThrow(F008SourceError);
  });

  /** @des DES-F008-004 @fun FUN-F008-005 @ut UT-F008-005 */
  it('production transport以外・context不一致・phase不正を拒否する', async () => {
    const context = await realF008Context();
    const notProductionTransport = { request: async () => { throw new Error('unused'); } };
    await expect(collectF008SourceSnapshot(
      notProductionTransport as unknown as ProductionAozoraTransport,
      context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F008_TRANSPORT_REQUIRED' });

    await expect(collectF008SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'unknown-phase' as never,
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F008_CONTEXT_INVALID' });

    const f004Context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );
    await expect(collectF008SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      f004Context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F008_CONTEXT_INVALID' });
  });

  /** @des DES-F008-004 @fun FUN-F008-005 @ut UT-F008-005 */
  it('実際に取得済みの公式artifactを再生した固定応答で3作品分のselection snapshotを固定する', async () => {
    const context = await realF008Context();
    const snapshot = await collectF008SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'selection',
      () => new Date('2026-08-22T14:41:29.993Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    expect(snapshot.authorId).toBe('001779');
    expect(snapshot.works.map((work) => work.workId)).toEqual(['056648', '056650', '057193']);
    expect(snapshot.policies.every((policy) => policy.decision.decision === 'allow')).toBe(true);

    const rights = evaluateF008RightsAndUsage(snapshot, {
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
    expect(() => evaluateF008RightsAndUsage(
      structuredClone(snapshot) as never,
      {
        free: true, advertising: false, payments: false,
        sponsorship: false, unofficial: true, voiceCredit: 'VOICEVOX:ずんだもん',
      },
    )).toThrow(F008SourceError);
  });

  /** @des DES-F008-005 @fun FUN-F008-006 @ut UT-F008-006 */
  it('未定義entity（&nbsp;等）を含むXHTMLをfail-closedで拒否する', async () => {
    const context = await realF008Context();
    const queue = await realResponsesQueue();
    // 一人二役(057193)のXHTML raw fixtureへ未承認の&nbsp;を混入させる。
    const tampered = queue[7]!;
    const injected = new TextDecoder('shift_jis').decode(tampered.body)
      .replace('<body>', '<body>&nbsp;');
    queue[7] = response(new TextEncoder().encode(injected).length > 0
      ? Buffer.from(injected, 'latin1')
      : tampered.body, 'text/html');

    const snapshot = await collectF008SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-22T14:41:29.993Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '057193')!;
    const record = parseF008SourceRecord(workSnapshot, '057193');
    expect(() => normalizeF008AozoraXhtmlEntities(record.raw.bytes, record))
      .toThrow(F008SourceError);
  });

  /**
   * 実HTTPS取得の結果、人間椅子(056648)・Ｄ坂の殺人事件(056650)・一人二役(057193)の
   * 3作品XHTMLとも未定義named entityは0件であることを実測確認した（F007の舞姫のような
   * `&nbsp;`特別contextはF008には存在しない）。Ｄ坂の殺人事件は生抽出82候補中4候補が
   * 600文字閾値を超過（実測最大1,429文字）し、`splitOverlongF008Candidates`により
   * 87候補へ自動分割される。
   * @des DES-F008-004 DES-F008-005 DES-F008-015 @fun FUN-F008-005 FUN-F008-006 @ut UT-F008-005 UT-F008-006
   */
  it('実際に永続化済みの公式snapshotを再mintし、3作品ともpassthroughで決定的抽出・長大候補分割を確認する', async () => {
    const context = await realF008Context();
    const snapshot = await rehydrateF008SelectionSnapshot(workspace, context);
    expect(snapshot.works.map((work) => work.workId)).toEqual(['056648', '056650', '057193']);

    const expected2: Record<string, { candidates: number }> = {
      '056648': { candidates: 11 },
      // Ｄ坂の殺人事件は生抽出82候補中4候補がVOICEVOX synthesis上限
      // （実測約1330〜1340文字）を超える（実測最大1,429文字）ため、
      // splitOverlongF008Candidatesにより87候補へ自動分割される。
      '056650': { candidates: 87 },
      '057193': { candidates: 11 },
    };
    for (const expected of F008_WORKS) {
      const workSnapshot = snapshot.works.find((work) => work.workId === expected.workId)!;
      const record = parseF008SourceRecord(workSnapshot, expected.workId);
      expect(record.bibliography.proofreader).not.toBeNull();

      const normalization = normalizeF008AozoraXhtmlEntities(record.raw.bytes, record);
      expect(normalization.variant).toBe('passthrough');
      expect(normalization.replacements).toHaveLength(0);

      const first = extractF008DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      const second = extractF008DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      expect(first.result.ok).toBe(true);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      const want = expected2[expected.workId]!;
      expect(first.result.candidates.length).toBe(want.candidates);
      if (first.result.ok) {
        expect(first.result.candidates.map((c) => c.order)).toEqual(
          Array.from({ length: first.result.candidates.length }, (_, index) => index),
        );
      }
    }
  });

  /** @des DES-F008-004 @fun FUN-F008-005 @ut UT-F008-005 */
  it('rehydrateはworkspace外・改変されたpersisted snapshotを拒否する', async () => {
    const context = await realF008Context();
    const root = await mkdtemp(join(tmpdir(), 'bungo-f008-rehydrate-tamper-'));
    temporaryDirectories.push(root);
    await mkdir(resolve(root, 'content/batches/F008/source-snapshots'), { recursive: true });
    await writeFile(
      resolve(root, 'content/batches/F008/source-snapshots/selection.json'),
      JSON.stringify({ not: 'canonical' }),
      'utf8',
    );
    await expect(rehydrateF008SelectionSnapshot(root, context)).rejects.toThrow(F008SourceError);
  });
});

describe('江戸川乱歩author identity registry（f008-source.ts）', () => {
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

  /** @des DES-F008-003 @fun FUN-F008-004 @ut UT-F008-004 */
  it('defineF008AuthorAndWorkRegistryはexact authorId/name/slugとwork順3件を返す', () => {
    const registry: F008WorkRegistry = defineF008AuthorAndWorkRegistry();
    expect(registry.authorId).toBe('001779');
    expect(registry.name).toBe('えどがわらんぽ');
    expect(registry.originalName).toBe('江戸川乱歩');
    expect(registry.slug).toBe('edogawa-ranpo');
    expect(registry.authorMode).toBe('introduce');
    expect(registry.works.map((work) => work.workId)).toEqual(['056648', '056650', '057193']);
    expect(registry.works.map((work) => work.order)).toEqual([1, 2, 3]);
    expect(registry.works.map((work) => work.title)).toEqual(['人間椅子', 'Ｄ坂の殺人事件', '一人二役']);
    expect(registry.identitySha256).toMatch(/^[0-9a-f]{64}$/u);
    // 再呼出しでも同一identitySha256（決定的）
    expect(defineF008AuthorAndWorkRegistry().identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F008-003 @fun FUN-F008-004 @ut UT-F008-004 */
  it('verifyF008AuthorIdentityはbaseline非衝突時だけVerifiedAuthorをmintする', () => {
    const registry = defineF008AuthorAndWorkRegistry();
    const verified = verifyF008AuthorIdentity(registry, baselineCatalog());
    expect(isVerifiedF008Author(verified)).toBe(true);
    expect(verified.authorId).toBe('001779');
    expect(verified.identitySha256).toBe(registry.identitySha256);
  });

  /** @des DES-F008-003 @fun FUN-F008-004 @ut UT-F008-004 */
  it('未mintのregistryはverifyF008AuthorIdentityで拒否される', () => {
    const fakeRegistry = { ...defineF008AuthorAndWorkRegistry() };
    expect(() => verifyF008AuthorIdentity(fakeRegistry, baselineCatalog())).toThrow(F008SourceError);
  });

  /** @des DES-F008-003 @fun FUN-F008-004 @ut UT-F008-004 */
  it('既存作者との衝突（authorId/name/slug一致）はF008_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF008AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      authors: [
        { authorId: '001779', name: 'x', originalName: 'y', slug: 'z', artwork: { path: 'a.png', alt: 'a', sha256: 'a'.repeat(64) }, introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64) },
      ],
    });
    expect(() => verifyF008AuthorIdentity(registry, conflicting)).toThrow(F008SourceError);
    try {
      verifyF008AuthorIdentity(registry, conflicting);
    } catch (error) {
      expect((error as F008SourceError).code).toBe('F008_REGISTRY_MISMATCH');
    }
  });

  /** @des DES-F008-003 @fun FUN-F008-004 @ut UT-F008-004 */
  it('既存作品のauthorId衝突もF008_REGISTRY_MISMATCHで拒否される', () => {
    const registry = defineF008AuthorAndWorkRegistry();
    const conflicting = baselineCatalog({
      works: [{ authorId: '001779' } as CatalogV2['works'][number]],
    });
    expect(() => verifyF008AuthorIdentity(registry, conflicting)).toThrow(F008SourceError);
  });
});
