import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioController } from './audio-controller';
import { validateCatalogV2 } from './catalog-loader';
import { selectDailyDialogue } from './daily';
import { createFavoriteController, type StorageLike } from './favorites';
import { FAVORITE_EXPORT_FORMAT } from './favorites-transfer';
import { OfflineAudioManager } from './offline';
import { cleanupRenderedTree, renderAuthorIndex, renderAuthorPageV2 } from './render';
import {
  renderDailyDialogue,
  renderDialogueSearch,
  renderFavoriteTransfer,
  renderOfflineAudioPanel,
  renderPlaybackSettings,
  renderSequenceControl,
  renderShareOffer,
  renderWorkBibliography,
} from './render-f012';
import type { AudioPort, UICatalogV2 } from './types';

const raw = readFileSync(join(process.cwd(), 'public', 'content', 'catalog.json'));
const parsed = validateCatalogV2(JSON.parse(raw.toString('utf8')), raw.byteLength);
if (!parsed.ok) throw new Error('catalog fixture invalid');
const CATALOG: UICatalogV2 = parsed.value;
const BASE = new URL('https://example.test/bungo-zundamon/');

class QuietAudio implements AudioPort {
  src = '';
  currentTime = 0;
  preload = '';
  playbackRate = 1;
  defaultPlaybackRate = 1;
  volume = 1;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function setup() {
  const audio = new QuietAudio();
  const controller = new AudioController(CATALOG, BASE, () => audio);
  const favoriteController = createFavoriteController(() => new MemoryStorage(), CATALOG);
  return { audio, controller, favoriteController };
}

afterEach(() => {
  cleanupRenderedTree(document.body);
  document.body.replaceChildren();
});

/** @des DES-F012-001 @fun FUN-F012-002 @ut UT-F012-002 */
describe('UT-F012-002 連続再生ボタン', () => {
  it('押すと作品の連続再生を始め、もう一度押すと止める。状態をaria-pressedへ反映する', async () => {
    const { controller } = setup();
    const work = CATALOG.works[0]!;
    const control = renderSequenceControl(controller, work.workId, work.title, work.dialogues);
    document.body.append(control);
    expect(control.getAttribute('aria-pressed')).toBe('false');
    expect(control.textContent).toBe(`連続再生（${work.dialogues.length}台詞）`);
    control.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.sequence?.key).toBe(`work:${work.workId}`);
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(control.getAttribute('aria-label')).toBe(`連続再生を止める：${work.title}`);
    control.click();
    expect(controller.sequence).toBeNull();
    expect(control.getAttribute('aria-pressed')).toBe('false');
  });

  it('作者ページの各作品パネルに1つずつ表示する', () => {
    const { controller, favoriteController } = setup();
    const author = CATALOG.authors[0]!;
    const page = renderAuthorPageV2(author.authorId, CATALOG, controller, BASE, favoriteController);
    const works = CATALOG.works.filter((work) => work.authorId === author.authorId);
    expect(page.querySelectorAll('.work-panel .sequence-button')).toHaveLength(works.length);
    expect(page.querySelectorAll('.playback-settings')).toHaveLength(1);
  });
});

/** @des DES-F012-002 @fun FUN-F012-006 @ut UT-F012-006 */
describe('UT-F012-006 書き出し・取り込み・共有の画面', () => {
  it('取り込みファイルを検証してmergeし、結果を通知する', async () => {
    const { favoriteController } = setup();
    const section = renderFavoriteTransfer(CATALOG, favoriteController, BASE);
    document.body.append(section);
    const ids = CATALOG.works[1]!.dialogues.slice(0, 2).map((dialogue) => dialogue.dialogueId);
    const file = new File([JSON.stringify({ format: FAVORITE_EXPORT_FORMAT, version: 1, dialogueIds: [...ids, 'unknown'] })], 'f.json', { type: 'application/json' });
    const input = section.querySelector<HTMLInputElement>('.transfer-file-input')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(section.querySelector('.transfer-status')?.textContent).toContain('2件をお気に入りに追加しました'));
    expect(section.querySelector('.transfer-status')?.textContent).toContain('取り込めない1件');
    expect(favoriteController.snapshot.dialogueIds).toEqual(ids);

    const bad = new File(['{"format":"x"}'], 'bad.json');
    Object.defineProperty(input, 'files', { configurable: true, value: [bad] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(section.querySelector('.transfer-status')?.textContent).toContain('お気に入りファイルではない'));
  });

  it('書き出しはJSONをダウンロードし、共有リンクはURLを表示する', async () => {
    const { favoriteController } = setup();
    const section = renderFavoriteTransfer(CATALOG, favoriteController, BASE);
    document.body.append(section);
    const [exportButton, shareButton] = [
      section.querySelectorAll<HTMLButtonElement>('button')[0]!,
      section.querySelectorAll<HTMLButtonElement>('button')[1]!,
    ];
    exportButton.click();
    expect(section.querySelector('.transfer-status')?.textContent).toContain('書き出すものがありません');
    favoriteController.toggle(CATALOG.works[0]!.dialogues[0]!.dialogueId);
    const blobs: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:https://example.test/1';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    exportButton.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await blobs[0]!.text())).toMatchObject({ format: FAVORITE_EXPORT_FORMAT, version: 1 });
    click.mockRestore();

    shareButton.click();
    const field = section.querySelector<HTMLInputElement>('.share-url')!;
    expect(field.hidden).toBe(false);
    expect(field.value).toMatch(/^https:\/\/example\.test\/bungo-zundamon\/\?fav=v1/u);
  });

  it('共有リンクの取り込みは利用者が選ぶまで追加しない', () => {
    const { favoriteController } = setup();
    const ids = [CATALOG.works[0]!.dialogues[1]!.dialogueId];
    const resolved = vi.fn();
    const offer = renderShareOffer({ result: { ok: true, dialogueIds: ids, unknownCount: 0 } }, favoriteController, resolved);
    document.body.append(offer);
    expect(favoriteController.snapshot.dialogueIds).toEqual([]);
    offer.querySelector<HTMLButtonElement>('.is-primary')!.click();
    expect(favoriteController.snapshot.dialogueIds).toEqual(ids);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(offer.querySelectorAll('button')).toHaveLength(0);

    const invalid = renderShareOffer({ result: { ok: false, reason: 'schema-invalid' } }, favoriteController, resolved);
    expect(invalid.textContent).toContain('共有リンクを読み取れませんでした');
  });
});

/** @des DES-F012-003 @fun FUN-F012-008 @ut UT-F012-008 */
describe('UT-F012-008 台詞検索の画面', () => {
  it('入力に応じて結果を描画し、件数をaria-liveで知らせる', () => {
    const { controller, favoriteController } = setup();
    const section = renderDialogueSearch(CATALOG, controller, favoriteController);
    document.body.append(section);
    const query = section.querySelector<HTMLInputElement>('.search-query')!;
    query.value = 'ごん狐';
    query.dispatchEvent(new Event('input'));
    const status = section.querySelector('.search-status')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/件見つかりました/u);
    expect(section.querySelectorAll('.search-result .dialogue-card').length).toBeGreaterThan(0);
    query.value = 'ずんずんずん存在しない';
    query.dispatchEvent(new Event('input'));
    expect(status.textContent).toBe('該当する台詞は見つかりませんでした。');
    expect(section.querySelectorAll('.search-result')).toHaveLength(0);
    const author = section.querySelector<HTMLSelectElement>('.search-author')!;
    query.value = '';
    author.value = CATALOG.authors[1]!.authorId;
    author.dispatchEvent(new Event('change'));
    expect(section.querySelectorAll('.search-result')).toHaveLength(30);
  });
});

/** @des DES-F012-004 @fun FUN-F012-010 @ut UT-F012-010 */
describe('UT-F012-010 再生設定の画面', () => {
  it('速度と音量をcontrollerへ反映し、表示を更新する', () => {
    const { audio, controller } = setup();
    const group = renderPlaybackSettings(controller);
    document.body.append(group);
    expect(group.getAttribute('role')).toBe('group');
    const rate = group.querySelector<HTMLSelectElement>('.playback-rate')!;
    rate.value = '1.25';
    rate.dispatchEvent(new Event('change'));
    expect(controller.playbackSettings.rate).toBe(1.25);
    expect(audio.playbackRate).toBe(1.25);
    const volume = group.querySelector<HTMLInputElement>('.playback-volume')!;
    volume.value = '40';
    volume.dispatchEvent(new Event('input'));
    expect(controller.playbackSettings.volume).toBe(0.4);
    expect(group.querySelector('.playback-volume-value')?.textContent).toBe('40%');
    expect(volume.getAttribute('aria-valuetext')).toBe('40%');
    expect(renderPlaybackSettings(controller).querySelector<HTMLSelectElement>('.playback-rate')!.value).toBe('1.25');
  });
});

/** @des DES-F012-005 @fun FUN-F012-012 @ut UT-F012-012 */
describe('UT-F012-012 今日の一台詞の画面', () => {
  it('指定日付の台詞を再生・お気に入り可能なカードで表示する', () => {
    const { controller, favoriteController } = setup();
    const now = new Date('2026-10-04T03:00:00Z');
    const expected = selectDailyDialogue(CATALOG, '2026-10-04')!;
    const section = renderDailyDialogue(CATALOG, controller, favoriteController, now)!;
    expect(section.dataset.dateKey).toBe('2026-10-04');
    expect(section.querySelector('.dialogue-card')?.getAttribute('data-dialogue-id')).toBe(expected.dialogue.dialogueId);
    expect(section.querySelector('.favorite-button')).not.toBeNull();
    expect(section.querySelector('.daily-author-link')?.getAttribute('href')).toBe(`#/authors/${expected.author.slug}`);
    const home = renderAuthorIndex(CATALOG, BASE, { controller, favoriteController, now: () => now });
    expect(home.querySelectorAll('h1')).toHaveLength(1);
    expect(home.querySelector('.daily-dialogue')).not.toBeNull();
    expect(home.querySelector('.dialogue-search')).not.toBeNull();
    expect(renderAuthorIndex(CATALOG, BASE).querySelector('.daily-dialogue, .dialogue-search')).toBeNull();
  });
});

/** @des DES-F012-006 @fun FUN-F012-017 @ut UT-F012-017 */
describe('UT-F012-017 オフライン保存の画面', () => {
  it('未対応環境では操作を無効にして理由を表示する', async () => {
    const { favoriteController } = setup();
    const manager = new OfflineAudioManager(CATALOG, BASE, { caches: undefined });
    const panel = renderOfflineAudioPanel(manager, favoriteController);
    await vi.waitFor(() => expect(panel.querySelector('.offline-status')?.textContent).toContain('利用できません'));
    expect(panel.querySelector<HTMLButtonElement>('.offline-toggle')!.disabled).toBe(true);
  });
});

/** @des DES-F012-007 @fun FUN-F012-018 @ut UT-F012-018 */
describe('UT-F012-018 作品データカード', () => {
  it('既存書誌だけを表示し、本文linkを新しいタブ・noopenerで開く', () => {
    const work = CATALOG.works[0]!;
    const author = CATALOG.authors.find((entry) => entry.authorId === work.authorId)!;
    const card = renderWorkBibliography(work, author, author.authorId);
    expect(card.querySelector('h3')?.textContent).toBe('作品データ');
    expect(card.textContent).toContain(work.source.baseEdition);
    expect(card.textContent).toContain(`${work.dialogues.length}台詞`);
    const link = card.querySelector<HTMLAnchorElement>('.source-text-link')!;
    expect(link.href).toBe(work.source.textUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(() => renderWorkBibliography(
      { ...work, source: { ...work.source, textUrl: 'https://evil.example/cards/x.html' } },
      author,
      author.authorId,
    )).toThrow();
  });
});
