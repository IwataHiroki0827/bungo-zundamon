import { describe, expect, it } from 'vitest';

import { loadAndValidateWorkNotices } from './work-notices.ts';

/** @des DES-F007-010 @fun FUN-F007-011 */
describe('F007 work-notices registration（work-notices.ts, content/batches/F007/work-notices.json）', () => {
  it('実データのregistryを検証し、舞姫だけofficial-content-warningを持つ', async () => {
    const report = await loadAndValidateWorkNotices(process.cwd(), '000129');
    expect(report.result).toBe('pass');
    expect(report.works).toHaveLength(3);
    const maihime = report.works.find((work) => work.workId === '058126');
    const takasebune = report.works.find((work) => work.workId === '045245');
    const sanshoDayu = report.works.find((work) => work.workId === '000689');
    expect(maihime?.title).toBe('舞姫');
    expect(maihime?.notices.map((notice) => notice.textKey)).toEqual([
      'official-content-warning', 'dialogue-excerpt-scope',
    ]);
    expect(takasebune?.notices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    expect(sanshoDayu?.notices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    expect(maihime?.completionStatus).toBe('complete');
  });
});
