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

// @req REQ-F007-014 @qt QT-F007-010
test('トップに6人目の森鴎外カードがデータ駆動で追加され、既存5作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F007以降トップの作者総数は6人になるため、総数ではなく森鴎外が
  // 個別に1件存在し所属・件数が不変であることだけを検査する。
  const mori = page.locator('.author-card').filter({ hasText: 'もりおうがい' });
  await expect(mori).toHaveCount(1);
  await expect(mori).toContainText('原著者: 森鴎外');
  await expect(mori).toContainText('3作品・160台詞');
});

// @req REQ-F007-014 @req REQ-F007-015 @qt QT-F007-010 @qt QT-F007-011
test('mori-ogai routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/mori-ogai');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/mori-ogai$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000129');
  await expect(page.getByRole('heading', { level: 1, name: 'もりおうがい' })).toBeVisible();
  await expect(page.getByText('原著者: 森鴎外').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['舞姫', '高瀬舟', '山椒大夫']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存5作者の作品名が森鴎外routeへ混線していないことも確認する。
  for (const title of ['羅生門', '注文の多い料理店', '人間失格', '夢十夜', '山月記']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F007-009 @req REQ-F007-010 @qt QT-F007-006
test('舞姫の公式表現注意がwork-list・work-detail・creditsの3配置へ表示され、他2作品には表示されない', async ({ page }) => {
  await page.goto('#/authors/mori-ogai');
  await waitForRouteReady(page);
  const maihimePanel = page.locator('.work-panel').filter({ hasText: '舞姫' });
  await expect(maihimePanel).toHaveCount(1);

  // work-list配置: summary内に注意spanが表示される(未展開でも見える)。
  await expect(maihimePanel.locator('.work-notice-official-content-warning')).toBeVisible();

  // 他2作品には公式表現注意が付与されていないことを確認する。
  for (const title of ['高瀬舟', '山椒大夫']) {
    const panel = page.locator('.work-panel').filter({ hasText: title });
    await expect(panel.locator('.work-notice-official-content-warning')).toHaveCount(0);
  }

  // work-detail配置: 展開後にwork-notices-detail内へ同文言が表示される。
  await maihimePanel.locator('summary').click();
  await expect(maihimePanel).toHaveAttribute('open', '');
  await expect(maihimePanel.locator('.work-notices-detail')).toContainText(
    '青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );

  // credits配置: クレジット画面の出典一覧にも同文言が表示される。
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  await expect(page.locator('[data-page="credits"]')).toContainText(
    '舞姫：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );
});

// @req REQ-F007-015 @qt QT-F007-011
test('森鴎外routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/mori-ogai');
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
  // F007以降トップの作者総数は6人になるため、総数ではなく森鴎外カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'もりおうがい' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
