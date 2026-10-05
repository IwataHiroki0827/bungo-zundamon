import { expect, test, type Page } from '@playwright/test';
import { waitForRouteReady } from './fixtures';

// F012 オフライン受入。service workerを有効にした独立contextで検査する。
// Playwrightのservice worker制御・offline emulationはChromium系だけが安定して扱えるため、
// Firefox/WebKit projectでは設計上skipし、unit/結合試験(UT-F012-013〜017・IT-F012-004)で補う。
test.use({ serviceWorkers: 'allow' });
test.skip(({ browserName }) => browserName !== 'chromium', 'service worker受入はChromium系projectで実施する(QT-F012-006)');

async function waitForControlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  }
}

// @qt QT-F012-006 @it IT-F012-004
test('service workerがapp shellを保存し、通信なしでもトップと作者ページを開ける', async ({ page, context }) => {
  await page.goto('#/');
  await waitForRouteReady(page);
  await waitForControlled(page);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((name) => name.startsWith('bz-shell-'))))
    .toBe(true);

  await context.setOffline(true);
  try {
    await page.reload();
    await waitForRouteReady(page);
    await expect(page.locator('.author-card')).toHaveCount(10);
    await expect(page.locator('.daily-dialogue')).toBeVisible();
    await page.goto('#/authors/niimi-nankichi');
    await expect(page.getByRole('heading', { level: 1, name: 'にいみなんきち' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

// @qt QT-F012-006 @it IT-F012-004
test('お気に入り音声は明示的に有効化した時だけ保存し、通信なしでRange要求へ応える', async ({ page, context }) => {
  await page.goto('#/authors/akutagawa-zunnosuke');
  await waitForRouteReady(page);
  await waitForControlled(page);
  const panel = page.locator('.work-panel').first();
  await panel.locator('summary').click();
  await panel.locator('.dialogue-card').first().getByRole('button', { name: 'お気に入りに追加' }).click();
  const audioPath = await page.evaluate(async () => {
    const catalog = await (await fetch('content/catalog.json')).json() as {
      works: Array<{ dialogues: Array<{ dialogueId: string; audioId: string }> }>;
      audioAssets: Array<{ audioId: string; path: string }>;
    };
    const saved = JSON.parse(localStorage.getItem('bungo-zundamon:favorites:v1')!) as { dialogueIds: string[] };
    const dialogue = catalog.works.flatMap((work) => work.dialogues).find((entry) => entry.dialogueId === saved.dialogueIds[0])!;
    return catalog.audioAssets.find((asset) => asset.audioId === dialogue.audioId)!.path;
  });

  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.offline-status')).toContainText('無効');
  expect(await page.evaluate(() => caches.has('bz-audio-v1'))).toBe(false);
  await page.getByRole('button', { name: 'お気に入りの音声を保存する' }).click();
  await expect(page.locator('.offline-status')).toContainText('保存済み 1件');
  await expect(page.locator('.offline-toggle')).toHaveAttribute('aria-pressed', 'true');

  await context.setOffline(true);
  try {
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path, { headers: { Range: 'bytes=0-11' } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, riff: String.fromCharCode(...bytes.slice(0, 4)), length: bytes.length };
    }, audioPath);
    expect(result).toEqual({ status: 206, riff: 'RIFF', length: 12 });
  } finally {
    await context.setOffline(false);
  }

  await page.getByRole('button', { name: '保存をやめて削除する' }).click();
  await expect(page.locator('.offline-status')).toContainText('無効');
  expect(await page.evaluate(() => caches.has('bz-audio-v1'))).toBe(false);
});
