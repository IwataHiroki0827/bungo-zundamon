import { WORK_NOTICE_TEXT } from '../notices/work-notice-text';
import { AudioController } from './audio-controller';
import { resolvePublicAsset, resolvePublicAssetV2 } from './catalog-loader';
import {
  selectFavoriteDialogueViews,
  type FavoriteController,
  type FavoriteNavigation,
  type FavoriteSnapshot,
} from './favorites';
import { observeAudioLazyLoading } from './lazy-loading';
import { hasUnsafeTextControl } from './text-safety';
import type {
  CatalogDialogue,
  DisplayAuthor,
  DisplayAuthorV2,
  DisplayWork,
  DisplayWorkV2,
  MotionMode,
  PlayerState,
  Route,
  UICatalog,
  UICatalogV2,
} from './types';

const CLEANUP = new WeakMap<Node, () => void>();
const AFTER_MOUNT = new WeakMap<Node, () => void>();

export type UIRenderErrorCode =
  | 'UI_AUTHOR_REFERENCE_INVALID'
  | 'UI_AUTHOR_NOT_FOUND'
  | 'UI_WORK_AUTHOR_MISMATCH'
  | 'UI_DIALOGUE_REFERENCE_INVALID';

export class UIRenderError extends Error {
  constructor(public readonly code: UIRenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UIRenderError';
  }
}

interface RenderChromeContext {
  readonly controller: AudioController;
  readonly favoriteController: FavoriteController;
  readonly favoriteNavigation: FavoriteNavigation;
  readonly baseUrl: URL;
  readonly motion: MotionMode;
  readonly motionLockedByOs: boolean;
  readonly onMotionToggle: () => void;
}

export interface RenderContext<CatalogType extends UICatalog | UICatalogV2 = UICatalogV2> extends RenderChromeContext {
  readonly creditsRenderer?: (catalog: CatalogType) => HTMLElement;
}

/** @des DES-F001-013 @fun FUN-F001-027 */
export function setSafeText(element: HTMLElement, value: string): void {
  if (hasUnsafeTextControl(value) || Array.from(value).length > 32_768) {
    throw new TypeError('unsafe-display-text');
  }
  element.textContent = value;
}

function assertSafeDisplayAttribute(value: string): void {
  if (hasUnsafeTextControl(value) || Array.from(value).length > 32_768) throw new TypeError('unsafe-display-text');
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  setSafeText(element, value);
  return element;
}

function routeLink(
  label: string,
  href: '#/' | '#/authors/akutagawa-zunnosuke' | '#/favorites' | '#/credits',
): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = 'route-link';
  anchor.href = href;
  setSafeText(anchor, label);
  return anchor;
}

function aozoraLink(label: string, href: string): HTMLAnchorElement {
  const url = new URL(href);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.aozora.gr.jp' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !url.pathname.startsWith('/cards/000879/')
  ) {
    throw new TypeError('unsafe-source-link');
  }
  const anchor = document.createElement('a');
  anchor.href = url.href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  setSafeText(anchor, label);
  return anchor;
}

function aozoraLinkV2(label: string, href: string, authorId: string): HTMLAnchorElement {
  let url: URL;
  try {
    url = new URL(href);
  } catch (error) {
    throw new UIRenderError('UI_WORK_AUTHOR_MISMATCH', '作品出典URLを解決できません', { cause: error });
  }
  if (
    !/^\d{6}$/u.test(authorId) ||
    url.protocol !== 'https:' ||
    url.hostname !== 'www.aozora.gr.jp' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !url.pathname.startsWith(`/cards/${authorId}/`) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new UIRenderError('UI_WORK_AUTHOR_MISMATCH', '作品出典URLが作者のcanonical HTTPS範囲外です');
  }
  const anchor = document.createElement('a');
  anchor.href = url.href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  setSafeText(anchor, label);
  return anchor;
}

function artwork(author: DisplayAuthor, baseUrl: URL): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'author-artwork';
  if (author.artwork) {
    const image = document.createElement('img');
    image.src = resolvePublicAsset(baseUrl, author.artwork.path).href;
    image.alt = author.artwork.alt;
    image.loading = 'eager';
    image.decoding = 'async';
    frame.append(image);
    return frame;
  }

  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', '文豪風のずんだもんを表す装飾');
  const monogram = textElement('span', 'ずん', 'author-monogram');
  monogram.setAttribute('aria-hidden', 'true');
  frame.append(monogram);
  return frame;
}

function artworkV2(author: DisplayAuthorV2, baseUrl: URL): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'author-artwork';
  const image = document.createElement('img');
  try {
    assertSafeDisplayAttribute(author.artwork.alt);
    image.src = resolvePublicAssetV2(baseUrl, author.artwork.path).href;
  } catch (error) {
    throw new UIRenderError('UI_AUTHOR_REFERENCE_INVALID', `作者画像を安全に解決できません: ${author.authorId}`, { cause: error });
  }
  image.alt = author.artwork.alt;
  image.loading = 'eager';
  image.decoding = 'async';
  frame.append(image);
  return frame;
}

function authorRouteLink(label: string, slug: string): HTMLAnchorElement {
  assertSafeDisplayAttribute(slug);
  let encodedSlug: string;
  try {
    encodedSlug = encodeURIComponent(slug);
  } catch (error) {
    throw new UIRenderError('UI_AUTHOR_REFERENCE_INVALID', '作者slugをencodeできません', { cause: error });
  }
  const anchor = document.createElement('a');
  anchor.className = 'route-link';
  anchor.href = `#/authors/${encodedSlug}`;
  setSafeText(anchor, label);
  return anchor;
}

function assertAuthorRelations(
  catalog: UICatalogV2,
  errorCode: UIRenderErrorCode,
  dialogueErrorCode: UIRenderErrorCode = errorCode,
): void {
  const authorIds = new Set<string>();
  const workIds = new Set<string>();
  const batchById = new Map(catalog.batches.map((batch) => [batch.batchId, batch]));
  const audioById = new Map<string, UICatalogV2['audioAssets']>();
  for (const asset of catalog.audioAssets) {
    const values = audioById.get(asset.audioId) ?? [];
    audioById.set(asset.audioId, [...values, asset]);
  }
  for (const author of catalog.authors) {
    if (authorIds.has(author.authorId)) throw new UIRenderError(errorCode, `作者IDが重複しています: ${author.authorId}`);
    authorIds.add(author.authorId);
  }
  for (const work of catalog.works) {
    if (workIds.has(work.workId) || !authorIds.has(work.authorId)) {
      throw new UIRenderError(errorCode, `作品の作者参照が不正です: ${work.workId}`);
    }
    workIds.add(work.workId);
    const batch = batchById.get(work.batchId);
    if (!batch || batch.authorId !== work.authorId || !batch.workIds.includes(work.workId)) {
      throw new UIRenderError(errorCode, `作品とbatchの作者参照が一致しません: ${work.workId}`);
    }
    for (const dialogue of work.dialogues) {
      const assets = audioById.get(dialogue.audioId);
      if (dialogue.workId !== work.workId || assets?.length !== 1 || assets[0]!.batchId !== work.batchId) {
        throw new UIRenderError(dialogueErrorCode, `台詞参照が作品と一致しません: ${dialogue.dialogueId}`);
      }
    }
  }
  if (catalog.authors.length === 0 || catalog.authors.some((author) => !catalog.works.some((work) => work.authorId === author.authorId))) {
    throw new UIRenderError(errorCode, '作品を持たない作者があります');
  }
}

function isUICatalogV2(catalog: UICatalog | UICatalogV2): catalog is UICatalogV2 {
  return catalog.schemaVersion === '2.0.0' && 'authors' in catalog && Array.isArray(catalog.authors);
}

function authorCardV2(author: DisplayAuthorV2, works: readonly DisplayWorkV2[], baseUrl: URL): HTMLElement {
  const card = document.createElement('article');
  card.className = 'author-card paper-card';
  card.append(artworkV2(author, baseUrl));
  const copy = document.createElement('div');
  copy.className = 'author-card-copy';
  const dialogueCount = works.reduce((total, work) => total + work.dialogues.length, 0);
  copy.append(
    textElement('p', '青空文庫 × ずんだもん', 'eyebrow'),
    textElement('h2', author.name),
    textElement('p', `原著者: ${author.originalName}`, 'original-author'),
    textElement('p', `${works.length}作品・${dialogueCount}台詞`, 'collection-count'),
    authorRouteLink('作品と台詞を聴く', author.slug),
  );
  card.append(copy);
  return card;
}

/** @des DES-F002-007 DES-F002-013 @fun FUN-F002-022 */
export function renderAuthorIndex(catalog: UICatalogV2, baseUrl = new URL(document.baseURI)): HTMLElement {
  assertAuthorRelations(catalog, 'UI_AUTHOR_REFERENCE_INVALID');
  const page = document.createElement('article');
  page.className = 'home-page page';
  page.dataset.page = 'home';
  page.append(textElement('h1', '文豪ずんだもん'));

  const section = document.createElement('section');
  section.className = 'authors-section';
  section.setAttribute('aria-labelledby', 'authors-v2-title');
  const title = textElement('h2', '作者一覧');
  title.id = 'authors-v2-title';
  const list = document.createElement('ul');
  list.className = 'author-list';
  for (const author of catalog.authors) {
    const item = document.createElement('li');
    item.append(authorCardV2(author, catalog.works.filter((work) => work.authorId === author.authorId), baseUrl));
    list.append(item);
  }
  section.append(title, list);
  page.append(section);
  return page;
}

function authorCard(catalog: UICatalog, baseUrl: URL): HTMLElement {
  const card = document.createElement('article');
  card.className = 'author-card paper-card';
  card.append(artwork(catalog.author, baseUrl));
  const copy = document.createElement('div');
  copy.className = 'author-card-copy';
  copy.append(
    textElement('p', '青空文庫 × ずんだもん', 'eyebrow'),
    textElement('h2', catalog.author.name),
    textElement('p', `原著者：${catalog.author.originalName ?? '芥川龍之介'}`, 'original-author'),
    textElement('p', `${catalog.works.length}作品・${catalog.candidateCounts.published}の台詞を収録`, 'collection-count'),
    routeLink('作品と台詞を聴く', '#/authors/akutagawa-zunnosuke'),
  );
  card.append(copy);
  return card;
}

/** @des DES-F001-001 DES-F001-010 DES-F001-012 @fun FUN-F001-022 */
export function renderHome(catalog: UICatalog, baseUrl = new URL(document.baseURI)): HTMLElement {
  if (catalog.works.length !== 3) throw new TypeError('catalog-work-count-invalid');
  const page = document.createElement('article');
  page.className = 'home-page page';
  page.dataset.page = 'home';

  const hero = document.createElement('header');
  hero.className = 'hero';
  const titleBlock = document.createElement('div');
  titleBlock.className = 'hero-copy';
  titleBlock.append(
    textElement('p', '声でひらく、日本文学。', 'eyebrow'),
    textElement('h1', '文豪ずんだもん'),
    textElement('p', '名作の口語の台詞を、ずんだもんの声で気軽に味わえる朗読アーカイブです。', 'hero-lead'),
  );
  const seal = textElement('span', '聴', 'hero-seal');
  seal.setAttribute('aria-hidden', 'true');
  hero.append(titleBlock, seal);

  const guide = document.createElement('section');
  guide.className = 'quick-guide';
  guide.setAttribute('aria-labelledby', 'quick-guide-title');
  const guideTitle = textElement('h2', '楽しみ方');
  guideTitle.id = 'quick-guide-title';
  const steps = document.createElement('ol');
  for (const [number, label] of [
    ['一', '作者を選ぶ'],
    ['二', '作品をひらく'],
    ['三', '台詞を再生する'],
  ] as const) {
    const item = document.createElement('li');
    item.append(textElement('span', number, 'step-number'), textElement('span', label));
    steps.append(item);
  }
  guide.append(guideTitle, steps);

  const authors = document.createElement('section');
  authors.className = 'authors-section';
  authors.setAttribute('aria-labelledby', 'authors-title');
  const authorsTitle = textElement('h2', '作者一覧');
  authorsTitle.id = 'authors-title';
  authors.append(authorsTitle, authorCard(catalog, baseUrl));
  page.append(hero, guide, authors);
  return page;
}

function playerLabel(dialogue: CatalogDialogue, state: PlayerState): string {
  if (state.dialogueId !== dialogue.dialogueId) return '再生';
  if (state.status === 'playing' || state.status === 'loading') return '一時停止';
  if (state.status === 'paused') return '再開';
  if (state.status === 'error') return 'もう一度試す';
  return '再生';
}

function playerIcon(dialogue: CatalogDialogue, state: PlayerState): string {
  return state.dialogueId === dialogue.dialogueId && (state.status === 'playing' || state.status === 'loading')
    ? 'Ⅱ'
    : '▶';
}

/** @des DES-F001-009 DES-F001-010 @fun FUN-F001-024 */
export function renderDialogueCard(
  dialogue: CatalogDialogue,
  controller: AudioController,
  sourceLink?: HTMLAnchorElement,
  favoriteController?: FavoriteController,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'dialogue-card';
  card.dataset.dialogueId = dialogue.dialogueId;

  const quote = document.createElement('blockquote');
  quote.append(textElement('p', dialogue.displayText));

  const actions = document.createElement('div');
  actions.className = 'dialogue-actions';
  const play = document.createElement('button');
  play.className = 'play-button';
  play.type = 'button';
  play.dataset.dialogueId = dialogue.dialogueId;
  const icon = textElement('span', '▶', 'play-icon');
  icon.setAttribute('aria-hidden', 'true');
  const label = textElement('span', '再生', 'play-label');
  play.append(icon, label);

  const stop = document.createElement('button');
  stop.className = 'stop-button';
  stop.type = 'button';
  stop.dataset.dialogueId = dialogue.dialogueId;
  setSafeText(stop, '停止');
  stop.disabled = true;

  let unsubscribeFavorite = (): void => undefined;
  let onFavorite = (): void => undefined;
  if (favoriteController) {
    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.dataset.dialogueId = dialogue.dialogueId;
    const updateFavorite = (snapshot: FavoriteSnapshot): void => {
      const active = snapshot.dialogueIds.includes(dialogue.dialogueId);
      favorite.className = active ? 'favorite-button is-favorite' : 'favorite-button';
      favorite.setAttribute('aria-pressed', String(active));
      setSafeText(favorite, active ? 'お気に入りから削除' : 'お気に入りに追加');
    };
    onFavorite = () => {
      favoriteController.toggle(dialogue.dialogueId);
    };
    favorite.addEventListener('click', onFavorite);
    unsubscribeFavorite = favoriteController.subscribe(updateFavorite);
    actions.append(play, stop, favorite);
    CLEANUP.set(favorite, () => {
      favorite.removeEventListener('click', onFavorite);
      unsubscribeFavorite();
    });
  } else {
    actions.append(play, stop);
  }

  const status = textElement('p', '再生待ち', 'dialogue-status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const meta = document.createElement('div');
  meta.className = 'dialogue-meta';
  meta.append(textElement('span', `台詞 ${dialogue.order}`));
  if (sourceLink) meta.append(sourceLink);

  const onPlay = (): void => {
    void controller.play(dialogue, play);
  };
  const onStop = (): void => {
    controller.control('stop', dialogue.dialogueId);
  };
  play.addEventListener('click', onPlay);
  stop.addEventListener('click', onStop);

  const unsubscribe = controller.subscribe((state) => {
    const active = state.dialogueId === dialogue.dialogueId;
    const playing = active && state.status === 'playing';
    const busy = active && state.status === 'loading';
    const hasPosition = active && ['playing', 'paused', 'loading'].includes(state.status);
    card.dataset.playerState = active ? state.status : 'idle';
    play.setAttribute('aria-pressed', String(playing || busy));
    play.setAttribute('aria-label', `${playerLabel(dialogue, state)}：${dialogue.displayText}`);
    play.setAttribute('aria-busy', String(busy));
    setSafeText(icon, playerIcon(dialogue, state));
    setSafeText(label, playerLabel(dialogue, state));
    stop.disabled = !hasPosition;
    setSafeText(status, active ? state.message : '再生待ち');
  });

  card.append(quote, actions, status, meta);
  CLEANUP.set(card, () => {
    play.removeEventListener('click', onPlay);
    stop.removeEventListener('click', onStop);
    unsubscribe();
    cleanupRenderedTree(actions);
  });
  return card;
}

function renderWork(
  work: DisplayWork | DisplayWorkV2,
  controller: AudioController,
  authorId?: string,
  favoriteController?: FavoriteController,
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'work-panel paper-card';
  details.dataset.workId = work.workId;
  // ブラウザの履歴復元に委ねず、作者ページを描画するたびに閉じた状態から始める。
  details.open = false;

  const summary = document.createElement('summary');
  const heading = textElement('span', work.title, 'work-title');
  const count = textElement('span', `${work.dialogues.length}台詞`, 'work-count');
  summary.append(heading, count);
  const notices = 'notices' in work && Array.isArray(work.notices) ? work.notices : [];
  for (const notice of notices) {
    if (notice.placements.includes('work-list')) {
      summary.append(textElement(
        'span',
        WORK_NOTICE_TEXT[notice.textKey],
        `work-notice work-notice-${notice.textKey}`,
      ));
    }
  }

  const source = authorId
    ? aozoraLinkV2('青空文庫の図書カード', work.cardLink, authorId)
    : aozoraLink('青空文庫の図書カード', work.cardLink);
  source.className = 'source-link';
  const intro = document.createElement('div');
  intro.className = 'work-intro';
  if (authorId) {
    intro.append(
      textElement('p', `出典: ${work.source.attribution}（${work.source.baseEdition}）`, 'source-attribution'),
      textElement('p', `入力: ${work.source.inputter}・校正: ${work.source.proofreader}`, 'source-contributors'),
    );
  }
  intro.append(source);
  const detailNotices = notices.filter((notice) => notice.placements.includes('work-detail'));
  if (detailNotices.length > 0) {
    const noticeList = document.createElement('ul');
    noticeList.className = 'work-notices work-notices-detail';
    for (const notice of detailNotices) {
      noticeList.append(textElement('li', WORK_NOTICE_TEXT[notice.textKey]));
    }
    intro.append(noticeList);
  }

  const list = document.createElement('ol');
  list.className = 'dialogue-list';
  for (const dialogue of work.dialogues) {
    const item = document.createElement('li');
    const dialogueSource = authorId
      ? aozoraLinkV2('この台詞の作品出典', work.cardLink, authorId)
      : aozoraLink('この台詞の作品出典', work.cardLink);
    dialogueSource.className = 'dialogue-source-link';
    item.append(renderDialogueCard(dialogue, controller, dialogueSource, favoriteController));
    list.append(item);
  }
  details.append(summary, intro, list);
  CLEANUP.set(details, () => cleanupRenderedTree(list));
  return details;
}

/** @des DES-F001-001 DES-F001-002 DES-F001-010 @fun FUN-F001-023 */
export function renderAuthorPage(
  author: DisplayAuthor,
  works: readonly DisplayWork[],
  controller: AudioController,
  baseUrl = new URL(document.baseURI),
  favoriteController?: FavoriteController,
): HTMLElement {
  if (works.length !== 3) throw new TypeError('catalog-work-count-invalid');
  const page = document.createElement('article');
  page.className = 'author-page page';
  page.dataset.page = 'author';

  const header = document.createElement('header');
  header.className = 'author-hero';
  header.append(artwork(author, baseUrl));
  const copy = document.createElement('div');
  copy.append(
    textElement('p', '文豪ずんだもん 第一席', 'eyebrow'),
    textElement('h1', author.name),
    textElement('p', `原著者：${author.originalName ?? '芥川龍之介'}`, 'original-author'),
    textElement('p', '作品名をひらき、気になる台詞の再生ボタンを押してください。', 'author-intro'),
  );
  header.append(copy);

  const worksSection = document.createElement('section');
  worksSection.className = 'works-section';
  worksSection.setAttribute('aria-labelledby', 'works-title');
  const title = textElement('h2', '収録作品');
  title.id = 'works-title';
  const workList = document.createElement('div');
  workList.className = 'work-list';
  works.forEach((work) => workList.append(renderWork(work, controller, undefined, favoriteController)));
  const lazyPlan = observeAudioLazyLoading(Array.from(workList.querySelectorAll<HTMLElement>('.dialogue-card')));
  worksSection.append(title, workList);
  page.append(header, worksSection);
  CLEANUP.set(page, () => {
    lazyPlan.disconnect();
    cleanupRenderedTree(workList);
  });
  return page;
}

/** @des DES-F002-007 DES-F002-008 DES-F002-013 @fun FUN-F002-023 */
export function renderAuthorPageV2(
  authorId: string,
  catalog: UICatalogV2,
  controller: AudioController,
  baseUrl = new URL(document.baseURI),
  favoriteController?: FavoriteController,
  favoriteNavigation?: FavoriteNavigation,
): HTMLElement {
  const matchingAuthors = catalog.authors.filter((author) => author.authorId === authorId);
  if (matchingAuthors.length !== 1) throw new UIRenderError('UI_AUTHOR_NOT_FOUND', `作者を一意に解決できません: ${authorId}`);
  assertAuthorRelations(catalog, 'UI_WORK_AUTHOR_MISMATCH', 'UI_DIALOGUE_REFERENCE_INVALID');
  const author = matchingAuthors[0]!;
  const works = catalog.works.filter((work) => work.authorId === authorId);
  if (works.length === 0) throw new UIRenderError('UI_WORK_AUTHOR_MISMATCH', `作者に公開作品がありません: ${authorId}`);
  for (const work of works) {
    for (const dialogue of work.dialogues) {
      if (dialogue.workId !== work.workId) {
        throw new UIRenderError('UI_DIALOGUE_REFERENCE_INVALID', `台詞の作品参照が一致しません: ${dialogue.dialogueId}`);
      }
      const assets = catalog.audioAssets.filter((asset) => asset.audioId === dialogue.audioId);
      if (assets.length !== 1 || assets[0]!.batchId !== work.batchId) {
        throw new UIRenderError('UI_DIALOGUE_REFERENCE_INVALID', `台詞の音声参照が一致しません: ${dialogue.dialogueId}`);
      }
    }
  }

  const page = document.createElement('article');
  page.className = 'author-page page';
  page.dataset.page = 'author';
  page.dataset.authorId = authorId;
  const header = document.createElement('header');
  header.className = 'author-hero';
  header.append(artworkV2(author, baseUrl));
  const copy = document.createElement('div');
  copy.append(
    textElement('p', '文豪ずんだもん', 'eyebrow'),
    textElement('h1', author.name),
    textElement('p', `原著者: ${author.originalName}`, 'original-author'),
    textElement('p', '作品名をひらき、気になる台詞の再生ボタンを押してください。', 'author-intro'),
  );
  header.append(copy);

  let unsubscribeFavoriteStatus = (): void => undefined;
  if (favoriteController) {
    const persistence = textElement('p', '', 'favorite-persistence-status');
    persistence.setAttribute('aria-live', 'polite');
    unsubscribeFavoriteStatus = favoriteController.subscribe((snapshot) => {
      setSafeText(persistence, snapshot.message ?? 'お気に入りはこの端末内に保存されます。');
      persistence.dataset.persistence = snapshot.persistence;
    });
    copy.append(persistence);
  }

  const worksSection = document.createElement('section');
  worksSection.className = 'works-section';
  worksSection.setAttribute('aria-labelledby', 'works-v2-title');
  const title = textElement('h2', '収録作品');
  title.id = 'works-v2-title';
  const workList = document.createElement('div');
  workList.className = 'work-list';
  const workReferences = new Map<string, {
    panel: HTMLDetailsElement;
    summary: HTMLElement;
    dialogues: ReadonlyMap<string, HTMLElement>;
  }>();
  works.forEach((work) => {
    const panel = renderWork(work, controller, authorId, favoriteController) as HTMLDetailsElement;
    const dialogueCards = Array.from(panel.querySelectorAll<HTMLElement>('.dialogue-card'));
    workReferences.set(work.workId, {
      panel,
      summary: panel.querySelector<HTMLElement>('summary')!,
      dialogues: new Map(work.dialogues.map((dialogue, index) => [
        dialogue.dialogueId,
        dialogueCards[index]!,
      ])),
    });
    workList.append(panel);
  });
  const lazyPlan = observeAudioLazyLoading(Array.from(workList.querySelectorAll<HTMLElement>('.dialogue-card')));
  worksSection.append(title, workList);
  page.append(header, worksSection);
  CLEANUP.set(page, () => {
    unsubscribeFavoriteStatus();
    lazyPlan.disconnect();
    cleanupRenderedTree(workList);
  });
  const intent = favoriteNavigation?.consume(authorId);
  if (intent) {
    const workReference = workReferences.get(intent.workId);
    const dialogueReference = workReference?.dialogues.get(intent.dialogueId);
    if (workReference && dialogueReference) {
      AFTER_MOUNT.set(page, () => {
        workReference.panel.open = true;
        dialogueReference.tabIndex = -1;
        dialogueReference.focus();
      });
    }
  }
  return page;
}

/** @des DES-F004-010 @fun FUN-F004-029 @ut UT-F004-029 */
export function renderFavoritesRoute(
  catalog: UICatalog | UICatalogV2,
  controller: AudioController,
  favoriteController: FavoriteController,
  navigation: FavoriteNavigation,
): HTMLElement {
  const page = document.createElement('article');
  page.className = 'favorites-page page narrow-page';
  page.dataset.page = 'favorites';
  page.append(
    textElement('p', '端末内コレクション', 'eyebrow'),
    textElement('h1', 'お気に入り'),
  );
  const persistence = textElement('p', '', 'favorite-persistence-status');
  persistence.setAttribute('aria-live', 'polite');
  const content = document.createElement('section');
  content.className = 'favorite-results';
  content.setAttribute('aria-live', 'polite');
  page.append(persistence, content);

  let focusIndex: number | null = null;
  const paint = (snapshot: FavoriteSnapshot): void => {
    setSafeText(
      persistence,
      snapshot.message ?? 'お気に入りはこの端末内だけに保存され、外部へ送信されません。',
    );
    persistence.dataset.persistence = snapshot.persistence;
    cleanupRenderedTree(content);
    const views = selectFavoriteDialogueViews(snapshot, catalog);
    const replacement = document.createDocumentFragment();
    if (views.length === 0) {
      const emptyTitle = textElement('h2', 'お気に入りはまだありません', 'favorite-empty-title');
      emptyTitle.tabIndex = -1;
      replacement.append(
        emptyTitle,
        textElement('p', '作者ページの「お気に入りに追加」ボタンから台詞を登録できます。'),
        textElement('p', '登録内容はこの端末内だけに保存されます。'),
      );
    } else {
      const list = document.createElement('ol');
      list.className = 'favorite-list';
      views.forEach((view, index) => {
        const item = document.createElement('li');
        item.className = 'favorite-item paper-card';
        item.dataset.dialogueId = view.dialogue.dialogueId;
        item.append(
          textElement('h2', view.author.name, 'favorite-author'),
          textElement('h3', view.work.title, 'favorite-work'),
          renderDialogueCard(view.dialogue, controller),
        );
        const actions = document.createElement('div');
        actions.className = 'favorite-route-actions';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'favorite-button is-favorite';
        remove.dataset.dialogueId = view.dialogue.dialogueId;
        remove.setAttribute('aria-pressed', 'true');
        setSafeText(remove, 'お気に入りから削除');
        const openOriginal = document.createElement('a');
        openOriginal.className = 'route-link favorite-original-link';
        openOriginal.href = `#/authors/${encodeURIComponent(view.author.slug)}`;
        setSafeText(openOriginal, '元の作品へ移動');
        const onRemove = (): void => {
          focusIndex = index;
          favoriteController.toggle(view.dialogue.dialogueId);
        };
        const onOpenOriginal = (event: MouseEvent): void => {
          event.preventDefault();
          navigation.activate(view.dialogue.dialogueId);
        };
        remove.addEventListener('click', onRemove);
        openOriginal.addEventListener('click', onOpenOriginal);
        CLEANUP.set(item, () => {
          remove.removeEventListener('click', onRemove);
          openOriginal.removeEventListener('click', onOpenOriginal);
          cleanupRenderedTree(item.querySelector('.dialogue-card'));
        });
        actions.append(remove, openOriginal);
        item.append(actions);
        list.append(item);
      });
      replacement.append(list);
    }
    content.replaceChildren(replacement);
    if (focusIndex !== null && page.isConnected) {
      const controls = Array.from(content.querySelectorAll<HTMLButtonElement>('.favorite-item > .favorite-route-actions > .favorite-button'));
      if (controls.length > 0) controls[Math.min(focusIndex, controls.length - 1)]!.focus();
      else content.querySelector<HTMLElement>('.favorite-empty-title')?.focus();
      focusIndex = null;
    }
  };
  const unsubscribe = favoriteController.subscribe(paint);
  CLEANUP.set(page, () => {
    unsubscribe();
    cleanupRenderedTree(content);
  });
  return page;
}

function renderCreditsFallback(): HTMLElement {
  const page = document.createElement('article');
  page.className = 'credits-page page narrow-page';
  page.dataset.page = 'credits';
  page.append(
    textElement('p', 'このサイトについて', 'eyebrow'),
    textElement('h1', 'クレジット・利用条件'),
    textElement('p', 'VOICEVOX:ずんだもん'),
    textElement('p', '東北ずん子・ずんだもんプロジェクトの非公式ファンサイトです'),
    textElement('p', '作品の出典・素材・利用条件の詳細を公開データとともに表示します。'),
  );
  return page;
}

function renderNotFound(): HTMLElement {
  const page = document.createElement('article');
  page.className = 'not-found-page page narrow-page';
  page.dataset.page = 'not-found';
  page.append(
    textElement('p', '404', 'error-code'),
    textElement('h1', 'ページが見つかりません'),
    textElement('p', '指定された場所は、このサイトのページではありません。'),
    routeLink('トップへ戻る', '#/'),
  );
  return page;
}

function siteHeader(route: Route, context: RenderChromeContext, fallbackAuthorSlug: string): HTMLElement {
  const header = document.createElement('header');
  header.className = 'site-header';
  const brand = routeLink('文豪ずんだもん', '#/');
  brand.classList.add('site-brand');
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'メインナビゲーション');
  const authorSlug = route.kind === 'author' ? route.slug : fallbackAuthorSlug;
  const links = [
    routeLink('トップ', '#/'),
    authorRouteLink('作者', authorSlug),
    routeLink('お気に入り', '#/favorites'),
    routeLink('クレジット', '#/credits'),
  ];
  const currentHref = route.kind === 'author'
    ? `#/authors/${encodeURIComponent(route.slug)}`
    : route.kind === 'favorites' ? '#/favorites'
      : route.kind === 'credits' ? '#/credits' : '#/';
  for (const link of links) if (link.getAttribute('href') === currentHref) link.setAttribute('aria-current', 'page');
  nav.append(...links);

  const motion = document.createElement('button');
  motion.className = 'motion-toggle';
  motion.type = 'button';
  motion.setAttribute('aria-pressed', String(context.motion === 'reduced'));
  motion.dataset.motionState = context.motion;
  const motionLabel = textElement(
    'span',
    context.motion === 'reduced' ? '演出：控えめ' : '演出：標準',
    'motion-label',
  );
  const motionDetail = textElement(
    'span',
    context.motionLockedByOs
      ? '端末設定により動きを停止中'
      : context.motion === 'reduced'
        ? 'ページ切替と再生アイコンの動きを停止中'
        : 'ページ切替と再生アイコンが動きます',
    'motion-detail',
  );
  motion.append(motionLabel, motionDetail);
  if (context.motionLockedByOs) {
    motion.disabled = true;
    motion.setAttribute('aria-label', '端末設定により演出を控えめにしています');
  } else {
    motion.setAttribute(
      'aria-label',
      context.motion === 'reduced' ? '演出を標準に戻す' : '演出を控えめにする',
    );
    motion.addEventListener('click', context.onMotionToggle);
    CLEANUP.set(motion, () => motion.removeEventListener('click', context.onMotionToggle));
  }

  header.append(brand, nav, motion);
  return header;
}

function siteFooter(): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.append(
    textElement('p', 'VOICEVOX:ずんだもん'),
    textElement('p', '東北ずん子・ずんだもんプロジェクトの非公式ファンサイトです'),
    routeLink('クレジットと利用条件', '#/credits'),
  );
  return footer;
}

/** @des DES-F001-001 DES-F001-010 @fun FUN-F001-002 */
export function renderRoute(
  root: HTMLElement,
  route: Route,
  catalog: UICatalogV2,
  context: RenderContext<UICatalogV2>,
): void;
export function renderRoute(
  root: HTMLElement,
  route: Route,
  catalog: UICatalog,
  context: RenderContext<UICatalog>,
): void;
export function renderRoute(
  root: HTMLElement,
  route: Route,
  catalog: UICatalog | UICatalogV2,
  context: RenderContext<UICatalog | UICatalogV2>,
): void;
export function renderRoute(
  root: HTMLElement,
  route: Route,
  catalog: UICatalog | UICatalogV2,
  context: RenderContext<UICatalog> | RenderContext<UICatalogV2>,
): void {
  cleanupRenderedTree(root);
  root.dataset.motion = context.motion;
  root.setAttribute('aria-busy', 'false');

  const v2 = isUICatalogV2(catalog);
  const fallbackAuthorSlug = v2 ? catalog.authors[0]?.slug ?? '' : catalog.author.slug;
  const skip = route.kind === 'author'
    ? authorRouteLink('本文へ移動', route.slug)
    : routeLink('本文へ移動', '#/');
  skip.className = 'skip-link';
  skip.addEventListener('click', () => root.querySelector<HTMLElement>('.page h1')?.focus());

  let page: HTMLElement;
  try {
    if (v2) {
      if (route.kind === 'home') page = renderAuthorIndex(catalog, context.baseUrl);
      else if (route.kind === 'author') {
        if (!('authorId' in route) || typeof route.authorId !== 'string') {
          throw new UIRenderError('UI_AUTHOR_NOT_FOUND', 'author routeが解決済みではありません');
        }
        page = renderAuthorPageV2(
          route.authorId,
          catalog,
          context.controller,
          context.baseUrl,
          context.favoriteController,
          context.favoriteNavigation,
        );
      } else if (route.kind === 'favorites') {
        page = renderFavoritesRoute(
          catalog,
          context.controller,
          context.favoriteController,
          context.favoriteNavigation,
        );
      } else if (route.kind === 'credits') {
        page = (context as RenderContext<UICatalogV2>).creditsRenderer?.(catalog) ?? renderCreditsFallback();
      } else page = renderNotFound();
    } else if (route.kind === 'home') page = renderHome(catalog, context.baseUrl);
    else if (route.kind === 'author') {
      page = renderAuthorPage(
        catalog.author,
        catalog.works,
        context.controller,
        context.baseUrl,
        context.favoriteController,
      );
    } else if (route.kind === 'favorites') {
      page = renderFavoritesRoute(
        catalog,
        context.controller,
        context.favoriteController,
        context.favoriteNavigation,
      );
    }
    else if (route.kind === 'credits') {
      page = (context as RenderContext<UICatalog>).creditsRenderer?.(catalog) ?? renderCreditsFallback();
    } else page = renderNotFound();
  } catch {
    page = document.createElement('article');
    page.className = 'page narrow-page page-error';
    page.append(
      textElement('h1', '表示できませんでした'),
      textElement('p', '公開データを確認できませんでした。トップからもう一度お試しください。'),
      routeLink('トップへ戻る', '#/'),
    );
  }

  const heading = page.querySelector<HTMLElement>('h1');
  if (heading) heading.tabIndex = -1;
  root.replaceChildren(skip, siteHeader(route, context, fallbackAuthorSlug), page, siteFooter());
  AFTER_MOUNT.get(page)?.();
  AFTER_MOUNT.delete(page);
  CLEANUP.set(root, () => {
    cleanupRenderedTree(page);
    cleanupRenderedTree(root.querySelector('.site-header'));
  });
}

export function cleanupRenderedTree(root: Node | null): void {
  if (!root) return;
  for (const child of Array.from(root.childNodes)) cleanupRenderedTree(child);
  CLEANUP.get(root)?.();
  CLEANUP.delete(root);
}
