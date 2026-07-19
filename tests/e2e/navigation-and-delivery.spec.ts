import { expect, test } from '@playwright/test';
import { PAGES_PATH } from './fixtures';

// IT-F001-007 / QT-F001-001 / QT-F001-018
test('Pages subpathでhash routeの直開き・再読込・履歴・キーボード遷移が成立する', async ({ page }) => {
  await page.goto('#/authors/akutagawa-zunnosuke');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/akutagawa-zunnosuke$`));
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
  await expect(page.getByText('原著者：芥川龍之介').first()).toBeVisible();
  await expect(page.locator('.work-panel')).toHaveCount(3);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
  await page.getByRole('link', { name: 'クレジット', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'クレジット・出典・利用条件' })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'クレジット・出典・利用条件' })).toBeVisible();

  await page.goto('#/存在しないページ');
  await expect(page.getByRole('heading', { level: 1, name: 'ページが見つかりません' })).toBeVisible();
  await page.getByRole('link', { name: 'トップへ戻る' }).press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: '文豪ずんだもん' })).toBeVisible();
});

// IT-F001-007 / IT-F001-019
test('catalog異常を再試行可能な全体エラーへ隔離する', async ({ page }) => {
  await page.route('**/content/catalog.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"works":[]}' });
  });
  await page.goto('#/');
  await expect(page.getByRole('heading', { level: 1, name: '作品を読み込めませんでした' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'もう一度読み込む' })).toBeVisible();
  await expect(page.locator('.dialogue-card')).toHaveCount(0);
});

// IT-F001-015 / IT-F001-020 / QT-F001-016 / QT-F001-018
test('production buildの全公開assetがPages base配下で200を返す', async ({ page, request, baseURL }) => {
  const badRequests: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) badRequests.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('#/authors/akutagawa-zunnosuke');
  await expect(page.locator('[data-page="author"]')).toBeVisible();

  const catalogResponse = await request.get(`${baseURL}content/catalog.json`);
  expect(catalogResponse.status()).toBe(200);
  const catalog = await catalogResponse.json() as {
    audioAssets: Array<{ path: string }>;
    author: { artwork?: { path: string } };
  };
  const paths = [
    'content/catalog.json',
    'content/licenses.json',
    'content/provenance.json',
    'content/artwork-provenance.json',
    ...(catalog.author.artwork ? [catalog.author.artwork.path] : []),
    ...catalog.audioAssets.map((asset) => asset.path),
  ];
  expect(paths.length).toBeGreaterThan(5);
  for (const path of new Set(paths)) {
    expect(path.startsWith('/'), `${path} must be relative`).toBe(false);
    expect(path.includes('..'), `${path} must not traverse`).toBe(false);
    const response = await request.get(`${baseURL}${path}`);
    expect(response.status(), path).toBe(200);
  }

  const localResources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
  expect(localResources.length).toBeGreaterThan(2);
  for (const resource of localResources) {
    const url = new URL(resource);
    expect(url.pathname.startsWith(PAGES_PATH), resource).toBe(true);
    expect(url.protocol).toBe('http:');
  }
  expect(badRequests).toEqual([]);
});
