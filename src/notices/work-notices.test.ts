import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadAndValidateWorkNotices,
  WORK_NOTICE_TEXT,
  WorkNoticeError,
  validateWorkNoticesAndCredits,
  type WorkNoticeRegistry,
} from './work-notices.ts';

const PLACEMENTS = ['work-list', 'work-detail', 'credits'] as const;

function registry(): WorkNoticeRegistry {
  return {
    schemaVersion: '1.0.0',
    authorId: '000035',
    works: [
      {
        workId: '000275',
        title: '女生徒',
        completionStatus: 'complete',
        cardUrl: 'https://www.aozora.gr.jp/cards/000035/card275.html',
        notices: [
          { textKey: 'official-content-warning', placements: PLACEMENTS },
          { textKey: 'dialogue-excerpt-scope', placements: PLACEMENTS },
        ],
      },
      {
        workId: '001567',
        title: '走れメロス',
        completionStatus: 'complete',
        cardUrl: 'https://www.aozora.gr.jp/cards/000035/card1567.html',
        notices: [{ textKey: 'dialogue-excerpt-scope', placements: PLACEMENTS }],
      },
      {
        workId: '000258',
        title: 'グッド・バイ',
        completionStatus: 'unfinished',
        cardUrl: 'https://www.aozora.gr.jp/cards/000035/card258.html',
        notices: [
          { textKey: 'unfinished', placements: PLACEMENTS },
          { textKey: 'official-content-warning', placements: PLACEMENTS },
          { textKey: 'dialogue-excerpt-scope', placements: PLACEMENTS },
        ],
      },
    ],
  };
}

describe('UT-F003-023 未完・公式注意・抜粋scope・credits [DES-F003-009][FUN-F003-023]', () => {
  it('3配置を固定text node用文字列へ解決し、公式linkをnoopener noreferrerへ固定する', () => {
    const result = validateWorkNoticesAndCredits(registry());
    expect(result.result).toBe('pass');
    expect(result.works).toHaveLength(3);
    expect(result.works.find((work) => work.workId === '000258')).toMatchObject({
      completionStatus: 'unfinished',
      links: [{
        href: 'https://www.aozora.gr.jp/cards/000035/card258.html',
        target: '_blank',
        rel: 'noopener noreferrer',
      }],
    });
    expect(result.works.flatMap((work) => work.renderedNotices).map((notice) => notice.text))
      .toContain(WORK_NOTICE_TEXT['dialogue-excerpt-scope']);
  });

  it.each([
    ['配置欠落', (value: WorkNoticeRegistry) => ({
      ...value,
      works: value.works.map((work, index) => index === 0 ? {
        ...work,
        notices: [{ ...work.notices[0]!, placements: ['work-list', 'work-detail'] }],
      } : work),
    })],
    ['unknown textKey', (value: WorkNoticeRegistry) => ({
      ...value,
      works: value.works.map((work, index) => index === 0 ? {
        ...work,
        notices: [{ textKey: 'unknown', placements: PLACEMENTS }],
      } : work),
    })],
    ['HTML textKey', (value: WorkNoticeRegistry) => ({
      ...value,
      works: value.works.map((work, index) => index === 0 ? {
        ...work,
        notices: [{ textKey: '<img src=x>', placements: PLACEMENTS }],
      } : work),
    })],
  ])('%sを拒否する', (_label, mutate) => {
    expect(() => validateWorkNoticesAndCredits(mutate(registry()) as unknown as WorkNoticeRegistry))
      .toThrowError(WorkNoticeError);
  });

  it('registry側の作者・未完・公式注意・URLを同時に偽造しても固定hashで拒否する', () => {
    const forged = {
      ...registry(),
      authorId: '000035',
      works: registry().works.map((work, index) => index === 0
        ? {
            ...work,
            cardUrl: 'https://www.aozora.gr.jp/cards/000035/card275.html',
            completionStatus: 'unfinished' as const,
            notices: [
              { textKey: 'unfinished' as const, placements: PLACEMENTS },
              { textKey: 'dialogue-excerpt-scope' as const, placements: PLACEMENTS },
            ],
          }
        : work),
    };
    expect(() => validateWorkNoticesAndCredits(forged))
      .toThrowError(expect.objectContaining({ code: 'WORK_NOTICE_PROVENANCE_MISMATCH' }));
    expect(() => validateWorkNoticesAndCredits({
      ...registry(),
      works: registry().works.map((work, index) => index === 0
        ? { ...work, cardUrl: 'https://evil.example/cards/000035/card275.html' }
        : work),
    })).toThrowError(expect.objectContaining({ code: 'WORK_NOTICE_PROVENANCE_MISMATCH' }));
  });

  it('committed F003 notice registryが公式source factsと一致する', async () => {
    const value = JSON.parse(await readFile(
      join(process.cwd(), 'content', 'batches', 'F003', 'work-notices.json'),
      'utf8',
    )) as WorkNoticeRegistry;
    expect(validateWorkNoticesAndCredits(value)).toMatchObject({
      result: 'pass',
      authorId: '000035',
    });
    await expect(loadAndValidateWorkNotices(process.cwd())).resolves.toMatchObject({
      result: 'pass',
      authorId: '000035',
    });
  });

  /** @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011 */
  it('committed F008 notice registryが公式source facts（人間椅子・Ｄ坂の殺人事件2件のofficial-content-warning）と一致する', async () => {
    const value = JSON.parse(await readFile(
      join(process.cwd(), 'content', 'batches', 'F008', 'work-notices.json'),
      'utf8',
    )) as WorkNoticeRegistry;
    const report = validateWorkNoticesAndCredits(value);
    expect(report).toMatchObject({ result: 'pass', authorId: '001779' });
    const ningenIsu = report.works.find((work) => work.workId === '056648');
    expect(ningenIsu?.notices.map((notice) => notice.textKey)).toEqual(
      expect.arrayContaining(['official-content-warning', 'dialogue-excerpt-scope']),
    );
    const dzakaSatsujin = report.works.find((work) => work.workId === '056650');
    expect(dzakaSatsujin?.notices.map((notice) => notice.textKey)).toEqual(
      expect.arrayContaining(['official-content-warning', 'dialogue-excerpt-scope']),
    );
    const hitoriFutayaku = report.works.find((work) => work.workId === '057193');
    expect(hitoriFutayaku?.notices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    await expect(loadAndValidateWorkNotices(process.cwd(), '001779')).resolves.toMatchObject({
      result: 'pass',
      authorId: '001779',
    });
  });

  /** @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011 */
  it('committed F009 notice registryが公式source facts（瓶詰地獄・死後の恋2件のofficial-content-warning）と一致する', async () => {
    const value = JSON.parse(await readFile(
      join(process.cwd(), 'content', 'batches', 'F009', 'work-notices.json'),
      'utf8',
    )) as WorkNoticeRegistry;
    const report = validateWorkNoticesAndCredits(value);
    expect(report).toMatchObject({ result: 'pass', authorId: '000096' });
    const binzumeJigoku = report.works.find((work) => work.workId === '002381');
    expect(binzumeJigoku?.notices.map((notice) => notice.textKey)).toEqual(
      expect.arrayContaining(['official-content-warning', 'dialogue-excerpt-scope']),
    );
    const kinokoKaigi = report.works.find((work) => work.workId === '046694');
    expect(kinokoKaigi?.notices.map((notice) => notice.textKey)).toEqual(['dialogue-excerpt-scope']);
    const shigoNoKoi = report.works.find((work) => work.workId === '002380');
    expect(shigoNoKoi?.notices.map((notice) => notice.textKey)).toEqual(
      expect.arrayContaining(['official-content-warning', 'dialogue-excerpt-scope']),
    );
    await expect(loadAndValidateWorkNotices(process.cwd(), '000096')).resolves.toMatchObject({
      result: 'pass',
      authorId: '000096',
    });
  });
});
