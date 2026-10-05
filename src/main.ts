import './style.css';

import { isValidatedLicenseManifest, loadReleaseNoticeBundle, renderCredits, renderCreditsV2 } from './notices';
import type { ValidatedNoticeBundle } from './notices';
import { AudioController } from './ui/audio-controller';
import { loadCatalog, publicBaseUrl } from './ui/catalog-loader';
import { cleanupRenderedTree, renderRoute, setSafeText } from './ui/render';
import { parseRoute, parseRouteV2, resolveMotionPreference, resolveRoute } from './ui/routes';
import {
  browserFavoriteStorageProvider,
  createFavoriteController,
  createFavoriteNavigation,
  FAVORITE_STORAGE_KEY,
  type FavoriteController,
  type StorageLike,
} from './ui/favorites';
import type { AudioFactory, MotionChoice, Route, UICatalog, UICatalogV2 } from './ui/types';
import { parseFavoriteShareParam, withoutFavoriteShareParam } from './ui/favorites-transfer';
import { OfflineAudioManager, registerAppServiceWorker } from './ui/offline';
import type { ShareOffer } from './ui/render-f012';

export type ApplicationCatalog = UICatalog | UICatalogV2;

export interface ApplicationOptions {
  readonly catalog: ApplicationCatalog;
  readonly baseUrl?: URL;
  readonly audioFactory?: AudioFactory;
  readonly creditsRenderer?: (catalog: ApplicationCatalog) => HTMLElement;
  readonly mediaQuery?: Pick<MediaQueryList, 'matches'>;
  readonly storageProvider?: () => StorageLike;
  /** F012: 今日の一台詞の基準時刻。 */
  readonly now?: () => Date;
  /** F012: お気に入り音声のオフライン保存(nullで無効)。 */
  readonly offlineAudio?: OfflineAudioManager | null;
}

export interface ApplicationHandle {
  readonly controller: AudioController;
  readonly favoriteController: FavoriteController;
  dispose(): void;
}

export type CatalogLoader = (baseUrl: URL, signal?: AbortSignal) => Promise<ApplicationCatalog>;
export type NoticeLoader = (baseUrl: URL, signal?: AbortSignal) => Promise<ValidatedNoticeBundle>;

interface StartupState {
  readonly generation: number;
  readonly abort: AbortController;
  handle?: ApplicationHandle;
}

const STARTUPS = new WeakMap<HTMLElement, StartupState>();

function defaultBaseUrl(): URL {
  return publicBaseUrl(location, import.meta.env.BASE_URL);
}

function isCatalogV2(catalog: ApplicationCatalog): catalog is UICatalogV2 {
  return catalog.schemaVersion === '2.0.0' && 'authors' in catalog && Array.isArray(catalog.authors);
}

function applicationRoute(hash: string, catalog: ApplicationCatalog): Route {
  // parseRouteV2自体は既知構文だけを受理する。ブラウザでbase URLを直接開いた
  // 場合の空hashは、application境界でcanonicalなhome routeへ正規化する。
  const applicationHash = hash === '' || hash === '#' ? '#/' : hash;
  return isCatalogV2(catalog) ? resolveRoute(parseRouteV2(applicationHash), catalog) : parseRoute(hash);
}

interface RouteLifecycleController {
  onRouteChange?: (next: Route) => unknown;
  stop: (reason?: string) => unknown;
}

/** route通知のAudio例外をnavigationへ伝播させず、描画より先に停止を1回だけ試行する。 */
export function notifyRouteChange(controller: RouteLifecycleController, next: Route): void {
  try {
    if (typeof controller.onRouteChange === 'function') controller.onRouteChange(next);
    else controller.stop('route-change');
  } catch {
    // Audio停止失敗は対象controllerが内部診断し、route描画は継続する。
  }
}

/** route変更通知を描画より先に完了させる。 */
export function renderAfterRouteChange(
  controller: RouteLifecycleController,
  next: Route,
  render: () => void,
): void {
  notifyRouteChange(controller, next);
  render();
}

/**
 * 再描画でfocus中の要素が置換された場合、focusがbodyへ落ちて
 * keyboard・支援技術の利用者が現在位置を失わないよう復元する。
 * route変更時は新ページのh1へ、演出切替などの同一route再描画時は演出ボタンへ戻す。
 * 描画側(お気に入りからの遷移など)が既にroot内へfocusを置いた場合は尊重する。
 * @des DES-F001-001 DES-F001-010 @fun FUN-F001-002
 */
export function restoreFocusAfterRepaint(root: HTMLElement, routeChanged: boolean): void {
  const active = root.ownerDocument.activeElement;
  if (active && active !== root.ownerDocument.body && root.contains(active)) return;
  const target = routeChanged
    ? root.querySelector<HTMLElement>('.page h1')
    : root.querySelector<HTMLElement>('.motion-toggle:not(:disabled)');
  target?.focus();
}

/** @des DES-F001-001 DES-F001-009 DES-F001-010 @fun FUN-F001-002 */
export function mountBungoZundamon(root: HTMLElement, options: ApplicationOptions): ApplicationHandle {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const controller = new AudioController(options.catalog, baseUrl, options.audioFactory);
  const favoriteController = createFavoriteController(
    options.storageProvider ?? browserFavoriteStorageProvider,
    options.catalog,
  );
  const favoriteNavigation = createFavoriteNavigation(options.catalog, (hash) => {
    location.hash = hash;
  });
  const media = options.mediaQuery ?? (
    typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: true }
  );
  let sessionChoice: MotionChoice | undefined;
  let disposed = false;
  let initialPaint = true;
  // @des DES-F012-002 @fun FUN-F012-004 共有リンク(?fav=)は起動時に1回だけ読み、履歴からは取り除く。
  let shareOffer: ShareOffer | null = null;
  const shareResult = parseFavoriteShareParam(location.search, options.catalog);
  if (shareResult) {
    shareOffer = { result: shareResult };
    try {
      history.replaceState(history.state, '', withoutFavoriteShareParam(location.href));
    } catch {
      // 履歴を書き換えられない環境でも取り込み確認は表示する。
    }
  }
  // @des DES-F012-006 @fun FUN-F012-016 有効化済みのときだけ、お気に入りの増減に保存音声を追従させる。
  const offlineAudio = options.offlineAudio === undefined
    ? new OfflineAudioManager(options.catalog, baseUrl)
    : options.offlineAudio ?? undefined;
  let offlineReady = false;
  const unsubscribeOffline = offlineAudio
    ? favoriteController.subscribe((snapshot) => {
      if (offlineReady && offlineAudio.lastStatus.enabled) void offlineAudio.sync(snapshot.dialogueIds);
    })
    : () => undefined;
  if (offlineAudio?.supported) {
    void offlineAudio.status().then((status) => {
      offlineReady = true;
      if (!disposed && status.enabled) void offlineAudio.sync(favoriteController.snapshot.dialogueIds);
    });
  }

  root.classList.add('app-root');
  const paint = (routeChanged: boolean): void => {
    if (disposed) return;
    const motion = resolveMotionPreference(media, sessionChoice);
    const route = applicationRoute(location.hash, options.catalog);
    const render = (): void => {
      const context = {
        controller,
        favoriteController,
        favoriteNavigation,
        baseUrl,
        motion,
        motionLockedByOs: media.matches,
        creditsRenderer: options.creditsRenderer,
        now: options.now,
        offlineAudio,
        shareOffer,
        onShareOfferResolved: () => {
          shareOffer = null;
        },
        onMotionToggle: () => {
          sessionChoice = motion === 'reduced' ? 'full' : 'reduced';
          paint(false);
        },
      };
      if (isCatalogV2(options.catalog)) renderRoute(root, route, options.catalog, context);
      else renderRoute(root, route, options.catalog, context);
    };
    if (routeChanged) renderAfterRouteChange(controller as unknown as RouteLifecycleController, route, render);
    else render();
    if (!initialPaint) restoreFocusAfterRepaint(root, routeChanged);
    initialPaint = false;
  };
  const onHashChange = (): void => paint(true);
  // 別タブでお気に入りが変わったら表示中の状態も追従させる(古い表示のまま操作させない)。
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === FAVORITE_STORAGE_KEY) favoriteController.refresh();
  };
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('storage', onStorage);
  paint(true);

  return {
    controller,
    favoriteController,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('storage', onStorage);
      cleanupRenderedTree(root);
      unsubscribeOffline();
      favoriteController.dispose();
      favoriteNavigation.clear();
      controller.dispose();
    },
  };
}

function renderLoading(root: HTMLElement): void {
  root.setAttribute('aria-busy', 'true');
  const panel = document.createElement('section');
  panel.className = 'startup-state';
  const title = document.createElement('h1');
  setSafeText(title, '文豪ずんだもん');
  const message = document.createElement('p');
  setSafeText(message, '作品を準備しています…');
  panel.append(title, message);
  root.replaceChildren(mainLandmark(panel));
}

/** 起動中・起動失敗画面も本文をmain landmarkへ入れる。 @des DES-F001-001 @fun FUN-F001-003 */
function mainLandmark(content: HTMLElement): HTMLElement {
  const main = document.createElement('main');
  main.className = 'site-main';
  main.append(content);
  return main;
}

function renderLoadError(root: HTMLElement, retry: () => void): void {
  root.setAttribute('aria-busy', 'false');
  const panel = document.createElement('section');
  panel.className = 'startup-state page-error';
  panel.setAttribute('aria-live', 'assertive');
  const title = document.createElement('h1');
  setSafeText(title, '作品を読み込めませんでした');
  const message = document.createElement('p');
  setSafeText(message, '公開データを確認できませんでした。通信状態を確認して、もう一度お試しください。');
  const button = document.createElement('button');
  button.type = 'button';
  setSafeText(button, 'もう一度読み込む');
  button.addEventListener('click', retry, { once: true });
  panel.append(title, message, button);
  root.replaceChildren(mainLandmark(panel));
}

/** @des DES-F001-001 DES-F001-002 DES-F001-019 @fun FUN-F001-003 */
export async function startBungoZundamon(
  root: HTMLElement,
  catalogLoader: CatalogLoader = loadCatalog,
  noticeLoader: NoticeLoader = (baseUrl, signal) => loadReleaseNoticeBundle(baseUrl, new Date(), fetch, signal),
): Promise<ApplicationHandle | null> {
  const previous = STARTUPS.get(root);
  previous?.abort.abort();
  previous?.handle?.dispose();
  const baseUrl = defaultBaseUrl();
  const abort = new AbortController();
  const state: StartupState = { generation: (previous?.generation ?? 0) + 1, abort };
  STARTUPS.set(root, state);
  renderLoading(root);
  try {
    const [catalog, notices] = await Promise.all([
      catalogLoader(baseUrl, abort.signal),
      noticeLoader(baseUrl, abort.signal),
    ]);
    if (STARTUPS.get(root) !== state || abort.signal.aborted) return null;
    if (!notices || !isValidatedLicenseManifest(notices.license)) {
      throw new TypeError('notice-bundle-not-validated');
    }
    const mounted = mountBungoZundamon(root, {
      catalog,
      baseUrl,
      creditsRenderer: (creditsCatalog) => (
        isCatalogV2(creditsCatalog)
          ? renderCreditsV2(creditsCatalog, notices)
          : renderCredits(creditsCatalog, notices.license)
      ),
    });
    const handle: ApplicationHandle = {
      controller: mounted.controller,
      favoriteController: mounted.favoriteController,
      dispose: () => {
        abort.abort();
        if (STARTUPS.get(root) === state) STARTUPS.delete(root);
        mounted.dispose();
      },
    };
    state.handle = handle;
    // @des DES-F012-006 @fun FUN-F012-015 production buildだけでservice workerを登録する。
    if (import.meta.env.PROD) void registerAppServiceWorker(baseUrl);
    return handle;
  } catch {
    if (STARTUPS.get(root) !== state || abort.signal.aborted) return null;
    abort.abort();
    renderLoadError(root, () => {
      void startBungoZundamon(root, catalogLoader, noticeLoader);
    });
    return null;
  }
}

const app = document.querySelector<HTMLElement>('#app');
if (app && import.meta.env.MODE !== 'test') void startBungoZundamon(app);
