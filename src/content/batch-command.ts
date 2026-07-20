import type {
  BatchId,
  BatchManifest,
  PassingResult,
  Sha256,
  WorkId,
  WorkspaceRelativePath,
} from './batch.ts';
import { hashBatchManifest, validateBatchManifest } from './batch.ts';
import { canonicalJson } from './artifacts.ts';

export const BATCH_COMMAND_STAGES = [
  'rights',
  'bibliography',
  'select',
  'sources',
  'provenance',
  'decode',
  'extract',
  'normalize',
  'review',
  'capacity-forecast',
  'voice',
  'capacity-actual',
  'accept',
  'prepare-release',
  'release-verify',
  'all',
] as const;

export type BatchCommandStage = (typeof BATCH_COMMAND_STAGES)[number];
type ExecutableStage = Exclude<BatchCommandStage, 'all' | 'accept' | 'prepare-release' | 'release-verify'>;

export interface BatchStageRequest {
  readonly workspace: string;
  readonly batchId: BatchId;
  readonly manifest: BatchManifest;
  readonly stage: ExecutableStage;
  readonly workId?: WorkId;
}

export interface BatchAcceptRequest {
  readonly workspace: string;
  readonly batchId: BatchId;
  readonly manifest: BatchManifest;
  readonly workId: WorkId;
}

export interface BatchBuildRequest {
  readonly workspace: string;
  readonly batchId: BatchId;
  readonly manifest: BatchManifest;
  readonly commit: string;
  readonly mode: 'prepare' | 'release';
}

export interface BatchStageExecution {
  readonly nextManifest: BatchManifest;
  readonly inputHashes: readonly Sha256[];
  readonly outputHashes: readonly Sha256[];
  readonly count: number;
  readonly forecastResult?: PassingResult | 'blocked';
  readonly actualCapacityResult?: PassingResult | 'blocked';
}

export interface BatchTerminalExecution {
  readonly inputHashes: readonly Sha256[];
  readonly outputHashes: readonly Sha256[];
  readonly count: number;
  readonly manifest?: BatchManifest;
  readonly forecastResult?: PassingResult | 'blocked';
  readonly actualCapacityResult?: PassingResult | 'blocked';
}

export interface BatchDependencies {
  readonly loadManifest: (workspace: string, batchId: BatchId) => Promise<BatchManifest>;
  readonly executeStage: (request: BatchStageRequest) => Promise<BatchStageExecution>;
  readonly persistManifest: (request: {
    readonly workspace: string;
    readonly manifestPath: WorkspaceRelativePath;
    readonly next: BatchManifest;
    readonly expectedSha256: Sha256;
  }) => Promise<Sha256>;
  /** FUN-F002-033がaccepted sourceとmanifestを同じtransactionで更新する。 */
  readonly acceptWork: (request: BatchAcceptRequest) => Promise<BatchTerminalExecution>;
  readonly prepareRelease: (request: BatchBuildRequest) => Promise<BatchTerminalExecution>;
  readonly verifyRelease: (request: BatchBuildRequest) => Promise<BatchTerminalExecution>;
  readonly verifyCommit: (request: {
    readonly workspace: string;
    readonly commit: string;
    readonly mode: 'prepare' | 'release';
  }) => Promise<boolean>;
}

export interface BatchCommandResult {
  readonly ok: true;
  readonly code: 0;
  readonly stage: BatchCommandStage;
  readonly status: 'completed' | 'awaiting_manual_gate';
  readonly batchId: BatchId;
  readonly workId?: WorkId;
  readonly gate?: 'review' | 'accept';
  readonly inputHashes: readonly Sha256[];
  readonly outputHashes: readonly Sha256[];
  readonly count: number;
  readonly batchStatus: BatchManifest['status'];
  readonly workStatus?: BatchManifest['workProgress'][number]['status'];
  readonly forecastResult?: PassingResult | 'blocked';
  readonly actualCapacityResult?: PassingResult | 'blocked';
  readonly commit?: string;
}

export type BatchCommandErrorCode =
  | 'CLI_ARGUMENT_INVALID'
  | 'BATCH_WORK_NOT_FOUND'
  | 'BATCH_WORK_REQUIRED'
  | 'BATCH_WORK_ORDER_BLOCKED'
  | 'BATCH_STAGE_PREREQUISITE'
  | 'BATCH_COMMIT_REQUIRED'
  | 'BATCH_COMMIT_MISMATCH'
  | 'BATCH_DEPENDENCY_FAILED';

export class BatchCommandError extends Error {
  constructor(
    public readonly code: BatchCommandErrorCode,
    public readonly exitCode: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
    message: string,
    public readonly stage?: BatchCommandStage,
  ) {
    super(message);
    this.name = 'BatchCommandError';
  }
}

interface ParsedArguments {
  readonly batchId: BatchId;
  readonly workId?: WorkId;
  readonly stage: BatchCommandStage;
  readonly commit?: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const BATCH = /^F[0-9]{3}$/;
const WORK = /^[0-9]{6}$/;
const EARLY_STAGES: readonly ExecutableStage[] = [
  'rights', 'bibliography', 'select', 'sources', 'provenance', 'decode', 'extract', 'normalize',
];
const SOURCE_STAGES = new Set<BatchCommandStage>(['bibliography', 'select', 'sources', 'provenance', 'decode', 'extract', 'normalize']);
const WORK_REQUIRED = new Set<BatchCommandStage>(['review', 'capacity-forecast', 'voice', 'capacity-actual', 'accept']);
const ALL_COMPOSITE_STAGES: readonly ExecutableStage[] = ['rights', 'normalize'];

function exitCode(stage: BatchCommandStage): 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  if (stage === 'rights') return 2;
  if (SOURCE_STAGES.has(stage)) return 3;
  if (stage === 'review') return 4;
  if (stage === 'capacity-forecast' || stage === 'capacity-actual') return 5;
  if (stage === 'voice') return 6;
  if (stage === 'accept') return 7;
  return 8;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !['--batch', '--work', '--stage', '--commit'].includes(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new BatchCommandError('CLI_ARGUMENT_INVALID', 1, '引数は--batch/--work/--stage/--commitを値と対で一度だけ指定してください');
    }
    values.set(flag, value);
  }
  if (values.size * 2 !== argv.length) throw new BatchCommandError('CLI_ARGUMENT_INVALID', 1, '値のないCLI引数があります');
  const batch = values.get('--batch');
  const work = values.get('--work');
  const stage = values.get('--stage');
  const commit = values.get('--commit');
  if (!batch || !BATCH.test(batch) || !stage || !(BATCH_COMMAND_STAGES as readonly string[]).includes(stage) ||
    (work !== undefined && !WORK.test(work)) || (commit !== undefined && !COMMIT.test(commit))) {
    throw new BatchCommandError('CLI_ARGUMENT_INVALID', 1, 'batch/work/stage/commitの形式が不正です');
  }
  const typedStage = stage as BatchCommandStage;
  if (WORK_REQUIRED.has(typedStage) && work === undefined) {
    throw new BatchCommandError('BATCH_WORK_REQUIRED', 1, `${typedStage}には--workが必要です`, typedStage);
  }
  if (typedStage === 'all' && work === undefined) {
    throw new BatchCommandError('BATCH_WORK_REQUIRED', 1, 'allにはsource compositeの対象--workが必要です', typedStage);
  }
  if ((typedStage === 'prepare-release' || typedStage === 'release-verify') && commit === undefined) {
    throw new BatchCommandError('BATCH_COMMIT_REQUIRED', 1, `${typedStage}には--commitが必要です`, typedStage);
  }
  return {
    batchId: batch as BatchId,
    stage: typedStage,
    ...(work === undefined ? {} : { workId: work as WorkId }),
    ...(commit === undefined ? {} : { commit }),
  };
}

function checkedManifest(value: BatchManifest, batchId: BatchId): BatchManifest {
  const validated = validateBatchManifest(value);
  if (!validated.ok || validated.value.batchId !== batchId) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 1, 'dependencyが別batchまたは不正manifestを返しました');
  }
  return validated.value;
}

function workIndex(manifest: BatchManifest, workId: WorkId | undefined): number {
  if (workId === undefined) return -1;
  const index = manifest.workIds.indexOf(workId);
  if (index < 0) throw new BatchCommandError('BATCH_WORK_NOT_FOUND', 1, 'work IDがmanifestにありません');
  return index;
}

function hasStage(manifest: BatchManifest, stage: string, index: number): boolean {
  const aliases: Readonly<Record<string, readonly string[]>> = {
    rights: ['rights', 'rights-verified'],
    sources: ['sources', 'sources-fixed'],
    extract: ['extract', 'extracted'],
    normalize: ['normalize', 'extracted'],
    review: ['review', 'reviewed'],
    'capacity-forecast': ['capacity-forecast', 'budget-approved'],
    voice: ['voice', 'voiced'],
  };
  const accepted = aliases[stage] ?? [stage];
  return manifest.stageRecords.some((record) => accepted.includes(record.stage)) ||
    (index >= 0 && manifest.workProgress[index]?.stageRecords.some((record) => accepted.includes(record.stage)) === true);
}

function ensureWorkOrder(manifest: BatchManifest, index: number, stage: BatchCommandStage): void {
  if (index > 0 && manifest.workProgress[index - 1]?.status !== 'accepted') {
    throw new BatchCommandError('BATCH_WORK_ORDER_BLOCKED', exitCode(stage), '直前workがacceptedになるまで後続workを処理できません', stage);
  }
}

function ensurePrerequisite(manifest: BatchManifest, stage: ExecutableStage, index: number): void {
  const sourceIndex = stage === 'normalize' ? -1 : EARLY_STAGES.indexOf(stage);
  if (sourceIndex > 0 && !hasStage(manifest, EARLY_STAGES[sourceIndex - 1] as string, index)) {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', exitCode(stage), '前段stageのhash evidenceがありません', stage);
  }
  if (stage === 'review' && (index < 0 || manifest.workProgress[index]?.status !== 'extracted')) {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 4, 'reviewにはextracted workが必要です', stage);
  }
  if (stage === 'normalize' && (index < 0 || manifest.workProgress[index]?.status !== 'pending' ||
    (manifest.status !== 'rights-verified' && manifest.status !== 'sources-fixed'))) {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 3, 'normalize compositeにはrights確認済みのpending workが必要です', stage);
  }
  if (stage === 'capacity-forecast' && manifest.workProgress[index]?.status !== 'reviewed') {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 5, 'capacity forecastにはreviewed workが必要です', stage);
  }
  if (stage === 'voice' && manifest.workProgress[index]?.status !== 'budget-approved') {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 6, 'voiceにはbudget-approved workが必要です', stage);
  }
  if (stage === 'capacity-actual' && manifest.workProgress[index]?.status !== 'voiced') {
    throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 5, 'capacity actualにはvoiced workが必要です', stage);
  }
}

function assertStageAdvance(
  before: BatchManifest,
  next: BatchManifest,
  stage: ExecutableStage,
  workId: WorkId | undefined,
  execution: BatchStageExecution,
): void {
  if (hashBatchManifest(before) === hashBatchManifest(next)) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), 'stageがmanifestを進行させないno-opでした', stage);
  }
  const beforeIndex = workId === undefined ? -1 : before.workIds.indexOf(workId);
  const nextIndex = workId === undefined ? -1 : next.workIds.indexOf(workId);
  const beforeRecords = beforeIndex < 0 ? before.stageRecords : before.workProgress[beforeIndex]?.stageRecords ?? [];
  const nextRecords = nextIndex < 0 ? next.stageRecords : next.workProgress[nextIndex]?.stageRecords ?? [];
  if (nextRecords.length !== beforeRecords.length + 1 ||
    canonicalJson(nextRecords.slice(0, -1)) !== canonicalJson(beforeRecords)) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), 'stageは対象scopeへ新規evidenceを1件だけ追加する必要があります', stage);
  }
  const evidence = nextRecords.at(-1);
  if (!evidence || !hasStage(next, stage, nextIndex) || !evidence.inputHashes.includes(hashBatchManifest(before)) ||
    evidence.outputHashes.length === 0 || canonicalJson(evidence.inputHashes) !== canonicalJson(execution.inputHashes) ||
    canonicalJson(evidence.outputHashes) !== canonicalJson(execution.outputHashes) || evidence.count !== execution.count) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), 'stage evidenceのstage/input/output/count結合が不正です', stage);
  }
  const expectedWorkEdge: Partial<Record<ExecutableStage, readonly [string, string]>> = {
    extract: ['pending', 'extracted'],
    normalize: ['pending', 'extracted'],
    review: ['extracted', 'reviewed'],
    'capacity-forecast': ['reviewed', 'budget-approved'],
    voice: ['budget-approved', 'voiced'],
  };
  const edge = expectedWorkEdge[stage];
  if (edge && (beforeIndex < 0 || before.workProgress[beforeIndex]?.status !== edge[0] ||
    next.workProgress[nextIndex]?.status !== edge[1])) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), 'stageが正しいwork状態edgeを進行していません', stage);
  }
  const expectedBatchEdge: Partial<Record<ExecutableStage, readonly [string, string]>> = {
    rights: ['draft', 'rights-verified'],
    sources: ['rights-verified', 'sources-fixed'],
  };
  const batchEdge = expectedBatchEdge[stage];
  if (batchEdge && (before.status !== batchEdge[0] || next.status !== batchEdge[1])) {
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), 'stageが正しいbatch状態edgeを進行していません', stage);
  }
}

function result(
  stage: BatchCommandStage,
  manifest: BatchManifest,
  execution: BatchTerminalExecution,
  workId?: WorkId,
  extras: Partial<BatchCommandResult> = {},
): BatchCommandResult {
  const index = workId === undefined ? -1 : manifest.workIds.indexOf(workId);
  return {
    ok: true,
    code: 0,
    stage,
    status: 'completed',
    batchId: manifest.batchId,
    ...(workId === undefined ? {} : { workId }),
    inputHashes: execution.inputHashes,
    outputHashes: execution.outputHashes,
    count: execution.count,
    batchStatus: manifest.status,
    ...(index < 0 ? {} : { workStatus: manifest.workProgress[index]?.status }),
    ...(execution.forecastResult === undefined ? {} : { forecastResult: execution.forecastResult }),
    ...(execution.actualCapacityResult === undefined ? {} : { actualCapacityResult: execution.actualCapacityResult }),
    ...extras,
  };
}

async function executeNormal(
  workspace: string,
  manifest: BatchManifest,
  stage: ExecutableStage,
  workId: WorkId | undefined,
  dependencies: BatchDependencies,
): Promise<{ readonly manifest: BatchManifest; readonly execution: BatchStageExecution }> {
  const index = workIndex(manifest, workId);
  if (index >= 0) ensureWorkOrder(manifest, index, stage);
  ensurePrerequisite(manifest, stage, index);
  try {
    const execution = await dependencies.executeStage({ workspace, batchId: manifest.batchId, manifest, stage, ...(workId === undefined ? {} : { workId }) });
    const next = checkedManifest(execution.nextManifest, manifest.batchId);
    assertStageAdvance(manifest, next, stage, workId, execution);
    if (next.status === 'published') throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), '通常stageはpublishedへ遷移できません', stage);
    await dependencies.persistManifest({
      workspace,
      manifestPath: `content/batches/${manifest.batchId}/batch.json` as WorkspaceRelativePath,
      next,
      expectedSha256: hashBatchManifest(manifest),
    });
    return { manifest: next, execution };
  } catch (error) {
    if (error instanceof BatchCommandError) throw error;
    throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', exitCode(stage), error instanceof Error ? error.message : 'stage dependencyが失敗しました', stage);
  }
}

function manualGate(manifest: BatchManifest, workId: WorkId | undefined, gate: 'review' | 'accept'): BatchCommandResult {
  return result('all', manifest, { inputHashes: [], outputHashes: [], count: 0 }, workId, {
    status: 'awaiting_manual_gate',
    gate,
  });
}

/** @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-027 */
export async function runBatchCommand(
  argv: readonly string[],
  workspace: string,
  dependencies: BatchDependencies,
): Promise<BatchCommandResult> {
  const parsed = parseArguments(argv);
  let manifest = checkedManifest(await dependencies.loadManifest(workspace, parsed.batchId), parsed.batchId);
  const index = workIndex(manifest, parsed.workId);
  if (index >= 0) ensureWorkOrder(manifest, index, parsed.stage);

  if (parsed.stage === 'accept') {
    if (manifest.workProgress[index]?.status !== 'voiced') {
      throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 7, 'acceptにはvoiced workが必要です', 'accept');
    }
    try {
      const execution = await dependencies.acceptWork({ workspace, batchId: manifest.batchId, manifest, workId: parsed.workId as WorkId });
      manifest = execution.manifest === undefined ? manifest : checkedManifest(execution.manifest, manifest.batchId);
      return result('accept', manifest, execution, parsed.workId);
    } catch (error) {
      if (error instanceof BatchCommandError) throw error;
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 7, error instanceof Error ? error.message : 'accept transactionが失敗しました', 'accept');
    }
  }

  if (parsed.stage === 'prepare-release' || parsed.stage === 'release-verify') {
    if (manifest.workProgress.some((work) => work.status !== 'accepted') || manifest.status !== 'accepted') {
      throw new BatchCommandError('BATCH_STAGE_PREREQUISITE', 8, 'buildにはaccepted batchが必要です', parsed.stage);
    }
    const mode = parsed.stage === 'prepare-release' ? 'prepare' : 'release';
    if (!parsed.commit || !await dependencies.verifyCommit({ workspace, commit: parsed.commit, mode })) {
      throw new BatchCommandError('BATCH_COMMIT_MISMATCH', 8, 'commitがexact clean checkoutと一致しません', parsed.stage);
    }
    try {
      const request = { workspace, batchId: manifest.batchId, manifest, commit: parsed.commit, mode } as const;
      const execution = parsed.stage === 'prepare-release'
        ? await dependencies.prepareRelease(request)
        : await dependencies.verifyRelease(request);
      return result(parsed.stage, manifest, execution, undefined, { commit: parsed.commit });
    } catch (error) {
      if (error instanceof BatchCommandError) throw error;
      throw new BatchCommandError('BATCH_DEPENDENCY_FAILED', 8, error instanceof Error ? error.message : 'build dependencyが失敗しました', parsed.stage);
    }
  }

  if (parsed.stage !== 'all') {
    const executed = await executeNormal(workspace, manifest, parsed.stage, parsed.workId, dependencies);
    return result(parsed.stage, executed.manifest, executed.execution, parsed.workId);
  }

  for (const stage of ALL_COMPOSITE_STAGES) {
    const currentIndex = workIndex(manifest, parsed.workId);
    if (hasStage(manifest, stage, currentIndex)) continue;
    const executed = await executeNormal(workspace, manifest, stage, parsed.workId, dependencies);
    manifest = executed.manifest;
  }
  if (parsed.workId === undefined) throw new BatchCommandError('BATCH_WORK_REQUIRED', 1, 'allには--workが必要です', 'all');
  const refreshedIndex = workIndex(manifest, parsed.workId);
  const work = manifest.workProgress[refreshedIndex];
  if (!work || work.status === 'pending' || work.status === 'extracted') return manualGate(manifest, parsed.workId, 'review');
  if (work.status === 'accepted') return result('all', manifest, { inputHashes: [], outputHashes: [], count: 0 }, parsed.workId);
  for (const stage of ['capacity-forecast', 'voice', 'capacity-actual'] as const) {
    const currentIndex = workIndex(manifest, parsed.workId);
    if (hasStage(manifest, stage, currentIndex)) continue;
    const executed = await executeNormal(workspace, manifest, stage, parsed.workId, dependencies);
    manifest = executed.manifest;
  }
  return manualGate(manifest, parsed.workId, 'accept');
}

export function serializeBatchCommandResult(value: BatchCommandResult): string {
  return `${JSON.stringify(value)}\n`;
}
