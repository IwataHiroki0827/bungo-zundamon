import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import type { BatchId, Sha256 } from '../src/content/batch.ts';
import {
  createRuntimeAcceptanceEvidence,
  REQUIRED_RUNTIME_BROWSERS,
  REQUIRED_RUNTIME_VIEWPORTS,
} from '../src/content/runtime-acceptance.ts';

const execFile = promisify(execFileCallback);
const BATCH_ID = 'F003';
const EVIDENCE_PATH = '.cache/batch-release/F003/runtime-acceptance.json';
const BROWSER_REPORT_ROOT = '.cache/batch-release/F003/browser';
const REQUIRED_TITLES = [
  'CatalogV2の3作者9作品472台詞を所属分離し、作者間の往復を維持する',
  '390x844で宮沢routeをkeyboard操作でき、overflowと44px未満targetがない',
  '844x390で宮沢routeをkeyboard操作でき、overflowと44px未満targetがない',
  '1440x900で宮沢routeをkeyboard操作でき、overflowと44px未満targetがない',
  'reduced motionは宮沢の情報と再生操作を保ったまま演出だけを止める',
  '3作者の主要routeで許可外通信・CSP・Cookie・storage・formが0件',
] as const;

interface PlaywrightReport {
  readonly suites: readonly PlaywrightSuite[];
  readonly errors: readonly unknown[];
  readonly stats: {
    readonly expected: number;
    readonly skipped: number;
    readonly unexpected: number;
    readonly flaky: number;
  };
}

interface PlaywrightSuite {
  readonly suites?: readonly PlaywrightSuite[];
  readonly specs?: readonly {
    readonly title: string;
    readonly tests: readonly {
      readonly projectName: string;
      readonly status: string;
    }[];
  }[];
}

interface CatalogProjection {
  readonly authors: readonly { readonly slug: string }[];
}

interface AuditReport {
  readonly metadata?: {
    readonly vulnerabilities?: {
      readonly high?: number;
      readonly critical?: number;
    };
  };
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function treeSha256(root: string): Promise<Sha256> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (current: string, logical: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${logical || root}にlink/reparseがあります`);
    if (info.isFile()) {
      files.push({ path: logical, bytes: await readFile(current) });
      return;
    }
    if (!info.isDirectory()) throw new Error(`${logical || root}にregular file以外があります`);
    for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right, 'en'))) {
      await walk(join(current, name), logical ? `${logical}/${name}` : name);
    }
  };
  await walk(root, '');
  const digest = createHash('sha256');
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  }
  return digest.digest('hex') as Sha256;
}

function collectSpecs(
  suites: readonly PlaywrightSuite[],
): Array<{ title: string; projectName: string; status: string }> {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((test) => ({ title: spec.title, ...test }))),
    ...collectSpecs(suite.suites ?? []),
  ]);
}

async function verifyBrowserReport(
  workspace: string,
  fileName: string,
  projectName: string,
  skipped: number,
): Promise<void> {
  const report = JSON.parse(
    await readFile(join(workspace, BROWSER_REPORT_ROOT, fileName), 'utf8'),
  ) as PlaywrightReport;
  const specs = collectSpecs(report.suites);
  const allowedSkippedTitle = 'production buildの全公開assetがPages base配下で200を返す';
  if (report.errors.length !== 0 || report.stats.unexpected !== 0 || report.stats.flaky !== 0 ||
    report.stats.skipped !== skipped || report.stats.expected !== 21 - skipped ||
    specs.some((spec) =>
      spec.projectName !== projectName ||
      (spec.status !== 'expected' && !(skipped === 1 &&
        spec.status === 'skipped' && spec.title === allowedSkippedTitle)))) {
    throw new Error(`${projectName}のPlaywright結果が合格条件を満たしません`);
  }
  for (const title of REQUIRED_TITLES) {
    if (!specs.some((spec) => spec.title === title)) {
      throw new Error(`${projectName}に必須試験がありません: ${title}`);
    }
  }
}

async function run(workspace: string, command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  const sourceCommit = head.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || status.trim() !== '') {
    throw new Error('RuntimeAcceptance生成にはexact clean source commitが必要です');
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const node = process.execPath;
  await run(workspace, npm, ['run', 'build']);
  await run(workspace, node, ['--experimental-transform-types', 'scripts/verify-project.mjs']);
  const audit = JSON.parse(
    await run(workspace, npm, ['audit', '--omit=dev', '--audit-level=high', '--json']),
  ) as AuditReport;
  const high = audit.metadata?.vulnerabilities?.high ?? -1;
  const critical = audit.metadata?.vulnerabilities?.critical ?? -1;
  if (high !== 0 || critical !== 0) throw new Error('依存脆弱性のHigh/Criticalが0件ではありません');

  await Promise.all([
    verifyBrowserReport(workspace, 'chromium.json', 'chromium-pages-preview', 0),
    verifyBrowserReport(workspace, 'firefox.json', 'firefox-pages-preview', 1),
    verifyBrowserReport(workspace, 'webkit.json', 'webkit-pages-preview', 1),
    verifyBrowserReport(workspace, 'android-equivalent.json', 'android-equivalent-pages-preview', 1),
  ]);

  const catalog = JSON.parse(
    await readFile(join(workspace, 'public', 'content', 'catalog.json'), 'utf8'),
  ) as CatalogProjection;
  const routes = ['#/', ...catalog.authors.map((author) => `#/authors/${author.slug}`), '#/credits'];
  if (routes.length !== 5) throw new Error('F003の公開routeが5件ではありません');
  const contentBuildSha256 = await treeSha256(join(workspace, 'public'));
  const distSha256 = await treeSha256(join(workspace, 'dist'));
  const evidence = createRuntimeAcceptanceEvidence({
    batchId: BATCH_ID as BatchId,
    sourceCommit,
    contentBuildSha256,
    distSha256,
    routes,
    browsers: REQUIRED_RUNTIME_BROWSERS,
    viewports: REQUIRED_RUNTIME_VIEWPORTS,
    reducedMotion: true,
    initialOpenPanels: Object.fromEntries(routes.map((route) => [route, 0])),
    keyboardExpandable: true,
    security: {
      cspViolations: 0,
      externalRequests: 0,
      unsafeDomSinks: 0,
      storageOrForms: 0,
      secrets: 0,
      dependencyHighOrCritical: 0,
      workflowViolations: 0,
    },
  });
  await writeJsonArtifactAtomic(workspace, EVIDENCE_PATH, evidence);
  const artifactBytes = await readFile(join(workspace, EVIDENCE_PATH));
  process.stdout.write(`${canonicalJson({
    path: EVIDENCE_PATH,
    artifactSha256: sha256(artifactBytes),
    evidenceSha256: evidence.evidenceSha256,
    sourceCommit,
    contentBuildSha256,
    distSha256,
    result: evidence.result,
  })}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
