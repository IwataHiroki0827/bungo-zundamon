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
  F006SourceError,
  F006_WORKS,
  collectF006SourceSnapshot,
  evaluateF006PolicyClauses,
  evaluateF006RightsAndUsage,
  extractF006DialogueCandidates,
  normalizeF006AozoraXhtmlEntities,
  parseF006BibliographyV2,
  parseF006SourceRecord,
  rehydrateF006SelectionSnapshot,
} from './f006-source.ts';

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

async function realF006Context() {
  return loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F006.ref,
    BATCH_DEFINITION_REFS.F006.sha256,
    APPROVAL_POLICY_REFS.F006.ref,
    APPROVAL_POLICY_REFS.F006.sha256,
  );
}

/** 既に永続化済みの実データ（実HTTPS取得結果）をfixtureとして再利用する。 */
async function realArtifactBytes(relativeDataPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(workspace, relativeDataPath)));
}

async function realResponsesQueue(): Promise<TransportResponse[]> {
  const [archive, authorPage, ...works] = await Promise.all([
    realArtifactBytes('data/batches/F006/source-snapshots/selection/bibliography.zip'),
    realArtifactBytes('data/batches/F006/source-snapshots/selection/author-page.html'),
    ...F006_WORKS.flatMap((work) => [
      realArtifactBytes(`data/batches/F006/source-snapshots/selection/works/${work.workId}/card.html`),
      realArtifactBytes(`data/batches/F006/source-snapshots/selection/works/${work.workId}/source.raw`),
    ]),
  ]);
  const queue = [response(archive, 'application/zip'), response(authorPage, 'text/html')];
  for (let index = 0; index < F006_WORKS.length; index += 1) {
    queue.push(response(works[index * 2]!, 'text/html'));
    queue.push(response(works[index * 2 + 1]!, 'text/html'));
  }
  return queue;
}

describe('F006原典・書誌・権利判定（f006-source.ts）', () => {
  /** @des DES-F006-004 @fun FUN-F006-005 @ut UT-F006-005 */
  it('VOICEVOX/ずんだもん3規約の固定clauseをallow/blocked/unknownへ判定する', () => {
    const allow = evaluateF006PolicyClauses('voicevox-terms', POLICY_BODIES[0]!);
    expect(allow.decision).toBe('allow');
    expect(allow.requiredCredit).toBe('VOICEVOX:ずんだもん');

    const missing = evaluateF006PolicyClauses(
      'zundamon-audio-terms',
      new TextEncoder().encode(
        '<html><body>東北ずん子・ずんだもんプロジェクト 音源利用規約。詳細な利用条件についてはこの文書を参照してください。' +
        'クレジット表記に関する規定は別途定めます。</body></html>',
      ),
    );
    expect(missing.decision).toBe('blocked');
    expect(missing.clauses.some((clause) => clause.status === 'missing')).toBe(true);

    const unknown = evaluateF006PolicyClauses('zundamon-character-guideline', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(unknown.decision).toBe('blocked');
    expect(unknown.clauses.every((clause) => clause.status === 'unknown')).toBe(true);

    expect(() => evaluateF006PolicyClauses('aozora-handling' as never, POLICY_BODIES[0]!))
      .toThrow(F006SourceError);
  });

  /** @des DES-F006-004 @fun FUN-F006-005 @ut UT-F006-005 */
  it('校正者が非nullの場合だけ書誌V2を受理する', () => {
    const parsed = parseF006BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '000624');
    expect(parsed.proofreader).toBe('校正者1');

    expect(() => parseF006BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: null,
    }, '000624')).toThrow(F006SourceError);
    expect(() => parseF006BibliographyV2({
      baseEdition: '底本1',
      inputter: '入力者1',
      proofreader: '校正者1',
    }, '999999' as never)).toThrow(F006SourceError);
  });

  /** @des DES-F006-004 @fun FUN-F006-005 @ut UT-F006-005 */
  it('production transport以外・context不一致・phase不正を拒否する', async () => {
    const context = await realF006Context();
    const notProductionTransport = { request: async () => { throw new Error('unused'); } };
    await expect(collectF006SourceSnapshot(
      notProductionTransport as unknown as ProductionAozoraTransport,
      context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F006_TRANSPORT_REQUIRED' });

    await expect(collectF006SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'unknown-phase' as never,
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F006_CONTEXT_INVALID' });

    const f004Context = await loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    );
    await expect(collectF006SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      f004Context,
      'selection',
      () => new Date(),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    )).rejects.toMatchObject({ code: 'F006_CONTEXT_INVALID' });
  });

  /** @des DES-F006-004 @fun FUN-F006-005 @ut UT-F006-005 */
  it('実際に取得済みの公式artifactを再生した固定応答で3作品分のselection snapshotを固定する', async () => {
    const context = await realF006Context();
    const snapshot = await collectF006SourceSnapshot(
      fakeAozoraTransport(await realResponsesQueue()),
      context,
      'selection',
      () => new Date('2026-08-21T06:52:21.272Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    expect(snapshot.authorId).toBe('000119');
    expect(snapshot.works.map((work) => work.workId)).toEqual(['000624', '000621', '001738']);
    expect(snapshot.policies.every((policy) => policy.decision.decision === 'allow')).toBe(true);

    const rights = evaluateF006RightsAndUsage(snapshot, {
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
    expect(() => evaluateF006RightsAndUsage(
      structuredClone(snapshot) as never,
      {
        free: true, advertising: false, payments: false,
        sponsorship: false, unofficial: true, voiceCredit: 'VOICEVOX:ずんだもん',
      },
    )).toThrow(F006SourceError);
  });

  /** @des DES-F006-005 @fun FUN-F006-006 @ut UT-F006-006 */
  it('未定義entity（&nbsp;等）を含むXHTMLをfail-closedで拒否する', async () => {
    const context = await realF006Context();
    const queue = await realResponsesQueue();
    // 弟子(001738)のXHTML raw fixtureへ未承認の&nbsp;を混入させる。
    const tampered = queue[7]!;
    const injected = new TextDecoder('shift_jis').decode(tampered.body)
      .replace('<body>', '<body>&nbsp;');
    queue[7] = response(new TextEncoder().encode(injected).length > 0
      ? Buffer.from(injected, 'latin1')
      : tampered.body, 'text/html');

    const snapshot = await collectF006SourceSnapshot(
      fakeAozoraTransport(queue),
      context,
      'selection',
      () => new Date('2026-08-21T06:52:21.272Z'),
      { policyTransport: fakePolicyTransport(), trustedProjectRoot: workspace, workspace },
    );
    const workSnapshot = snapshot.works.find((work) => work.workId === '001738')!;
    const record = parseF006SourceRecord(workSnapshot, '001738');
    expect(() => normalizeF006AozoraXhtmlEntities(record.raw.bytes, record))
      .toThrow(F006SourceError);
  });

  /** @des DES-F006-004 DES-F006-005 @fun FUN-F006-005 FUN-F006-006 @ut UT-F006-005 UT-F006-006 */
  it('実際に永続化済みの公式snapshotを再mintし、3作品とも未定義entity0件・決定的抽出を確認する', async () => {
    const context = await realF006Context();
    const snapshot = await rehydrateF006SelectionSnapshot(workspace, context);
    expect(snapshot.works.map((work) => work.workId)).toEqual(['000624', '000621', '001738']);

    const expectedCandidateCounts: Record<string, number> = {
      '000624': 3,
      '000621': 4,
      '001738': 55,
    };
    for (const expected of F006_WORKS) {
      const workSnapshot = snapshot.works.find((work) => work.workId === expected.workId)!;
      const record = parseF006SourceRecord(workSnapshot, expected.workId);
      expect(record.bibliography.proofreader).not.toBeNull();

      const normalization = normalizeF006AozoraXhtmlEntities(record.raw.bytes, record);
      expect(normalization.variant).toBe('passthrough');
      expect(normalization.replacements).toEqual([]);

      const first = extractF006DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      const second = extractF006DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
      expect(first.result.ok).toBe(true);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.result.candidates.length).toBe(expectedCandidateCounts[expected.workId]);
    }
  });

  /** @des DES-F006-004 @fun FUN-F006-005 @ut UT-F006-005 */
  it('rehydrateはworkspace外・改変されたpersisted snapshotを拒否する', async () => {
    const context = await realF006Context();
    const root = await mkdtemp(join(tmpdir(), 'bungo-f006-rehydrate-tamper-'));
    temporaryDirectories.push(root);
    await mkdir(resolve(root, 'content/batches/F006/source-snapshots'), { recursive: true });
    await writeFile(
      resolve(root, 'content/batches/F006/source-snapshots/selection.json'),
      JSON.stringify({ not: 'canonical' }),
      'utf8',
    );
    await expect(rehydrateF006SelectionSnapshot(root, context)).rejects.toThrow(F006SourceError);
  });
});
