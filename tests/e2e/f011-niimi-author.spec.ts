import { expect, test } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  installDeterministicAudio,
  PAGES_PATH,
  waitForRouteReady,
} from './fixtures';

/**
 * F011（新美南吉3作品追加・10人目にして最終作者）専用のauthor route e2e spec。
 *
 * F007〜F010（tests/e2e/f007-mori-ogai-author.spec.ts〜f010-kajii-author.spec.ts）の
 * 先例を踏襲し、T-210着手時点でF011最終Catalog統合
 * （scripts/f011-final-integration.ts、`.cache/f011-final-integration-PHFSi1/`）
 * の実データ（authorId=000121、name=にいみなんきち、slug=niimi-nankichi、
 * works=手袋を買いに(000637)/ごん狐(000628)/二ひきの蛙(004718)、
 * 合計68台詞＝27+30+11。ごん狐は既にAUDIO_ID_COLLISIONによる2件のaudio除外が
 * 反映された後の実測値）で確定させた。
 *
 * F011の3作品はいずれもofficial-content-warning注記を持たない
 * （notices全て`dialogue-excerpt-scope`のみ、`.cache/f011-final-integration-PHFSi1/
 * tree/content/catalog.jsonのauthorId=000121 works[].noticesを実測して確認済み）。
 * F010と同様に、notice「非存在」を明示的に確認する必要がある。
 *
 * 実行環境注記: F011統合candidateは`.cache/f011-final-integration-PHFSi1/`に
 * staged済みだが、`public/`への昇格（T-211・リリース工程）はまだ行われていない。
 * このspecはT-210時点では`public/`未変更のためlocal previewサーバーがF011データを
 * 配信できず実ブラウザ実行はできない（F009/F010testspec時点と同型の既知制約）。
 * T-211でcandidateがpromoteされた後、他のf0xx-*-author.spec.tsと同時に
 * 実行されることを前提に、実測値のみで確定させている。
 * @des DES-F011-010 @fun FUN-F011-011 FUN-F011-012
 */

test.beforeEach(async ({ page }) => {
  // native codec・autoplay・実音声品質ではなく、アプリのAudioPortと遅延取得だけを検査する。
  await installDeterministicAudio(page);
});

// @req REQ-F011-014 @qt QT-F011-010
test('トップに10人目の新美南吉カードがデータ駆動で追加され、既存9作者と共存する', async ({ page }) => {
  await page.goto('#/');
  // F011以降トップの作者総数は10人になるため、総数ではなく新美南吉が
  // 個別に1件存在し所属・件数が不変であることだけを検査する。
  const niimi = page.locator('.author-card').filter({ hasText: 'にいみなんきち' });
  await expect(niimi).toHaveCount(1);
  await expect(niimi).toContainText('原著者: 新美南吉');
  // 実測: 手袋を買いに27・ごん狐30・二ひきの蛙11＝合計68台詞
  // （.cache/f011-final-integration-PHFSi1/tree/content/catalog.jsonのauthorId=000121
  // works.dialogues.lengthを実測して確認済み。ごん狐のAUDIO_ID_COLLISIONによる
  // 2件除外を既に反映した後の公開台詞数）。
  await expect(niimi).toContainText('3作品・68台詞');
});

// @req REQ-F011-014 @req REQ-F011-015 @qt QT-F011-010 @qt QT-F011-011
test('niimi-nankichi routeへ直接遷移でき、3作品の所属が正しく初期全閉で表示される', async ({ page }) => {
  await page.goto('#/authors/niimi-nankichi');
  await expect(page).toHaveURL(new RegExp(`${PAGES_PATH.replaceAll('/', '\\/')}#/authors/niimi-nankichi$`));
  await waitForRouteReady(page);
  await expect(page.locator('[data-page="author"]')).toHaveAttribute('data-author-id', '000121');
  await expect(page.getByRole('heading', { level: 1, name: 'にいみなんきち' })).toBeVisible();
  await expect(page.getByText('原著者: 新美南吉').first()).toBeVisible();

  await expect(page.locator('.work-panel')).toHaveCount(3);
  await expect(page.locator('.work-panel[open]')).toHaveCount(0);
  for (const title of ['手袋を買いに', 'ごん狐', '二ひきの蛙']) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(1);
  }
  // 既存9作者の作品名が新美南吉routeへ混線していないことも確認する。
  for (const title of [
    '羅生門', '注文の多い料理店', '走れメロス', '夢十夜', '山月記', '舞姫', '人間椅子', '瓶詰地獄', '檸檬',
  ]) {
    await expect(page.locator('.work-title', { hasText: title })).toHaveCount(0);
  }
});

// @req REQ-F011-011 @req REQ-F011-012 @req REQ-F011-013 @qt QT-F011-006
test('新美南吉の3作品いずれにも公式表現注意が付与されていない', async ({ page }) => {
  await page.goto('#/authors/niimi-nankichi');
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

  // credits配置: クレジット画面の出典一覧にも、新美南吉の作品に紐づく
  // official-content-warning行が存在しない。
  await page.getByRole('link', { name: 'クレジット', exact: true }).click();
  await expect(page.locator('[data-page="credits"]')).toBeVisible();
  for (const title of ['手袋を買いに', 'ごん狐', '二ひきの蛙']) {
    await expect(page.locator('[data-page="credits"]')).not.toContainText(
      `${title}：青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。`,
    );
  }
});

// @req REQ-F011-015 @qt QT-F011-011
test('新美南吉routeでも初期全閉・単一再生・route切替停止のcontractを維持する', async ({ page }) => {
  await page.goto('#/authors/niimi-nankichi');
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
  // F011以降トップの作者総数は10人になるため、総数ではなく新美南吉カードの存在だけ確認する。
  await expect(page.locator('.author-card').filter({ hasText: 'にいみなんきち' })).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
});
