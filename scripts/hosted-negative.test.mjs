import { describe, it } from 'vitest';

describe('QT-F001-019 controlled hosted negative fixture', () => {
  it('検証専用branchだけを意図的に失敗させる', () => {
    throw new Error('CONTROLLED_HOSTED_NEGATIVE_QT_F001_019');
  });
});
