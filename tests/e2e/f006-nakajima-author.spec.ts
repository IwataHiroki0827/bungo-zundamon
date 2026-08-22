import { expect, test } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  installDeterministicAudio,
  PAGES_PATH,
  waitForRouteReady,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  // native codec・autoplay・実音声品質ではなく、アプリのAudioPortと遅延取得だけを検査する。
  await installDeterministicAudio(page);
});

// @req REQ-F006-003 @req REQ-F006-014 @qt QT-F006-002 @qt QT-F006-010
test('トップに5人目の中島敦カードがデータ駆動で追加され、既存4作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F006以降トップの作者総数は5人（中島敦追加）になるため、総数ではなく中島敦が
  // 個別に1件存在し所属・件数が不変であることだけを検査する。
  const nakajima = page.locator('.author-card').filter({ hasText: 'なかじまあつし' });
  await expect(nakajima).toHaveCount(1);
  await expect(nakajima).toContainText('原著者: 中島敦');
  await expect(nakajima).toContainText('3作品・62台詞');
});

// @req REQ-F006-003 @req REQ-F006-004 @req REQ-F006-014 @req REQ-F006-015 @qt QT-F006-002 @qt QT-F006-010 @qt QT-F006-011
test('nakajima-atsushi routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/nakajima-atsushi');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/nakajima-atsushi$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000119');
  await expect(page.getByRole('heading', { level: 1, name: 'なかじまあつし' })).toBeVisible();
  await expect(page.getByText('原著者: 中島敦').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['山月記', '名人伝', '弟子']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存4作者の作品名が中島敦routeへ混線していないことも確認する。
  for (const title of ['羅生門', '注文の多い料理店', '人間失格', '夢十夜']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F006-015 @qt QT-F006-011 @qt QT-F006-012
test('中島敦routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/nakajima-atsushi');
  await waitForRouteReady(page);
  const firstWork = page.locator('.work-panel').first();
  await firstWork.locator('summary').click();
  await expect(firstWork).toHaveAttribute('open', '');

  const firstDialogue = page.locator('.dialogue-card').first();
  await firstDialogue.getByRole('button', { name: /^再生：/ }).click();
  await expect(firstDialogue).toHaveAttribute('data-player-state', 'playing');
  expect(await page.evaluate(() => window.__audioInstances.length)).toBe(1);

  await page.getByRole('link', { name: 'トップ', exact: true }).click();
  await waitForRouteReady(page);
  expect(await page.evaluate(() => window.__audioInstances[0]!.paused)).toBe(true);
  // F006以降トップの作者総数は5人になるため、総数ではなく中島敦カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'なかじまあつし' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
