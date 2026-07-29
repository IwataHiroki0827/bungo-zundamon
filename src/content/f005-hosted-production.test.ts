import { execFile, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);

interface HostedWorkflow {
  readonly on: {
    readonly push: {
      readonly branches: readonly string[];
      readonly paths: readonly string[];
    };
  };
  readonly permissions: { readonly contents: string };
  readonly jobs: {
    readonly 'produce-candidate': {
      readonly if: string;
      readonly permissions: { readonly contents: string };
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

describe('F005 hosted production candidate workflow [UT-F005-047]', () => {
  it('固定source・最小権限・容量guard・候補branchだけで夢十夜を生成する', async () => {
    const path = resolve('.github/workflows/f005-hosted-production.yml');
    const raw = await readFile(path, 'utf8');
    const attributes = await readFile(resolve('.gitattributes'), 'utf8');
    const workflow = parse(raw) as HostedWorkflow;
    const job = workflow.jobs['produce-candidate'];
    const scripts = job.steps.flatMap((step) => step.run ? [step.run] : []).join('\n');
    const actions = job.steps.flatMap((step) => step.uses ? [step.uses] : []);
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const persist = job.steps.find((step) => step.name === 'Validate and persist isolated candidate');
    const production = job.steps.find((step) => step.name === 'Run T-070 production pipeline');

    expect(workflow.on.push).toEqual({
      branches: ['feature/F005'],
      paths: ['.github/workflows/f005-hosted-production.yml'],
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'write' });
    expect(job.if).toContain("github.ref == 'refs/heads/feature/F005'");
    expect(actions).toEqual([
      'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    ]);
    expect(actions.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(persist?.env).toEqual({
      GITHUB_PUSH_TOKEN: '${{ github.token }}',
      F005_ENGINE_CACHE_ROOT: '${{ steps.engine.outputs.cache_root }}',
    });
    expect(scripts).toContain('voicevox_engine-windows-cpu-0.25.2.7z.001');
    expect(scripts).toContain('2ab86e4bf29448e3317ee97327efb3211c4ecc1063b03a62ab72b15a92ec531d');
    expect(scripts).toContain('$drive.Free -lt 10GB');
    expect(scripts).toContain('$drive.Free -lt 5GB');
    expect(scripts).toContain("Remove-Item -LiteralPath $archive");
    expect(scripts).toContain('[IO.Path]::GetFullPath($env:RUNNER_TEMP)');
    expect(scripts).not.toContain("Join-Path $PWD '.cache\\voicevox-hosted'");
    expect(scripts).toContain('VOICEVOX cache must stay outside the guarded workspace');
    expect(production?.env?.F005_ENGINE_CACHE_ROOT)
      .toBe('${{ steps.engine.outputs.cache_root }}');
    expect(production?.run).not.toContain("Join-Path $PWD '.cache\\f005-hosted-production");
    expect(production?.run).toContain(
      "Join-Path $logRoot 'f005-hosted-production-result.json'",
    );
    expect(persist?.run).toContain(
      "Join-Path $logRoot 'f005-hosted-production-result.json'",
    );
    expect(scripts).toContain('native build evidence semantic drift');
    expect(scripts).toContain('F005_NATIVE_EVIDENCE_DRIFT_FIELDS_BASE64');
    expect(scripts).toContain('[IO.File]::WriteAllBytes($evidencePath, $expectedBytes)');
    expect(attributes).toContain('*.json text eol=lf');
    expect(attributes).toContain('*.md text eol=lf');
    expect(attributes).toContain('*.yaml text eol=lf');
    expect(attributes).toContain('*.yml text eol=lf');
    expect(attributes).toContain('public/.nojekyll text eol=lf');
    expect(attributes).toContain('native/f005-guard/** text eol=lf');
    expect(scripts).toContain("'127.0.0.1'");
    expect(scripts).toMatch(/'--work',\s*'000799'/u);
    expect(scripts).toContain('git ls-remote --heads origin');
    expect(scripts).not.toContain('git ls-remote --exit-code');
    expect(scripts).toContain("F005_RESULT_JSON=");
    expect(scripts).toContain('F005_RUNNER_STDERR_BASE64');
    expect(scripts).toContain('function Write-SafeFailureAnnotation');
    expect(scripts).toContain('::error title=F005 production diagnostic::');
    expect(scripts).toContain(
      "'^F005_(?:PROGRESS|VOICE_PROGRESS)=[a-z0-9-]+$'",
    );
    expect(scripts).toContain(
      "'^F005_NATIVE_START_FAILURE=[A-Z0-9_]+$'",
    );
    expect(scripts).toContain("'^[A-Z][A-Z0-9_]{0,127}$'");
    expect(scripts).not.toContain('$failure.frames');
    expect(scripts).toContain('$limit = 65536');
    expect(scripts.match(/F005_RUNNER_STDOUT_BASE64/gu)).toHaveLength(3);
    expect(scripts).toContain('$runnerProcess = Start-Process');
    expect(scripts).toContain('$runnerProcess.ExitCode');
    expect(scripts).not.toContain('$raw = & node');
    expect(job.steps.map((step) => step.name)).not.toContain('Start fixed loopback VOICEVOX ENGINE');
    expect(job.steps.map((step) => step.name)).not.toContain('Stop VOICEVOX ENGINE');
    expect(production?.run).toContain('$engineProcess = Start-Process');
    expect(production?.run?.indexOf('$engineProcess = Start-Process')).toBeLessThan(
      production?.run?.indexOf('$runnerProcess = Start-Process') ?? -1,
    );
    expect(production?.run).toContain('} finally {');
    expect(production?.run).toContain('Stop-Process -Id $engineProcess.Id');
    expect(production?.run).toContain('[Diagnostics.Stopwatch]::StartNew()');
    expect(production?.run).toContain('-ConnectionTimeoutSeconds 2');
    expect(production?.run).toContain('-OperationTimeoutSeconds 2');
    expect(job.steps.map((step) => step.name)).toContain('Verify prepared source remains clean');
    expect(scripts).toContain('F005_PREFLIGHT_STATUS_BASE64');
    expect(scripts).toMatch(/'status',\s*'--porcelain=v1',\s*'--untracked-files=all'/u);
    expect(scripts).toContain('function Invoke-CapturedGit');
    expect(scripts).toContain('$process.ExitCode -ne 0');
    expect(scripts).toContain('$resultLines.Count -ne 1');
    expect(scripts).toContain("git diff --exit-code -- public");
    expect(scripts).toContain('candidate/f005-t070-$env:GITHUB_SHA');
    expect(scripts).toContain('http.https://github.com/.extraheader=');
    expect(scripts).toContain('accepted WAV count mismatch');
    expect(scripts).toContain('allowlist-external path');
    expect(raw).not.toMatch(/\bdeploy-pages\b|\bpages:\s*write\b|\bid-token:\s*write\b/u);
    expect(raw).not.toMatch(/\bworkflow_dispatch\b|\bschedule:\b|\bsecrets:\b/u);
  });

  it.runIf(process.platform === 'win32')(
    '応答停止したprobeもdeadline後にfinallyでengine processを停止する',
    async () => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('stall server address missing');
        }
        const sleeperPayload = Buffer.from('Start-Sleep -Seconds 30', 'utf16le').toString('base64');
        const script = [
          "$ErrorActionPreference = 'Stop'",
          `$engineProcess = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${sleeperPayload}') -WindowStyle Hidden -PassThru`,
          '$probeDeadlineSeconds = 3',
          '$probeTimer = [Diagnostics.Stopwatch]::StartNew()',
          'try {',
          '  while ($probeTimer.Elapsed.TotalSeconds -lt $probeDeadlineSeconds) {',
          '    try {',
          `      Invoke-RestMethod -Uri 'http://127.0.0.1:${String(address.port)}/version' -ConnectionTimeoutSeconds 1 -OperationTimeoutSeconds 1 | Out-Null`,
          '      break',
          '    } catch {',
          '      if ($probeTimer.Elapsed.TotalSeconds -lt $probeDeadlineSeconds) {',
          '        Start-Sleep -Milliseconds 100',
          '      }',
          '    }',
          '  }',
          '} finally {',
          '  if (-not $engineProcess.HasExited) {',
          '    Stop-Process -Id $engineProcess.Id -Force',
          '  }',
          '}',
          'if (-not $engineProcess.WaitForExit(5000)) { exit 9 }',
        ].join('\n');
        const payload = Buffer.from(script, 'utf16le').toString('base64');
        const startedAt = Date.now();
        await execFileAsync(
          'pwsh',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', payload],
          { timeout: 10_000, windowsHide: true },
        );
        expect(Date.now() - startedAt).toBeLessThan(8_000);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'ErrorActionPreference StopでもStart-Processからnative非0終了値を回収する',
    () => {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$stdoutPath = [IO.Path]::GetTempFileName()",
        "$stderrPath = [IO.Path]::GetTempFileName()",
        'try {',
        "  $payload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('exit 7'))",
        '  $process = Start-Process -FilePath (Get-Command pwsh).Source `',
        "    -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $payload) `",
        '    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath `',
        '    -Wait -PassThru',
        '  $stopped = $false',
        '  try {',
        "    if ($process.ExitCode -ne 0) { throw \"captured nonzero: $($process.ExitCode)\" }",
        '  } catch {',
        '    $stopped = $true',
        '  }',
        "  if (-not $stopped) { throw 'native nonzero was not stopped' }",
        '} finally {',
        '  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue',
        '}',
      ].join('\n');
      expect(() => execFileSync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: 'pipe' },
      )).not.toThrow();
    },
  );
});
