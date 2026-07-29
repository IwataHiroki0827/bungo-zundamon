import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
    const workflow = parse(raw) as HostedWorkflow;
    const job = workflow.jobs['produce-candidate'];
    const scripts = job.steps.flatMap((step) => step.run ? [step.run] : []).join('\n');
    const actions = job.steps.flatMap((step) => step.uses ? [step.uses] : []);
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const persist = job.steps.find((step) => step.name === 'Validate and persist isolated candidate');

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
    expect(persist?.env).toEqual({ GITHUB_PUSH_TOKEN: '${{ github.token }}' });
    expect(scripts).toContain('voicevox_engine-windows-cpu-0.25.2.7z.001');
    expect(scripts).toContain('2ab86e4bf29448e3317ee97327efb3211c4ecc1063b03a62ab72b15a92ec531d');
    expect(scripts).toContain('$drive.Free -lt 10GB');
    expect(scripts).toContain('$drive.Free -lt 5GB');
    expect(scripts).toContain("Remove-Item -LiteralPath $archive");
    expect(scripts).toContain("'127.0.0.1'");
    expect(scripts).toContain('--work 000799');
    expect(scripts).toContain("F005_RESULT_JSON=");
    expect(scripts).toContain('$resultLines.Count -ne 1');
    expect(scripts).toContain("git diff --exit-code -- public");
    expect(scripts).toContain('candidate/f005-t070-$env:GITHUB_SHA');
    expect(scripts).toContain('http.https://github.com/.extraheader=');
    expect(scripts).toContain('accepted WAV count mismatch');
    expect(scripts).toContain('allowlist-external path');
    expect(raw).not.toMatch(/\bdeploy-pages\b|\bpages:\s*write\b|\bid-token:\s*write\b/u);
    expect(raw).not.toMatch(/\bworkflow_dispatch\b|\bschedule:\b|\bsecrets:\b/u);
  });
});
