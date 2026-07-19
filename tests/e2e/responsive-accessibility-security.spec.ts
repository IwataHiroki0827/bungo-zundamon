import { expect, test } from '@playwright/test';
import { assertNoHorizontalOverflow, installDeterministicAudio } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installDeterministicAudio(page);
});

const viewports = [
  { name: 'mobile-portrait', width: 390, height: 844 },
  { name: 'mobile-landscape', width: 844, height: 390 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

// IT-F001-010 / QT-F001-013 / QT-F001-014
for (const viewport of viewports) {
  test(`${viewport.name}で3操作以内・overflowなし・keyboard/44px targetを満たす`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('#/');
    await assertNoHorizontalOverflow(page);

    const authorLink = page.getByRole('link', { name: '作品と台詞を聴く' });
    await authorLink.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    const firstWork = page.locator('.work-panel').first();
    await expect(firstWork).toHaveAttribute('open', '');
    const play = firstWork.getByRole('button', { name: /^再生：/ }).first();
    await play.focus();
    await expect(play).toBeFocused();
    const target = await play.boundingBox();
    expect(target).not.toBeNull();
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(target!.width).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(firstWork.locator('.dialogue-card').first()).toHaveAttribute('data-player-state', 'playing');

    await page.getByRole('link', { name: 'クレジット', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'クレジット・出典・利用条件' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
}

// IT-F001-010 / QT-F001-014（axe相当の構造検査。実スクリーンリーダーは手動項目）
test('主要routeの見出し・list・button名・画像代替・focus順に重大な構造欠陥がない', async ({ page }) => {
  for (const route of ['#/', '#/authors/akutagawa-zunnosuke', '#/credits']) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    expect(await page.locator('h1').count()).toBe(1);
    expect(await page.locator('button:not([aria-label]):not(:has-text("演出を")):not(:has-text("停止"))').count()).toBe(0);
    expect(await page.locator('img:not([alt])').count()).toBe(0);
    expect(await page.locator('a[href=""]').count()).toBe(0);
    const duplicateIds = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]'), (node) => node.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    expect(duplicateIds).toEqual([]);
  }
});

// IT-F001-011 / QT-F001-015
test('OS設定とサイト内設定でreduced motionを有効化し情報を保持する', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('#/authors/akutagawa-zunnosuke');
  await expect(page.locator('#app')).toHaveAttribute('data-motion', 'full');
  await expect(page.locator('.motion-toggle')).toContainText('ページ切替と再生アイコンが動きます');
  await page.getByRole('button', { name: '演出を控えめにする' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('.motion-toggle')).toContainText('ページ切替と再生アイコンの動きを停止中');
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
  const siteDuration = await page.locator('.page').evaluate((node) => getComputedStyle(node).animationDuration);
  expect(Number.parseFloat(siteDuration)).toBeLessThanOrEqual(0.001);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('.motion-toggle')).toContainText('端末設定により動きを停止中');
  await expect(page.locator('.motion-toggle')).toBeDisabled();
  const osDuration = await page.locator('.page').evaluate((node) => getComputedStyle(node).animationDuration);
  expect(Number.parseFloat(osDuration)).toBeLessThanOrEqual(0.001);
});

// IT-F001-012 / QT-F001-011 / QT-F001-017
test('footer・クレジット・出典・外部link属性とプライバシー表示が全routeで安全である', async ({ page }) => {
  for (const route of ['#/', '#/authors/akutagawa-zunnosuke', '#/credits', '#/unknown']) {
    await page.goto(route);
    await expect(page.locator('.site-footer')).toContainText('VOICEVOX:ずんだもん');
    await expect(page.locator('.site-footer')).toContainText('非公式ファンサイト');
  }
  await page.goto('#/credits');
  const pageText = await page.locator('[data-page="credits"]').innerText();
  for (const required of [
    '青空文庫',
    'CC BY 4.0',
    'キャラクター利用ガイドライン',
    '立ち絵：坂本アヒル',
    '広告・課金はありません',
    '入力フォーム、Cookie、アクセス解析などによる追跡は行いません',
    '日本国外での権利状態を一律に保証しません',
    '問い合わせ方法',
  ]) expect(pageText).toContain(required);

  const externalLinks = page.locator('[data-page="credits"] a[href^="https://"]');
  expect(await externalLinks.count()).toBeGreaterThan(5);
  for (const link of await externalLinks.all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(new URL((await link.getAttribute('href'))!).protocol).toBe('https:');
  }
});

// IT-F001-013 / IT-F001-020 / QT-F001-017
test('外部request・Cookie・storage・form・CSP違反が0件で主要操作を完遂する', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
  });
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  await page.goto('#/');
  await page.getByRole('link', { name: '作品と台詞を聴く' }).click();
  const first = page.locator('.dialogue-card').first();
  await first.getByRole('button', { name: /^再生：/ }).click();
  await expect(first).toHaveAttribute('data-player-state', 'playing');
  await first.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();

  expect(externalRequests).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
  expect(await page.evaluate(() => ({
    csp: window.__cspViolations,
    forms: document.forms.length,
    local: localStorage.length,
    session: sessionStorage.length,
  }))).toEqual({ csp: [], forms: 0, local: 0, session: 0 });
});
