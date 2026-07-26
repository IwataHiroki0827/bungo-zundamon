import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UT_MAP: Readonly<Record<string, readonly string[]>> = {
  'UT-F003-001': ['src/content/batch-candidate.test.ts'],
  'UT-F003-002': ['src/content/batch-candidate.test.ts'],
  'UT-F003-003': ['src/content/batch-candidate.test.ts'],
  'UT-F003-004': ['src/content/published-baseline.test.ts'],
  'UT-F003-005': ['src/content/published-baseline.test.ts'],
  'UT-F003-006': ['src/content/f003-review-acceptance.test.ts'],
  'UT-F003-007': ['src/content/f003-review-acceptance.test.ts'],
  'UT-F003-008': ['src/content/editorial-independent.test.ts'],
  'UT-F003-009': ['src/content/f003-review-acceptance.test.ts'],
  'UT-F003-010': ['src/content/f003-review-acceptance.test.ts'],
  'UT-F003-011': ['src/content/f003-review-acceptance.test.ts'],
  'UT-F003-012': ['src/content/f003-review-acceptance.test.ts'],
  'UT-F003-013': ['src/content/editorial-independent.test.ts'],
  'UT-F003-014': ['src/voice/f003.test.ts'],
  'UT-F003-015': ['src/voice/f003.test.ts'],
  'UT-F003-016': ['src/voice/f003.test.ts'],
  'UT-F003-017': ['src/voice/f003.test.ts'],
  'UT-F003-018': ['src/voice/f003.test.ts'],
  'UT-F003-019': ['src/content/f003-artifact-paths.test.ts'],
  'UT-F003-020': ['src/content/batch.test.ts'],
  'UT-F003-021': ['src/content/batch.test.ts'],
  'UT-F003-022': ['src/content/f003-catalog.test.ts'],
  'UT-F003-023': ['src/notices/work-notices.test.ts'],
  'UT-F003-024': ['src/notices/artwork-provenance.test.ts'],
  'UT-F003-025': ['src/ui/audio-controller.test.ts'],
  'UT-F003-026': ['src/content/runtime-acceptance.test.ts'],
  'UT-F003-027': ['src/content/batch-runtime.test.ts', 'scripts/f003-final-integration.ts'],
  'UT-F003-028': ['src/content/batch-runtime.test.ts', 'src/content/runtime-acceptance.test.ts'],
  'UT-F003-029': ['src/content/batch.test.ts'],
};

const IT_MAP: Readonly<Record<string, readonly string[]>> = {
  'IT-F003-001': ['src/content/batch-candidate.test.ts'],
  'IT-F003-002': ['src/content/published-baseline.test.ts'],
  'IT-F003-003': ['src/content/f003-review-acceptance.test.ts'],
  'IT-F003-004': ['src/content/editorial-independent.test.ts'],
  'IT-F003-005': ['src/content/f003-review-acceptance.test.ts'],
  'IT-F003-006': ['src/voice/f003.test.ts'],
  'IT-F003-007': ['src/content/batch-runtime.test.ts'],
  'IT-F003-008': ['src/content/batch.test.ts'],
  'IT-F003-009': ['src/content/f003-catalog.test.ts', 'src/notices/artwork-provenance.test.ts'],
  'IT-F003-010': ['src/ui/audio-controller.test.ts', 'tests/e2e/audio-and-isolation.spec.ts'],
  'IT-F003-011': ['src/content/runtime-acceptance.test.ts', 'scripts/f002-security.test.mjs'],
  'IT-F003-012': ['src/content/batch-runtime.test.ts', 'src/content/batch.test.ts'],
  'IT-F003-013': ['src/content/production-final.test.ts', 'src/content/batch-runtime.test.ts'],
  'IT-F003-014': ['src/content/f003-reuse.test.ts', 'src/content/f003-catalog.test.ts'],
};

const QT_MAP: Readonly<Record<string, readonly string[]>> = {
  'QT-F003-001': ['src/content/published-baseline.test.ts'],
  'QT-F003-002': ['src/content/batch-candidate.test.ts'],
  'QT-F003-003': ['src/content/f003-review-acceptance.test.ts'],
  'QT-F003-004': ['src/content/f003-reuse.test.ts'],
  'QT-F003-005': ['src/content/editorial-independent.test.ts'],
  'QT-F003-006': ['src/voice/f003.test.ts'],
  'QT-F003-007': ['src/notices/work-notices.test.ts', 'tests/e2e/f002-multi-author.spec.ts'],
  'QT-F003-008': ['src/voice/f003.test.ts'],
  'QT-F003-009': ['src/voice/capacity-v2.test.ts'],
  'QT-F003-010': ['src/content/batch.test.ts'],
  'QT-F003-011': ['src/ui/audio-controller.test.ts', 'tests/e2e/audio-and-isolation.spec.ts'],
  'QT-F003-012': ['src/notices/artwork-provenance.test.ts'],
  'QT-F003-013': ['scripts/f002-security.test.mjs'],
  'QT-F003-014': ['src/content/runtime-acceptance.test.ts', 'tests/e2e/responsive-accessibility-security.spec.ts'],
  'QT-F003-015': ['src/content/f003-reuse.test.ts', 'tests/e2e/f002-multi-author.spec.ts'],
};

function specIds(text: string, prefix: 'UT' | 'IT' | 'QT'): string[] {
  return [...new Set(text.match(new RegExp(`${prefix}-F003-\\d{3}`, 'gu')) ?? [])]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

describe('F003仕様ID機械照合', () => {
  it.each([
    ['UT', 'docs/tests/ut/UT-F003.md', UT_MAP],
    ['IT', 'docs/tests/it/IT-F003.md', IT_MAP],
    ['QT', 'docs/tests/qt/QT-F003.md', QT_MAP],
  ] as const)('%s仕様IDが実行対象へ全件対応する', async (prefix, specPath, mapping) => {
    const expected = specIds(await readFile(join(process.cwd(), specPath), 'utf8'), prefix);
    expect(Object.keys(mapping).sort((left, right) => left.localeCompare(right, 'en'))).toEqual(expected);
    for (const paths of Object.values(mapping)) {
      for (const path of paths) await expect(access(join(process.cwd(), path))).resolves.toBeUndefined();
    }
  });
});
