import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  isMintedLoadedBatchCandidateProjection,
  loadBatchCandidateRegistryProjection,
  loadAndVerifyBatchCandidate,
  type ApprovedBatchCandidateDefinition,
  type BatchCandidateRegistry,
  type LoadedBatchCandidateProjection,
  validateBatchCandidateRegistry,
} from './batch-candidate.ts';
import {
  createNextBatchTemplate,
  type BatchAuthor,
  type BatchId,
  type BatchManifest,
  type Sha256,
  type WorkspaceRelativePath,
} from './batch.ts';
import {
  canonicalJson,
  fingerprintArtifact,
  writeJsonArtifactAtomic,
} from './artifacts.ts';

const execFile = promisify(execFileCallback);
const SHA256 = /^[0-9a-f]{64}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;

export const F005_REQUIREMENT_APPROVAL_SNAPSHOT =
  '18e3fa50edfe5214480a65ed2e840fe49a663ee2' as const;
export const F005_EXPECTED_OLD_REGISTRY_SHA256 =
  '7af12bb0226e7347584a97bd34c5b6d2311475d8aacc44bdbb2e87269785724d' as Sha256;
export const F005_MIGRATION_EVIDENCE_PATH =
  'docs/evidence/implementation/F005-candidate-registry-migration.json' as WorkspaceRelativePath;
export const F005_ACCEPTANCE_EVIDENCE_PATH =
  'docs/evidence/implementation/F005-candidate-registry-acceptance.json' as WorkspaceRelativePath;
export const F005_LOADER_TEST_EVIDENCE_PATH =
  'docs/evidence/tests/F005-candidate-registry-loaders.json' as WorkspaceRelativePath;
export const F005_MANIFEST_PATH =
  'content/batches/F005/batch.json' as WorkspaceRelativePath;

const SHARED_REGISTRY_PATH = 'content/batch-candidates.json' as WorkspaceRelativePath;
const SNAPSHOT_DEFINITION_PATH =
  'content/batch-definitions/F005.json' as WorkspaceRelativePath;
const SNAPSHOT_CANDIDATE_PATH =
  'content/batch-candidates/F005.json' as WorkspaceRelativePath;
const SNAPSHOT_POLICY_PATH =
  'content/approval-policies/F005.json' as WorkspaceRelativePath;
const SNAPSHOT_BINDING_PATH =
  'docs/evidence/requirements/F005-approval-binding.json' as WorkspaceRelativePath;

const SNAPSHOT_FILES = Object.freeze({
  [SNAPSHOT_DEFINITION_PATH]: '6d8edca9efb8aabc096021a7b263176decaa03cf8416750bb98cc25d3ffdbcf4',
  [SNAPSHOT_CANDIDATE_PATH]: '185314c8c7ee350db448a8106902eaaba1b8b5e14e404a17952763f2df19650a',
  [SNAPSHOT_POLICY_PATH]: '579cea92775d45629cf82de5a9ee0c59d1ae97ead2335b6fec94e7d26345afac',
  [SNAPSHOT_BINDING_PATH]: '77ff059da2cd1eb7a09b2ce7737f2d9cecdad830e1cada419638641b860dbb55',
  'queue.yaml': '052fcc020339897d9caeb69b9dfe1bae100c0ee87b0c95533e6ac8dfac0ffb00',
  'docs/srs/SRS-F005.md': '46a6edbe93c0f5c7e24493e4fe09be3305ef8eefdfdbc6e09c4647fecea005bc',
  'docs/tests/qt/QT-F005.md': '70ef3dbb27bdf053308a2dbbcbf0a11ecf221de10884acb9742bc9bf6408e907',
  'docs/changes/CHG-F005-001.md': '919bfda8550089e5eecddf8d3cdd8ca86c3276176207e8b3716c18d83734c876',
} satisfies Readonly<Record<string, string>>);

const NATSUME_AUTHOR = Object.freeze({
  authorId: '000148',
  identitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f' as Sha256,
  name: 'なつめそうせき',
  originalName: '夏目漱石',
  slug: 'natsume-soseki',
} satisfies BatchAuthor);

const F005_GATE_REFS = Object.freeze({
  requirements: 'docs/srs/SRS-F005.md' as WorkspaceRelativePath,
  design: 'docs/design/DD-F005.md' as WorkspaceRelativePath,
  testspec: 'docs/tests/ut/UT-F005.md' as WorkspaceRelativePath,
  release: 'docs/evidence/release/F005-approval.json' as WorkspaceRelativePath,
});

const LOADER_TEST_IDS = Object.freeze({
  F003: 'F005-REGISTRY-LOADER-F003',
  F004: 'F005-REGISTRY-LOADER-F004',
  F005: 'F005-REGISTRY-LOADER-F005',
} as const);

type GitCommit = string & { readonly __gitCommit: unique symbol };

export type F005ContextErrorCode =
  | 'F005_APPROVAL_SNAPSHOT_INVALID'
  | 'F005_REGISTRY_MIGRATION_INVALID'
  | 'F005_REGISTRY_CONTROL_INVALID'
  | 'F005_CONTEXT_INVALID'
  | 'F005_MANIFEST_CONFLICT';

export class F005ContextError extends Error {
  constructor(
    public readonly code: F005ContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'F005ContextError';
  }
}

export interface IntegratedRegistryEvidenceV1 {
  readonly schemaVersion: 1;
  readonly requirementApprovalSnapshot: typeof F005_REQUIREMENT_APPROVAL_SNAPSHOT;
  readonly expectedOldRegistrySha256: Sha256;
  readonly integratedRegistrySha256: Sha256;
  readonly priorCandidateProjectionSha256: readonly [
    { readonly feature: 'F003'; readonly sha256: Sha256 },
    { readonly feature: 'F004'; readonly sha256: Sha256 },
  ];
  readonly f005CandidateSha256: Sha256;
  readonly implementationCommit: GitCommit;
  readonly createdAt: string;
  readonly sealSha256: Sha256;
}

export interface IntegratedRegistryAcceptanceV1 {
  readonly schemaVersion: 1;
  readonly requirementApprovalSnapshot: typeof F005_REQUIREMENT_APPROVAL_SNAPSHOT;
  readonly controlCommit: GitCommit;
  readonly integratedEvidenceSha256: Sha256;
  readonly loaderTestEvidenceSha256: Sha256;
  readonly testedFeatures: readonly ['F003', 'F004', 'F005'];
  readonly createdAt: string;
  readonly sealSha256: Sha256;
}

interface LoaderTestEvidenceV1 {
  readonly schemaVersion: 1;
  readonly requirementApprovalSnapshot: typeof F005_REQUIREMENT_APPROVAL_SNAPSHOT;
  readonly controlCommit: GitCommit;
  readonly integratedRegistrySha256: Sha256;
  readonly tests: readonly [
    LoaderTestResult<'F003'>,
    LoaderTestResult<'F004'>,
    LoaderTestResult<'F005'>,
  ];
  readonly createdAt: string;
  readonly sealSha256: Sha256;
}

interface LoaderTestResult<Feature extends 'F003' | 'F004' | 'F005'> {
  readonly testId: (typeof LOADER_TEST_IDS)[Feature];
  readonly feature: Feature;
  readonly result: 'pass';
  readonly candidateSha256: Sha256;
}

export interface VerifiedImplementationRegistryControl {
  readonly __brand: 'VerifiedImplementationRegistryControl';
  readonly acceptanceCommit: GitCommit;
  readonly controlCommit: GitCommit;
  readonly implementationCommit: GitCommit;
  readonly evidencePath: typeof F005_MIGRATION_EVIDENCE_PATH;
  readonly evidenceSha256: Sha256;
  readonly acceptanceEvidencePath: typeof F005_ACCEPTANCE_EVIDENCE_PATH;
  readonly acceptanceEvidenceSha256: Sha256;
  readonly integratedRegistrySha256: Sha256;
}

export interface F005VerifiedApprovalBindingPolicy {
  readonly __brand: 'VerifiedApprovalBindingPolicy';
  readonly requirementApprovalSnapshot: typeof F005_REQUIREMENT_APPROVAL_SNAPSHOT;
  readonly artifactSha256s: Readonly<Record<keyof typeof SNAPSHOT_FILES, Sha256>>;
}

export interface F005ApprovedBatchContext {
  readonly __brand: 'ApprovedBatchContext';
  readonly candidate: ApprovedBatchCandidateDefinition;
  readonly definition: {
    readonly __brand: 'VerifiedBatchDefinition';
    readonly ref: typeof SNAPSHOT_DEFINITION_PATH;
    readonly sha256: Sha256;
    readonly batchId: 'F005';
    readonly feature: 'F005';
    readonly candidateRegistryPath: typeof SHARED_REGISTRY_PATH;
    readonly author: BatchAuthor;
    readonly workIds: readonly ['000799', '001076', '001104'];
    readonly works: ApprovedBatchCandidateDefinition['works'];
    readonly authorExpectation: 'introduce';
  };
  readonly policy: F005VerifiedApprovalBindingPolicy;
  readonly implementationControl: VerifiedImplementationRegistryControl;
}

interface SnapshotArtifacts {
  readonly definition: Readonly<Record<string, unknown>>;
  readonly dedicatedRegistry: BatchCandidateRegistry;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly binding: Readonly<Record<string, unknown>>;
}

interface DiffEntry {
  readonly status: string;
  readonly path: string;
  readonly mode: string;
  readonly objectId: string;
  readonly bytes: string;
}

type ActualLoaderResults = readonly [
  LoadedBatchCandidateProjection & { readonly feature: 'F003' },
  LoadedBatchCandidateProjection & { readonly feature: 'F004' },
  LoadedBatchCandidateProjection & { readonly feature: 'F005' },
];

const verifiedPolicies = new WeakSet<object>();
const verifiedControls = new WeakSet<object>();
const approvedContexts = new WeakSet<object>();

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) {
    throw new F005ContextError('F005_CONTEXT_INVALID', 'workspaceは絶対pathで指定する必要があります');
  }
  const lexical = resolve(workspace);
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(lexical) !== lexical) {
    throw new F005ContextError('F005_CONTEXT_INVALID', 'workspace実体が不正です');
  }
  return lexical;
}

async function git(workspace: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'Git object検証に失敗しました');
  }
}

async function gitSucceeds(workspace: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFile('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function blobAt(workspace: string, commit: string, path: string): Promise<string> {
  if (!FULL_COMMIT.test(commit)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', '完全commit SHAが必要です');
  }
  return git(workspace, ['show', `${commit}:${path}`]);
}

async function canonicalJsonAt<T>(
  workspace: string,
  commit: string,
  path: string,
  code: F005ContextErrorCode,
): Promise<{ readonly raw: string; readonly value: T }> {
  const raw = await blobAt(workspace, commit, path);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new F005ContextError(code, 'canonical JSON artifactを解釈できません');
  }
  if (raw !== canonicalJson(value)) {
    throw new F005ContextError(code, 'artifactがcanonical JSONではありません');
  }
  return { raw, value: value as T };
}

async function cleanHead(workspace: string): Promise<GitCommit> {
  const [head, status, symbolic] = await Promise.all([
    git(workspace, ['rev-parse', 'HEAD']),
    git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']),
    gitSucceeds(workspace, ['symbolic-ref', '-q', 'HEAD']),
  ]);
  const commit = head.trim();
  if (!FULL_COMMIT.test(commit) || status !== '' || !symbolic) {
    throw new F005ContextError(
      'F005_REGISTRY_CONTROL_INVALID',
      'cleanかつbranch上の完全HEADが必要です',
    );
  }
  return commit as GitCommit;
}

async function acceptedControlCommitAtCleanDescendant(
  workspace: string,
): Promise<GitCommit> {
  const head = await cleanHead(workspace);
  const additions = (await git(workspace, [
    'log',
    '--first-parent',
    '--format=%H',
    '--diff-filter=A',
    head,
    '--',
    F005_ACCEPTANCE_EVIDENCE_PATH,
  ]))
    .trim()
    .split(/\s+/u)
    .filter((value) => value.length > 0);
  const acceptanceCommit = additions[0];
  if (
    additions.length !== 1 ||
    !acceptanceCommit ||
    !FULL_COMMIT.test(acceptanceCommit) ||
    !await gitSucceeds(workspace, ['merge-base', '--is-ancestor', acceptanceCommit, head])
  ) {
    throw new F005ContextError(
      'F005_REGISTRY_CONTROL_INVALID',
      'F005 acceptance commitをclean descendantから一意に解決できません',
    );
  }
  const protectedPaths = [
    F005_MIGRATION_EVIDENCE_PATH,
    F005_ACCEPTANCE_EVIDENCE_PATH,
    F005_LOADER_TEST_EVIDENCE_PATH,
  ] as const;
  for (const path of protectedPaths) {
    if (await blobAt(workspace, head, path) !== await blobAt(workspace, acceptanceCommit, path)) {
      throw new F005ContextError(
        'F005_REGISTRY_CONTROL_INVALID',
        `acceptance後に保護artifactが変更されています: ${path}`,
      );
    }
  }
  // SHARED_REGISTRY_PATHはF002以降の全featureが追記し続けるappend-only共有registryのため、
  // 全体のbyte一致ではなくF005自身のcandidate entryだけが不変であることを検証する
  // (F006以降の正当な追記でこの不変条件が壊れないようにするための2026-08-22の修正)。
  let headF005: ApprovedBatchCandidateDefinition | undefined;
  let acceptanceF005: ApprovedBatchCandidateDefinition | undefined;
  try {
    const headRegistry = parseSharedRegistry(JSON.parse(await blobAt(workspace, head, SHARED_REGISTRY_PATH)));
    const acceptanceRegistry = parseSharedRegistry(
      JSON.parse(await blobAt(workspace, acceptanceCommit, SHARED_REGISTRY_PATH)),
    );
    headF005 = headRegistry.candidates.find((candidate) => candidate.feature === 'F005');
    acceptanceF005 = acceptanceRegistry.candidates.find((candidate) => candidate.feature === 'F005');
  } catch {
    throw new F005ContextError(
      'F005_REGISTRY_CONTROL_INVALID',
      `acceptance後に保護artifactが変更されています: ${SHARED_REGISTRY_PATH}`,
    );
  }
  if (!headF005 || !acceptanceF005 || canonicalJson(headF005) !== canonicalJson(acceptanceF005)) {
    throw new F005ContextError(
      'F005_REGISTRY_CONTROL_INVALID',
      `acceptance後に保護artifactが変更されています: ${SHARED_REGISTRY_PATH}`,
    );
  }
  return acceptanceCommit as GitCommit;
}

async function singleParent(workspace: string, commit: GitCommit): Promise<GitCommit> {
  const parts = (await git(workspace, ['rev-list', '--parents', '-n', '1', commit]))
    .trim()
    .split(/\s+/u);
  const parent = parts[1];
  if (parts.length !== 2 || !parent || !FULL_COMMIT.test(parent)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'single-parent commitが必要です');
  }
  return parent as GitCommit;
}

async function commitTimestamp(workspace: string, commit: GitCommit): Promise<string> {
  const value = (await git(workspace, ['show', '-s', '--format=%cI', commit])).trim();
  if (value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'commit timestampが不正です');
  }
  return value;
}

async function exactAddedDiff(
  workspace: string,
  parent: GitCommit,
  child: GitCommit,
  expectedPaths: readonly WorkspaceRelativePath[],
): Promise<ReadonlyMap<string, DiffEntry>> {
  const raw = await git(workspace, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '--no-renames',
    '-r',
    '-z',
    parent,
    child,
  ]);
  const tokens = raw.split('\0').filter((token) => token.length > 0);
  if (tokens.length % 2 !== 0) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'Git tree差分が不正です');
  }
  const statuses = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    if (!status || !path || statuses.has(path)) {
      throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'Git tree差分が一意ではありません');
    }
    statuses.set(path, status);
  }
  if (canonicalJson([...statuses.keys()].sort()) !== canonicalJson([...expectedPaths].sort()) ||
    [...statuses.values()].some((status) => status !== 'A')) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', '許可外のGit tree差分があります');
  }
  const result = new Map<string, DiffEntry>();
  for (const path of expectedPaths) {
    const tree = (await git(workspace, ['ls-tree', child, '--', path])).trim();
    const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/u.exec(tree);
    if (!match || match[3] !== path) {
      throw new F005ContextError(
        'F005_REGISTRY_CONTROL_INVALID',
        'evidenceはmode 100644のregular fileである必要があります',
      );
    }
    result.set(path, {
      status: 'A',
      path,
      mode: match[1]!,
      objectId: match[2]!,
      bytes: await blobAt(workspace, child, path),
    });
  }
  return result;
}

function parseSnapshotCandidate(value: unknown): BatchCandidateRegistry {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'candidates']) ||
    value.schemaVersion !== '1.0.0' || !Array.isArray(value.candidates) ||
    value.candidates.length !== 1) {
    throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'F005専用registryが不正です');
  }
  const candidate = value.candidates[0];
  if (!isRecord(candidate) ||
    canonicalJson(candidate.author) !== canonicalJson(NATSUME_AUTHOR) ||
    candidate.batchId !== 'F005' || candidate.feature !== 'F005' ||
    !Array.isArray(candidate.works) || candidate.works.length !== 3 ||
    canonicalJson(candidate.works.map((work) => isRecord(work) ? work.workId : null)) !==
      canonicalJson(['000799', '001076', '001104'])) {
    throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'F005候補identityが不正です');
  }
  return structuredClone(value) as unknown as BatchCandidateRegistry;
}

async function loadSnapshotArtifacts(workspace: string): Promise<SnapshotArtifacts> {
  const artifactSha256s: Record<string, Sha256> = {};
  const raws = new Map<string, string>();
  for (const [path, expectedSha] of Object.entries(SNAPSHOT_FILES)) {
    const raw = await blobAt(workspace, F005_REQUIREMENT_APPROVAL_SNAPSHOT, path);
    if (sha256(raw) !== expectedSha) {
      throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'approval snapshot SHAが不正です');
    }
    artifactSha256s[path] = expectedSha as Sha256;
    raws.set(path, raw);
  }
  const parse = (path: string): Record<string, unknown> => {
    const raw = raws.get(path);
    if (!raw) throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'snapshot artifactがありません');
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'snapshot JSONが不正です');
    }
    if (!isRecord(value) || raw !== canonicalJson(value)) {
      throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'snapshot JSONがcanonicalではありません');
    }
    return value;
  };
  const definition = parse(SNAPSHOT_DEFINITION_PATH);
  const dedicatedRegistry = parseSnapshotCandidate(parse(SNAPSHOT_CANDIDATE_PATH));
  const policy = parse(SNAPSHOT_POLICY_PATH);
  const binding = parse(SNAPSHOT_BINDING_PATH);
  if (definition.candidateRegistryPath !== SNAPSHOT_CANDIDATE_PATH ||
    definition.feature !== 'F005' || definition.batchId !== 'F005' ||
    canonicalJson(definition.works) !== canonicalJson(dedicatedRegistry.candidates[0]?.works) ||
    policy.feature !== 'F005' || binding.feature !== 'F005') {
    throw new F005ContextError('F005_APPROVAL_SNAPSHOT_INVALID', 'snapshot artifact間のbindingが不正です');
  }
  return { definition, dedicatedRegistry, policy, binding };
}

/**
 * 固定Git objectだけからrequirement approval policyをmintする。
 * @des DES-F005-001 @des DES-F005-012 @fun FUN-F005-045 @ut UT-F005-045
 */
async function loadVerifiedF005ApprovalBindingPolicy(
  workspace: string,
): Promise<F005VerifiedApprovalBindingPolicy> {
  const root = await verifiedWorkspace(workspace);
  await loadSnapshotArtifacts(root);
  const policy = deepFreeze({
    __brand: 'VerifiedApprovalBindingPolicy' as const,
    requirementApprovalSnapshot: F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    artifactSha256s: Object.fromEntries(
      Object.entries(SNAPSHOT_FILES).map(([path, value]) => [path, value as Sha256]),
    ) as Record<keyof typeof SNAPSHOT_FILES, Sha256>,
  });
  verifiedPolicies.add(policy);
  return policy;
}

function parseSharedRegistry(value: unknown): BatchCandidateRegistry {
  const result = validateBatchCandidateRegistry(value);
  if (!result.ok) {
    throw new F005ContextError('F005_REGISTRY_MIGRATION_INVALID', '共有registry schemaが不正です');
  }
  return result.value;
}

function integratedRegistry(
  oldRegistry: BatchCandidateRegistry,
  dedicated: BatchCandidateRegistry,
): BatchCandidateRegistry {
  const f005 = dedicated.candidates[0];
  if (oldRegistry.candidates.length !== 2 ||
    canonicalJson(oldRegistry.candidates.map((candidate) => candidate.feature)) !==
      canonicalJson(['F003', 'F004']) ||
    !f005 || f005.feature !== 'F005') {
    throw new F005ContextError('F005_REGISTRY_MIGRATION_INVALID', '旧候補projectionまたはF005候補が不正です');
  }
  return {
    schemaVersion: '1.0.0',
    candidates: [
      structuredClone(oldRegistry.candidates[0]!),
      structuredClone(oldRegistry.candidates[1]!),
      structuredClone(f005),
    ],
  };
}

function evidenceSeal<T extends object>(core: T): Sha256 {
  return sha256(canonicalJson(core));
}

function migrationCore(
  oldRegistry: BatchCandidateRegistry,
  dedicated: BatchCandidateRegistry,
  implementationCommit: GitCommit,
  createdAt: string,
): Omit<IntegratedRegistryEvidenceV1, 'sealSha256'> {
  const integrated = integratedRegistry(oldRegistry, dedicated);
  return {
    schemaVersion: 1,
    requirementApprovalSnapshot: F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    expectedOldRegistrySha256: F005_EXPECTED_OLD_REGISTRY_SHA256,
    integratedRegistrySha256: sha256(canonicalJson(integrated)),
    priorCandidateProjectionSha256: [
      { feature: 'F003', sha256: sha256(canonicalJson(oldRegistry.candidates[0])) },
      { feature: 'F004', sha256: sha256(canonicalJson(oldRegistry.candidates[1])) },
    ],
    f005CandidateSha256: sha256(canonicalJson(dedicated.candidates[0])),
    implementationCommit,
    createdAt,
  };
}

async function writeSealedJson(
  workspace: string,
  path: WorkspaceRelativePath,
  value: unknown,
): Promise<string> {
  const absolute = join(workspace, ...path.split('/'));
  await writeJsonArtifactAtomic(workspace, absolute, value, { expectedFingerprint: null });
  const handle = await open(absolute, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const raw = await readFile(absolute, 'utf8');
  if (raw !== canonicalJson(value)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'evidence post-readが一致しません');
  }
  return raw;
}

async function assertSnapshotAncestor(workspace: string, commit: GitCommit): Promise<void> {
  if (!await gitSucceeds(workspace, [
    'merge-base',
    '--is-ancestor',
    F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    commit,
  ])) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'approval snapshotの子孫ではありません');
  }
}

/**
 * clean implementation commitのregistry不変条件を検証し、migration evidenceだけを保存する。
 * @des DES-F005-001 @fun FUN-F005-048 @ut UT-F005-048
 * @internal
 */
async function migrateF005CandidateRegistry(
  workspace: string,
): Promise<IntegratedRegistryEvidenceV1> {
  const root = await verifiedWorkspace(workspace);
  const implementationCommit = await cleanHead(root);
  await assertSnapshotAncestor(root, implementationCommit);
  const parent = await singleParent(root, implementationCommit);
  const snapshot = await loadSnapshotArtifacts(root);
  const oldRaw = await blobAt(root, parent, SHARED_REGISTRY_PATH);
  if (sha256(oldRaw) !== F005_EXPECTED_OLD_REGISTRY_SHA256) {
    throw new F005ContextError('F005_REGISTRY_MIGRATION_INVALID', 'expected old registry SHAが一致しません');
  }
  const oldRegistry = parseSharedRegistry(JSON.parse(oldRaw) as unknown);
  const expectedIntegrated = integratedRegistry(oldRegistry, snapshot.dedicatedRegistry);
  const integratedRaw = await blobAt(root, implementationCommit, SHARED_REGISTRY_PATH);
  if (integratedRaw !== canonicalJson(expectedIntegrated)) {
    throw new F005ContextError('F005_REGISTRY_MIGRATION_INVALID', '統合registryがexact projectionと一致しません');
  }

  // PreControlMigrationVerification: production brandへ変換せずF003/F004実loaderを事前確認する。
  const integratedSha = sha256(integratedRaw);
  const [f003Loader, f004Loader, f004Context] = await Promise.all([
    loadBatchCandidateRegistryProjection(root, 'F003' as BatchId),
    loadBatchCandidateRegistryProjection(root, 'F004' as BatchId),
    loadAndVerifyBatchCandidate(
      root,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    ),
  ]);
  if (!isMintedLoadedBatchCandidateProjection(f003Loader) ||
    !isMintedLoadedBatchCandidateProjection(f004Loader) ||
    f003Loader.registrySha256 !== integratedSha ||
    f004Loader.registrySha256 !== integratedSha ||
    canonicalJson(f004Loader.candidate) !== canonicalJson(f004Context.candidate)) {
    throw new F005ContextError('F005_REGISTRY_MIGRATION_INVALID', 'F003/F004 production loaderが不一致です');
  }

  const core = migrationCore(
    oldRegistry,
    snapshot.dedicatedRegistry,
    implementationCommit,
    await commitTimestamp(root, implementationCommit),
  );
  const evidence = deepFreeze({ ...core, sealSha256: evidenceSeal(core) });
  await writeSealedJson(root, F005_MIGRATION_EVIDENCE_PATH, evidence);
  return evidence;
}

function parseMigrationEvidence(raw: string): IntegratedRegistryEvidenceV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'migration evidenceが不正です');
  }
  if (!isRecord(value) || raw !== canonicalJson(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'requirementApprovalSnapshot',
      'expectedOldRegistrySha256',
      'integratedRegistrySha256',
      'priorCandidateProjectionSha256',
      'f005CandidateSha256',
      'implementationCommit',
      'createdAt',
      'sealSha256',
    ]) ||
    value.schemaVersion !== 1 ||
    value.requirementApprovalSnapshot !== F005_REQUIREMENT_APPROVAL_SNAPSHOT ||
    value.expectedOldRegistrySha256 !== F005_EXPECTED_OLD_REGISTRY_SHA256 ||
    typeof value.implementationCommit !== 'string' || !FULL_COMMIT.test(value.implementationCommit) ||
    typeof value.sealSha256 !== 'string' || !SHA256.test(value.sealSha256)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'migration evidence schemaが不正です');
  }
  const { sealSha256, ...core } = value;
  if (sealSha256 !== evidenceSeal(core)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'migration evidence sealが不正です');
  }
  return value as unknown as IntegratedRegistryEvidenceV1;
}

async function recomputeImplementationMigration(
  workspace: string,
  implementationCommit: GitCommit,
  migrationRaw: string,
): Promise<{
  readonly migration: IntegratedRegistryEvidenceV1;
  readonly registry: BatchCandidateRegistry;
  readonly snapshot: SnapshotArtifacts;
}> {
  const migration = parseMigrationEvidence(migrationRaw);
  const oldRegistryCommit = await singleParent(workspace, implementationCommit);
  const oldRaw = await blobAt(workspace, oldRegistryCommit, SHARED_REGISTRY_PATH);
  if (sha256(oldRaw) !== F005_EXPECTED_OLD_REGISTRY_SHA256) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'implementation親のold registry SHAが不正です');
  }
  let oldValue: unknown;
  try {
    oldValue = JSON.parse(oldRaw) as unknown;
  } catch {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'old registry JSONが不正です');
  }
  if (oldRaw !== canonicalJson(oldValue)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'old registryがcanonicalではありません');
  }
  const oldRegistry = parseSharedRegistry(oldValue);
  const snapshot = await loadSnapshotArtifacts(workspace);
  const expectedRegistry = integratedRegistry(oldRegistry, snapshot.dedicatedRegistry);
  const implementationArtifact = await canonicalJsonAt<BatchCandidateRegistry>(
    workspace,
    implementationCommit,
    SHARED_REGISTRY_PATH,
    'F005_REGISTRY_CONTROL_INVALID',
  );
  const registry = parseSharedRegistry(implementationArtifact.value);
  if (implementationArtifact.raw !== canonicalJson(expectedRegistry)) {
    throw new F005ContextError(
      'F005_REGISTRY_CONTROL_INVALID',
      'implementation registryのcanonical projectionが不正です',
    );
  }
  const expectedCore = migrationCore(
    oldRegistry,
    snapshot.dedicatedRegistry,
    implementationCommit,
    await commitTimestamp(workspace, implementationCommit),
  );
  const expectedEvidence = {
    ...expectedCore,
    sealSha256: evidenceSeal(expectedCore),
  };
  if (migration.implementationCommit !== implementationCommit ||
    canonicalJson(expectedEvidence) !== migrationRaw) {
    throw new F005ContextError(
      'F005_REGISTRY_CONTROL_INVALID',
      'migration evidence全fieldの再計算結果が一致しません',
    );
  }
  return { migration, registry, snapshot };
}

function candidateByFeature(
  registry: BatchCandidateRegistry,
  feature: 'F003' | 'F004' | 'F005',
): ApprovedBatchCandidateDefinition {
  const matches = registry.candidates.filter((candidate) => candidate.feature === feature);
  const candidate = matches[0];
  if (matches.length !== 1 || !candidate) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'loader候補が一意ではありません');
  }
  return candidate;
}

function loaderTestCore(
  controlCommit: GitCommit,
  integratedRegistrySha256: Sha256,
  loaderResults: ActualLoaderResults,
  createdAt: string,
): Omit<LoaderTestEvidenceV1, 'sealSha256'> {
  return {
    schemaVersion: 1,
    requirementApprovalSnapshot: F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    controlCommit,
    integratedRegistrySha256,
    tests: loaderResults.map((result) => ({
      testId: LOADER_TEST_IDS[result.feature as 'F003' | 'F004' | 'F005'],
      feature: result.feature,
      result: 'pass' as const,
      candidateSha256: sha256(canonicalJson(result.candidate)),
    })) as unknown as LoaderTestEvidenceV1['tests'],
    createdAt,
  };
}

async function runActualLoaderLogic(
  workspace: string,
  anchorCommit: GitCommit,
  snapshot: SnapshotArtifacts,
): Promise<ActualLoaderResults> {
  const [f003, f004, f005, f004Context, anchorRegistryRaw] = await Promise.all([
    loadBatchCandidateRegistryProjection(workspace, 'F003' as BatchId),
    loadBatchCandidateRegistryProjection(workspace, 'F004' as BatchId),
    loadBatchCandidateRegistryProjection(workspace, 'F005' as BatchId),
    loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    ),
    blobAt(workspace, anchorCommit, SHARED_REGISTRY_PATH),
  ]);
  // registrySha256（共有registry全体のbyte hash）はF002以降の全featureがappend-onlyで
  // 追記し続けるため、integratedRegistrySha256（F005統合migration時点の固定値）とは
  // F006以降のfeatureが正当に追記するたびに必ず乖離する。全体byte一致の代わりに、
  // F003のcandidate entryはanchorCommit（implementation commit）時点のregistry blobと
  // pinした個別比較へ差し替え、F004/F005は既存どおり独立経路（definition+policy
  // verification／F005 dedicated registry）との一致で検証する
  // （2026-08-22の修正、SHARED_REGISTRY_PATH全体不変条件を廃止した既存修正と同じ方針）。
  const anchorRegistry = parseSharedRegistry(JSON.parse(anchorRegistryRaw) as unknown);
  const anchorF003 = candidateByFeature(anchorRegistry, 'F003');
  if ([f003, f004, f005].some((result) =>
    !isMintedLoadedBatchCandidateProjection(result)) ||
    canonicalJson(f003.candidate) !== canonicalJson(anchorF003) ||
    canonicalJson(f004.candidate) !== canonicalJson(f004Context.candidate) ||
    canonicalJson(f005.candidate) !== canonicalJson(snapshot.dedicatedRegistry.candidates[0])) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'production loader結果が一致しません');
  }
  return [
    f003 as ActualLoaderResults[0],
    f004 as ActualLoaderResults[1],
    f005 as ActualLoaderResults[2],
  ];
}

/**
 * control commit上で3 production loader logicを受入専用brandへ閉じて実行する。
 * @des DES-F005-001 @fun FUN-F005-048 @ut UT-F005-048
 * @internal
 */
async function acceptIntegratedF005Registry(
  workspace: string,
): Promise<IntegratedRegistryAcceptanceV1> {
  const root = await verifiedWorkspace(workspace);
  const controlCommit = await cleanHead(root);
  const implementationCommit = await singleParent(root, controlCommit);
  const diff = await exactAddedDiff(
    root,
    implementationCommit,
    controlCommit,
    [F005_MIGRATION_EVIDENCE_PATH],
  );
  const migrationRaw = diff.get(F005_MIGRATION_EVIDENCE_PATH)?.bytes;
  if (!migrationRaw) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'migration evidenceがありません');
  }
  const { migration, snapshot } = await recomputeImplementationMigration(
    root,
    implementationCommit,
    migrationRaw,
  );
  const loaderResults = await runActualLoaderLogic(
    root,
    implementationCommit,
    snapshot,
  );
  const createdAt = await commitTimestamp(root, controlCommit);
  const loaderCore = loaderTestCore(
    controlCommit,
    migration.integratedRegistrySha256,
    loaderResults,
    createdAt,
  );
  const loaderEvidence = deepFreeze({ ...loaderCore, sealSha256: evidenceSeal(loaderCore) });
  const loaderRaw = canonicalJson(loaderEvidence);
  const acceptanceCore = {
    schemaVersion: 1 as const,
    requirementApprovalSnapshot: F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    controlCommit,
    integratedEvidenceSha256: sha256(migrationRaw),
    loaderTestEvidenceSha256: sha256(loaderRaw),
    testedFeatures: ['F003', 'F004', 'F005'] as const,
    createdAt,
  };
  const acceptance = deepFreeze({
    ...acceptanceCore,
    sealSha256: evidenceSeal(acceptanceCore),
  });
  await writeSealedJson(root, F005_LOADER_TEST_EVIDENCE_PATH, loaderEvidence);
  await writeSealedJson(root, F005_ACCEPTANCE_EVIDENCE_PATH, acceptance);
  return acceptance;
}

function parseAcceptanceEvidence(raw: string): IntegratedRegistryAcceptanceV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'acceptance evidenceが不正です');
  }
  if (!isRecord(value) || raw !== canonicalJson(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'requirementApprovalSnapshot',
      'controlCommit',
      'integratedEvidenceSha256',
      'loaderTestEvidenceSha256',
      'testedFeatures',
      'createdAt',
      'sealSha256',
    ]) ||
    value.schemaVersion !== 1 ||
    value.requirementApprovalSnapshot !== F005_REQUIREMENT_APPROVAL_SNAPSHOT ||
    typeof value.controlCommit !== 'string' || !FULL_COMMIT.test(value.controlCommit) ||
    canonicalJson(value.testedFeatures) !== canonicalJson(['F003', 'F004', 'F005']) ||
    typeof value.sealSha256 !== 'string' || !SHA256.test(value.sealSha256)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'acceptance evidence schemaが不正です');
  }
  const { sealSha256, ...core } = value;
  if (sealSha256 !== evidenceSeal(core)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'acceptance evidence sealが不正です');
  }
  return value as unknown as IntegratedRegistryAcceptanceV1;
}

function parseLoaderEvidence(raw: string): LoaderTestEvidenceV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'loader test evidenceが不正です');
  }
  if (!isRecord(value) || raw !== canonicalJson(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'requirementApprovalSnapshot',
      'controlCommit',
      'integratedRegistrySha256',
      'tests',
      'createdAt',
      'sealSha256',
    ]) ||
    value.schemaVersion !== 1 ||
    value.requirementApprovalSnapshot !== F005_REQUIREMENT_APPROVAL_SNAPSHOT ||
    !Array.isArray(value.tests) || value.tests.length !== 3 ||
    typeof value.sealSha256 !== 'string' || !SHA256.test(value.sealSha256)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'loader test evidence schemaが不正です');
  }
  const { sealSha256, ...core } = value;
  if (sealSha256 !== evidenceSeal(core)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'loader test evidence sealが不正です');
  }
  return value as unknown as LoaderTestEvidenceV1;
}

/**
 * acceptance→control→implementationをGit objectから再計算した場合だけproduction controlをmintする。
 * @des DES-F005-001 @fun FUN-F005-048 @ut UT-F005-048
 * @internal
 */
async function loadVerifiedF005RegistryControl(
  workspace: string,
): Promise<VerifiedImplementationRegistryControl> {
  const root = await verifiedWorkspace(workspace);
  const acceptanceCommit = await acceptedControlCommitAtCleanDescendant(root);
  const controlCommit = await singleParent(root, acceptanceCommit);
  const implementationCommit = await singleParent(root, controlCommit);
  await assertSnapshotAncestor(root, implementationCommit);
  const controlDiff = await exactAddedDiff(
    root,
    implementationCommit,
    controlCommit,
    [F005_MIGRATION_EVIDENCE_PATH],
  );
  const acceptanceDiff = await exactAddedDiff(
    root,
    controlCommit,
    acceptanceCommit,
    [F005_ACCEPTANCE_EVIDENCE_PATH, F005_LOADER_TEST_EVIDENCE_PATH],
  );
  const migrationRaw = controlDiff.get(F005_MIGRATION_EVIDENCE_PATH)?.bytes;
  const acceptanceRaw = acceptanceDiff.get(F005_ACCEPTANCE_EVIDENCE_PATH)?.bytes;
  const loaderRaw = acceptanceDiff.get(F005_LOADER_TEST_EVIDENCE_PATH)?.bytes;
  if (!migrationRaw || !acceptanceRaw || !loaderRaw) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'canonical evidenceが不足しています');
  }
  const acceptance = parseAcceptanceEvidence(acceptanceRaw);
  const loader = parseLoaderEvidence(loaderRaw);
  const {
    migration,
    registry: implementationRegistry,
    snapshot,
  } = await recomputeImplementationMigration(root, implementationCommit, migrationRaw);
  if (migration.implementationCommit !== implementationCommit ||
    acceptance.controlCommit !== controlCommit ||
    loader.controlCommit !== controlCommit ||
    acceptance.integratedEvidenceSha256 !== sha256(migrationRaw) ||
    acceptance.loaderTestEvidenceSha256 !== sha256(loaderRaw) ||
    loader.integratedRegistrySha256 !== migration.integratedRegistrySha256) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', '三段階evidence bindingが一致しません');
  }
  const registryArtifact = await canonicalJsonAt<BatchCandidateRegistry>(
    root,
    acceptanceCommit,
    SHARED_REGISTRY_PATH,
    'F005_REGISTRY_CONTROL_INVALID',
  );
  const registry = parseSharedRegistry(registryArtifact.value);
  if (sha256(registryArtifact.raw) !== migration.integratedRegistrySha256 ||
    canonicalJson(registry) !== canonicalJson(implementationRegistry)) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', 'production registry SHAが一致しません');
  }
  const loaderResults = await runActualLoaderLogic(
    root,
    implementationCommit,
    snapshot,
  );
  const createdAt = await commitTimestamp(root, controlCommit);
  const expectedLoaderCore = loaderTestCore(
    controlCommit,
    migration.integratedRegistrySha256,
    loaderResults,
    createdAt,
  );
  const expectedAcceptanceCore = {
    schemaVersion: 1 as const,
    requirementApprovalSnapshot: F005_REQUIREMENT_APPROVAL_SNAPSHOT,
    controlCommit,
    integratedEvidenceSha256: sha256(migrationRaw),
    loaderTestEvidenceSha256: sha256(loaderRaw),
    testedFeatures: ['F003', 'F004', 'F005'] as const,
    createdAt,
  };
  if (canonicalJson({
    ...expectedLoaderCore,
    sealSha256: evidenceSeal(expectedLoaderCore),
  }) !== loaderRaw ||
    canonicalJson({
      ...expectedAcceptanceCore,
      sealSha256: evidenceSeal(expectedAcceptanceCore),
    }) !== acceptanceRaw) {
    throw new F005ContextError('F005_REGISTRY_CONTROL_INVALID', '3 loader test evidenceが一致しません');
  }
  const control = deepFreeze({
    __brand: 'VerifiedImplementationRegistryControl' as const,
    acceptanceCommit,
    controlCommit,
    implementationCommit,
    evidencePath: F005_MIGRATION_EVIDENCE_PATH,
    evidenceSha256: sha256(migrationRaw),
    acceptanceEvidencePath: F005_ACCEPTANCE_EVIDENCE_PATH,
    acceptanceEvidenceSha256: sha256(acceptanceRaw),
    integratedRegistrySha256: migration.integratedRegistrySha256,
  });
  verifiedControls.add(control);
  return control;
}

/**
 * requirement policyとimplementation controlの両方を内部取得しF005 contextをmintする。
 * @des DES-F005-001 @des DES-F005-002 @fun FUN-F005-001 @ut UT-F005-001
 */
export async function loadVerifiedF005Definition(
  workspace: string,
): Promise<F005ApprovedBatchContext> {
  const root = await verifiedWorkspace(workspace);
  const [policy, implementationControl, snapshot] = await Promise.all([
    loadVerifiedF005ApprovalBindingPolicy(root),
    loadVerifiedF005RegistryControl(root),
    loadSnapshotArtifacts(root),
  ]);
  if (!verifiedPolicies.has(policy) || !verifiedControls.has(implementationControl)) {
    throw new F005ContextError('F005_CONTEXT_INVALID', '内部mint済みcontrolが必要です');
  }
  const registryArtifact = await canonicalJsonAt<BatchCandidateRegistry>(
    root,
    implementationControl.acceptanceCommit,
    SHARED_REGISTRY_PATH,
    'F005_CONTEXT_INVALID',
  );
  const registry = parseSharedRegistry(registryArtifact.value);
  const candidate = candidateByFeature(registry, 'F005');
  const snapshotCandidate = snapshot.dedicatedRegistry.candidates[0];
  if (!snapshotCandidate || canonicalJson(candidate) !== canonicalJson(snapshotCandidate) ||
    registryArtifact.raw.length === 0 ||
    sha256(registryArtifact.raw) !== implementationControl.integratedRegistrySha256) {
    throw new F005ContextError('F005_CONTEXT_INVALID', 'F005 definitionと統合registryが一致しません');
  }
  const works = candidate.works;
  const context = deepFreeze({
    __brand: 'ApprovedBatchContext' as const,
    candidate: structuredClone(candidate),
    definition: {
      __brand: 'VerifiedBatchDefinition' as const,
      ref: SNAPSHOT_DEFINITION_PATH,
      sha256: SNAPSHOT_FILES[SNAPSHOT_DEFINITION_PATH] as Sha256,
      batchId: 'F005' as const,
      feature: 'F005' as const,
      candidateRegistryPath: SHARED_REGISTRY_PATH,
      author: structuredClone(candidate.author),
      workIds: ['000799', '001076', '001104'] as const,
      works: structuredClone(works),
      authorExpectation: 'introduce' as const,
    },
    policy,
    implementationControl,
  });
  approvedContexts.add(context);
  return context;
}

export function isMintedF005ApprovedBatchContext(
  value: unknown,
): value is F005ApprovedBatchContext {
  return isRecord(value) && approvedContexts.has(value) &&
    value.__brand === 'ApprovedBatchContext';
}

async function readExistingManifest(workspace: string): Promise<string | null> {
  try {
    return await readFile(join(workspace, ...F005_MANIFEST_PATH.split('/')), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 内部mint済みcontextとexact夏目identityだけから冪等に3作品manifestを作る。
 * @des DES-F005-002 @fun FUN-F005-005 @ut UT-F005-005
 */
export async function createF005Manifest(
  workspace: string,
  context: F005ApprovedBatchContext,
  author: BatchAuthor,
): Promise<BatchManifest> {
  const root = await verifiedWorkspace(workspace);
  if (!isMintedF005ApprovedBatchContext(context) ||
    canonicalJson(author) !== canonicalJson(context.candidate.author) ||
    canonicalJson(author) !== canonicalJson(NATSUME_AUTHOR)) {
    throw new F005ContextError('F005_CONTEXT_INVALID', 'mint済みcontextと夏目identityが必要です');
  }
  const manifest = createNextBatchTemplate({
    candidateId: 'F005',
    approved: true,
    author,
    works: context.candidate.works.map((work) => ({ workId: work.workId, title: work.title })),
    approvalGateRefs: F005_GATE_REFS,
    existingFeatureIds: ['F001', 'F002', 'F003', 'F004'] as BatchId[],
  }, 'F005' as BatchId);
  const expected = canonicalJson(manifest);
  const existing = await readExistingManifest(root);
  if (existing !== null) {
    if (existing !== expected) {
      throw new F005ContextError('F005_MANIFEST_CONFLICT', '既存F005 manifestが異なります');
    }
    return manifest;
  }
  const target = join(root, ...F005_MANIFEST_PATH.split('/'));
  try {
    await writeJsonArtifactAtomic(root, target, manifest, {
      expectedFingerprint: await fingerprintArtifact(target),
    });
  } catch {
    if (await readExistingManifest(root) !== expected) {
      throw new F005ContextError('F005_MANIFEST_CONFLICT', 'F005 manifestのCASに失敗しました');
    }
  }
  if (await readExistingManifest(root) !== expected) {
    throw new F005ContextError('F005_MANIFEST_CONFLICT', 'F005 manifest post-readが一致しません');
  }
  return manifest;
}

type PrivateTestCommand = 'policy' | 'migrate' | 'accept' | 'control';

function isDirectModuleExecution(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' &&
    pathToFileURL(resolve(entry)).href === import.meta.url;
}

/**
 * private関数のexportを増やさずに試験するための直接実行専用入口。
 * import時は実行せず、NODE_ENV=test以外の直接実行も拒否する。
 */
async function runPrivateTestCliIfRequested(): Promise<void> {
  if (!isDirectModuleExecution()) return;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('F005 private test CLIはNODE_ENV=test以外では利用できません');
  }
  const command = process.argv[2] as PrivateTestCommand | undefined;
  const workspace = process.argv[3];
  if (!workspace || !['policy', 'migrate', 'accept', 'control'].includes(command ?? '')) {
    throw new Error('F005 private test CLIのcommandまたはworkspaceが不正です');
  }
  try {
    const value = command === 'policy'
      ? await loadVerifiedF005ApprovalBindingPolicy(workspace)
      : command === 'migrate'
        ? await migrateF005CandidateRegistry(workspace)
        : command === 'accept'
          ? await acceptIntegratedF005Registry(workspace)
          : await loadVerifiedF005RegistryControl(workspace);
    process.stdout.write(canonicalJson({ ok: true, value }));
  } catch (error) {
    process.stdout.write(canonicalJson({
      ok: false,
      error: {
        code: error instanceof F005ContextError ? error.code : 'UNEXPECTED',
        message: error instanceof Error ? error.message : 'unknown error',
      },
    }));
    process.exitCode = 1;
  }
}

await runPrivateTestCliIfRequested();
