import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateCatalogV2 } from './catalog-loader';
import { selectDailyDialogue, tokyoDateKey } from './daily';
import { FAVORITE_MAX_IDS, createFavoriteController, type StorageLike } from './favorites';
import {
  FAVORITE_EXPORT_FORMAT,
  FAVORITE_SHARE_MAX_IDS,
  buildFavoriteExport,
  buildFavoriteShareUrl,
  parseFavoriteImport,
  parseFavoriteShareParam,
  withoutFavoriteShareParam,
} from './favorites-transfer';
import { planOfflineAudio } from './offline';
import { normalizeSearchText, searchDialogues } from './search';
import type { UICatalogV2 } from './types';

function realCatalog(): UICatalogV2 {
  const raw = readFileSync(join(process.cwd(), 'public', 'content', 'catalog.json'));
  const result = validateCatalogV2(JSON.parse(raw.toString('utf8')), raw.byteLength);
  if (!result.ok) throw new Error(`catalog fixture invalid: ${result.error.code}`);
  return result.value;
}

const CATALOG = realCatalog();
const ALL_IDS = CATALOG.works.flatMap((work) => work.dialogues.map((dialogue) => dialogue.dialogueId));

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

/** @des DES-F012-002 @fun FUN-F012-003 @ut UT-F012-003 */
describe('UT-F012-003 お気に入りファイルの書き出し・取り込み', () => {
  it('exact schemaで書き出し、同じ内容を往復で取り込める', () => {
    const raw = buildFavoriteExport({ dialogueIds: ALL_IDS.slice(0, 3) });
    expect(JSON.parse(raw)).toEqual({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: ALL_IDS.slice(0, 3) });
    expect(parseFavoriteImport(raw, CATALOG)).toEqual({ ok: true, dialogueIds: ALL_IDS.slice(0, 3), unknownCount: 0 });
    expect(parseFavoriteImport(`\uFEFF${raw}`, CATALOG).ok).toBe(true);
  });

  it('未知IDは件数だけ数えて除外し、重複は1件にまとめる', () => {
    const raw = JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: [ALL_IDS[0], 'unknown-id', ALL_IDS[0]] });
    expect(parseFavoriteImport(raw, CATALOG)).toEqual({ ok: true, dialogueIds: [ALL_IDS[0]], unknownCount: 1 });
    const onlyUnknown = JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: ['unknown-id'] });
    expect(parseFavoriteImport(onlyUnknown, CATALOG)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    ['壊れたJSON', '{"format":', 'malformed'],
    ['配列', '[]', 'schema-invalid'],
    ['余分なkey', JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: [], extra: 1 }), 'schema-invalid'],
    ['format違い', JSON.stringify({ format: 'other', version: 1, dialogueIds: [] }), 'schema-invalid'],
    ['version違い', JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 2, dialogueIds: [] }), 'schema-invalid'],
    ['ID文字種違反', JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: ['<img>'] }), 'schema-invalid'],
    ['ID型違反', JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: [1] }), 'schema-invalid'],
    ['__proto__', '{"__proto__":{"x":1},"format":"bungo-zundamon-favorites","version":1,"dialogueIds":[]}', 'schema-invalid'],
    ['件数超過', JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: Array.from({ length: FAVORITE_MAX_IDS + 1 }, (_, i) => `d${i}`) }), 'schema-invalid'],
    ['サイズ超過', ' '.repeat(262_145), 'too-large'],
  ])('%sを拒否する', (_label, raw, reason) => {
    expect(parseFavoriteImport(raw, CATALOG)).toEqual({ ok: false, reason });
  });
});

/** @des DES-F012-002 @fun FUN-F012-004 @ut UT-F012-004 */
describe('UT-F012-004 共有URL', () => {
  const base = new URL('https://example.test/bungo-zundamon/');

  it('#/favorites固定のURLへv1形式で載せ、上限を超えるとnullにする', () => {
    const url = buildFavoriteShareUrl(base, ALL_IDS.slice(0, 2))!;
    expect(url.startsWith('https://example.test/bungo-zundamon/?fav=v1')).toBe(true);
    expect(url.endsWith('#/favorites')).toBe(true);
    expect(parseFavoriteShareParam(new URL(url).search, CATALOG)).toEqual({ ok: true, dialogueIds: ALL_IDS.slice(0, 2), unknownCount: 0 });
    expect(buildFavoriteShareUrl(base, ALL_IDS.slice(0, FAVORITE_SHARE_MAX_IDS))).not.toBeNull();
    expect(buildFavoriteShareUrl(base, ALL_IDS.slice(0, FAVORITE_SHARE_MAX_IDS + 1))).toBeNull();
    expect(buildFavoriteShareUrl(base, [])).toBeNull();
  });

  it('paramがなければnull、不正なら理由付きで拒否し、取り除いたURLを返す', () => {
    expect(parseFavoriteShareParam('', CATALOG)).toBeNull();
    expect(parseFavoriteShareParam('?other=1', CATALOG)).toBeNull();
    expect(parseFavoriteShareParam('?fav=v2:abc', CATALOG)).toEqual({ ok: false, reason: 'schema-invalid' });
    expect(parseFavoriteShareParam('?fav=v1:a,%3Cb%3E', CATALOG)).toEqual({ ok: false, reason: 'schema-invalid' });
    expect(parseFavoriteShareParam('?fav=v1:a&fav=v1:b', CATALOG)).toEqual({ ok: false, reason: 'schema-invalid' });
    expect(parseFavoriteShareParam(`?fav=v1:${'a,'.repeat(FAVORITE_SHARE_MAX_IDS)}a`, CATALOG)).toEqual({ ok: false, reason: 'schema-invalid' });
    expect(withoutFavoriteShareParam('https://example.test/bungo-zundamon/?fav=v1:a&x=1#/favorites'))
      .toBe('https://example.test/bungo-zundamon/?x=1#/favorites');
  });
});

/** @des DES-F012-002 @fun FUN-F012-005 @ut UT-F012-005 */
describe('UT-F012-005 FavoriteController.merge', () => {
  it('Catalog順で追加し、登録済み・不明IDを数え、保存は1回だけ行う', () => {
    const storage = new MemoryStorage();
    const controller = createFavoriteController(() => storage, CATALOG);
    controller.toggle(ALL_IDS[5]!);
    const result = controller.merge([ALL_IDS[5]!, ALL_IDS[1]!, 'unknown', ALL_IDS[1]!]);
    expect(result).toMatchObject({ added: 1, alreadySaved: 1, ignored: 2 });
    expect(controller.snapshot.dialogueIds).toEqual([ALL_IDS[1], ALL_IDS[5]]);
    expect(JSON.parse(storage.values.get('bungo-zundamon:favorites:v1')!).dialogueIds).toEqual([ALL_IDS[1], ALL_IDS[5]]);
    expect(controller.merge(['unknown']).added).toBe(0);
    controller.dispose();
    expect(controller.merge([ALL_IDS[2]!]).added).toBe(0);
  });
});

/** @des DES-F012-003 @fun FUN-F012-007 @ut UT-F012-007 */
describe('UT-F012-007 台詞検索', () => {
  it('NFKC・カタカナ/ひらがな・括弧の差を吸収する', () => {
    expect(normalizeSearchText('「ゴン、ＡＢＣ」')).toBe('ごんabc');
    expect(normalizeSearchText(' メロス は ')).toBe('めろすは');
  });

  it('作品名・作者名・本文で絞り込み、件数と上限を返す', () => {
    const byTitle = searchDialogues(CATALOG, 'ごん狐');
    expect(byTitle.total).toBeGreaterThan(0);
    expect(byTitle.hits.every((hit) => hit.work.title === 'ごん狐')).toBe(true);
    const byAuthor = searchDialogues(CATALOG, '', '000879');
    expect(byAuthor.total).toBe(CATALOG.works.filter((w) => w.authorId === '000879').reduce((n, w) => n + w.dialogues.length, 0));
    expect(byAuthor.hits).toHaveLength(30);
    const sample = CATALOG.works[0]!.dialogues[0]!;
    const byText = searchDialogues(CATALOG, sample.displayText.slice(1, 6));
    expect(byText.hits.some((hit) => hit.dialogue.dialogueId === sample.dialogueId)).toBe(true);
    expect(searchDialogues(CATALOG, '   ')).toEqual({ total: 0, hits: [] });
    expect(searchDialogues(CATALOG, '存在しない語句ずんずんずん').total).toBe(0);
  });
});

/** @des DES-F012-005 @fun FUN-F012-011 @ut UT-F012-011 */
describe('UT-F012-011 今日の一台詞', () => {
  it('日本時間の暦日で切り替わり、同じ日付なら同じ台詞を返す', () => {
    expect(tokyoDateKey(new Date('2026-10-04T14:59:59Z'))).toBe('2026-10-04');
    expect(tokyoDateKey(new Date('2026-10-04T15:00:00Z'))).toBe('2026-10-05');
    expect(() => tokyoDateKey(new Date('invalid'))).toThrow('daily-date-invalid');
    const first = selectDailyDialogue(CATALOG, '2026-10-04')!;
    expect(selectDailyDialogue(CATALOG, '2026-10-04')!.dialogue.dialogueId).toBe(first.dialogue.dialogueId);
    expect(first.work.authorId).toBe(first.author.authorId);
    const week = new Set(['01', '02', '03', '04', '05', '06', '07']
      .map((day) => selectDailyDialogue(CATALOG, `2026-10-${day}`)!.dialogue.dialogueId));
    expect(week.size).toBeGreaterThan(1);
    expect(() => selectDailyDialogue(CATALOG, '2026/10/04')).toThrow('daily-date-key-invalid');
    expect(selectDailyDialogue({ ...CATALOG, works: [] }, '2026-10-04')).toBeNull();
  });
});

/** @des DES-F012-006 @fun FUN-F012-016 @ut UT-F012-016 */
describe('UT-F012-016 オフライン音声の保存計画', () => {
  it('Catalog順・重複除去で上限内だけを計画し、超過分を数える', () => {
    const ids = ALL_IDS.slice(0, 20);
    const all = planOfflineAudio(ids, CATALOG);
    expect(all.assets.length).toBeGreaterThan(0);
    expect(new Set(all.assets.map((asset) => asset.path)).size).toBe(all.assets.length);
    expect(all.totalBytes).toBe(all.assets.reduce((total, asset) => total + asset.bytes, 0));
    const first = all.assets[0]!;
    const tight = planOfflineAudio(ids, CATALOG, first.bytes);
    expect(tight.assets).toEqual([first]);
    expect(tight.skippedOverBudget).toBe(all.assets.length - 1);
    expect(planOfflineAudio([], CATALOG)).toEqual({ assets: [], totalBytes: 0, skippedOverBudget: 0 });
  });
});
