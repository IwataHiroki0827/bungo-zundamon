import { AudioController } from './audio-controller';
import { resolvePublicAsset } from './catalog-loader';
import { observeAudioLazyLoading } from './lazy-loading';
import { hasUnsafeTextControl } from './text-safety';
import type {
  CatalogDialogue,
  DisplayAuthor,
  DisplayWork,
  MotionMode,
  PlayerState,
  Route,
  UICatalog,
} from './types';

const CLEANUP = new WeakMap<Node, () => void>();

export interface RenderContext {
  readonly controller: AudioController;
  readonly baseUrl: URL;
  readonly motion: MotionMode;
  readonly motionLockedByOs: boolean;
  readonly onMotionToggle: () => void;
  readonly creditsRenderer?: (catalog: UICatalog) => HTMLElement;
}

/** @des DES-F001-013 @fun FUN-F001-027 */
export function setSafeText(element: HTMLElement, value: string): void {
  if (hasUnsafeTextControl(value) || Array.from(value).length > 32_768) {
    throw new TypeError('unsafe-display-text');
  }
  element.textContent = value;
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

function routeLink(label: string, href: '#/' | '#/authors/akutagawa-zunnosuke' | '#/credits'): HTMLAnchorElement {
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

  const status = textElement('p', '再生待ち', 'dialogue-status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  actions.append(play, stop);

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
  });
  return card;
}

function renderWork(work: DisplayWork, controller: AudioController, expanded: boolean): HTMLElement {
  const details = document.createElement('details');
  details.className = 'work-panel paper-card';
  details.open = expanded;

  const summary = document.createElement('summary');
  const heading = textElement('span', work.title, 'work-title');
  const count = textElement('span', `${work.dialogues.length}台詞`, 'work-count');
  summary.append(heading, count);

  const source = aozoraLink('青空文庫の図書カード', work.cardLink);
  source.className = 'source-link';
  const intro = document.createElement('div');
  intro.className = 'work-intro';
  intro.append(source);

  const list = document.createElement('ol');
  list.className = 'dialogue-list';
  for (const dialogue of work.dialogues) {
    const item = document.createElement('li');
    const dialogueSource = aozoraLink('この台詞の作品出典', work.cardLink);
    dialogueSource.className = 'dialogue-source-link';
    item.append(renderDialogueCard(dialogue, controller, dialogueSource));
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
  works.forEach((work, index) => workList.append(renderWork(work, controller, index === 0)));
  const lazyPlan = observeAudioLazyLoading(Array.from(workList.querySelectorAll<HTMLElement>('.dialogue-card')));
  worksSection.append(title, workList);
  page.append(header, worksSection);
  CLEANUP.set(page, () => {
    lazyPlan.disconnect();
    cleanupRenderedTree(workList);
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

function siteHeader(route: Route, context: RenderContext): HTMLElement {
  const header = document.createElement('header');
  header.className = 'site-header';
  const brand = routeLink('文豪ずんだもん', '#/');
  brand.classList.add('site-brand');
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'メインナビゲーション');
  const links = [
    routeLink('トップ', '#/'),
    routeLink('作者', '#/authors/akutagawa-zunnosuke'),
    routeLink('クレジット', '#/credits'),
  ];
  const currentHref = route.kind === 'author' ? '#/authors/akutagawa-zunnosuke' : route.kind === 'credits' ? '#/credits' : '#/';
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
  catalog: UICatalog,
  context: RenderContext,
): void {
  cleanupRenderedTree(root);
  context.controller.stop();
  root.dataset.motion = context.motion;
  root.setAttribute('aria-busy', 'false');

  const skip = routeLink('本文へ移動', route.kind === 'author' ? '#/authors/akutagawa-zunnosuke' : '#/');
  skip.className = 'skip-link';
  skip.addEventListener('click', () => root.querySelector<HTMLElement>('.page h1')?.focus());

  let page: HTMLElement;
  try {
    if (route.kind === 'home') page = renderHome(catalog, context.baseUrl);
    else if (route.kind === 'author') {
      page = renderAuthorPage(catalog.author, catalog.works, context.controller, context.baseUrl);
    } else if (route.kind === 'credits') {
      page = context.creditsRenderer?.(catalog) ?? renderCreditsFallback();
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
  root.replaceChildren(skip, siteHeader(route, context), page, siteFooter());
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
