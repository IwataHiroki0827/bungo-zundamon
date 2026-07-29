import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  createF005Manifest,
  F005_ACCEPTANCE_EVIDENCE_PATH,
  F005_LOADER_TEST_EVIDENCE_PATH,
  F005_MANIFEST_PATH,
  F005_MIGRATION_EVIDENCE_PATH,
  F005_REQUIREMENT_APPROVAL_SNAPSHOT,
  loadVerifiedF005Definition,
  type F005ApprovedBatchContext,
  type F005VerifiedApprovalBindingPolicy,
  type IntegratedRegistryAcceptanceV1,
  type IntegratedRegistryEvidenceV1,
  type VerifiedImplementationRegistryControl,
} from './f005-context.ts';
import * as internalContextApi from './f005-context-internal.ts';
import * as publicContextApi from './f005-context.ts';

const execFile = promisify(execFileCallback);
const sourceWorkspace = resolve('.');
const temporaryRoots: string[] = [];

async function git(workspace: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

interface PrivateCliPayload {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

async function runPrivateTestCli<T>(
  workspace: string,
  command: 'policy' | 'migrate' | 'accept' | 'control',
): Promise<T> {
  const modulePath = resolve(
    sourceWorkspace,
    'src/content/f005-context-internal.ts',
  );
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFile(
      process.execPath,
      ['--experimental-transform-types', modulePath, command, workspace],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          NODE_NO_WARNINGS: '1',
        },
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const processError = error as {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly message?: string;
    };
    stdout = processError.stdout ?? '';
    stderr = processError.stderr ?? processError.message ?? '';
  }
  let payload: PrivateCliPayload;
  try {
    payload = JSON.parse(stdout) as PrivateCliPayload;
  } catch {
    throw new Error(`F005 private test CLIの応答が不正です: ${stderr}`);
  }
  if (!payload.ok || payload.value === undefined) {
    throw Object.assign(
      new Error(payload.error?.message ?? 'F005 private test CLIが失敗しました'),
      { code: payload.error?.code ?? 'UNEXPECTED' },
    );
  }
  return payload.value as T;
}

function loadVerifiedF005ApprovalBindingPolicy(
  workspace: string,
): Promise<F005VerifiedApprovalBindingPolicy> {
  return runPrivateTestCli(workspace, 'policy');
}

function migrateF005CandidateRegistry(
  workspace: string,
): Promise<IntegratedRegistryEvidenceV1> {
  return runPrivateTestCli(workspace, 'migrate');
}

function acceptIntegratedF005Registry(
  workspace: string,
): Promise<IntegratedRegistryAcceptanceV1> {
  return runPrivateTestCli(workspace, 'accept');
}

function loadVerifiedF005RegistryControl(
  workspace: string,
): Promise<VerifiedImplementationRegistryControl> {
  return runPrivateTestCli(workspace, 'control');
}

async function cloneFixture(): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'bungo-f005-context-'));
  temporaryRoots.push(temporary);
  const workspace = join(temporary, 'repo');
  await execFile('git', [
    '-c',
    'core.autocrlf=false',
    'clone',
    '--quiet',
    '--shared',
    sourceWorkspace,
    workspace,
  ], {
    windowsHide: true,
  });
  await git(workspace, 'config', 'user.name', 'F005 Context Test');
  await git(workspace, 'config', 'user.email', 'f005-context@example.invalid');
  return workspace;
}

async function installImplementation(
  workspace: string,
  options: {
    readonly integrateRegistry?: boolean;
    readonly projectionDrift?: boolean;
  } = {},
): Promise<string> {
  if (options.integrateRegistry !== false) {
    const oldRegistry = JSON.parse(
      await readFile(join(workspace, 'content', 'batch-candidates.json'), 'utf8'),
    ) as { schemaVersion: '1.0.0'; candidates: unknown[] };
    const dedicated = JSON.parse(
      await readFile(join(workspace, 'content', 'batch-candidates', 'F005.json'), 'utf8'),
    ) as { schemaVersion: '1.0.0'; candidates: unknown[] };
    const candidates = structuredClone([
      ...oldRegistry.candidates,
      ...dedicated.candidates,
    ]);
    if (options.projectionDrift === true) {
      const first = candidates[0] as {
        works?: Array<{ title?: string }>;
      } | undefined;
      if (!first?.works?.[0]) {
        throw new Error('F003 fixture candidateがありません');
      }
      first.works[0].title = `${first.works[0].title ?? ''}（改ざん）`;
    }
    await writeFile(
      join(workspace, 'content', 'batch-candidates.json'),
      canonicalJson({
        schemaVersion: '1.0.0',
        candidates,
      }),
      'utf8',
    );
  }
  await copyFile(
    resolve(sourceWorkspace, 'src/content/f005-context.ts'),
    join(workspace, 'src', 'content', 'f005-context.ts'),
  );
  await copyFile(
    resolve(sourceWorkspace, 'src/content/f005-context-internal.ts'),
    join(workspace, 'src', 'content', 'f005-context-internal.ts'),
  );
  await copyFile(
    resolve(sourceWorkspace, 'src/content/batch-candidate.ts'),
    join(workspace, 'src', 'content', 'batch-candidate.ts'),
  );
  await git(
    workspace,
    'add',
    'src/content/f005-context.ts',
    'src/content/f005-context-internal.ts',
    'src/content/batch-candidate.ts',
    'content/batch-candidates.json',
  );
  await git(workspace, 'commit', '-m', 'test: F005 implementation');
  return git(workspace, 'rev-parse', 'HEAD');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function commitSpecialControlEntry(
  workspace: string,
  kind: 'executable' | 'symlink' | 'submodule' | 'rename',
): Promise<void> {
  await migrateF005CandidateRegistry(workspace);
  await git(workspace, 'add', F005_MIGRATION_EVIDENCE_PATH);
  if (kind === 'executable') {
    await git(workspace, 'update-index', '--chmod=+x', F005_MIGRATION_EVIDENCE_PATH);
  } else if (kind === 'rename') {
    await git(
      workspace,
      'mv',
      F005_MIGRATION_EVIDENCE_PATH,
      `${F005_MIGRATION_EVIDENCE_PATH}.renamed`,
    );
  } else {
    const objectSource = join(workspace, '.git', `f005-${kind}-object`);
    await writeFile(
      objectSource,
      kind === 'symlink' ? 'migration-target.json' : await git(workspace, 'rev-parse', 'HEAD'),
      'utf8',
    );
    const objectId = kind === 'symlink'
      ? await git(workspace, 'hash-object', '-w', objectSource)
      : await git(workspace, 'rev-parse', 'HEAD');
    const mode = kind === 'symlink' ? '120000' : '160000';
    await git(
      workspace,
      'update-index',
      '--add',
      '--cacheinfo',
      `${mode},${objectId},${F005_MIGRATION_EVIDENCE_PATH}`,
    );
  }
  await git(workspace, 'commit', '-m', `test: reject ${kind} control entry`);
  await git(workspace, 'reset', '--hard', 'HEAD');
}

async function commitControl(workspace: string, extraPath?: string): Promise<string> {
  await migrateF005CandidateRegistry(workspace);
  await git(workspace, 'add', F005_MIGRATION_EVIDENCE_PATH);
  if (extraPath) {
    await writeFile(join(workspace, extraPath), 'extra\n', 'utf8');
    await git(workspace, 'add', extraPath);
  }
  await git(workspace, 'commit', '-m', 'test: F005 migration control');
  return git(workspace, 'rev-parse', 'HEAD');
}

async function commitAcceptance(workspace: string, extraPath?: string): Promise<string> {
  await acceptIntegratedF005Registry(workspace);
  await git(
    workspace,
    'add',
    F005_ACCEPTANCE_EVIDENCE_PATH,
    F005_LOADER_TEST_EVIDENCE_PATH,
  );
  if (extraPath) {
    await writeFile(join(workspace, extraPath), 'extra\n', 'utf8');
    await git(workspace, 'add', extraPath);
  }
  await git(workspace, 'commit', '-m', 'test: F005 registry acceptance');
  return git(workspace, 'rev-parse', 'HEAD');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })),
  );
});

describe('F005 approved context and registry migration', () => {
  it('production/internal直接importの双方にprivate APIを露出しない', async () => {
    const privateNames = [
      'migrateF005CandidateRegistry',
      'acceptIntegratedF005Registry',
      'loadVerifiedF005RegistryControl',
      'loadVerifiedF005ApprovalBindingPolicy',
    ] as const;
    for (const name of privateNames) {
      expect(publicContextApi).not.toHaveProperty(name);
      expect(internalContextApi).not.toHaveProperty(name);
    }
    const source = await readFile(
      resolve(sourceWorkspace, 'src/content/f005-context-internal.ts'),
      'utf8',
    );
    for (const name of privateNames) {
      expect(source).not.toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'u'));
      expect(source).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`, 'su'));
    }
    const productionImport = await execFile(
      process.execPath,
      [
        '--experimental-transform-types',
        '--input-type=module',
        '--eval',
        [
          'const module = await import(process.argv[1]);',
          `const names = ${JSON.stringify(privateNames)};`,
          'process.stdout.write(JSON.stringify(names.map((name) => Object.hasOwn(module, name))));',
        ].join(''),
        pathToFileURL(resolve(
          sourceWorkspace,
          'src/content/f005-context-internal.ts',
        )).href,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production', NODE_NO_WARNINGS: '1' },
        windowsHide: true,
      },
    );
    expect(JSON.parse(productionImport.stdout)).toEqual([false, false, false, false]);
  });

  it('private test CLIをNODE_ENV=test以外では実行できない', async () => {
    await expect(execFile(
      process.execPath,
      [
        '--experimental-transform-types',
        resolve(sourceWorkspace, 'src/content/f005-context-internal.ts'),
        'policy',
        sourceWorkspace,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
        windowsHide: true,
      },
    )).rejects.toMatchObject({
      stderr: expect.stringContaining('NODE_ENV=test'),
    });
  });

  /** @des DES-F005-001 @des DES-F005-012 @fun FUN-F005-045 @test UT-F005-045 */
  it('固定approval snapshotのcanonical artifactからだけrequirement policyをmintする', async () => {
    const policy = await loadVerifiedF005ApprovalBindingPolicy(sourceWorkspace);

    expect(policy).toMatchObject({
      __brand: 'VerifiedApprovalBindingPolicy',
      requirementApprovalSnapshot: F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    });
    expect(Object.keys(policy.artifactSha256s)).toHaveLength(8);
  });

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('implementation→control→acceptanceのexact差分後だけproduction controlをmintする', async () => {
    const workspace = await cloneFixture();
    const implementationCommit = await installImplementation(workspace);
    const migration = await migrateF005CandidateRegistry(workspace);
    expect(migration.implementationCommit).toBe(implementationCommit);
    expect(migration.priorCandidateProjectionSha256.map((entry) => entry.feature))
      .toEqual(['F003', 'F004']);

    await git(workspace, 'add', F005_MIGRATION_EVIDENCE_PATH);
    await git(workspace, 'commit', '-m', 'test: F005 migration control');
    const controlCommit = await git(workspace, 'rev-parse', 'HEAD');

    const acceptance = await acceptIntegratedF005Registry(workspace);
    expect(acceptance).toMatchObject({
      controlCommit,
      testedFeatures: ['F003', 'F004', 'F005'],
    });
    await git(
      workspace,
      'add',
      F005_ACCEPTANCE_EVIDENCE_PATH,
      F005_LOADER_TEST_EVIDENCE_PATH,
    );
    await git(workspace, 'commit', '-m', 'test: F005 registry acceptance');
    const acceptanceCommit = await git(workspace, 'rev-parse', 'HEAD');

    const control = await loadVerifiedF005RegistryControl(workspace);
    expect(control).toMatchObject({
      __brand: 'VerifiedImplementationRegistryControl',
      acceptanceCommit,
      controlCommit,
      implementationCommit,
    });
    const context = await loadVerifiedF005Definition(workspace);
    expect(context.candidate.works.map((work) => work.workId))
      .toEqual(['000799', '001076', '001104']);
    expect(context.definition.author).toMatchObject({
      authorId: '000148',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
    });

    const first = await createF005Manifest(workspace, context, context.candidate.author);
    const second = await createF005Manifest(workspace, context, context.candidate.author);
    expect(second).toEqual(first);
    expect(first.workProgress.map((work) => work.status))
      .toEqual(['pending', 'pending', 'pending']);
    expect(await readFile(join(workspace, ...F005_MANIFEST_PATH.split('/')), 'utf8'))
      .toBe(canonicalJson(first));

    await writeFile(
      join(workspace, ...F005_MANIFEST_PATH.split('/')),
      canonicalJson({ ...first, schemaVersion: 'tampered' }),
      'utf8',
    );
    await expect(createF005Manifest(workspace, context, context.candidate.author))
      .rejects.toMatchObject({ code: 'F005_MANIFEST_CONFLICT' });
  }, 120_000);

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('old registryのままのimplementation commitを拒否する', async () => {
    const workspace = await cloneFixture();
    await installImplementation(workspace, { integrateRegistry: false });

    await expect(migrateF005CandidateRegistry(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_MIGRATION_INVALID' });
  }, 120_000);

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('F003 canonical projection driftをprecontrolで拒否する', async () => {
    const workspace = await cloneFixture();
    await installImplementation(workspace, { projectionDrift: true });

    await expect(migrateF005CandidateRegistry(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_MIGRATION_INVALID' });
  }, 120_000);

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('sealだけ再計算した偽造migration evidenceを拒否する', async () => {
    const workspace = await cloneFixture();
    await installImplementation(workspace);
    await migrateF005CandidateRegistry(workspace);
    const evidencePath = join(workspace, ...F005_MIGRATION_EVIDENCE_PATH.split('/'));
    const forged = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    const projections = forged.priorCandidateProjectionSha256 as
      Array<Record<string, unknown>>;
    projections[0]!.sha256 = '0'.repeat(64);
    const core = structuredClone(forged);
    delete core.sealSha256;
    forged.sealSha256 = sha256(canonicalJson(core));
    await writeFile(evidencePath, canonicalJson(forged), 'utf8');
    await git(workspace, 'add', F005_MIGRATION_EVIDENCE_PATH);
    await git(workspace, 'commit', '-m', 'test: forged resealed migration evidence');

    await expect(acceptIntegratedF005Registry(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_CONTROL_INVALID' });
  }, 120_000);

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('相互hashとsealを再計算した偽造loader evidenceをproduction再読込で拒否する', async () => {
    const workspace = await cloneFixture();
    await installImplementation(workspace);
    await commitControl(workspace);
    await acceptIntegratedF005Registry(workspace);
    const loaderPath = join(workspace, ...F005_LOADER_TEST_EVIDENCE_PATH.split('/'));
    const acceptancePath = join(workspace, ...F005_ACCEPTANCE_EVIDENCE_PATH.split('/'));
    const loader = JSON.parse(await readFile(loaderPath, 'utf8')) as Record<string, unknown>;
    const tests = loader.tests as Array<Record<string, unknown>>;
    tests[0]!.candidateSha256 = '0'.repeat(64);
    const loaderCore = structuredClone(loader);
    delete loaderCore.sealSha256;
    loader.sealSha256 = sha256(canonicalJson(loaderCore));
    const loaderRaw = canonicalJson(loader);
    await writeFile(loaderPath, loaderRaw, 'utf8');

    const acceptance = JSON.parse(
      await readFile(acceptancePath, 'utf8'),
    ) as Record<string, unknown>;
    acceptance.loaderTestEvidenceSha256 = sha256(loaderRaw);
    const acceptanceCore = structuredClone(acceptance);
    delete acceptanceCore.sealSha256;
    acceptance.sealSha256 = sha256(canonicalJson(acceptanceCore));
    await writeFile(acceptancePath, canonicalJson(acceptance), 'utf8');
    await git(
      workspace,
      'add',
      F005_ACCEPTANCE_EVIDENCE_PATH,
      F005_LOADER_TEST_EVIDENCE_PATH,
    );
    await git(workspace, 'commit', '-m', 'test: forged resealed loader evidence');

    await expect(loadVerifiedF005RegistryControl(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_CONTROL_INVALID' });
  }, 120_000);

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it.each(['executable', 'symlink', 'submodule', 'rename'] as const)(
    'control evidenceのGit tree形態 %s を拒否する',
    async (kind) => {
      const workspace = await cloneFixture();
      await installImplementation(workspace);
      await commitSpecialControlEntry(workspace, kind);

      await expect(acceptIntegratedF005Registry(workspace))
        .rejects.toMatchObject({ code: 'F005_REGISTRY_CONTROL_INVALID' });
    },
    120_000,
  );

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('control commitへのextra source差分を拒否する', async () => {
    const workspace = await cloneFixture();
    await installImplementation(workspace);
    await commitControl(workspace, 'extra-control.txt');

    await expect(acceptIntegratedF005Registry(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_CONTROL_INVALID' });
  }, 120_000);

  /** @des DES-F005-001 @fun FUN-F005-048 @test UT-F005-048 */
  it('acceptance commitへのextra差分とdirty HEADを拒否する', async () => {
    const workspace = await cloneFixture();
    await installImplementation(workspace);
    await commitControl(workspace);
    await commitAcceptance(workspace, 'extra-acceptance.txt');

    await expect(loadVerifiedF005RegistryControl(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_CONTROL_INVALID' });

    await git(workspace, 'reset', '--hard', 'HEAD^');
    await rm(join(workspace, 'extra-acceptance.txt'), { force: true });
    await commitAcceptance(workspace);
    await writeFile(join(workspace, 'dirty.txt'), 'dirty\n', 'utf8');
    await expect(loadVerifiedF005RegistryControl(workspace))
      .rejects.toMatchObject({ code: 'F005_REGISTRY_CONTROL_INVALID' });
  }, 120_000);

  /** @des DES-F005-002 @fun FUN-F005-005 @test UT-F005-005 */
  it('callerが偽造したcontextからmanifestを作らない', async () => {
    const workspace = await cloneFixture();
    const forged = {
      __brand: 'ApprovedBatchContext',
      candidate: { author: {} },
    } as unknown as F005ApprovedBatchContext;

    await expect(createF005Manifest(
      workspace,
      forged,
      {
        authorId: '000148',
        identitySha256:
          '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f' as Sha256,
        name: 'なつめそうせき',
        originalName: '夏目漱石',
        slug: 'natsume-soseki',
      },
    )).rejects.toMatchObject({ code: 'F005_CONTEXT_INVALID' });
  }, 120_000);
});
