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
    expect(program).toContain('throw new GuardException("ETW_CONSUMER_DRAIN_TIMEOUT")');
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
    expect(program).toContain('"SYSTEM_PROCESS_BOUND_FILE_OBJECT"');
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
    expect(program).toContain('timestampQpc <= completed.CompletedAtQpc');
    expect(program).toContain('prior.RelativePath == normalized');
    expect(program).toContain('prior.Identity == completed.Identity');
    expect(program).toContain('current?.Identity == completed.Identity');
    expect(program).toContain('current?.Identity != completedWriteExpectedIdentity');
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
      'ETW_SYSTEM_SETINFO_CORRELATION_LEASE_CLOSED',
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
