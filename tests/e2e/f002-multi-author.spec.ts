import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  assertNoHorizontalOverflow,
  expandFirstWork,
  installDeterministicAudio,
  PAGES_PATH,
  waitForRouteReady,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  // native codec・autoplay・実音声品質ではなく、アプリのAudioPortと遅延取得だけを検査する。
  await installDeterministicAudio(page);
});

async function openAuthorFromHome(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto('#/');
  const card = page.locator('.author-card').filter({ hasText: name });
  await expect(card).toHaveCount(1);
  await card.getByRole('link', { name: '作品と台詞を聴く' }).click();
  await waitForRouteReady(page);
}

// @it IT-F002-010 @it IT-F002-012 @it IT-F003-009 @it IT-F003-014 @it IT-F004-007 @it IT-F004-008 @qt QT-F002-002 @qt QT-F002-014 @qt QT-F003-015 @qt QT-F004-010
test('CatalogV2の3作者12作品674台詞を所属分離し、作者間の往復を維持する', async ({ page }) => {
  await page.goto('#/');
  // F005以降トップの作者総数は4人（夏目漱石追加）になるため、総数ではなく既存3作者が
  // 個別に1件ずつ存在し所属・件数が不変であることだけを検査する（F005固有の検証はf005 specへ分離）。
  const akutagawa = page.locator('.author-card').filter({ hasText: 'あくたがわずんのすけ' });
  const miyazawa = page.locator('.author-card').filter({ hasText: 'みやざわずんじ' });
  const dazai = page.locator('.author-card').filter({ hasText: 'だざいおさむ' });
  await expect(akutagawa).toHaveCount(1);
  await expect(miyazawa).toHaveCount(1);
  await expect(dazai).toHaveCount(1);
  await expect(akutagawa).toContainText('原著者: 芥川龍之介');
  await expect(akutagawa).toContainText('3作品・59台詞');
  await expect(miyazawa).toContainText('原著者: 宮沢賢治');
  await expect(miyazawa).toContainText('6作品・356台詞');
  await expect(dazai).toContainText('原著者: 太宰治');
  await expect(dazai).toContainText('3作品・259台詞');

  await miyazawa.getByRole('link', { name: '作品と台詞を聴く' }).click();
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/miyazawa-zunji$`));
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000081');
  await expect(page.getByRole('heading', { level: 1, name: 'みやざわずんじ' })).toBeVisible();
  await expect(page.getByText('原著者: 宮沢賢治').first()).toBeVisible();
  await expect(page.locator('.work-panel')).toHaveCount(6);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  await expect(page.locator('.dialogue-card')).toHaveCount(356);
  for (const title of [
    'よだかの星',
    'どんぐりと山猫',
    '注文の多い料理店',
    'オツベルと象',
    '雪渡り',
    'カイロ団長',
  ]) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  for (const title of ['羅生門', '蜘蛛の糸', '杜子春']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }

  await page.getByRole('link', { name: 'トップ', exact: true }).click();
  await akutagawa.getByRole('link', { name: '作品と台詞を聴く' }).click();
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000879');
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  await expect(page.locator('.dialogue-card')).toHaveCount(59);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: '文豪ずんだもん' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'みやざわずんじ' })).toBeVisible();
});

// @it IT-F002-011 @it IT-F002-012 @it IT-F003-010 @qt QT-F002-008 @qt QT-F002-014 @qt QT-F003-011
test('作者route変更で音声を停止し、遅延eventを新しい作者DOMへ混入させない', async ({ page }) => {
  const audioRequests: string[] = [];
  await page.route('**/audio/**', async (route) => {
    audioRequests.push(route.request().url());
    await route.continue();
  });
  await openAuthorFromHome(page, 'みやざわずんじ');
  expect(audioRequests).toHaveLength(0);
  await expandFirstWork(page);
  const firstMiyazawa = page.locator('.dialogue-card').first();
  await firstMiyazawa.getByRole('button', { name: /^再生：/ }).click();
  await expect(firstMiyazawa).toHaveAttribute('data-player-state', 'playing');
  expect(audioRequests).toHaveLength(1);
  await page.evaluate(() => { window.__audioInstances[0]!.currentTime = 9; });

  await page.getByRole('link', { name: 'トップ', exact: true }).click();
  await waitForRouteReady(page);
  const akutagawa = page.locator('.author-card').filter({ hasText: 'あくたがわずんのすけ' });
  await akutagawa.getByRole('link', { name: '作品と台詞を聴く' }).click();
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000879');
  expect(await page.evaluate(() => ({
    count: window.__audioInstances.length,
    paused: window.__audioInstances[0]!.paused,
    currentTime: window.__audioInstances[0]!.currentTime,
    src: window.__audioInstances[0]!.src,
  }))).toEqual({ count: 1, paused: true, currentTime: 0, src: '' });

  await page.evaluate(() => {
    window.__audioInstances[0]!.dispatchEvent(new Event('ended'));
    window.__audioInstances[0]!.dispatchEvent(new Event('error'));
  });
  await expect(page.locator('.dialogue-card[data-player-state="idle"]')).toHaveCount(59);
  await expect(page.getByText('読み上げが終わりました。')).toHaveCount(0);
  await expect(page.getByText(/音声を再生できませんでした/)).toHaveCount(0);
});

// @it IT-F002-010 @it IT-F002-014 @it IT-F003-010 @qt QT-F002-002 @qt QT-F002-014 @qt QT-F003-014
for (const viewport of [
  { name: '390x844', width: 390, height: 844 },
  { name: '844x390', width: 844, height: 390 },
  { name: '1440x900', width: 1440, height: 900 },
] as const) {
  test(`${viewport.name}で宮沢routeをkeyboard操作でき、overflowと44px未満targetがない`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('#/');
    await assertNoHorizontalOverflow(page);
    const miyazawa = page.locator('.author-card').filter({ hasText: 'みやざわずんじ' });
    const link = miyazawa.getByRole('link', { name: '作品と台詞を聴く' });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'みやざわずんじ' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await expandFirstWork(page);
    const play = page.locator('.dialogue-card').first().getByRole('button', { name: /^再生：/ });
    await play.focus();
    const box = await play.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(page.locator('.dialogue-card').first()).toHaveAttribute('data-player-state', 'playing');
  });
}

// @it IT-F002-012 @it IT-F003-010 @it IT-F004-008 @qt QT-F002-014 @qt QT-F003-014 @qt QT-F004-011
test('reduced motionは宮沢の情報と再生操作を保ったまま演出だけを止める', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('#/authors/miyazawa-zunji');
  await expect(page.locator('#app')).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('.motion-toggle')).toBeDisabled();
  await expect(page.locator('.motion-toggle')).toContainText('端末設定により動きを停止中');
  await expect(page.locator('.work-panel')).toHaveCount(6);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  await expandFirstWork(page);
  const play = page.locator('.dialogue-card').first().getByRole('button', { name: /^再生：/ });
  await play.click();
  await expect(page.locator('.dialogue-card').first()).toHaveAttribute('data-player-state', 'playing');
  const duration = await page.locator('.page').evaluate((node) => getComputedStyle(node).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
});

// @it IT-F002-010 @it IT-F002-014 @qt QT-F002-002 @qt QT-F002-014
test('宮沢画像とcreditを同一originの公開実体へ結合する', async ({ page, request, baseURL }) => {
  await page.goto('#/authors/miyazawa-zunji');
  const image = page.getByRole('img', {
    name: '宮沢賢治の文学世界をイメージしたずんだもんのオリジナルイラスト',
  });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /artwork\/miyazawa-zundamon\.png$/);
  const imageResponse = await request.get(`${baseURL}artwork/miyazawa-zundamon.png`);
  expect(imageResponse.status()).toBe(200);
  const imageBytes = await imageResponse.body();
  expect(imageBytes.byteLength).toBeGreaterThan(0);
  const catalogResponse = await request.get(`${baseURL}content/catalog.json`);
  expect(catalogResponse.status()).toBe(200);
  const catalog = await catalogResponse.json() as {
    authors: Array<{ authorId: string; artwork: { sha256: string } }>;
  };
  const miyazawaArtwork = catalog.authors.find((author) => author.authorId === '000081')?.artwork;
  expect(miyazawaArtwork).toBeDefined();
  expect(createHash('sha256').update(imageBytes).digest('hex')).toBe(miyazawaArtwork!.sha256);

  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  await expect(page.locator('[data-page="credits"]')).toContainText('宮沢賢治ずんだもん');
  await expect(page.locator('[data-page="credits"]')).toContainText('VOICEVOX:ずんだもん');
});

// @it IT-F002-012 @it IT-F003-011 @it IT-F004-013 @qt QT-F002-014 @qt QT-F003-013 @qt QT-F003-014 @qt QT-F004-013 @qt QT-F004-014
test('3作者の主要routeで許可外通信・CSP・Cookie・storage・formが0件', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  for (const route of [
    '#/',
    '#/authors/akutagawa-zunnosuke',
    '#/authors/miyazawa-zunji',
    '#/authors/dazai-osamu',
    '#/favorites',
    '#/credits',
  ]) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    if (route.startsWith('#/authors/')) await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  }
  expect(externalRequests).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
  expect(await page.evaluate(() => ({
    csp: window.__cspViolations,
    forms: document.forms.length,
    local: localStorage.length,
    session: sessionStorage.length,
  }))).toEqual({ csp: [], forms: 0, local: 0, session: 0 });
});
