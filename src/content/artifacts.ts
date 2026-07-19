import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ArtifactFingerprint {
  readonly sha256: string;
}

export interface JsonArtifactEntry {
  readonly path: string;
  readonly value: unknown;
}

export interface AtomicArtifactOptions {
  readonly expectedFingerprint?: ArtifactFingerprint | null;
  readonly beforeCommit?: () => void | Promise<void>;
}

export class ArtifactWriteError extends Error {
  constructor(
    public readonly code: 'ARTIFACT_WORKSPACE_BOUNDARY' | 'ARTIFACT_CONFLICT' | 'ARTIFACT_INVALID_PATH',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactWriteError';
  }
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'JSONへ非有限数は保存できません');
    return value;
  }
  if (typeof value !== 'object') {
    throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'JSONへ保存できない値が含まれています');
  }
  if (seen.has(value)) throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', '循環参照は保存できません');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'plain object以外は保存できません');
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, canonicalize(item, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'workspaceは絶対pathが必要です');
  const lexical = resolve(workspace);
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(lexical)) !== lexical) {
    throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'workspace実体が不正です');
  }
  return lexical;
}

function descendant(workspace: string, path: string): string {
  const target = resolve(path);
  const relation = relative(workspace, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifactがworkspace外です');
  }
  return target;
}

async function assertNoSymbolicLink(workspace: string, target: string): Promise<void> {
  const relation = relative(workspace, target);
  let cursor = workspace;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifact pathにsymbolic linkがあります');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function walkFingerprint(root: string): Promise<ArtifactFingerprint | null> {
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink()) throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifactはsymbolic linkにできません');
    const hash = createHash('sha256');
    const walk = async (path: string, logical: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifact treeにsymbolic linkがあります');
      hash.update(`${logical}\0${info.isDirectory() ? 'd' : 'f'}\0${info.size}\0${info.mtimeMs}\0${info.ino}\0`);
      if (info.isDirectory()) {
        const entries = (await readdir(path)).sort((left, right) => left.localeCompare(right, 'en'));
        for (const entry of entries) await walk(join(path, entry), `${logical}/${entry}`);
      } else if (info.isFile()) {
        hash.update(await readFile(path));
      } else {
        throw new ArtifactWriteError('ARTIFACT_WORKSPACE_BOUNDARY', 'artifact treeにはregular fileだけを保存できます');
      }
    };
    await walk(root, '.');
    return { sha256: hash.digest('hex') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameFingerprint(left: ArtifactFingerprint | null, right: ArtifactFingerprint | null): boolean {
  return left?.sha256 === right?.sha256 && (left === null) === (right === null);
}

export async function fingerprintArtifact(path: string): Promise<ArtifactFingerprint | null> {
  if (!isAbsolute(path)) throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'fingerprint対象は絶対pathが必要です');
  return walkFingerprint(resolve(path));
}

/** @des DES-F001-017 DES-F001-019 @fun FUN-F001-033 */
export async function writeJsonArtifactAtomic(
  workspace: string,
  path: string,
  value: unknown,
  options: AtomicArtifactOptions = {},
): Promise<void> {
  const root = await verifiedWorkspace(workspace);
  const target = descendant(root, path);
  await assertNoSymbolicLink(root, target);
  const initial = await walkFingerprint(target);
  if (options.expectedFingerprint !== undefined && !sameFingerprint(initial, options.expectedFingerprint)) {
    throw new ArtifactWriteError('ARTIFACT_CONFLICT', 'artifactが読取後に変更されています');
  }
  await mkdir(dirname(target), { recursive: true });
  await assertNoSymbolicLink(root, dirname(target));
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, canonicalJson(value), { encoding: 'utf8', flag: 'wx' });
    await options.beforeCommit?.();
    if (!sameFingerprint(initial, await walkFingerprint(target))) {
      throw new ArtifactWriteError('ARTIFACT_CONFLICT', 'artifactが書込中に変更されています');
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** @des DES-F001-017 DES-F001-019 @fun FUN-F001-033 */
export async function writeJsonArtifactTreeAtomic(
  workspace: string,
  targetDirectory: string,
  entries: readonly JsonArtifactEntry[],
  options: AtomicArtifactOptions = {},
): Promise<void> {
  const root = await verifiedWorkspace(workspace);
  const target = descendant(root, targetDirectory);
  await assertNoSymbolicLink(root, target);
  const initial = await walkFingerprint(target);
  if (options.expectedFingerprint !== undefined && !sameFingerprint(initial, options.expectedFingerprint)) {
    throw new ArtifactWriteError('ARTIFACT_CONFLICT', 'artifact treeが読取後に変更されています');
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      isAbsolute(entry.path) || entry.path.includes('\\') ||
      entry.path.split('/').some((component) => component === '' || component === '.' || component === '..')
    ) {
      throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'tree内pathは安全な相対pathが必要です');
    }
    const normalized = relative('.', resolve('.', entry.path));
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'tree内pathが不正です');
    }
    if (paths.has(normalized)) throw new ArtifactWriteError('ARTIFACT_INVALID_PATH', 'tree内pathが重複しています');
    paths.add(normalized);
  }
  await mkdir(dirname(target), { recursive: true });
  await assertNoSymbolicLink(root, dirname(target));
  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.stage-`));
  const backup = join(dirname(target), `.${basename(target)}.backup-${randomUUID()}`);
  let backedUp = false;
  let promoted = false;
  try {
    for (const entry of entries) {
      const output = join(staging, entry.path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, canonicalJson(entry.value), { encoding: 'utf8', flag: 'wx' });
    }
    await options.beforeCommit?.();
    if (!sameFingerprint(initial, await walkFingerprint(target))) {
      throw new ArtifactWriteError('ARTIFACT_CONFLICT', 'artifact treeが書込中に変更されています');
    }
    try {
      await rename(target, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    promoted = true;
  } catch (error) {
    if (backedUp && !promoted) await rename(backup, target);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (promoted) {
      try {
        await rm(backup, { recursive: true, force: true });
      } catch {
        // 新treeは採用済み。旧backupの掃除は次回保守へ委ねる。
      }
    }
  }
}

export async function readJsonArtifact<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
