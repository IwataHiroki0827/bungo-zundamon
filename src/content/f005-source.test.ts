import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mintedTestContexts = vi.hoisted(() => new WeakSet<object>());

vi.mock('./f005-context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./f005-context.ts')>();
  return {
    ...actual,
    isMintedF005ApprovedBatchContext: (value: unknown) =>
      typeof value === 'object' && value !== null && mintedTestContexts.has(value),
  };
});

import {
  AOZORA_BIBLIOGRAPHY_ENTRY,
  AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS,
  MAX_BIBLIOGRAPHY_CSV_BYTES,
  ProductionAozoraTransport,
  extractVerifiedBibliographyCsv,
  type PinnedRequest,
  type TransportResponse,
} from './source.ts';
import {
  POLICY_TRANSPORT_VERSION,
  ProductionPolicyTransport,
  type PolicyTransportResponse,
} from '../notices/policy-snapshots.ts';
import type { F005ApprovedBatchContext } from './f005-context.ts';
import {
  F005SourceError,
  F005_WORKS,
  closeSafeWorkspaceFile,
  collectF005SourceSnapshot,
  evaluateF005RightsAndUsage,
  evaluateF005PolicyClauses,
  extractF005DialogueCandidates,
  formatProofreader,
  getF005NativeGuardProcessCountForTest,
  normalizeAozoraXhtmlEntities,
  normalizeApprovedF005EntityContext,
  parseBibliographyV2,
  parseF005SourceRecord,
  readSafeWorkspaceFile,
  renameSafeWorkspaceFile,
  resolveSafeWorkspaceFile,
} from './f005-source.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipCsv(csv: Uint8Array): Uint8Array {
  const name = Buffer.from(AOZORA_BIBLIOGRAPHY_ENTRY);
  const compressed = deflateRawSync(csv);
  const crc = crc32(csv);
  const local = Buffer.alloc(30 + name.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.byteLength, 18);
  local.writeUInt32LE(csv.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.byteLength, 20);
  central.writeUInt32LE(csv.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(local.byteLength + compressed.byteLength, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

function csvFixture(): Uint8Array {
  const records = F005_WORKS.map((work, index) => {
    const values: Record<string, string> = {
      作品ID: String(Number(work.workId)),
      作品名: work.title,
      文字遣い種別: '新字新仮名',
      作品著作権フラグ: 'なし',
      図書カードURL: work.cardUrl,
      人物ID: '148',
      人物著作権フラグ: 'なし',
      役割フラグ: '著者',
      底本名1: `底本${index + 1}`,
      入力者: `入力者${index + 1}`,
      校正者: index === 0 ? '' : `校正者${index + 1}`,
      'XHTML/HTMLファイルURL': work.sourceUrl,
      'XHTML/HTMLファイル符号化方式': 'Shift_JIS',
      'XHTML/HTMLファイル文字集合': 'Shift_JIS',
    };
    return AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map((column) => values[column] ?? '').join(',');
  });
  return new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${records.join('\n')}\n`);
}

const VALID_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

const VALID_XHTML = new TextEncoder().encode(
  '<?xml version="1.0" encoding="Shift_JIS"?>\n' +
  `${VALID_DOCTYPE}\n` +
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>' +
  '<body><div class="main_text"><p>&#12300;test&#12301;</p></div></body></html>',
);

function response(body: Uint8Array, contentType: string): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': contentType },
    body,
    elapsedMs: 14_999,
    fetchedAt: '2026-07-29T00:00:00.000Z',
    complete: true,
    peerAddress: '8.8.8.8',
    socketSecurity: { tlsAuthorized: true, hostnameVerified: true },
  };
}

function standardResponses(): TransportResponse[] {
  return [
    response(zipCsv(csvFixture()), 'application/zip'),
    response(new TextEncoder().encode('<html>author</html>'), 'text/html; charset=UTF-8'),
    ...F005_WORKS.flatMap(() => [
      response(
        new TextEncoder().encode('<html><body><p>最終更新日：2026-07-29</p></body></html>'),
        'text/html; charset=UTF-8',
      ),
      response(VALID_XHTML, 'text/html; charset=Shift_JIS'),
    ]),
  ];
}

function transportFixture(overrides: readonly TransportResponse[] = []): ProductionAozoraTransport {
  const queue = [...(overrides.length > 0 ? overrides : standardResponses())];
  const socket = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  return new ProductionAozoraTransport({
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    pinnedSocketFactory: socket,
  });
}

const CONTEXT = Object.freeze({
  __brand: 'ApprovedBatchContext',
  candidate: {
    batchId: 'F005',
    feature: 'F005',
    author: { authorId: '000148' },
    works: F005_WORKS.map((work, order) => ({
      workId: work.workId,
      title: work.title,
      order,
      cardUrl: work.cardUrl,
      xhtmlUrl: work.sourceUrl,
    })),
  },
  definition: {
    batchId: 'F005',
    feature: 'F005',
  },
}) as unknown as F005ApprovedBatchContext;
mintedTestContexts.add(CONTEXT);

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

function policyTransportFixture(
  bodies: readonly Uint8Array[] = POLICY_BODIES,
  elapsedMs = 14_999,
): ProductionPolicyTransport {
  let index = 0;
  return new ProductionPolicyTransport({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    pinnedSocketFactory: async (request): Promise<PolicyTransportResponse> => {
      const body = bodies[index++];
      if (!body) throw new Error('unexpected policy request');
      return {
        status: 200,
        mediaType: 'text/html',
        body,
        finalUrl: request.url.href,
        elapsedMs,
        fetchedAt: '2026-07-29T00:00:00.000Z',
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

function collectionOptions(
  root = process.cwd(),
  bodies: readonly Uint8Array[] = POLICY_BODIES,
  selectionSnapshot?: Awaited<ReturnType<typeof collectF005SourceSnapshot>>,
  policyElapsedMs = 14_999,
) {
  return {
    policyTransport: policyTransportFixture(bodies, policyElapsedMs),
    trustedProjectRoot: root,
    workspace: root,
    ...(selectionSnapshot ? { selectionSnapshot } : {}),
  };
}

const USAGE = Object.freeze({
  free: true,
  advertising: false,
  payments: false,
  sponsorship: false,
  unofficial: true,
  voiceCredit: 'VOICEVOX:ずんだもん',
});

describe('F005公式原典snapshotと権利・書誌', () => {
  /** @des DES-F005-001 DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('構造clone contextとrequest overrideされた擬似production transportを取得前に拒否する', async () => {
    const clonedContext = structuredClone(CONTEXT);
    await expect(collectF005SourceSnapshot(
      transportFixture(),
      clonedContext,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'F005_CONTEXT_INVALID' });
    class OverriddenTransport extends ProductionAozoraTransport {
      override async request(): Promise<TransportResponse> {
        return response(Uint8Array.of(), 'application/zip');
      }
    }
    await expect(collectF005SourceSnapshot(
      new OverriddenTransport(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'F005_TRANSPORT_REQUIRED' });
  });

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('production transportの固定responseだけを取得してraw bytesとSHAを保持する', async () => {
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    expect(snapshot.works.map((work) => work.workId)).toEqual(['000799', '001076', '001104']);
    expect(Buffer.from(snapshot.works[0]!.xhtml.bytes)).toEqual(Buffer.from(VALID_XHTML));
    expect(snapshot.works[0]?.xhtml.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.bibliographyCsv.byteLength).toBeGreaterThan(0);
    expect(snapshot.policies.map((policy) => policy.policyId)).toEqual([
      'voicevox-terms',
      'zundamon-audio-terms',
      'zundamon-character-guideline',
    ]);
    expect(snapshot.policies.every((policy) =>
      policy.artifact.transport.tlsAuthorized &&
      policy.artifact.transport.hostnameVerified &&
      policy.artifact.transport.redirectsFollowed === 0 &&
      policy.artifact.transport.proxyUsed === false
    )).toBe(true);
    expect(snapshot.works[0]!.xhtml.transport).toMatchObject({
      dnsAddresses: ['8.8.8.8'],
      connectedAddress: '8.8.8.8',
      hostHeader: 'www.aozora.gr.jp',
      serverName: 'www.aozora.gr.jp',
    });
  });

  /** @des DES-F005-003 @fun FUN-F005-006 FUN-F005-007 @test UT-F005-006 UT-F005-007 */
  it('predeployで規約raw SHAが1件でもdriftしたらsnapshotを返さない', async () => {
    const selection = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const changed = [
      new TextEncoder().encode('VOICEVOX terms changed'),
      POLICY_BODIES[1]!,
      POLICY_BODIES[2]!,
    ];
    await expect(collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'predeploy',
      () => new Date('2026-07-29T00:01:00.000Z'),
      collectionOptions(process.cwd(), changed, selection),
    )).rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });
  });

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('card/XHTML/termsの8MiB同値を許し+1 byteを独立拒否する', async () => {
    const exactResponses = standardResponses();
    exactResponses[2] = response(new Uint8Array(8_388_608), 'text/html; charset=UTF-8');
    await expect(collectF005SourceSnapshot(
      transportFixture(exactResponses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(process.cwd(), [new Uint8Array(8_388_608), POLICY_BODIES[1]!, POLICY_BODIES[2]!]),
    )).resolves.toMatchObject({ phase: 'selection' });

    for (const responseIndex of [2, 3]) {
      const oversized = standardResponses();
      oversized[responseIndex] = response(
        new Uint8Array(8_388_609),
        responseIndex === 2 ? 'text/html; charset=UTF-8' : 'text/html; charset=Shift_JIS',
      );
      await expect(collectF005SourceSnapshot(
        transportFixture(oversized),
        CONTEXT,
        'selection',
        () => new Date('2026-07-29T00:00:00.000Z'),
        collectionOptions(),
      )).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
    }
    await expect(collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(process.cwd(), [new Uint8Array(8_388_609), POLICY_BODIES[1]!, POLICY_BODIES[2]!]),
    )).rejects.toMatchObject({ code: 'F005_SOURCE_RESPONSE_INVALID' });

    const archiveOversized = standardResponses();
    archiveOversized[0] = response(new Uint8Array(8_388_609), 'application/zip');
    await expect(collectF005SourceSnapshot(
      transportFixture(archiveOversized),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });

    const partial = standardResponses();
    partial[0] = { ...partial[0]!, complete: false };
    await expect(collectF005SourceSnapshot(
      transportFixture(partial),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'PARTIAL_RESPONSE' });
  }, 30_000);

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it.each(['127.0.0.1', '169.254.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1'])(
    'SSRF special/mapped/private分類 %s をsocket前に拒否する',
    async (address) => {
      const socket = vi.fn();
      const unsafe = new ProductionAozoraTransport({
        resolver: async () => [{ address }],
        pinnedSocketFactory: socket,
      });
      await expect(collectF005SourceSnapshot(
        unsafe,
        CONTEXT,
        'selection',
        () => new Date('2026-07-29T00:00:00.000Z'),
        collectionOptions(),
      )).rejects.toMatchObject({ code: 'UNSAFE_RESOLVED_ADDRESS' });
      expect(socket).not.toHaveBeenCalled();
    },
  );

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('15,000msとcharset差をfail-closedで拒否する', async () => {
    const bad = response(zipCsv(csvFixture()), 'application/zip');
    bad.elapsedMs = 15_000;
    await expect(collectF005SourceSnapshot(
      transportFixture([bad]),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'F005_SOURCE_RESPONSE_INVALID' });
    await expect(collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(process.cwd(), POLICY_BODIES, undefined, 15_000),
    )).rejects.toMatchObject({ code: 'F005_SOURCE_RESPONSE_INVALID' });
  });

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('展開CSV 32MiB同値を許し+1 byteをZIP展開前に拒否する', () => {
    const exactHeader = new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n`);
    const boundaryCsv = (length: number): Uint8Array => {
      const value = new Uint8Array(length);
      value.set(exactHeader);
      let random = 0x9e3779b9;
      for (let index = exactHeader.byteLength; index < value.byteLength; index += 5) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        value.fill(0x20 + (random & 0x5f), index, Math.min(index + 5, value.byteLength));
      }
      return value;
    };
    const exact = boundaryCsv(MAX_BIBLIOGRAPHY_CSV_BYTES);
    expect(extractVerifiedBibliographyCsv(zipCsv(exact))).toHaveLength(MAX_BIBLIOGRAPHY_CSV_BYTES);
    const oversized = boundaryCsv(MAX_BIBLIOGRAPHY_CSV_BYTES + 1);
    expect(() => extractVerifiedBibliographyCsv(zipCsv(oversized))).toThrowError(
      expect.objectContaining({ code: 'BIBLIOGRAPHY_ZIP_BOMB' }),
    );
  }, 30_000);

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('HTTP/TLS/DNS/peer pinを独立検証しDNS回答外peerとredirectを拒否する', async () => {
    const redirect = standardResponses();
    redirect[0] = { ...redirect[0]!, status: 302 };
    await expect(collectF005SourceSnapshot(
      transportFixture(redirect),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'HTTP_STATUS' });

    const peerResponses = standardResponses();
    peerResponses[0] = { ...peerResponses[0]!, peerAddress: '8.8.4.4' };
    const requests: PinnedRequest[] = [];
    const queue = [...peerResponses];
    const transport = new ProductionAozoraTransport({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      pinnedSocketFactory: async (request) => {
        requests.push(request);
        return queue.shift()!;
      },
    });
    await expect(collectF005SourceSnapshot(
      transport,
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'UNSAFE_RESOLVED_ADDRESS' });
    expect(requests[0]).toMatchObject({
      address: '8.8.8.8',
      hostHeader: 'www.aozora.gr.jp',
      serverName: 'www.aozora.gr.jp',
      rejectUnauthorized: true,
      checkServerIdentity: true,
      followRedirects: false,
      useEnvironmentProxy: false,
    });

    for (const mutation of [
      { peerAddress: undefined },
      { socketSecurity: { tlsAuthorized: false, hostnameVerified: true } },
      { socketSecurity: { tlsAuthorized: true, hostnameVerified: false } },
    ] as const) {
      const invalid = standardResponses();
      invalid[0] = { ...invalid[0]!, ...mutation };
      await expect(collectF005SourceSnapshot(
        transportFixture(invalid),
        CONTEXT,
        'selection',
        () => new Date('2026-07-29T00:00:00.000Z'),
        collectionOptions(),
      )).rejects.toMatchObject({ code: 'TLS_INVALID' });
    }
  });

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it('ProductionAozoraTransportのresolver/socket DIをNODE_ENV=test以外で拒否する', () => {
    const previous = process.env.NODE_ENV;
    try {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => new ProductionAozoraTransport({
        resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      })).toThrowError(/NODE_ENV=test/u);
      expect(() => new ProductionAozoraTransport()).not.toThrow();
    } finally {
      vi.stubEnv('NODE_ENV', previous ?? 'test');
    }
  });

  /** @des DES-F005-003 @fun FUN-F005-007 FUN-F005-008 @test UT-F005-007 UT-F005-008 */
  it('exact用途だけallowし、夢十夜だけnull校正者のSourceRecordV2にする', async () => {
    const selection = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'predeploy',
      () => new Date('2026-07-29T00:01:00.000Z'),
      collectionOptions(process.cwd(), POLICY_BODIES, selection),
    );
    expect(evaluateF005RightsAndUsage(snapshot, USAGE).decision).toBe('allow');
    expect(evaluateF005RightsAndUsage(snapshot, { ...USAGE, advertising: true }).decision).toBe('blocked');
    const records = snapshot.works.map((work, index) => parseF005SourceRecord(work, F005_WORKS[index]!));
    expect(records[0]?.bibliography.proofreader).toBeNull();
    expect(records[1]?.bibliography.proofreader).toBe('校正者2');
    expect(records[0]).toMatchObject({
      updatedAt: '2026-07-29',
      cardRawSha256: records[0]!.card.sha256,
      cardRawBytes: records[0]!.card.byteLength,
    });
  });

  /** @des DES-F005-003 @fun FUN-F005-008 @test UT-F005-008 */
  it.each(['2026-02-31', '2025-02-29', '2026-13-01'])(
    'card最終更新日%sを暦日component round-tripで拒否する',
    async (invalidDate) => {
      const responses = standardResponses();
      responses[2] = response(
        new TextEncoder().encode(`<html><body><p>最終更新日：${invalidDate}</p></body></html>`),
        'text/html; charset=UTF-8',
      );
      const snapshot = await collectF005SourceSnapshot(
        transportFixture(responses),
        CONTEXT,
        'selection',
        () => new Date('2026-07-29T00:00:00.000Z'),
        collectionOptions(),
      );
      expect(() => parseF005SourceRecord(snapshot.works[0]!, '000799'))
        .toThrowError(/最終更新日が不正/u);
    },
  );

  /** @des DES-F005-003 DES-F005-004 @fun FUN-F005-008 FUN-F005-009 @test UT-F005-008 */
  it('SourceRecordV2のmutable raw/card bytes改変を次の信頼境界で拒否する', async () => {
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const source = parseF005SourceRecord(snapshot.works[0]!, '000799');
    source.card.bytes[0] = (source.card.bytes[0] ?? 0) ^ 0xff;
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-mutated-'));
    temporaryDirectories.push(root);
    await expect(normalizeAozoraXhtmlEntities(source.raw.bytes, source, '1.0.0', root))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });
  });

  /** @des DES-F005-003 DES-F005-007 @fun FUN-F005-024 @test UT-F005-024 */
  it('nullable書誌をexact検証し、nullを「記載なし」へ投影する', () => {
    const parsed = parseBibliographyV2(
      { baseEdition: '底本', inputter: '入力者', proofreader: null },
      '000799',
    );
    expect(formatProofreader(parsed.proofreader)).toBe('記載なし');
    expect(() => parseBibliographyV2(
      { baseEdition: '底本', inputter: '入力者', proofreader: '' },
      '001076',
    )).toThrow(F005SourceError);
    expect(() => parseBibliographyV2(
      { baseEdition: '底本', inputter: '入力者', proofreader: null, unknown: true },
      '000799',
    )).toThrow(F005SourceError);
  });

  /** @des DES-F005-003 @fun FUN-F005-007 @test UT-F005-007 */
  it.each([
    ['意味なし', new TextEncoder().encode('meaningless')],
    ['credit欠落', new TextEncoder().encode(
      '<html><body>VOICEVOX 利用規約。無料利用できます。利用できます。'.repeat(4) + '</body></html>',
    )],
    ['禁止', new TextEncoder().encode(
      '<html><body>VOICEVOX 利用規約。クレジット表記 VOICEVOX:ずんだもん。無料利用は禁止します。'.repeat(3) +
      '</body></html>',
    )],
    ['unknown byte', Uint8Array.of(0xff, 0xfe, 0xfd)],
  ])('deterministic clause evaluatorは%s本文をblockedにする', (_label, body) => {
    const decision = evaluateF005PolicyClauses('voicevox-terms', body);
    expect(decision.decision).toBe('blocked');
    expect(decision.clauses.some((clause) => clause.status !== 'satisfied')).toBe(true);
  });
});

describe('F005 entity正規化と安全抽出', () => {
  /** @des DES-F005-004 @fun FUN-F005-009 @test UT-F005-009 */
  it('notation_notes内の連続2 entityだけを等長numeric entityへ置換する', () => {
    const raw = new TextEncoder().encode(
      '<html><body><div class="notation_notes"><table><tr><td>&nbsp;&nbsp;</td></tr></table></div></body></html>',
    );
    const normalized = normalizeApprovedF005EntityContext(raw);
    expect(new TextDecoder().decode(normalized.bytes)).toContain('<td>&#160;&#160;</td>');
    expect(normalized.bytes.byteLength).toBe(raw.byteLength);
    expect(normalized.replacements).toHaveLength(2);
  });

  /** @des DES-F005-004 @fun FUN-F005-009 @test UT-F005-009 */
  it('公式「趣味の遺伝」raw実体を固定SHAで2件だけ正規化する', async () => {
    const live = await fetch('https://www.aozora.gr.jp/cards/000148/files/1104_14948.html', {
      redirect: 'error',
    });
    expect(live.status).toBe(200);
    const raw = new Uint8Array(await live.arrayBuffer());
    expect(raw.byteLength).toBe(161_913);
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe('91209534d37abf5fc66a4720eb167b0315aefbd5ea8842cccd731d4155e982ef');
    const normalized = normalizeApprovedF005EntityContext(raw);
    expect(normalized.replacements).toHaveLength(2);
    expect(createHash('sha256').update(normalized.bytes).digest('hex'))
      .toBe('c1e2f27fe6acc91bdb8b66115f21a3efd64fadbc9112e7365f574e94ff69696b');
  }, 20_000);

  /** @des DES-F005-004 @fun FUN-F005-009 FUN-F005-010 @test UT-F005-009 UT-F005-010 */
  it('passthrough作品をpreflight後に二重抽出して同一候補を返す', async () => {
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const source = parseF005SourceRecord(snapshot.works[0]!, '000799');
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-sealed-'));
    temporaryDirectories.push(root);
    const normalized = await normalizeAozoraXhtmlEntities(source.raw.bytes, source, '1.0.0', root);
    expect(normalized.variant).toBe('passthrough');
    expect(normalized.replacements).toHaveLength(0);
    const candidates = await extractF005DialogueCandidates(normalized, source, '1.0.0');
    expect(candidates.result.ok).toBe(true);
    if (candidates.result.ok) expect(candidates.result.candidates).toHaveLength(1);
  });

  /** @des DES-F005-004 @fun FUN-F005-009 @test UT-F005-009 */
  it('趣味の遺伝は承認raw length/hashでない限りentity variantをmintしない', async () => {
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const source = parseF005SourceRecord(snapshot.works[2]!, '001104');
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-invalid-'));
    temporaryDirectories.push(root);
    await expect(normalizeAozoraXhtmlEntities(source.raw.bytes, source, '1.0.0', root))
      .rejects.toThrowError(/承認hash/u);
  });

  /** @des DES-F005-004 @fun FUN-F005-010 @test UT-F005-010 */
  it.each([
    ['internal subset', '<!DOCTYPE html [<!ENTITY x "y">]><html><body><div class="main_text"/></body></html>'],
    ['ENTITY', `${VALID_DOCTYPE}<!ENTITY x "y"><html><body><div class="main_text"/></body></html>`],
    ['XInclude', `${VALID_DOCTYPE}<html><body><xi:include href="file:///x"/></body></html>`],
    ['schema', `${VALID_DOCTYPE}<html xsi:schemaLocation="https://evil.example/x"><body/></html>`],
    ['stylesheet', `<?xml-stylesheet href="https://evil.example/x.css"?>${VALID_DOCTYPE}<html><body/></html>`],
    ['depth', `${VALID_DOCTYPE}<html><body>${'<div>'.repeat(257)}x${'</div>'.repeat(257)}</body></html>`],
    ['nodes', `${VALID_DOCTYPE}<html><body>${'<br/>'.repeat(500_001)}</body></html>`],
    ['text', `${VALID_DOCTYPE}<html><body><div class="main_text">${'a'.repeat(4_000_001)}</div></body></html>`],
  ])('%s resourceをDOM parse前に拒否する', async (_label, xhtml) => {
    const responses = standardResponses();
    responses[3] = response(new TextEncoder().encode(xhtml), 'text/html; charset=Shift_JIS');
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const source = parseF005SourceRecord(snapshot.works[0]!, '000799');
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-xml-negative-'));
    temporaryDirectories.push(root);
    const normalized = await normalizeAozoraXhtmlEntities(source.raw.bytes, source, '1.0.0', root);
    await expect(extractF005DialogueCandidates(normalized, source, '1.0.0'))
      .rejects.toMatchObject({ code: 'F005_XHTML_PREFLIGHT_REJECTED' });
  }, 30_000);
});

describe('F005 Windows安全path', () => {
  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('root内single-link regular fileだけをidentity付きで解決する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-safe-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'content'));
    await writeFile(join(root, 'content', 'safe.json'), '{}');
    const result = await resolveSafeWorkspaceFile(root, 'content/safe.json', 'read');
    expect(result.exists).toBe(true);
    expect(result.identity?.size).toBe(2);
    expect(Buffer.from(await readSafeWorkspaceFile(result)).toString('utf8')).toBe('{}');
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it.each([
    '../outside', 'C:/outside', '//server/share', '//?/C:/device', '//./device',
    'a\\b', 'file:ads', 'CON', 'PRN.txt', 'AUX', 'NUL', 'COM1.txt', 'COM9',
    'LPT1.txt', 'LPT9', 'a/%2f/b', 'a/%5c/b', 'trailing.', 'trailing ',
    'empty//segment', 'dot/./segment', 'dotdot/../segment', 'e\u0301.txt', `control/${String.fromCharCode(1)}.txt`,
  ])(
    '危険path %s を拒否する',
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), 'bungo-f005-path-'));
      temporaryDirectories.push(root);
      await expect(resolveSafeWorkspaceFile(root, path, 'read')).rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    },
  );

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('hardlink実体を拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-hardlink-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'source.json'), '{}');
    await link(join(root, 'source.json'), join(root, 'linked.json'));
    await expect(resolveSafeWorkspaceFile(root, 'source.json', 'read'))
      .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('production APIがnative handleでparent/source swapを止め、target挿入もfail-closedにする', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-swap-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'content'));
    await writeFile(join(root, 'content', 'safe.json'), '{}');
    let parentCapability: Awaited<ReturnType<typeof resolveSafeWorkspaceFile>> | undefined;
    let renameCapability: Awaited<ReturnType<typeof resolveSafeWorkspaceFile>> | undefined;
    const stagingPath = join(root, 'content', 'staging.tmp');
    try {
      parentCapability = await resolveSafeWorkspaceFile(root, 'content/safe.json', 'read');
      await expect(rename(join(root, 'content', 'safe.json'), join(root, 'content', 'old-safe.json')))
        .rejects.toBeDefined();
      await expect(rename(join(root, 'content'), join(root, 'old-content'))).rejects.toBeDefined();
      expect(Buffer.from(await readSafeWorkspaceFile(parentCapability)).toString('utf8')).toBe('{}');

      await writeFile(stagingPath, 'trusted');
      renameCapability = await resolveSafeWorkspaceFile(root, 'content/staging.tmp', 'rename-source');
      await writeFile(join(root, 'content', 'new.json'), 'attacker');
      await expect(renameSafeWorkspaceFile(renameCapability, 'content/new.json'))
        .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
      expect(renameCapability).not.toHaveProperty('absolutePath');
      expect(renameCapability).not.toHaveProperty('root');
    } finally {
      if (parentCapability) await closeSafeWorkspaceFile(parentCapability);
      if (renameCapability) await closeSafeWorkspaceFile(renameCapability);
      // helper exit待機後ならWindows file handleが残らず即時unlinkできる。
      await rm(stagingPath, { force: true });
    }
    expect(getF005NativeGuardProcessCountForTest()).toBe(0);
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('capability取得後のoperation不一致と不正targetでもhelper終了を待つ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-guard-cleanup-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'source.json'), '{}');

    const renameCapability = await resolveSafeWorkspaceFile(root, 'source.json', 'rename-source');
    await expect(readSafeWorkspaceFile(renameCapability))
      .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    expect(getF005NativeGuardProcessCountForTest()).toBe(0);

    const readCapability = await resolveSafeWorkspaceFile(root, 'source.json', 'read');
    await expect(renameSafeWorkspaceFile(readCapability, '../outside.json'))
      .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    expect(getF005NativeGuardProcessCountForTest()).toBe(0);
  });
});
