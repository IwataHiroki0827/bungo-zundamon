import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { BatchId, Sha256, WorkspaceRelativePath } from './batch.ts';
import {
  createRuntimeAcceptanceEvidence,
  loadRuntimeAcceptanceEvidence,
  validateRuntimeAcceptanceEvidence,
  type RuntimeAcceptanceMeasurements,
} from './runtime-acceptance.ts';

const temporary: string[] = [];
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex') as Sha256;

function fixture(): RuntimeAcceptanceMeasurements {
  const routes = [
    '#/',
    '#/authors/akutagawa-zunnosuke',
    '#/authors/miyazawa-zunji',
    '#/authors/dazai-osamu',
    '#/credits',
  ];
  return {
    batchId: 'F003' as BatchId,
    sourceCommit: 'a'.repeat(40),
    contentBuildSha256: hash('content'),
    distSha256: hash('dist'),
    routes,
    browsers: ['chromium', 'firefox', 'webkit', 'android-equivalent'],
    viewports: ['390x844', '768x1024', '1440x900'],
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
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('FUN-F003-026 RuntimeAcceptance [UT-F003-026][IT-F003-011]', () => {
  it('5 route・4 browser・3 viewport・初期全閉・security 0をhashへ固定する', () => {
    const evidence = createRuntimeAcceptanceEvidence(fixture());
    expect(evidence).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'runtime-acceptance',
      batchId: 'F003',
      result: 'pass',
      reducedMotion: true,
      keyboardExpandable: true,
      security: { status: 'pass' },
    });
    expect(evidence.routes).toHaveLength(5);
    expect(evidence.evidenceSha256).toHaveLength(64);
    expect(validateRuntimeAcceptanceEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  });

  it.each([
    ['route欠落', (value: RuntimeAcceptanceMeasurements) => ({ ...value, routes: value.routes.slice(1) })],
    ['browser欠落', (value: RuntimeAcceptanceMeasurements) => ({ ...value, browsers: value.browsers.slice(1) })],
    ['viewport重複', (value: RuntimeAcceptanceMeasurements) => ({ ...value, viewports: ['390x844', '390x844', '1440x900'] })],
    ['初期open', (value: RuntimeAcceptanceMeasurements) => ({
      ...value,
      initialOpenPanels: { ...value.initialOpenPanels, '#/authors/dazai-osamu': 1 },
    })],
    ['keyboard不能', (value: RuntimeAcceptanceMeasurements) => ({ ...value, keyboardExpandable: false })],
    ['外部通信', (value: RuntimeAcceptanceMeasurements) => ({
      ...value,
      security: { ...value.security, externalRequests: 1 },
    })],
  ])('%sをPASSへ格上げしない', (_label, mutate) => {
    expect(() => createRuntimeAcceptanceEvidence(mutate(fixture()))).toThrow();
  });

  it('unknown key・route/hash・evidence hash改変を拒否する', () => {
    const evidence = createRuntimeAcceptanceEvidence(fixture());
    for (const mutate of [
      (value: Record<string, unknown>) => { value.unknown = true; },
      (value: Record<string, unknown>) => { value.routeSetSha256 = hash('other'); },
      (value: Record<string, unknown>) => { value.evidenceSha256 = hash('other'); },
    ]) {
      const value = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
      mutate(value);
      expect(() => validateRuntimeAcceptanceEvidence(value)).toThrow();
    }
  });

  it('canonical原artifactのpath・実体SHA・内部hashを再検証する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'runtime-acceptance-'));
    temporary.push(workspace);
    const path = 'docs/evidence/qt/runtime-acceptance.json' as WorkspaceRelativePath;
    const target = join(workspace, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const evidence = createRuntimeAcceptanceEvidence(fixture());
    const bytes = new TextEncoder().encode(canonicalJson(evidence));
    await writeFile(target, bytes);
    await expect(loadRuntimeAcceptanceEvidence(workspace, path, hash(bytes))).resolves.toEqual(evidence);
    await expect(loadRuntimeAcceptanceEvidence(workspace, path, hash('other'))).rejects.toThrow();

    const external = await mkdtemp(join(tmpdir(), 'runtime-acceptance-external-'));
    temporary.push(external);
    const link = join(workspace, 'linked');
    try {
      await symlink(external, link, 'junction');
      await expect(loadRuntimeAcceptanceEvidence(
        workspace,
        'linked/evidence.json' as WorkspaceRelativePath,
        hash(bytes),
      )).rejects.toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });
});
