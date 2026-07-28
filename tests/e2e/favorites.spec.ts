import { expect, test } from '@playwright/test';
import {
  expandFirstWork,
  installDeterministicAudio,
  waitForRouteReady,
} from './fixtures';

const STORAGE_KEY = 'bungo-zundamon:favorites:v1';

test.beforeEach(async ({ page }) => {
  await installDeterministicAudio(page);
});

async function openAuthor(
  page: import('@playwright/test').Page,
  slug: string,
): Promise<void> {
  await page.goto(`#/authors/${slug}`);
  await waitForRouteReady(page);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  await expandFirstWork(page);
}

// @it IT-F004-009 @it IT-F004-011 @qt QT-F004-015
test('お気に入りを音声再生なしで切替し、再読込・一覧・解除へ永続化する', async ({ page }) => {
  await openAuthor(page, 'miyazawa-zunji');
  const first = page.locator('.dialogue-card').first();
  const favorite = first.getByRole('button', { name: 'お気に入りに追加' });
  await expect(favorite).toHaveAttribute('aria-pressed', 'false');
  await favorite.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__audioFetches)).toEqual([]);
  await expect.poll(async () => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toContain('"version":1');

  await page.reload();
  await waitForRouteReady(page);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  await expandFirstWork(page);
  await expect(page.locator('.dialogue-card').first().getByRole('button', { name: 'お気に入りから削除' }))
    .toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('[data-page="favorites"]')).toBeVisible();
  await expect(page.locator('.favorite-item')).toHaveCount(1);
  await page.locator('.favorite-item').getByRole('button', { name: 'お気に入りから削除' }).click();
  await expect(page.locator('.favorite-empty-title')).toHaveText('お気に入りはまだありません');
  await expect(page.locator('.favorite-empty-title')).toBeFocused();
  await expect.poll(async () => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBeNull();
});

// @it IT-F004-009 @it IT-F004-011 @qt QT-F004-014 @qt QT-F004-016
test('複数作者をCatalog順に一覧化し、元作品へ一度だけ展開・focusする', async ({ page }) => {
  for (const slug of ['akutagawa-zunnosuke', 'miyazawa-zunji']) {
    await openAuthor(page, slug);
    await page.locator('.dialogue-card').first().getByRole('button', { name: 'お気に入りに追加' }).click();
  }
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  const items = page.locator('.favorite-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator('.favorite-author')).toHaveText('あくたがわずんのすけ');
  await expect(items.nth(1).locator('.favorite-author')).toHaveText('みやざわずんじ');

  await items.nth(1).getByRole('link', { name: '元作品を開く' }).click();
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000081');
  await expect(page.locator('.work-panel[open]')).toHaveCount(1);
  await expect(page.locator('.work-panel[open] .favorite-button:focus')).toHaveCount(1);

  await page.reload();
  await waitForRouteReady(page);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
});

// @it IT-F004-010 @qt QT-F004-013 @qt QT-F004-015
test('破損・重複・未知IDを正規化し、storage書込失敗時もmemoryで操作を継続する', async ({ page }) => {
  await openAuthor(page, 'akutagawa-zunnosuke');
  const validId = await page.locator('.favorite-button').first().getAttribute('data-dialogue-id');
  expect(validId).not.toBeNull();
  await page.evaluate(({ key, id }) => {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      dialogueIds: ['unknown-dialogue', id, id],
    }));
  }, { key: STORAGE_KEY, id: validId! });
  await page.reload();
  await waitForRouteReady(page);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.favorite-item')).toHaveCount(1);

  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string): void {
      if (name === key) throw new DOMException('quota injected', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, STORAGE_KEY);
  await page.goto('#/authors/dazai-osamu');
  await waitForRouteReady(page);
  await expandFirstWork(page);
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'お気に入りに追加' }).click();
  await expect(page.locator('.favorite-persistence-status')).toContainText('このタブ内');
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.favorite-item')).toHaveCount(2);
});
