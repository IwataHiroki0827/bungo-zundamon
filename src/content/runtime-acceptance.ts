import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import type { BatchId, Sha256, WorkspaceRelativePath } from './batch.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const AUTHOR_ROUTE = /^#\/authors\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const REQUIRED_RUNTIME_BROWSERS = [
  'chromium',
  'firefox',
  'webkit',
  'android-equivalent',
] as const;

export const REQUIRED_RUNTIME_VIEWPORTS = [
  '390x844',
  '844x390',
  '1440x900',
] as const;

export interface RuntimeSecurityMeasurements {
  readonly cspViolations: number;
  readonly externalRequests: number;
  readonly unsafeDomSinks: number;
  readonly storageOrForms: number;
  readonly secrets: number;
  readonly dependencyHighOrCritical: number;
  readonly workflowViolations: number;
}

export interface RuntimeAcceptanceMeasurements {
  readonly batchId: BatchId;
  readonly sourceCommit: string;
  readonly contentBuildSha256: Sha256;
  readonly distSha256: Sha256;
  readonly routes: readonly string[];
  readonly browsers: readonly string[];
  readonly viewports: readonly string[];
  readonly reducedMotion: boolean;
  readonly initialOpenPanels: Readonly<Record<string, number>>;
  readonly keyboardExpandable: boolean;
  readonly security: RuntimeSecurityMeasurements;
}

interface RuntimeAcceptanceCore {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'runtime-acceptance';
  readonly batchId: BatchId;
  readonly sourceCommit: string;
  readonly contentBuildSha256: Sha256;
  readonly distSha256: Sha256;
  readonly routes: readonly string[];
  readonly routeSetSha256: Sha256;
  readonly browsers: readonly string[];
  readonly viewports: readonly string[];
  readonly reducedMotion: true;
  readonly initialOpenPanels: Readonly<Record<string, 0>>;
  readonly keyboardExpandable: true;
  readonly security: RuntimeSecurityMeasurements & { readonly status: 'pass' };
  readonly result: 'pass';
}

export interface RuntimeAcceptanceEvidence extends RuntimeAcceptanceCore {
  readonly evidenceSha256: Sha256;
}

export class RuntimeAcceptanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeAcceptanceError';
  }
}

function fail(code: string, message: string): never {
  throw new RuntimeAcceptanceError(code, message);
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return canonicalJson(actual) === canonicalJson(expected);
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...values].sort((left, right) => left.localeCompare(right, 'en'));
  return new Set(actual).size === expected.length &&
    canonicalJson(normalize(actual)) === canonicalJson(normalize(expected));
}

function validRoute(value: string): boolean {
  return value === '#/' || value === '#/credits' || AUTHOR_ROUTE.test(value);
}

function canonicalRoutes(routes: readonly string[]): readonly string[] {
  if (routes.length < 3 || new Set(routes).size !== routes.length || routes.some((route) => !validRoute(route))) {
    return fail('RUNTIME_ROUTE_SET_INVALID', 'route集合が不正です');
  }
  return [...routes].sort((left, right) => left.localeCompare(right, 'en'));
}

function validateSecurity(value: unknown): RuntimeSecurityMeasurements {
  const keys = [
    'cspViolations',
    'externalRequests',
    'unsafeDomSinks',
    'storageOrForms',
    'secrets',
    'dependencyHighOrCritical',
    'workflowViolations',
  ];
  if (!isRecord(value) || !exactKeys(value, keys) ||
    keys.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) !== 0)) {
    return fail('RUNTIME_SECURITY_BLOCKED', 'runtime securityに未解決項目があります');
  }
  return value as unknown as RuntimeSecurityMeasurements;
}

/** @des DES-F003-011 @fun FUN-F003-026 */
export function createRuntimeAcceptanceEvidence(
  measurements: RuntimeAcceptanceMeasurements,
): RuntimeAcceptanceEvidence {
  const routes = canonicalRoutes(measurements.routes);
  if (!COMMIT.test(measurements.sourceCommit) || !SHA256.test(measurements.contentBuildSha256) ||
    !SHA256.test(measurements.distSha256)) {
    return fail('RUNTIME_CANDIDATE_TUPLE_INVALID', 'candidate tupleが不正です');
  }
  if (!exactSet(measurements.browsers, REQUIRED_RUNTIME_BROWSERS) ||
    !exactSet(measurements.viewports, REQUIRED_RUNTIME_VIEWPORTS) ||
    measurements.reducedMotion !== true || measurements.keyboardExpandable !== true) {
    return fail('RUNTIME_BROWSER_MATRIX_INCOMPLETE', 'browser・viewport・操作証跡が不足しています');
  }
  if (!isRecord(measurements.initialOpenPanels) ||
    !exactKeys(measurements.initialOpenPanels as Record<string, unknown>, routes) ||
    routes.some((route) => measurements.initialOpenPanels[route] !== 0)) {
    return fail('RUNTIME_INITIAL_OPEN_PANEL', '全routeの初期表示が全閉ではありません');
  }
  const security = validateSecurity(measurements.security);
  const core: RuntimeAcceptanceCore = {
    schemaVersion: '1.0.0',
    kind: 'runtime-acceptance',
    batchId: measurements.batchId,
    sourceCommit: measurements.sourceCommit,
    contentBuildSha256: measurements.contentBuildSha256,
    distSha256: measurements.distSha256,
    routes,
    routeSetSha256: sha256(canonicalJson(routes)),
    browsers: [...measurements.browsers].sort((left, right) => left.localeCompare(right, 'en')),
    viewports: [...measurements.viewports].sort((left, right) => left.localeCompare(right, 'en')),
    reducedMotion: true,
    initialOpenPanels: Object.freeze(
      Object.fromEntries(routes.map((route) => [route, 0 as const])) as Record<string, 0>,
    ),
    keyboardExpandable: true,
    security: { ...security, status: 'pass' },
    result: 'pass',
  };
  return Object.freeze({ ...core, evidenceSha256: sha256(canonicalJson(core)) });
}

/** @des DES-F003-011 @fun FUN-F003-026 */
export function validateRuntimeAcceptanceEvidence(value: unknown): RuntimeAcceptanceEvidence {
  const keys = [
    'schemaVersion', 'kind', 'batchId', 'sourceCommit', 'contentBuildSha256', 'distSha256',
    'routes', 'routeSetSha256', 'browsers', 'viewports', 'reducedMotion', 'initialOpenPanels',
    'keyboardExpandable', 'security', 'result', 'evidenceSha256',
  ];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schemaVersion !== '1.0.0' ||
    value.kind !== 'runtime-acceptance' || typeof value.batchId !== 'string' ||
    typeof value.sourceCommit !== 'string' || typeof value.contentBuildSha256 !== 'string' ||
    typeof value.distSha256 !== 'string' || !Array.isArray(value.routes) ||
    !Array.isArray(value.browsers) || !Array.isArray(value.viewports) ||
    !isRecord(value.initialOpenPanels) || !isRecord(value.security)) {
    return fail('RUNTIME_EVIDENCE_SCHEMA_INVALID', 'RuntimeAcceptance schemaが不正です');
  }
  const sourceCommit = value.sourceCommit as string;
  const security = value.security as Record<string, unknown>;
  const { evidenceSha256, ...measurements } = value;
  const recreated = createRuntimeAcceptanceEvidence({
    batchId: measurements.batchId as BatchId,
    sourceCommit,
    contentBuildSha256: measurements.contentBuildSha256 as Sha256,
    distSha256: measurements.distSha256 as Sha256,
    routes: measurements.routes as string[],
    browsers: measurements.browsers as string[],
    viewports: measurements.viewports as string[],
    reducedMotion: measurements.reducedMotion as boolean,
    initialOpenPanels: measurements.initialOpenPanels as Record<string, number>,
    keyboardExpandable: measurements.keyboardExpandable as boolean,
    security: Object.fromEntries(
      Object.entries(security).filter(([key]) => key !== 'status'),
    ) as unknown as RuntimeSecurityMeasurements,
  });
  if (value.routeSetSha256 !== recreated.routeSetSha256 || value.result !== 'pass' ||
    security.status !== 'pass' || evidenceSha256 !== recreated.evidenceSha256 ||
    canonicalJson(value) !== canonicalJson(recreated)) {
    return fail('RUNTIME_EVIDENCE_HASH_MISMATCH', 'RuntimeAcceptanceのhash chainが一致しません');
  }
  return recreated;
}

async function assertCanonicalFile(workspace: string, persistedPath: WorkspaceRelativePath): Promise<string> {
  if (!isAbsolute(workspace) || persistedPath.startsWith('/') || persistedPath.includes('\\') ||
    persistedPath.includes(':') || persistedPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    return fail('RUNTIME_EVIDENCE_PATH_UNSAFE', 'RuntimeAcceptance pathが不正です');
  }
  const root = resolve(workspace);
  const target = join(root, ...persistedPath.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    return fail('RUNTIME_EVIDENCE_PATH_UNSAFE', 'RuntimeAcceptance pathがworkspace外です');
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) return fail('RUNTIME_EVIDENCE_PATH_UNSAFE', 'RuntimeAcceptance pathにlinkがあります');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
    return fail('RUNTIME_EVIDENCE_PATH_UNSAFE', 'RuntimeAcceptance実体が不正です');
  }
  return target;
}

/** release-verifyではcaller値を使わず、canonical原artifactを再読込する。 */
export async function loadRuntimeAcceptanceEvidence(
  workspace: string,
  persistedPath: WorkspaceRelativePath,
  expectedSha256: Sha256,
): Promise<RuntimeAcceptanceEvidence> {
  const target = await assertCanonicalFile(workspace, persistedPath);
  const bytes = await readFile(target);
  if (sha256(bytes) !== expectedSha256) {
    return fail('RUNTIME_EVIDENCE_ARTIFACT_MISMATCH', 'RuntimeAcceptance原artifact SHAが一致しません');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('RUNTIME_EVIDENCE_SCHEMA_INVALID', 'RuntimeAcceptance JSONが不正です');
  }
  return validateRuntimeAcceptanceEvidence(value);
}
