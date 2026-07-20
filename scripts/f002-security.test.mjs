import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runF002SecurityChecks, runF002StaticSecurityChecks } from './f002-security.mjs';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const workflowPath = path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'pages.yml');

async function fixture() {
  return {
    applicationOrigin: 'https://example.test',
    publicBasePath: '/bungo-zundamon/',
    expectedRoutes: ['#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits'],
    distRoutes: [
      { route: '#/', csp: CSP },
      { route: '#/authors/akutagawa-zunnosuke', csp: CSP },
      { route: '#/authors/miyazawa-zunji', csp: `<meta http-equiv="Content-Security-Policy" content="${CSP}">` },
      { route: '#/credits', csp: CSP },
    ],
    requestLog: {
      status: 'passed',
      source: 'browser-observer',
      observedRoutes: ['#/', '#/authors/akutagawa-zunnosuke', '#/authors/miyazawa-zunji', '#/credits'],
      requests: [
        { route: '#/', kind: 'asset', url: 'https://example.test/bungo-zundamon/assets/app.js' },
        { route: '#/authors/miyazawa-zunji', kind: 'audio', url: 'https://example.test/bungo-zundamon/audio/F002/a.wav' },
      ],
    },
    domSinkScan: { status: 'passed', unsafeSinkCount: 0 },
    privacyScan: {
      status: 'passed', cookieAccessCount: 0, localStorageCount: 0,
      sessionStorageCount: 0, indexedDbCount: 0, formCount: 0,
    },
    secretScan: { status: 'passed', matches: 0 },
    dependencyAudit: { status: 'passed', source: 'npm-audit', audited: true, high: 0, critical: 0 },
    catalogFixtures: { status: 'passed', source: 'malicious-fixture-suite', caseCount: 12, unsafeAccepted: 0 },
    workflow: await readFile(workflowPath, 'utf8'),
  };
}

describe('FUN-F002-029 security集約 [DES-F002-012][DES-F002-016][UT-F002-029][IT-F002-016][IT-F002-017]', () => {
  it('self-only runtime・安全DOM・最小workflow・問題0のscanだけをPASSにする', async () => {
    await expect(runF002SecurityChecks(await fixture())).resolves.toEqual({
      scope: 'full-release',
      status: 'pass',
      counts: {
        cspViolations: 0,
        externalRequests: 0,
        openRedirects: 0,
        unsafeDomSinks: 0,
        storageOrForms: 0,
        externalTtsRequests: 0,
        secrets: 0,
        dependencyHighOrCritical: 0,
        workflowViolations: 0,
        catalogUnsafeAccepted: 0,
        unknownResults: 0,
      },
      codes: [],
    });
  });

  it.each(Object.keys({
    'default-src': 1, 'script-src': 1, 'style-src': 1, 'img-src': 1, 'media-src': 1,
    'connect-src': 1, 'object-src': 1, 'base-uri': 1, 'form-action': 1, 'frame-src': 1,
  }))('CSP必須directive %s の欠落を拒否する', async (directive) => {
    const context = await fixture();
    context.distRoutes[0].csp = CSP.split('; ').filter((item) => !item.startsWith(directive)).join('; ');
    const result = await runF002SecurityChecks(context);
    expect(result).toMatchObject({ status: 'blocked', codes: expect.arrayContaining(['SECURITY_CSP_VIOLATION']) });
  });

  it.each([
    ['外部request', (context) => context.requestLog.requests.push({ kind: 'asset', url: 'https://evil.example/app.js' }), 'SECURITY_EXTERNAL_REQUEST'],
    ['open redirect', (context) => context.requestLog.requests.push({ kind: 'navigation', url: 'https://evil.example/' }), 'SECURITY_EXTERNAL_REQUEST'],
    ['外部TTS', (context) => context.requestLog.requests.push({ kind: 'tts', url: 'https://voicevox.example/synthesis' }), 'SECURITY_EXTERNAL_TTS'],
    ['危険DOM', (context) => { context.domSinkScan.unsafeSinkCount = 1; }, 'SECURITY_UNSAFE_DOM'],
    ['storage', (context) => { context.privacyScan.localStorageCount = 1; }, 'SECURITY_STORAGE_OR_FORM'],
    ['form', (context) => { context.privacyScan.formCount = 1; }, 'SECURITY_STORAGE_OR_FORM'],
    ['secret', (context) => { context.secretScan.matches = 1; }, 'SECURITY_SECRET_FOUND'],
    ['High依存', (context) => { context.dependencyAudit.high = 1; }, 'SECURITY_DEPENDENCY_HIGH'],
    ['Critical依存', (context) => { context.dependencyAudit.critical = 1; }, 'SECURITY_DEPENDENCY_HIGH'],
    ['悪意catalog受理', (context) => { context.catalogFixtures.unsafeAccepted = 1; }, 'SECURITY_CATALOG_UNSAFE'],
  ])('%sを件数付きでblockedにする', async (_label, mutate, code) => {
    const context = await fixture();
    mutate(context);
    const result = await runF002SecurityChecks(context);
    expect(result).toMatchObject({ status: 'blocked', codes: expect.arrayContaining([code]) });
    expect(Object.values(result.counts).some((count) => count > 0)).toBe(true);
  });

  it.each([
    ['tag', 'actions/checkout@v4'],
    ['branch', 'actions/checkout@main'],
    ['短縮SHA', 'actions/checkout@1234567'],
    ['大文字40桁', `actions/checkout@${'A'.repeat(40)}`],
    ['非hex40桁', `actions/checkout@${'g'.repeat(40)}`],
  ])('remote usesの%sを拒否する', async (_label, replacement) => {
    const context = await fixture();
    context.workflow = context.workflow.replace(/actions\/checkout@[a-f0-9]{40}/u, replacement);
    const result = await runF002SecurityChecks(context);
    expect(result).toMatchObject({ status: 'blocked', codes: expect.arrayContaining(['SECURITY_WORKFLOW_INVALID']) });
  });

  it('checkout persist-credentials trueを拒否し、local ./ actionはSHAなしで許可する', async () => {
    const unsafe = await fixture();
    unsafe.workflow = unsafe.workflow.replace('persist-credentials: false', 'persist-credentials: true');
    await expect(runF002SecurityChecks(unsafe)).resolves.toMatchObject({
      status: 'blocked', codes: expect.arrayContaining(['SECURITY_WORKFLOW_INVALID']),
    });

    const local = await fixture();
    local.workflow = local.workflow.replace(
      '      - name: Set up Node',
      '      - name: Local check\n        uses: ./actions/security-check\n      - name: Set up Node',
    );
    await expect(runF002SecurityChecks(local)).resolves.toMatchObject({ status: 'pass' });
  });

  it('unknown結果をfail-closedにし、秘密・stack・payload本文を診断へ含めない', async () => {
    const context = await fixture();
    context.dependencyAudit = {
      status: 'unknown', high: 0, critical: 0,
      token: 'ghp_SUPER_SECRET_VALUE_SHOULD_NEVER_LEAK',
      stack: 'Error: token at internal/path',
      payload: '未公開台詞全文',
    };
    const result = await runF002SecurityChecks(context);
    expect(result).toMatchObject({
      status: 'blocked',
      counts: { unknownResults: 1 },
      codes: expect.arrayContaining(['SECURITY_UNKNOWN_RESULT']),
    });
    const diagnostic = JSON.stringify(result);
    expect(diagnostic).not.toContain('SUPER_SECRET');
    expect(diagnostic).not.toContain('internal/path');
    expect(diagnostic).not.toContain('未公開台詞');
  });

  it('static-build検査は実測可能な項目だけを判定しfull-release PASSを名乗らない', async () => {
    const full = await fixture();
    const result = await runF002StaticSecurityChecks({
      expectedRoutes: full.expectedRoutes,
      distRoutes: full.distRoutes,
      domSinkScan: full.domSinkScan,
      privacyScan: full.privacyScan,
      secretScan: full.secretScan,
      workflow: full.workflow,
    });
    expect(result).toMatchObject({ scope: 'static-build', status: 'static-pass' });
    expect(result).not.toHaveProperty('scope', 'full-release');
    expect(result.status).not.toBe('pass');
  });

  it.each(['requestLog', 'dependencyAudit', 'catalogFixtures'])(
    'full-release検査は%s欠落をunknownとしてblockedにする', async (field) => {
      const context = await fixture();
      delete context[field];
      await expect(runF002SecurityChecks(context)).resolves.toMatchObject({
        scope: 'full-release',
        status: 'blocked',
        codes: expect.arrayContaining(['SECURITY_UNKNOWN_RESULT']),
      });
    },
  );
});
