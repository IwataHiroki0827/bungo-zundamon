import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { F005ApprovedBatchContext } from './f005-context.ts';
import {
  F005_CAPACITY_LIMITS,
  F005_RANKING_POLICY_VERSION,
  F005_V040_PINS,
  advanceAuthorExpansionPlan,
  capacityWarnings,
  computeAuthorPopularityRanking,
  createF005CapacityPlan,
  createInitialAuthorExpansionPlan,
  discoverF005CapacityInventory,
  evaluateF005CapacityThresholds,
  forecastF005Capacity,
  isVerifiedNewAuthor,
  loadV040Baseline,
  verifyNatsumeIdentity,
  verifyV040Projection,
  type AuthorRankingEvidence,
  type F005CapacityInventory,
  type F005CapacityPlan,
  type V040Baseline,
} from './f005-foundation.ts';

const execFileAsync = promisify(execFile);
const mintedContexts = vi.hoisted(() => new WeakSet<object>());
vi.mock('./f005-context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./f005-context.ts')>();
  return {
    ...actual,
    isMintedF005ApprovedBatchContext: (value: unknown) =>
      typeof value === 'object' && value !== null && mintedContexts.has(value),
  };
});

const HASH = (character: string): string => character.repeat(64);
const workspace = resolve('.');
const context = {
  __brand: 'ApprovedBatchContext',
  candidate: {
    batchId: 'F005',
    author: {
      authorId: '000148',
      identitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f',
      name: 'なつめそうせき',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
    },
  },
  definition: { feature: 'F005', batchId: 'F005' },
  policy: { requirementApprovalSnapshot: '18e3fa50edfe5214480a65ed2e840fe49a663ee2' },
  implementationControl: { __brand: 'VerifiedImplementationRegistryControl' },
} as unknown as F005ApprovedBatchContext;
mintedContexts.add(context);

let baseline: V040Baseline;

beforeAll(async () => {
  baseline = await loadV040Baseline(workspace, context);
}, 60_000);

describe('UT-F005-002/003/004 v0.4.0 foundation', () => {
  /** @des DES-F005-001 @fun FUN-F005-002 @test UT-F005-002 */
  it('release payloadとpostrelease controlを別Git objectから固定する', () => {
    expect(baseline).toMatchObject({
      __brand: 'V040Baseline',
      descriptorSha256: '1d4648fd83669ce3d6f9332c1b3347af788df6e8a2602c4221ac708609116f62',
      pins: F005_V040_PINS,
      controlManifest: { batchId: 'F004', status: 'published' },
    });
    expect(baseline.pins.releaseCommit).not.toBe(baseline.pins.controlCommit);
    expect(baseline.publicFiles).toHaveLength(694);
    expect(baseline.catalog).toMatchObject({
      authors: expect.arrayContaining([]),
      works: expect.arrayContaining([]),
      audioAssets: expect.arrayContaining([]),
    });
    expect(baseline.catalog.authors).toHaveLength(3);
    expect(baseline.catalog.works).toHaveLength(12);
    expect(baseline.catalog.audioAssets).toHaveLength(662);
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  /** @des DES-F005-001 @fun FUN-F005-002 @test UT-F005-002 */
  it('release/control逆転とpublic件数差をF005_BASELINE_MISMATCHで拒否する', async () => {
    const reverse = {
      resolveCommit: async (_root: string, ref: string) =>
        ref === F005_V040_PINS.releaseCommit ? F005_V040_PINS.controlCommit : F005_V040_PINS.releaseCommit,
      listPublicTree: async () => [],
      readObject: async () => new Uint8Array(),
    };
    await expect(loadV040Baseline(workspace, context, { git: reverse }))
      .rejects.toMatchObject({ code: 'F005_BASELINE_MISMATCH' });
  });

  /** @des DES-F005-001 @fun FUN-F005-003 @test UT-F005-003 */
  it('既存3作者・12作品とcontent/mediaをexact維持する', () => {
    const report = verifyV040Projection(context, baseline, {
      catalog: structuredClone(baseline.catalog),
      files: baseline.publicFiles.map((file) => ({ ...file })),
    });
    expect(report).toMatchObject({ result: 'pass', mismatches: [] });
  });

  /** @des DES-F005-001 @fun FUN-F005-003 @test UT-F005-003 */
  it('既存media 1 byte差・未追跡追加・Catalog projection差を列挙してblockedにする', () => {
    const media = baseline.publicFiles.find((file) => file.path.startsWith('audio/'));
    expect(media).toBeDefined();
    const files = baseline.publicFiles.map((file) => file.path === media?.path
      ? { ...file, bytes: file.bytes + 1 }
      : { ...file });
    files.push({
      mode: '100644',
      oid: 'a'.repeat(40),
      bytes: 1,
      sha256: HASH('a'),
      path: 'untracked.txt',
    });
    const catalog = structuredClone(baseline.catalog);
    catalog.authors[0] = { ...catalog.authors[0]!, name: '改変作者' };

    const report = verifyV040Projection(context, baseline, { catalog, files });
    expect(report.result).toBe('blocked');
    expect(report.mismatches).toEqual(expect.arrayContaining([
      `FILE_MISMATCH:${media?.path}`,
      'UNTRACKED_ADDITION:untracked.txt',
      'CATALOG_PROJECTION_MISMATCH',
    ]));
  });

  /** @des DES-F005-001 @fun FUN-F005-003 @test UT-F005-003 */
  it('aggregateを含む既存publicの改変とbaseline reference欠落を拒否する', () => {
    const catalogFile = baseline.publicFiles.find((file) => file.path === 'content/catalog.json');
    const referenced = baseline.catalog.audioAssets[0]!.path;
    const files = baseline.publicFiles
      .filter((file) => file.path !== referenced)
      .map((file) => file.path === catalogFile?.path
        ? { ...file, sha256: HASH('f') }
        : { ...file });
    const report = verifyV040Projection(context, baseline, {
      catalog: structuredClone(baseline.catalog),
      files,
    });
    expect(report.result).toBe('blocked');
    expect(report.mismatches).toEqual(expect.arrayContaining([
      'FILE_MISMATCH:content/catalog.json',
      `PATH_MISSING:${referenced}`,
      `REFERENCE_MISMATCH:${referenced}`,
    ]));
  });

  /** @des DES-F005-001 @fun FUN-F005-003 @test UT-F005-003 */
  it('旧publicを変えないF005許可pathの追加だけを認める', () => {
    const report = verifyV040Projection(context, baseline, {
      catalog: structuredClone(baseline.catalog),
      files: [
        ...baseline.publicFiles.map((file) => ({ ...file })),
        {
          mode: '100644',
          oid: 'f'.repeat(40),
          bytes: 1,
          sha256: HASH('f'),
          path: 'audio/F005/new.wav',
        },
      ],
    });
    expect(report).toMatchObject({ result: 'pass', mismatches: [] });
  });

  /** @des DES-F005-002 @fun FUN-F005-004 @test UT-F005-004 */
  it('baseline join 0件の夏目漱石exact identityだけをmintする', () => {
    const author = verifyNatsumeIdentity(context, baseline.catalog);
    expect(author).toEqual({
      __brand: 'VerifiedNewAuthor',
      authorId: '000148',
      name: 'なつめそうせき',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
      identitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f',
    });
    expect(isVerifiedNewAuthor(author)).toBe(true);
    expect(isVerifiedNewAuthor(structuredClone(author))).toBe(false);
  });

  /** @des DES-F005-002 @fun FUN-F005-004 @test UT-F005-004 */
  it.each(['authorId', 'name', 'originalName', 'slug'] as const)(
    '既存authorの%s衝突をF005_AUTHOR_IDENTITY_CONFLICTで拒否する',
    (field) => {
      const catalog = structuredClone(baseline.catalog);
      catalog.authors[0] = { ...catalog.authors[0]!, [field]: context.candidate.author[field] };
      expect(() => verifyNatsumeIdentity(context, catalog))
        .toThrow(expect.objectContaining({ code: 'F005_AUTHOR_IDENTITY_CONFLICT' }));
    },
  );

  /** @des DES-F005-001 @des DES-F005-002 @fun FUN-F005-002 @fun FUN-F005-004 @test UT-F005-001 */
  it('構造だけ複製したcaller contextをproduction brandとして受理しない', () => {
    expect(() => verifyNatsumeIdentity(
      structuredClone(context),
      baseline.catalog,
    )).toThrow(expect.objectContaining({ code: 'F005_APPROVAL_CONTEXT_INVALID' }));
  });
});

function thresholdInput(overrides: Partial<Parameters<typeof evaluateF005CapacityThresholds>[0]> = {}) {
  return {
    audioBytes: 0,
    artifactBytes: 0,
    repositoryBytes: 0,
    objectBytes: 0,
    workspacePeakBytes: 0,
    initialFreeBytes: F005_CAPACITY_LIMITS.minimumFreeBytes,
    ...overrides,
  };
}

describe('UT-F005-018 CapacityForecastV3', () => {
  let capacityWorkspace: string;
  let inventory: F005CapacityInventory;
  let plan: F005CapacityPlan;

  async function writeFixture(path: string, contents: string): Promise<void> {
    const target = join(capacityWorkspace, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }

  beforeEach(async () => {
    capacityWorkspace = await mkdtemp(join(tmpdir(), 'f005-capacity-'));
    await execFileAsync('git', ['init', capacityWorkspace], { windowsHide: true });
    const fixtures = [
      ['public/audio/F005/declared.wav', 'audio-a'],
      ['public/audio/F005/hidden.wav', 'audio-b'],
      ['dist/index.html', 'artifact-a'],
      ['dist/hidden.bin', 'artifact-b'],
      ['.cache/f005/stage/declared.tmp', 'peak-a'],
      ['.cache/f005/stage/hidden.tmp', 'peak-b'],
      ['src/tracked-a.ts', 'repository-a'],
      ['src/tracked-b.ts', 'repository-b'],
      ['objects/largest.bin', 'x'.repeat(128)],
    ] as const;
    for (const [path, contents] of fixtures) {
      await writeFixture(path, contents);
    }
    await execFileAsync(
      'git',
      ['-C', capacityWorkspace, 'add', 'src/tracked-a.ts', 'src/tracked-b.ts'],
      { windowsHide: true },
    );
    await execFileAsync(
      'git',
      ['-C', capacityWorkspace, 'hash-object', '-w', 'objects/largest.bin'],
      { windowsHide: true },
    );
    inventory = await discoverF005CapacityInventory(capacityWorkspace, context, baseline);
    plan = createF005CapacityPlan(context, baseline, inventory, {
      planSha256: HASH('9'),
      entries: [{
        audioId: HASH('8'),
        speechSha256: HASH('7'),
        estimatedBytes: 1_000,
      }],
    });
  });

  afterEach(async () => {
    await rm(capacityWorkspace, { recursive: true, force: true });
  });

  const candidateHashes = () => ({
    candidateSha256: plan.candidateSha256,
    claims: plan.expectedClaims.map((claim) => ({ ...claim })),
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it.each([
    ['audio', 'audioBytes', F005_CAPACITY_LIMITS.audioStopBytes],
    ['artifact', 'artifactBytes', F005_CAPACITY_LIMITS.artifactStopBytes],
    ['repository', 'repositoryBytes', F005_CAPACITY_LIMITS.repositoryStopBytes],
    ['object', 'objectBytes', F005_CAPACITY_LIMITS.objectStopBytes],
  ] as const)('%s停止境界は同値を許可し+1 byteを停止する', (_name, key, limit) => {
    expect(evaluateF005CapacityThresholds(thresholdInput({ [key]: limit })).blocked).toBe(false);
    expect(evaluateF005CapacityThresholds(thresholdInput({ [key]: limit + 1 })).blocked).toBe(true);
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('Pages/repository警告は直前normal・同値warning、停止境界は包含とする', () => {
    const before = evaluateF005CapacityThresholds(thresholdInput({
      artifactBytes: F005_CAPACITY_LIMITS.artifactWarningBytes - 1,
      repositoryBytes: F005_CAPACITY_LIMITS.repositoryWarningBytes - 1,
    }));
    expect(before.warnings).toEqual([]);
    const exact = evaluateF005CapacityThresholds(thresholdInput({
      artifactBytes: F005_CAPACITY_LIMITS.artifactWarningBytes,
      repositoryBytes: F005_CAPACITY_LIMITS.repositoryWarningBytes,
    }));
    expect(exact.warnings).toEqual([
      'F005_CAPACITY_ARTIFACT_WARNING',
      'F005_CAPACITY_REPOSITORY_WARNING',
    ]);
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('workspace peak後5 GiB同値を許可し1 byte不足で停止する', () => {
    const peak = 1_000;
    const pass = evaluateF005CapacityThresholds(thresholdInput({
      initialFreeBytes: F005_CAPACITY_LIMITS.minimumFreeBytes + peak,
      workspacePeakBytes: peak,
    }));
    expect(pass.freeAfterPeakBytes).toBe(F005_CAPACITY_LIMITS.minimumFreeBytes);
    expect(evaluateF005CapacityThresholds(thresholdInput({
      initialFreeBytes: F005_CAPACITY_LIMITS.minimumFreeBytes + peak,
      workspacePeakBytes: peak + 1,
    }))).toMatchObject({ blocked: true, freeAfterPeakBytes: F005_CAPACITY_LIMITS.minimumFreeBytes - 1 });
    expect(evaluateF005CapacityThresholds(thresholdInput({
      initialFreeBytes: F005_CAPACITY_LIMITS.minimumFreeBytes + peak - 1,
      workspacePeakBytes: peak,
    }))).toMatchObject({ blocked: true, freeAfterPeakBytes: F005_CAPACITY_LIMITS.minimumFreeBytes - 1 });
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it.each([-1, 0.5, Number.NaN])('負値・小数・NaNを拒否する: %s', (bytes) => {
    expect(() => evaluateF005CapacityThresholds(thresholdInput({ audioBytes: bytes })))
      .toThrow(expect.objectContaining({ code: 'F005_CAPACITY_INTEGER_INVALID' }));
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('固定root・Git index・全object databaseを完全列挙して6 bucketを返す', async () => {
    const forecast = await forecastF005Capacity(
      capacityWorkspace,
      plan,
      baseline,
      candidateHashes(),
    );
    expect(forecast.buckets.map((bucket) => bucket.kind)).toEqual([
      'audio', 'artifact', 'repository', 'object', 'workspace-peak', 'free-after-peak',
    ]);
    expect(forecast.buckets.find((bucket) => bucket.kind === 'artifact')?.entries).toHaveLength(2);
    expect(forecast.buckets.find((bucket) => bucket.kind === 'repository')?.entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'git-index', path: 'src/tracked-a.ts' }),
        expect.objectContaining({ kind: 'git-index', path: 'src/tracked-b.ts' }),
      ]));
    expect(forecast.buckets.find((bucket) => bucket.kind === 'object')?.totalBytes).toBe(128);
    expect(forecast.buckets.find((bucket) => bucket.kind === 'audio')?.entries).toHaveLength(3);
    expect(forecast.buckets.find((bucket) => bucket.kind === 'audio')?.entries)
      .toContainEqual(expect.objectContaining({
        kind: 'planned-audio',
        bytes: 1_000,
        planSha256: HASH('9'),
      }));
    expect(forecast.buckets.find((bucket) => bucket.kind === 'workspace-peak')?.entries).toHaveLength(3);
    expect(capacityWarnings(forecast)).toEqual([]);
    expect(Object.keys(forecast).sort()).toEqual([
      'buckets', 'candidateSha256', 'freeAfterPeakBytes', 'initialFreeBytes',
      'measuredAt', 'predictedPeakBytes', 'schemaVersion',
    ]);
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('初回作品のF005 audio rootが未作成でもplanned audioだけで予測する', async () => {
    await Promise.all([
      rm(join(capacityWorkspace, 'public', 'audio', 'F005'), { recursive: true }),
      rm(join(capacityWorkspace, '.cache', 'f005'), { recursive: true }),
    ]);
    inventory = await discoverF005CapacityInventory(capacityWorkspace, context, baseline);
    plan = createF005CapacityPlan(context, baseline, inventory, {
      planSha256: HASH('9'),
      entries: [{
        audioId: HASH('8'),
        speechSha256: HASH('7'),
        estimatedBytes: 1_000,
      }],
    });
    const forecast = await forecastF005Capacity(
      capacityWorkspace,
      plan,
      baseline,
      candidateHashes(),
    );
    expect(forecast.buckets.find((bucket) => bucket.kind === 'audio')).toMatchObject({
      totalBytes: 1_000,
      entries: [expect.objectContaining({ kind: 'planned-audio', bytes: 1_000 })],
    });
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('callerが各bucketの小file 1件だけを申告して他fileを隠す操作を拒否する', async () => {
    const onePerBucket = ['audio', 'artifact', 'repository', 'object', 'workspace-peak']
      .map((bucket) => plan.expectedClaims.find((claim) => claim.bucket === bucket)!)
      .map((claim) => ({ ...claim }));
    await expect(forecastF005Capacity(capacityWorkspace, plan, baseline, {
      candidateSha256: plan.candidateSha256,
      claims: onePerBucket,
    })).rejects.toMatchObject({ code: 'F005_CAPACITY_PLAN_MISMATCH' });
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('任意claimや構造clone inventoryからproduction planをmintできない', () => {
    expect(() => createF005CapacityPlan(context, baseline, {
      ...inventory,
      entries: inventory.entries.slice(0, 5),
    }, {
      planSha256: HASH('9'),
      entries: [],
    })).toThrow(expect.objectContaining({ code: 'F005_CAPACITY_PLAN_MISMATCH' }));
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('candidate claimsの欠落・追加・重複・別hash・別candidateを拒否する', async () => {
    const claims = candidateHashes().claims;
    const variants = [
      { candidateSha256: plan.candidateSha256, claims: claims.slice(1) },
      { candidateSha256: plan.candidateSha256, claims: [...claims, { ...claims[0]! }] },
      {
        candidateSha256: plan.candidateSha256,
        claims: claims.map((claim, index) => index === 0 ? { ...claim, sha256: HASH('f') } : claim),
      },
      { candidateSha256: HASH('d'), claims },
    ];
    for (const candidateHashes of variants) {
      await expect(forecastF005Capacity(capacityWorkspace, plan, baseline, candidateHashes))
        .rejects.toMatchObject({ code: 'F005_CAPACITY_PLAN_MISMATCH' });
    }
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it.each([
    ['未追跡WAV', async () => writeFixture('public/audio/F005/late.wav', 'late-audio')],
    ['artifact追加', async () => writeFixture('dist/late.bin', 'late-artifact')],
    ['workspace staging追加', async () => writeFixture('.cache/f005/stage/late.tmp', 'late-peak')],
    ['path rename', async () => rename(
      join(capacityWorkspace, 'dist', 'hidden.bin'),
      join(capacityWorkspace, 'dist', 'renamed.bin'),
    )],
  ])('%sをplan後の再列挙で拒否する', async (_label, mutate) => {
    await mutate();
    await expect(forecastF005Capacity(capacityWorkspace, plan, baseline, candidateHashes()))
      .rejects.toMatchObject({ code: 'F005_CAPACITY_PLAN_MISMATCH' });
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('plan後に追加されたtracked repository fileを拒否する', async () => {
    await writeFixture('src/tracked-late.ts', 'late-repository');
    await execFileAsync('git', ['-C', capacityWorkspace, 'add', 'src/tracked-late.ts'], { windowsHide: true });
    await expect(forecastF005Capacity(capacityWorkspace, plan, baseline, candidateHashes()))
      .rejects.toMatchObject({ code: 'F005_CAPACITY_PLAN_MISMATCH' });
  });

  /** @des DES-F005-006 @fun FUN-F005-018 @test UT-F005-018 */
  it('plan後にobject databaseへ追加された最大Git blobを拒否する', async () => {
    await writeFixture('objects/later-largest.bin', 'y'.repeat(256));
    await execFileAsync(
      'git',
      ['-C', capacityWorkspace, 'hash-object', '-w', 'objects/later-largest.bin'],
      { windowsHide: true },
    );
    await expect(forecastF005Capacity(capacityWorkspace, plan, baseline, candidateHashes()))
      .rejects.toMatchObject({ code: 'F005_CAPACITY_PLAN_MISMATCH' });
  });
});

function rankingFixture(): { xhtml: string; csv: string } {
  const people = [
    ['000879', '芥川龍之介'],
    ['000148', '夏目漱石'],
    ...Array.from({ length: 10 }, (_, index) => [
      String(100 + index).padStart(6, '0'),
      `作者${index + 1}`,
    ]),
  ];
  const rows = Array.from({ length: 500 }, (_, index) => {
    const rank = index + 1;
    const person = index < people.length ? people[index]! : people[0]!;
    const views = index === 0 ? 20_000 : index === 1 ? 10_000 : index < people.length ? 1_000 - index : 1;
    return `<tr data-rank="${rank}" data-person-id="${person[0]}" data-author="${person[1]}" data-views="${views}"><td>${rank}</td><td>${person[1]}</td><td>${views}</td></tr>`;
  });
  const csv = [
    '人物ID,氏名,役割,公開状態',
    ...people.map(([id, name]) => `${id},${name},著者,公開中`),
  ].join('\n');
  return { xhtml: `<table>${rows.join('')}</table>`, csv };
}

describe('UT-F005-040/041 作者順位と追加10作者plan', () => {
  let ranking: AuthorRankingEvidence;

  beforeAll(() => {
    const fixture = rankingFixture();
    ranking = computeAuthorPopularityRanking(
      { bytes: fixture.xhtml },
      { bytes: fixture.csv },
      F005_RANKING_POLICY_VERSION,
    );
  });

  /** @des DES-F005-013 @fun FUN-F005-040 @test UT-F005-040 */
  it('500行を人物別合計降順・同点人物ID昇順へ固定し同入力digestを再現する', () => {
    const fixture = rankingFixture();
    const again = computeAuthorPopularityRanking(
      { bytes: fixture.xhtml, expectedSha256: ranking.rankingXhtmlSha256 },
      { bytes: fixture.csv, expectedSha256: ranking.extendedCsvSha256 },
      F005_RANKING_POLICY_VERSION,
    );
    expect(again.entries[0]).toMatchObject({ authorId: '000879', name: '芥川龍之介' });
    expect(again.entries.find((entry) => entry.authorId === '000148')).toMatchObject({
      name: '夏目漱石',
      identitySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(again.adoptedRows).toBe(500);
    expect(again.resultDigest).toBe(ranking.resultDigest);
    expect(canonicalJson(again.entries)).toBe(canonicalJson(ranking.entries));
  });

  /** @des DES-F005-013 @fun FUN-F005-040 @test UT-F005-040 */
  it('SHA差・rank重複・未知人物・式version差をF005_RANKING_INPUT_INVALIDで拒否する', () => {
    const fixture = rankingFixture();
    expect(() => computeAuthorPopularityRanking(
      { bytes: fixture.xhtml, expectedSha256: HASH('0') },
      { bytes: fixture.csv },
      F005_RANKING_POLICY_VERSION,
    )).toThrow(expect.objectContaining({ code: 'F005_RANKING_INPUT_INVALID' }));
    expect(() => computeAuthorPopularityRanking(
      { bytes: fixture.xhtml.replace('data-rank="2"', 'data-rank="1"').replace('<td>2</td>', '<td>1</td>') },
      { bytes: fixture.csv },
      F005_RANKING_POLICY_VERSION,
    )).toThrow(expect.objectContaining({ code: 'F005_RANKING_INPUT_INVALID' }));
    expect(() => computeAuthorPopularityRanking(
      { bytes: fixture.xhtml.replace('data-person-id="000148"', 'data-person-id="999999"') },
      { bytes: fixture.csv },
      F005_RANKING_POLICY_VERSION,
    )).toThrow(expect.objectContaining({ code: 'F005_RANKING_INPUT_INVALID' }));
    expect(() => computeAuthorPopularityRanking(
      { bytes: fixture.xhtml },
      { bytes: fixture.csv },
      'different-policy',
    )).toThrow(expect.objectContaining({ code: 'F005_RANKING_INPUT_INVALID' }));
  });

  /** @des DES-F005-013 @fun FUN-F005-040 @test UT-F005-040 */
  it('拡充CSVの完全重複行をF005_RANKING_INPUT_INVALIDで拒否する', () => {
    const fixture = rankingFixture();
    const duplicate = `${fixture.csv}\n${fixture.csv.split('\n')[1]}`;
    expect(() => computeAuthorPopularityRanking(
      { bytes: fixture.xhtml },
      { bytes: duplicate },
      F005_RANKING_POLICY_VERSION,
    )).toThrow(expect.objectContaining({ code: 'F005_RANKING_INPUT_INVALID' }));
  });

  /** @des DES-F005-013 @fun FUN-F005-041 @test UT-F005-041 */
  it('F005を追加1/10へ進め、ineligibleを理由付きで繰上げる', () => {
    const initial = createInitialAuthorExpansionPlan(ranking);
    const next = advanceAuthorExpansionPlan(initial, ranking, {
      authorId: '000148',
      identitySha256: initial.nextCandidate!.identitySha256,
    }, [
      { authorId: '000100', decision: 'exclude', reason: 'rights' },
      { authorId: '000101', decision: 'allow' },
    ]);
    expect(next).toMatchObject({
      baselineAuthors: 3,
      targetAdditionalAuthors: 10,
      finalAuthorLimit: 13,
      addedCount: 1,
      remainingCount: 9,
      excluded: [{ authorId: '000100', reason: 'rights' }],
      nextCandidate: { authorId: '000101' },
    });
  });

  /** @des DES-F005-013 @fun FUN-F005-041 @test UT-F005-041 */
  it('10作者でnextを閉じ、11件目・ranking drift・identity重複を拒否する', () => {
    let plan = createInitialAuthorExpansionPlan(ranking);
    for (let index = 0; index < 10; index += 1) {
      const current = plan.nextCandidate;
      expect(current).not.toBeNull();
      plan = advanceAuthorExpansionPlan(plan, ranking, {
        authorId: current!.authorId,
        identitySha256: current!.identitySha256,
      }, ranking.entries
        .filter((entry) => entry.authorId !== current!.authorId)
        .map((entry) => ({ authorId: entry.authorId, decision: 'allow' as const })));
    }
    expect(plan).toMatchObject({ addedCount: 10, remainingCount: 0, nextCandidate: null });
    expect(() => advanceAuthorExpansionPlan(plan, ranking, {
      authorId: '999999',
      identitySha256: HASH('f'),
    }, [])).toThrow(expect.objectContaining({ code: 'F005_AUTHOR_PLAN_LIMIT' }));

    const initial = createInitialAuthorExpansionPlan(ranking);
    expect(() => advanceAuthorExpansionPlan(initial, { ...ranking, resultDigest: HASH('f') }, {
      authorId: '000148',
      identitySha256: initial.nextCandidate!.identitySha256,
    }, [])).toThrow(expect.objectContaining({ code: 'F005_AUTHOR_PLAN_LIMIT' }));

    expect(() => advanceAuthorExpansionPlan(initial, ranking, {
      authorId: '000148',
      identitySha256: HASH('f'),
    }, [])).toThrow(expect.objectContaining({ code: 'F005_AUTHOR_PLAN_LIMIT' }));
  });
});
