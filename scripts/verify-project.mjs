import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAndVerifyF001Baseline } from '../src/content/production-final.ts';
import {
  PAGES_BASE,
  runF002StaticSecurityChecks,
  verifyBuiltReferences,
  verifyWorkflowPermissions,
} from './release-checks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNOWN_BASELINE_CODES = new Set([
  'F001_BASELINE_IDENTITY_INVALID',
  'F001_ITEM_MISSING',
  'F001_ITEM_MUTATED',
  'F001_PROVENANCE_MISSING',
  'F001_PROVENANCE_HASH_MISMATCH',
  'F001_ASSET_MISSING',
  'F001_ASSET_HASH_MISMATCH',
  'F001_SOURCE_ROOT_UNSAFE',
]);

/** @des DES-F002-003 DES-F002-006 DES-F002-016 @fun FUN-F002-005 */
export async function verifyF001BaselinePreflight(
  root,
  loader = loadAndVerifyF001Baseline,
) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return { ok: false, errors: ['F001_BASELINE_PREFLIGHT_FAILED'] };
  }
  const sourceRoot = path.resolve(root, 'public');
  const baselinePath = path.resolve(root, 'content', 'baselines', 'F001-v0.1.0.json');
  const rawCatalogPath = path.resolve(root, 'content', 'baselines', 'F001-v0.1.0-catalog.json');
  try {
    await loader(sourceRoot, baselinePath, rawCatalogPath);
    return { ok: true, errors: [] };
  } catch (error) {
    const code = error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : null;
    return {
      ok: false,
      errors: [code !== null && KNOWN_BASELINE_CODES.has(code) ? code : 'F001_BASELINE_PREFLIGHT_FAILED'],
    };
  }
}

// @des DES-F001-015 @des DES-F001-016 @fun FUN-F001-031 @fun FUN-F001-032
async function main() {
  const [workflow, nvmrc, packageJson] = await Promise.all([
    readFile(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8'),
    readFile(path.join(projectRoot, '.nvmrc'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const expectedNodeVersion = packageJson.engines?.node;
  const workflowReport = verifyWorkflowPermissions(workflow, {
    expectedNodeVersion,
    nvmrcVersion: nvmrc.trim().replace(/^v/, ''),
  });
  const [buildReport, baselineReport] = await Promise.all([
    verifyBuiltReferences(path.join(projectRoot, 'dist'), PAGES_BASE),
    verifyF001BaselinePreflight(projectRoot),
  ]);
  const errors = [...workflowReport.errors, ...buildReport.errors, ...baselineReport.errors];
  const warnings = [...workflowReport.warnings, ...buildReport.warnings];

  const [indexHtml, catalog, staticTexts] = await Promise.all([
    readFile(path.join(projectRoot, 'dist', 'index.html'), 'utf8'),
    readFile(path.join(projectRoot, 'dist', 'content', 'catalog.json'), 'utf8').then(JSON.parse),
    Promise.all(buildReport.files
      .filter((file) => /\.(?:html|js|mjs|css|json|svg|txt)$/iu.test(file.path))
      .map((file) => readFile(path.join(projectRoot, 'dist', ...file.path.split('/')), 'utf8'))),
  ]);
  const authorSlugs = catalog.schemaVersion === '2.0.0'
    ? catalog.authors.map((author) => author.slug)
    : [catalog.author.slug];
  const expectedRoutes = ['#/', ...authorSlugs.map((slug) => `#/authors/${slug}`), '#/credits'];
  const staticSource = staticTexts.join('\n');
  const securityReport = await runF002StaticSecurityChecks({
    expectedRoutes,
    distRoutes: expectedRoutes.map((route) => ({ route, csp: indexHtml })),
    domSinkScan: {
      status: 'passed',
      unsafeSinkCount: [
        /\.innerHTML\s*=/gu,
        /\.outerHTML\s*=/gu,
        /insertAdjacentHTML\s*\(/gu,
        /document\.write\s*\(/gu,
        /\beval\s*\(/gu,
        /new\s+Function\s*\(/gu,
      ].reduce((count, pattern) => count + [...staticSource.matchAll(pattern)].length, 0),
    },
    privacyScan: {
      status: 'passed',
      cookieAccessCount: [...staticSource.matchAll(/document\.cookie/gu)].length,
      localStorageCount: [...staticSource.matchAll(/\blocalStorage\b/gu)].length,
      sessionStorageCount: [...staticSource.matchAll(/\bsessionStorage\b/gu)].length,
      indexedDbCount: [...staticSource.matchAll(/\bindexedDB\b/gu)].length,
      formCount: [...staticSource.matchAll(/<form\b/giu)].length,
    },
    secretScan: {
      status: 'passed',
      matches: buildReport.errors.filter((error) => error.startsWith('SECRET_PATTERN:')).length,
    },
    workflow,
  });
  if (securityReport.scope !== 'static-build' || securityReport.status !== 'static-pass') {
    errors.push(...securityReport.codes);
  }
  if (process.version.slice(1) !== expectedNodeVersion) errors.push('LOCAL_NODE_VERSION_MISMATCH');
  if (!buildReport.files.some((file) => file.path === '.nojekyll')) errors.push('NOJEKYLL_MISSING');

  for (const warning of warnings) console.warn(`[build warning] ${warning}`);
  if (errors.length > 0) {
    for (const error of [...new Set(errors)]) console.error(`[build error] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`build verification passed: ${buildReport.files.length} files / ${buildReport.totalBytes} bytes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
