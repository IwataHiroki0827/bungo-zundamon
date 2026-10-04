import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  OFFLINE_AUDIO_CACHE,
  OfflineAudioManager,
  registerAppServiceWorker,
  type CacheStorageLike,
} from './offline';
import type { UICatalogV2 } from './types';

const BASE = new URL('https://example.test/bungo-zundamon/');

function bytesFor(id: string, size: number): Uint8Array {
  return new Uint8Array(size).fill(id.charCodeAt(0));
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const AUDIO = {
  a: bytesFor('a', 40),
  b: bytesFor('b', 30),
  c: bytesFor('c', 20),
};

function catalog(): UICatalogV2 {
  const ids = ['a', 'b', 'c'] as const;
  return {
    schemaVersion: '2.0.0',
    authors: [{ authorId: '000001', name: '作者', originalName: '作者', slug: 'author' }],
    works: [{
      workId: 'w1',
      authorId: '000001',
      title: '作品',
      dialogues: ids.map((id, index) => ({ dialogueId: `d-${id}`, workId: 'w1', order: index + 1, audioId: `audio-${id}` })),
    }],
    audioAssets: ids.map((id) => ({
      audioId: `audio-${id}`,
      path: `audio/F001/${id}.wav`,
      bytes: AUDIO[id].byteLength,
      sha256: sha(AUDIO[id]),
    })),
  } as unknown as UICatalogV2;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(url: string): Promise<Response | undefined> { return this.entries.get(url)?.clone(); }
  async put(url: string, response: Response): Promise<void> { this.entries.set(url, response); }
  async delete(url: string): Promise<boolean> { return this.entries.delete(url); }
  async keys(): Promise<{ url: string }[]> { return [...this.entries.keys()].map((url) => ({ url })); }
}

class FakeCaches implements CacheStorageLike {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    const store = this.stores.get(name) ?? new FakeCache();
    this.stores.set(name, store);
    return store;
  }
  async delete(name: string): Promise<boolean> { return this.stores.delete(name); }
  async has(name: string): Promise<boolean> { return this.stores.has(name); }
}

function fetcherFor(overrides: Record<string, Uint8Array | number> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const id = url.match(/\/([abc])\.wav$/u)?.[1] as keyof typeof AUDIO | undefined;
    const override = id ? overrides[id] : undefined;
    if (typeof override === 'number') return new Response(null, { status: override });
    if (!id) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(override ?? AUDIO[id]), { status: 200 });
  });
}

const digest = async (bytes: ArrayBuffer): Promise<string> => sha(new Uint8Array(bytes));

/** @des DES-F012-006 @fun FUN-F012-016 @ut UT-F012-016 */
describe('UT-F012-016 OfflineAudioManager', () => {
  it('明示的に有効化した時だけ保存し、bytes・SHA-256一致を確認する', async () => {
    const caches = new FakeCaches();
    const fetcher = fetcherFor({ b: bytesFor('x', 30) });
    const manager = new OfflineAudioManager(catalog(), BASE, { caches, fetcher, digest, storage: undefined });
    expect(await manager.sync(['d-a'])).toMatchObject({ enabled: false, savedCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(caches.stores.has(OFFLINE_AUDIO_CACHE)).toBe(false);

    const enabled = await manager.enable(['d-a', 'd-b']);
    expect(enabled).toMatchObject({ enabled: true, savedCount: 1, savedBytes: 40, failed: 1 });
    const keys = [...caches.stores.get(OFFLINE_AUDIO_CACHE)!.entries.keys()];
    expect(keys).toContain('https://example.test/bungo-zundamon/audio/F001/a.wav');
    expect(keys).not.toContain('https://example.test/bungo-zundamon/audio/F001/b.wav');
  });

  it('お気に入りから外した音声を削除し、無効化で全削除する', async () => {
    const caches = new FakeCaches();
    const manager = new OfflineAudioManager(catalog(), BASE, { caches, fetcher: fetcherFor(), digest, storage: undefined });
    await manager.enable(['d-a', 'd-c']);
    const synced = await manager.sync(['d-c']);
    expect(synced).toMatchObject({ enabled: true, savedCount: 1, savedBytes: 20 });
    expect(await manager.status()).toMatchObject({ enabled: true, savedCount: 1 });
    expect(await manager.disable()).toMatchObject({ enabled: false, savedCount: 0 });
    expect(caches.stores.has(OFFLINE_AUDIO_CACHE)).toBe(false);
  });

  it('端末の空き容量が足りない音声は保存せず件数を報告する', async () => {
    const caches = new FakeCaches();
    const storage = { estimate: async () => ({ quota: 10_000_045, usage: 0 }) };
    const manager = new OfflineAudioManager(catalog(), BASE, { caches, fetcher: fetcherFor(), digest, storage });
    const status = await manager.enable(['d-a', 'd-b', 'd-c']);
    expect(status).toMatchObject({ savedCount: 1, skippedQuota: 2 });
  });

  it('Cache Storageがない環境では未対応として何もしない', async () => {
    const manager = new OfflineAudioManager(catalog(), BASE, { caches: undefined, fetcher: fetcherFor(), digest });
    expect(manager.supported).toBe(false);
    expect(await manager.enable(['d-a'])).toMatchObject({ supported: false, enabled: false });
  });

  it('購読者へ状態変化を通知する', async () => {
    const manager = new OfflineAudioManager(catalog(), BASE, { caches: new FakeCaches(), fetcher: fetcherFor(), digest, storage: undefined });
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    await manager.enable(['d-a']);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, savedCount: 1 }));
    unsubscribe();
  });
});

/** @des DES-F012-006 @fun FUN-F012-015 @ut UT-F012-015 */
describe('UT-F012-015 service worker登録', () => {
  it('secure contextでbase配下のsw.jsをscope・updateViaCache none付きで登録する', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    expect(await registerAppServiceWorker(BASE, { register }, true)).toBe(true);
    expect(register).toHaveBeenCalledWith('https://example.test/bungo-zundamon/sw.js', {
      scope: '/bungo-zundamon/',
      updateViaCache: 'none',
    });
  });

  it('非secure・未対応・登録失敗では画面を止めずfalseを返す', async () => {
    const register = vi.fn(async () => {
      throw new Error('denied');
    });
    expect(await registerAppServiceWorker(BASE, { register }, false)).toBe(false);
    expect(await registerAppServiceWorker(BASE, undefined, true)).toBe(false);
    expect(await registerAppServiceWorker(BASE, { register }, true)).toBe(false);
  });
});
