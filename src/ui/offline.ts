import { resolvePublicAssetV2 } from './catalog-loader';
import { selectFavoriteDialogueViews } from './favorites';
import type { UICatalog, UICatalogV2 } from './types';

/**
 * F012 オフライン対応(画面側)。
 * - service worker(`sw.js`)の登録
 * - 利用者が明示的に有効化した場合だけ、お気に入り台詞の音声を容量上限内でCache Storageへ保存
 * Cache名・marker・上限はservice worker側(src/sw/service-worker.js)と共有する固定値。
 */
export const OFFLINE_AUDIO_CACHE = 'bz-audio-v1';
/** お気に入り音声の保存上限(decimal byte)。 */
export const OFFLINE_AUDIO_BUDGET_BYTES = 50_000_000;
/** 端末の空き容量に対して残す余白。 */
export const OFFLINE_QUOTA_MARGIN_BYTES = 10_000_000;
export const OFFLINE_OPT_IN_MARKER = '__offline-audio-opt-in';

export interface OfflineAudioAsset {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface OfflineAudioPlan {
  readonly assets: readonly OfflineAudioAsset[];
  readonly totalBytes: number;
  readonly skippedOverBudget: number;
}

export interface OfflineAudioStatus {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly savedCount: number;
  readonly savedBytes: number;
  readonly skippedOverBudget: number;
  readonly skippedQuota: number;
  readonly failed: number;
}

interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<readonly { readonly url: string }[]>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
  has(name: string): Promise<boolean>;
}

export interface StorageEstimateLike {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}

type Digest = (bytes: ArrayBuffer) => Promise<string>;

async function webCryptoSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * お気に入り(Catalog順)から重複のない音声assetを選び、上限内に収まる分だけを計画する。
 * @des DES-F012-006 @fun FUN-F012-016
 */
export function planOfflineAudio(
  dialogueIds: readonly string[],
  catalog: UICatalog | UICatalogV2,
  budgetBytes = OFFLINE_AUDIO_BUDGET_BYTES,
): OfflineAudioPlan {
  const assets: OfflineAudioAsset[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let skippedOverBudget = 0;
  for (const view of selectFavoriteDialogueViews({ dialogueIds }, catalog)) {
    const audio = view.audio as { path: string; bytes?: number; sha256?: string };
    if (seen.has(audio.path)) continue;
    seen.add(audio.path);
    if (!Number.isSafeInteger(audio.bytes) || (audio.bytes as number) <= 0 || typeof audio.sha256 !== 'string') {
      skippedOverBudget += 1;
      continue;
    }
    if (totalBytes + (audio.bytes as number) > budgetBytes) {
      skippedOverBudget += 1;
      continue;
    }
    totalBytes += audio.bytes as number;
    assets.push(Object.freeze({ path: audio.path, bytes: audio.bytes as number, sha256: audio.sha256.toLowerCase() }));
  }
  return Object.freeze({ assets: Object.freeze(assets), totalBytes, skippedOverBudget });
}

/**
 * Pages base配下の`sw.js`を登録する。更新確認はHTTP cacheを経由させない。
 * production build・secure contextだけで動作し、失敗しても画面表示へ影響させない。
 * @des DES-F012-006 @fun FUN-F012-015
 */
export async function registerAppServiceWorker(
  baseUrl: URL,
  container: Pick<ServiceWorkerContainer, 'register'> | undefined =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  secure = typeof isSecureContext === 'boolean' ? isSecureContext : false,
): Promise<boolean> {
  if (!container || !secure) return false;
  try {
    const script = new URL(`${baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`}sw.js`);
    await container.register(script.href, { scope: new URL(baseUrl.href).pathname, updateViaCache: 'none' });
    return true;
  } catch {
    return false;
  }
}

/**
 * お気に入り音声の明示的なオフライン保存を管理する。操作は直列化し、
 * 保存した音声は公開Catalogのbytes・SHA-256と一致したものだけを残す。
 * @des DES-F012-006 @fun FUN-F012-016
 */
export class OfflineAudioManager {
  readonly #catalog: UICatalog | UICatalogV2;
  readonly #base: URL;
  readonly #caches: CacheStorageLike | undefined;
  readonly #fetcher: typeof fetch;
  readonly #digest: Digest;
  readonly #storage: StorageEstimateLike | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #last: OfflineAudioStatus;
  readonly #listeners = new Set<(status: OfflineAudioStatus) => void>();

  constructor(
    catalog: UICatalog | UICatalogV2,
    baseUrl: URL,
    options: {
      readonly caches?: CacheStorageLike;
      readonly fetcher?: typeof fetch;
      readonly digest?: Digest;
      readonly storage?: StorageEstimateLike;
    } = {},
  ) {
    this.#catalog = catalog;
    this.#base = new URL(baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
    this.#caches = 'caches' in options
      ? options.caches
      : (typeof caches !== 'undefined' ? caches as unknown as CacheStorageLike : undefined);
    this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.#digest = options.digest ?? webCryptoSha256;
    this.#storage = 'storage' in options
      ? options.storage
      : (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function'
        ? navigator.storage
        : undefined);
    this.#last = this.#status(false, 0, 0);
  }

  /** 保存状況の変化を購読する。 */
  subscribe(listener: (status: OfflineAudioStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#last);
    return () => this.#listeners.delete(listener);
  }

  #update(status: OfflineAudioStatus): OfflineAudioStatus {
    this.#last = status;
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch {
        // 画面側の例外で保存処理を止めない。
      }
    }
    return status;
  }

  get supported(): boolean {
    return this.#caches !== undefined;
  }

  get lastStatus(): OfflineAudioStatus {
    return this.#last;
  }

  #status(enabled: boolean, savedCount: number, savedBytes: number, extra: Partial<OfflineAudioStatus> = {}): OfflineAudioStatus {
    return Object.freeze({
      supported: this.supported,
      enabled,
      savedCount,
      savedBytes,
      skippedOverBudget: 0,
      skippedQuota: 0,
      failed: 0,
      ...extra,
    });
  }

  #run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #markerUrl(): string {
    // build後の参照検査(new URL("相対path"))で実在fileと誤認されないよう、絶対URLを連結する。
    return new URL(this.#base.href + OFFLINE_OPT_IN_MARKER).href;
  }

  async #enabled(): Promise<boolean> {
    if (!this.#caches || !(await this.#caches.has(OFFLINE_AUDIO_CACHE))) return false;
    const cache = await this.#caches.open(OFFLINE_AUDIO_CACHE);
    return (await cache.match(this.#markerUrl())) !== undefined;
  }

  /** 現在の保存状況を読む。 */
  status(): Promise<OfflineAudioStatus> {
    return this.#run(async () => {
      if (!this.#caches) return this.#update(this.#status(false, 0, 0));
      try {
        if (!(await this.#enabled())) return this.#update(this.#status(false, 0, 0));
        const cache = await this.#caches.open(OFFLINE_AUDIO_CACHE);
        const byUrl = this.#assetsByUrl();
        let savedCount = 0;
        let savedBytes = 0;
        for (const key of await cache.keys()) {
          const asset = byUrl.get(key.url);
          if (asset) {
            savedCount += 1;
            savedBytes += asset.bytes;
          }
        }
        return this.#update(this.#status(true, savedCount, savedBytes, {
          skippedOverBudget: this.#last.skippedOverBudget,
          skippedQuota: this.#last.skippedQuota,
          failed: this.#last.failed,
        }));
      } catch {
        return this.#update(this.#status(false, 0, 0));
      }
    });
  }

  #assetsByUrl(): Map<string, OfflineAudioAsset> {
    const map = new Map<string, OfflineAudioAsset>();
    for (const audio of this.#catalog.audioAssets as ReadonlyArray<{ path: string; bytes?: number; sha256?: string }>) {
      if (!Number.isSafeInteger(audio.bytes) || typeof audio.sha256 !== 'string') continue;
      try {
        map.set(resolvePublicAssetV2(this.#base, audio.path).href, {
          path: audio.path,
          bytes: audio.bytes as number,
          sha256: audio.sha256.toLowerCase(),
        });
      } catch {
        // 不正pathはCatalog検証で既に拒否されるが、保存対象からも除外する。
      }
    }
    return map;
  }

  /** 利用者の明示操作で保存を有効化し、お気に入りの音声を保存する。 */
  enable(dialogueIds: readonly string[]): Promise<OfflineAudioStatus> {
    return this.#run(async () => {
      if (!this.#caches) return this.#update(this.#status(false, 0, 0));
      const cache = await this.#caches.open(OFFLINE_AUDIO_CACHE);
      await cache.put(this.#markerUrl(), new Response('1', { headers: { 'Content-Type': 'text/plain' } }));
      return this.#syncNow(dialogueIds);
    });
  }

  /** 有効時だけ、お気に入りの増減に保存内容を合わせる。 */
  sync(dialogueIds: readonly string[]): Promise<OfflineAudioStatus> {
    return this.#run(async () => {
      if (!this.#caches || !(await this.#enabled())) return this.#update(this.#status(false, 0, 0));
      return this.#syncNow(dialogueIds);
    });
  }

  /** 保存を無効化し、保存済み音声をすべて削除する。 */
  disable(): Promise<OfflineAudioStatus> {
    return this.#run(async () => {
      if (this.#caches) await this.#caches.delete(OFFLINE_AUDIO_CACHE);
      return this.#update(this.#status(false, 0, 0));
    });
  }

  async #syncNow(dialogueIds: readonly string[]): Promise<OfflineAudioStatus> {
    const cache = await this.#caches!.open(OFFLINE_AUDIO_CACHE);
    const plan = planOfflineAudio(dialogueIds, this.#catalog);
    const wanted = new Map(plan.assets.map((asset) => [resolvePublicAssetV2(this.#base, asset.path).href, asset]));
    const marker = this.#markerUrl();
    const present = new Set<string>();
    for (const key of await cache.keys()) {
      if (key.url === marker) continue;
      if (wanted.has(key.url)) present.add(key.url);
      else await cache.delete(key.url);
    }
    let savedCount = present.size;
    let savedBytes = [...present].reduce((total, url) => total + wanted.get(url)!.bytes, 0);
    let skippedQuota = 0;
    let failed = 0;
    let available = Number.POSITIVE_INFINITY;
    try {
      const estimate = await this.#storage?.estimate();
      if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
        available = (estimate.quota as number) - (estimate.usage as number) - OFFLINE_QUOTA_MARGIN_BYTES;
      }
    } catch {
      // estimate未対応時は固定上限(OFFLINE_AUDIO_BUDGET_BYTES)だけで制御する。
    }
    for (const [url, asset] of wanted) {
      if (present.has(url)) continue;
      if (asset.bytes > available) {
        skippedQuota += 1;
        continue;
      }
      try {
        const response = await this.#fetcher(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error('offline-audio-http');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== asset.bytes || await this.#digest(bytes) !== asset.sha256) {
          throw new Error('offline-audio-integrity');
        }
        await cache.put(url, new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.byteLength) },
        }));
        available -= asset.bytes;
        savedCount += 1;
        savedBytes += asset.bytes;
      } catch {
        failed += 1;
      }
    }
    return this.#update(this.#status(true, savedCount, savedBytes, {
      skippedOverBudget: plan.skippedOverBudget,
      skippedQuota,
      failed,
    }));
  }
}

/** 表示用のMB表記(decimal、小数1桁)。 @des DES-F012-006 @fun FUN-F012-017 */
export function formatMegabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1_000_000).toFixed(1)} MB`;
}
