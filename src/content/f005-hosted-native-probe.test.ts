import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ProbeWorkflow {
  readonly on: {
    readonly push: {
      readonly branches: readonly string[];
      readonly paths: readonly string[];
    };
  };
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: {
    readonly probe: {
      readonly permissions?: Readonly<Record<string, string>>;
      readonly steps: ReadonlyArray<{
        readonly name?: string;
        readonly uses?: string;
        readonly run?: string;
        readonly with?: Readonly<Record<string, unknown>>;
        readonly env?: Readonly<Record<string, string>>;
      }>;
    };
  };
}

interface TargetManifest {
  readonly schemaVersion: string;
  readonly targetId: string;
  readonly cases: readonly string[];
}

interface TargetResult {
  readonly targetId: string;
  readonly result: string;
  readonly expectedCaseCount: number;
  readonly passedCaseCount: number;
  readonly caseManifestSha256: string;
  readonly runtime: Readonly<Record<string, string>>;
}

const CASE_PREFIX = 'F005_T110_CASE_BASE64=';
const RESULT_PREFIX = 'F005_T110_RESULT_BASE64=';
const execFileAsync = promisify(execFile);

function decodeMarker<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T;
}

describe('F005 T-110 hosted native correlation [CHG-F005-052]', () => {
  it('workflow全体をread-onlyに固定しcredential・push・artifactを持たない', async () => {
    const raw = await readFile(
      resolve('.github/workflows/f005-hosted-native-probe.yml'),
      'utf8',
    );
    const workflow = parse(raw) as ProbeWorkflow;
    const job = workflow.jobs.probe;
    const scripts = job.steps.flatMap((step) => step.run ? [step.run] : []).join('\n');
    const actions = job.steps.flatMap((step) => step.uses ? [step.uses] : []);
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));

    expect(workflow.on.push).toEqual({
      branches: ['feature/F005'],
      paths: [
        '.github/workflows/f005-hosted-native-probe.yml',
        'native/f005-guard/**',
        'native/f005-guard-tests/**',
        'src/content/f005-source.ts',
      ],
    });
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(actions).toEqual([
      'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    ]);
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(raw).not.toMatch(/(?:contents|actions|pages|id-token):\s*write/u);
    expect(scripts).not.toMatch(/\bgit\s+(?:push|commit|add)\b/u);
    expect(raw).not.toMatch(/actions\/upload-(?:artifact|pages-artifact)@/u);
    expect(scripts).toContain('F005_T110_CASE_BASE64=');
    expect(scripts).toContain('F005_T110_RESULT_BASE64=');
    expect(scripts).toContain('F005_T110_EVIDENCE_BASE64=');
    expect(scripts).toContain('(Get-Item -LiteralPath $stdout).Length -gt 65536');
    expect(scripts).toContain('(Get-Item -LiteralPath $stderr).Length -gt 65536');
    expect(scripts).toContain('F005_T110_TARGET_UNKNOWN_LINE');
    expect(scripts).toContain('F005_T110_TARGET_RESULT_CARDINALITY');
    expect(scripts).toContain("@('public', 'data', 'candidate', 'audio', 'staging')");
    expect(scripts).toContain('candidate/f005-t070-$env:GITHUB_SHA');
    expect(scripts).toContain('actions/workflows/pages.yml/runs?event=push&head_sha=');
    expect(scripts).toContain("$deploy[0].conclusion -cne 'skipped'");
    expect(scripts).toContain('sourceSha256 = $hashes');
    expect(scripts).toContain('ProductionAssemblySha256');
    expect(scripts).toContain('ProductionAssemblyMvid');
    expect(scripts).toContain('TestAssemblySha256');
    expect(scripts).toContain('TestExecutableSha256');
    expect(scripts).not.toContain('nativeBuildLogTail');
  });

  it('production callbackとtargetが同じ初回tuple共有規則を使用する', async () => {
    const [production, target] = await Promise.all([
      readFile(resolve('native/f005-guard/Program.cs'), 'utf8'),
      readFile(resolve('native/f005-guard-tests/T110TargetSuite.cs'), 'utf8'),
    ]);
    const callback = production.slice(
      production.indexOf('private bool TryAuthorizeBoundLeaseDirectoryWriteLocked('),
      production.indexOf('private string? RecheckBoundLeaseDirectoryTupleLocked('),
    );
    const shared = production.slice(
      production.indexOf('public readonly record struct BoundLeaseInitialInspection('),
      production.indexOf('public static string? TupleRecheckFailure('),
    );

    expect(callback.match(/EvaluateInitialTupleInspection\(/gu)).toHaveLength(1);
    expect(callback.match(/directoryCurrent = TryInspect\(normalized\)/gu)).toHaveLength(1);
    expect(callback.match(/leaseCurrent = TryInspect\(lease\.RelativePath\)/gu))
      .toHaveLength(1);
    expect(callback.indexOf('EvaluateCheapPredicates('))
      .toBeLessThan(callback.indexOf('EvaluateInitialTupleInspection('));
    expect(callback.indexOf('EvaluateInitialTupleInspection('))
      .toBeLessThan(callback.indexOf('job.InspectRetainedProcess('));
    expect(shared).toContain('inspection = inspect();');
    expect(shared.match(/inspection = inspect\(\);/gu)).toHaveLength(1);
    expect(shared).toContain(
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_INITIAL_TUPLE_INSPECTION_FAILED',
    );
    expect(target).toContain('Rules.EvaluateInitialTupleInspection(');
    expect(production).not.toMatch(/F005_T110|CHG-F005-036\/T-110/u);
    expect(callback).not.toMatch(/Environment\.|GetEnvironmentVariable|args\[/u);
  });

  it.runIf(process.platform === 'win32')(
    '固定57 case markerとfinal markerをexactに解析する', async () => {
    const manifest = JSON.parse(await readFile(
      resolve('native/f005-guard-tests/t110-case-manifest.json'),
      'utf8',
    )) as TargetManifest;
    const executable = resolve(
      'native/f005-guard-tests/bin/Release/net9.0/win-x64/F005Guard.CorrelationTests.exe',
    );
    await execFileAsync(resolve('.cache/dotnet-f005/sdk/dotnet.exe'), [
      'build',
      resolve('native/f005-guard-tests/F005Guard.CorrelationTests.csproj'),
      '--configuration',
      'Release',
      '--nologo',
    ], {
      cwd: resolve('.'),
      windowsHide: true,
      env: {
        ...process.env,
        DOTNET_CLI_HOME: resolve('.cache/dotnet-f005/cli-home'),
        DOTNET_NOLOGO: '1',
        NUGET_PACKAGES: resolve('.cache/dotnet-f005/nuget'),
      },
    });
    const child = spawn(executable, ['--target', 'CHG-F005-036/T-110'], {
      cwd: resolve('.'),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    const lines = stdout.trim().split(/\r?\n/u);
    const caseLines = lines.filter((line) => line.startsWith(CASE_PREFIX));
    const resultLines = lines.filter((line) => line.startsWith(RESULT_PREFIX));
    const unknown = lines.filter(
      (line) => !line.startsWith(CASE_PREFIX) && !line.startsWith(RESULT_PREFIX),
    );
    const cases = caseLines.map((line) => decodeMarker<{
      readonly caseId: string;
      readonly result: string;
    }>(line.slice(CASE_PREFIX.length)));
    const result = decodeMarker<TargetResult>(
      resultLines[0]!.slice(RESULT_PREFIX.length),
    );

    expect({ exitCode, stderr, unknown }).toEqual({ exitCode: 0, stderr: '', unknown: [] });
    expect(manifest).toMatchObject({
      schemaVersion: '1.0.0',
      targetId: 'CHG-F005-036/T-110',
    });
    expect(manifest.cases).toHaveLength(57);
    expect(new Set(manifest.cases).size).toBe(57);
    expect(resultLines).toHaveLength(1);
    expect(cases.map((item) => item.caseId)).toEqual(manifest.cases);
    expect(cases.every((item) => item.result === 'pass')).toBe(true);
    expect(result).toMatchObject({
      targetId: manifest.targetId,
      result: 'pass',
      expectedCaseCount: 57,
      passedCaseCount: 57,
      caseManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      runtime: {
        ProductionAssemblySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        ProductionAssemblyMvid: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        TestAssemblySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        TestAssemblyMvid: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        TestExecutableSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        DotnetRuntime: expect.stringMatching(/^9\.0\./u),
      },
    });
    for (const rawSentinel of [
      'pid=424242', 'qpc=9223372036854775000', 'fileObject=0xDEADBEEF',
      'volume:private', 'handle=0xFEEDFACE', 'C:\\private\\audio.wav',
    ]) expect(stdout).not.toContain(rawSentinel);
  }, 120_000);
});
