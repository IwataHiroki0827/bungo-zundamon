import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCatalog } from '../src/ui/catalog-loader.ts';
import {
  HARD_FILE_BYTES,
  HARD_TOTAL_BYTES,
  PAGES_BASE,
  WARNING_TOTAL_BYTES,
  runF002StaticSecurityChecks,
  runReleaseChecks,
  validateReleaseVisibilityEvidence,
  verifyAssetBudget,
  verifyBuiltReferences,
  verifyCsp,
  verifyWorkflowPermissions,
} from './release-checks.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories = [];
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// IT-F001-016: workflow最小権限、承認SHA拘束、deploy event matrixを追跡する。
describe('FUN-F001-032 verifyWorkflowPermissions [UT-F001-032]', () => {
  it('実workflowの最小権限・SHA固定・承認switchを受理する', async () => {
    const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8');
    expect(verifyWorkflowPermissions(workflow, { expectedNodeVersion: '24.11.0', nvmrcVersion: '24.11.0' })).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it.each([
    ['tag参照', (value) => value.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v7'), 'ACTION_NOT_PINNED:actions/checkout'],
    ['npm install', (value) => value.replace('run: npm ci', 'run: npm install'), 'NPM_CI_MISSING'],
    ['過剰権限', (value) => value.replace('  contents: read\n\nconcurrency:', '  contents: write\n\nconcurrency:'), 'TOP_LEVEL_PERMISSIONS_NOT_READ_ONLY'],
    ['非main deploy', (value) => value.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/dev'"), 'DEPLOY_CONDITION_INVALID'],
    ['承認switchなし', (value) => value.replace(" && vars.PAGES_DEPLOY_ENABLED == 'true'", ''), 'DEPLOY_CONDITION_INVALID'],
    ['承認SHA拘束なし', (value) => value.replace(' && vars.PAGES_DEPLOY_COMMIT == github.sha', ''), 'DEPLOY_CONDITION_INVALID'],
    ['承認SHA固定値', (value) => value.replace('vars.PAGES_DEPLOY_COMMIT == github.sha', `vars.PAGES_DEPLOY_COMMIT == '${SHA}'`), 'DEPLOY_CONDITION_INVALID'],
    ['取得step', (value) => value.replace('run: npm run verify', 'run: npm run content:update'), 'NETWORK_UPDATE_STEP_FORBIDDEN'],
    ['feature push除外', (value) => value.replace("      - '**'", '      - main'), 'WORKFLOW_EVENT_MATRIX_INVALID'],
    ['verifyをコメント化', (value) => value.replace('run: npm run verify', '# run: npm run verify\n        run: npm run build'), 'VERIFY_STEP_MISSING'],
    ['alwaysによる検査迂回', (value) => value.replace('      - name: Verify without content retrieval', '      - name: Verify without content retrieval\n        if: always()'), 'WORKFLOW_CONTROL_BYPASS'],
    ['continue-on-error', (value) => value.replace('        run: npm run verify', '        continue-on-error: true\n        run: npm run verify'), 'WORKFLOW_CONTROL_BYPASS'],
    ['重複key', (value) => value.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\n  contents: read'), 'WORKFLOW_YAML_INVALID'],
    ['artifact upload欠落', (value) => value.replace(/ {6}- name: Upload Pages artifact[\s\S]*? {10}path: dist\n\n {2}deploy:/, '\n  deploy:'), 'BUILD_STEPS_INVALID'],
  ])('%sを拒否する', async (_name, mutate, code) => {
    const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8');
    expect(verifyWorkflowPermissions(mutate(workflow)).errors).toContain(code);
  });

  it.each([
    ['main成功・enable=false', { eventName: 'push', ref: 'refs/heads/main', buildSucceeded: true, enabled: false, deployCommit: SHA, sha: SHA }, false],
    ['main失敗・enable=true', { eventName: 'push', ref: 'refs/heads/main', buildSucceeded: false, enabled: true, deployCommit: SHA, sha: SHA }, false],
    ['feature成功・enable=true', { eventName: 'push', ref: 'refs/heads/feature/F001', buildSucceeded: true, enabled: true, deployCommit: SHA, sha: SHA }, false],
    ['main成功・承認SHA不一致', { eventName: 'push', ref: 'refs/heads/main', buildSucceeded: true, enabled: true, deployCommit: 'c'.repeat(40), sha: SHA }, false],
    ['ゲート④後main成功・承認SHA一致', { eventName: 'push', ref: 'refs/heads/main', buildSucceeded: true, enabled: true, deployCommit: SHA, sha: SHA }, true],
  ])('%sのevent matrixを判定する', async (_name, event, expected) => {
    const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8');
    expect(verifyWorkflowPermissions(workflow).ok).toBe(true);
    const deployAllowed = event.eventName === 'push'
      && event.ref === 'refs/heads/main'
      && event.buildSucceeded
      && event.enabled
      && event.deployCommit === event.sha;
    expect(deployAllowed).toBe(expected);
  });
});

describe('容量境界', () => {
  it.each([
    [WARNING_TOTAL_BYTES - 1, true, []],
    [WARNING_TOTAL_BYTES, true, ['TOTAL_WARNING_THRESHOLD']],
    [HARD_TOTAL_BYTES - 1, true, ['TOTAL_WARNING_THRESHOLD']],
    [HARD_TOTAL_BYTES, false, []],
  ])('合計%d byteを判定する', (bytes, ok, warnings) => {
    const files = [];
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = Math.min(remaining, HARD_FILE_BYTES - 1);
      files.push({ path: `assets/part-${files.length}.bin`, bytes: chunk });
      remaining -= chunk;
    }
    const result = verifyAssetBudget(files);
    expect(result.ok).toBe(ok);
    expect(result.warnings).toEqual(warnings);
  });

  it('単一100MiBの境界と重複音声hashを拒否する', () => {
    expect(verifyAssetBudget([{ path: 'a.bin', bytes: HARD_FILE_BYTES - 1 }]).ok).toBe(true);
    expect(verifyAssetBudget([{ path: 'a.bin', bytes: HARD_FILE_BYTES }]).errors).toContain('FILE_LIMIT_EXCEEDED:a.bin');
    expect(verifyAssetBudget([
      { path: 'audio/a.wav', bytes: 1, hash: HASH },
      { path: 'audio/b.wav', bytes: 1, hash: HASH },
    ]).errors).toContain('DUPLICATE_AUDIO_HASH:audio/b.wav');
  });
});

describe('FUN-F001-031 build参照とCSP [UT-F001-031]', () => {
  it('Pages base配下の成果物を受理する', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bungo-build-'));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, 'assets')),
      mkdir(path.join(directory, 'content')),
      mkdir(path.join(directory, 'artwork')),
      mkdir(path.join(directory, 'audio')),
    ]);
    await writeFile(path.join(directory, 'index.html'), `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><link rel="stylesheet" href="${PAGES_BASE}assets/app.css"><script src="${PAGES_BASE}assets/app.js"></script></head></html>`);
    await writeFile(path.join(directory, 'assets', 'app.js'), 'console.log("ok")');
    await writeFile(path.join(directory, 'assets', 'app.css'), 'body{background:url("../artwork/akutagawa-zundamon.png")}');
    await writeFile(path.join(directory, 'artwork', 'akutagawa-zundamon.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));
    const wav = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'binary');
    const wavs = [1, 2, 3].map((suffix) => Buffer.concat([wav, Buffer.from([suffix])]));
    await Promise.all([
      writeFile(path.join(directory, 'audio', 'audio-1.wav'), wavs[0]),
      writeFile(path.join(directory, 'audio', 'audio-2.wav'), wavs[1]),
      writeFile(path.join(directory, 'audio', 'audio-3.wav'), wavs[2]),
      writeFile(path.join(directory, 'content', 'licenses.json'), '{}'),
    ]);
    const definitions = [['000127', '羅生門', '127'], ['000092', '蜘蛛の糸', '92'], ['043015', '杜子春', '43015']];
    const works = definitions.map(([workId, title, cardId], index) => ({
      workId,
      title,
      cardLink: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
      source: {
        cardUrl: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
        textUrl: `https://www.aozora.gr.jp/cards/000879/files/${workId === '000127' ? '127_15260.html' : workId === '000092' ? '92_14545.html' : '43015_17432.html'}`,
        attribution: `青空文庫『${title}』（芥川龍之介）`,
        baseEdition: workId === '000127' ? '芥川龍之介全集1' : workId === '000092' ? '芥川龍之介全集2' : '蜘蛛の糸・杜子春',
        inputter: workId === '043015' ? '蒋龍' : '野口英司、平山誠',
        proofreader: workId === '043015' ? 'noriko saito' : 'もりみつじゅんじ',
        fetchedAt: '2026-07-18T00:00:00Z',
        transformation: '公式XHTMLを宣言charsetでdecodeし、「」候補を抽出して表示文・読み上げ文へ決定的に正規化',
        sourceSha256: `${index + 1}`.repeat(64),
      },
      dialogues: [{
        dialogueId: `dialogue-${index + 1}`,
        order: 1,
        displayText: `${title}の台詞`,
        speechText: `${title}の台詞`,
        audioId: `audio-${index + 1}`,
        sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
        review: { candidateId: `dialogue-${index + 1}`, revision: 1, status: 'approved', reasonCode: 'SPOKEN_DIALOGUE', note: '発話として確認', reviewer: 'reviewer', reviewedAt: '2026-07-18T00:00:00Z', policyCheckedAt: '2026-07-18T00:00:00Z' },
      }],
    }));
    const catalog = {
      schemaVersion: '1.0.0',
      author: { authorId: '000879', name: 'あくたがわずんのすけ', originalName: '芥川龍之介', slug: 'akutagawa-zunnosuke', artwork: { path: 'artwork/akutagawa-zundamon.png', alt: '文豪風の装いで本を持つ、あくたがわずんのすけのイラスト' } },
      works,
      audioAssets: works.map((_, index) => ({ audioId: `audio-${index + 1}`, path: `audio/audio-${index + 1}.wav`, sha256: `${index + 4}`.repeat(64), bytes: wavs[index].length, durationMs: 1000, configHash: 'a'.repeat(64) })),
      candidateCounts: { total: 3, published: 3, editorialExcluded: 0, audioExcluded: 0, editorialReasons: {}, audioFailureReasons: {} },
      creditsRef: 'content/licenses.json',
      futureExpansionPolicy: { eligibilityCriteria: '確認', rightsRecheck: '再確認', stagedAddition: '段階追加' },
    };
    const catalogText = JSON.stringify(catalog);
    expect(validateCatalog(catalog, Buffer.byteLength(catalogText))).toMatchObject({ works: expect.any(Array) });
    await writeFile(path.join(directory, 'content', 'catalog.json'), catalogText);
    const result = await verifyBuiltReferences(directory);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files.find((file) => file.path === 'assets/app.css')?.mime).toBe('text/css');
  });

  it('欠損・base逸脱・危険CSPを拒否する', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bungo-build-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="${CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")}"><script src="/missing.js"></script>`);
    const result = await verifyBuiltReferences(directory);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('CATALOG_MISSING');
    expect(result.errors).toContain('CSP_DIRECTIVE_INVALID:script-src');
    expect(result.errors.some((value) => value.startsWith('BASE_ESCAPE:'))).toBe(true);
  });

  it('CSS内の欠損参照とMIME偽装をfail-closedで拒否する', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bungo-build-'));
    temporaryDirectories.push(directory);
    await Promise.all([mkdir(path.join(directory, 'assets')), mkdir(path.join(directory, 'content'))]);
    await writeFile(path.join(directory, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><link rel="stylesheet" href="${PAGES_BASE}assets/app.css">`);
    await writeFile(path.join(directory, 'assets', 'app.css'), '<!doctype html><style>body{background:url("../missing.png")}</style>');
    await writeFile(path.join(directory, 'content', 'catalog.json'), '{}');
    const result = await verifyBuiltReferences(directory);
    expect(result.errors).toContain('REFERENCE_MISSING:missing.png');
    expect(result.errors).toContain('MIME_CONTENT_MISMATCH:assets/app.css');
  });

  it('必須CSP directiveを検査する', () => {
    expect(verifyCsp(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`).ok).toBe(true);
    expect(verifyCsp('<meta http-equiv="Content-Security-Policy" content="default-src *">').ok).toBe(false);
  });
});

function releaseContext() {
  const completedAt = '2026-07-18T05:50:00.000Z';
  const browser = (key, value) => ({
    [key]: value,
    status: 'passed',
    installed: true,
    authorizedReviewer: true,
    reviewer: 'release-reviewer',
    browserVersion: 'stable-1',
    osVersion: 'test-os-1',
    evidence: `${value}.png`,
    checkedAt: completedAt,
    releaseCommit: SHA,
    catalogHash: HASH,
  });
  return {
    feature: 'F001',
    now: '2026-07-18T06:00:00.000Z',
    releaseCommit: SHA,
    catalogHash: HASH,
    automatedChecks: ['typecheck', 'lint', 'unit', 'build', 'schema', 'asset-budget', 'same-origin']
      .map((id) => ({ id, status: 'passed', evidence: `${id}.json`, completedAt, releaseCommit: SHA, catalogHash: HASH })),
    manualBrowsers: ['Windows Chrome', 'Windows Edge', 'iOS Safari'].map((name) => browser('name', name)),
    automatedBrowsers: ['chromium', 'firefox', 'webkit', 'android-viewport'].map((scope) => browser('scope', scope)),
    browserRisks: ['firefox', 'webkit', 'android-viewport'].map((scope) => ({
      scope,
      triggers: [],
      requiresDeviceTest: false,
      rationale: '自動試験PASS、既知の固有差異なし',
      reviewer: 'release-reviewer',
      authorizedReviewer: true,
      assessedAt: completedAt,
    })),
    deviceTests: [],
    hostedBuild: {
      repositoryId: 123,
      repositoryUrl: 'https://github.com/example/bungo',
      runId: 456,
      runUrl: 'https://github.com/example/bungo/actions/runs/456',
      event: 'push',
      ref: 'refs/heads/feature/F001',
      headSha: SHA,
      workflowPath: '.github/workflows/pages.yml',
      workflowSha: SHA,
      conclusion: 'success',
      artifactId: 789,
      artifactName: 'github-pages',
      artifactDigest: `sha256:${HASH}`,
      artifactCatalogHash: HASH,
      observedAt: completedAt,
      reviewer: 'release-reviewer',
      authorizedReviewer: true,
      deploymentAbsent: true,
      pagesHashBefore: HASH,
      pagesHashAfter: HASH,
    },
    visibilityPlan: {
      repositoryId: 123,
      repositoryUrl: 'https://github.com/example/bungo',
      currentVisibility: 'private',
      pagesEnabled: false,
      pagesDeployEnabled: false,
      pagesDeployCommit: null,
      observedAt: '2026-07-18T05:59:00.000Z',
      releaseCommit: SHA,
      catalogHash: HASH,
      pagesHash: HASH,
      evidence: 'visibility.json',
    },
    budget: { ok: true, evidence: 'budget.json', completedAt },
    csp: { ok: true, evidence: 'csp.json', completedAt },
    credits: { ok: true, evidence: 'credits.json', completedAt },
    artwork: { ok: true, evidence: 'artwork.json', completedAt },
    policies: [{ url: 'https://example.test/terms', status: 'passed', checkedAt: completedAt, validUntil: '2026-07-18T07:00:00.000Z', evidence: 'terms.png' }],
  };
}

// IT-F001-017: browser・hosted build・権利証跡を束ねる承認前判定を追跡する。
describe('FUN-F001-035 承認前リリース判定 [UT-F001-035]', () => {
  it('全条件を満たすread-only証跡だけをreadyにする', async () => {
    await expect(runReleaseChecks(releaseContext())).resolves.toMatchObject({ status: 'ready_for_approval', releaseCommit: SHA, catalogHash: HASH });
  });

  it.each([
    ['public repository', (context) => { context.visibilityPlan.currentVisibility = 'public'; }, 'VISIBILITY_PLAN_UNSAFE'],
    ['Pages有効', (context) => { context.visibilityPlan.pagesEnabled = true; }, 'VISIBILITY_PLAN_UNSAFE'],
    ['deploy enable有効', (context) => { context.visibilityPlan.pagesDeployEnabled = true; }, 'VISIBILITY_PLAN_UNSAFE'],
    ['deploy commit設定済み', (context) => { context.visibilityPlan.pagesDeployCommit = SHA; }, 'VISIBILITY_PLAN_UNSAFE'],
    ['手動browser非実機', (context) => { context.manualBrowsers[0].installed = false; }, 'MANUAL_BROWSER_EVIDENCE:Windows Chrome'],
    ['手動browser証跡重複', (context) => { context.manualBrowsers[1].name = 'Windows Chrome'; }, 'MANUAL_BROWSER_SET_INVALID'],
    ['自動browser Partial', (context) => { context.automatedBrowsers[1].status = 'partial'; }, 'AUTOMATED_BROWSER_EVIDENCE:firefox'],
    ['自動browser commit不一致', (context) => { context.automatedBrowsers[2].releaseCommit = 'c'.repeat(40); }, 'AUTOMATED_BROWSER_EVIDENCE:webkit'],
    ['risk欠落', (context) => { context.browserRisks.pop(); }, 'BROWSER_RISK_SET_INVALID'],
    ['未知risk trigger', (context) => { context.browserRisks[0].triggers = ['unknown']; context.browserRisks[0].requiresDeviceTest = true; }, 'BROWSER_RISK_INVALID:firefox'],
    ['triggerあり実機欠落', (context) => { context.browserRisks[0].triggers = ['automated-failure']; context.browserRisks[0].requiresDeviceTest = true; context.browserRisks[0].resolvedAt = '2026-07-18T05:40:00.000Z'; }, 'DEVICE_TEST_REQUIRED:firefox'],
    ['hosted catalog hash不一致', (context) => { context.hostedBuild.artifactCatalogHash = 'c'.repeat(64); }, 'HOSTED_BUILD_HASH_MISMATCH'],
    ['hosted repository不一致', (context) => { context.hostedBuild.repositoryId = 999; }, 'HOSTED_REPOSITORY_MISMATCH'],
    ['hosted ref不一致', (context) => { context.hostedBuild.ref = 'refs/heads/main'; }, 'HOSTED_BUILD_EVIDENCE'],
    ['hosted head SHA不一致', (context) => { context.hostedBuild.headSha = 'c'.repeat(40); }, 'HOSTED_BUILD_EVIDENCE'],
    ['hosted deploymentあり', (context) => { context.hostedBuild.deploymentAbsent = false; }, 'HOSTED_BUILD_EVIDENCE'],
    ['hosted Pages hash変化', (context) => { context.hostedBuild.pagesHashAfter = 'c'.repeat(64); }, 'HOSTED_PAGES_HASH_CHANGED'],
    ['期限切れ', (context) => { context.policies[0].validUntil = '2026-07-18T05:00:00.000Z'; }, 'POLICY_EVIDENCE_INVALID'],
    ['必須自動検査欠落', (context) => { context.automatedChecks.pop(); }, 'AUTOMATED_CHECK_INCOMPLETE'],
    ['自動検査証跡空', (context) => { context.automatedChecks[0].evidence = ''; }, 'AUTOMATED_CHECK_INCOMPLETE'],
    ['不正ISO日付', (context) => { context.visibilityPlan.observedAt = '2026-02-30T06:00:00Z'; }, 'VISIBILITY_PLAN_STALE'],
  ])('%sをblockedにする', async (_name, mutate, blocker) => {
    const context = releaseContext();
    mutate(context);
    await expect(runReleaseChecks(context)).resolves.toMatchObject({ status: 'blocked', blockers: expect.arrayContaining([blocker]) });
  });

  it('証跡日時が判定instantと一致する境界を受理し、入力を変更しない', async () => {
    const context = releaseContext();
    context.visibilityPlan.observedAt = context.now;
    context.hostedBuild.observedAt = context.now;
    context.manualBrowsers[0].checkedAt = context.now;
    context.automatedBrowsers[0].checkedAt = context.now;
    context.policies[0].validUntil = context.now;
    const before = JSON.parse(JSON.stringify(context));
    await expect(runReleaseChecks(context)).resolves.toMatchObject({ status: 'ready_for_approval' });
    expect(context).toEqual(before);
  });

  it('trigger解消後の自動再試験と該当実機PASSを受理する', async () => {
    const context = releaseContext();
    const resolvedAt = '2026-07-18T05:56:00.000Z';
    context.browserRisks[0] = {
      ...context.browserRisks[0],
      triggers: ['behavior-difference'],
      requiresDeviceTest: true,
      assessedAt: '2026-07-18T05:30:00.000Z',
      resolvedAt,
    };
    context.deviceTests.push({
      ...context.manualBrowsers[0],
      scope: 'firefox',
      name: 'Installed Firefox',
      checkedAt: '2026-07-18T05:55:00.000Z',
    });
    await expect(runReleaseChecks(context)).resolves.toMatchObject({ status: 'ready_for_approval' });
  });

  it('feature/hosted branch固定をF002へparameter化しsecurity preflightを接続する', async () => {
    const context = releaseContext();
    context.feature = 'F002';
    context.hostedBuild.ref = 'refs/heads/feature/F002';
    context.securityContext = { dependencyAudit: { status: 'unknown' } };
    await expect(runReleaseChecks(context)).resolves.toMatchObject({
      status: 'blocked', blockers: expect.arrayContaining(['SECURITY_CHECK_FAILED']),
    });
    const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8');
    const csp = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
    context.securityContext = {
      applicationOrigin: 'https://example.test',
      publicBasePath: '/bungo-zundamon/',
      expectedRoutes: ['#/', '#/credits'],
      distRoutes: [{ route: '#/', csp }, { route: '#/credits', csp }],
      requestLog: {
        status: 'passed', source: 'browser-observer',
        observedRoutes: ['#/', '#/credits'], requests: [],
      },
      domSinkScan: { status: 'passed', unsafeSinkCount: 0 },
      privacyScan: { status: 'passed', cookieAccessCount: 0, localStorageCount: 0, sessionStorageCount: 0, indexedDbCount: 0, formCount: 0 },
      secretScan: { status: 'passed', matches: 0 },
      dependencyAudit: { status: 'passed', source: 'npm-audit', audited: true, high: 0, critical: 0 },
      catalogFixtures: { status: 'passed', source: 'malicious-fixture-suite', caseCount: 1, unsafeAccepted: 0 },
      workflow,
    };
    await expect(runReleaseChecks(context)).resolves.toMatchObject({ status: 'ready_for_approval' });

    context.securityContext = await runF002StaticSecurityChecks({
      expectedRoutes: ['#/', '#/credits'],
      distRoutes: [{ route: '#/', csp }, { route: '#/credits', csp }],
      domSinkScan: { status: 'passed', unsafeSinkCount: 0 },
      privacyScan: { status: 'passed', cookieAccessCount: 0, localStorageCount: 0, sessionStorageCount: 0, indexedDbCount: 0, formCount: 0 },
      secretScan: { status: 'passed', matches: 0 },
      workflow,
    });
    await expect(runReleaseChecks(context)).resolves.toMatchObject({
      status: 'blocked', blockers: expect.arrayContaining(['SECURITY_CHECK_FAILED']),
    });
  });
});

function visibilityEvidence() {
  return {
    feature: 'F001',
    approvalId: 'Q-009',
    approvalStatus: 'closed',
    approvalAnswer: '承認',
    approvalTargetCommit: SHA,
    approvedAt: '2026-07-18T06:00:00.000Z',
    trustedQueueApprovals: [
      {
        id: 'Q-004',
        type: 'approval',
        status: 'closed',
        answer: '承認',
        source: 'pf-testspec',
        target_mode: 'document',
        target: 'docs/tests/ut/UT-F001.md',
        approvalTargetCommit: SHA,
        approvedAt: '2026-07-18T05:00:00.000Z',
      },
      {
        id: 'Q-009',
        type: 'approval',
        status: 'closed',
        answer: '承認',
        source: 'pf-release',
        target_mode: 'reference',
        target: 'F001',
        approvalTargetCommit: SHA,
        approvedAt: '2026-07-18T06:00:00.000Z',
      },
    ],
    releaseCommit: SHA,
    privateObserved: true,
    privateObservedAt: '2026-07-18T06:00:00.000Z',
    publicObserved: true,
    publicObservedAt: '2026-07-18T06:01:00.000Z',
    pagesEnabledAt: '2026-07-18T06:01:00.000Z',
    pagesDeployCommit: SHA,
    pagesDeployEnabledAt: '2026-07-18T06:02:00.000Z',
    pagesDeployDisabledAt: '2026-07-18T06:03:00.000Z',
    pagesDeployEnabledAfter: false,
    pagesDeployCommitAfter: null,
    visibilityAuditEvent: { id: 'audit-1', from: 'private', to: 'public', occurredAt: '2026-07-18T06:00:30.000Z', releaseCommit: SHA },
    artifactCommit: SHA,
    deploymentCommit: SHA,
    catalogHash: HASH,
    artifactCatalogHash: HASH,
    deploymentCatalogHash: HASH,
    pagesCatalogHash: HASH,
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    deploymentArtifactDigest: `sha256:${'c'.repeat(64)}`,
    deploymentId: 'deployment-1',
    pagesHash: HASH,
    pagesStatus: 200,
    repositoryUrl: 'https://github.com/example/bungo',
    pagesUrl: 'https://example.github.io/bungo-zundamon/',
  };
}

describe('FUN-F001-042 承認後release chain [UT-F001-042]', () => {
  it('完全なchainだけをreleasedにする', () => {
    expect(validateReleaseVisibilityEvidence(visibilityEvidence())).toMatchObject({ status: 'released', releaseCommit: SHA });
  });

  it.each([
    ['未承認', (evidence) => { evidence.approvalAnswer = '修正指示'; }, 'APPROVAL_INVALID'],
    ['存在しない承認ID', (evidence) => { evidence.approvalId = 'Q-999'; }, 'APPROVAL_RECORD_NOT_FOUND'],
    ['ゲート③承認ID', (evidence) => { evidence.approvalId = 'Q-004'; }, 'APPROVAL_GATE_MISMATCH'],
    ['queue type不一致', (evidence) => { evidence.trustedQueueApprovals[1].type = 'question'; }, 'APPROVAL_INVALID'],
    ['queue status不一致', (evidence) => { evidence.trustedQueueApprovals[1].status = 'pending'; }, 'APPROVAL_INVALID'],
    ['queue answer不一致', (evidence) => { evidence.trustedQueueApprovals[1].answer = '修正指示'; }, 'APPROVAL_INVALID'],
    ['queue source不一致', (evidence) => { evidence.trustedQueueApprovals[1].source = 'pf-testspec'; }, 'APPROVAL_GATE_MISMATCH'],
    ['queue target mode不一致', (evidence) => { evidence.trustedQueueApprovals[1].target_mode = 'document'; }, 'APPROVAL_GATE_MISMATCH'],
    ['queue target不一致', (evidence) => { evidence.trustedQueueApprovals[1].target = 'F002'; }, 'APPROVAL_GATE_MISMATCH'],
    ['queue承認commit不一致', (evidence) => { evidence.trustedQueueApprovals[1].approvalTargetCommit = 'd'.repeat(40); }, 'APPROVAL_GATE_MISMATCH'],
    ['queue承認時刻不一致', (evidence) => { evidence.trustedQueueApprovals[1].approvedAt = '2026-07-18T05:59:00.000Z'; }, 'APPROVAL_GATE_MISMATCH'],
    ['queue承認レコード欠落', (evidence) => { evidence.trustedQueueApprovals = []; }, 'TRUSTED_APPROVAL_SET_INVALID'],
    ['queue承認ID重複', (evidence) => { evidence.trustedQueueApprovals.push({ ...evidence.trustedQueueApprovals[1] }); }, 'TRUSTED_APPROVAL_SET_INVALID'],
    ['順序不正', (evidence) => { evidence.publicObservedAt = '2026-07-18T05:59:00.000Z'; }, 'VISIBILITY_TIME_ORDER_INVALID'],
    ['audit欠落', (evidence) => { evidence.visibilityAuditEvent = null; }, 'VISIBILITY_AUDIT_INVALID'],
    ['deploy commit不一致', (evidence) => { evidence.pagesDeployCommit = 'd'.repeat(40); }, 'RELEASE_COMMIT_CHAIN_MISMATCH'],
    ['deploy変数無効化欠落', (evidence) => { evidence.pagesDeployEnabledAfter = true; }, 'DEPLOY_VARIABLES_NOT_DISABLED'],
    ['commit不一致', (evidence) => { evidence.deploymentCommit = 'd'.repeat(40); }, 'RELEASE_COMMIT_CHAIN_MISMATCH'],
    ['catalog hash不一致', (evidence) => { evidence.pagesCatalogHash = 'd'.repeat(64); }, 'CATALOG_HASH_CHAIN_MISMATCH'],
    ['空commit', (evidence) => { evidence.releaseCommit = ''; evidence.approvalTargetCommit = ''; evidence.pagesDeployCommit = ''; evidence.artifactCommit = ''; evidence.deploymentCommit = ''; }, 'RELEASE_COMMIT_INVALID'],
    ['空hash chain', (evidence) => { evidence.catalogHash = ''; evidence.artifactCatalogHash = ''; evidence.deploymentCatalogHash = ''; evidence.pagesCatalogHash = ''; evidence.pagesHash = ''; }, 'CATALOG_HASH_INVALID'],
    ['artifact digest chain不一致', (evidence) => { evidence.deploymentArtifactDigest = `sha256:${'d'.repeat(64)}`; }, 'ARTIFACT_DIGEST_INVALID'],
    ['audit時刻欠落', (evidence) => { delete evidence.visibilityAuditEvent.occurredAt; }, 'VISIBILITY_AUDIT_INVALID'],
  ])('%sをblockedにする', (_name, mutate, blocker) => {
    const evidence = visibilityEvidence();
    mutate(evidence);
    expect(validateReleaseVisibilityEvidence(evidence)).toMatchObject({ status: 'blocked', blockers: expect.arrayContaining([blocker]) });
  });

  it('公開・Pages・deploy変数の許容境界時刻を受理する', () => {
    const evidence = visibilityEvidence();
    evidence.pagesDeployEnabledAt = evidence.pagesEnabledAt;
    evidence.pagesDeployDisabledAt = evidence.pagesDeployEnabledAt;
    expect(validateReleaseVisibilityEvidence(evidence)).toMatchObject({ status: 'released' });
  });

  it('承認targetをfeature引数F002へparameter化する', () => {
    const evidence = visibilityEvidence();
    evidence.feature = 'F002';
    evidence.trustedQueueApprovals[1].target = 'F002';
    expect(validateReleaseVisibilityEvidence(evidence)).toMatchObject({ status: 'released' });
  });
});
