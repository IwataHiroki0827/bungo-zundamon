import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBungoZundamon, type ApplicationHandle } from './main';
import { validateCatalogV2 } from './ui/catalog-loader';
import { buildFavoriteShareUrl } from './ui/favorites-transfer';
import { OFFLINE_AUDIO_CACHE, OfflineAudioManager, type CacheStorageLike } from './ui/offline';
import type { AudioPort, UICatalogV2 } from './ui/types';
// @ts-expect-error release-checks.mjsは型宣言を持たないbuild検査script
import { verifyCsp } from '../scripts/release-checks.mjs';
// @ts-expect-error f002-security.mjsは型宣言を持たないbuild検査script
import { scanFavoriteStorageContract } from '../scripts/f002-security.mjs';

const raw = readFileSync(join(process.cwd(), 'public', 'content', 'catalog.json'));
const parsed = validateCatalogV2(JSON.parse(raw.toString('utf8')), raw.byteLength);
if (!parsed.ok) throw new Error('catalog fixture invalid');
const CATALOG: UICatalogV2 = parsed.value;
const BASE = new URL('http://localhost/bungo-zundamon/');

class ScriptedAudio implements AudioPort {
  src = '';
  currentTime = 0;
  preload = '';
  playbackRate = 1;
  defaultPlaybackRate = 1;
  volume = 1;
  readonly listeners = new Map<string, Set<EventListener>>();
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    provider: () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    }),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('IT-F012 結合', () => {
  let handle: ApplicationHandle | undefined;
  let root: HTMLElement;

  beforeEach(() => {
    root = Object.assign(document.createElement('div'), { id: 'app' });
    document.body.replaceChildren(root);
    history.replaceState(null, '', '/bungo-zundamon/#/');
  });

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
  });

  /** @des DES-F012-001 DES-F012-004 @it IT-F012-001 */
  it('IT-F012-001 作者routeで速度設定付きの連続再生を進め、route切替で停止する', async () => {
    const audio = new ScriptedAudio();
    const author = CATALOG.authors[0]!;
    location.hash = `#/authors/${author.slug}`;
    handle = mountBungoZundamon(root, {
      catalog: CATALOG, baseUrl: BASE, audioFactory: () => audio,
      mediaQuery: { matches: true }, storageProvider: memoryStorage().provider, offlineAudio: null,
    });
    const rate = root.querySelector<HTMLSelectElement>('.playback-rate')!;
    rate.value = '1.5';
    rate.dispatchEvent(new Event('change'));
    const panel = root.querySelector<HTMLDetailsElement>('.work-panel')!;
    panel.open = true;
    panel.querySelector<HTMLButtonElement>('.sequence-button')!.click();
    await flush();
    const cards = panel.querySelectorAll<HTMLElement>('.dialogue-card');
    expect(cards[0]!.dataset.playerState).toBe('playing');
    expect(audio.playbackRate).toBe(1.5);
    audio.emit('ended');
    await flush();
    expect(cards[1]!.dataset.playerState).toBe('playing');
    expect(cards[1]!.querySelector('.dialogue-status')?.textContent).toContain('連続再生 2/');

    location.hash = '#/favorites';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(handle.controller.sequence).toBeNull();
    expect(handle.controller.state.status).toBe('stopped');
    expect(handle.controller.playbackSettings.rate).toBe(1.5);
  });

  /** @des DES-F012-002 @it IT-F012-002 */
  it('IT-F012-002 共有リンクで開くと確認後にだけ取り込み、URLから共有queryを除く', () => {
    const ids = CATALOG.works[2]!.dialogues.slice(0, 2).map((dialogue) => dialogue.dialogueId);
    const shared = new URL(buildFavoriteShareUrl(BASE, ids)!);
    history.replaceState(null, '', `${shared.pathname}${shared.search}${shared.hash}`);
    const storage = memoryStorage();
    handle = mountBungoZundamon(root, {
      catalog: CATALOG, baseUrl: BASE, audioFactory: () => new ScriptedAudio(),
      mediaQuery: { matches: true }, storageProvider: storage.provider, offlineAudio: null,
    });
    expect(location.search).toBe('');
    expect(location.hash).toBe('#/favorites');
    expect(root.querySelector('.share-offer')?.textContent).toContain('2件');
    expect(root.querySelectorAll('.favorite-item')).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('.share-offer .is-primary')!.click();
    expect(root.querySelectorAll('.favorite-item')).toHaveLength(2);
    expect(JSON.parse(storage.values.get('bungo-zundamon:favorites:v1')!).dialogueIds).toEqual(ids);
    location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    location.hash = '#/favorites';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.querySelector('.share-offer')).toBeNull();
  });

  /** @des DES-F012-003 DES-F012-005 @it IT-F012-003 */
  it('IT-F012-003 トップの検索結果と今日の一台詞からお気に入りへ登録できる', () => {
    handle = mountBungoZundamon(root, {
      catalog: CATALOG, baseUrl: BASE, audioFactory: () => new ScriptedAudio(),
      mediaQuery: { matches: true }, storageProvider: memoryStorage().provider, offlineAudio: null,
      now: () => new Date('2026-10-04T00:00:00Z'),
    });
    expect(root.querySelector('.daily-dialogue')?.getAttribute('data-date-key')).toBe('2026-10-04');
    const query = root.querySelector<HTMLInputElement>('.search-query')!;
    query.value = '手袋を買いに';
    query.dispatchEvent(new Event('input'));
    const first = root.querySelector<HTMLElement>('.search-result .dialogue-card')!;
    first.querySelector<HTMLButtonElement>('.favorite-button')!.click();
    expect(handle.favoriteController.snapshot.dialogueIds).toEqual([first.dataset.dialogueId]);
    root.querySelector<HTMLButtonElement>('.daily-dialogue .favorite-button')!.click();
    expect(handle.favoriteController.snapshot.dialogueIds.length).toBeGreaterThanOrEqual(1);
    expect(root.querySelectorAll('.work-panel[open]')).toHaveLength(0);
  });

  /** @des DES-F012-006 @it IT-F012-004 */
  it('IT-F012-004 有効化済みのオフライン保存はお気に入りの増減へ追従する', async () => {
    const stores = new Map<string, Map<string, Response>>();
    const cacheFor = (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (url: string) => store.get(url),
        put: async (url: string, response: Response) => { store.set(url, response); },
        delete: async (url: string) => store.delete(url),
        keys: async () => [...store.keys()].map((url) => ({ url })),
      };
    };
    const caches: CacheStorageLike = {
      open: async (name) => cacheFor(name),
      delete: async (name) => stores.delete(name),
      has: async (name) => stores.has(name),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace('/bungo-zundamon/', '');
      return new Response(new Uint8Array(readFileSync(join(process.cwd(), 'public', ...path.split('/')))));
    });
    const digest = async (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    const manager = new OfflineAudioManager(CATALOG, BASE, { caches, fetcher, digest, storage: undefined });
    location.hash = '#/favorites';
    handle = mountBungoZundamon(root, {
      catalog: CATALOG, baseUrl: BASE, audioFactory: () => new ScriptedAudio(),
      mediaQuery: { matches: true }, storageProvider: memoryStorage().provider, offlineAudio: manager,
    });
    const id = CATALOG.works[0]!.dialogues[0]!.dialogueId;
    handle.favoriteController.toggle(id);
    await vi.waitFor(() => expect(root.querySelector('.offline-status')?.textContent).toContain('無効'));
    expect(fetcher).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('.offline-toggle')!.click();
    await vi.waitFor(() => expect(root.querySelector('.offline-status')?.textContent).toContain('保存済み 1件'));
    expect(root.querySelector('.offline-toggle')?.getAttribute('aria-pressed')).toBe('true');
    handle.favoriteController.toggle(id);
    await vi.waitFor(async () => expect((await manager.status()).savedCount).toBe(0));
    expect([...stores.get(OFFLINE_AUDIO_CACHE)!.keys()].filter((url) => url.endsWith('.wav'))).toEqual([]);
  });

  /** @des DES-F012-008 @it IT-F012-005 */
  it('IT-F012-005 公開CSPはworker-src selfだけを許し、storage契約は追加moduleでも維持される', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(verifyCsp(html).errors).toEqual([]);
    expect(verifyCsp(html.replace("worker-src 'self'", "worker-src 'none'")).errors).toContain('CSP_DIRECTIVE_INVALID:worker-src');
    const sources: Array<{ path: string; source: string }> = [];
    const walk = (relative: string): void => {
      for (const entry of readdirSync(join(process.cwd(), relative), { withFileTypes: true })) {
        const next = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          sources.push({ path: next, source: readFileSync(join(process.cwd(), next), 'utf8') });
        }
      }
    };
    walk('src');
    expect(scanFavoriteStorageContract(sources)).toMatchObject({ status: 'passed', violations: 0, localStorageCount: 1 });
  });
});
