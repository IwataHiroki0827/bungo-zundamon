import type { AudioController } from './audio-controller';
import { PLAYBACK_RATES } from './audio-controller';
import { selectDailyDialogue, tokyoDateKey } from './daily';
import type { FavoriteController } from './favorites';
import {
  FAVORITE_EXPORT_FILE_NAME,
  FAVORITE_SHARE_MAX_IDS,
  buildFavoriteExport,
  buildFavoriteShareUrl,
  parseFavoriteImport,
  type FavoriteImportResult,
} from './favorites-transfer';
import { OFFLINE_AUDIO_BUDGET_BYTES, formatMegabytes, type OfflineAudioManager, type OfflineAudioStatus } from './offline';
import { cleanupRenderedTree, registerCleanup, renderDialogueCard, sourceLinkFor, setSafeText } from './render';
import { SEARCH_QUERY_MAX, searchDialogues } from './search';
import type { CatalogDialogue, UICatalog, UICatalogV2 } from './types';

/** F012で追加した画面部品。文字列は常にtextContentで描画する(setSafeText)。 */

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  setSafeText(element, value);
  return element;
}

function button(label: string, className: string): HTMLButtonElement {
  const element = text('button', label, className);
  element.type = 'button';
  return element;
}

function listen<K extends keyof HTMLElementEventMap>(
  owner: Node,
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
): void {
  target.addEventListener(type, listener as EventListener);
  registerCleanup(owner, () => target.removeEventListener(type, listener as EventListener));
}

/**
 * 再生速度・音量。値はAudioControllerがsession中だけ保持し、端末へ保存しない。
 * @des DES-F012-004 @fun FUN-F012-010
 */
export function renderPlaybackSettings(controller: AudioController): HTMLElement {
  const group = document.createElement('div');
  group.className = 'playback-settings';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '再生設定');
  // 試験用の軽量controller等、設定APIを持たない実装でも描画を止めない。
  const settings = controller.playbackSettings ?? { rate: 1, volume: 1 };
  const configurable = typeof controller.setPlaybackRate === 'function' && typeof controller.setVolume === 'function';

  const rateLabel = document.createElement('label');
  rateLabel.className = 'playback-field';
  const rate = document.createElement('select');
  rate.className = 'playback-rate';
  for (const value of PLAYBACK_RATES) {
    const option = text('option', `${value}倍`);
    option.value = String(value);
    option.selected = value === settings.rate;
    rate.append(option);
  }
  rateLabel.append(text('span', '速度'), rate);

  const volumeLabel = document.createElement('label');
  volumeLabel.className = 'playback-field';
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'playback-volume';
  volume.min = '0';
  volume.max = '100';
  volume.step = '5';
  volume.value = String(Math.round(settings.volume * 100));
  const volumeValue = text('output', `${volume.value}%`, 'playback-volume-value');
  volume.setAttribute('aria-valuetext', `${volume.value}%`);
  volumeLabel.append(text('span', '音量'), volume, volumeValue);

  group.append(rateLabel, volumeLabel);
  if (!configurable) {
    rate.disabled = true;
    volume.disabled = true;
    return group;
  }
  listen(group, rate, 'change', () => {
    const applied = controller.setPlaybackRate(Number(rate.value));
    rate.value = String(applied.rate);
  });
  listen(group, volume, 'input', () => {
    const applied = controller.setVolume(Number(volume.value) / 100);
    const percent = `${Math.round(applied.volume * 100)}%`;
    setSafeText(volumeValue, percent);
    volume.setAttribute('aria-valuetext', percent);
  });
  return group;
}

/**
 * 作品パネルの「連続再生」ボタン。明示操作でだけ開始し、もう一度押すと停止する。
 * @des DES-F012-001 @fun FUN-F012-002
 */
export function renderSequenceControl(
  controller: AudioController,
  workId: string,
  title: string,
  items: readonly CatalogDialogue[],
): HTMLButtonElement {
  const key = `work:${workId}`;
  const control = button('連続再生', 'sequence-button');
  control.dataset.workId = workId;
  const update = (): void => {
    const active = controller.sequence?.key === key;
    control.setAttribute('aria-pressed', String(active));
    control.setAttribute('aria-label', active ? `連続再生を止める：${title}` : `連続再生：${title}`);
    setSafeText(control, active ? '連続再生を止める' : `連続再生（${items.length}台詞）`);
  };
  const unsubscribe = controller.subscribe(update);
  if (typeof controller.playSequence !== 'function') control.disabled = true;
  listen(control, control, 'click', () => {
    if (controller.sequence?.key === key) controller.stopSequence();
    else void controller.playSequence(key, items);
  });
  registerCleanup(control, unsubscribe);
  update();
  return control;
}

/**
 * 既存の書誌メタデータだけで作る「作品データ」カード。新しい解説文は書かず、
 * 青空文庫の図書カードと本文ページへの外部リンクを新しいタブで開く。
 * @des DES-F012-007 @fun FUN-F012-018
 */
export function renderWorkBibliography(
  work: (UICatalog['works'][number] | UICatalogV2['works'][number]),
  author: { readonly name: string; readonly originalName?: string } | undefined,
  authorId: string | undefined,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'work-bibliography';
  section.setAttribute('aria-label', `作品データ：${work.title}`);
  section.append(text('h3', '作品データ', 'work-bibliography-title'));
  const list = document.createElement('dl');
  const rows: Array<[string, string]> = [];
  if (author) {
    rows.push(['作者', author.originalName ? `${author.name}（原著者: ${author.originalName}）` : author.name]);
  }
  rows.push(['作品', work.title]);
  rows.push(['底本', work.source.baseEdition]);
  rows.push(['収録', `${work.dialogues.length}台詞（作中のかぎ括弧内の発話を抜粋）`]);
  try {
    rows.push(['原典確認日', tokyoDateKey(new Date(work.source.fetchedAt))]);
  } catch {
    // 日付が読めない場合は行を省略する(Catalog検証済みのため通常は発生しない)。
  }
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.append(text('dt', label), text('dd', value));
    list.append(row);
  }
  const links = document.createElement('p');
  links.className = 'work-bibliography-links';
  const textLink = sourceLinkFor('本文を青空文庫で読む', work.source.textUrl, authorId);
  textLink.className = 'source-text-link';
  textLink.setAttribute('aria-label', `${work.title}の本文を青空文庫で読む（新しいタブ）`);
  links.append(textLink);
  section.append(list, links);
  return section;
}

/**
 * トップの「今日の一台詞」。日本時間の日付から決定的に1件を選ぶ。
 * @des DES-F012-005 @fun FUN-F012-012
 */
export function renderDailyDialogue(
  catalog: UICatalogV2,
  controller: AudioController,
  favoriteController: FavoriteController | undefined,
  now: Date,
): HTMLElement | null {
  let daily;
  try {
    daily = selectDailyDialogue(catalog, tokyoDateKey(now));
  } catch {
    return null;
  }
  if (!daily) return null;
  const section = document.createElement('section');
  section.className = 'daily-dialogue';
  section.setAttribute('aria-labelledby', 'daily-dialogue-title');
  const title = text('h2', '今日の一台詞', 'daily-dialogue-title');
  title.id = 'daily-dialogue-title';
  const [year, month, day] = daily.dateKey.split('-').map(Number);
  const meta = text('p', `${year}年${month}月${day}日・${daily.author.name}『${daily.work.title}』より`, 'daily-meta');
  const source = sourceLinkFor('この台詞の作品出典', daily.work.cardLink, daily.author.authorId);
  source.className = 'dialogue-source-link';
  const card = renderDialogueCard(daily.dialogue, controller, source, favoriteController);
  const authorLink = text('a', `${daily.author.name}の作品を聴く`, 'route-link daily-author-link');
  authorLink.href = `#/authors/${encodeURIComponent(daily.author.slug)}`;
  section.append(title, meta, card, authorLink);
  section.dataset.dateKey = daily.dateKey;
  registerCleanup(section, () => cleanupRenderedTree(card));
  return section;
}

/**
 * トップの台詞検索。routeは増やさず、キーワードと作者で絞り込んだ結果を同じ画面に出す。
 * @des DES-F012-003 @fun FUN-F012-008
 */
export function renderDialogueSearch(
  catalog: UICatalogV2,
  controller: AudioController,
  favoriteController: FavoriteController | undefined,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'dialogue-search';
  section.setAttribute('aria-labelledby', 'dialogue-search-title');
  const title = text('h2', '台詞をさがす', 'dialogue-search-title');
  title.id = 'dialogue-search-title';

  const controls = document.createElement('div');
  controls.className = 'search-controls';
  controls.setAttribute('role', 'search');
  const queryLabel = document.createElement('label');
  queryLabel.className = 'search-field';
  const query = document.createElement('input');
  query.type = 'search';
  query.className = 'search-query';
  query.maxLength = SEARCH_QUERY_MAX;
  query.autocomplete = 'off';
  query.placeholder = '例: 羅生門、ごんぎつね、メロス';
  queryLabel.append(text('span', 'キーワード'), query);
  const authorLabel = document.createElement('label');
  authorLabel.className = 'search-field';
  const author = document.createElement('select');
  author.className = 'search-author';
  const all = text('option', 'すべての作者');
  all.value = '';
  author.append(all);
  for (const entry of catalog.authors) {
    const option = text('option', `${entry.name}（${entry.originalName}）`);
    option.value = entry.authorId;
    author.append(option);
  }
  authorLabel.append(text('span', '作者'), author);
  controls.append(queryLabel, authorLabel);

  const status = text('p', 'キーワードを入力するか作者を選ぶと、台詞を表示します。', 'search-status');
  status.setAttribute('aria-live', 'polite');
  const results = document.createElement('ol');
  results.className = 'search-results';

  const paint = (): void => {
    cleanupRenderedTree(results);
    results.replaceChildren();
    const result = searchDialogues(catalog, query.value, author.value);
    if (query.value.trim() === '' && author.value === '') {
      setSafeText(status, 'キーワードを入力するか作者を選ぶと、台詞を表示します。');
      return;
    }
    if (result.total === 0) {
      setSafeText(status, '該当する台詞は見つかりませんでした。');
      return;
    }
    setSafeText(status, result.total > result.hits.length
      ? `${result.total}件見つかりました。先頭の${result.hits.length}件を表示しています。`
      : `${result.total}件見つかりました。`);
    for (const hit of result.hits) {
      const item = document.createElement('li');
      item.className = 'search-result';
      const source = sourceLinkFor('この台詞の作品出典', hit.work.cardLink, hit.author.authorId);
      source.className = 'dialogue-source-link';
      item.append(
        text('p', `${hit.author.name}『${hit.work.title}』`, 'search-result-meta'),
        renderDialogueCard(hit.dialogue, controller, source, favoriteController),
      );
      results.append(item);
    }
  };
  listen(section, query, 'input', paint);
  listen(section, author, 'change', paint);
  registerCleanup(section, () => cleanupRenderedTree(results));
  section.append(title, controls, renderPlaybackSettings(controller), status, results);
  return section;
}

const IMPORT_FAILURE_MESSAGE: Record<Exclude<FavoriteImportResult, { ok: true }>['reason'], string> = {
  'too-large': 'ファイルが大きすぎるため取り込めませんでした。',
  malformed: 'ファイルの形式を読み取れませんでした。書き出したJSONファイルを選んでください。',
  'schema-invalid': '文豪ずんだもんのお気に入りファイルではないため取り込めませんでした。',
  empty: '取り込める台詞が含まれていませんでした。',
};

export interface ShareOffer {
  readonly result: FavoriteImportResult;
}

function mergeMessage(added: number, alreadySaved: number, ignored: number): string {
  const extras = [
    alreadySaved > 0 ? `登録済み${alreadySaved}件` : '',
    ignored > 0 ? `取り込めない${ignored}件` : '',
  ].filter(Boolean);
  return `${added}件をお気に入りに追加しました。${extras.length > 0 ? `（${extras.join('・')}）` : ''}`;
}

/**
 * 共有リンクから開いた場合の確認。自動では追加せず、利用者の選択で取り込む。
 * @des DES-F012-002 @fun FUN-F012-006
 */
export function renderShareOffer(
  offer: ShareOffer,
  favoriteController: FavoriteController,
  onResolved: () => void,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'share-offer paper-card';
  section.setAttribute('aria-labelledby', 'share-offer-title');
  const title = text('h2', '共有されたお気に入り', 'share-offer-title');
  title.id = 'share-offer-title';
  const message = text('p', '', 'share-offer-message');
  message.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  actions.className = 'transfer-actions';
  section.append(title, message, actions);
  const finish = (value: string): void => {
    setSafeText(message, value);
    cleanupRenderedTree(actions);
    actions.replaceChildren();
    onResolved();
  };
  if (!offer.result.ok) {
    setSafeText(message, `共有リンクを読み取れませんでした。${IMPORT_FAILURE_MESSAGE[offer.result.reason]}`);
    const close = button('閉じる', 'transfer-button');
    listen(actions, close, 'click', () => {
      onResolved();
      section.remove();
    });
    actions.append(close);
    return section;
  }
  const result = offer.result;
  setSafeText(message, `共有リンクに${result.dialogueIds.length}件の台詞が含まれています。${
    result.unknownCount > 0 ? `（このサイトにない${result.unknownCount}件は除きます）` : ''
  }お気に入りに追加しますか。`);
  const accept = button('お気に入りに追加する', 'transfer-button is-primary');
  const decline = button('追加しない', 'transfer-button');
  listen(actions, accept, 'click', () => {
    const merged = favoriteController.merge(result.dialogueIds);
    finish(mergeMessage(merged.added, merged.alreadySaved, merged.ignored + result.unknownCount));
  });
  listen(actions, decline, 'click', () => finish('共有リンクの台詞は追加しませんでした。'));
  actions.append(accept, decline);
  return section;
}

/**
 * お気に入りの書き出し・取り込み・共有リンク。保存処理はFavoriteControllerへ委ねる。
 * @des DES-F012-002 @fun FUN-F012-006
 */
export function renderFavoriteTransfer(
  catalog: UICatalog | UICatalogV2,
  favoriteController: FavoriteController,
  baseUrl: URL,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'favorite-transfer paper-card';
  section.setAttribute('aria-labelledby', 'favorite-transfer-title');
  const title = text('h2', '書き出し・取り込み', 'favorite-transfer-title');
  title.id = 'favorite-transfer-title';
  const lead = text('p', 'お気に入りをファイルや共有リンクにして、別の端末やブラウザへ移せます。ファイルとリンクに含まれるのは台詞のIDだけです。', 'transfer-lead');
  const actions = document.createElement('div');
  actions.className = 'transfer-actions';
  const exportButton = button('ファイルに書き出す', 'transfer-button');
  const importLabel = document.createElement('label');
  importLabel.className = 'transfer-button transfer-file';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.className = 'transfer-file-input';
  importLabel.append(text('span', 'ファイルから取り込む'), importInput);
  const shareButton = button('共有リンクを作る', 'transfer-button');
  actions.append(exportButton, importLabel, shareButton);
  const status = text('p', '', 'transfer-status');
  status.setAttribute('aria-live', 'polite');
  const shareField = document.createElement('input');
  shareField.type = 'text';
  shareField.readOnly = true;
  shareField.className = 'share-url';
  shareField.hidden = true;
  shareField.setAttribute('aria-label', '共有リンク');

  listen(section, exportButton, 'click', () => {
    const ids = favoriteController.snapshot.dialogueIds;
    if (ids.length === 0) {
      setSafeText(status, 'お気に入りがまだないため、書き出すものがありません。');
      return;
    }
    if (typeof URL.createObjectURL !== 'function') {
      setSafeText(status, 'このブラウザではファイルを書き出せません。共有リンクをご利用ください。');
      return;
    }
    const blob = new Blob([buildFavoriteExport({ dialogueIds: ids })], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = FAVORITE_EXPORT_FILE_NAME;
    anchor.hidden = true;
    section.append(anchor);
    anchor.click();
    anchor.remove();
    // 一部ブラウザはclick直後にrevokeするとdownloadを開始できないため、少し待ってから解放する。
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    setSafeText(status, `${ids.length}件を「${FAVORITE_EXPORT_FILE_NAME}」に書き出しました。`);
  });

  listen(section, importInput, 'change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    if (file.size > 1_048_576) {
      setSafeText(status, IMPORT_FAILURE_MESSAGE['too-large']);
      return;
    }
    void file.text().then((raw) => {
      const result = parseFavoriteImport(raw, catalog);
      if (!result.ok) {
        setSafeText(status, IMPORT_FAILURE_MESSAGE[result.reason]);
        return;
      }
      const merged = favoriteController.merge(result.dialogueIds);
      setSafeText(status, mergeMessage(merged.added, merged.alreadySaved, merged.ignored + result.unknownCount));
    }, () => setSafeText(status, IMPORT_FAILURE_MESSAGE.malformed));
  });

  listen(section, shareButton, 'click', () => {
    const ids = favoriteController.snapshot.dialogueIds;
    if (ids.length === 0) {
      setSafeText(status, 'お気に入りがまだないため、共有リンクを作れません。');
      shareField.hidden = true;
      return;
    }
    const url = buildFavoriteShareUrl(baseUrl, ids);
    if (!url) {
      setSafeText(status, `共有リンクに含められるのは${FAVORITE_SHARE_MAX_IDS}件までです。ファイルへの書き出しをご利用ください。`);
      shareField.hidden = true;
      return;
    }
    shareField.value = url;
    shareField.hidden = false;
    shareField.select();
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(url).then(
        () => setSafeText(status, `${ids.length}件の共有リンクをコピーしました。`),
        () => setSafeText(status, `${ids.length}件の共有リンクを表示しました。選択してコピーしてください。`),
      );
    } else {
      setSafeText(status, `${ids.length}件の共有リンクを表示しました。選択してコピーしてください。`);
    }
  });

  section.append(title, lead, actions, status, shareField);
  return section;
}

function offlineMessage(status: OfflineAudioStatus): string {
  if (!status.supported) return 'このブラウザではオフライン保存を利用できません。';
  if (!status.enabled) return `オフライン保存は無効です（上限 ${formatMegabytes(OFFLINE_AUDIO_BUDGET_BYTES)}）。`;
  const notes = [
    status.skippedOverBudget > 0 ? `上限を超える${status.skippedOverBudget}件は保存していません` : '',
    status.skippedQuota > 0 ? `端末の空き容量不足で${status.skippedQuota}件を保存していません` : '',
    status.failed > 0 ? `${status.failed}件は取得に失敗しました（次回の更新時に再試行します）` : '',
  ].filter(Boolean);
  return `保存済み ${status.savedCount}件・${formatMegabytes(status.savedBytes)} / 上限 ${formatMegabytes(OFFLINE_AUDIO_BUDGET_BYTES)}${
    notes.length > 0 ? `。${notes.join('。')}` : ''
  }`;
}

/**
 * お気に入り音声のオフライン保存(利用者が明示的に有効化した場合だけ)。
 * @des DES-F012-006 @fun FUN-F012-017
 */
export function renderOfflineAudioPanel(
  manager: OfflineAudioManager,
  favoriteController: FavoriteController,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'offline-audio paper-card';
  section.setAttribute('aria-labelledby', 'offline-audio-title');
  const title = text('h2', 'オフライン再生', 'offline-audio-title');
  title.id = 'offline-audio-title';
  const lead = text(
    'p',
    `お気に入りの台詞の音声を、この端末に最大${formatMegabytes(OFFLINE_AUDIO_BUDGET_BYTES)}まで保存できます。保存した音声は通信がなくても再生でき、お気に入りから外すと削除されます。`,
    'offline-lead',
  );
  const toggle = button('お気に入りの音声を保存する', 'offline-toggle');
  toggle.setAttribute('aria-pressed', 'false');
  const status = text('p', '保存状況を確認しています…', 'offline-status');
  status.setAttribute('aria-live', 'polite');
  let busy = false;
  const paint = (current: OfflineAudioStatus): void => {
    toggle.disabled = !current.supported || busy;
    toggle.setAttribute('aria-pressed', String(current.enabled));
    setSafeText(toggle, current.enabled ? '保存をやめて削除する' : 'お気に入りの音声を保存する');
    setSafeText(status, busy ? '保存しています…' : offlineMessage(current));
  };
  const unsubscribe = manager.subscribe(paint);
  registerCleanup(section, unsubscribe);
  listen(section, toggle, 'click', () => {
    if (busy) return;
    busy = true;
    paint(manager.lastStatus);
    const task = manager.lastStatus.enabled
      ? manager.disable()
      : manager.enable(favoriteController.snapshot.dialogueIds);
    void task.finally(() => {
      busy = false;
      paint(manager.lastStatus);
    });
  });
  void manager.status();
  section.append(title, lead, toggle, status);
  return section;
}
