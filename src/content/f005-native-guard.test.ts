import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import {
  classifyF005NativeCapacityReplyError,
  classifyF005NativeWriteThroughReplyError,
  F005_WRITE_COMPLETION_DRAIN_FAILURE_STAGES,
  F005_WRITE_LEASE_PRODUCER_BIRTH_FAILURE_STAGES,
  F005NativeCapacityError,
  flushF005ArtifactDirectory,
  isF005AfterLeaseReservationDirectoryRejoinFailureCode,
  isF005SystemDirectoryBoundLeaseRejoinFailureCode,
  isF005WriteCompletionDrainFailureCode,
  isF005WriteLeaseProducerBirthFailureCode,
  isF005ClosedLeaseRejoinDiagnosticCode,
  isF005CompletedWriteRejoinDiagnosticCode,
  isF005SystemSetInfoCorrelationDiagnosticCode,
  isF005SystemSetInfoDiagnosticCode,
  isF005SystemDirectoryWriteRejoinDiagnosticCode,
  isF005SystemDirectoryActiveLeaseWriteRejoinDiagnosticCode,
  isF005SystemDirectoryBoundLeaseWriteRejoinDiagnosticCode,
  isF005SystemDirectoryBoundLeaseRenameWriteRejoinDiagnosticCode,
  isF005SystemBoundFileObjectRejoinDiagnosticCode,
  isF005SystemBoundFileObjectRenameLeasePathRejoinDiagnosticCode,
  isF005SystemUnboundWriteDiagnosticCode,
  isF005SystemUnboundWriteOtherKnownPathDiagnosticCode,
  normalizeF005CapacityNoticePath,
  preserveF005NativeCapacityFailure,
  validateF005CapacityJournalV3,
} from './f005-native-guard.ts';
import { F005_NATIVE_GUARD_PINS } from './f005-source.ts';
import { createF005NativeCapacityJournalReader } from './f005-voice.ts';

const PROJECT_ROOT = resolve('.');
const GUARD_EXE = resolve('.cache/dotnet-f005/publish/f005-guard.exe');
const SHA = '1'.repeat(64);
const PRODUCER_SHA = F005_NATIVE_GUARD_PINS.outputBinarySha256;
const temporaryRoots: string[] = [];

it('native reply自由文字列を固定capacity error codeへ分類する', () => {
  for (const [value, expected] of [
    ['ETW_ALLOCATED_LENGTH_MISSING', 'F005_ETW_ALLOCATED_LENGTH_MISSING'],
    ['ETW_BUFFER_LOSS', 'F005_ETW_BUFFER_LOSS'],
    ['ETW_CALLBACK_ACCESS_FAILED', 'F005_ETW_CALLBACK_ACCESS_FAILED'],
    ['ETW_CALLBACK_ARGUMENT_FAILED', 'F005_ETW_CALLBACK_ARGUMENT_FAILED'],
    ['ETW_CALLBACK_AUTHORIZATION_FAILED', 'F005_ETW_CALLBACK_AUTHORIZATION_FAILED'],
    ['ETW_CALLBACK_CAPACITY_FAILED', 'F005_ETW_CALLBACK_CAPACITY_FAILED'],
    ['ETW_CALLBACK_CORRELATION_FAILED', 'F005_ETW_CALLBACK_CORRELATION_FAILED'],
    ['ETW_CALLBACK_DISPOSED', 'F005_ETW_CALLBACK_DISPOSED'],
    ['ETW_CALLBACK_IDENTITY_FAILED', 'F005_ETW_CALLBACK_IDENTITY_FAILED'],
    ['ETW_CALLBACK_FAILED', 'F005_ETW_CALLBACK_FAILED'],
    ['ETW_CALLBACK_IO_FAILED', 'F005_ETW_CALLBACK_IO_FAILED'],
    ['ETW_CALLBACK_JOURNAL_FAILED', 'F005_ETW_CALLBACK_JOURNAL_FAILED'],
    ['ETW_CALLBACK_LOCK_STATE_FAILED', 'F005_ETW_CALLBACK_LOCK_STATE_FAILED'],
    ['ETW_CALLBACK_NORMALIZE_FAILED', 'F005_ETW_CALLBACK_NORMALIZE_FAILED'],
    ['ETW_CALLBACK_OVERFLOW', 'F005_ETW_CALLBACK_OVERFLOW'],
    ['ETW_CALLBACK_PHASE_FAILED', 'F005_ETW_CALLBACK_PHASE_FAILED'],
    ['ETW_CALLBACK_RECORD_FAILED', 'F005_ETW_CALLBACK_RECORD_FAILED'],
    ['ETW_CALLBACK_STATE_FAILED', 'F005_ETW_CALLBACK_STATE_FAILED'],
    ['ETW_CONSUMER_DRAIN_FAILED', 'F005_ETW_CONSUMER_DRAIN_FAILED'],
    ['ETW_CONSUMER_DRAIN_TIMEOUT', 'F005_ETW_CONSUMER_DRAIN_TIMEOUT'],
    ['ETW_CONSUMER_STOP_TIMEOUT', 'F005_ETW_CONSUMER_STOP_TIMEOUT'],
    ['ETW_EVENT_OUTSIDE_PHASE', 'F005_ETW_EVENT_OUTSIDE_PHASE'],
    ['ETW_EVENT_PHASE_TIMESTAMP_MISMATCH', 'F005_ETW_EVENT_PHASE_TIMESTAMP_MISMATCH'],
    ['ETW_FILE_IDENTITY_MISSING', 'F005_ETW_FILE_IDENTITY_MISSING'],
    ['ETW_FILE_IDENTITY_MISSING_CREATE_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_CREATE_CORRELATION'],
    ['ETW_FILE_IDENTITY_MISSING_CREATE_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_CREATE_IDENTITY'],
    ['ETW_FILE_IDENTITY_MISSING_DELETE_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_DELETE_CORRELATION'],
    ['ETW_FILE_IDENTITY_MISSING_DELETE_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_DELETE_IDENTITY'],
    ['ETW_FILE_IDENTITY_MISSING_RENAME_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_RENAME_CORRELATION'],
    ['ETW_FILE_IDENTITY_MISSING_RENAME_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_RENAME_IDENTITY'],
    ['ETW_FILE_IDENTITY_MISSING_SETINFO_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_CORRELATION'],
    ['ETW_FILE_IDENTITY_MISSING_SETINFO_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_IDENTITY'],
    ['ETW_FILE_IDENTITY_MISSING_WRITE_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_WRITE_CORRELATION'],
    ['ETW_FILE_IDENTITY_MISSING_WRITE_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_WRITE_IDENTITY'],
    ['ETW_FILE_IDENTITY_UNSAFE', 'F005_ETW_FILE_IDENTITY_UNSAFE'],
    ['ETW_OBSERVATION_MISSING', 'F005_ETW_OBSERVATION_MISSING'],
    ['ETW_PID_NOT_JOB_MEMBER', 'F005_ETW_PID_NOT_JOB_MEMBER'],
    ['ETW_PROCESS_START_KEY_MISSING', 'F005_ETW_PROCESS_START_KEY_MISSING'],
    ['ETW_PROCESS_START_KEY_PROBE_FAILED', 'F005_ETW_PROCESS_START_KEY_PROBE_FAILED'],
    ['ETW_PROCESS_START_KEY_PROBE_IDENTITY_MISMATCH', 'F005_ETW_PROCESS_START_KEY_PROBE_IDENTITY_MISMATCH'],
    ['ETW_PROCESS_START_KEY_PROBE_REQUIRED', 'F005_ETW_PROCESS_START_KEY_PROBE_REQUIRED'],
    ['ETW_PROCESS_START_KEY_PROBE_TIMEOUT', 'F005_ETW_PROCESS_START_KEY_PROBE_TIMEOUT'],
    ['ETW_RENAME_IDENTITY_MISMATCH', 'F005_ETW_RENAME_IDENTITY_MISMATCH'],
    ['ETW_SEQUENCE_GAP', 'F005_ETW_SEQUENCE_GAP'],
    ['ETW_UNKNOWN_EVENT', 'F005_ETW_UNKNOWN_EVENT'],
    [
      'ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH',
      'F005_ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH',
    ],
  ] as const) {
    expect(classifyF005NativeCapacityReplyError(value)).toBe(expected);
  }
  expect(classifyF005NativeCapacityReplyError('F005_CAPACITY_NOTICE_UNMATCHED'))
    .toBe('F005_CAPACITY_NOTICE_UNMATCHED');
  expect(classifyF005NativeCapacityReplyError('ETW_OBSERVATION_FAILED_secret'))
    .toBe('F005_ETW_CALLBACK_FAILED');
  expect(classifyF005NativeCapacityReplyError('ETW_CONSUMER_FAILED_secret'))
    .toBe('F005_ETW_CONSUMER_FAILED');
  expect(classifyF005NativeCapacityReplyError('ETW_SESSION_STOP_FAILED_secret'))
    .toBe('F005_ETW_SESSION_STOP_FAILED');
  expect(classifyF005NativeCapacityReplyError('ETW_PRIVILEGE_REQUIRED_5'))
    .toBe('F005_ETW_PRIVILEGE_REQUIRED');
  const fixedBucket =
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_UNKNOWN_PATH_CACHE_WAV_FILE_NO_LEASE';
  expect(classifyF005NativeCapacityReplyError(fixedBucket.slice(5)))
    .toBe(fixedBucket);
  expect(isF005SystemSetInfoDiagnosticCode(fixedBucket)).toBe(true);
  expect(fixedBucket.length).toBeLessThanOrEqual(127);
  const maximumFixedBucket =
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_UNKNOWN_PATH_NODE_MODULES_OTHER_DIRECTORY_UNBOUND_LEASE';
  expect(maximumFixedBucket).toHaveLength(126);
  expect(isF005SystemSetInfoDiagnosticCode(maximumFixedBucket)).toBe(true);
  expect(classifyF005NativeCapacityReplyError(maximumFixedBucket.slice(5)))
    .toBe(maximumFixedBucket);
  for (const completedState of ['DONE_ID', 'DONE_CHANGED', 'DONE_MISSING'] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_UNKNOWN_PATH_CACHE_WAV_FILE_${completedState}` as const;
    expect(isF005SystemSetInfoDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
  }
  for (const invalid of [
    `${fixedBucket}_secret`,
    fixedBucket.replace('_CACHE_', '_PRIVATE_'),
    fixedBucket.replace('_WAV_', '_WAV/path_'),
    fixedBucket.replace('_FILE_NO_LEASE', '_LINK_NO_LEASE'),
  ]) {
    expect(isF005SystemSetInfoDiagnosticCode(invalid)).toBe(false);
    expect(classifyF005NativeCapacityReplyError(
      typeof invalid === 'string' && invalid.startsWith('F005_')
        ? invalid.slice(5)
        : invalid,
    )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  }
  for (const stage of [
    'FILE_OBJECT_ZERO',
    'LEASE_SNAPSHOT_MISSING',
    'LEASE_CURRENT_MISSING',
    'LEASE_IDENTITY_MISMATCH',
    'LEASE_OPEN_CANDIDATE',
    'LEASE_CLOSED_CANDIDATE',
    'COMPLETED_ID',
    'COMPLETED_CHANGED',
    'COMPLETED_MISSING',
    'OTHER_KNOWN_PATH',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_${stage}` as const;
    expect(isF005SystemUnboundWriteDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005SystemUnboundWriteDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  const otherKnownPath =
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_CACHE_OTHER_DIRECTORY_UNBOUND_LEASE';
  expect(isF005SystemUnboundWriteOtherKnownPathDiagnosticCode(otherKnownPath))
    .toBe(true);
  expect(classifyF005NativeCapacityReplyError(otherKnownPath.slice(5)))
    .toBe(otherKnownPath);
  const maximumOtherKnownPath =
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_NODE_MODULES_OTHER_DIRECTORY_UNBOUND_LEASE';
  expect(isF005SystemUnboundWriteOtherKnownPathDiagnosticCode(maximumOtherKnownPath))
    .toBe(true);
  expect(maximumOtherKnownPath.length).toBeLessThanOrEqual(127);
  expect(isF005SystemUnboundWriteOtherKnownPathDiagnosticCode(
    `${otherKnownPath}_PRIVATE`,
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    `${otherKnownPath.slice(5)}_PRIVATE`,
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(F005_WRITE_COMPLETION_DRAIN_FAILURE_STAGES).toHaveLength(108);
  for (const stage of F005_WRITE_COMPLETION_DRAIN_FAILURE_STAGES) {
    const code = `F005_ETW_WRITE_COMPLETION_DRAIN_${stage}` as const;
    expect(isF005WriteCompletionDrainFailureCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code)).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(
    'F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE',
  ).toHaveLength(100);
  expect(
    'F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_SETINFO',
  ).toHaveLength(102);
  expect(Math.max(...F005_WRITE_COMPLETION_DRAIN_FAILURE_STAGES
    .filter((stage) => stage.startsWith('LATE_DIAG_'))
    .map((stage) => `F005_ETW_WRITE_COMPLETION_DRAIN_${stage}`.length)))
    .toBe(112);
  expect(F005_WRITE_LEASE_PRODUCER_BIRTH_FAILURE_STAGES).toHaveLength(4);
  for (const stage of F005_WRITE_LEASE_PRODUCER_BIRTH_FAILURE_STAGES) {
    const rawCode = `WRITE_LEASE_PRODUCER_BIRTH_${stage}`;
    const code = `F005_${rawCode}` as const;
    expect(isF005WriteLeaseProducerBirthFailureCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(rawCode)).toBe(code);
    expect(classifyF005NativeCapacityReplyError(code)).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  for (const code of [
    'WRITE_LEASE_PRODUCER_BIRTH_PRIVATE',
    'WRITE_LEASE_PRODUCER_BIRTH_TIMEOUT_EXTRA',
    'F005_WRITE_LEASE_PRODUCER_BIRTH_TIMEOUT_EXTRA',
    'F005_WRITE_LEASE_PRODUCER_BIRTH_TIMEOUT'.padEnd(128, 'X'),
  ]) {
    expect(isF005WriteLeaseProducerBirthFailureCode(code)).toBe(false);
    // CHG-F005-072: 固定識別子は型付きcodeへ誤認せず、F005_NATIVE_接頭辞で透過する。
    expect(classifyF005NativeCapacityReplyError(code))
      .toBe(`F005_NATIVE_${code}`);
  }
  // 固定識別子でない値だけがcatch-allへ落ちる。
  for (const value of ['lower_case', 'has space', '9LEADING', '', 42, null, {}]) {
    expect(classifyF005NativeCapacityReplyError(value))
      .toBe('F005_CAPACITY_GUARD_REJECTED');
  }
  for (const code of [
    'F005_ETW_WRITE_COMPLETION_DRAIN_PRIVATE',
    'F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_SAME_LEASE',
    'F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_SAME_LEASE',
    'F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_EXACT_ONE_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_AMBIGUOUS_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_ALL_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_MIXED_EXTRA',
    'F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT'.padEnd(128, 'X'),
  ]) {
    expect(isF005WriteCompletionDrainFailureCode(code)).toBe(false);
    // CHG-F005-072: 型付きcodeへは誤認せず、F005_NATIVE_接頭辞で透過する。
    expect(classifyF005NativeCapacityReplyError(code))
      .toBe(`F005_NATIVE_${code}`);
  }
  for (const stage of [
    'SNAPSHOT_MISSING',
    'CURRENT_MISSING',
    'IDENTITY_MISMATCH',
    'OWNER_MISSING',
    'ROOT_INACTIVE',
    'CANDIDATE',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_WRITE_REJOIN_${stage}` as const;
    expect(isF005SystemDirectoryWriteRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
  }
  expect(isF005SystemDirectoryWriteRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_WRITE_REJOIN_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_WRITE_REJOIN_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'DIRECTORY_SNAPSHOT_MISSING',
    'DIRECTORY_CURRENT_MISSING',
    'DIRECTORY_IDENTITY_MISMATCH',
    'DIRECTORY_OWNER_MISSING',
    'DIRECTORY_ROOT_INACTIVE',
    'DIRECTORY_UNKNOWN',
    'LEASE_MISSING',
    'LEASE_PHASE',
    'LEASE_PARENT',
    'LEASE_BOUND',
    'LEASE_CLOSED',
    'LEASE_ESCAPE',
    'CANDIDATE',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_ACTIVE_LEASE_WRITE_REJOIN_${stage}` as const;
    expect(isF005SystemDirectoryActiveLeaseWriteRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005SystemDirectoryActiveLeaseWriteRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_ACTIVE_LEASE_WRITE_REJOIN_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_ACTIVE_LEASE_WRITE_REJOIN_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'DIRECTORY_SNAPSHOT_MISSING',
    'DIRECTORY_CURRENT_MISSING',
    'DIRECTORY_IDENTITY_MISMATCH',
    'DIRECTORY_OWNER_MISSING',
    'DIRECTORY_ROOT_INACTIVE',
    'DIRECTORY_UNKNOWN',
    'LEASE_MISSING',
    'LEASE_PHASE',
    'LEASE_PARENT',
    'LEASE_CLOSED',
    'LEASE_UNBOUND',
    'LEASE_SNAPSHOT_MISSING',
    'LEASE_BINDING_MISSING',
    'LEASE_BINDING_MISMATCH',
    'LEASE_CURRENT_MISSING',
    'LEASE_IDENTITY_MISMATCH',
    'LEASE_ESCAPE',
    'CANDIDATE',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_${stage}` as const;
    expect(isF005SystemDirectoryBoundLeaseWriteRejoinDiagnosticCode(code))
      .toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005SystemDirectoryBoundLeaseWriteRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'PATH_MISSING',
    'PARENT',
    'RESERVATION_MISSING',
    'BEFORE_LEASE_RESERVATION',
    'AFTER_LEASE_RESERVATION',
    'CURRENT_MISSING',
    'IDENTITY_MISMATCH',
    'LEASE_ESCAPE',
    'CANDIDATE',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_${stage}` as const;
    expect(isF005SystemDirectoryBoundLeaseRenameWriteRejoinDiagnosticCode(code))
      .toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005SystemDirectoryBoundLeaseRenameWriteRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_BEFORE_RESERVATION',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'TUPLE_INSPECTION_FAILED',
    'PROCESS_WAIT_FAILED',
    'PROCESS_IDENTITY_FAILED',
    'JOB_QUERY_FAILED',
    'PROCESS_OUTSIDE_JOB',
    'DIRECTORY_IDENTITY_MISMATCH',
    'LEASE_CURRENT_EXISTS',
    'TARGET_IDENTITY_MISMATCH',
    'BINDING_MISMATCH',
  ] as const) {
    const code =
      `F005_ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_${stage}` as const;
    expect(isF005AfterLeaseReservationDirectoryRejoinFailureCode(code))
      .toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005AfterLeaseReservationDirectoryRejoinFailureCode(
    'F005_ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'INITIAL_TUPLE_INSPECTION_FAILED',
    'PROCESS_IDENTITY_FAILED',
    'PROCESS_WAIT_FAILED',
    'JOB_QUERY_FAILED',
    'PROCESS_TUPLE_MISMATCH',
    'PROCESS_SIGNALED',
    'PROCESS_OUTSIDE_JOB',
    'ACTIVE_LEASE_CHANGED',
    'EVENT_FILE_OBJECT_BOUND',
    'RENAME_STATE_CHANGED',
    'DIRECTORY_IDENTITY_MISMATCH',
    'LEASE_CURRENT_IDENTITY_MISMATCH',
    'BINDING_MISMATCH',
    'PROCESS_RECHECK_IDENTITY_FAILED',
    'PROCESS_RECHECK_WAIT_FAILED',
    'PROCESS_RECHECK_JOB_QUERY_FAILED',
    'PROCESS_RECHECK_TUPLE_MISMATCH',
    'PROCESS_RECHECK_SIGNALED',
    'PROCESS_RECHECK_OUTSIDE_JOB',
  ] as const) {
    const code =
      `F005_ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_${stage}` as const;
    expect(isF005SystemDirectoryBoundLeaseRejoinFailureCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  for (const code of [
    'F005_ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PRIVATE',
    'F005_ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_SIGNALED_EXTRA',
    'F005_ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_SIGNALED'.padEnd(
      128,
      'X',
    ),
  ]) {
    expect(isF005SystemDirectoryBoundLeaseRejoinFailureCode(code)).toBe(false);
    expect(classifyF005NativeCapacityReplyError(code.slice(5)))
      .toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  }
  for (const stage of [
    'SNAPSHOT_MISSING',
    'PATH_MISMATCH',
    'CURRENT_MISSING',
    'IDENTITY_MISMATCH',
    'LEASE_MISSING',
    'LEASE_PHASE',
    'LEASE_BINDING',
    'LEASE_CLOSED',
    'LEASE_ESCAPE',
    'CANDIDATE',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_${stage}` as const;
    expect(isF005SystemBoundFileObjectRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005SystemBoundFileObjectRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_LEASE_PATH',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  const noPendingStages = [
    'NO_PENDING_FILE',
    'NO_PENDING_OTHER',
    'NO_PENDING_DIR_SNAPSHOT_MISSING',
    'NO_PENDING_DIR_CURRENT_MISSING',
    'NO_PENDING_DIR_ID_MISMATCH',
    'NO_PENDING_DIR_OWNER_MISSING',
    'NO_PENDING_DIR_ROOT_INACTIVE',
    'NO_PENDING_DIR_UNKNOWN',
    'NO_PENDING_LEASE_PARENT',
    'NO_PENDING_LEASE_CLOSED',
    'NO_PENDING_LEASE_SNAPSHOT_MISSING',
    'NO_PENDING_LEASE_BINDING_MISSING',
    'NO_PENDING_LEASE_BINDING_MISMATCH',
    'NO_PENDING_LEASE_CURRENT_MISSING',
    'NO_PENDING_LEASE_ID_MISMATCH',
    'NO_PENDING_LEASE_ESCAPE',
    'NO_PENDING_CANDIDATE',
    'NO_PENDING_STATE_DRIFT',
  ] as const;
  for (const stage of noPendingStages) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_${stage}` as const;
    expect(isF005SystemBoundFileObjectRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeGreaterThanOrEqual(83);
    expect(code.length).toBeLessThanOrEqual(101);
  }
  expect(noPendingStages).toHaveLength(18);
  const noPendingUnboundStages = [
    'NO_PENDING_UNBOUND_SNAPSHOT_PRESENT',
    'NO_PENDING_UNBOUND_BEFORE_RESERVATION',
    'NO_PENDING_UNBOUND_CURRENT_INSPECTION_FAILED',
    'NO_PENDING_UNBOUND_CURRENT_MISSING',
    'NO_PENDING_UNBOUND_DEFERRED_MISSING',
    'NO_PENDING_UNBOUND_DEFERRED_TUPLE',
    'NO_PENDING_UNBOUND_CURRENT_ID_MISMATCH',
    'NO_PENDING_UNBOUND_PROCESS_WAIT_FAILED',
    'NO_PENDING_UNBOUND_PROCESS_IDENTITY_FAILED',
    'NO_PENDING_UNBOUND_JOB_QUERY_FAILED',
    'NO_PENDING_UNBOUND_PROCESS_TUPLE',
    'NO_PENDING_UNBOUND_PROCESS_SIGNALED',
    'NO_PENDING_UNBOUND_LEASE_ESCAPE',
    'NO_PENDING_UNBOUND_CANDIDATE',
  ] as const;
  for (const stage of noPendingUnboundStages) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_${stage}` as const;
    expect(isF005SystemBoundFileObjectRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeGreaterThanOrEqual(96);
    expect(code.length).toBeLessThanOrEqual(112);
  }
  expect(noPendingUnboundStages).toHaveLength(14);
  expect(isF005SystemBoundFileObjectRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_NO_PENDING_LEASE_UNBOUND',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_NO_PENDING_LEASE_UNBOUND',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_NO_PENDING_UNBOUND_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'TARGET_MISMATCH',
    'RESERVATION_MISSING',
    'RESERVATION_ORDER',
    'BEFORE_LEASE_RESERVATION',
    'AFTER_LEASE_RESERVATION',
    'LEASE_CURRENT_EXISTS',
    'SNAPSHOT_MISSING',
    'SNAPSHOT_PATH',
    'IDENTITY_MISMATCH',
    'BINDING_MISMATCH',
    'LEASE_CLOSED',
    'LEASE_ESCAPE',
    'CANDIDATE',
  ] as const) {
    const code =
      `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_RENAME_LEASE_PATH_${stage}` as const;
    expect(isF005SystemBoundFileObjectRenameLeasePathRejoinDiagnosticCode(code))
      .toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
    expect(code.length).toBeLessThanOrEqual(127);
  }
  expect(isF005SystemBoundFileObjectRenameLeasePathRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_RENAME_LEASE_PATH_PRIVATE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_RENAME_LEASE_PATH_PRIVATE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(isF005SystemBoundFileObjectRenameLeasePathRejoinDiagnosticCode(
    'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_RENAME_LEASE_PATH_PATH_MISSING',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_RENAME_LEASE_PATH_PATH_MISSING',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(classifyF005NativeCapacityReplyError(
    'ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'CREATE_BIND_MISMATCH',
    'CREATE_SNAPSHOT_MISSING',
    'CURRENT_MISSING',
    'DEFERRED_BIND_MISMATCH',
    'DEFERRED_CLEANUP',
    'DEFERRED_SNAPSHOT_MISSING',
    'DEFERRED_TUPLE_MISMATCH',
    'FILE_OBJECT_MISMATCH',
    'IDENTITY_MISMATCH',
    'LEASE_CLOSED',
    'LEASE_SNAPSHOT_MISSING',
    'RENAME_CONSUME',
  ] as const) {
    const code = `F005_ETW_SYSTEM_SETINFO_CORRELATION_${stage}` as const;
    expect(isF005SystemSetInfoCorrelationDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
  }
  expect(isF005SystemSetInfoCorrelationDiagnosticCode(
    'F005_ETW_SYSTEM_SETINFO_CORRELATION_PRIVATE_PATH',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_SYSTEM_SETINFO_CORRELATION_PRIVATE_PATH',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'AUTH_FAILURE',
    'SYSTEM_PID',
    'EVENT',
    'FILE_OBJECT_ZERO',
    'PHASE',
    'BEFORE_RESERVATION',
    'AFTER_COMPLETION_WITHIN_100MS',
    'AFTER_COMPLETION_WITHIN_500MS',
    'AFTER_COMPLETION_WITHIN_2S',
    'AFTER_COMPLETION_WITHIN_10S',
    'AFTER_COMPLETION_OVER_10S',
    'FILE_OBJECT_BINDING',
    'CURRENT_MISSING',
    'IDENTITY_MISMATCH',
  ] as const) {
    const code = `F005_ETW_COMPLETED_WRITE_REJOIN_${stage}` as const;
    expect(isF005CompletedWriteRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
  }
  expect(isF005CompletedWriteRejoinDiagnosticCode(
    'F005_ETW_COMPLETED_WRITE_REJOIN_PRIVATE_VALUE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_COMPLETED_WRITE_REJOIN_PRIVATE_VALUE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  for (const stage of [
    'SNAPSHOT_MISSING',
    'FILE_OBJECT_BINDING',
    'CURRENT_MISSING',
    'IDENTITY_MISMATCH',
    'CANDIDATE',
  ] as const) {
    const code = `F005_ETW_CLOSED_LEASE_REJOIN_${stage}` as const;
    expect(isF005ClosedLeaseRejoinDiagnosticCode(code)).toBe(true);
    expect(classifyF005NativeCapacityReplyError(code.slice(5))).toBe(code);
  }
  expect(isF005ClosedLeaseRejoinDiagnosticCode(
    'F005_ETW_CLOSED_LEASE_REJOIN_PRIVATE_VALUE',
  )).toBe(false);
  expect(classifyF005NativeCapacityReplyError(
    'ETW_CLOSED_LEASE_REJOIN_PRIVATE_VALUE',
  )).toBe('F005_CAPACITY_ETW_OBSERVATION_FAILED');
  expect(classifyF005NativeCapacityReplyError('NOTICE_PHASE_MISMATCH_secret'))
    .toBe('F005_CAPACITY_GUARD_REJECTED');
  expect(classifyF005NativeCapacityReplyError(null))
    .toBe('F005_CAPACITY_GUARD_REJECTED');
  for (const prototypeKey of ['toString', 'constructor', '__proto__']) {
    expect(classifyF005NativeCapacityReplyError(prototypeKey))
      .toBe('F005_CAPACITY_GUARD_REJECTED');
  }
});

it('write-through helper replyを秘密を含まない固定カテゴリへ分類する', () => {
  for (const [value, expected] of [
    ['WRITE_THROUGH_OPEN_FAILED_5', 'F005_NATIVE_WRITE_THROUGH_OPEN_FAILED'],
    ['DIRECTORY_OPEN_FAILED_5', 'F005_NATIVE_WRITE_THROUGH_OPEN_FAILED'],
    ['WRITE_THROUGH_FLUSH_FAILED_1117', 'F005_NATIVE_WRITE_THROUGH_FLUSH_FAILED'],
    ['WRITE_THROUGH_IDENTITY_UNSAFE', 'F005_NATIVE_WRITE_THROUGH_IDENTITY_FAILED'],
    ['IDENTITY_READ_FAILED_6', 'F005_NATIVE_WRITE_THROUGH_IDENTITY_FAILED'],
    ['WRITE_THROUGH_LENGTH_MISMATCH', 'F005_NATIVE_WRITE_THROUGH_VERIFY_FAILED'],
    ['WRITE_THROUGH_CLEANUP_FAILED', 'F005_NATIVE_WRITE_THROUGH_CLEANUP_FAILED'],
    ['WRITE_THROUGH_DELETE_ON_CLOSE_CLEAR_FAILED_50', 'F005_NATIVE_WRITE_THROUGH_CLEANUP_FAILED'],
    ['WRITE_THROUGH_UNKNOWN', 'F005_NATIVE_WRITE_THROUGH_PROTOCOL_FAILED'],
  ] as const) {
    expect(classifyF005NativeWriteThroughReplyError(value)).toBe(expected);
  }
  expect(classifyF005NativeWriteThroughReplyError({ path: 'secret' }))
    .toBe('F005_NATIVE_WRITE_THROUGH_PROTOCOL_FAILED');
});

it('分類済みwrite-through failureを外側catchでgeneric再包装しない', () => {
  const classified = new F005NativeCapacityError(
    'F005_NATIVE_WRITE_THROUGH_OPEN_FAILED',
    'fixed category',
  );
  expect(() => preserveF005NativeCapacityFailure(classified, 'outer'))
    .toThrow(classified);
  expect(() => preserveF005NativeCapacityFailure(new Error('channel'), 'outer'))
    .toThrow(expect.objectContaining({
      code: 'F005_CAPACITY_IPC_FAILED',
      cause: expect.any(Error),
    }));
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validJournal(): Record<string, unknown> {
  const notice = {
    notice: {
      event: 'create',
      noticeId: '3'.repeat(64),
      path: 'data/batches/F005/sample.wav',
      phase: 'voice',
      phaseInstanceId: SHA,
      workId: '000799',
    },
    noticeSequence: 1,
    observationSequences: [1],
    sessionNonce: SHA,
    state: 'matched',
    workerPid: 1234,
  };
  const body = {
    candidateSha256: 'b'.repeat(64),
    // CHG-F005-072: 容量actualは明示サンプリングを正とする。
    capacitySamples: [
      { freeBytesAvailable: 90_000, liveBytes: 4096, reason: 'notice', sequence: 1 },
    ],
    etwSessionIdentity: 'F005Capacity-fixture',
    initialFreeBytes: 100_000,
    jobIdentity: 'f005-job-fixture',
    minimumObservedFreeBytes: 90_000,
    notices: [notice],
    owner: 'UT-F005-047',
    peakLiveBytes: 4096,
    phases: [
      {
        freeBytes: 100_000,
        liveBytes: 0,
        observedAt: '2026-07-29T00:00:00.0000000+00:00',
        phase: 'voice',
        phaseInstanceId: SHA,
        state: 'started',
        workId: '000799',
      },
      {
        freeBytes: 90_000,
        liveBytes: 4096,
        observedAt: '2026-07-29T00:00:01.0000000+00:00',
        phase: 'voice',
        phaseInstanceId: SHA,
        state: 'finished',
        workId: '000799',
      },
    ],
    registeredWorkerPids: [1234],
    schemaVersion: 3,
    sessionNonce: SHA,
    workId: '000799',
  };
  return {
    ...body,
    closedSeal: {
      etwSequenceGapCount: 0,
      firstEtwSequence: 1,
      journalBodySha256: hash(canonicalJson(body)),
      lastEtwSequence: 1,
      producerBinarySha256: PRODUCER_SHA,
    },
    state: 'closed',
  };
}

it('startup失敗の固定codeをflushしてからkill-on-close guardを停止する', async () => {
  const source = await readFile(resolve('src/content/f005-native-guard.ts'), 'utf8');
  const failurePath = source.slice(
    source.indexOf('const failure = error instanceof F005NativeCapacityError'),
    source.indexOf('export interface CapacityJournalV3'),
  );
  expect(failurePath).toContain('await options.onStartupFailure?.(failure.code)');
  expect(failurePath.indexOf('await options.onStartupFailure?.(failure.code)'))
    .toBeLessThan(failurePath.indexOf('guard?.terminate()'));
  expect(failurePath).toContain("startupStage === 'pipe-connect'");
  expect(failurePath).toContain("'F005_CAPACITY_IPC_CONNECT_FAILED'");
  expect(failurePath).toContain("'F005_CAPACITY_REGISTER_SELF_FAILED'");
  expect(failurePath).toContain("'F005_CAPACITY_PROCESS_IDENTITY_PROBE_ARM_FAILED'");
  expect(failurePath).toContain("'F005_CAPACITY_PROCESS_IDENTITY_PROBE_WRITE_FAILED'");
  expect(failurePath).toContain("'F005_CAPACITY_PROCESS_IDENTITY_PROBE_VERIFY_FAILED'");
});

describe('F005 native ETW capacity guard', () => {
  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-019 FUN-F005-047 @test UT-F005-019 UT-F005-047 */
  it('closed CapacityJournalV3のETW・notice・容量・body sealを再計算する', () => {
    expect(validateF005CapacityJournalV3(validJournal())).toMatchObject({
      schemaVersion: 3,
      state: 'closed',
      peakLiveBytes: 4096,
      minimumObservedFreeBytes: 90_000,
    });
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 SC-F005-U047-A SC-F005-U047-B */
  it.each([
    ['notice replay/gap', (journal: Record<string, unknown>) => {
      ((journal.notices as Record<string, unknown>[])[0]!).noticeSequence = 2;
    }],
    ['notice mismatch', (journal: Record<string, unknown>) => {
      (((journal.notices as Record<string, unknown>[])[0]!).notice as Record<string, unknown>).event = 'delete';
    }],
    ['notice path mismatch', (journal: Record<string, unknown>) => {
      (((journal.notices as Record<string, unknown>[])[0]!).notice as Record<string, unknown>).path =
        'data/batches/F005/other.wav';
    }],
  ])('%sではclosed journalを受理しない', (_label, mutate) => {
    const journal = structuredClone(validJournal());
    mutate(journal);
    expect(() => validateF005CapacityJournalV3(journal))
      .toThrowError(F005NativeCapacityError);
  });


  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 IT-F005-005 */
  it('open journalは診断読込だけ許しactualへの昇格を拒否する', () => {
    const journal = validJournal();
    journal.state = 'open';
    journal.closedSeal = null;
    expect(validateF005CapacityJournalV3(journal, false)).toMatchObject({ state: 'open' });
    expect(() => validateF005CapacityJournalV3(journal, true))
      .toThrowError(/open journal/u);
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 */
  it('application絶対pathをworkspace相対pathへ変換しescapeを拒否する', () => {
    const workspace = resolve('C:/f005-workspace');
    expect(normalizeF005CapacityNoticePath(
      workspace,
      resolve(workspace, 'data/batches/F005/sample.wav'),
    )).toBe('data/batches/F005/sample.wav');
    expect(() => normalizeF005CapacityNoticePath(
      workspace,
      resolve(workspace, '../escape.wav'),
    )).toThrowError(F005NativeCapacityError);
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-019 FUN-F005-047 @test UT-F005-019 UT-F005-047 */
  it('canonical native journalを既存actual journal readerへbridgeする', async () => {
    const workspace = resolve(await mkdtemp(join(tmpdir(), 'f005-native-journal-')));
    temporaryRoots.push(workspace);
    const journalId = 'a'.repeat(64);
    const journalPath = `.cache/f005-capacity/${journalId}.json`;
    await mkdir(join(workspace, '.cache', 'f005-capacity'), { recursive: true });
    const journalText = canonicalJson(validJournal());
    await writeFile(join(workspace, ...journalPath.split('/')), journalText, 'utf8');
    const reader = createF005NativeCapacityJournalReader({
      journalId,
      journalPath,
      journalSha256: createHash('sha256').update(journalText).digest('hex'),
      workId: '000799',
      candidateSha256: 'b'.repeat(64),
      workspaceRoot: workspace,
      distRoot: join(workspace, 'dist'),
      entries: [],
    });
    await expect(reader.readClosedCapacityJournal(workspace)).resolves.toMatchObject({
      schemaVersion: 3,
      state: 'closed',
      journalId,
      allowedWorkerPids: [1234],
      phases: [{ phase: 'voice', phaseInstanceId: SHA }],
      events: [{
        sequence: 1,
        path: 'data/batches/F005/sample.wav',
        noticeId: '3'.repeat(64),
      }],
    });
    const mismatchedReader = createF005NativeCapacityJournalReader({
      journalId,
      journalPath,
      journalSha256: createHash('sha256').update(journalText).digest('hex'),
      workId: '000799',
      candidateSha256: 'c'.repeat(64),
      workspaceRoot: workspace,
      distRoot: join(workspace, 'dist'),
      entries: [],
    });
    await expect(mismatchedReader.readClosedCapacityJournal(workspace))
      .rejects.toMatchObject({ code: 'F005_CAPACITY_ACTUAL_INVALID' });
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 IT-F005-005 */
  it.runIf(process.platform === 'win32')(
    '実binaryはkernel ETW権限不足を明示しfallbackしない',
    async () => {
      await expect(readFile(GUARD_EXE)).resolves.not.toHaveLength(0);
      const child = spawn(GUARD_EXE, [], {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = createInterface({ input: child.stdout });
      const replyPromise = new Promise<Record<string, unknown>>((resolveReply, reject) => {
        lines.once('line', (line) => {
          try {
            resolveReply(JSON.parse(line) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
        child.once('error', reject);
      });
      child.stdin.write('{"op":"capacity-preflight"}\n');
      const reply = await replyPromise;
      expect(
        reply.ok === true
          ? reply
          : { ok: reply.ok, error: String(reply.error).split('_').slice(0, 3).join('_') },
      ).toEqual(reply.ok === true
        ? expect.objectContaining({
            ok: true,
            capacityAbi: 'f005-capacity-pipe-v3',
            etw: 'system-io-process-start-key',
          })
        : { ok: false, error: 'ETW_PRIVILEGE_REQUIRED' });
      child.stdin.end();
      await new Promise<void>((resolveExit, reject) => {
        child.once('exit', (code) => code === 0
          ? resolveExit()
          : reject(new Error(`guard exit ${String(code)}`)));
        child.once('error', reject);
      });
    },
  );

  /** @des DES-F005-006 @fun FUN-F005-022 @test UT-F005-022 IT-F005-006 */
  it.runIf(process.platform === 'win32')(
    '固定native sync-directory opでworkspace配下directoryを実flushする',
    async () => {
      const workspace = resolve(await mkdtemp(join(tmpdir(), 'f005-native-directory-sync-')));
      temporaryRoots.push(workspace);
      const directory = join(workspace, 'evidence', 'voice');
      await mkdir(directory, { recursive: true });
      await expect(flushF005ArtifactDirectory(workspace, directory, {
        executable: GUARD_EXE,
      })).resolves.toBeUndefined();
      await expect(flushF005ArtifactDirectory(
        workspace,
        resolve(workspace, '..', 'escape'),
        { executable: GUARD_EXE },
      )).rejects.toMatchObject({ code: 'F005_DIRECTORY_SYNC_FAILED' });
    },
  );

  it.runIf(process.platform === 'win32')(
    '高速native guard終了でもexit listenerを取り逃がさない',
    async () => {
      const workspace = resolve(await mkdtemp(join(tmpdir(), 'f005-native-fast-exit-')));
      temporaryRoots.push(workspace);
      const directory = join(workspace, 'evidence');
      await mkdir(directory, { recursive: true });
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await expect(flushF005ArtifactDirectory(workspace, directory, {
          executable: GUARD_EXE,
        })).resolves.toBeUndefined();
      }
      const source = await readFile(resolve('src/content/f005-native-guard.ts'), 'utf8');
      const closeBody = source.slice(
        source.indexOf('async close(): Promise<void>'),
        source.indexOf('terminate(): void'),
      );
      expect(closeBody.indexOf("this.process.once('exit', onExit)"))
        .toBeLessThan(closeBody.indexOf('this.process.stdin.end()'));
      expect(closeBody.indexOf('const observedExitCode = this.process.exitCode'))
        .toBeLessThan(closeBody.indexOf('this.process.stdin.end()'));
    },
  );

  it('rootだけを明示Job登録し、子workerはbreakaway禁止Job継承でETW認可する', async () => {
    const source = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    expect(source).toContain('case "registerSelf":');
    expect(source).toContain('rootWorkerPid = pid');
    expect(source).toContain('rootWorkerProcess = process');
    expect(source).toContain('var processIdentity = job.ProcessIdentity(process)');
    expect(source).toContain('rootWorkerStartKey = processIdentity.ProcessStartKey');
    expect(source).toContain('rootWorkerSequenceNumber = processIdentity.ProcessSequenceNumber');
    expect(source).toContain('rootWorkerStartKey != eventProcessStartKey');
    expect(source).toContain('if (!RootWorkerAliveLocked(clientPid) || !registeredPids.Contains(clientPid))');
    expect(source).toContain('if (!journalClosed) PoisonLocked("IPC_PEER_DISCONNECTED")');
    expect(source).toContain('job.Contains(rootWorkerProcess)');
    expect(source).toContain('rootWorkerProcess?.Dispose()');
    expect(source.match(/ROOT_PID_NOT_RUNNING/gu)).toHaveLength(2);
    expect(source).not.toContain('case "registerPid":');
    expect(source).toContain('AuthorizeJobMemberLocked(\n                data.ProcessID,');
    expect(source).toContain('AuthorizeJobMemberLocked(\n                    pid,');
    expect(source).toContain('etwSource.Registered.All += ObserveProcessBirth');
    expect(source).toContain('eventTimestampQpc <= birth.StartedAtQpc');
    expect(source).toContain('identity.ProcessSequenceNumber != birth.ProcessSequenceNumber');
    expect(source).toContain('if (job.IsAliveOutsideJob(retained.Process))');
    expect(source).not.toContain('if (!job.Contains(retained.Process))');
    expect(source).toContain('if (waitResult == 0) return false;');
    expect(source).toContain('return !IsProcessInJob(processHandle, handle, out var result) || !result;');
    expect(source).toContain('foreach (var pid in job.MemberPids())');
    expect(source).toContain('QueryInformationJobObject(');
    expect(source).toContain('LimitFlags = JobObjectLimitKillOnJobClose');
    expect(source).not.toContain('JobObjectLimitBreakawayOk');
    expect(source).not.toContain('JobObjectLimitSilentBreakawayOk');
    expect(source).toContain('case "sync-directory":');
    expect(source).toContain('GetFinalPathNameByHandleW(');
    expect(source).toContain('FileFlagOpenReparsePoint');
    expect(source).toContain('ShareRead | ShareWrite');
    expect(source).toMatch(/CreateFileW\(\s*absolute,\s*0,\s*0x00000001 \| 0x00000002 \| 0x00000004/u);
    expect(source).toContain('FlushFileBuffers(heldDirectories[^1])');
  });

  it('rename ETWの旧名とnoticeの新名を同一FileIdで相関し、未照合renameを閉じない', async () => {
    const source = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    expect(source).toContain('private readonly Dictionary<string, FileSnapshot> filesByPath');
    expect(source).toContain('private readonly List<DeferredRenameRecord> deferredRenames');
    expect(source).toContain('kernel.FileIOCleanup += data => ForgetFileObject(data.FileObject)');
    expect(source).toContain('var source = filesByPath.GetValueOrDefault(normalized) ?? prior');
    expect(source).toContain(
      'var effective = current ?? filesByPath.GetValueOrDefault(normalized) ?? prior',
    );
    expect(source).not.toContain('filesByObject[deferred.FileObject] = target');
    expect(source).toContain('item.Source.RelativePath == from');
    expect(source).toContain('var target = InspectDeferredRenameTarget(notice.To)');
    expect(source).toContain('if (target.Identity != deferred.Source.Identity)');
    // CHG-F005-072: 未照合renameでphaseを止める契約は廃止し、
    // 宣言はdeclaredで受理してphase前後の実測差分で健全性を証明する。
    expect(source).not.toContain('deferredRenames.Any(item => item.PhaseInstanceId == phaseInstanceId)');
    expect(source).toContain('if (record.State != "matched") record.Declare();');
    expect(source).toContain('item.State != "matched" && item.State != "declared"');
    expect(source).toMatch(
      /DeferredRenameRecord\(\s*pid,\s*producerSequenceNumber,\s*checked\(\+\+etwSequence\)/u,
    );
    expect(source).toContain('var sequence = deferred.EtwSequence');
    expect(source).toMatch(
      /if \(deferredRenames\.Count != 0\)\s*\{\s*PoisonLocked\("ETW_RENAME_IDENTITY_MISMATCH"\)/u,
    );
    expect(source).toContain('filesByPath.Remove(deferred.Source.RelativePath)');
    expect(source).toContain('filesByPath[target.RelativePath] = target');
  });

  it('System SetInfoは予約済みJob childの同一FileObjectへ後着Createで完全相関する', async () => {
    const [program, bridge] = await Promise.all([
      readFile(resolve('native/f005-guard/Program.cs'), 'utf8'),
      readFile(resolve('src/content/f005-native-guard.ts'), 'utf8'),
    ]);
    expect(program).toContain('case "reserveWrite":');
    expect(program).toContain('case "prepareWriteRename":');
    expect(program).toContain('case "completeWrite":');
    expect(program).toContain('job.OpenContainedProcess(producerPid)');
    expect(program).toContain('identity.ProcessSequenceNumber');
    expect(program).toContain('TryAuthorizeReservedSystemSetInfoLocked(');
    expect(program).toContain('SystemSetInfoCorrelationRules.MatchesReservation(');
    expect(program).toContain('SystemSetInfoCorrelationRules.CanBindDeferred(');
    expect(program).toContain('item.Snapshot.Identity');
    expect(program).toContain('ReplayDeferredSystemSetInfoLocked(deferred)');
    expect(program).toContain('lease.FileObjectClosed = true');
    expect(program).toContain('SystemSetInfoCorrelationRules.CleanupInvalidates(');
    expect(program).toContain('SystemSetInfoCorrelationRules.TryGetReservationQpc(');
    expect(program).toContain('SystemSetInfoCorrelationRules.CanPrepareRename(');
    expect(program).toContain('SystemSetInfoCorrelationRules.TryConsumeRename(');
    expect(program).toContain('writeLease.CurrentPathReservedAtQpc = promotedReservationQpc');
    expect(program).toContain('timestampQpc > pathReservationQpc');
    expect(program).toContain('job.IsSignaled(lease.Process)');
    expect(program).toContain('current.Identity != lease.Snapshot!.Identity');
    // CHG-F005-072: 未解決write leaseは維持し、帰属不能なdeferred System eventのみ
    // 致命扱いから外す。
    expect(program).toContain('if (pendingWriteLease is not null)');
    expect(program).not.toContain('pendingWriteLease is not null || deferredSystemSetInfos.Count != 0');
    expect(program).toContain('ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_SNAPSHOT_MISSING');
    expect(bridge.indexOf("op: 'reserveWrite'"))
      .toBeLessThan(bridge.indexOf("op: 'write-through'"));
    expect(bridge.indexOf("op: 'prepareWriteRename'"))
      .toBeLessThan(bridge.indexOf("op: 'write-rename'"));
    expect(bridge.indexOf('await writer.close();'))
      .toBeLessThan(bridge.indexOf("op: 'completeWrite'"));
  });

  it.runIf(process.platform === 'win32')('System SetInfo相関のnative規則を攻撃ケース込みで実行する', async () => {
    const dotnet = resolve('.cache/dotnet-f005/sdk/dotnet.exe');
    const child = spawn(dotnet, [
      'run',
      '--project',
      resolve('native/f005-guard-tests/F005Guard.CorrelationTests.csproj'),
      '--configuration',
      'Release',
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DOTNET_CLI_HOME: resolve('.cache/dotnet-f005/cli-home'),
        DOTNET_NOLOGO: '1',
        NUGET_PACKAGES: resolve('.cache/dotnet-f005/nuget'),
      },
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    expect({ exitCode, output }).toMatchObject({
      exitCode: 0,
      output: expect.stringContaining('System SetInfo correlation tests PASS (1287 cases)'),
    });
  }, 120_000);
});
