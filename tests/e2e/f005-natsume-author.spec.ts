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

// @req REQ-F005-003 @req REQ-F005-014 @qt QT-F005-010
test('トップに4人目の夏目漱石カードがデータ駆動で追加され、既存3作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F006以降トップの作者総数は5人（中島敦追加）になるため、総数ではなく夏目漱石が
  // 個別に1件存在し所属・件数が不変であることだけを検査する（F006固有の検証はf006 specへ分離）。
  const natsume = page.locator('.author-card').filter({ hasText: 'なつめそうせき' });
  await expect(natsume).toHaveCount(1);
  await expect(natsume).toContainText('原著者: 夏目漱石');
  await expect(natsume).toContainText('3作品・203台詞');
});

// @req REQ-F005-003 @req REQ-F005-004 @req REQ-F005-014 @req REQ-F005-015 @qt QT-F005-010 @qt QT-F005-011
test('natsume-soseki routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/natsume-soseki');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/natsume-soseki$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000148');
  await expect(page.getByRole('heading', { level: 1, name: 'なつめそうせき' })).toBeVisible();
  await expect(page.getByText('原著者: 夏目漱石').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['夢十夜', '倫敦塔', '趣味の遺伝']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存3作者の作品名が夏目漱石routeへ混線していないことも確認する。
  for (const title of ['羅生門', '注文の多い料理店', '人間失格']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F005-010 @qt QT-F005-006 @qt QT-F005-018
test('趣味の遺伝の公式表現注意がwork-list・work-detail・creditsの3配置へ表示される', async ({ page }) => {
  await page.goto('#/authors/natsume-soseki');
  await waitForRouteReady(page);
  const shumiPanel = page.locator('.work-panel').filter({ hasText: '趣味の遺伝' });
  await expect(shumiPanel).toHaveCount(1);

  // work-list配置: summary内に注意spanが表示される（未展開でも見える）。
  await expect(shumiPanel.locator('.work-notice-official-content-warning')).toBeVisible();

  // 他2作品には公式表現注意が付与されていないことを確認する。
  for (const title of ['夢十夜', '倫敦塔']) {
    const panel = page.locator('.work-panel').filter({ hasText: title });
    await expect(panel.locator('.work-notice-official-content-warning')).toHaveCount(0);
  }

  // work-detail配置: 展開後にwork-notices-detail内へ同文言が表示される。
  await shumiPanel.locator('summary').click();
  await expect(shumiPanel).toHaveAttribute('open', '');
  await expect(shumiPanel.locator('.work-notices-detail')).toContainText(
    '青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );

  // credits配置: クレジット画面の出典一覧にも同文言が表示される。
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  await expect(page.locator('[data-page="credits"]')).toContainText(
    '趣味の遺伝：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );
});

// @req REQ-F005-015 @qt QT-F005-011
test('夏目漱石routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/natsume-soseki');
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
  // F006以降トップの作者総数は5人になるため、総数ではなく夏目漱石カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'なつめそうせき' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
