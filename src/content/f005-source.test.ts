import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { writeF005SourceArtifactOnce } from '../../scripts/f005-collect-source.ts';
import { assertGuardExecutableAvailable } from './f005-test-support.ts';

// SafeWorkspaceFile系APIは実native guard exeをspawnするため、欠損時は明示エラーで停止する。
beforeAll(async () => {
  await assertGuardExecutableAvailable();
});

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
  F005_SELECTION_SNAPSHOT_PATH,
  F005_WORKS,
  closeSafeWorkspaceFile,
  collectF005SourceSnapshot,
  evaluateF005RightsAndUsage,
  evaluateF005PolicyClauses,
  extractF005DialogueCandidates,
  extractVerifiedShumiNotice,
  formatProofreader,
  getF005NativeGuardProcessCountForTest,
  normalizeAozoraXhtmlEntities,
  normalizeApprovedF005EntityContext,
  parseBibliographyV2,
  parseF005SourceRecord,
  readSafeWorkspaceFile,
  rehydrateF005PredeploySnapshot,
  rehydrateF005SelectionSnapshot,
  renameSafeWorkspaceFile,
  resolveSafeWorkspaceFile,
  type F005ShumiNoticeCandidate,
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
    response(
      new TextEncoder().encode('<html><head><meta charset="utf-8"></head><body>author</body></html>'),
      'text/html',
    ),
    ...F005_WORKS.flatMap(() => [
      response(
        new TextEncoder().encode(
          '<html><head><meta http-equiv="Content-Type" content="text/html;charset=utf-8"></head>' +
          '<body><p>最終更新日：2026-07-29</p></body></html>',
        ),
        'text/html',
      ),
      response(VALID_XHTML, 'text/html'),
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

async function persistSelectionSnapshot(
  root: string,
  snapshot: Awaited<ReturnType<typeof collectF005SourceSnapshot>>,
): Promise<Record<string, unknown>> {
  const entries = [
    {
      path: 'data/batches/F005/source-snapshots/selection/bibliography.zip',
      artifact: snapshot.bibliographyArchive,
    },
    {
      path: 'data/batches/F005/source-snapshots/selection/bibliography.csv',
      artifact: snapshot.bibliographyCsv,
    },
    {
      path: 'data/batches/F005/source-snapshots/selection/author-page.html',
      artifact: snapshot.authorPage,
    },
    ...snapshot.policies.map((policy) => ({
      path: `data/batches/F005/source-snapshots/selection/policies/${policy.policyId}.raw`,
      artifact: policy.artifact,
    })),
    ...snapshot.works.flatMap((work) => [
      {
        path: `data/batches/F005/source-snapshots/selection/works/${work.workId}/card.html`,
        artifact: work.card,
      },
      {
        path: `data/batches/F005/source-snapshots/selection/works/${work.workId}/source.raw`,
        artifact: work.xhtml,
      },
    ]),
  ];
  for (const entry of entries) {
    const target = join(root, ...entry.path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, entry.artifact.bytes);
  }
  const metadata = (
    artifact: (typeof entries)[number]['artifact'],
    path: string,
  ): Record<string, unknown> => ({
    storage: 'sealed',
    path,
    sourceUrl: artifact.sourceUrl,
    fetchedAt: artifact.fetchedAt,
    mediaType: artifact.mediaType,
    charset: artifact.charset,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    transport: artifact.transport,
  });
  const artifact = {
    schemaVersion: '2.0.0',
    kind: 'f005-source-selection-snapshot',
    batchId: 'F005',
    authorId: snapshot.authorId,
    phase: snapshot.phase,
    observedAt: snapshot.observedAt,
    rights: evaluateF005RightsAndUsage(snapshot, USAGE),
    bibliographyArchive: metadata(snapshot.bibliographyArchive, entries[0]!.path),
    bibliographyCsv: metadata(snapshot.bibliographyCsv, entries[1]!.path),
    authorPage: metadata(snapshot.authorPage, entries[2]!.path),
    policies: snapshot.policies.map((policy) => {
      const entry = entries.find((item) => item.artifact === policy.artifact)!;
      return {
        policyId: policy.policyId,
        versionOrLabel: policy.versionOrLabel,
        artifact: metadata(policy.artifact, entry.path),
        decision: policy.decision,
      };
    }),
    works: snapshot.works.map((work) => {
      const card = entries.find((item) => item.artifact === work.card)!;
      const xhtml = entries.find((item) => item.artifact === work.xhtml)!;
      return {
        workId: work.workId,
        title: work.title,
        bibliography: work.bibliography,
        card: metadata(work.card, card.path),
        xhtml: metadata(work.xhtml, xhtml.path),
      };
    }),
  };
  const snapshotPath = join(root, ...F005_SELECTION_SNAPSHOT_PATH.split('/'));
  await mkdir(join(snapshotPath, '..'), { recursive: true });
  await writeFile(snapshotPath, canonicalJson(artifact));
  return artifact;
}

describe('F005公式原典snapshotと権利・書誌', () => {
  /** @des DES-F005-001 DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it.runIf(process.platform === 'win32')('初回selection archive/JSONを既存root anchorからbootstrapし、後続anchorへ切り替える', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-source-bootstrap-'));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(join(root, 'data', 'batches', 'F005', 'source-snapshots', 'selection'), { recursive: true }),
      mkdir(join(root, 'content', 'batches', 'F005', 'source-snapshots'), { recursive: true }),
    ]);
    await writeFile(join(root, 'package.json'), '{"private":true}\n');
    const archivePath = 'data/batches/F005/source-snapshots/selection/bibliography.zip';
    const selectionPath = F005_SELECTION_SNAPSHOT_PATH;
    const followupDataPath =
      'data/batches/F005/source-snapshots/selection/predeploy-bootstrap-author-page.html';
    const followupJsonPath =
      'content/batches/F005/source-snapshots/predeploy-bootstrap.json';
    await writeF005SourceArtifactOnce(root, archivePath, Uint8Array.of(1, 2, 3));
    await writeF005SourceArtifactOnce(root, selectionPath, new TextEncoder().encode('{}\n'));
    await writeF005SourceArtifactOnce(root, followupDataPath, Uint8Array.of(4, 5, 6));
    await writeF005SourceArtifactOnce(root, followupJsonPath, new TextEncoder().encode('{"ok":true}\n'));
    await expect(readFile(join(root, ...archivePath.split('/')))).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(readFile(join(root, ...selectionPath.split('/')), 'utf8')).resolves.toBe('{}\n');
    await expect(readFile(join(root, ...followupDataPath.split('/')))).resolves.toEqual(Buffer.from([4, 5, 6]));
    await expect(readFile(join(root, ...followupJsonPath.split('/')), 'utf8')).resolves.toBe('{"ok":true}\n');
  });

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

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 @it IT-F005-003 */
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
  it.runIf(process.platform === 'win32')('永続化selectionを実物とApproved Contextへ再結合し、process再開相当のpredeployへ渡す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-rehydrate-'));
    temporaryDirectories.push(root);
    const original = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(root),
    );
    await persistSelectionSnapshot(root, original);
    const rehydrated = await rehydrateF005SelectionSnapshot(root, CONTEXT);
    expect(rehydrated).not.toBe(original);
    expect(rehydrated).toEqual(original);
    await expect(collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'predeploy',
      () => new Date('2026-07-29T00:01:00.000Z'),
      collectionOptions(root, POLICY_BODIES, rehydrated),
    )).resolves.toMatchObject({ phase: 'predeploy' });
    await expect(rehydrateF005SelectionSnapshot(root, structuredClone(CONTEXT)))
      .rejects.toMatchObject({ code: 'F005_CONTEXT_INVALID' });
  });

  /** @des DES-F005-001 DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it.runIf(process.platform === 'win32')('8MiB超の永続化書誌CSVも同一FileHandle identityから再結合する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-rehydrate-large-'));
    temporaryDirectories.push(root);
    const base = csvFixture();
    const chunks: Uint8Array[] = [base];
    let largeBytes = base.byteLength;
    while (largeBytes <= 8_388_608) {
      const filler = new TextEncoder().encode(
        `${randomBytes(96).toString('hex')}${','.repeat(AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.length - 1)}\n`,
      );
      chunks.push(filler);
      largeBytes += filler.byteLength;
    }
    const largeCsv = Buffer.concat(chunks);
    const responses = standardResponses();
    responses[0] = response(zipCsv(largeCsv), 'application/zip');
    const original = await collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(root),
    );
    const artifact = await persistSelectionSnapshot(root, original);
    const rehydrated = await rehydrateF005SelectionSnapshot(root, CONTEXT);
    expect(rehydrated.bibliographyCsv.byteLength).toBe(largeCsv.byteLength);
    expect(rehydrated.bibliographyCsv.sha256).toBe(original.bibliographyCsv.sha256);
    const derived = structuredClone(artifact) as {
      bibliographyArchive: { path: string; sha256: string };
      bibliographyCsv: Record<string, unknown>;
    };
    derived.bibliographyCsv = {
      ...derived.bibliographyCsv,
      storage: 'derived',
      path: derived.bibliographyArchive.path,
      derivedFromSha256: derived.bibliographyArchive.sha256,
    };
    await rm(join(root, 'data', 'batches', 'F005', 'source-snapshots', 'selection', 'bibliography.csv'));
    await writeFile(
      join(root, ...F005_SELECTION_SNAPSHOT_PATH.split('/')),
      canonicalJson(derived),
    );
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .resolves.toMatchObject({ bibliographyCsv: { byteLength: largeCsv.byteLength } });
  }, 30_000);

  /** @des DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it.runIf(process.platform === 'win32')('永続化selectionの非canonical JSON・未知key・path・decision・実体SHA改変を拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-rehydrate-tamper-'));
    temporaryDirectories.push(root);
    const original = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(root),
    );
    const artifact = await persistSelectionSnapshot(root, original);
    const snapshotPath = join(root, ...F005_SELECTION_SNAPSHOT_PATH.split('/'));

    await writeFile(snapshotPath, JSON.stringify(artifact));
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });

    const unknown = structuredClone(artifact);
    unknown.unexpected = true;
    await writeFile(snapshotPath, canonicalJson(unknown));
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });

    const unsafePath = structuredClone(artifact) as {
      works: Array<{ card: { path: string } }>;
    };
    unsafePath.works[0]!.card.path = '../card.html';
    await writeFile(snapshotPath, canonicalJson(unsafePath));
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });

    const changedDecision = structuredClone(artifact) as {
      policies: Array<{ decision: { decision: string } }>;
    };
    changedDecision.policies[0]!.decision.decision = 'blocked';
    await writeFile(snapshotPath, canonicalJson(changedDecision));
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });

    await writeFile(snapshotPath, canonicalJson(artifact));
    const sourcePath = join(
      root,
      'data',
      'batches',
      'F005',
      'source-snapshots',
      'selection',
      'works',
      '000799',
      'source.raw',
    );
    await writeFile(sourcePath, Uint8Array.of(1, 2, 3));
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });
  }, 30_000);

  /** @des DES-F005-001 DES-F005-003 @fun FUN-F005-006 @test UT-F005-006 */
  it.runIf(process.platform === 'win32')('永続化selectionの参照実体がsymlinkなら拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-rehydrate-link-'));
    temporaryDirectories.push(root);
    const original = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(root),
    );
    await persistSelectionSnapshot(root, original);
    const workDirectory = join(
      root,
      'data',
      'batches',
      'F005',
      'source-snapshots',
      'selection',
      'works',
      '000799',
    );
    const external = join(root, 'external-work');
    await mkdir(external);
    await rm(workDirectory, { recursive: true });
    await symlink(external, workDirectory, 'junction');
    await expect(rehydrateF005SelectionSnapshot(root, CONTEXT))
      .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
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
  it('HTTP charset欠落時は本文宣言だけを採用し、宣言不一致を拒否する', async () => {
    const accepted = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    expect(accepted.authorPage.charset).toBe('UTF-8');
    expect(accepted.works[0]!.card.charset).toBe('UTF-8');
    expect(accepted.works[0]!.xhtml.charset).toBe('Shift_JIS');

    const responses = standardResponses();
    responses[1] = response(
      new TextEncoder().encode('<html><head><meta charset="shift_jis"></head></html>'),
      'text/html',
    );
    await expect(collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    )).rejects.toMatchObject({ code: 'F005_SOURCE_RESPONSE_INVALID' });
  });

  /** @des DES-F005-003 @fun FUN-F005-008 @test UT-F005-008 */
  it('図書カード表の対象XHTML行から最終更新日を一意に固定する', async () => {
    const responses = standardResponses();
    responses[2] = response(
      new TextEncoder().encode(
        '<html><head><meta charset="utf-8"></head><body>' +
        '<table><tr><th>初登録日</th><th>最終更新日</th></tr>' +
        '<tr><td><a href="./files/799_14972.html">XHTML</a></td>' +
        '<td>2004-02-29</td><td>2013-07-17</td></tr></table></body></html>',
      ),
      'text/html',
    );
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    expect(parseF005SourceRecord(snapshot.works[0]!, '000799').updatedAt)
      .toBe('2013-07-17');
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

  /** @des DES-F005-003 DES-F005-004 @fun FUN-F005-008 FUN-F005-009 @test UT-F005-008 @it IT-F005-003 */
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
  it.runIf(process.platform === 'win32')('passthrough作品をpreflight後に二重抽出して同一候補を返す', async () => {
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
  it.runIf(process.platform === 'win32').each([
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
  it.runIf(process.platform === 'win32')('root内single-link regular fileだけをidentity付きで解決する', async () => {
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
  it.runIf(process.platform === 'win32')('production APIがnative handleでparent/source swapを止め、target挿入もfail-closedにする', async () => {
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
      await expect(renameSafeWorkspaceFile(
        renameCapability,
        'content/new.json',
        renameCapability.nativeIdentity,
      ))
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
  it.runIf(process.platform === 'win32')('capability取得後のoperation不一致と不正targetでもhelper終了を待つ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-guard-cleanup-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'source.json'), '{}');

    const renameCapability = await resolveSafeWorkspaceFile(root, 'source.json', 'rename-source');
    await expect(readSafeWorkspaceFile(renameCapability))
      .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    expect(getF005NativeGuardProcessCountForTest()).toBe(0);

    const readCapability = await resolveSafeWorkspaceFile(root, 'source.json', 'read');
    await expect(renameSafeWorkspaceFile(
      readCapability,
      '../outside.json',
      readCapability.nativeIdentity,
    ))
      .rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    expect(getF005NativeGuardProcessCountForTest()).toBe(0);
  });
});

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const SHUMI_NOTICE_TEXT =
  'この作品には、今日からみれば、不適切と受け取られる可能性のある表現がみられます。' +
  'その旨をここに記載した上で、そのままの形で作品を公開します。（青空文庫）';

function shumiCardHtml(noticeText: string): Uint8Array {
  return new TextEncoder().encode(
    '<html><head><meta charset="utf-8"></head><body>' +
    '<p>最終更新日：2026-07-29</p>' +
    '<table><tr><td class="header">備考：</td><td>' +
    `${noticeText}<br><div id="link"></div><script type="text/javascript" src="../link.js"></script>` +
    '</td></tr></table></body></html>',
  );
}

function shumiCandidate(overrides: Partial<F005ShumiNoticeCandidate> = {}): F005ShumiNoticeCandidate {
  return {
    schemaVersion: 1,
    workId: '001104',
    text: SHUMI_NOTICE_TEXT,
    sourceUrl: F005_WORKS[2]!.cardUrl,
    sourceRawSha256: sha256Hex(shumiCardHtml(SHUMI_NOTICE_TEXT)),
    textSha256: sha256Hex(SHUMI_NOTICE_TEXT),
    placements: ['author', 'work', 'credits'],
    ...overrides,
  };
}

describe('UT-F005-014 表現注意の検証済み抽出 [DES-F005-005][DES-F005-010][FUN-F005-014]', () => {
  async function shumiSourceRecord(cardNoticeText = SHUMI_NOTICE_TEXT) {
    const responses = standardResponses();
    responses[6] = response(shumiCardHtml(cardNoticeText), 'text/html');
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    return parseF005SourceRecord(snapshot.works[2]!, '001104');
  }

  it('公式card raw内の唯一trusted備考行から独立に再計算した値だけを検証済みnoticeとして返す', async () => {
    const source = await shumiSourceRecord();
    const notice = extractVerifiedShumiNotice(source, shumiCandidate());
    expect(notice).toMatchObject({
      schemaVersion: 1,
      workId: '001104',
      text: SHUMI_NOTICE_TEXT,
      sourceUrl: F005_WORKS[2]!.cardUrl,
      placements: ['author', 'work', 'credits'],
    });
    expect(notice.sourceRawSha256).toBe(source.cardRawSha256);
    expect(notice.textSha256).toBe(sha256Hex(SHUMI_NOTICE_TEXT));
  });

  it('自己申告値同士だけが一致していてもcard実体と異なれば拒否する', async () => {
    const source = await shumiSourceRecord();
    const forgedText = `${SHUMI_NOTICE_TEXT}改変`;
    const forged = shumiCandidate({
      text: forgedText,
      textSha256: sha256Hex(forgedText),
    });
    expect(() => extractVerifiedShumiNotice(source, forged))
      .toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
  });

  it('備考行が0件・複数件のcardを拒否する', async () => {
    const noNoticeResponses = standardResponses();
    noNoticeResponses[6] = response(
      new TextEncoder().encode(
        '<html><head><meta charset="utf-8"></head><body><p>最終更新日：2026-07-29</p></body></html>',
      ),
      'text/html',
    );
    const noNoticeSnapshot = await collectF005SourceSnapshot(
      transportFixture(noNoticeResponses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const noNoticeSource = parseF005SourceRecord(noNoticeSnapshot.works[2]!, '001104');
    expect(() => extractVerifiedShumiNotice(noNoticeSource, shumiCandidate()))
      .toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));

    const duplicateHtml = new TextEncoder().encode(
      '<html><head><meta charset="utf-8"></head><body>' +
      '<p>最終更新日：2026-07-29</p>' +
      '<table>' +
      `<tr><td class="header">備考：</td><td>${SHUMI_NOTICE_TEXT}<br><div id="link"></div>` +
      '<script type="text/javascript" src="../link.js"></script></td></tr>' +
      `<tr><td class="header">備考：</td><td>${SHUMI_NOTICE_TEXT}<br><div id="link"></div>` +
      '<script type="text/javascript" src="../link.js"></script></td></tr>' +
      '</table></body></html>',
    );
    const duplicateResponses = standardResponses();
    duplicateResponses[6] = response(duplicateHtml, 'text/html');
    const duplicateSnapshot = await collectF005SourceSnapshot(
      transportFixture(duplicateResponses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const duplicateSource = parseF005SourceRecord(duplicateSnapshot.works[2]!, '001104');
    expect(() => extractVerifiedShumiNotice(duplicateSource, shumiCandidate()))
      .toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
  });

  it('HTML注入を試みた備考行を拒否する', async () => {
    const injectedHtml = new TextEncoder().encode(
      '<html><head><meta charset="utf-8"></head><body>' +
      '<p>最終更新日：2026-07-29</p>' +
      '<table><tr><td class="header">備考：</td><td>' +
      '<b>危険</b>この作品には…<br><div id="link"></div>' +
      '<script type="text/javascript" src="../link.js"></script></td></tr></table></body></html>',
    );
    const responses = standardResponses();
    responses[6] = response(injectedHtml, 'text/html');
    const snapshot = await collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const source = parseF005SourceRecord(snapshot.works[2]!, '001104');
    expect(() => extractVerifiedShumiNotice(source, shumiCandidate()))
      .toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
  });

  it('文言差・sourceUrl差・schema不正の自己申告候補を拒否する', async () => {
    const source = await shumiSourceRecord();
    expect(() => extractVerifiedShumiNotice(source, shumiCandidate({ text: '別の文言です' })))
      .toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
    expect(() => extractVerifiedShumiNotice(source, shumiCandidate({
      sourceUrl: 'https://www.aozora.gr.jp/cards/000148/card799.html',
    }))).toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
    expect(() => extractVerifiedShumiNotice(
      source,
      { ...shumiCandidate(), placements: ['work', 'author', 'credits'] } as unknown as F005ShumiNoticeCandidate,
    )).toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
    expect(() => extractVerifiedShumiNotice(
      source,
      { ...shumiCandidate(), extra: true } as unknown as F005ShumiNoticeCandidate,
    )).toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
  });

  it('mint済みではないSourceRecordV2や作品違いを拒否する', async () => {
    const source = await shumiSourceRecord();
    expect(() => extractVerifiedShumiNotice(
      structuredClone(source) as never,
      shumiCandidate(),
    )).toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
    const responses = standardResponses();
    const otherSnapshot = await collectF005SourceSnapshot(
      transportFixture(responses),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(),
    );
    const otherSource = parseF005SourceRecord(otherSnapshot.works[0]!, '000799');
    expect(() => extractVerifiedShumiNotice(otherSource, shumiCandidate()))
      .toThrowError(expect.objectContaining({ code: 'F005_NOTICE_INVALID' }));
  });
});

async function persistPredeploySnapshot(
  root: string,
  snapshot: Awaited<ReturnType<typeof collectF005SourceSnapshot>>,
  run: string,
): Promise<Record<string, unknown>> {
  const dataPath = (leaf: string): string =>
    `data/batches/F005/source-snapshots/selection/predeploy-${run}-${leaf.replace(/\//gu, '-')}`;
  const entries = [
    { path: dataPath('bibliography.zip'), artifact: snapshot.bibliographyArchive },
    { path: dataPath('bibliography.csv'), artifact: snapshot.bibliographyCsv },
    { path: dataPath('author-page.html'), artifact: snapshot.authorPage },
    ...snapshot.policies.map((policy) => ({
      path: dataPath(`policies/${policy.policyId}.raw`),
      artifact: policy.artifact,
    })),
    ...snapshot.works.flatMap((work) => [
      { path: dataPath(`works/${work.workId}/card.html`), artifact: work.card },
      { path: dataPath(`works/${work.workId}/source.raw`), artifact: work.xhtml },
    ]),
  ];
  for (const entry of entries) {
    const target = join(root, ...entry.path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, entry.artifact.bytes);
  }
  const metadata = (
    artifact: (typeof entries)[number]['artifact'],
    path: string,
  ): Record<string, unknown> => ({
    storage: 'sealed',
    path,
    sourceUrl: artifact.sourceUrl,
    fetchedAt: artifact.fetchedAt,
    mediaType: artifact.mediaType,
    charset: artifact.charset,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    transport: artifact.transport,
  });
  const artifact = {
    schemaVersion: '2.0.0',
    kind: 'f005-source-predeploy-snapshot',
    batchId: 'F005',
    authorId: snapshot.authorId,
    phase: snapshot.phase,
    observedAt: snapshot.observedAt,
    rights: evaluateF005RightsAndUsage(snapshot, USAGE),
    bibliographyArchive: metadata(snapshot.bibliographyArchive, entries[0]!.path),
    bibliographyCsv: metadata(snapshot.bibliographyCsv, entries[1]!.path),
    authorPage: metadata(snapshot.authorPage, entries[2]!.path),
    policies: snapshot.policies.map((policy) => {
      const entry = entries.find((item) => item.artifact === policy.artifact)!;
      return {
        policyId: policy.policyId,
        versionOrLabel: policy.versionOrLabel,
        artifact: metadata(policy.artifact, entry.path),
        decision: policy.decision,
      };
    }),
    works: snapshot.works.map((work) => {
      const card = entries.find((item) => item.artifact === work.card)!;
      const xhtml = entries.find((item) => item.artifact === work.xhtml)!;
      return {
        workId: work.workId,
        title: work.title,
        bibliography: work.bibliography,
        card: metadata(work.card, card.path),
        xhtml: metadata(work.xhtml, xhtml.path),
      };
    }),
  };
  const snapshotPath = join(root, 'content', 'batches', 'F005', 'source-snapshots', `predeploy-${run}.json`);
  await mkdir(join(snapshotPath, '..'), { recursive: true });
  await writeFile(snapshotPath, canonicalJson(artifact));
  return artifact;
}

describe('UT-F005-006 predeploy snapshotの検証済み再読込 [DES-F005-003][FUN-F005-006]', () => {
  const RUN = '2026-07-29T00-01-00-000Z';
  const SNAPSHOT_RELATIVE_PATH = `content/batches/F005/source-snapshots/predeploy-${RUN}.json`;

  async function seed(root: string) {
    const selection = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'selection',
      () => new Date('2026-07-29T00:00:00.000Z'),
      collectionOptions(root),
    );
    await persistSelectionSnapshot(root, selection);
    const rehydratedSelection = await rehydrateF005SelectionSnapshot(root, CONTEXT);
    const predeploy = await collectF005SourceSnapshot(
      transportFixture(),
      CONTEXT,
      'predeploy',
      () => new Date('2026-07-29T00:01:00.000Z'),
      collectionOptions(root, POLICY_BODIES, rehydratedSelection),
    );
    return predeploy;
  }

  it.runIf(process.platform === 'win32')('永続化predeployを実物とApproved Contextへ再結合し、selectionと対称なexact値を返す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-predeploy-rehydrate-'));
    temporaryDirectories.push(root);
    const predeploy = await seed(root);
    await persistPredeploySnapshot(root, predeploy, RUN);
    const rehydrated = await rehydrateF005PredeploySnapshot(root, CONTEXT, SNAPSHOT_RELATIVE_PATH);
    expect(rehydrated).not.toBe(predeploy);
    expect(rehydrated).toEqual(predeploy);
    expect(rehydrated.phase).toBe('predeploy');
    expect(evaluateF005RightsAndUsage(rehydrated, USAGE).decision).toBe('allow');
  }, 30_000);

  it.runIf(process.platform === 'win32')('固定形式外のpath・context不一致を拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-predeploy-path-'));
    temporaryDirectories.push(root);
    const predeploy = await seed(root);
    await persistPredeploySnapshot(root, predeploy, RUN);
    await expect(rehydrateF005PredeploySnapshot(
      root, CONTEXT, 'content/batches/F005/source-snapshots/selection.json',
    )).rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    await expect(rehydrateF005PredeploySnapshot(
      root, CONTEXT, `content/batches/F005/source-snapshots/predeploy-${RUN}/../escape.json`,
    )).rejects.toMatchObject({ code: 'F005_PATH_UNSAFE' });
    await expect(rehydrateF005PredeploySnapshot(root, structuredClone(CONTEXT), SNAPSHOT_RELATIVE_PATH))
      .rejects.toMatchObject({ code: 'F005_CONTEXT_INVALID' });
  });

  it.runIf(process.platform === 'win32')('実体SHA・kind・phase改変を拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-f005-predeploy-tamper-'));
    temporaryDirectories.push(root);
    const predeploy = await seed(root);
    const artifact = await persistPredeploySnapshot(root, predeploy, RUN);
    const snapshotPath = join(root, ...SNAPSHOT_RELATIVE_PATH.split('/'));

    const wrongKind = { ...artifact, kind: 'f005-source-selection-snapshot' };
    await writeFile(snapshotPath, canonicalJson(wrongKind));
    await expect(rehydrateF005PredeploySnapshot(root, CONTEXT, SNAPSHOT_RELATIVE_PATH))
      .rejects.toMatchObject({ code: 'F005_SOURCE_DRIFT' });

    const tamperedWork = structuredClone(artifact) as {
      works: Array<{ card: { sha256: string } }>;
    };
    tamperedWork.works[2]!.card.sha256 = '0'.repeat(64);
    await writeFile(snapshotPath, canonicalJson(tamperedWork));
    await expect(rehydrateF005PredeploySnapshot(root, CONTEXT, SNAPSHOT_RELATIVE_PATH))
      .rejects.toThrow();

    await writeFile(snapshotPath, canonicalJson(artifact));
    await expect(rehydrateF005PredeploySnapshot(root, CONTEXT, SNAPSHOT_RELATIVE_PATH))
      .resolves.toMatchObject({ phase: 'predeploy' });
  }, 30_000);
});
