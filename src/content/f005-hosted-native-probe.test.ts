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
const T122_CASE_PREFIX = 'F005_T122_CASE_BASE64=';
const T122_RESULT_PREFIX = 'F005_T122_RESULT_BASE64=';
const execFileAsync = promisify(execFile);

function decodeMarker<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T;
}

describe('F005 hosted native correlation [CHG-F005-052 CHG-F005-053]', () => {
  it('workflow全体をread-onlyに固定しcredential・push・artifactを持たない', async () => {
    const raw = await readFile(
      resolve('.github/workflows/f005-hosted-native-probe.yml'),
      'utf8',
    );
    const [selectorRaw, manifestRaw] = await Promise.all([
      readFile(resolve('native/f005-guard-tests/hosted-target-selector.json'), 'utf8'),
      readFile(resolve('native/f005-guard-tests/t122-case-manifest.json'), 'utf8'),
    ]);
    const workflow = parse(raw) as ProbeWorkflow;
    const selector = JSON.parse(selectorRaw) as Readonly<Record<string, string>>;
    const manifest = JSON.parse(manifestRaw) as TargetManifest;
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
    expect(selector).toEqual({
      schemaVersion: '1.0.0',
      selectedTargetId: 'CHG-F005-048/T-122',
      kind: 'f005-t122-hosted-correlation',
      manifestPath: 'native/f005-guard-tests/t122-case-manifest.json',
      testSourcePath: 'native/f005-guard-tests/T122TargetSuite.cs',
      caseMarkerPrefix: T122_CASE_PREFIX,
      resultMarkerPrefix: T122_RESULT_PREFIX,
    });
    expect(manifest.targetId).toBe(selector.selectedTargetId);
    expect(scripts).toContain('F005_T122_CASE_BASE64=');
    expect(scripts).toContain('F005_T122_RESULT_BASE64=');
    expect(scripts).toContain('F005_T122_EVIDENCE_BASE64=');
    expect(scripts).toContain('(Get-Item -LiteralPath $stdout).Length -gt 65536');
    expect(scripts).toContain('(Get-Item -LiteralPath $stderr).Length -gt 65536');
    expect(scripts).toContain('F005_T122_TARGET_UNKNOWN_LINE');
    expect(scripts).toContain('F005_T122_TARGET_RESULT_CARDINALITY');
    expect(scripts).toContain("@('public', 'data', 'candidate', 'audio', 'staging')");
    expect(scripts).toContain('candidate/f005-t070-$env:GITHUB_SHA');
    expect(scripts).toContain('actions/workflows/pages.yml/runs?event=push&head_sha=');
    expect(scripts).toContain("$deploy[0].conclusion -cne 'skipped'");
    expect(scripts).toContain('sourceSha256 = $hashes');
    expect(scripts).toContain("selector = $selectorPath");
    expect(scripts).toContain('caseManifest = $selector.manifestPath');
    expect(scripts).toContain('foreach ($item in ([ordered]@{');
    expect(scripts).toContain('}).GetEnumerator()) {');
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

  it('T-122 targetがproduction lookup/recheck規則と3呼出箇所を直接固定する', async () => {
    const [production, target, harness, manifestRaw] = await Promise.all([
      readFile(resolve('native/f005-guard/Program.cs'), 'utf8'),
      readFile(resolve('native/f005-guard-tests/T122TargetSuite.cs'), 'utf8'),
      readFile(resolve('native/f005-guard-tests/Program.cs'), 'utf8'),
      readFile(resolve('native/f005-guard-tests/t122-case-manifest.json'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestRaw) as TargetManifest;
    const recheck = production.slice(
      production.indexOf('private void RecheckSealedCallbackLocked('),
      production.indexOf('private void RecheckCompletedNoLeaseDirectoryProofLocked('),
    );
    const authorization = production.slice(
      production.indexOf('private bool TryAuthorizeWriteCompletionDrainEventLocked('),
      production.indexOf('private void ObserveProcessIdentityProbeLocked('),
    );
    const shared = production.slice(
      production.indexOf('public static class WriteCompletionDrainRules'),
      production.indexOf('public static class SystemDirectoryWriteRejoinAuthorizationRules'),
    );

    expect(production.match(/WriteCompletionDrainRules\.LookupFailure\(/gu))
      .toHaveLength(2);
    expect(production.match(/WriteCompletionDrainRules\.RecheckSealedFailure\(/gu))
      .toHaveLength(1);
    expect(recheck.indexOf('WriteCompletionDrainRules.RecheckSealedFailure('))
      .toBeLessThan(recheck.indexOf('if (tupleFailure is not null)'));
    expect(recheck.indexOf('if (tupleFailure is not null)'))
      .toBeLessThan(recheck.indexOf('WriteCompletionDrainRules.RecheckIdentityFailure('));
    expect(authorization.match(/WriteCompletionDrainRules\.LookupFailure\(/gu))
      .toHaveLength(2);
    expect(authorization).toContain(
      'if (lookupFailure is not null) throw new GuardException(lookupFailure);',
    );
    expect(authorization.indexOf(
      'if (lookupFailure is not null) throw new GuardException(lookupFailure);',
    )).toBeLessThan(authorization.indexOf('selectedSeal = exact[0];'));
    for (const code of [
      'EVENT_TUPLE_MISMATCH',
      'EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_NO_LATE_PROOF',
      'EVENT_TUPLE_LOOKUP_EXACT_MISSING',
      'EVENT_TUPLE_LOOKUP_EXACT_AMBIGUOUS',
      'EVENT_TUPLE_RECHECK_SEAL_MISSING',
      'EVENT_TUPLE_RECHECK_SEAL_AMBIGUOUS',
      'EVENT_TUPLE_RECHECK_FIELDS',
      'LATE_EVENT_AFTER_SEAL',
    ]) expect(shared).toContain(code);
    expect(target).toContain('WriteCompletionDrainRules.LookupFailure(');
    expect(target).toContain('WriteCompletionDrainRules.RecheckSealedFailure(');
    expect(target).not.toContain('static string? LookupFailure(');
    expect(target).not.toContain('static string? RecheckSealedFailure(');
    expect(harness).toContain(
      '"CHG-F005-048/T-122" => T122TargetSuite.Run(args)',
    );
    expect(production).not.toMatch(/CHG-F005-048\/T-122|F005_T122/u);
    expect(manifest.cases).toHaveLength(43);
    expect(new Set(manifest.cases).size).toBe(43);
    expect(manifest.cases).toContain('lookup-all-zero-pass');
    expect(manifest.cases.filter((item) => item.startsWith('recheck-field-false-')))
      .toHaveLength(11);
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

  it.runIf(process.platform === 'win32')(
    'T-122固定43 case markerとfinal markerをexactに解析する', async () => {
    const manifest = JSON.parse(await readFile(
      resolve('native/f005-guard-tests/t122-case-manifest.json'),
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
    const child = spawn(executable, ['--target', 'CHG-F005-048/T-122'], {
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
    const caseLines = lines.filter((line) => line.startsWith(T122_CASE_PREFIX));
    const resultLines = lines.filter((line) => line.startsWith(T122_RESULT_PREFIX));
    const unknown = lines.filter(
      (line) => !line.startsWith(T122_CASE_PREFIX) &&
        !line.startsWith(T122_RESULT_PREFIX),
    );
    const cases = caseLines.map((line) => decodeMarker<{
      readonly caseId: string;
      readonly result: string;
    }>(line.slice(T122_CASE_PREFIX.length)));
    const result = decodeMarker<TargetResult>(
      resultLines[0]!.slice(T122_RESULT_PREFIX.length),
    );

    expect({ exitCode, stderr, unknown }).toEqual({ exitCode: 0, stderr: '', unknown: [] });
    expect(manifest).toMatchObject({
      schemaVersion: '1.0.0',
      targetId: 'CHG-F005-048/T-122',
    });
    expect(manifest.cases).toHaveLength(43);
    expect(new Set(manifest.cases).size).toBe(43);
    expect(resultLines).toHaveLength(1);
    expect(cases.map((item) => item.caseId)).toEqual(manifest.cases);
    expect(cases.every((item) => item.result === 'pass')).toBe(true);
    expect(result).toMatchObject({
      targetId: manifest.targetId,
      result: 'pass',
      expectedCaseCount: 43,
      passedCaseCount: 43,
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
