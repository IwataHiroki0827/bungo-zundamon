import { describe, expect, it } from 'vitest';
import { exitCodeForDiagnostic } from '../../scripts/content-cli.ts';

describe('content CLI exit code [DES-F001-017][DES-F001-019]', () => {
  it.each([
    ['bibliography', 2], ['select', 3], ['sources', 4], ['provenance', 5],
    ['decode', 6], ['extract', 7], ['normalize', 8],
  ])('PipelineRunError.diagnostic.stage=%sをexit codeへ変換する', (stage, expected) => {
    expect(exitCodeForDiagnostic({ stage, reasonCode: 'PIPELINE_STAGE_FAILED' })).toBe(expected);
  });

  it.each([null, {}, { stage: 'future' }, { stage: 1 }])('未知diagnosticはexit 1にする', (diagnostic) => {
    expect(exitCodeForDiagnostic(diagnostic)).toBe(1);
  });
});
