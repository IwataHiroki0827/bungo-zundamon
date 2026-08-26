import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** F005 native guard実行ファイルの規定配置(gitignore対象の.cache配下)。 */
export const F005_GUARD_EXECUTABLE_PATH = join(
  resolve('.'),
  '.cache',
  'dotnet-f005',
  'publish',
  'f005-guard.exe',
);

/**
 * F005 native guard exeの存在をテスト実行前に確認する。
 * .cacheごと削除されるとF005系テストが大量ENOENTで崩壊するため、
 * サイレントskipせず再構築手順付きで明示的にthrowする。
 */
export async function assertGuardExecutableAvailable(): Promise<void> {
  let size: number;
  try {
    size = (await stat(F005_GUARD_EXECUTABLE_PATH)).size;
  } catch {
    throw new Error(
      `F005 native guard実行ファイルが見つかりません: ${F005_GUARD_EXECUTABLE_PATH}\n` +
      '`pwsh -NoProfile -File native/f005-guard/build.ps1` を実行して再構築してください',
    );
  }
  if (size === 0) {
    throw new Error(
      `F005 native guard実行ファイルが空です: ${F005_GUARD_EXECUTABLE_PATH}\n` +
      '`pwsh -NoProfile -File native/f005-guard/build.ps1` を実行して再構築してください',
    );
  }
}
