import { expect, test } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  installDeterministicAudio,
  PAGES_PATH,
  waitForRouteReady,
} from './fixtures';

/**
 * F008（江戸川乱歩3作品追加）専用のauthor route e2e spec雛形。
 *
 * F007（T-166〜T-169相当）でtests/e2e/f007-mori-ogai-author.spec.tsが後付けで
 * 発見・追加された反省を踏まえ、T-177着手前の本タスクで最初から用意する。
 * データはsrc/content/f008-source.tsの`defineF008AuthorAndWorkRegistry`から
 * 取得できるexact固定値（authorId=001779、name=えどがわらんぽ、
 * slug=edogawa-ranpo、works=人間椅子(056648,order1)/Ｄ坂の殺人事件
 * (056650,order2)/一人二役(057193,order3)）と、content/batches/F008/
 * work-notices.json（人間椅子・Ｄ坂の殺人事件にofficial-content-warning、
 * 一人二役にはなし）を反映した。
 *
 * 本セッション時点でF008はaccept未完了（T-172作者画像実生成待ち）のため
 * public/へは一切反映されておらず、本specは実行するとすべて失敗する
 * （#/authors/edogawa-ranpo routeが存在しない）。台詞数・作者総数（トップの
 * .author-cardの総数は「7人」になる想定だが、F008公開前の現状は6人）は
 * T-176（最終Catalog統合）完了後の実データに合わせて調整すること
 * （TODO: 台詞数プレースホルダを実測値へ差し替える）。
 * @des DES-F008-010 @fun FUN-F008-011 FUN-F008-012
 */

test.beforeEach(async ({ page }) => {
  // native codec・autoplay・実音声品質ではなく、アプリのAudioPortと遅延取得だけを検査する。
  await installDeterministicAudio(page);
});

// @req REQ-F008-014 @qt QT-F008-010
test('トップに7人目の江戸川乱歩カードがデータ駆動で追加され、既存6作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F008以降トップの作者総数は7人になるため、総数ではなく江戸川乱歩が
  // 個別に1件存在し所属・件数が不変であることだけを検査する。
  const edogawa = page.locator('.author-card').filter({ hasText: 'えどがわらんぽ' });
  await expect(edogawa).toHaveCount(1);
  await expect(edogawa).toContainText('原著者: 江戸川乱歩');
  // TODO(T-176完了後): 実際の合計台詞数（人間椅子approved5＋Ｄ坂approved85＋
  // 一人二役approved11＝暫定101件、長大候補分割等の最終確定値で差し替える）。
  await expect(edogawa).toContainText('3作品');
});

// @req REQ-F008-014 @req REQ-F008-015 @qt QT-F008-010 @qt QT-F008-011
test('edogawa-ranpo routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/edogawa-ranpo');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/edogawa-ranpo$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '001779');
  await expect(page.getByRole('heading', { level: 1, name: 'えどがわらんぽ' })).toBeVisible();
  await expect(page.getByText('原著者: 江戸川乱歩').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['人間椅子', 'Ｄ坂の殺人事件', '一人二役']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存6作者の作品名が江戸川乱歩routeへ混線していないことも確認する。
  for (const title of ['羅生門', '注文の多い料理店', '人間失格', '夢十夜', '山月記', '舞姫']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F008-011 @req REQ-F008-012 @req REQ-F008-013 @qt QT-F008-006
test('人間椅子・Ｄ坂の殺人事件の公式表現注意がwork-list・work-detail・creditsの3配置へ表示され、一人二役には表示されない', async ({ page }) => {
  await page.goto('#/authors/edogawa-ranpo');
  await waitForRouteReady(page);

  for (const title of ['人間椅子', 'Ｄ坂の殺人事件']) {
    const panel = page.locator('.work-panel').filter({ hasText: title });
    await expect(panel).toHaveCount(1);
    // work-list配置: summary内に注意spanが表示される(未展開でも見える)。
    await expect(panel.locator('.work-notice-official-content-warning')).toBeVisible();
  }

  // 一人二役には公式表現注意が付与されていないことを確認する。
  const hitorifutayakuPanel = page.locator('.work-panel').filter({ hasText: '一人二役' });
  await expect(hitorifutayakuPanel.locator('.work-notice-official-content-warning')).toHaveCount(0);

  // work-detail配置: 展開後にwork-notices-detail内へ同文言が表示される。
  const ningenIsuPanel = page.locator('.work-panel').filter({ hasText: '人間椅子' });
  await ningenIsuPanel.locator('summary').click();
  await expect(ningenIsuPanel).toHaveAttribute('open', '');
  await expect(ningenIsuPanel.locator('.work-notices-detail')).toContainText(
    '青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );

  // credits配置: クレジット画面の出典一覧にも同文言が表示される。
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  await expect(page.locator('[data-page="credits"]')).toContainText(
    '人間椅子：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );
  await expect(page.locator('[data-page="credits"]')).toContainText(
    'Ｄ坂の殺人事件：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  );
});

// @req REQ-F008-015 @qt QT-F008-011
test('江戸川乱歩routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/edogawa-ranpo');
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
  // F008以降トップの作者総数は7人になるため、総数ではなく江戸川乱歩カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'えどがわらんぽ' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
