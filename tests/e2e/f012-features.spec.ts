import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { assertNoHorizontalOverflow, expandFirstWork, installDeterministicAudio, waitForRouteReady } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installDeterministicAudio(page);
});

// @qt QT-F012-001 @it IT-F012-001
test('作品の連続再生が音声終了で次の台詞へ進み、停止ボタンで止まる', async ({ page }) => {
  await page.goto('#/authors/akutagawa-zunnosuke');
  await waitForRouteReady(page);
  await expandFirstWork(page);
  const panel = page.locator('.work-panel').first();
  const sequence = panel.locator('.sequence-button');
  await expect(sequence).toHaveAttribute('aria-pressed', 'false');
  await sequence.click();
  const cards = panel.locator('.dialogue-card');
  await expect(cards.nth(0)).toHaveAttribute('data-player-state', 'playing');
  await expect(sequence).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.__audioInstances[0]!.dispatchEvent(new Event('ended')));
  await expect(cards.nth(1)).toHaveAttribute('data-player-state', 'playing');
  await expect(cards.nth(1).locator('.dialogue-status')).toContainText('連続再生 2/');
  await sequence.click();
  await expect(sequence).toHaveAttribute('aria-pressed', 'false');
  await expect(cards.nth(1)).toHaveAttribute('data-player-state', 'stopped');
  expect(await page.evaluate(() => window.__audioFetches.length)).toBe(2);
});

// @qt QT-F012-004
test('再生速度と音量をsession中だけ保持し、端末へ保存しない', async ({ page }) => {
  await page.goto('#/authors/akutagawa-zunnosuke');
  await waitForRouteReady(page);
  await page.locator('.playback-rate').selectOption('1.25');
  await page.locator('.playback-volume').fill('60');
  await expect(page.locator('.playback-volume-value')).toHaveText('60%');
  await expandFirstWork(page);
  await page.locator('.dialogue-card').first().getByRole('button', { name: /^再生：/ }).click();
  await expect.poll(() => page.evaluate(() => {
    const audio = window.__audioInstances[0] as unknown as { playbackRate: number; volume: number };
    return [audio.playbackRate, audio.volume];
  })).toEqual([1.25, 0.6]);
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.playback-rate')).toHaveValue('1.25');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.reload();
  await expect(page.locator('.playback-rate')).toHaveValue('1');
});

// @qt QT-F012-003 @qt QT-F012-005
test('トップの今日の一台詞と台詞検索がrouteを増やさずに動作する', async ({ page }) => {
  await page.goto('#/');
  await waitForRouteReady(page);
  await assertNoHorizontalOverflow(page);
  const daily = page.locator('.daily-dialogue');
  await expect(daily.getByRole('heading', { level: 2, name: '今日の一台詞' })).toBeVisible();
  await expect(daily.locator('.dialogue-card')).toHaveCount(1);
  expect(await page.evaluate(() => window.__audioFetches.length)).toBe(0);

  const search = page.locator('.dialogue-search');
  await search.getByRole('searchbox').fill('ごん狐');
  await expect(search.locator('.search-status')).toContainText('件見つかりました');
  await expect(search.locator('.search-result').first()).toContainText('ごん狐');
  await search.locator('.search-author').selectOption({ label: 'あくたがわずんのすけ（芥川龍之介）' });
  await expect(search.locator('.search-status')).toHaveText('該当する台詞は見つかりませんでした。');
  await search.getByRole('searchbox').fill('');
  await expect(search.locator('.search-result')).toHaveCount(30);
  await search.locator('.search-result').first().getByRole('button', { name: /^再生：/ }).click();
  await expect(search.locator('.search-result .dialogue-card').first()).toHaveAttribute('data-player-state', 'playing');
  expect(page.url()).toMatch(/#\/$/u);
  await assertNoHorizontalOverflow(page);
});

// @qt QT-F012-007
test('作品データカードに既存書誌と青空文庫本文への安全な外部linkを表示する', async ({ page }) => {
  await page.goto('#/authors/niimi-nankichi');
  await waitForRouteReady(page);
  await expandFirstWork(page);
  const card = page.locator('.work-panel[open] .work-bibliography');
  await expect(card.getByRole('heading', { level: 3, name: '作品データ' })).toBeVisible();
  await expect(card).toContainText('底本');
  const textLink = card.locator('.source-text-link');
  await expect(textLink).toHaveAttribute('target', '_blank');
  await expect(textLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect(new URL((await textLink.getAttribute('href'))!).href).toMatch(/^https:\/\/www\.aozora\.gr\.jp\/cards\/000121\/files\//u);
});

// @qt QT-F012-002 @it IT-F012-002
test('お気に入りをファイルへ書き出し、別の端末相当の状態へ取り込める', async ({ page }) => {
  await page.goto('#/authors/miyazawa-zunji');
  await waitForRouteReady(page);
  await expandFirstWork(page);
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'お気に入りに追加' }).click();
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.favorite-item')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ファイルに書き出す' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('bungo-zundamon-favorites.json');
  const exported = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(exported)).toMatchObject({ format: 'bungo-zundamon-favorites', version: 1 });

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('.favorite-item')).toHaveCount(0);
  await page.locator('.transfer-file-input').setInputFiles({ name: 'favorites.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await expect(page.locator('.transfer-status')).toContainText('1件をお気に入りに追加しました');
  await expect(page.locator('.favorite-item')).toHaveCount(1);
  await page.locator('.transfer-file-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1}') });
  await expect(page.locator('.transfer-status')).toContainText('お気に入りファイルではない');
  await expect(page.locator('.favorite-item')).toHaveCount(1);
});

// @qt QT-F012-002 @it IT-F012-002
test('共有リンクは確認してから取り込み、URLから共有情報を取り除く', async ({ page }) => {
  await page.goto('#/authors/dazai-osamu');
  await waitForRouteReady(page);
  await expandFirstWork(page);
  await page.locator('.dialogue-card').nth(0).getByRole('button', { name: 'お気に入りに追加' }).click();
  await page.locator('.dialogue-card').nth(1).getByRole('button', { name: 'お気に入りに追加' }).click();
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await page.getByRole('button', { name: '共有リンクを作る' }).click();
  const shareUrl = await page.locator('.share-url').inputValue();
  expect(shareUrl).toContain('?fav=v1');

  await page.evaluate(() => localStorage.clear());
  await page.goto(shareUrl);
  await expect(page.locator('.share-offer')).toContainText('2件');
  expect(new URL(page.url()).search).toBe('');
  await expect(page.locator('.favorite-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'お気に入りに追加する' }).click();
  await expect(page.locator('.favorite-item')).toHaveCount(2);
  await expect(page.locator('.share-offer-message')).toContainText('2件をお気に入りに追加しました');
});
