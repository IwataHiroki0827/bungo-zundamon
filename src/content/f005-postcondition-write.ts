import { createHash } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';

/**
 * 事後検証契約における一時書込み。
 *
 * native guardのwrite-through leaseは「ETWで検証された書込み」を提供するために
 * 存在した。CHG-F005-072でその保証はphase前後の実測差分が担うため、書込み自体は
 * 通常のfsで行い、native guardは容量計測と安全path解決だけを担当する。
 *
 * これによりwrite lease・write completion drainに広範に結合したETW依存
 * （correlationReady、PrepareTupleMatches、filesByObject binding、observations）
 * が voice phase の経路から一括で外れる。
 *
 * @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047
 */

export type F005PostconditionWriteCode =
  | 'F005_POSTCONDITION_WRITE_EXISTS'
  | 'F005_POSTCONDITION_WRITE_VERIFY_FAILED'
  | 'F005_POSTCONDITION_WRITE_RENAME_FAILED'
  | 'F005_POSTCONDITION_WRITE_IDENTITY_FAILED'
  | 'F005_POSTCONDITION_WRITE_SETTLED';

export class F005PostconditionWriteError extends Error {
  constructor(public readonly code: F005PostconditionWriteCode) {
    super(code);
    this.name = 'F005PostconditionWriteError';
  }
}

export interface F005PostconditionWriteLease {
  readonly producerPid: number;
  readonly nativeIdentity: `${string}:${string}`;
  rename(targetPath: string): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

function fail(code: F005PostconditionWriteCode): never {
  throw new F005PostconditionWriteError(code);
}

/** native guardのnativeIdentityと同じ `[0-9a-f]{8}:[0-9a-f]{16}` 形式へ揃える。 */
async function readIdentity(path: string): Promise<`${string}:${string}`> {
  let info;
  try {
    info = await stat(path, { bigint: true });
  } catch {
    return fail('F005_POSTCONDITION_WRITE_IDENTITY_FAILED');
  }
  const volume = (info.dev & 0xffffffffn).toString(16).padStart(8, '0');
  const file = (info.ino & 0xffffffffffffffffn).toString(16).padStart(16, '0');
  return `${volume}:${file}` as const;
}

async function verifyContent(path: string, expectedSha256: string): Promise<void> {
  let actual;
  try {
    actual = createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return fail('F005_POSTCONDITION_WRITE_VERIFY_FAILED');
  }
  if (actual !== expectedSha256) fail('F005_POSTCONDITION_WRITE_VERIFY_FAILED');
}

/**
 * 排他作成でstagingへ書き、fsync後に読み戻してSHA-256を照合する。
 * renameは実施後に再照合し、commitは事後検証へ委ねるno-opとする。
 */
export async function writeF005TemporaryFile(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<F005PostconditionWriteLease> {
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    fail('F005_POSTCONDITION_WRITE_VERIFY_FAILED');
  }
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch {
    return fail('F005_POSTCONDITION_WRITE_EXISTS');
  }
  try {
    await handle.write(bytes);
    // rename前にdirty pageを明示flushする（旧write-throughと同じ意図）。
    await handle.sync();
  } finally {
    await handle.close();
  }
  await verifyContent(path, expectedSha256);

  let currentPath = path;
  let settled = false;
  const identity = await readIdentity(path);
  return Object.freeze({
    producerPid: process.pid,
    nativeIdentity: identity,
    rename: async (targetPath: string): Promise<void> => {
      if (settled) fail('F005_POSTCONDITION_WRITE_SETTLED');
      try {
        await rename(currentPath, targetPath);
      } catch {
        return fail('F005_POSTCONDITION_WRITE_RENAME_FAILED');
      }
      currentPath = targetPath;
      await verifyContent(currentPath, expectedSha256);
    },
    commit: async (): Promise<void> => {
      if (settled) fail('F005_POSTCONDITION_WRITE_SETTLED');
      settled = true;
      // 最終状態の健全性はphase後の実測差分が証明する。
    },
    abort: async (): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        await unlink(currentPath);
      } catch {
        // 既に消えている場合は事後検証が最終状態で判定する。
      }
    },
  });
}
