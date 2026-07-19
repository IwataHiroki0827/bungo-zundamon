import { expect, test } from '@playwright/test';
import { installDeterministicAudio, openAuthor } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installDeterministicAudio(page);
});

// IT-F001-008 / IT-F001-014 / QT-F001-008 / QT-F001-009 / QT-F001-016
test('明示操作前0件から対象音声1件だけを取得し、pause/resume/stop/切替/endedを同期する', async ({ page }) => {
  const audioRequests: string[] = [];
  await page.route('**/audio/**', async (route) => {
    audioRequests.push(route.request().url());
    await route.continue();
  });
  await openAuthor(page);
  expect(audioRequests).toHaveLength(0);
  expect(await page.evaluate(() => window.__audioFetches)).toHaveLength(0);

  const cards = page.locator('.dialogue-card');
  const first = cards.nth(0);
  const second = cards.nth(1);
  const firstPlay = first.getByRole('button', { name: /^再生：/ });
  await firstPlay.click();
  await expect(first).toHaveAttribute('data-player-state', 'playing');
  expect(audioRequests).toHaveLength(1);
  expect(await page.evaluate(() => window.__audioFetches)).toHaveLength(1);
  await expect(first.getByRole('button', { name: /^一時停止：/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByText('読み上げています。')).toBeVisible();

  await page.evaluate(() => { window.__audioInstances[0]!.currentTime = 12.5; });
  await first.getByRole('button', { name: /^一時停止：/ }).press('Enter');
  await expect(first).toHaveAttribute('data-player-state', 'paused');
  expect(await page.evaluate(() => window.__audioInstances[0]!.currentTime)).toBe(12.5);

  await first.getByRole('button', { name: /^再開：/ }).press('Enter');
  await expect(first).toHaveAttribute('data-player-state', 'playing');
  expect(audioRequests).toHaveLength(1);
  expect(await page.evaluate(() => window.__audioInstances[0]!.currentTime)).toBe(12.5);

  await first.getByRole('button', { name: '停止', exact: true }).click();
  await expect(first).toHaveAttribute('data-player-state', 'stopped');
  expect(await page.evaluate(() => window.__audioInstances[0]!.currentTime)).toBe(0);

  await first.getByRole('button', { name: /^再生：/ }).click();
  await expect(first).toHaveAttribute('data-player-state', 'playing');
  await page.evaluate(() => { window.__audioInstances[0]!.currentTime = 7; });
  await second.getByRole('button', { name: /^再生：/ }).click();
  await expect(second).toHaveAttribute('data-player-state', 'playing');
  await expect(first).toHaveAttribute('data-player-state', 'idle');
  expect(await page.evaluate(() => window.__audioInstances[0]!.currentTime)).toBe(0);

  await page.evaluate(() => window.__audioInstances[0]!.dispatchEvent(new Event('ended')));
  await expect(second).toHaveAttribute('data-player-state', 'ended');
  await expect(second.getByText('読み上げが終わりました。')).toBeVisible();
});

// IT-F001-009 / IT-F001-019 / QT-F001-010
test('音声404とplay拒否を対象カードへ隔離し、別音声と再試行を維持する', async ({ page }) => {
  let failFirstRequest = true;
  await page.route('**/audio/**', async (route) => {
    if (failFirstRequest) {
      failFirstRequest = false;
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    } else {
      await route.continue();
    }
  });
  await openAuthor(page);
  const cards = page.locator('.dialogue-card');
  const failed = cards.nth(0);
  const healthy = cards.nth(1);

  await failed.getByRole('button', { name: /^再生：/ }).click();
  await expect(failed).toHaveAttribute('data-player-state', 'error');
  await expect(failed.getByText(/音声を再生できませんでした/)).toBeVisible();
  await expect(failed.getByRole('button', { name: /^もう一度試す：/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();

  await healthy.getByRole('button', { name: /^再生：/ }).click();
  await expect(healthy).toHaveAttribute('data-player-state', 'playing');
  await failed.getByRole('button', { name: /^再生：/ }).click();
  await expect(failed).toHaveAttribute('data-player-state', 'playing');
  await expect(failed.getByText('読み上げています。')).toBeVisible();

  await page.evaluate(() => { window.__audioPlayFailure = true; });
  await healthy.getByRole('button', { name: /^再生：/ }).click();
  await expect(healthy).toHaveAttribute('data-player-state', 'error');
  await expect(healthy.getByText(/ブラウザが再生を許可しませんでした/)).toBeVisible();
});

// IT-F001-019 / IT-F001-020
test('画像404でも主要navigation・音声・クレジット・戻る操作を維持する', async ({ page }) => {
  await page.route('**/artwork/akutagawa-zundamon.png', async (route) => {
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing artwork' });
  });
  await openAuthor(page);
  await page.locator('.dialogue-card').first().getByRole('button', { name: /^再生：/ }).click();
  await expect(page.locator('.dialogue-card').first()).toHaveAttribute('data-player-state', 'playing');
  await page.locator('.dialogue-card').first().getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'クレジット・出典・利用条件' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
});
