import './style.css';

import { isValidatedLicenseManifest, loadReleaseNoticeBundle, renderCredits } from './notices';
import type { ValidatedNoticeBundle } from './notices';
import { AudioController } from './ui/audio-controller';
import { loadCatalog, publicBaseUrl } from './ui/catalog-loader';
import { cleanupRenderedTree, renderRoute, setSafeText } from './ui/render';
import { parseRoute, resolveMotionPreference } from './ui/routes';
import type { AudioFactory, MotionChoice, UICatalog } from './ui/types';

export interface ApplicationOptions {
  readonly catalog: UICatalog;
  readonly baseUrl?: URL;
  readonly audioFactory?: AudioFactory;
  readonly creditsRenderer?: (catalog: UICatalog) => HTMLElement;
  readonly mediaQuery?: Pick<MediaQueryList, 'matches'>;
}

export interface ApplicationHandle {
  readonly controller: AudioController;
  dispose(): void;
}

export type CatalogLoader = (baseUrl: URL, signal?: AbortSignal) => Promise<UICatalog>;
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

/** @des DES-F001-001 DES-F001-009 DES-F001-010 @fun FUN-F001-002 */
export function mountBungoZundamon(root: HTMLElement, options: ApplicationOptions): ApplicationHandle {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const controller = new AudioController(options.catalog, baseUrl, options.audioFactory);
  const media = options.mediaQuery ?? (
    typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: true }
  );
  let sessionChoice: MotionChoice | undefined;
  let disposed = false;

  root.classList.add('app-root');
  const paint = (): void => {
    if (disposed) return;
    const motion = resolveMotionPreference(media, sessionChoice);
    renderRoute(root, parseRoute(location.hash), options.catalog, {
      controller,
      baseUrl,
      motion,
      motionLockedByOs: media.matches,
      creditsRenderer: options.creditsRenderer,
      onMotionToggle: () => {
        sessionChoice = motion === 'reduced' ? 'full' : 'reduced';
        paint();
      },
    });
  };
  const onHashChange = (): void => paint();
  window.addEventListener('hashchange', onHashChange);
  paint();

  return {
    controller,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('hashchange', onHashChange);
      cleanupRenderedTree(root);
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
  root.replaceChildren(panel);
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
  root.replaceChildren(panel);
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
      creditsRenderer: (creditsCatalog) => renderCredits(creditsCatalog, notices.license),
    });
    const handle: ApplicationHandle = {
      controller: mounted.controller,
      dispose: () => {
        abort.abort();
        if (STARTUPS.get(root) === state) STARTUPS.delete(root);
        mounted.dispose();
      },
    };
    state.handle = handle;
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
