import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deleteSafeWorkspaceFile,
  F005_NATIVE_GUARD_PINS,
  readSafeWorkspaceFile,
  renameSafeWorkspaceFile,
  resolveSafeWorkspaceFile,
  snapshotSafeWorkspaceFileCapability,
  verifyF005NativeGuardBuildEvidence,
  type F005NativeGuardBuildEvidence,
  type SafeFileHandle,
} from './f005-source.ts';

const PROJECT_ROOT = resolve('.');
const NATIVE_ROOT = join(PROJECT_ROOT, 'native', 'f005-guard');
const GUARD_EXE = join(PROJECT_ROOT, '.cache', 'dotnet-f005', 'publish', 'f005-guard.exe');
const temporaryDirectories: string[] = [];

interface GuardReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

class GuardClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly replies: Array<(value: GuardReply) => void> = [];

  constructor(
    args: readonly string[] = [],
    cwd: string = dirname(GUARD_EXE),
  ) {
    this.process = spawn(GUARD_EXE, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      const resolveReply = this.replies.shift();
      if (resolveReply) resolveReply(JSON.parse(line) as GuardReply);
    });
  }

  command(value: Readonly<Record<string, unknown>>): Promise<GuardReply> {
    return new Promise((resolveReply, reject) => {
      this.replies.push(resolveReply);
      this.process.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) reject(error);
      });
    });
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    await new Promise<void>((resolveExit, reject) => {
      this.process.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`guard exit ${code}`)));
      this.process.once('error', reject);
    });
  }

  async killAndWait(): Promise<void> {
    const exited = new Promise<void>((resolveExit, reject) => {
      this.process.once('exit', () => resolveExit());
      this.process.once('error', reject);
    });
    if (!this.process.kill()) throw new Error('guard kill failed');
    await exited;
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

beforeAll(async () => {
  await expect(readFile(GUARD_EXE)).resolves.not.toHaveLength(0);
});

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('F005 native Windows handle guard', () => {
  it('ETW callback例外を自由文字列/HRESULTなしの固定分類へ変換する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    expect(program).toContain(
      '? ClassifyEtwGuardFailure(guard.Code, eventName, callbackStage)',
    );
    expect(program).toContain('return $"ETW_FILE_IDENTITY_MISSING_{safeEvent}_{safeStage}"');
    expect(program).toContain('PoisonLocked(ClassifyEtwGuardFailure(');
    expect(program).toContain('var target = InspectDeferredRenameTarget(notice.To)');
    expect(program).toContain(
      'catch (GuardException error) when (error.Code == "ETW_FILE_IDENTITY_MISSING")',
    );
    expect(program).toContain('IOException => "ETW_CALLBACK_IO_FAILED"');
    expect(program).toContain('OverflowException => "ETW_CALLBACK_OVERFLOW"');
    expect(program).toContain('"JOURNAL" => "ETW_CALLBACK_JOURNAL_FAILED"');
    expect(program).toContain('"AUTHORIZATION" => "ETW_CALLBACK_AUTHORIZATION_FAILED"');
    expect(program).toContain('"PHASE" => "ETW_CALLBACK_PHASE_FAILED"');
    expect(program).toContain('_ => "ETW_CALLBACK_NORMALIZE_FAILED"');
    expect(program).not.toContain('ETW_OBSERVATION_FAILED_{error.HResult');
  });

  it('ETW callbackはidentityを即時捕捉し、journal永続化はdrain後のphase境界で行う', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const observe = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private static string ClassifyEtwGuardFailure('),
    );
    expect(observe).not.toContain('PersistJournal(');
    expect(program).toContain('private object EndPhaseAfterEtwDrain(');
    expect(program).toContain('Interlocked.Read(ref etwRelevantEventCount)');
    expect(program).toContain('Stopwatch.GetTimestamp()');
    expect(program).toContain('timestampQpc <= activePhase.StartedAtQpc');
    expect(program).toContain('PoisonLocked("ETW_EVENT_PHASE_TIMESTAMP_MISMATCH")');
    expect(program).toContain(
      'throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT")',
    );
  });

  it('Job所属はProcessSequenceNumberとQPC境界で同一process世代だけを認可する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const rootAlive = program.slice(
      program.indexOf('private bool RootWorkerAliveLocked('),
      program.indexOf('private void AssertRegisteredProcessesContained('),
    );
    const jobContains = program.slice(
      program.indexOf('public bool Contains(Process process)'),
      program.indexOf('public IReadOnlyList<int> MemberPids()'),
    );
    expect(rootAlive).not.toContain('HasExited');
    expect(jobContains).not.toContain('HasExited');
    expect(jobContains).toContain('IsAlive(process)');
    expect(program).toContain('WaitForSingleObject(process.Handle, 0) == WaitTimeout');
    expect(program).toContain('Dictionary<ulong, RegisteredWorkerProcess>');
    expect(program).toContain(
      'new RegisteredWorkerProcess(\n                pid,\n                process,\n                actualStartKey,\n                birth.ProcessSequenceNumber,\n                birth.StartedAtQpc)',
    );
    expect(program).toContain('rootWorkerStartKey != eventProcessStartKey');
    expect(program).toContain('actualStartKey != eventProcessStartKey');
    expect(program).toContain('ProcessTelemetryIdInformation = 64');
    expect(program).toContain('headerSize < 48 || headerSize > required');
    expect(program).toContain('Marshal.ReadInt64(buffer, 40)');
    expect(program).toContain('WaitForSingleObject(process.Handle, 0) == 0');
    expect(program).toContain('job.IsAliveOutsideJob(worker.Process)');
    expect(program).toContain('if (waitResult != WaitTimeout) return true');
    expect(program).toContain('TraceEventProcessIdentity.ProcessStartKey(data)');
    expect(program).toContain('etwSource.Registered.All += ObserveProcessBirth');
    expect(program).toContain('Dictionary<int, ProcessBirthRecord> processBirthByPid');
    expect(program).toContain('data.PayloadByName("ProcessSequenceNumber")');
    expect(program).toContain('actualIdentity.ProcessSequenceNumber != birth.ProcessSequenceNumber');
    expect(program).toContain('eventTimestampQpc <= birth.StartedAtQpc');
    expect(program).toContain('rejection = "BIRTH_MISSING"');
    expect(program).toContain('rejection = "EVENT_BEFORE_BIRTH"');
    expect(program).toContain('rejection = "PROCESS_UNAVAILABLE"');
    expect(program).toContain('rejection = "SEQUENCE_MISMATCH"');
    expect(program).toContain('ETW_PID_NOT_JOB_MEMBER_{authorizationFailure}');
    expect(program).toContain('filesByObject.ContainsKey(fileObject)');
    expect(program).toContain('"SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_"');
    expect(program.match(/SystemBoundFileObjectRejoinStage\(/gu)).toHaveLength(2);
    const observeEtw = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private void ObserveProcessIdentityProbeLocked('),
    );
    expect(observeEtw.match(/SystemBoundFileObjectRejoinStage\(/gu))
      .toHaveLength(1);
    expect(observeEtw.indexOf('lock (gate)'))
      .toBeLessThan(observeEtw.indexOf('SystemBoundFileObjectRejoinStage('));
    expect(observeEtw.indexOf('callbackStage = "AUTHORIZATION"'))
      .toBeLessThan(observeEtw.indexOf('SystemBoundFileObjectRejoinStage('));
    expect(observeEtw.indexOf('SystemBoundFileObjectRejoinStage('))
      .toBeLessThan(observeEtw.indexOf(
        'PoisonLocked($"ETW_PID_NOT_JOB_MEMBER_{authorizationFailure}")',
      ));
    expect(program).toContain('$"SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_{operationClass}_"');
    expect(program).toContain('"BIRTH_MISSING_BOUND_FILE_OBJECT"');
    expect(program).toContain('"create" => "CREATE"');
    expect(program).toContain('"delete" => "DELETE"');
    expect(program).toContain('SystemSetInfoDiagnosticRules.Classify(');
    expect(program).toContain('operationClass == "SETINFO"');
    expect(program).toContain(': "UNKNOWN_PATH")');
    expect(program).toContain('"NODE_MODULES"');
    expect(program).toContain('"UNBOUND_LEASE"');
    expect(program).toContain('"DONE_ID"');
    expect(program).toContain('"DONE_CHANGED"');
    expect(program).toContain('"DONE_MISSING"');
    expect(program.match(/completedWrites\.Clear\(\)/gu)).toHaveLength(2);
    expect(program).toContain('CompletedWriteDiagnosticRules.ShouldTrack(');
    expect(program).toContain('CompletedWriteDiagnosticRules.Classify(');
    expect(program).toContain('public static bool CanAuthorize(');
    expect(program).toContain('CompletedWriteDiagnosticRules.Rejection(');
    expect(program).toContain('CompletedWriteDiagnosticRules.AfterCompletionBucket(');
    expect(program).toContain('AFTER_COMPLETION_{bucket}');
    expect(program).toContain('ETW_COMPLETED_WRITE_REJOIN_{rejection}');
    expect(program.indexOf('SystemSetInfoCorrelationRules.MatchesReservation('))
      .toBeLessThan(program.indexOf('if (lease.FileObjectClosed)'));
    expect(program.indexOf('if (!AuthorizeJobMemberLocked('))
      .toBeLessThan(program.indexOf('if (TryAuthorizeReservedSystemSetInfoLocked('));
    expect(program.indexOf('if (TryAuthorizeReservedSystemSetInfoLocked('))
      .toBeLessThan(program.indexOf('else if (TryAuthorizeCompletedSystemSetInfoLocked('));
    expect(program.indexOf('else if (TryAuthorizeCompletedSystemSetInfoLocked('))
      .toBeLessThan(program.indexOf(
        'PoisonLocked($"ETW_PID_NOT_JOB_MEMBER_{authorizationFailure}")',
      ));
    expect(program).toContain('failureCode ??= code');
    expect(program).toContain('completedWrites[path] = new CompletedWriteRecord(');
    expect(program).toContain('timestampQpc > completed.ReservedAtQpc');
    expect(program).toContain('CompletedWriteDiagnosticRules.IsWithinCompletionWindow(');
    expect(program).toContain(
      '(decimal)eventTimestampQpc - completedAtQpc <= (decimal)frequency * 2',
    );
    expect(program).toContain('prior.RelativePath == normalized');
    expect(program).toContain('prior.Identity == completed.Identity');
    expect(program).toContain('current?.Identity == completed.Identity');
    expect(program).toContain('current?.Identity != systemSetInfoExpectedIdentity');
    expect(program).toContain('ClosedLeaseDiagnosticRules.Classify(');
    expect(program).toContain('ETW_CLOSED_LEASE_REJOIN_{stage}');
    expect(program).toContain('if (stage == "CANDIDATE")');
    expect(program).toContain('expectedIdentity = lease.Snapshot!.Identity');
    expect(program).toContain('ETW_CLOSED_LEASE_REJOIN_IDENTITY_MISMATCH');
    expect(program).toContain('SystemUnboundWriteKnownPathFailure(');
    expect(program.match(/SystemUnboundWriteKnownPathFailure\(/gu)).toHaveLength(2);
    expect(observeEtw.match(/SystemUnboundWriteKnownPathFailure\(/gu))
      .toHaveLength(1);
    expect(observeEtw.indexOf('lock (gate)'))
      .toBeLessThan(observeEtw.indexOf('SystemUnboundWriteKnownPathFailure('));
    expect(program).toContain('SystemUnboundWriteDiagnosticRules.Classify(');
    expect(program).toContain('LEASE_CLOSED_CANDIDATE');
    expect(program).toContain('LEASE_OPEN_CANDIDATE');
    const unboundWriteStage = program.slice(
      program.indexOf('private string SystemUnboundWriteKnownPathFailure('),
      program.indexOf('private string SystemBoundFileObjectRejoinStage('),
    );
    expect(unboundWriteStage.indexOf('if (fileObject == 0)'))
      .toBeLessThan(unboundWriteStage.indexOf('var lease = pendingWriteLease'));
    expect(unboundWriteStage.indexOf('if (lease!.Snapshot is null)'))
      .toBeLessThan(unboundWriteStage.indexOf('var current = TryInspect(normalized)'));
    expect(unboundWriteStage.indexOf('var current = TryInspect(normalized)'))
      .toBeLessThan(unboundWriteStage.indexOf('CompletedWriteDiagnosticState(normalized)'));
    expect(unboundWriteStage.match(/TryInspect\(normalized\)/gu)).toHaveLength(1);
    expect(unboundWriteStage).toContain(
      'if (completedStage != "OTHER_KNOWN_PATH")',
    );
    expect(unboundWriteStage).toContain(
      '"SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_"',
    );
    expect(unboundWriteStage).toContain('SystemSetInfoDiagnosticRules.Classify(');
    expect(unboundWriteStage).toContain(
      'if (bucket == "CACHE_OTHER_DIRECTORY_NO_LEASE")',
    );
    expect(unboundWriteStage).toContain(
      'if (bucket == "CACHE_OTHER_DIRECTORY_UNBOUND_LEASE")',
    );
    expect(unboundWriteStage).toContain(
      'if (bucket == "CACHE_OTHER_DIRECTORY_BOUND_LEASE")',
    );
    expect(unboundWriteStage).toContain(
      '"SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_"',
    );
    expect(unboundWriteStage).toContain(
      '"SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_"',
    );
    expect(program.match(/SystemDirectoryBoundLeaseWriteRejoinStage\(/gu))
      .toHaveLength(4);
    expect(unboundWriteStage.match(
      /SystemDirectoryBoundLeaseWriteRejoinStage\(\s*normalized,\s*timestampQpc\)/gu,
    )).toHaveLength(1);
    expect(unboundWriteStage).toContain(
      '"SYSTEM_DIRECTORY_WRITE_REJOIN_"',
    );
    const boundFileObjectStage = program.slice(
      program.indexOf('private string SystemBoundFileObjectRejoinStage('),
      program.indexOf(
        'private string SystemBoundFileObjectRenameLeasePathDiagnosticStage(',
      ),
    );
    expect(observeEtw.match(
      /SystemBoundFileObjectRejoinStage\(\s*normalized,\s*fileObject,\s*timestampQpc\)/gu,
    )).toHaveLength(1);
    const orderedBoundFileObjectChecks = [
      'filesByObject.TryGetValue(fileObject, out var snapshot)',
      'if (snapshot.RelativePath != normalized)',
      'var current = TryInspect(normalized)',
      'if (current is null)',
      'if (current.Identity != snapshot.Identity)',
      'var lease = pendingWriteLease',
      'if (lease is null)',
      'lease.PhaseInstanceId == activePhase.PhaseInstanceId',
      'if (!phaseMatches)',
      'if (lease.RelativePath != normalized)',
      'SystemBoundFileObjectRenameLeasePathDiagnosticStage(',
      'if (lease.FileObject != fileObject)',
      'if (lease.FileObjectClosed)',
      'job.IsAliveOutsideJob(lease.Process)',
    ];
    for (const runtimeCheck of orderedBoundFileObjectChecks) {
      expect(boundFileObjectStage.indexOf(runtimeCheck))
        .toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedBoundFileObjectChecks.length; index += 1) {
      expect(boundFileObjectStage.indexOf(orderedBoundFileObjectChecks[index - 1]!))
        .toBeLessThan(boundFileObjectStage.indexOf(orderedBoundFileObjectChecks[index]!));
    }
    expect(boundFileObjectStage.match(
      /job\.IsAliveOutsideJob\(lease\.Process\)/gu,
    )).toHaveLength(1);
    expect(boundFileObjectStage.match(
      /return SystemBoundFileObjectRejoinDiagnosticRules\.Classify\(/gu,
    )).toHaveLength(9);
    expect(boundFileObjectStage.match(
      /SystemBoundFileObjectRenameLeasePathDiagnosticStage\(/gu,
    )).toHaveLength(1);
    const renameLeasePathStage = program.slice(
      program.indexOf(
        'private string SystemBoundFileObjectRenameLeasePathDiagnosticStage(',
      ),
      program.indexOf(
        'private string SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticStage(',
      ),
    );
    const orderedRenameLeasePathChecks = [
      'var target = lease.PendingRenamePath',
      'if (target is null)',
      'string.Equals(normalized, target, StringComparison.Ordinal)',
      'var renameReservationQpc = lease.RenameReservedAtQpc',
      'if (renameReservationQpc is null or <= 0)',
      'renameReservationQpc.Value > lease.CurrentPathReservedAtQpc',
      'if (!reservationOrderValid)',
      'SystemBoundFileObjectRenameLeasePathDiagnosticRules.ClassifyTimeRelation(',
      'if (timeStage == "BEFORE_LEASE_RESERVATION")',
      'if (timeStage == "AFTER_LEASE_RESERVATION")',
      'var leaseCurrent = TryInspect(lease.RelativePath)',
      'if (leaseCurrent is not null)',
      'if (lease.Snapshot is null)',
      'lease.Snapshot.RelativePath != lease.RelativePath',
      'lease.Snapshot.Identity != observedSnapshot.Identity',
      'lease.FileObject != fileObject',
      'if (lease.FileObjectClosed)',
      'job.IsAliveOutsideJob(lease.Process)',
    ];
    for (const runtimeCheck of orderedRenameLeasePathChecks) {
      expect(renameLeasePathStage.indexOf(runtimeCheck))
        .toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedRenameLeasePathChecks.length; index += 1) {
      expect(renameLeasePathStage.indexOf(orderedRenameLeasePathChecks[index - 1]!))
        .toBeLessThan(renameLeasePathStage.indexOf(orderedRenameLeasePathChecks[index]!));
    }
    expect(renameLeasePathStage.match(
      /TryInspect\(lease\.RelativePath\)/gu,
    )).toHaveLength(1);
    expect(renameLeasePathStage.match(
      /job\.IsAliveOutsideJob\(lease\.Process\)/gu,
    )).toHaveLength(1);
    expect(renameLeasePathStage.match(
      /return SystemBoundFileObjectRenameLeasePathDiagnosticRules\.Classify\(/gu,
    )).toHaveLength(12);
    expect(renameLeasePathStage).toContain(
      'SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticStage(',
    );
    expect(renameLeasePathStage).not.toContain('"PATH_MISSING"');
    expect(boundFileObjectStage).toContain(
      'leasePathStage.StartsWith("NO_PENDING_", StringComparison.Ordinal)',
    );
    const noPendingStage = program.slice(
      program.indexOf(
        'private string SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticStage(',
      ),
      program.indexOf('private string SystemDirectoryWriteRejoinStage('),
    );
    const orderedNoPendingChecks = [
      'File.Exists(absolute)',
      'Directory.Exists(absolute)',
      'SystemDirectoryWriteRejoinStage(normalized)',
      'if (directoryStage != "CANDIDATE")',
      'ReferenceEquals(pendingWriteLease, lease)',
      "lease.RelativePath.LastIndexOf('/')",
      'lease.FileObjectClosed',
      'lease.FileObject is null',
      'lease.Snapshot is null',
      'filesByObject.GetValueOrDefault(lease.FileObject.Value)',
      'binding.RelativePath != lease.RelativePath',
      'TryInspect(lease.RelativePath)',
      'if (current is null)',
      'current.Identity != lease.Snapshot.Identity',
      'job.IsAliveOutsideJob(lease.Process)',
      'return Classify()',
    ];
    for (const runtimeCheck of orderedNoPendingChecks) {
      expect(noPendingStage.indexOf(runtimeCheck)).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedNoPendingChecks.length; index += 1) {
      expect(noPendingStage.indexOf(orderedNoPendingChecks[index - 1]!))
        .toBeLessThan(noPendingStage.indexOf(orderedNoPendingChecks[index]!));
    }
    expect(noPendingStage.indexOf('File.Exists(absolute)'))
      .toBeLessThan(noPendingStage.indexOf('SystemDirectoryWriteRejoinStage(normalized)'));
    expect(noPendingStage.indexOf('Directory.Exists(absolute)'))
      .toBeLessThan(noPendingStage.indexOf('SystemDirectoryWriteRejoinStage(normalized)'));
    expect(noPendingStage).toContain('Classify(leaseStateStable: false)');
    expect(noPendingStage).toContain('Classify(leaseCurrentExists: false)');
    expect(noPendingStage).toContain(
      'SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticRules.Classify(',
    );
    expect(noPendingStage).not.toContain('TryAuthorize');
    expect(noPendingStage).not.toContain('ObservationRecord');
    expect(noPendingStage).not.toContain('allocatedByIdentity');
    expect(noPendingStage).toContain('return "NO_PENDING_" +');
    expect(noPendingStage).toContain(
      'SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticStage(',
    );
    const unboundLeaseStage = program.slice(
      program.indexOf(
        'private string SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticStage(',
      ),
      program.indexOf('private string SystemDirectoryWriteRejoinStage('),
    );
    const orderedUnboundChecks = [
      'lease.Snapshot is not null',
      '.IsEventAfterReservation(',
      'TryInspect(lease.RelativePath)',
      'if (current is null)',
      'deferredSystemSetInfos.Count == 0',
      'deferredSystemSetInfos.Count != 1',
      'var deferred = deferredSystemSetInfos[0]',
      '.DeferredTupleMatches(',
      'current.Identity != deferred.Snapshot.Identity',
      'job.InspectRetainedProcess(lease.Process)',
      'processInspection.ProcessId == lease.WorkerPid',
      'processInspection.ProcessStartKey == lease.ProcessStartKey',
      'processInspection.ProcessSequenceNumber == lease.ProcessSequenceNumber',
      'if (processInspection.Signaled)',
      'if (!processInspection.JobMember)',
      'return Classify()',
    ];
    for (const runtimeCheck of orderedUnboundChecks) {
      expect(unboundLeaseStage.indexOf(runtimeCheck)).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedUnboundChecks.length; index += 1) {
      expect(unboundLeaseStage.indexOf(orderedUnboundChecks[index - 1]!))
        .toBeLessThan(unboundLeaseStage.indexOf(orderedUnboundChecks[index]!));
    }
    for (const tupleField of [
      'deferred.WorkerPid',
      'deferred.ProducerSequenceNumber',
      'deferred.Phase',
      'deferred.WorkId',
      'deferred.PhaseInstanceId',
      'deferred.RelativePath',
      'deferred.Snapshot.RelativePath',
      'deferred.FileObject',
      '!filesByObject.ContainsKey(deferred.FileObject)',
      'deferred.TimestampQpc',
      'lease.CurrentPathReservedAtQpc',
      'eventQpc',
    ]) {
      expect(unboundLeaseStage).toContain(tupleField);
    }
    expect(unboundLeaseStage).not.toContain('TryAuthorize');
    expect(unboundLeaseStage).not.toContain('BindReservedSystemSetInfoLocked');
    expect(unboundLeaseStage).not.toContain('ObservationRecord');
    expect(unboundLeaseStage).not.toContain('allocatedByIdentity');

    const retainedInspectionForUnbound = program.slice(
      program.indexOf('public RetainedProcessInspection InspectRetainedProcess('),
      program.indexOf('public ProcessIdentityRecord ProcessIdentity('),
    );
    expect(retainedInspectionForUnbound.indexOf('var identity = ProcessIdentity(process)'))
      .toBeLessThan(retainedInspectionForUnbound.indexOf(
        'WaitForSingleObject(process.Handle, 0)',
      ));
    expect(retainedInspectionForUnbound.indexOf('if (waitResult == 0)'))
      .toBeLessThan(retainedInspectionForUnbound.indexOf('IsProcessInJob('));
    expect(program).toContain('SystemDirectoryWriteRejoinDiagnosticRules.Classify(');
    expect(program).toContain(
      'SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(',
    );
    const activeLeaseDirectoryStage = program.slice(
      program.indexOf('private string SystemDirectoryActiveLeaseWriteRejoinStage('),
      program.indexOf('private string SystemDirectoryBoundLeaseWriteRejoinStage('),
    );
    const orderedRuntimeChecks = [
      'SystemDirectoryWriteRejoinStage(normalized)',
      'if (directoryStage != "CANDIDATE")',
      'var lease = pendingWriteLease',
      'if (lease is null)',
      'lease.PhaseInstanceId == activePhase.PhaseInstanceId',
      'if (!phaseMatches)',
      "lease.RelativePath.LastIndexOf('/')",
      'lease.RelativePath[..slash] == normalized',
      'if (!parentMatches)',
      'if (lease.FileObject is not null)',
      'if (lease.FileObjectClosed)',
      'job.IsAliveOutsideJob(lease.Process)',
    ];
    for (const runtimeCheck of orderedRuntimeChecks) {
      expect(activeLeaseDirectoryStage.indexOf(runtimeCheck))
        .toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedRuntimeChecks.length; index += 1) {
      expect(activeLeaseDirectoryStage.indexOf(orderedRuntimeChecks[index - 1]!))
        .toBeLessThan(activeLeaseDirectoryStage.indexOf(orderedRuntimeChecks[index]!));
    }
    expect(activeLeaseDirectoryStage.match(
      /job\.IsAliveOutsideJob\(lease\.Process\)/gu,
    )).toHaveLength(1);
    const boundLeaseDirectoryStage = program.slice(
      program.indexOf('private string SystemDirectoryBoundLeaseWriteRejoinStage('),
      program.indexOf('private string SystemDirectoryBoundLeaseRenameDiagnosticStage('),
    );
    const orderedBoundLeaseDirectoryChecks = [
      'SystemDirectoryWriteRejoinStage(normalized)',
      'if (directoryStage != "CANDIDATE")',
      'var lease = pendingWriteLease',
      'if (lease is null)',
      'lease.PhaseInstanceId == activePhase.PhaseInstanceId',
      'if (!phaseMatches)',
      "lease.RelativePath.LastIndexOf('/')",
      'lease.RelativePath[..slash] == normalized',
      'if (!parentMatches)',
      'if (lease.FileObjectClosed)',
      'if (lease.FileObject is null)',
      'if (lease.Snapshot is null)',
      'filesByObject.GetValueOrDefault(lease.FileObject.Value)',
      'if (binding is null)',
      'lease.Snapshot.RelativePath == lease.RelativePath',
      'binding.RelativePath == lease.RelativePath',
      'binding.Identity == lease.Snapshot.Identity',
      'if (!bindingMatches)',
      'var current = TryInspect(lease.RelativePath)',
      'if (current is null)',
      'if (current.Identity != lease.Snapshot.Identity)',
      'job.IsAliveOutsideJob(lease.Process)',
    ];
    for (const runtimeCheck of orderedBoundLeaseDirectoryChecks) {
      expect(boundLeaseDirectoryStage.indexOf(runtimeCheck))
        .toBeGreaterThanOrEqual(0);
    }
    for (
      let index = 1;
      index < orderedBoundLeaseDirectoryChecks.length;
      index += 1
    ) {
      expect(boundLeaseDirectoryStage.indexOf(
        orderedBoundLeaseDirectoryChecks[index - 1]!,
      )).toBeLessThan(boundLeaseDirectoryStage.indexOf(
        orderedBoundLeaseDirectoryChecks[index]!,
      ));
    }
    expect(boundLeaseDirectoryStage.match(
      /job\.IsAliveOutsideJob\(lease\.Process\)/gu,
    )).toHaveLength(1);
    expect(boundLeaseDirectoryStage.match(
      /return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules\.Classify\(/gu,
    )).toHaveLength(11);
    expect(boundLeaseDirectoryStage.match(
      /return "RENAME_" \+ SystemDirectoryBoundLeaseRenameDiagnosticStage\(/gu,
    )).toHaveLength(1);
    expect(program.match(/SystemDirectoryBoundLeaseRenameDiagnosticStage\(/gu))
      .toHaveLength(2);
    const boundLeaseRenameStage = program.slice(
      program.indexOf('private string SystemDirectoryBoundLeaseRenameDiagnosticStage('),
      program.indexOf('private string? NormalizeObservedPath('),
    );
    const orderedBoundLeaseRenameChecks = [
      'var target = lease.PendingRenamePath',
      'if (target is null)',
      "target.LastIndexOf('/')",
      'target[..slash] == normalized',
      'if (!parentMatches)',
      'var reservation = lease.RenameReservedAtQpc',
      'if (reservation is null or <= 0)',
      'timestampQpc > lease.CurrentPathReservedAtQpc',
      'if (!afterLeaseReservation)',
      'timestampQpc > reservation.Value',
      'if (!afterRenameReservation)',
      'var current = TryInspect(target)',
      'if (current is null)',
      'if (current.Identity != lease.Snapshot!.Identity)',
      'job.IsAliveOutsideJob(lease.Process)',
    ];
    for (const runtimeCheck of orderedBoundLeaseRenameChecks) {
      expect(boundLeaseRenameStage.indexOf(runtimeCheck))
        .toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedBoundLeaseRenameChecks.length; index += 1) {
      expect(boundLeaseRenameStage.indexOf(orderedBoundLeaseRenameChecks[index - 1]!))
        .toBeLessThan(boundLeaseRenameStage.indexOf(orderedBoundLeaseRenameChecks[index]!));
    }
    expect(boundLeaseRenameStage.match(
      /job\.IsAliveOutsideJob\(lease\.Process\)/gu,
    )).toHaveLength(1);
    expect(boundLeaseRenameStage.match(
      /return SystemDirectoryBoundLeaseRenameDiagnosticRules\.Classify\(/gu,
    )).toHaveLength(8);
    const directoryStage = program.slice(
      program.indexOf('private string SystemDirectoryWriteRejoinStage('),
      program.indexOf('private string? NormalizeObservedPath('),
    );
    expect(directoryStage.indexOf('var snapshot = filesByPath.GetValueOrDefault(normalized)'))
      .toBeLessThan(directoryStage.indexOf('var current = TryInspect(normalized)'));
    expect(directoryStage).toContain('item.EventName == "create"');
    expect(directoryStage).toContain('item.PhaseInstanceId == activePhase.PhaseInstanceId');
    expect(directoryStage).toContain('item.WorkerPid == rootPid');
    expect(directoryStage).toContain('item.ProducerSequenceNumber == rootSequence');
    expect(directoryStage.indexOf('if (!ownerMatches)'))
      .toBeLessThan(directoryStage.indexOf('RootWorkerAliveLocked(rootPid ?? -1)'));
    expect(directoryStage.match(/RootWorkerAliveLocked\(rootPid \?\? -1\)/gu))
      .toHaveLength(1);
    expect(program).toContain('TryAuthorizeKnownSystemDirectoryWriteLocked(');
    const directoryAuthorization = program.slice(
      program.indexOf('private bool TryAuthorizeKnownSystemDirectoryWriteLocked('),
      program.indexOf('private bool BindReservedSystemSetInfoLocked('),
    );
    expect(directoryAuthorization).toContain(
      'SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(',
    );
    expect(directoryAuthorization).toContain('stage == "CANDIDATE"');
    expect(directoryAuthorization).toContain(
      'bucket == "CACHE_OTHER_DIRECTORY_NO_LEASE"',
    );
    expect(directoryAuthorization).toContain(
      'expectedIdentity = filesByPath[normalized].Identity',
    );
    expect(program).toContain(
      'ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH',
    );
    const closedLeaseBlock = program.slice(
      program.indexOf('if (lease.FileObjectClosed)'),
      program.indexOf('if (lease.FileObject is null)'),
    );
    expect(closedLeaseBlock.indexOf('if (lease.Snapshot is null)'))
      .toBeLessThan(closedLeaseBlock.indexOf('TryInspect(normalized)'));
    expect(closedLeaseBlock.indexOf('if (!fileObjectCompatible)'))
      .toBeLessThan(closedLeaseBlock.indexOf('TryInspect(normalized)'));
    expect(new Set(program.match(
      /ETW_COMPLETED_WRITE_(?:REJOIN_\{rejection\}|[A-Z_]+)/gu,
    ) ?? [])).toEqual(new Set([
      'ETW_COMPLETED_WRITE_REJOIN_{rejection}',
      'ETW_COMPLETED_WRITE_REJOIN_IDENTITY_MISMATCH',
    ]));
    expect(program).not.toContain('WRITE_HISTORY_LIMIT');
    expect(new Set(program.match(
      /ETW_SYSTEM_SETINFO_CORRELATION_[A-Z_]+/gu,
    ) ?? [])).toEqual(new Set([
      'ETW_SYSTEM_SETINFO_CORRELATION_CREATE_BIND_MISMATCH',
      'ETW_SYSTEM_SETINFO_CORRELATION_CREATE_SNAPSHOT_MISSING',
      'ETW_SYSTEM_SETINFO_CORRELATION_CURRENT_MISSING',
      'ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_BIND_MISMATCH',
      'ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_CLEANUP',
      'ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_SNAPSHOT_MISSING',
      'ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_TUPLE_MISMATCH',
      'ETW_SYSTEM_SETINFO_CORRELATION_FILE_OBJECT_MISMATCH',
      'ETW_SYSTEM_SETINFO_CORRELATION_IDENTITY_MISMATCH',
      'ETW_SYSTEM_SETINFO_CORRELATION_LEASE_SNAPSHOT_MISSING',
      'ETW_SYSTEM_SETINFO_CORRELATION_RENAME_CONSUME',
    ]));
    expect(program).toContain('eventProcessStartKey != 0 &&');
    expect(program).toContain('22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716');
    expect(program).toContain('KernelProcessKeyword = 0x0000000000000010');
    expect(program).toContain('KernelProcessStartEventId = 1');
    expect(program).toContain('EventEnablePropertyProcessStartKey = 0x00000080');
    expect(program).toContain('SystemIoFileKeywords = 0x0000000000000414');
    expect(program).toContain('session.EnableProviderTimeoutMSec = 10_000');
    expect(program).toContain('session.EnableKernelProvider(KernelTraceEventParser.Keywords.None)');
    expect(program).not.toContain('if (!session.EnableProvider(');
    expect(program).toContain('DangerousGetHandleMethod.Invoke(sessionHandle, null)');
    expect(program).toContain('lock (session)');
    expect(program).not.toContain('is not SafeHandle sessionHandle');
    expect(program).toContain('EnableProviderTimeoutMilliseconds = 10_000');
    expect(program).toContain('catch (GuardException)');
    expect(program).toContain('ETW_PROCESS_START_KEY_PROBE_TIMEOUT');
    expect(program).toContain('if (!processIdentityProbed)');
    expect(program).not.toContain('EnableKernelProvider(\n                KernelTraceEventParser.Keywords.FileIO');
    expect(program).not.toContain('private static bool ProcessExists(');
    expect(program).toContain('var producerPid = PipePositiveInt(rootElement, "producerPid")');
    expect(program).toContain('using var producerProcess = job.OpenContainedProcess(producerPid)');
    expect(program).toContain('job.ProcessIdentity(producerProcess).ProcessSequenceNumber');
    expect(program).toContain('item.WorkerPid == producerPid');
    expect(program).toContain('item.ProducerSequenceNumber == producerSequenceNumber');
    expect(program).toContain('ProducerSequenceNumber == observation.ProducerSequenceNumber');
    const bridge = await readFile(resolve('src/content/f005-native-guard.ts'), 'utf8');
    expect(bridge).toContain('producerPid: notice.producerPid');
    expect(bridge).toContain('const producerPid = Number(hello.processId)');
    expect(bridge).toContain('Number(hello.processId) !== writer.process.pid');
  });

  it('AFTER_LEASE_RESERVATIONのdirectory writeは保存済みlease世代の完全tupleだけを再認可する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const observeEtw = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private void ObserveProcessIdentityProbeLocked('),
    );
    expect(observeEtw.indexOf(
      'TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(',
    )).toBeLessThan(observeEtw.lastIndexOf(
      'TryAuthorizeKnownSystemDirectoryWriteLocked(',
    ));
    expect(observeEtw).toContain('pid = leaseDirectoryPid;');
    expect(observeEtw).toContain(
      'producerSequenceNumber = leaseDirectorySequenceNumber;',
    );
    expect(observeEtw.indexOf('RecheckAfterLeaseDirectoryRejoinLocked('))
      .toBeLessThan(observeEtw.indexOf('var observation = new ObservationRecord('));

    const authorization = program.slice(
      program.indexOf(
        'private bool TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(',
      ),
      program.indexOf('private string? RecheckAfterLeaseDirectoryRejoinLocked('),
    );
    for (const check of [
      'stage != "RENAME_AFTER_LEASE_RESERVATION"',
      'filesByPath.GetValueOrDefault(normalized)?.Identity == directoryCurrent.Identity',
      'targetCurrent.Identity == leaseSnapshot.Identity',
      'binding.RelativePath == lease.RelativePath',
      'binding.Identity == leaseSnapshot.Identity',
      'job.InspectRetainedProcess(lease.Process)',
      'processInspection.ProcessId == lease.WorkerPid',
      'processInspection.ProcessStartKey == lease.ProcessStartKey',
      'processInspection.ProcessSequenceNumber == lease.ProcessSequenceNumber',
      '.IsCandidateTimestamp(',
      'producerPid = lease.WorkerPid;',
      'producerSequenceNumber = lease.ProcessSequenceNumber;',
    ]) {
      expect(authorization).toContain(check);
    }
    expect(authorization).toContain(
      'processInspection.Signaled,\n                processInspection.JobMember,\n                targetTupleMatches',
    );
    expect(authorization).toContain(
      'ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_PROCESS_OUTSIDE_JOB',
    );

    const recheck = program.slice(
      program.indexOf('private string? RecheckAfterLeaseDirectoryRejoinLocked('),
      program.indexOf('private bool BindReservedSystemSetInfoLocked('),
    );
    const orderedRechecks = [
      'TryInspect(context.DirectoryPath)',
      'TryInspect(context.LeasePath)',
      'TryInspect(context.PendingTargetPath)',
      'filesByObject.GetValueOrDefault(context.LeaseFileObject)',
    ];
    for (let index = 1; index < orderedRechecks.length; index += 1) {
      expect(recheck.indexOf(orderedRechecks[index - 1]!))
        .toBeLessThan(recheck.indexOf(orderedRechecks[index]!));
    }
    for (const suffix of [
      'DIRECTORY_IDENTITY_MISMATCH',
      'LEASE_CURRENT_EXISTS',
      'TARGET_IDENTITY_MISMATCH',
      'BINDING_MISMATCH',
    ]) {
      expect(recheck).toContain(
        `ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_${suffix}`,
      );
    }

    const retainedInspection = program.slice(
      program.indexOf('public RetainedProcessInspection InspectRetainedProcess('),
      program.indexOf('public ProcessIdentityRecord ProcessIdentity('),
    );
    expect(retainedInspection.indexOf('var identity = ProcessIdentity(process)'))
      .toBeLessThan(retainedInspection.indexOf('WaitForSingleObject(process.Handle, 0)'));
    expect(retainedInspection).toContain('throw new GuardException("PROCESS_WAIT_FAILED")');
    expect(retainedInspection).toContain('throw new GuardException("JOB_QUERY_FAILED")');
    expect(retainedInspection).toContain('identity.ProcessId');
  });

  it('bound lease directory CANDIDATEだけを二段process再検査付きで限定再結合する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const observeEtw = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private void ObserveProcessIdentityProbeLocked('),
    );
    expect(observeEtw.indexOf('TryAuthorizeBoundLeaseDirectoryWriteLocked('))
      .toBeLessThan(observeEtw.indexOf(
        'TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(',
      ));
    expect(observeEtw).toContain('var sequence = checked(++etwSequence)');
    const callbackApply = program.slice(
      program.indexOf('private void ApplyCallbackSnapshotLocked('),
      program.indexOf('private bool TryAuthorizeWriteCompletionDrainEventLocked('),
    );
    expect(callbackApply.indexOf('RecheckBoundLeaseDirectoryTupleLocked('))
      .toBeLessThan(callbackApply.indexOf('filesByObject[snapshot.FileObject]'));
    expect(callbackApply.indexOf('RecheckBoundLeaseDirectoryProcessLocked('))
      .toBeLessThan(callbackApply.indexOf('var observation = new ObservationRecord('));

    const authorization = program.slice(
      program.indexOf('private bool TryAuthorizeBoundLeaseDirectoryWriteLocked('),
      program.indexOf('private string? RecheckBoundLeaseDirectoryTupleLocked('),
    );
    const cheapAuthorization = authorization.slice(
      authorization.indexOf('.EvaluateCheapPredicates('),
      authorization.indexOf('if (!cheapPredicatesPass)'),
    );
    const orderedCheapChecks = [
      'authorizationFailure,',
      'pid,',
      'eventName,',
      'fileObject,',
      '!filesByObject.ContainsKey(fileObject)',
      'phase.Phase == "voice"',
      'lease.PhaseInstanceId == phase.PhaseInstanceId',
      'phase.StartedAtQpc,',
      'lease.CurrentPathReservedAtQpc,',
      'eventQpc,',
      'SystemDirectoryBoundLeaseWriteRejoinStage(',
      '== "CANDIDATE"',
      'lease.PendingRenamePath is null',
      'lease.RenameReservedAtQpc is null',
    ];
    for (const check of orderedCheapChecks) {
      expect(cheapAuthorization.indexOf(check)).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedCheapChecks.length; index += 1) {
      expect(cheapAuthorization.indexOf(orderedCheapChecks[index - 1]!))
        .toBeLessThan(cheapAuthorization.indexOf(orderedCheapChecks[index]!));
    }
    const orderedAuthorizationChecks = [
      'InitialTupleMatches(',
      'job.InspectRetainedProcess(lease.Process)',
      'processInspection.ProcessId == lease.WorkerPid',
      'processInspection.ProcessStartKey == lease.ProcessStartKey',
      'processInspection.ProcessSequenceNumber == lease.ProcessSequenceNumber',
      'producerPid = lease.WorkerPid',
      'producerSequenceNumber = lease.ProcessSequenceNumber',
    ];
    for (const check of orderedAuthorizationChecks) {
      expect(authorization.indexOf(check)).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedAuthorizationChecks.length; index += 1) {
      expect(authorization.indexOf(orderedAuthorizationChecks[index - 1]!))
        .toBeLessThan(authorization.indexOf(orderedAuthorizationChecks[index]!));
    }
    expect(authorization).not.toContain('lease.FileObject =');
    expect(authorization).not.toContain('BindReservedSystemSetInfoLocked');
    expect(authorization).not.toContain('allocatedByIdentity');

    const tupleRecheck = program.slice(
      program.indexOf('private string? RecheckBoundLeaseDirectoryTupleLocked('),
      program.indexOf('private string? RecheckBoundLeaseDirectoryProcessLocked('),
    );
    const orderedTupleRechecks = [
      'ReferenceEquals(phase, context.Phase)',
      'ReferenceEquals(lease, context.Lease)',
      'filesByObject.ContainsKey(eventFileObject)',
      'lease!.PendingRenamePath is null',
      'lease.RenameReservedAtQpc is null',
      'TryInspect(context.DirectoryPath)',
      'TryInspect(context.LeasePath)',
      'filesByObject.GetValueOrDefault(context.LeaseFileObject)',
    ];
    for (const check of orderedTupleRechecks) {
      expect(tupleRecheck.indexOf(check)).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedTupleRechecks.length; index += 1) {
      expect(tupleRecheck.indexOf(orderedTupleRechecks[index - 1]!))
        .toBeLessThan(tupleRecheck.indexOf(orderedTupleRechecks[index]!));
    }
    expect(tupleRecheck.match(/\.TupleRecheckFailure\(/gu)?.length)
      .toBeGreaterThanOrEqual(6);

    const tupleRecheckRule = program.slice(
      program.indexOf('public static string? TupleRecheckFailure('),
      program.indexOf('public static string InitialProcessFailureCode('),
    );
    const orderedTupleCodes = [
      'ACTIVE_LEASE_CHANGED',
      'EVENT_FILE_OBJECT_BOUND',
      'RENAME_STATE_CHANGED',
      'DIRECTORY_IDENTITY_MISMATCH',
      'LEASE_CURRENT_IDENTITY_MISMATCH',
      'BINDING_MISMATCH',
    ];
    for (const code of orderedTupleCodes) {
      expect(tupleRecheckRule).toContain(code);
    }
    for (let index = 1; index < orderedTupleCodes.length; index += 1) {
      expect(tupleRecheckRule.indexOf(orderedTupleCodes[index - 1]!))
        .toBeLessThan(tupleRecheckRule.indexOf(orderedTupleCodes[index]!));
    }

    const processRecheck = program.slice(
      program.indexOf('private string? RecheckBoundLeaseDirectoryProcessLocked('),
      program.indexOf('private bool TryAuthorizeAfterLeaseReservationDirectoryWriteLocked('),
    );
    expect(processRecheck).toContain(
      'job.InspectRetainedProcess(context.Lease.Process)',
    );
    expect(processRecheck.indexOf('processInspection.ProcessId'))
      .toBeLessThan(processRecheck.indexOf('ProcessRejection('));
    expect(processRecheck).not.toContain('ObservationRecord');
    expect(processRecheck).not.toContain('allocatedByIdentity');

    const retainedInspection = program.slice(
      program.indexOf('public RetainedProcessInspection InspectRetainedProcess('),
      program.indexOf('public ProcessIdentityRecord ProcessIdentity('),
    );
    expect(retainedInspection.indexOf('var identity = ProcessIdentity(process)'))
      .toBeLessThan(retainedInspection.indexOf('WaitForSingleObject(process.Handle, 0)'));
    expect(retainedInspection.indexOf('if (waitResult == 0)'))
      .toBeLessThan(retainedInspection.indexOf('IsProcessInJob('));

    expect(new Set(program.match(
      /ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_[A-Z_]+/gu,
    ) ?? [])).toEqual(new Set([
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_INITIAL_TUPLE_INSPECTION_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_IDENTITY_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_WAIT_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_JOB_QUERY_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_TUPLE_MISMATCH',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_SIGNALED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_OUTSIDE_JOB',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_ACTIVE_LEASE_CHANGED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_EVENT_FILE_OBJECT_BOUND',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_RENAME_STATE_CHANGED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_DIRECTORY_IDENTITY_MISMATCH',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_LEASE_CURRENT_IDENTITY_MISMATCH',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_BINDING_MISMATCH',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_IDENTITY_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_WAIT_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_JOB_QUERY_FAILED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_TUPLE_MISMATCH',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_SIGNALED',
      'ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_OUTSIDE_JOB',
    ]));
  });

  it('capacity-start応答前にnamed pipe instanceを同期生成する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const constructor = program.slice(
      program.indexOf('private CapacityGuardSession('),
      program.indexOf('public string Owner'),
    );
    expect(constructor.indexOf('var initialPipe = CreatePipeServer()'))
      .toBeLessThan(constructor.indexOf('Task.Run(() => PipeLoopAsync(initialPipe))'));
    expect(program).toContain('private async Task PipeLoopAsync(NamedPipeServerStream initialPipe)');
    expect(program).toContain('await using (var pipe = nextPipe)');
    expect(program).toContain('nextPipe = CreatePipeServer()');
    expect(constructor).toContain('initialPipe.Dispose()');
    expect(program).toContain('Poison("IPC_PEER_IDENTITY_UNAVAILABLE");\n                        return;');
    expect(program).toContain('while (true)');
  });

  it('write completionをprivate sealed epochでprepareしてexactly-once drainする', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const bridge = await readFile(resolve('src/content/f005-native-guard.ts'), 'utf8');
    const commit = bridge.slice(
      bridge.indexOf('commit: async (): Promise<void> =>'),
      bridge.indexOf('abort: async (): Promise<void> =>'),
    );
    for (const token of [
      "op: 'prepareWriteCompletion'",
      "op: 'write-commit'",
      'await writer.close()',
      "op: 'completeWrite'",
    ]) expect(commit).toContain(token);
    expect(commit.indexOf("op: 'prepareWriteCompletion'"))
      .toBeLessThan(commit.indexOf("op: 'write-commit'"));
    expect(commit.indexOf("op: 'write-commit'"))
      .toBeLessThan(commit.indexOf('await writer.close()'));
    expect(commit.indexOf('await writer.close()'))
      .toBeLessThan(commit.indexOf("op: 'completeWrite'"));
    expect(commit).toContain("'ok,sealSequence,state'");

    const dispatch = program.slice(
      program.indexOf('private object DispatchPipe('),
      program.indexOf('private void Authenticate('),
    );
    expect(dispatch).toContain('case "prepareWriteCompletion":');
    expect(dispatch).toContain(
      '"authToken", "op", "path", "phase", "phaseInstanceId", "producerPid", "sessionNonce", "workId"',
    );
    const prepareDispatch = dispatch.slice(
      dispatch.indexOf('if (operation == "prepareWriteCompletion")'),
      dispatch.indexOf('lock (gate)', dispatch.indexOf('if (operation == "prepareWriteCompletion")') + 1) +
        'lock (gate)'.length,
    );
    expect(prepareDispatch.indexOf('callbackAdmission.EnterFinal()'))
      .toBeLessThan(prepareDispatch.lastIndexOf('lock (gate)'));
    const genericDispatch = dispatch.slice(
      dispatch.lastIndexOf('lock (gate)'),
    );
    expect(genericDispatch).not.toContain('"prepareWriteCompletion" =>');
    const prepare = program.slice(
      program.indexOf('private object PrepareWriteCompletion('),
      program.indexOf('private WriteCompletionDrainSeal RequestWriteCompletionLocked('),
    );
    expect(prepare).toContain('state = "completion-drain-prepared"');
    expect(prepare).toContain('sealSequence = seal.SealSequence');
    expect(prepare).toContain('MaxWriteCompletionSeals');
    expect(prepare).toContain('job.InspectRetainedProcess(lease.Process)');
    expect(prepare).toContain('item.EventName == "create"');
    expect(prepare).toContain('item.WorkerPid == rootWorkerPid');
    expect(prepare).toContain(
      'item.ProducerSequenceNumber == rootWorkerSequenceNumber',
    );
    expect(prepare).toContain('job.InspectRetainedProcess(rootWorkerProcess)');
    expect(program).toContain('MaxWriteCompletionEventsPerSeal = 64');
    expect(program).toContain('MaxWriteCompletionEventsPerPhase = 8_192');
    expect(program).toContain('finally\n        {\n            if (relevantCallback)');
    expect(program).toContain('Interlocked.Add(\n                    ref etwAccountedEventCount,');
    expect(program).toContain('WriteCompletionDrainRules.AccountedDelta(terminal)');
    expect(program).toContain('WriteCompletionDrainRules.CountersStable(');
    expect(program).toContain('long expectedRelevant,');
    expect(program).toContain('long expectedAccounted)');
    expect(program).toContain('WriteCompletionDrainState.CompletedRetained');
    expect(program).toContain('WriteCompletionDrainState.Released');
    const queueOrApply = program.slice(
      program.indexOf('private string QueueOrApplyCallbackLocked('),
      program.indexOf('private void ApplyCallbackSnapshotLocked('),
    );
    expect(queueOrApply).toContain('activeSealedCandidate');
    expect(queueOrApply).toContain('WriteCompletionDrainState.Prepared');
    expect(queueOrApply).toContain('WriteCompletionDrainState.CompletionRequested');
    for (const forbidden of [
      'filesByObject[',
      'filesByPath[',
      'allocatedByIdentity[',
      'peakLiveBytes =',
      'minimumObservedFreeBytes =',
      'pending.Match(',
      'observations.Add(',
    ]) expect(queueOrApply).not.toContain(forbidden);
    const apply = program.slice(
      program.indexOf('private void ApplyCallbackSnapshotLocked('),
      program.indexOf('private bool TryAuthorizeWriteCompletionDrainEventLocked('),
    );
    expect(apply).toContain('snapshot.BindingProof is not null');
    expect(apply).toContain('retained.Reinspect(snapshot.Effective.Identity)');
    expect(apply.indexOf('live = checked('))
      .toBeLessThan(apply.indexOf('filesByObject['));
    expect(apply.indexOf('allocatedByIdentity['))
      .toBeLessThan(apply.indexOf('new ObservationRecord('));
    expect(apply.indexOf('new ObservationRecord('))
      .toBeLessThan(apply.indexOf('observations.Add(observation)'));
    const complete = program.slice(
      program.indexOf('private object? CompleteWrite('),
      program.indexOf('private bool ReplayWriteCompletionQueueLocked('),
    );
    expect(complete.indexOf('FindCompletionSealLocked('))
      .toBeLessThan(complete.indexOf('WriteCompletionDrainRules.CountersStable('));
    expect(complete).not.toContain('TryInspect(');
    expect(complete).not.toContain('filesByObject');
    expect(complete).toContain('seal.RetainedParent.Reinspect(');
    expect(program).toContain(
      'if (snapshot.SealSequence is not null)\n            RecheckSealedCallbackLocked(snapshot)',
    );
    expect(program).not.toContain(
      'snapshot.SealSequence is not null && snapshot.BindingProof is null',
    );
    expect(complete).toContain('seal.RetainedCurrent.Reinspect(');
    expect(complete).toContain('writeCompletionBindingLedger.MatchesGeneration(');
    expect(complete).not.toContain('ValidateWriteLeaseTuple(');
    expect(complete).toContain('if (ReplayWriteCompletionQueueLocked()) return null;');
    expect(complete.indexOf('WriteCompletionDrainRules.CanMutateFinalState('))
      .toBeLessThan(complete.indexOf('completedWrites[path] ='));
    expect(complete.indexOf('WriteCompletionDrainRules.CanMutateFinalState('))
      .toBeLessThan(complete.indexOf('TransitionWriteCompletionSealLocked('));
    expect(complete.indexOf('WriteCompletionDrainRules.CanMutateFinalState('))
      .toBeLessThan(complete.indexOf('pendingWriteLease = null'));
    expect(program).toContain('if (completed is not null) return completed;');
    const completeDrain = program.slice(
      program.indexOf('private object CompleteWriteAfterEtwDrain('),
      program.indexOf('private object PrepareWriteCompletion('),
    );
    expect(completeDrain.indexOf('using (callbackAdmission.EnterFinal())'))
      .toBeLessThan(completeDrain.indexOf('lock (gate)', completeDrain.indexOf('using (callbackAdmission.EnterFinal())')));
    const endPhase = program.slice(
      program.indexOf('private object? EndPhase('),
      program.indexOf('private object EndPhaseAfterEtwDrain('),
    );
    expect(endPhase.indexOf('WriteCompletionDrainRules.CanMutateFinalState('))
      .toBeLessThan(endPhase.indexOf('TransitionWriteCompletionSealLocked('));
    expect(endPhase.indexOf('WriteCompletionDrainRules.CanMutateFinalState('))
      .toBeLessThan(endPhase.indexOf('activePhase = null'));
    const observeAdmission = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private string QueueOrApplyCallbackLocked('),
    );
    expect(observeAdmission.indexOf('callbackAdmission.EnterCallback()'))
      .toBeLessThan(observeAdmission.indexOf('NormalizeObservedPath(eventPath)'));
    expect(observeAdmission.indexOf('Interlocked.Add('))
      .toBeLessThan(observeAdmission.indexOf('callbackAdmissionLease?.Dispose()'));
    const admission = program.slice(
      program.indexOf('public sealed class WriteCompletionCallbackAdmission'),
      program.indexOf('public static class WriteCompletionDrainRules'),
    );
    expect(admission).toContain('ReaderWriterLockSlim');
    expect(admission).toContain('public IDisposable EnterCallback()');
    expect(admission).toContain('public IDisposable EnterFinal()');
    expect(program).toContain('callbackAdmission.Dispose();');
    const sealedRecheck = program.slice(
      program.indexOf('private void RecheckSealedCallbackLocked('),
      program.indexOf('private void ApplyRenameSnapshotLocked('),
    );
    for (const required of [
      'item.SealSequence == snapshot.SealSequence',
      'WriteCompletionDrainRules.IsWithinEpoch(',
      'WriteCompletionDrainRules.IsWithinPostRequestEpoch(',
      'snapshot.ReplayKind == WriteCompletionReplayKind.PostRequestSystemSetInfo',
      '!completedWrites.ContainsKey(snapshot.NormalizedPath)',
      'proof?.StateBefore is WriteCompletionBindingState.Bound or',
      'proof?.Path == seal.CurrentPath',
      'proof.GenerationBefore != seal.LeaseFileObjectGeneration',
      'seal.RetainedCurrent.Reinspect(snapshot.Effective.Identity)',
      'seal.RetainedParent.Reinspect(snapshot.Effective.Identity)',
      'job.InspectRetainedProcess(seal.Lease.Process)',
      'inspection.ProcessSequenceNumber != seal.ProcessSequenceNumber',
      '!inspection.Signaled',
    ]) expect(sealedRecheck).toContain(required);
    expect(sealedRecheck.indexOf('F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_TUPLE_MISMATCH'))
      .toBeLessThan(sealedRecheck.indexOf('identity != snapshot.Effective.Identity'));
    expect(sealedRecheck.indexOf('identity != snapshot.Effective.Identity'))
      .toBeLessThan(sealedRecheck.indexOf('F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED'));
    expect(program).toContain('callbackTerminal = QueueOrApplyCallbackLocked(\n                        renameSnapshot');
    const prepareCompletion = program.slice(
      program.indexOf('private object PrepareWriteCompletion('),
      program.indexOf('private WriteCompletionDrainSeal RequestWriteCompletionLocked('),
    );
    expect(prepareCompletion).toContain('item.VolumeId == directorySnapshot?.VolumeId');
    expect(prepareCompletion).toContain('item.FileId128 == directorySnapshot?.FileId128');
    const endPhaseDrain = program.slice(
      program.indexOf('private object EndPhaseAfterEtwDrain('),
      program.indexOf('private void ObserveEtw('),
    );
    expect(endPhaseDrain.match(/EnsureActiveWriteCompletionDeadlineLocked\(/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    const lateLookup = program.slice(
      program.indexOf('private bool TryAuthorizeWriteCompletionDrainEventLocked('),
      program.indexOf('private bool TryAuthorizeReservedSystemSetInfoLocked('),
    );
    expect(lateLookup).not.toContain('TryInspect(');
    expect(lateLookup).not.toContain('filesByObject');
    expect(lateLookup).toContain('ledger.MatchesGeneration(');
    expect(lateLookup).toContain('ledger.IsUnbound(fileObject)');
    expect(lateLookup).toContain(
      'LateDiagnosticSetInfoSealNotCompletedRetainedFailureCode',
    );
    expect(lateLookup).toContain('CanAuthorizePostRequestSystemSetInfo(');
    expect(lateLookup).toContain('!completedWrites.ContainsKey(normalized)');
    expect(lateLookup).toContain(
      'replayKind = WriteCompletionReplayKind.PostRequestSystemSetInfo',
    );
    const forget = program.slice(
      program.indexOf('private void ForgetFileObject('),
      program.indexOf('private void ObserveUnknownEtw('),
    );
    expect(forget.indexOf('callbackAdmission.EnterCallback()'))
      .toBeLessThan(forget.indexOf('.AdmitCleanup(fileObject)'));
    expect(forget).toContain('writeCompletionCleanupRelevantCount');
    expect(forget).toContain('writeCompletionCleanupAccountedCount');
    const deferredCleanup = forget.slice(
      forget.indexOf('if (writeCompletionReorderActive)'),
      forget.indexOf('else', forget.indexOf('if (writeCompletionReorderActive)')),
    );
    expect(deferredCleanup).toContain('writeCompletionReplayStore.AddCleanup(');
    expect(deferredCleanup).toContain('return;');
    expect(deferredCleanup).not.toContain('ApplyCleanupSemanticLocked(');
    const replayQueue = program.slice(
      program.indexOf('private bool ReplayWriteCompletionQueueLocked('),
      program.indexOf('private PendingWriteLease ValidateWriteLeaseTuple('),
    );
    expect(replayQueue).toContain('return writeCompletionReplayStore.Replay(');
    expect(replayQueue).toContain('PreflightCallbackSnapshotLocked');
    expect(replayQueue).toContain('PreflightCapacityBatchLocked');
    expect(replayQueue).toContain('ApplyPreflightedCallbackSnapshotLocked');
    expect(replayQueue).toContain('RestoreCompletionSemanticCheckpointLocked');
    const replayStore = program.slice(
      program.indexOf('internal sealed class WriteCompletionReplayStore<'),
      program.indexOf('public sealed class WriteCompletionBindingLedger'),
    );
    expect(replayStore.indexOf('ledger.Validate(proofs)'))
      .toBeLessThan(replayStore.indexOf('preflightSnapshot(snapshot)'));
    expect(replayStore.indexOf('preflightSnapshot(snapshot)'))
      .toBeLessThan(replayStore.indexOf('preflightCapacity(pending)'));
    expect(replayStore.indexOf('preflightCapacity(pending)'))
      .toBeLessThan(replayStore.indexOf('captureCheckpoint()'));
    expect(replayStore.indexOf('captureCheckpoint()'))
      .toBeLessThan(replayStore.indexOf('WriteCompletionAtomicBatchRules.Execute('));
    expect(replayStore.indexOf('ledger.ValidateAndCommit(proofs)'))
      .toBeLessThan(replayStore.indexOf('Snapshots.Clear()'));
    expect(replayStore).toContain('rollback(checkpoint)');
    for (const bound of [
      'Snapshots.Count >= maximumSnapshots',
      'Cleanups.Count >= maximumCleanups',
      'GenerationHandles.Count >= maximumGenerationHandles',
      'F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT',
    ]) expect(replayStore).toContain(bound);
    const immutableRejoin = program.slice(
      program.indexOf('private void PreflightImmutableRejoinLocked('),
      program.indexOf('private void PreflightRenameSnapshotLocked('),
    );
    const preflightContextExclusion = immutableRejoin.indexOf(
      'WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(',
    );
    const preflightProofRead = immutableRejoin.indexOf(
      'var proof = snapshot.BindingProof!;',
    );
    const preflightAfterContext = immutableRejoin.indexOf(
      'if (snapshot.AfterLeaseDirectoryRejoin is { } afterLease)',
    );
    const preflightBoundContext = immutableRejoin.indexOf(
      'if (snapshot.BoundLeaseDirectoryRejoin is { } boundLease)',
    );
    expect(preflightContextExclusion).toBeGreaterThan(-1);
    expect(preflightContextExclusion).toBeLessThan(preflightProofRead);
    expect(preflightProofRead).toBeLessThan(preflightAfterContext);
    expect(preflightContextExclusion).toBeLessThan(preflightBoundContext);
    const preflightExclusiveReject = immutableRejoin.slice(
      preflightContextExclusion,
      preflightProofRead,
    );
    expect(preflightExclusiveReject).toContain(
      'F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED',
    );
    expect(preflightExclusiveReject).not.toContain(
      'RecheckAfterLeaseDirectoryProcessLocked(',
    );
    expect(preflightExclusiveReject).not.toContain(
      'RecheckBoundLeaseDirectoryProcessLocked(',
    );
    for (const mutation of [
      'filesByObject',
      'filesByPath',
      'allocatedByIdentity',
      'pendingWriteLease =',
      'writeCompletionReorderQueue.',
      'notices.',
      'observations.',
      'peakLiveBytes =',
      'minimumObservedFreeBytes =',
    ]) expect(preflightExclusiveReject).not.toContain(mutation);
    expect(immutableRejoin).toContain('proof.Kind == WriteCompletionBindingKind.OtherBound');
    expect(immutableRejoin).toContain('RecheckAfterLeaseDirectoryProcessLocked(afterLease)');
    expect(immutableRejoin).toContain('RecheckBoundLeaseDirectoryProcessLocked(boundLease)');
    expect(immutableRejoin).not.toContain('TryInspect(');
    expect(immutableRejoin).not.toContain('filesByObject');
    expect(immutableRejoin).not.toContain('filesByPath');
    const boundProcessRecheck = program.slice(
      program.indexOf('private string? RecheckBoundLeaseDirectoryProcessLocked('),
      program.indexOf('private bool TryAuthorizeAfterLeaseReservationDirectoryWriteLocked('),
    );
    expect(boundProcessRecheck).toContain('job.InspectRetainedProcess(context.Lease.Process)');
    expect(boundProcessRecheck).not.toContain('TryInspect(');
    expect(boundProcessRecheck).not.toContain('filesByObject');
    expect(boundProcessRecheck).not.toContain('filesByPath');
    const afterProcessRecheck = program.slice(
      program.indexOf('private string? RecheckAfterLeaseDirectoryProcessLocked('),
      program.indexOf('private bool BindReservedSystemSetInfoLocked('),
    );
    expect(afterProcessRecheck).toContain('job.InspectRetainedProcess(context.Process)');
    expect(afterProcessRecheck).toContain('inspection.ProcessId != context.ProducerPid');
    expect(afterProcessRecheck).toContain(
      'inspection.ProcessStartKey != context.ProcessStartKey',
    );
    expect(afterProcessRecheck).toContain(
      'inspection.ProcessSequenceNumber != context.ProducerSequenceNumber',
    );
    expect(afterProcessRecheck).toContain('!inspection.Signaled && !inspection.JobMember');
    expect(afterProcessRecheck).not.toContain('TryInspect(');
    expect(afterProcessRecheck).not.toContain('filesByObject');
    const applyCore = program.slice(
      program.indexOf('private void ApplyCallbackSnapshotCoreLocked('),
      program.indexOf('private void ReinspectImmediateSnapshot('),
    );
    const contextExclusion = applyCore.indexOf(
      'WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(',
    );
    const afterTupleRecheck = applyCore.indexOf(
      'RecheckAfterLeaseDirectoryRejoinLocked(',
    );
    const afterProcessRecheckIndex = applyCore.indexOf(
      'RecheckAfterLeaseDirectoryProcessLocked(',
    );
    const boundTupleRecheck = applyCore.indexOf(
      'RecheckBoundLeaseDirectoryTupleLocked(',
    );
    const boundProcessRecheckIndex = applyCore.indexOf(
      'RecheckBoundLeaseDirectoryProcessLocked(',
    );
    const capacityRead = applyCore.indexOf('long oldAllocated;');
    expect(contextExclusion).toBeGreaterThan(-1);
    expect(contextExclusion).toBeLessThan(afterTupleRecheck);
    const applyExclusiveReject = applyCore.slice(
      contextExclusion,
      applyCore.indexOf(
        'if (snapshot.AfterLeaseDirectoryRejoin is not null)',
        contextExclusion + 1,
      ),
    );
    expect(applyExclusiveReject.trim()).toBe(preflightExclusiveReject.trim());
    expect(afterTupleRecheck).toBeLessThan(afterProcessRecheckIndex);
    expect(afterProcessRecheckIndex).toBeLessThan(capacityRead);
    expect(boundTupleRecheck).toBeLessThan(boundProcessRecheckIndex);
    expect(boundProcessRecheckIndex).toBeLessThan(capacityRead);
    expect(applyCore).not.toContain(
      'snapshot.BindingProof is null && snapshot.AfterLeaseDirectoryRejoin',
    );
    expect(applyCore).not.toContain(
      'snapshot.BindingProof is null && snapshot.BoundLeaseDirectoryRejoin',
    );
    const preflightedApply = program.slice(
      program.indexOf('private void ApplyPreflightedCallbackSnapshotLocked('),
      program.indexOf('private void ApplyCallbackSnapshotCoreLocked('),
    );
    expect(preflightedApply).toContain('ApplyCallbackSnapshotCoreLocked(snapshot, preflighted: true)');
    expect(preflightedApply).not.toContain('RecheckSealedCallbackLocked(');
    expect(preflightedApply).not.toContain('TryInspect(');
    const ledger = program.slice(
      program.indexOf('public sealed class WriteCompletionBindingLedger'),
      program.indexOf('public static class WriteCompletionDrainRules'),
    );
    expect(ledger).toContain('value.State == WriteCompletionBindingState.Unbound');
    expect(ledger).toContain('if (before.CleanupSeen || before.Reused)');
    expect(ledger).toContain('canonical != proof');
    expect(ledger).toContain('throw new WriteCompletionBufferLimitException()');
    expect(ledger).toContain('applied = shadow;');
    expect(program).toContain('public sealed class WriteCompletionBindingLedger');
    expect(program).toContain('public sealed record ImmutableBindingProof(');
    expect(program).toContain('long ProofSequence,');
    expect(program).toContain('public long AdmissionHead { get; private set; }');
    expect(program).toContain('public long AppliedCursor { get; private set; }');
    expect(program).toContain('MaximumEntries = 8_192');
    expect(program).toContain('MaxWriteCompletionRetainedHandles = 8_448');
    expect(program).toContain('0x02000000 | 0x00200000');
    const capacityError = program.indexOf(
      'private static object Error(',
      program.indexOf('sealed class CapacityGuardSession'),
    );
    const dispose = program.slice(
      program.lastIndexOf('public void Dispose()', capacityError),
      capacityError,
    );
    expect(dispose).toContain('writeCompletionSeals');
    expect(dispose).toContain('ReferenceEquals(item, seal.Lease.Process)');
    expect(dispose).toContain('retained.Dispose()');
    expect(program).not.toContain('CreateWriteCompletionSealForTest');
    expect(program).not.toContain('InjectWriteCompletionEvent');
  });

  it('write予約前ProcessStart fenceはgateを解放して有限待機し成功後だけleaseを公開する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const reserveWrite = program.slice(
      program.indexOf('private object ReserveWrite('),
      program.indexOf('private ProcessBirthRecord WaitForProducerBirthLocked('),
    );
    expect(reserveWrite.indexOf('var identity = job.ProcessIdentity(process);'))
      .toBeLessThan(reserveWrite.indexOf('WaitForProducerBirthLocked('));
    expect(reserveWrite.indexOf('WaitForProducerBirthLocked('))
      .toBeLessThan(reserveWrite.indexOf('var reservedAtQpc = Stopwatch.GetTimestamp();'));
    expect(reserveWrite.indexOf('var reservedAtQpc = Stopwatch.GetTimestamp();'))
      .toBeLessThan(reserveWrite.indexOf('new ObservedProducerBirthSnapshot('));
    expect(reserveWrite.indexOf('new ObservedProducerBirthSnapshot('))
      .toBeLessThan(reserveWrite.indexOf(
        'producerBirthSnapshot => new PendingWriteLease(',
      ));
    expect(reserveWrite.indexOf('producerBirthSnapshot => new PendingWriteLease('))
      .toBeLessThan(reserveWrite.indexOf('lease => pendingWriteLease = lease'));
    expect(reserveWrite.match(/var reservedAtQpc = Stopwatch\.GetTimestamp\(\);/gu))
      .toHaveLength(1);
    expect(reserveWrite).toContain('birth.StartedAtQpc > reservedAtQpc');
    expect(reserveWrite).not.toContain('etwSession.Flush');
    expect(reserveWrite).toContain('identity = job.ProcessIdentity(process);');
    expect(reserveWrite).toContain('catch (GuardException error)');
    expect(reserveWrite).not.toContain('catch (Exception error)');
    expect(reserveWrite).toContain('.NormalizeProcessIdentityGuardFailureCode(error.Code)');
    expect(reserveWrite).toContain('new WriteLeaseReservationTransaction()');
    expect(reserveWrite).toContain('reservationTransaction.FenceFailure(error.Code)');

    const waitFence = program.slice(
      program.indexOf('private ProcessBirthRecord WaitForProducerBirthLocked('),
      program.indexOf('private ProducerBirthFingerprint ProducerBirthFingerprintLocked('),
    );
    const abortCheck = waitFence.indexOf('ThrowIfProducerBirthWaitAbortedLocked();');
    const deadlineCheck = waitFence.indexOf(
      'WriteLeaseProducerBirthFenceRules.IsDeadlineReached(',
    );
    const fingerprintCheck = waitFence.indexOf(
      'WriteLeaseProducerBirthFenceRules.FingerprintDecision(',
    );
    const stateCheck = waitFence.indexOf(
      'RecheckProducerBirthReservationStateLocked(',
    );
    const processCheck = waitFence.indexOf('RecheckProducerBirthProcessLocked(');
    const monitorWait = waitFence.indexOf('Monitor.Wait(gate, waitMilliseconds)');
    expect(abortCheck).toBeLessThan(deadlineCheck);
    expect(deadlineCheck).toBeLessThan(fingerprintCheck);
    expect(fingerprintCheck).toBeLessThan(stateCheck);
    expect(stateCheck).toBeLessThan(processCheck);
    expect(processCheck).toBeLessThan(monitorWait);
    expect(waitFence).toContain('_ = Monitor.Wait(gate, waitMilliseconds);');
    expect(waitFence).not.toContain('etwSession.Flush');
    expect(waitFence).not.toContain('pendingWriteLease =');
    expect(waitFence).not.toContain('new ObservedProducerBirthSnapshot(');

    const abort = program.slice(
      program.indexOf('private void ThrowIfProducerBirthWaitAbortedLocked('),
      program.indexOf('private void RecheckProducerBirthReservationStateLocked('),
    );
    expect(abort).toContain('CapacityGuardLifecycleRules.WaitAbortFailureCode(');
    expect(abort).toContain('if (abortFailureCode is not null)');
    const observeBirth = program.slice(
      program.indexOf('private void ObserveProcessBirth('),
      program.indexOf('private void ProcessEtw('),
    );
    expect(observeBirth.indexOf('processBirthByPid[pid] ='))
      .toBeLessThan(observeBirth.indexOf('Monitor.PulseAll(gate);'));
    expect(observeBirth).toContain('lock (gate)');

    const rules = program.slice(
      program.indexOf('public static class WriteLeaseProducerBirthFenceRules'),
      program.indexOf('public static class WriteCompletionDrainRules'),
    );
    expect(rules).toContain('var durationQpc = checked(frequency * 10);');
    expect(rules).toContain('deadlineQpc = checked(startQpc + durationQpc);');
    expect(rules).toContain('nowQpc >= deadlineQpc');
    expect(rules).toContain('Math.Ceiling(');
    expect(rules).toContain('return int.MaxValue;');
    expect(rules).toContain('return ProducerBirthFingerprintDecision.Ready;');
    expect(rules).toContain('if (current == entry)');
    expect(rules).toContain('return ProducerBirthFingerprintDecision.TupleMismatch;');

    const capacityError = program.indexOf(
      'private static object Error(',
      program.indexOf('sealed class CapacityGuardSession'),
    );
    const dispose = program.slice(
      program.lastIndexOf('public void Dispose()', capacityError),
      capacityError,
    );
    expect(dispose).toContain('CapacityGuardLifecycleRules.BeginDisposeLocked(');
    expect(dispose).toContain('CapacityGuardLifecycleRules.CancelDrainPipeAndDispose(');
    expect(dispose).toContain('DisposeResourcesAfterPipeCompletion);');
    const lifecycle = program.slice(
      program.indexOf('public static class CapacityGuardLifecycleRules'),
      program.indexOf('public static class WriteLeaseProducerBirthFenceRules'),
    );
    const disposedSet = lifecycle.indexOf('disposed = true;');
    const abortFailure = lifecycle.indexOf('failureCode ??= SessionAbortFailureCode;');
    const pulse = lifecycle.indexOf('Monitor.PulseAll(gate);');
    const cancel = lifecycle.indexOf('cancellation.Cancel();');
    const pipeWait = lifecycle.indexOf('pipeTask.Wait(timeout)');
    const resourceDispose = lifecycle.indexOf('disposeResources();');
    expect(disposedSet).toBeLessThan(abortFailure);
    expect(abortFailure).toBeLessThan(pulse);
    expect(pulse).toBeLessThan(cancel);
    expect(cancel).toBeLessThan(pipeWait);
    expect(pipeWait).toBeLessThan(resourceDispose);
    expect(lifecycle).toContain('if (failureCode is not null) return failureCode;');
    expect(lifecycle).toContain('if (!pipeCompleted)');
    expect(lifecycle).toContain('SessionAbortTimeoutFailureCode');
    const resourceCleanup = dispose.slice(
      dispose.indexOf('private void DisposeResourcesAfterPipeCompletion()'),
    );
    expect(resourceCleanup.indexOf('StopEtw();'))
      .toBeLessThan(resourceCleanup.indexOf('etwSource.Dispose();'));
    expect(resourceCleanup.indexOf('etwSource.Dispose();'))
      .toBeLessThan(resourceCleanup.indexOf('job.Dispose();'));
  });

  it('exact late位置で固定診断・限定handoff/replayだけを純粋選択する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const authorize = program.slice(
      program.indexOf('private bool TryAuthorizeWriteCompletionDrainEventLocked('),
      program.indexOf('private void ObserveProcessIdentityProbeLocked('),
    );
    const lateBlock = authorize.slice(
      authorize.indexOf('if (epoch.Length == 0)'),
      authorize.indexOf('var exact = epoch.Where(ProofCandidate)'),
    );
    expect(lateBlock).toContain('var lateCandidates = broad.Where(');
    expect(lateBlock).toContain('ProofCandidate(seal)).ToArray()');
    expect(lateBlock).toContain('WriteCompletionDrainRules.AggregateLateEventFailureCode(');
    expect(lateBlock).toContain('lateCandidates.Select(seal => new LateEventDiagnosticCandidate(');
    expect(lateBlock).toContain('seal.State == WriteCompletionDrainState.CompletedRetained');
    expect(lateBlock).toContain('normalized == seal.ParentPath');
    expect(lateBlock).toContain('!ReferenceEquals(activeLease, seal.Lease)');
    expect(lateBlock).toContain('activeLease!.RelativePath[..slash] == normalized');
    expect(lateBlock).toContain('eventQpc > activeLease.CurrentPathReservedAtQpc');
    expect(lateBlock).toContain(
      'WriteCompletionDrainRules.IsCompletedWriteHandoffCandidate(',
    );
    expect(lateBlock).toContain('lateCandidates.Length,\n                    failure');
    expect(lateBlock).toContain('completedWrites.TryGetValue(');
    expect(lateBlock).toContain('WriteCompletionDrainRules.CanHandoffCompletedWrite(');
    for (const axis of [
      'completed!.WorkerPid == seal.ProducerPid',
      'completed!.ProcessSequenceNumber ==\n                        seal.ProcessSequenceNumber',
      'completed!.PhaseInstanceId ==\n                        seal.Phase.PhaseInstanceId',
      'completed!.ReservedAtQpc ==\n                        seal.CurrentPathReservedAtQpc',
      'completed!.Identity ==\n                        seal.CurrentIdentity',
    ]) expect(lateBlock).toContain(axis);
    expect(lateBlock).toContain(
      'throw new GuardException(\n                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED")',
    );
    expect(lateBlock).toContain('completedWriteHandoff = seal;\n                return true;');
    const activeDirectorySelection = lateBlock.slice(
      lateBlock.indexOf('if (lateCandidates.Length == 1)',
        lateBlock.indexOf('CanAuthorizePostRequestSystemSetInfo(')),
      lateBlock.indexOf(
        'if (failure == WriteCompletionDrainRules\n' +
        '                    .LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode)',
      ),
    );
    expect(activeDirectorySelection.match(/CanHandoffActiveDirectory\(/gu))
      .toHaveLength(1);
    for (const required of [
      'lateCandidates.Length',
      'failure',
      'authorizationFailure',
      'ledger?.IsUnbound(fileObject) == true',
      'seal.State == WriteCompletionDrainState.CompletedRetained',
      'activePhase?.Phase == "voice"',
      'ReferenceEquals(activePhase, seal.Phase)',
      'normalized == seal.ParentPath',
      '!ReferenceEquals(activeLease, seal.Lease)',
      'activeLease.PhaseInstanceId == activePhase.PhaseInstanceId',
      'activeLease!.RelativePath[..activeSlash] ==\n                        normalized',
      'eventQpc > activeLease.CurrentPathReservedAtQpc',
    ]) expect(activeDirectorySelection).toContain(required);
    expect(activeDirectorySelection).toContain(
      'activeDirectoryHandoff = activeLease;\n                    return true;',
    );
    expect(activeDirectorySelection).not.toContain('selectedSeal =');
    expect(activeDirectorySelection).not.toContain('completedWriteHandoff =');
    expect(activeDirectorySelection).not.toContain('replayKind =');
    const activeProducerBirth = lateBlock.slice(
      lateBlock.indexOf(
        'if (failure == WriteCompletionDrainRules\n' +
        '                    .LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode)',
      ),
      lateBlock.lastIndexOf('throw new GuardException(failure)'),
    );
    expect(activeProducerBirth).toContain(
      'registeredWorkerProcesses.TryGetValue(\n' +
      '                        activeLease.ProcessStartKey,',
    );
    expect(activeProducerBirth.match(/ActiveProducerBirthFailureCode\(/gu))
      .toHaveLength(1);
    expect(activeProducerBirth.match(/ReservationProducerBirthFailureCode\(/gu))
      .toHaveLength(1);
    for (const required of [
      'activeProducer!.Pid == activeLease.WorkerPid',
      'activeProducer!.ProcessStartKey ==\n                                activeLease.ProcessStartKey',
      'activeProducer!.ProcessSequenceNumber ==\n                                activeLease.ProcessSequenceNumber',
      'activeLease.PhaseInstanceId ==\n                                activePhase.PhaseInstanceId',
      'activePhase.StartedAtQpc',
      'activeProducer!.StartedAtQpc',
      'activeLease.CurrentPathReservedAtQpc',
      'eventQpc',
    ]) expect(activeProducerBirth).toContain(required);
    expect(activeProducerBirth).not.toContain('processBirthByPid');
    expect(activeProducerBirth).not.toContain('return true');
    expect(activeProducerBirth).not.toContain('selectedSeal =');
    expect(activeProducerBirth).not.toContain('producerPid =');
    expect(activeProducerBirth).not.toContain('producerSequenceNumber =');
    expect(activeProducerBirth).toContain(
      'eventQpc <=\n                                    activeLease.CurrentPathReservedAtQpc',
    );
    expect(activeProducerBirth).toContain(
      'snapshot?.LeaseReservedAtQpc ==\n                                    activeLease.ReservedAtQpc',
    );
    expect(activeProducerBirth).toContain(
      'activeLease.CurrentPathReservedAtQpc,\n                                eventQpc',
    );
    const legacyBirthClassifier = lateBlock.indexOf('ActiveProducerBirthFailureCode(');
    const fallbackGuard = lateBlock.indexOf(
      'if (failure == WriteCompletionDrainRules\n' +
      '                            .LateDiagnosticWriteActiveProducerRecordMissingFailureCode)',
    );
    const reservationBirthClassifier = lateBlock.indexOf(
      'ReservationProducerBirthFailureCode(',
    );
    const finalLateThrow = lateBlock.lastIndexOf('throw new GuardException(failure)');
    expect(legacyBirthClassifier).toBeLessThan(fallbackGuard);
    expect(fallbackGuard).toBeLessThan(reservationBirthClassifier);
    expect(reservationBirthClassifier).toBeLessThan(finalLateThrow);
    expect(lateBlock).toContain('throw new GuardException(failure)');
    for (const forbidden of [
      'writeCompletionBindingLedger =',
      'writeCompletionReorderQueue.',
      'filesByObject',
      'filesByPath',
      'allocatedByIdentity',
      'notices.',
      'observations.',
      'pendingWriteLease =',
      'ValidateAndCommit(',
      'AppliedCursor =',
      'AdmissionHead =',
      'peakLiveBytes =',
      'minimumObservedFreeBytes =',
      'writeCompletionPhaseEventCount',
      'writeCompletionSeals.',
    ]) expect(lateBlock).not.toContain(forbidden);
    expect(lateBlock).not.toMatch(/\.State\s*=(?!=)/u);
    expect(lateBlock).not.toMatch(/activeLease!?\.[A-Za-z0-9_]+\s*=(?!=)/u);

    const pureRule = program.slice(
      program.indexOf('public static string LateEventFailureCode('),
      program.indexOf('public static string NormalizeExternalFailureCode('),
    );
    for (const suffix of [
      'SEAL_NOT_COMPLETED_RETAINED',
      'CURRENT_PATH',
      'ACTIVE_LEASE_MISSING',
      'ACTIVE_PARENT_MISMATCH',
      'AT_OR_BEFORE_ACTIVE_RESERVATION',
    ]) expect(pureRule).toContain(suffix);
    expect(pureRule).toContain('if (!otherActiveLease) return GenericLateEventFailureCode');
    expect(pureRule).toContain('classified.Contains(exactCode, StringComparer.Ordinal)');
    expect(pureRule).toContain('classified.Contains(\n                GenericLateEventFailureCode');
    expect(pureRule).toContain('classified.Distinct(StringComparer.Ordinal)');
    expect(pureRule).toContain('LateDiagnosticWriteMixedCausesFailureCode');
    expect(pureRule).toContain('LateDiagnosticSetInfoMixedCausesFailureCode');
    const activeDirectoryRule = program.slice(
      program.indexOf('public static bool CanHandoffActiveDirectory('),
      program.indexOf('public static bool IsDeadlineValid('),
    );
    for (const required of [
      'lateCandidateCount == 1',
      'aggregateFailureCode == LateRetainedParentWriteFailureCode',
      'authorizationFailure == "BIRTH_MISSING"',
      'systemPid is 0 or 4',
      'eventName == "write"',
      'fileObject != 0',
      'fileObjectUnbound',
      'sealCompletedRetained',
      'activeVoicePhase',
      'sealPhaseMatches',
      'sealParentPath',
      'activeLeasePresent',
      'otherActiveLease',
      'phaseInstanceMatches',
      'activeParentMatches',
      'eventAfterActiveReservation',
    ]) expect(activeDirectoryRule).toContain(required);
    const reservationBirthRule = program.slice(
      program.indexOf('public static string ReservationProducerBirthFailureCode('),
      program.indexOf('public static bool CanHandoffActiveDirectory('),
    );
    expect(reservationBirthRule.indexOf('!registeredRecordAbsent'))
      .toBeLessThan(reservationBirthRule.indexOf('!snapshotPresent'));
    expect(reservationBirthRule.indexOf('!snapshotPresent'))
      .toBeLessThan(reservationBirthRule.indexOf('!producerPidMatches'));
    expect(reservationBirthRule.indexOf('!producerPidMatches'))
      .toBeLessThan(reservationBirthRule.indexOf('eventQpc <= birthStartedAtQpc'));
    expect(reservationBirthRule).toContain(
      'currentPathReservedAtQpc < initialLeaseReservedAtQpc',
    );
    expect(reservationBirthRule).toContain(
      'eventQpc > currentPathReservedAtQpc',
    );
    expect(reservationBirthRule).toContain(
      'birthStartedAtQpc > initialLeaseReservedAtQpc',
    );
    expect(reservationBirthRule).not.toContain(
      'eventQpc > initialLeaseReservedAtQpc',
    );
    for (const code of [
      'LateDiagnosticWriteReservationBirthRecordMissingFailureCode',
      'LateDiagnosticWriteReservationBirthTupleMismatchFailureCode',
      'LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode',
      'LateDiagnosticWriteAfterReservationBirthFailureCode',
      'F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED',
    ]) expect(reservationBirthRule).toContain(code);
    expect(reservationBirthRule).not.toContain('processBirthByPid');
    expect(reservationBirthRule).not.toContain('registeredWorkerProcesses');
    expect(reservationBirthRule).not.toContain('Stopwatch');
    expect(pureRule).not.toMatch(/(?:pendingWriteLease|writeCompletion|filesBy|notices|observations)\s*[.=]/u);

    const completeWrite = program.slice(
      program.indexOf('private object? CompleteWrite('),
      program.indexOf('private bool ReplayWriteCompletionQueueLocked('),
    );
    expect(completeWrite).toContain(
      'WriteCompletionDrainState.CompletionRequested,\n' +
      '            WriteCompletionDrainState.CompletedRetained);\n' +
      '        pendingWriteLease = null;',
    );
    const completeWriteAfterDrain = program.slice(
      program.indexOf('private object CompleteWriteAfterEtwDrain('),
      program.indexOf('private object? CompleteWrite('),
    );
    expect(completeWriteAfterDrain.indexOf('lock (gate)'))
      .toBeLessThan(completeWriteAfterDrain.indexOf('var completed = CompleteWrite('));
    const reserveWrite = program.slice(
      program.indexOf('private object ReserveWrite('),
      program.indexOf('private ProcessBirthRecord WaitForProducerBirthLocked('),
    );
    expect(reserveWrite).toContain('producerBirthSnapshot => new PendingWriteLease(');
    expect(reserveWrite).toContain('lease => pendingWriteLease = lease');
    expect(reserveWrite.match(/Stopwatch\.GetTimestamp\(\)/gu)).toHaveLength(1);
    expect(reserveWrite).not.toContain('processBirthByPid.TryGetValue(');
    expect(reserveWrite).toContain('WaitForProducerBirthLocked(');
    expect(reserveWrite.indexOf('var identity = job.ProcessIdentity(process);'))
      .toBeLessThan(reserveWrite.indexOf('WaitForProducerBirthLocked('));
    expect(reserveWrite.indexOf('WaitForProducerBirthLocked('))
      .toBeLessThan(reserveWrite.indexOf('var reservedAtQpc = Stopwatch.GetTimestamp();'));
    expect(reserveWrite.indexOf('var reservedAtQpc = Stopwatch.GetTimestamp();'))
      .toBeLessThan(reserveWrite.indexOf('new ObservedProducerBirthSnapshot('));
    expect(reserveWrite.indexOf('new ObservedProducerBirthSnapshot('))
      .toBeLessThan(reserveWrite.indexOf('producerBirthSnapshot => new PendingWriteLease('));
    const dispatchPipe = program.slice(
      program.indexOf('private object DispatchPipe('),
      program.indexOf('private object RegisterSelf('),
    );
    expect(dispatchPipe.indexOf('lock (gate)'))
      .toBeLessThan(dispatchPipe.indexOf('"reserveWrite" => ReserveWrite('));
    const observeBirth = program.slice(
      program.indexOf('private void ObserveProcessBirth('),
      program.indexOf('private void ProcessEtw('),
    );
    expect(observeBirth.indexOf('lock (gate)'))
      .toBeLessThan(observeBirth.indexOf('processBirthByPid.TryGetValue('));
    const observedBirthSnapshot = program.slice(
      program.indexOf('private sealed class ObservedProducerBirthSnapshot('),
      program.indexOf('private sealed record DeferredSystemSetInfoRecord('),
    );
    expect(observedBirthSnapshot).not.toContain('ProcessBirthRecord');
    expect(observedBirthSnapshot).not.toContain('Dictionary<');
    expect(observedBirthSnapshot).not.toMatch(/\{\s*get;\s*set;/u);
    for (const scalar of [
      'bool recordObserved',
      'ulong recordProcessSequenceNumber',
      'long recordStartedAtQpc',
      'int producerPid',
      'ulong producerProcessStartKey',
      'ulong leaseProcessSequenceNumber',
      'string phaseInstanceId',
      'long phaseStartedAtQpc',
      'long leaseReservedAtQpc',
    ]) expect(observedBirthSnapshot).toContain(scalar);
    const pendingWriteLeaseClass = program.slice(
      program.indexOf('private sealed class PendingWriteLease('),
      program.indexOf('private sealed record RegisteredWorkerProcess('),
    );
    expect(pendingWriteLeaseClass).toContain(
      'public ObservedProducerBirthSnapshot ProducerBirthSnapshot { get; } =',
    );
    expect(pendingWriteLeaseClass).not.toContain(
      'ProducerBirthSnapshot { get; set; }',
    );
    expect(pendingWriteLeaseClass).not.toContain('ProcessBirthRecord');

    type FixtureBirth = Readonly<{ sequence: bigint; startedAtQpc: number }>;
    const fixtureBirthMap = new Map<number, FixtureBirth>();
    const captureBirth = (pid: number, reservationQpc: number) => {
      const observed = fixtureBirthMap.get(pid);
      return Object.freeze({
        recordObserved: observed !== undefined,
        recordSequence: observed?.sequence ?? 0n,
        recordStartedAtQpc: observed?.startedAtQpc ?? 0,
        producerPid: pid,
        reservationQpc,
      });
    };
    const delayed = captureBirth(41, 110);
    fixtureBirthMap.set(41, { sequence: 1n, startedAtQpc: 100 });
    expect(delayed).toEqual({
      recordObserved: false,
      recordSequence: 0n,
      recordStartedAtQpc: 0,
      producerPid: 41,
      reservationQpc: 110,
    });
    const captured = captureBirth(41, 111);
    fixtureBirthMap.set(41, { sequence: 2n, startedAtQpc: 112 });
    fixtureBirthMap.delete(41);
    fixtureBirthMap.set(41, { sequence: 3n, startedAtQpc: 113 });
    expect(captured).toEqual({
      recordObserved: true,
      recordSequence: 1n,
      recordStartedAtQpc: 100,
      producerPid: 41,
      reservationQpc: 111,
    });

    const observe = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private string QueueOrApplyCallbackLocked('),
    );
    expect(observe).toContain('WriteCompletionDrainSeal? completionDrainSeal = null;');
    expect(observe).toContain('WriteCompletionDrainSeal? completedWriteHandoff = null;');
    expect(observe).toContain('PendingWriteLease? activeDirectoryHandoff = null;');
    expect(observe).toContain(
      'var completionReplayKind = WriteCompletionReplayKind.NormalEpoch;',
    );
    expect(observe).toContain('out completionDrainSeal,\n                        out completedWriteHandoff');
    expect(observe).toContain('out completedWriteHandoff,\n                        out activeDirectoryHandoff');
    expect(observe).toContain(
      'out activeDirectoryHandoff,\n' +
      '                        out completedNoLeaseDirectoryHandoff,\n' +
      '                        out completionReplayKind',
    );
    const activeDirectoryBranch = observe.slice(
      observe.indexOf('if (activeDirectoryHandoff is not null)'),
      observe.indexOf('else if (completedWriteHandoff is not null)'),
    );
    expect(activeDirectoryBranch.match(/TryAuthorizeBoundLeaseDirectoryWriteLocked\(/gu))
      .toHaveLength(1);
    expect(activeDirectoryBranch.match(
      /TryAuthorizeAfterLeaseReservationDirectoryWriteLocked\(/gu,
    )).toHaveLength(1);
    const boundAuthorize = activeDirectoryBranch.indexOf(
      'TryAuthorizeBoundLeaseDirectoryWriteLocked(',
    );
    const firstPoisonCheck = activeDirectoryBranch.indexOf(
      'if (failureCode is not null) return;',
    );
    const afterAuthorize = activeDirectoryBranch.indexOf(
      'TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(',
    );
    const stateChangedPoison = activeDirectoryBranch.lastIndexOf(
      'F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED',
    );
    const secondPoisonCheck = activeDirectoryBranch.lastIndexOf(
      'if (failureCode is not null) return;',
    );
    expect(activeDirectoryBranch.match(/if \(failureCode is not null\) return;/gu))
      .toHaveLength(2);
    expect(boundAuthorize).toBeLessThan(firstPoisonCheck);
    expect(firstPoisonCheck).toBeLessThan(afterAuthorize);
    expect(afterAuthorize).toBeLessThan(secondPoisonCheck);
    expect(secondPoisonCheck).toBeLessThan(stateChangedPoison);
    expect(activeDirectoryBranch).toContain('completionDrainSeal is not null ||');
    expect(activeDirectoryBranch).toContain('completedWriteHandoff is not null ||');
    expect(activeDirectoryBranch).toContain(
      'completionReplayKind !=\n                                    WriteCompletionReplayKind.NormalEpoch',
    );
    for (const forbidden of [
      'TryAuthorizeReservedSystemSetInfoLocked(',
      'TryAuthorizeCompletedSystemSetInfoLocked(',
      'TryAuthorizeKnownSystemDirectoryWriteLocked(',
      'completionDrainSeal =',
    ]) expect(activeDirectoryBranch).not.toContain(forbidden);
    const handoffBranch = observe.slice(
      observe.indexOf('if (completedWriteHandoff is not null)'),
      observe.indexOf('else\n                        {\n                            pid = drainPid;'),
    );
    expect(handoffBranch.match(/TryAuthorizeCompletedSystemSetInfoLocked\(/gu))
      .toHaveLength(1);
    expect(handoffBranch).toContain('if (failureCode is null)');
    expect(handoffBranch).toContain(
      'PoisonLocked(\n                                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED")',
    );
    expect(handoffBranch).toContain('return;');
    expect(handoffBranch).toContain('pid = completedPid;');
    expect(handoffBranch).toContain('producerSequenceNumber = completedSequenceNumber;');
    expect(handoffBranch).toContain(
      'identityRecheckFailureCode =\n                                "ETW_COMPLETED_WRITE_REJOIN_IDENTITY_MISMATCH"',
    );
    for (const forbidden of [
      'TryAuthorizeReservedSystemSetInfoLocked(',
      'TryAuthorizeBoundLeaseDirectoryWriteLocked(',
      'TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(',
      'TryAuthorizeKnownSystemDirectoryWriteLocked(',
      'AdmitCallbackProofLocked(',
      'RecheckSealedCallbackLocked(',
      'ReplayWriteCompletionQueueLocked(',
      'completionDrainSeal =',
      'EventCount',
    ]) expect(handoffBranch).not.toContain(forbidden);
    expect(observe.indexOf('if (completedWriteHandoff is not null)'))
      .toBeLessThan(observe.indexOf('TryAuthorizeReservedSystemSetInfoLocked('));
    expect(observe.indexOf('TryAuthorizeWriteCompletionDrainEventLocked('))
      .toBeLessThan(observe.indexOf('TryAuthorizeBoundLeaseDirectoryWriteLocked('));
    expect(observe.indexOf('TryAuthorizeWriteCompletionDrainEventLocked('))
      .toBeLessThan(observe.indexOf('TryAuthorizeAfterLeaseReservationDirectoryWriteLocked('));
    expect(observe.match(/TryAuthorizeCompletedSystemSetInfoLocked\(/gu)).toHaveLength(2);
    const normalProof = program.slice(
      program.indexOf('private ImmutableBindingProof? AdmitCallbackProofLocked('),
      program.indexOf('private void ApplyCallbackSnapshotLocked('),
    );
    expect(normalProof).toContain('else if (seal is null)');
    expect(normalProof).toContain('kind = WriteCompletionBindingKind.OtherBound;');
    expect(observe).toContain('completionDrainSeal?.SealSequence');
    expect(observe).toContain('bindingProof,\n                    completionReplayKind,');
    expect(program).toContain('public enum WriteCompletionReplayKind');
    expect(program).toContain('PostRequestSystemSetInfo,');
    expect(program).toContain(
      'error = WriteCompletionDrainRules.NormalizeExternalFailureCode(code)',
    );
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047 @test UT-F005-047 */
  it('single exact completed no-lease directory handoffを旧seal replayなしでatomic再検査する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const authorize = program.slice(
      program.indexOf('private bool TryAuthorizeWriteCompletionDrainEventLocked('),
      program.indexOf('private void ObserveProcessIdentityProbeLocked('),
    );
    const lateBlock = authorize.slice(
      authorize.indexOf('if (epoch.Length == 0)'),
      authorize.indexOf('var exact = epoch.Where(ProofCandidate)'),
    );
    expect(lateBlock.match(/CanHandoffCompletedNoLeaseDirectory\(/gu)).toHaveLength(1);
    for (const required of [
      'lateCandidates.Length',
      'failure',
      'authorizationFailure',
      'ledger?.IsUnbound(fileObject) == true',
      'seal.State == WriteCompletionDrainState.CompletedRetained',
      'activePhase?.Phase == "voice"',
      'ReferenceEquals(activePhase, seal.Phase)',
      'normalized == seal.ParentPath',
      'pendingWriteLease is null',
      'seal.CompletionRequestedAtQpc is long',
      'eventQpc > completionUpper',
      'completedNoLeaseDirectoryHandoff = seal;',
    ]) expect(lateBlock).toContain(required);

    const observe = program.slice(
      program.indexOf('private void ObserveEtw('),
      program.indexOf('private string QueueOrApplyCallbackLocked('),
    );
    const dedicated = observe.slice(
      observe.indexOf('if (completedNoLeaseDirectoryHandoff is not null)'),
      observe.indexOf('else if (activeDirectoryHandoff is not null)'),
    );
    expect(dedicated.match(/TryAuthorizeKnownSystemDirectoryWriteLocked\(/gu))
      .toHaveLength(1);
    expect(dedicated).toContain('InvokeCompletedNoLeaseKnownAuthorization(');
    expect(dedicated).toContain(
      'CompletedNoLeaseKnownAuthorizationDecision.StateChanged',
    );
    for (const forbidden of [
      'TryAuthorizeReservedSystemSetInfoLocked(',
      'TryAuthorizeCompletedSystemSetInfoLocked(',
      'TryAuthorizeBoundLeaseDirectoryWriteLocked(',
      'TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(',
      'completionDrainSeal =',
      'EventCount++',
    ]) expect(dedicated).not.toContain(forbidden);
    expect(dedicated).toContain('new CompletedNoLeaseDirectoryRejoinContext(');
    expect(dedicated).toContain(
      'RecheckCompletedNoLeaseDirectoryProofIndependentLocked(',
    );
    expect(dedicated.indexOf('RecheckCompletedNoLeaseDirectoryProofIndependentLocked('))
      .toBeLessThan(observe.indexOf('AdmitCallbackProofLocked('));
    expect(dedicated).toContain(
      '"F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED"',
    );
    expect(observe).toContain(
      'completedNoLeaseDirectoryRejoin,\n                    completionDrainSeal?.SealSequence',
    );

    const context = program.slice(
      program.indexOf('private sealed record CompletedNoLeaseDirectoryRejoinContext('),
      program.indexOf('private enum WriteCompletionDrainState'),
    );
    for (const scalar of [
      'long SealSequence', 'WriteCompletionDrainSeal Seal', 'ActivePhase Phase',
      'string PhaseInstanceId', 'long PhaseStartedAtQpc', 'string DirectoryPath',
      'string DirectoryIdentity', 'ulong EventFileObject', 'long EventQpc',
      'long CompletionUpperQpc', 'int RootPid', 'ulong RootProcessStartKey',
      'ulong RootProcessSequenceNumber',
    ]) expect(context).toContain(scalar);
    expect(context).not.toMatch(/\{\s*get;\s*set;/u);

    const recheck = program.slice(
      program.indexOf('private void RecheckCompletedNoLeaseDirectoryProofIndependentLocked('),
      program.indexOf('private bool TryAuthorizeBoundLeaseDirectoryWriteLocked('),
    );
    for (const required of [
      'CompletedNoLeaseContextStateMatches(',
      'pendingWriteLease is null',
      'matchingSeals.Length == 1',
      'WriteCompletionDrainState.CompletedRetained',
      'SystemDirectoryWriteRejoinStage(',
      'seal.RetainedParent.Reinspect(',
      'job.InspectRetainedProcess(rootWorkerProcess!)',
      'CompletedNoLeaseRootProcessMatches(',
      'CompletedNoLeaseSnapshotMatches(',
      'CompletedNoLeaseProofMatches(',
      'WriteCompletionBindingKind.OtherBound',
      'WriteCompletionBindingState.Bound',
      'writeCompletionGenerationHandles.TryGetValue(',
      'retained.Reinspect(context.DirectoryIdentity)',
    ]) expect(recheck).toContain(required);
    const preflight = program.slice(
      program.indexOf('private void PreflightImmutableRejoinLocked('),
      program.indexOf('private void PreflightRenameSnapshotLocked('),
    );
    const apply = program.slice(
      program.indexOf('private void ApplyCallbackSnapshotCoreLocked('),
      program.indexOf('private void ReinspectImmediateSnapshot('),
    );
    for (const block of [preflight, apply]) {
      expect(block).toContain('HasAtMostOneImmutableRejoinContext(');
      expect(block).toContain('CompletedNoLeaseDirectoryRejoin is { } completedNoLease');
      expect(block).toContain('RecheckCompletedNoLeaseDirectoryProofLocked(');
    }
    expect(apply.indexOf('RecheckCompletedNoLeaseDirectoryProofLocked('))
      .toBeLessThan(apply.indexOf('oldAllocated ='));
    const queueOrApply = program.slice(
      program.indexOf('private string QueueOrApplyCallbackLocked('),
      program.indexOf('private ImmutableBindingProof? AdmitCallbackProofLocked('),
    );
    expect(queueOrApply).toContain('writeCompletionReplayStore.EnqueueSnapshot(snapshot)');
    const replayQueue = program.slice(
      program.indexOf('private bool ReplayWriteCompletionQueueLocked('),
      program.indexOf('private void PreflightCallbackSnapshotLocked('),
    );
    expect(replayQueue).toContain('writeCompletionReplayStore.Replay(');
    const generationRetention = program.slice(
      program.indexOf('private void EnsureWriteCompletionLedgerLocked()'),
      program.indexOf('private sealed class RetainedFileIdentity'),
    );
    expect(generationRetention.match(/writeCompletionReplayStore\.AddGenerationHandle\(/gu))
      .toHaveLength(2);
    const dispose = program.slice(
      program.indexOf('private void DisposeResourcesAfterPipeCompletion()'),
      program.indexOf('private static object Error('),
    );
    expect(dispose).toContain('writeCompletionReplayStore.Dispose();');
    const replayStore = program.slice(
      program.indexOf('internal sealed class WriteCompletionReplayStore<'),
      program.indexOf('public sealed class WriteCompletionBindingLedger'),
    );
    for (const cleanup of [
      'handle.Dispose()',
      'GenerationHandles.Clear();',
      'Snapshots.Clear();',
      'Cleanups.Clear();',
      'Ledger = null;',
    ]) expect(replayStore).toContain(cleanup);
    const pureRule = program.slice(
      program.indexOf('public static bool CanHandoffCompletedNoLeaseDirectory('),
      program.indexOf('public static bool IsDeadlineValid('),
    );
    for (const required of [
      'lateCandidateCount == 1',
      'LateDiagnosticWriteActiveLeaseMissingFailureCode',
      'authorizationFailure == "BIRTH_MISSING"',
      'systemPid is 0 or 4', 'eventName == "write"', 'fileObject != 0',
      'fileObjectUnbound', 'sealCompletedRetained', 'activeVoicePhase',
      'sealPhaseMatches', 'sealParentPath', 'noActiveLease',
      'completionUpperPresent', 'eventAfterCompletionUpper',
      'InvokeCompletedNoLeaseKnownAuthorization(',
      'HasAtMostOneImmutableRejoinContext(',
      'CompletedNoLeaseContextStateMatches(',
      'CompletedNoLeaseRootProcessMatches(',
      'CompletedNoLeaseSnapshotMatches(',
      'CompletedNoLeaseProofMatches(',
    ]) expect(pureRule).toContain(required);
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 */
  it('completed no-lease replay storeをproduction queue/ledger/handle/Disposeへ直結する', async () => {
    const program = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    const fields = program.slice(
      program.indexOf('private readonly WriteCompletionReplayStore<'),
      program.indexOf('private PendingWriteLease? pendingWriteLease;'),
    );
    expect(fields).toContain('PendingCallbackSnapshot');
    expect(fields).toContain('PendingCleanupSnapshot');
    expect(fields).toContain('RetainedFileIdentity> writeCompletionReplayStore = new();');
    expect(fields).toContain('writeCompletionReplayStore.Snapshots');
    expect(fields).toContain('writeCompletionReplayStore.Cleanups');
    expect(fields).toContain('writeCompletionReplayStore.GenerationHandles');
    expect(fields).toContain('writeCompletionReplayStore.Ledger');

    const queueOrApply = program.slice(
      program.indexOf('private string QueueOrApplyCallbackLocked('),
      program.indexOf('private ImmutableBindingProof? AdmitCallbackProofLocked('),
    );
    expect(queueOrApply).toContain('writeCompletionReplayStore.EnqueueSnapshot(snapshot)');
    const replay = program.slice(
      program.indexOf('private bool ReplayWriteCompletionQueueLocked('),
      program.indexOf('private void PreflightCallbackSnapshotLocked('),
    );
    expect(replay).toContain('return writeCompletionReplayStore.Replay(');
    const dispose = program.slice(
      program.indexOf('private void DisposeResourcesAfterPipeCompletion()'),
      program.indexOf('private static object Error('),
    );
    expect(dispose).toContain('writeCompletionReplayStore.Dispose();');
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 */
  it('completed no-lease実Task fixtureは共有storeの実queueをdrift後poison・Disposeする', async () => {
    const nativeTests = await readFile(
      resolve('native/f005-guard-tests/Program.cs'),
      'utf8',
    );
    const fixture = nativeTests.slice(
      nativeTests.indexOf(') RunCompletedNoLeaseQueueFixture(string? drift)'),
      nativeTests.indexOf('bool RejectsReplayBufferLimit('),
    );
    expect(fixture).toContain('new WriteCompletionReplayStore<');
    expect(fixture).toContain('new WriteCompletionBindingLedger([])');
    expect(fixture).toContain('store.AddGenerationHandle(');
    expect(fixture).toContain('store.EnqueueSnapshot(');
    expect(fixture).toContain('Task.Run(() =>');
    expect(fixture).toContain('replayReady.Set();');
    expect(fixture).toContain('allowReplay.Wait(');
    expect(fixture).toContain('store.Replay(');
    for (const drift of [
      'case "new lease"',
      'case "root exit"',
      'case "seal release"',
      'case "directory replacement"',
    ]) expect(fixture).toContain(drift);
    for (const retained of [
      'store.SnapshotCount == 1',
      'store.LedgerRetained',
      'store.GenerationHandleCount == 1',
      'ledger.AppliedCursor < proof.ProofSequence',
      '!generationHandle.Disposed',
    ]) expect(fixture).toContain(retained);
    expect(fixture).toContain('for (var callbackAttempt = 0; callbackAttempt < 2;');
    expect(fixture).toContain('if (!poisoned)');
    expect(fixture).toContain('store.Dispose();');
    expect(fixture).not.toContain('var queue = new Queue<string>()');
    expect(fixture).not.toContain('new MemoryStream(');
  });

  it('PID再利用raceでは新旧どちらのFileIOも別世代へ取り違えない', () => {
    const authorize = (
      birth: { sequenceNumber: bigint; startedAtQpc: number } | undefined,
      eventQpc: number,
      currentHandleSequenceNumber: bigint,
    ): boolean =>
      birth !== undefined &&
      eventQpc > birth.startedAtQpc &&
      currentHandleSequenceNumber === birth.sequenceNumber;

    const generationA = { sequenceNumber: 101n, startedAtQpc: 1_000 };
    const generationB = { sequenceNumber: 102n, startedAtQpc: 2_000 };

    expect(authorize(generationA, 1_500, 101n)).toBe(true);
    expect(authorize(generationA, 1_500, 102n)).toBe(false);
    expect(authorize(generationB, 1_500, 102n)).toBe(false);
    expect(authorize(generationB, 2_500, 102n)).toBe(true);
    expect(authorize(undefined, 2_500, 102n)).toBe(false);

    const noticeMatches = (
      notice: { pid: number; sequenceNumber: bigint },
      observation: { pid: number; sequenceNumber: bigint },
    ): boolean =>
      notice.pid === observation.pid &&
      notice.sequenceNumber === observation.sequenceNumber;
    expect(noticeMatches(
      { pid: 1234, sequenceNumber: generationA.sequenceNumber },
      { pid: 1234, sequenceNumber: generationA.sequenceNumber },
    )).toBe(true);
    expect(noticeMatches(
      { pid: 1234, sequenceNumber: generationB.sequenceNumber },
      { pid: 1234, sequenceNumber: generationA.sequenceNumber },
    )).toBe(false);
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('SDK/runtime固定build evidenceを実sourceと70MiB self-contained binaryで検証する', async () => {
    const [evidenceRaw, program, project, globalJson, binary] = await Promise.all([
      readFile(join(NATIVE_ROOT, 'build-evidence.json'), 'utf8'),
      readFile(join(NATIVE_ROOT, 'Program.cs')),
      readFile(join(NATIVE_ROOT, 'F005Guard.csproj')),
      readFile(join(NATIVE_ROOT, 'global.json')),
      readFile(GUARD_EXE),
    ]);
    const evidence = JSON.parse(evidenceRaw) as F005NativeGuardBuildEvidence;
    expect(verifyF005NativeGuardBuildEvidence(evidence, {
      program,
      project,
      globalJson,
      apphost: binary,
      outputBinary: binary,
    })).toEqual(evidence);
    const tampered = new Uint8Array(binary);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => verifyF005NativeGuardBuildEvidence(evidence, {
      program,
      project,
      globalJson,
      apphost: binary,
      outputBinary: tampered,
    })).toThrowError(/binary pin/u);

    const client = new GuardClient();
    await expect(client.command({ op: 'hello' })).resolves.toMatchObject({
      ok: true,
      abi: 'f005-guard-jsonl-v1',
      capacityAbi: 'f005-capacity-pipe-v3',
      rid: 'win-x64',
      runtimeVersion: '9.0.18',
      binarySha256: F005_NATIVE_GUARD_PINS.outputBinarySha256,
      workingDirectoryIsExecutableDirectory: true,
    });
    await client.close();

    const wrongCwdClient = new GuardClient([], PROJECT_ROOT);
    await expect(wrongCwdClient.command({ op: 'hello' })).resolves.toMatchObject({
      ok: true,
      workingDirectoryIsExecutableDirectory: false,
    });
    await wrongCwdClient.close();
  });

  /** @des DES-F005-006 @fun FUN-F005-017 @test UT-F005-047 */
  it('Job継承helperがWAVをwrite-throughし、衝突とhash不一致をfail-closedにする', async () => {
    const root = await temporaryRoot('f005-native-write-through-');
    await mkdir(join(root, 'stage'));
    const body = Buffer.from('f005-write-through');
    const digest = createHash('sha256').update(body).digest('hex');
    const oneShot = async (): Promise<GuardClient> => {
      const client = new GuardClient(['--write-through-once']);
      await expect(client.command({ op: 'hello' }))
        .resolves.toMatchObject({
          ok: true,
          abi: 'f005-guard-jsonl-v1',
          binarySha256: F005_NATIVE_GUARD_PINS.outputBinarySha256,
          workingDirectoryIsExecutableDirectory: true,
        });
      return client;
    };
    const ordinary = new GuardClient();
    await expect(ordinary.command({
      op: 'write-through',
      root,
      relativePath: 'stage/forbidden.wav',
      expectedSha256: digest,
      bodyBase64: body.toString('base64'),
    })).resolves.toMatchObject({ ok: false, error: 'OPERATION_INVALID' });
    await ordinary.close();

    const uninitialized = new GuardClient(['--write-through-once']);
    await expect(uninitialized.command({
      op: 'write-through',
      root,
      relativePath: 'stage/uninitialized.wav',
      expectedSha256: digest,
      bodyBase64: body.toString('base64'),
    })).resolves.toMatchObject({ ok: false, error: 'WRITE_THROUGH_HELLO_REQUIRED' });
    await uninitialized.close();

    const restricted = await oneShot();
    await expect(restricted.command({
      op: 'open',
      capabilityId: 'forbidden',
      root,
      relativePath: 'stage/voice.wav',
    })).resolves.toMatchObject({ ok: false, error: 'OPERATION_INVALID' });
    await restricted.close();

    const committed = await oneShot();
    await expect(committed.command({
      op: 'write-through',
      root,
      relativePath: 'stage/voice.wav',
      expectedSha256: digest,
      bodyBase64: body.toString('base64'),
    })).resolves.toMatchObject({
      ok: true,
      bytes: body.byteLength,
      relativePath: 'stage/voice.wav',
      sha256: digest,
      nativeIdentity: expect.stringMatching(/^[0-9a-f]{8}:[0-9a-f]{16}$/u),
      durability: 'file-flag-write-through-flush-file-buffers-delete-on-close',
    });
    await expect(readFile(join(root, 'stage', 'voice.wav'))).resolves.toEqual(body);
    await expect(rename(
      join(root, 'stage', 'voice.wav'),
      join(root, 'stage', 'before-commit.wav'),
    )).rejects.toBeDefined();
    await expect(committed.command({
      op: 'write-commit',
      relativePath: 'stage/voice.wav',
      expectedSha256: digest,
    })).resolves.toMatchObject({ ok: false, error: 'WRITE_THROUGH_RENAME_REQUIRED' });
    await expect(committed.command({
      op: 'write-rename',
      relativePath: 'stage/voice.wav',
      relativeTarget: 'stage/voice-final.wav',
      expectedSha256: digest,
    })).resolves.toMatchObject({
      ok: true,
      state: 'renamed',
      relativePath: 'stage/voice-final.wav',
      sha256: digest,
    });
    await expect(committed.command({
      op: 'write-rename',
      relativePath: 'stage/voice-final.wav',
      relativeTarget: 'stage/voice-second.wav',
      expectedSha256: digest,
    })).resolves.toMatchObject({ ok: false, error: 'WRITE_THROUGH_RENAME_ALREADY_USED' });
    await expect(committed.command({
      op: 'write-commit',
      relativePath: 'stage/voice-final.wav',
      expectedSha256: digest,
    })).resolves.toMatchObject({ ok: true, state: 'committed' });
    await committed.close();
    await expect(readFile(join(root, 'stage', 'voice-final.wav'))).resolves.toEqual(body);

    const collisionClient = await oneShot();
    const collision = await collisionClient.command({
      op: 'write-through',
      root,
      relativePath: 'stage/voice-final.wav',
      expectedSha256: digest,
      bodyBase64: body.toString('base64'),
    });
    expect(collision.ok).toBe(false);
    expect(collision.error).toMatch(/^WRITE_THROUGH_OPEN_FAILED_/u);
    await collisionClient.close();
    await expect(readFile(join(root, 'stage', 'voice-final.wav'))).resolves.toEqual(body);

    const invalidHash = await oneShot();
    await expect(invalidHash.command({
      op: 'write-through',
      root,
      relativePath: 'stage/bad.wav',
      expectedSha256: '0'.repeat(64),
      bodyBase64: body.toString('base64'),
    })).resolves.toMatchObject({
      ok: false,
      error: 'WRITE_THROUGH_HASH_MISMATCH',
    });
    await invalidHash.close();
    await expect(readFile(join(root, 'stage', 'bad.wav'))).rejects.toBeDefined();

    const boundaryBody = Buffer.alloc(5_760_044, 0x5a);
    const boundaryDigest = createHash('sha256').update(boundaryBody).digest('hex');
    const boundary = await oneShot();
    await expect(boundary.command({
      op: 'write-through',
      root,
      relativePath: 'stage/boundary.wav',
      expectedSha256: boundaryDigest,
      bodyBase64: boundaryBody.toString('base64'),
    })).resolves.toMatchObject({
      ok: true,
      bytes: boundaryBody.byteLength,
      sha256: boundaryDigest,
    });
    await expect(boundary.command({ op: 'write-abort' }))
      .resolves.toMatchObject({ ok: true, state: 'aborted' });
    await boundary.close();
    await expect(readFile(join(root, 'stage', 'boundary.wav'))).rejects.toBeDefined();

    const disconnected = await oneShot();
    await expect(disconnected.command({
      op: 'write-through',
      root,
      relativePath: 'stage/disconnected.wav',
      expectedSha256: digest,
      bodyBase64: body.toString('base64'),
    })).resolves.toMatchObject({ ok: true, sha256: digest });
    await expect(disconnected.command({
      op: 'write-rename',
      relativePath: 'stage/disconnected.wav',
      relativeTarget: 'stage/disconnected-final.wav',
      expectedSha256: digest,
    })).resolves.toMatchObject({ ok: true, state: 'renamed' });
    await disconnected.close();
    await expect(readFile(join(root, 'stage', 'disconnected.wav'))).rejects.toBeDefined();
    await expect(readFile(join(root, 'stage', 'disconnected-final.wav'))).rejects.toBeDefined();

    const killed = await oneShot();
    const killBody = Buffer.alloc(5_760_044, 0x6b);
    const killDigest = createHash('sha256').update(killBody).digest('hex');
    void killed.command({
      op: 'write-through',
      root,
      relativePath: 'stage/killed-before-reply.wav',
      expectedSha256: killDigest,
      bodyBase64: killBody.toString('base64'),
    });
    const killPath = join(root, 'stage', 'killed-before-reply.wav');
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      try {
        await stat(killPath);
        break;
      } catch {
        if (attempt === 1_999) throw new Error('write-through create was not observed');
        await delay(1);
      }
    }
    await killed.killAndWait();
    await expect(readFile(killPath)).rejects.toBeDefined();

    const overBody = Buffer.alloc(5_760_045, 0x5a);
    const over = await oneShot();
    await expect(over.command({
      op: 'write-through',
      root,
      relativePath: 'stage/over.wav',
      expectedSha256: createHash('sha256').update(overBody).digest('hex'),
      bodyBase64: overBody.toString('base64'),
    })).resolves.toMatchObject({
      ok: false,
      error: 'WRITE_THROUGH_BODY_INVALID',
    });
    await over.close();
    await expect(readFile(join(root, 'stage', 'over.wav'))).rejects.toBeDefined();
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('open handleをprocess内保持してsource/parent swapを止め、同じhandleをread・renameする', async () => {
    const root = await temporaryRoot('f005-native-barrier-');
    await mkdir(join(root, 'content'));
    const source = join(root, 'content', 'source.txt');
    await writeFile(source, 'held-original');
    const client = new GuardClient();
    await expect(client.command({
      op: 'open',
      capabilityId: 'held',
      root,
      relativePath: 'content/source.txt',
    })).resolves.toMatchObject({ ok: true, bytes: 13 });

    await expect(rename(source, join(root, 'content', 'attacker.txt'))).rejects.toBeDefined();
    await expect(rename(join(root, 'content'), join(root, 'attacker-content'))).rejects.toBeDefined();
    const read = await client.command({ op: 'read', capabilityId: 'held' });
    expect(Buffer.from(String(read.bodyBase64), 'base64').toString('utf8')).toBe('held-original');
    await expect(client.command({
      op: 'rename',
      capabilityId: 'held',
      relativeTarget: 'content/renamed.txt',
    })).resolves.toMatchObject({ ok: true, relativePath: 'content/renamed.txt' });
    await expect(readFile(join(root, 'content', 'renamed.txt'), 'utf8')).resolves.toBe('held-original');
    await expect(client.command({ op: 'read', capabilityId: 'held' }))
      .resolves.toMatchObject({ ok: true, bytes: 13 });
    await client.command({ op: 'close', capabilityId: 'held' });
    await client.close();
    await expect(rename(
      join(root, 'content', 'renamed.txt'),
      join(root, 'content', 'after-close.txt'),
    )).resolves.toBeUndefined();
  });

  /** @des DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('held identityだけをdeleteし、reply後の同名replacement・replay・未知capabilityを保護する', async () => {
    const root = await temporaryRoot('f005-native-delete-race-');
    await mkdir(join(root, 'cleanup'));
    const target = join(root, 'cleanup', 'target.json');
    const original = '{"owner":"pipeline"}\n';
    const replacement = '{"owner":"third-party"}\n';
    await writeFile(target, original);
    const client = new GuardClient();
    await expect(client.command({
      op: 'open',
      capabilityId: 'delete-held',
      root,
      relativePath: 'cleanup/target.json',
    })).resolves.toMatchObject({
      ok: true,
      sha256: createHash('sha256').update(original).digest('hex'),
    });

    // open〜disposition間はShareWriteを外し、検証済みbytesの差替えを拒否する。
    await expect(writeFile(target, replacement)).rejects.toBeDefined();
    await expect(client.command({
      op: 'delete',
      capabilityId: 'delete-held',
    })).resolves.toEqual({
      ok: true,
      capabilityId: 'delete-held',
      relativePath: 'cleanup/target.json',
      sha256: createHash('sha256').update(original).digest('hex'),
    });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });

    // delete opは元handleをclose済み。同名replacementをhelper終了前に作っても触れない。
    await writeFile(target, replacement);
    await expect(client.command({
      op: 'delete',
      capabilityId: 'delete-held',
    })).resolves.toEqual({ ok: false, error: 'CAPABILITY_UNKNOWN' });
    await expect(client.command({
      op: 'delete',
      capabilityId: 'never-opened',
    })).resolves.toEqual({ ok: false, error: 'CAPABILITY_UNKNOWN' });
    await client.close();
    await expect(readFile(target, 'utf8')).resolves.toBe(replacement);
  });

  /** @des DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('TS bridgeはmint済みdelete-source capabilityだけを一度消費する', async () => {
    const root = await temporaryRoot('f005-native-delete-bridge-');
    await mkdir(join(root, 'cleanup'));
    const target = join(root, 'cleanup', 'target.json');
    await writeFile(target, '{"state":"old"}\n');
    const capability = await resolveSafeWorkspaceFile(
      root,
      'cleanup/target.json',
      'delete-source',
    );
    await expect(deleteSafeWorkspaceFile(
      capability,
      capability.nativeIdentity,
    )).resolves.toBeUndefined();
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(target, '{"state":"replacement"}\n');
    await expect(deleteSafeWorkspaceFile(
      capability,
      capability.nativeIdentity,
    )).rejects.toBeDefined();
    await expect(deleteSafeWorkspaceFile(
      {} as SafeFileHandle,
      '00000000:0000000000000000',
    )).rejects.toBeDefined();
    await expect(readFile(target, 'utf8')).resolves.toBe('{"state":"replacement"}\n');
  });

  /** @des DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('pre-scan後の同SHA別identityをdelete/rename CASで拒否し、同identityだけ許可する', async () => {
    const root = await temporaryRoot('f005-native-identity-cas-');
    await mkdir(join(root, 'cleanup'));
    const content = '{"same":"sha"}\n';

    const deleteTarget = join(root, 'cleanup', 'delete.json');
    await writeFile(deleteTarget, content);
    const deleteScan = await resolveSafeWorkspaceFile(root, 'cleanup/delete.json', 'read');
    const deleteSnapshot = snapshotSafeWorkspaceFileCapability(deleteScan);
    await readSafeWorkspaceFile(deleteScan);
    await rename(deleteTarget, join(root, 'cleanup', 'delete-old.json'));
    await writeFile(deleteTarget, content);
    await expect(resolveSafeWorkspaceFile(
      root,
      'cleanup/delete.json',
      'delete-source',
      deleteSnapshot.nativeIdentity,
    )).rejects.toBeDefined();
    const replacedDeleteCapability = await resolveSafeWorkspaceFile(
      root,
      'cleanup/delete.json',
      'delete-source',
    );
    await expect(deleteSafeWorkspaceFile(
      replacedDeleteCapability,
      deleteSnapshot.nativeIdentity,
    )).rejects.toBeDefined();
    await expect(readFile(deleteTarget, 'utf8')).resolves.toBe(content);

    const renameSource = join(root, 'cleanup', 'rename.json');
    await writeFile(renameSource, content);
    const renameScan = await resolveSafeWorkspaceFile(root, 'cleanup/rename.json', 'read');
    const renameSnapshot = snapshotSafeWorkspaceFileCapability(renameScan);
    await readSafeWorkspaceFile(renameScan);
    await rename(renameSource, join(root, 'cleanup', 'rename-old.json'));
    await writeFile(renameSource, content);
    await expect(resolveSafeWorkspaceFile(
      root,
      'cleanup/rename.json',
      'rename-source',
      renameSnapshot.nativeIdentity,
    )).rejects.toBeDefined();
    const replacedRenameCapability = await resolveSafeWorkspaceFile(
      root,
      'cleanup/rename.json',
      'rename-source',
    );
    await expect(renameSafeWorkspaceFile(
      replacedRenameCapability,
      'cleanup/renamed.json',
      renameSnapshot.nativeIdentity,
    )).rejects.toBeDefined();
    await expect(readFile(renameSource, 'utf8')).resolves.toBe(content);
    await expect(readFile(join(root, 'cleanup', 'renamed.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const stableDelete = join(root, 'cleanup', 'stable-delete.json');
    await writeFile(stableDelete, content);
    const stableDeleteScan = await resolveSafeWorkspaceFile(
      root,
      'cleanup/stable-delete.json',
      'read',
    );
    const stableDeleteSnapshot = snapshotSafeWorkspaceFileCapability(stableDeleteScan);
    await readSafeWorkspaceFile(stableDeleteScan);
    const stableDeleteCapability = await resolveSafeWorkspaceFile(
      root,
      'cleanup/stable-delete.json',
      'delete-source',
      stableDeleteSnapshot.nativeIdentity,
    );
    await deleteSafeWorkspaceFile(
      stableDeleteCapability,
      stableDeleteSnapshot.nativeIdentity,
    );
    await expect(readFile(stableDelete)).rejects.toMatchObject({ code: 'ENOENT' });

    const stableRename = join(root, 'cleanup', 'stable-rename.json');
    await writeFile(stableRename, content);
    const stableRenameScan = await resolveSafeWorkspaceFile(
      root,
      'cleanup/stable-rename.json',
      'read',
    );
    const stableRenameSnapshot = snapshotSafeWorkspaceFileCapability(stableRenameScan);
    await readSafeWorkspaceFile(stableRenameScan);
    const stableRenameCapability = await resolveSafeWorkspaceFile(
      root,
      'cleanup/stable-rename.json',
      'rename-source',
      stableRenameSnapshot.nativeIdentity,
    );
    await renameSafeWorkspaceFile(
      stableRenameCapability,
      'cleanup/stable-renamed.json',
      stableRenameSnapshot.nativeIdentity,
    );
    await expect(readFile(join(root, 'cleanup', 'stable-renamed.json'), 'utf8'))
      .resolves.toBe(content);
  });

  /** @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @test UT-F005-043 */
  it('hardlink・junction/reparse・Windows危険pathをnative syscall境界で拒否する', async () => {
    const root = await temporaryRoot('f005-native-negative-');
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'file.txt'), 'data');
    await link(join(root, 'real', 'file.txt'), join(root, 'real', 'hardlink.txt'));
    await symlink(join(root, 'real'), join(root, 'junction'), 'junction');
    const client = new GuardClient();
    await expect(client.command({
      op: 'open', capabilityId: 'hard', root, relativePath: 'real/file.txt',
    })).resolves.toMatchObject({ ok: false, error: 'HARDLINK_REJECTED' });
    await expect(client.command({
      op: 'open', capabilityId: 'junction', root, relativePath: 'junction/file.txt',
    })).resolves.toMatchObject({ ok: false, error: 'REPARSE_REJECTED' });
    for (const [index, relativePath] of [
      '../outside', 'C:/outside', '//server/share', 'a\\b', 'file:ads', 'CON',
      'COM1.txt', 'LPT9', 'a/%2f/b', 'trailing.', 'trailing ', 'e\u0301.txt',
    ].entries()) {
      await expect(client.command({
        op: 'open',
        capabilityId: `bad-${index}`,
        root,
        relativePath,
      })).resolves.toMatchObject({ ok: false, error: 'PATH_INVALID' });
    }
    await client.close();
  });
});
