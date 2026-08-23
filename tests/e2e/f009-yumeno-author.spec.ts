import { expect, test } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  installDeterministicAudio,
  PAGES_PATH,
  waitForRouteReady,
} from './fixtures';

/**
 * F009（夢野久作3作品追加）専用のauthor route e2e spec。
 *
 * F007（tests/e2e/f007-mori-ogai-author.spec.ts）が後付けで発見・追加された
 * 反省、およびF008（tests/e2e/f008-edogawa-author.spec.ts）でT-177着手前に
 * 雛形を用意した先例を踏襲し、T-188着手時点でF009最終Catalog統合
 * （scripts/f009-final-integration.ts、`.cache/f009-final-integration-5aJXoB/`）
 * の実データ（authorId=000096、name=ゆめのきゅうさく、slug=yumeno-kyusaku、
 * works=瓶詰地獄(002381)/きのこ会議(046694)/死後の恋(002380)、合計27台詞＝
 * 4+15+8）で確定させた。
 * @des DES-F009-010 @fun FUN-F009-011 FUN-F009-012
 */

test.beforeEach(async ({ page }) => {
  // native codec・autoplay・実音声品質ではなく、アプリのAudioPortと遅延取得だけを検査する。
  await installDeterministicAudio(page);
});

// @req REQ-F009-014 @qt QT-F009-010
test('トップに8人目の夢野久作カードがデータ駆動で追加され、既存7作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F009以降トップの作者総数は8人になるため、総数ではなく夢野久作が
  // 個別に1件存在し所属・件数が不変であることだけを検査する。
  const yumeno = page.locator('.author-card').filter({ hasText: 'ゆめのきゅうさく' });
  await expect(yumeno).toHaveCount(1);
  await expect(yumeno).toContainText('原著者: 夢野久作');
  // 実測: 瓶詰地獄4・きのこ会議15・死後の恋8＝合計27台詞
  // （.cache/f009-final-integration-5aJXoB/tree/content/catalog.jsonのauthorId=000096
  // works.dialogues.lengthを実測して確認済み）。
  await expect(yumeno).toContainText('3作品・27台詞');
});

// @req REQ-F009-014 @req REQ-F009-015 @qt QT-F009-010 @qt QT-F009-011
test('yumeno-kyusaku routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/yumeno-kyusaku');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/yumeno-kyusaku$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000096');
  await expect(page.getByRole('heading', { level: 1, name: 'ゆめのきゅうさく' })).toBeVisible();
  await expect(page.getByText('原著者: 夢野久作').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['瓶詰地獄', 'きのこ会議', '死後の恋']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存7作者の作品名が夢野久作routeへ混線していないことも確認する。
  for (const title of ['羅生門', '注文の多い料理店', '走れメロス', '夢十夜', '山月記', '舞姫', '人間椅子']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F009-011 @req REQ-F009-012 @req REQ-F009-013 @qt QT-F009-006
test('瓶詰地獄・死後の恋の公式表現注意がwork-list・work-detail・creditsの3配置へ表示され、きのこ会議には表示されない', async ({ page }) => {
  await page.goto('#/authors/yumeno-kyusaku');
  await waitForRouteReady(page);

  for (const title of ['瓶詰地獄', '死後の恋']) {
    const panel = page.locator('.work-panel').filter({ hasText: title });
    await expect(panel).toHaveCount(1);
    // work-list配置: summary内に注意spanが表示される(未展開でも見える)。
    await expect(panel.locator('.work-notice-official-content-warning')).toBeVisible();
  }

  // きのこ会議には公式表現注意が付与されていないことを確認する。
  const kinokoPanel = page.locator('.work-panel').filter({ hasText: 'きのこ会議' });
  await expect(kinokoPanel.locator('.work-notice-official-content-warning')).toHaveCount(0);

  // work-detail配置: 展開後にwork-notices-detail内へ同文言が表示される。
  const bindzumejigokuPanel = page.locator('.work-panel').filter({ hasText: '瓶詰地獄' });
  await bindzumejigokuPanel.locator('summary').click();
  await expect(bindzumejigokuPanel).toHaveAttribute('open', '');
  await expect(bindzumejigokuPanel.locator('.work-notices-detail')).toContainText(
    '青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );

  // credits配置: クレジット画面の出典一覧にも同文言が表示される。
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  await expect(page.locator('[data-page="credits"]')).toContainText(
    '瓶詰地獄：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );
  await expect(page.locator('[data-page="credits"]')).toContainText(
    '死後の恋：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );
});

// @req REQ-F009-015 @qt QT-F009-011
test('夢野久作routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/yumeno-kyusaku');
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
  // F009以降トップの作者総数は8人になるため、総数ではなく夢野久作カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'ゆめのきゅうさく' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
