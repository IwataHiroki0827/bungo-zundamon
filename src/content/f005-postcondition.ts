import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

import type { Sha256 } from './batch.ts';

/**
 * F005 phaseの書込み健全性を事後検証する。
 *
 * phase実行中の全カーネルファイルイベントをETWで逐次相関する常時監視は、
 * 共有hosted runner上で帰属不能なSystem(PID 4)の遅延書き戻しが無限に現れるため
 * 収束しない（CHG-F005-072）。本モジュールはphase前後の実測差分が
 * 宣言済みmutation集合とexactに一致することで同じ性質を証明する。
 *
 * @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047
 */

/** 走査対象root。REQ-F005-017が守る公開物・原典・成果物に限定する。 */
export const F005_TRACKED_ROOTS = Object.freeze([
  'content',
  'data',
  'public',
] as const);

export type F005PostconditionCode =
  | 'F005_POSTCONDITION_UNDECLARED_CREATE'
  | 'F005_POSTCONDITION_UNDECLARED_MODIFY'
  | 'F005_POSTCONDITION_UNDECLARED_DELETE'
  | 'F005_POSTCONDITION_DECLARED_MISSING'
  | 'F005_POSTCONDITION_CONTENT_MISMATCH'
  | 'F005_POSTCONDITION_BYTES_MISMATCH'
  | 'F005_POSTCONDITION_NOTICE_SEQUENCE'
  | 'F005_POSTCONDITION_NOTICE_INVALID'
  | 'F005_POSTCONDITION_REPARSE_POINT'
  | 'F005_POSTCONDITION_HARDLINK'
  | 'F005_POSTCONDITION_SCAN_FAILED';

export class F005PostconditionError extends Error {
  constructor(
    public readonly code: F005PostconditionCode,
    /** raw pathを含めない固定bucket。件数だけを持つ。 */
    public readonly count: number,
  ) {
    super(code);
    this.name = 'F005PostconditionError';
  }
}

export interface F005ScanEntry {
  readonly bytes: number;
  readonly sha256: Sha256;
  /** volume serial + file index。identity差し替えの検出に使う。 */
  readonly identity: string;
}

/** workspace相対POSIX path -> entry */
export type F005Snapshot = ReadonlyMap<string, F005ScanEntry>;

export interface F005DeclaredMutation {
  readonly sequence: number;
  readonly kind: 'create' | 'rename' | 'delete';
  readonly path: string;
  readonly targetPath: string | null;
  readonly sha256: Sha256 | null;
  readonly bytes: number;
}

const SHA256_PATTERN = /^[a-f\d]{64}$/u;

function fail(code: F005PostconditionCode, count: number): never {
  throw new F005PostconditionError(code, count);
}

function toPosix(value: string): string {
  return sep === '/' ? value : value.split(sep).join(posix.sep);
}

/**
 * 追跡対象root配下を全走査する。REQ-F005-017の境界検査のため
 * reparse point・hardlinkはこの時点で拒否する。
 */
export async function scanF005Workspace(
  workspaceRoot: string,
  roots: readonly string[] = F005_TRACKED_ROOTS,
): Promise<F005Snapshot> {
  const entries = new Map<string, F005ScanEntry>();
  let reparse = 0;
  let hardlink = 0;

  const walk = async (relative: string): Promise<void> => {
    const absolute = join(workspaceRoot, relative);
    let listing;
    try {
      listing = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new F005PostconditionError('F005_POSTCONDITION_SCAN_FAILED', 0);
    }
    for (const item of listing) {
      const childRelative = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) {
        reparse += 1;
        continue;
      }
      if (item.isDirectory()) {
        await walk(childRelative);
        continue;
      }
      if (!item.isFile()) continue;
      const childAbsolute = join(workspaceRoot, childRelative);
      const stat = await lstat(childAbsolute);
      if (stat.isSymbolicLink()) {
        reparse += 1;
        continue;
      }
      if (stat.nlink > 1) {
        hardlink += 1;
        continue;
      }
      const bytes = await readFile(childAbsolute);
      entries.set(toPosix(childRelative), Object.freeze({
        bytes: stat.size,
        sha256: createHash('sha256').update(bytes).digest('hex') as Sha256,
        identity: `${stat.dev}:${stat.ino}`,
      }));
    }
  };

  for (const root of roots) await walk(root);
  if (reparse > 0) fail('F005_POSTCONDITION_REPARSE_POINT', reparse);
  if (hardlink > 0) fail('F005_POSTCONDITION_HARDLINK', hardlink);
  return entries;
}

/**
 * 宣言済みmutationをsequence順に畳み込み、baselineから期待される最終状態を作る。
 */
export function foldF005Declarations(
  baseline: F005Snapshot,
  declarations: readonly F005DeclaredMutation[],
): F005Snapshot {
  const expected = new Map<string, F005ScanEntry>(baseline);
  let previous = 0;
  for (const item of declarations) {
    if (!Number.isSafeInteger(item.sequence) || item.sequence !== previous + 1) {
      fail('F005_POSTCONDITION_NOTICE_SEQUENCE', item.sequence);
    }
    previous = item.sequence;
    if (typeof item.path !== 'string' || item.path.length === 0 ||
      item.path.includes('\\') || item.path.startsWith('/') ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      fail('F005_POSTCONDITION_NOTICE_INVALID', item.sequence);
    }
    if (item.kind === 'delete') {
      expected.delete(item.path);
      continue;
    }
    if (item.kind === 'rename') {
      if (typeof item.targetPath !== 'string' || item.targetPath.length === 0) {
        fail('F005_POSTCONDITION_NOTICE_INVALID', item.sequence);
      }
      const moved = expected.get(item.path);
      expected.delete(item.path);
      expected.set(item.targetPath, Object.freeze({
        bytes: item.bytes,
        sha256: (item.sha256 ?? moved?.sha256 ?? null) as Sha256,
        identity: moved?.identity ?? '',
      }));
      continue;
    }
    if (item.sha256 === null || !SHA256_PATTERN.test(item.sha256)) {
      fail('F005_POSTCONDITION_NOTICE_INVALID', item.sequence);
    }
    expected.set(item.path, Object.freeze({
      bytes: item.bytes,
      sha256: item.sha256,
      identity: '',
    }));
  }
  return expected;
}

/**
 * 実測差分が宣言集合とexact一致することを検証する。
 * 一致しない場合はraw pathを出さない固定codeと件数でfail-closedする。
 */
export function verifyF005Postconditions(
  baseline: F005Snapshot,
  actual: F005Snapshot,
  declarations: readonly F005DeclaredMutation[],
): void {
  const expected = foldF005Declarations(baseline, declarations);
  const declaredPaths = new Set<string>();
  for (const item of declarations) {
    declaredPaths.add(item.path);
    if (item.targetPath !== null) declaredPaths.add(item.targetPath);
  }

  let undeclaredCreate = 0;
  let undeclaredModify = 0;
  let contentMismatch = 0;
  let bytesMismatch = 0;
  for (const [path, entry] of actual) {
    const want = expected.get(path);
    if (!want) {
      // expectedに無い = 宣言で作られておらずbaselineからも消えている
      undeclaredCreate += 1;
      continue;
    }
    if (want.sha256 === entry.sha256 && want.bytes === entry.bytes) continue;
    if (!declaredPaths.has(path)) {
      // 宣言されていないpathが baseline と異なる = 不正な改変
      undeclaredModify += 1;
      continue;
    }
    if (want.sha256 !== entry.sha256) contentMismatch += 1;
    else bytesMismatch += 1;
  }
  if (undeclaredCreate > 0) fail('F005_POSTCONDITION_UNDECLARED_CREATE', undeclaredCreate);
  if (undeclaredModify > 0) fail('F005_POSTCONDITION_UNDECLARED_MODIFY', undeclaredModify);
  if (contentMismatch > 0) fail('F005_POSTCONDITION_CONTENT_MISMATCH', contentMismatch);
  if (bytesMismatch > 0) fail('F005_POSTCONDITION_BYTES_MISMATCH', bytesMismatch);

  let declaredMissing = 0;
  let undeclaredDelete = 0;
  for (const path of expected.keys()) {
    if (actual.has(path)) continue;
    if (baseline.has(path)) undeclaredDelete += 1;
    else declaredMissing += 1;
  }
  if (declaredMissing > 0) fail('F005_POSTCONDITION_DECLARED_MISSING', declaredMissing);
  if (undeclaredDelete > 0) fail('F005_POSTCONDITION_UNDECLARED_DELETE', undeclaredDelete);
}
