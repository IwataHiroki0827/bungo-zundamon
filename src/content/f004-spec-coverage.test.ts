import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UT_MAP: Readonly<Record<string, readonly string[]>> = {
  'UT-F004-001': ['src/content/f004-approved-context.test.ts'],
  'UT-F004-002': ['src/content/f004-baseline.test.ts'],
  'UT-F004-003': ['src/content/f004-baseline.test.ts'],
  'UT-F004-004': ['src/content/f004-approved-context.test.ts'],
  'UT-F004-005': ['src/content/batch-candidate.test.ts'],
  'UT-F004-006': ['src/content/f004-source.test.ts'],
  'UT-F004-007': ['src/content/f004-source.test.ts'],
  'UT-F004-008': ['src/content/f004-editorial.test.ts'],
  'UT-F004-009': ['src/content/f004-editorial.test.ts'],
  'UT-F004-010': ['src/content/f004-editorial.test.ts'],
  'UT-F004-011': ['src/content/f004-editorial.test.ts'],
  'UT-F004-012': ['src/content/f004-voice.test.ts'],
  'UT-F004-013': ['src/content/f004-voice.test.ts'],
  'UT-F004-014': ['src/content/f004-voice.test.ts'],
  'UT-F004-015': ['src/content/f004-voice.test.ts'],
  'UT-F004-016': ['src/content/f004-voice.test.ts'],
  'UT-F004-017': ['src/content/f004-voice.test.ts'],
  'UT-F004-018': ['src/content/f004-acceptance.test.ts'],
  'UT-F004-019': ['src/content/f004-acceptance.test.ts'],
  'UT-F004-020': ['src/content/f004-acceptance.test.ts'],
  'UT-F004-021': ['src/content/batch-catalog.test.ts'],
  'UT-F004-022': ['src/content/batch-catalog.test.ts', 'src/content/batch-public.test.ts'],
  'UT-F004-023': ['src/content/batch-catalog.test.ts'],
  'UT-F004-024': ['src/content/batch-catalog.test.ts'],
  'UT-F004-025': ['src/ui/favorites.test.ts'],
  'UT-F004-026': ['src/ui/favorites.test.ts'],
  'UT-F004-027': ['src/ui/favorites.test.ts'],
  'UT-F004-028': ['src/ui/favorites.test.ts'],
  'UT-F004-029': ['src/main.test.ts', 'src/ui/favorites.test.ts'],
  'UT-F004-030': ['src/main.test.ts', 'src/ui/favorites.test.ts'],
  'UT-F004-031': ['src/content/runtime-acceptance.test.ts', 'scripts/f002-security.test.mjs'],
  'UT-F004-032': ['src/content/runtime-acceptance.test.ts', 'scripts/f002-security.test.mjs'],
  'UT-F004-033': ['src/content/batch-runtime.test.ts', 'scripts/release-checks.test.mjs'],
  'UT-F004-034': ['src/content/runtime-acceptance.test.ts'],
  'UT-F004-035': ['src/content/batch-runtime.test.ts'],
  'UT-F004-036': ['src/content/batch-runtime.test.ts'],
  'UT-F004-037': ['src/content/batch-catalog.test.ts'],
};

const IT_MAP: Readonly<Record<string, readonly string[]>> = {
  'IT-F004-001': ['src/content/f004-approved-context.test.ts', 'src/content/batch-candidate.test.ts'],
  'IT-F004-002': ['src/content/f004-baseline.test.ts', 'src/content/batch-public.test.ts'],
  'IT-F004-003': ['src/content/f004-source.test.ts', 'scripts/f004-predeploy-rights.ts'],
  'IT-F004-004': ['src/content/f004-editorial.test.ts'],
  'IT-F004-005': ['src/content/f004-voice.test.ts'],
  'IT-F004-006': ['src/content/f004-acceptance.test.ts', 'src/content/batch-catalog.test.ts'],
  'IT-F004-007': ['src/content/batch-catalog.test.ts'],
  'IT-F004-008': ['src/content/batch-catalog.test.ts', 'src/main.test.ts'],
  'IT-F004-009': ['src/ui/favorites.test.ts', 'src/main.test.ts', 'tests/e2e/favorites.spec.ts'],
  'IT-F004-010': ['src/ui/favorites.test.ts', 'scripts/f002-security.test.mjs'],
  'IT-F004-011': ['src/main.test.ts', 'tests/e2e/audio-and-isolation.spec.ts'],
  'IT-F004-012': ['src/content/batch-catalog.test.ts', 'src/content/batch-candidate.test.ts'],
  'IT-F004-013': ['src/content/runtime-acceptance.test.ts', 'scripts/f002-security.test.mjs'],
  'IT-F004-014': ['src/content/batch-runtime.test.ts', 'scripts/release-checks.test.mjs'],
  'IT-F004-015': ['src/content/f004-spec-coverage.test.ts'],
};

const QT_MAP: Readonly<Record<string, readonly string[]>> = {
  'QT-F004-001': ['src/content/f004-baseline.test.ts'],
  'QT-F004-002': ['src/content/f004-approved-context.test.ts', 'src/content/batch-candidate.test.ts'],
  'QT-F004-003': ['src/content/f004-source.test.ts', 'scripts/f004-predeploy-rights.ts'],
  'QT-F004-004': ['src/content/f004-editorial.test.ts'],
  'QT-F004-005': ['src/content/f004-editorial.test.ts'],
  'QT-F004-006': ['src/content/f004-editorial.test.ts', 'src/content/batch-catalog.test.ts'],
  'QT-F004-007': ['src/content/f004-voice.test.ts'],
  'QT-F004-008': [
    'src/content/f004-voice.test.ts',
    'src/voice/capacity-v2.test.ts',
    'scripts/f004-release-capacity.ts',
  ],
  'QT-F004-009': ['src/content/f004-acceptance.test.ts'],
  'QT-F004-010': ['src/content/batch-catalog.test.ts', 'src/content/batch-public.test.ts'],
  'QT-F004-011': ['src/main.test.ts', 'tests/e2e/audio-and-isolation.spec.ts'],
  'QT-F004-012': ['src/content/batch-catalog.test.ts', 'src/notices/artwork-provenance.test.ts'],
  'QT-F004-013': ['scripts/f002-security.test.mjs', 'src/ui/favorites.test.ts'],
  'QT-F004-014': ['src/content/runtime-acceptance.test.ts', 'tests/e2e/favorites.spec.ts'],
  'QT-F004-015': ['src/ui/favorites.test.ts', 'tests/e2e/favorites.spec.ts'],
  'QT-F004-016': ['src/main.test.ts', 'src/ui/favorites.test.ts', 'tests/e2e/favorites.spec.ts'],
};

function specIds(text: string, prefix: 'UT' | 'IT' | 'QT'): string[] {
  return [...new Set(text.match(new RegExp(`${prefix}-F004-\\d{3}`, 'gu')) ?? [])]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

describe('F004仕様ID機械照合', () => {
  it.each([
    ['UT', 'docs/tests/ut/UT-F004.md', UT_MAP],
    ['IT', 'docs/tests/it/IT-F004.md', IT_MAP],
    ['QT', 'docs/tests/qt/QT-F004.md', QT_MAP],
  ] as const)('%s仕様IDが実行対象へ全件対応する', async (prefix, specPath, mapping) => {
    const expected = specIds(await readFile(join(process.cwd(), specPath), 'utf8'), prefix);
    expect(Object.keys(mapping).sort((left, right) => left.localeCompare(right, 'en'))).toEqual(expected);
    for (const paths of Object.values(mapping)) {
      for (const path of paths) await expect(access(join(process.cwd(), path))).resolves.toBeUndefined();
    }
  });
});
