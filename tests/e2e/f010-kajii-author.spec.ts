import { expect, test } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  installDeterministicAudio,
  PAGES_PATH,
  waitForRouteReady,
} from './fixtures';

/**
 * F010（梶井基次郎3作品追加）専用のauthor route e2e spec。
 *
 * F007〜F009（tests/e2e/f007-mori-ogai-author.spec.ts〜f009-yumeno-author.spec.ts）の
 * 先例を踏襲し、T-199着手時点でF010最終Catalog統合
 * （scripts/f010-final-integration.ts、`.cache/f010-final-integration-GL47gm/`）
 * の実データ（authorId=000074、name=かじいもとじろう、slug=kajii-motojiro、
 * works=檸檬(000424)/Ｋの昇天(000419)/愛撫(000411)、合計21台詞＝5+12+4）で確定させた。
 *
 * F010の3作品はいずれもofficial-content-warning注記を持たない
 * （notices全て`dialogue-excerpt-scope`のみ、`.cache/f010-final-integration-GL47gm/
 * tree/content/catalog.jsonのauthorId=000074 works[].noticesを実測して確認済み）。
 * F009までの先例（瓶詰地獄・死後の恋にofficial-content-warningがある）とは異なり、
 * F010ではnotice「非存在」を明示的に確認する必要がある（F006（中島敦、同じく
 * 0作品該当）はnoticeテストケース自体を持たないため、本specでは
 * work-list/work-detail双方・credits双方に渡って明示的に0件であることを検証する）。
 * @des DES-F010-010 @fun FUN-F010-011 FUN-F010-012
 */

test.beforeEach(async ({ page }) => {
  // native codec・autoplay・実音声品質ではなく、アプリのAudioPortと遅延取得だけを検査する。
  await installDeterministicAudio(page);
});

// @req REQ-F010-014 @qt QT-F010-010
test('トップに9人目の梶井基次郎カードがデータ駆動で追加され、既存8作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F010以降トップの作者総数は9人になるため、総数ではなく梶井基次郎が
  // 個別に1件存在し所属・件数が不変であることだけを検査する。
  const kajii = page.locator('.author-card').filter({ hasText: 'かじいもとじろう' });
  await expect(kajii).toHaveCount(1);
  await expect(kajii).toContainText('原著者: 梶井基次郎');
  // 実測: 檸檬5・Ｋの昇天12・愛撫4＝合計21台詞
  // （.cache/f010-final-integration-GL47gm/tree/content/catalog.jsonのauthorId=000074
  // works.dialogues.lengthを実測して確認済み）。
  await expect(kajii).toContainText('3作品・21台詞');
});

// @req REQ-F010-014 @req REQ-F010-015 @qt QT-F010-010 @qt QT-F010-011
test('kajii-motojiro routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/kajii-motojiro');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/kajii-motojiro$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000074');
  await expect(page.getByRole('heading', { level: 1, name: 'かじいもとじろう' })).toBeVisible();
  await expect(page.getByText('原著者: 梶井基次郎').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['檸檬', 'Ｋの昇天', '愛撫']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存8作者の作品名が梶井基次郎routeへ混線していないことも確認する。
  for (const title of [
    '羅生門', '注文の多い料理店', '走れメロス', '夢十夜', '山月記', '舞姫', '人間椅子', '瓶詰地獄',
  ]) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F010-011 @req REQ-F010-012 @req REQ-F010-013 @qt QT-F010-006
test('梶井基次郎の3作品いずれにも公式表現注意が付与されていない', async ({ page }) => {
  await page.goto('#/authors/kajii-motojiro');
  await waitForRouteReady(page);

  // work-list配置: 未展開のsummary内にofficial-content-warning spanが存在しない。
  await expect(page.locator('.work-notice-official-content-warning')).toHaveCount(0);

  // work-detail配置: 3作品すべてを展開しても、official-content-warning文言を含む
  // notice行が現れない。
  const panels = page.locator('.work-panel');
  const panelCount = await panels.count();
  expect(panelCount).toBe(3);
  for (let index = 0; index < panelCount; index += 1) {
    const panel = panels.nth(index);
    await panel.locator('summary').click();
    await expect(panel).toHaveAttribute('open', '');
  }
  await expect(page.locator('.work-notice-official-content-warning')).toHaveCount(0);
  // dialogue-excerpt-scope（抜粋である旨）は3作品とも表示されるが、
  // official-content-warning文言は一切含まれない。
  await expect(page.locator('.work-notices-detail').first()).toContainText(
    '本サービスは作品全文の朗読や要約ではなく、括弧で示された発話の抜粋を収録しています。',
  );
  await expect(page.locator('[data-page="author"]')).not.toContainText(
    '今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります',
  );

  // credits配置: クレジット画面の出典一覧にも、梶井基次郎の作品に紐づく
  // official-content-warning行が存在しない。
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  for (const title of ['檸檬', 'Ｋの昇天', '愛撫']) {
    await expect(page.locator('[data-page="credits"]')).not.toContainText(
      `${title}：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。`,
    );
  }
});

// @req REQ-F010-015 @qt QT-F010-011
test('梶井基次郎routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/kajii-motojiro');
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
  // F010以降トップの作者総数は9人になるため、総数ではなく梶井基次郎カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'かじいもとじろう' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
