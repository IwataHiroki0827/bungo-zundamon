/* global Request, Response, setTimeout */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  buildWebManifest,
  renderServiceWorker,
  requiredContentFiles,
} from './service-worker-build.mjs';

const root = path.resolve(import.meta.dirname, '..');
const template = readFileSync(path.join(root, 'src', 'sw', 'service-worker.js'), 'utf8');
const SCOPE = 'https://example.test/bungo-zundamon/';
const PRECACHE = ['', 'assets/index-abc.js', 'content/catalog.json', 'manifest.json'];

class FakeCache {
  constructor() { this.entries = new Map(); }
  async match(request) { return this.entries.get(typeof request === 'string' ? request : request.url)?.clone(); }
  async put(request, response) { this.entries.set(typeof request === 'string' ? request : request.url, response); }
  async addAll(requests) {
    for (const request of requests) this.entries.set(request.url, new Response(`precached:${request.url}`));
  }
}

class FakeCaches {
  constructor() { this.stores = new Map(); }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
  async match(request, options = {}) {
    const url = typeof request === 'string' ? request : request.url;
    const names = options.cacheName ? [options.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(url);
      if (hit) return hit;
    }
    return undefined;
  }
}

function loadWorker({ online = true } = {}) {
  const listeners = new Map();
  const caches = new FakeCaches();
  const network = [];
  const state = { online, skipped: false, claimed: false };
  const self = {
    registration: { scope: SCOPE },
    location: new URL(SCOPE),
    clients: { claim: async () => { state.claimed = true; } },
    skipWaiting: async () => { state.skipped = true; },
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const fetch = async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    network.push(url);
    if (!state.online) throw new TypeError('offline');
    const response = new Response(`network:${url}`, { status: 200 });
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  };
  const source = renderServiceWorker(template, 'a'.repeat(20), PRECACHE);
  vm.runInNewContext(source, { self, caches, fetch, Request, Response, URL, Promise, JSON, Number, Math, String, TypeError });
  const dispatch = async (type, init) => {
    const waits = [];
    let responded;
    const event = {
      ...init,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => { responded = Promise.resolve(promise); },
    };
    listeners.get(type)(event);
    await Promise.all(waits);
    return responded;
  };
  return { caches, network, state, dispatch };
}

function request(url, init = {}) {
  const value = new Request(url, init);
  Object.defineProperty(value, 'mode', { value: init.navigate ? 'navigate' : 'cors' });
  return value;
}

/** @des DES-F012-006 @fun FUN-F012-014 @ut UT-F012-014 */
describe('UT-F012-014 service worker build', () => {
  it('版数とprecache一覧を埋め込み、placeholderを残さない', () => {
    const source = renderServiceWorker(template, 'b'.repeat(20), ['manifest.json', '', 'manifest.json']);
    expect(source).not.toContain('__BZ_SW_VERSION__');
    expect(source).not.toContain('__BZ_PRECACHE_JSON__');
    expect(source).toContain(`"${'b'.repeat(20)}"`);
    expect(source).not.toMatch(/\b(?:import|export)\s/u);
  });

  it('不正な版数・precache pathを拒否する', () => {
    expect(() => renderServiceWorker(template, 'XYZ', [])).toThrow('SERVICE_WORKER_VERSION_INVALID');
    expect(() => renderServiceWorker(template, 'a'.repeat(20), ['../secret'])).toThrow('SERVICE_WORKER_PRECACHE_INVALID');
    expect(() => renderServiceWorker(template, 'a'.repeat(20), ['https://evil.example/x'])).toThrow('SERVICE_WORKER_PRECACHE_INVALID');
    expect(() => renderServiceWorker('const x = 1;', 'a'.repeat(20), [])).toThrow('SERVICE_WORKER_TEMPLATE_INVALID');
  });

  it('起動に必要な公開dataと作者画像provenanceを列挙し、manifestは同一originのiconだけを持つ', () => {
    const files = requiredContentFiles(path.join(root, 'public'));
    expect(files).toEqual(expect.arrayContaining([
      'content/catalog.json',
      'content/licenses.json',
      'content/artwork-provenance.json',
      'content/artwork-provenances.json',
      'content/artwork-provenance/F011.json',
    ]));
    const manifest = JSON.parse(buildWebManifest('assets/favicon-x.svg'));
    expect(manifest).toMatchObject({ start_url: './#/', scope: './', display: 'standalone', lang: 'ja' });
    expect(manifest.icons.every((icon) => icon.src.startsWith('./'))).toBe(true);
  });
});

/** @des DES-F012-006 @fun FUN-F012-013 @ut UT-F012-013 */
describe('UT-F012-013 service worker取得方針', () => {
  it('installでapp shellを保存し、activateで古い版だけを削除する', async () => {
    const worker = loadWorker();
    await (await worker.caches.open('bz-shell-old')).put(`${SCOPE}old.js`, new Response('old'));
    await (await worker.caches.open('bz-audio-v1')).put(`${SCOPE}audio/a.wav`, new Response('a'));
    await worker.dispatch('install', {});
    expect(worker.state.skipped).toBe(true);
    expect([...worker.caches.stores.get(`bz-shell-${'a'.repeat(20)}`).entries.keys()])
      .toEqual(PRECACHE.map((relative) => `${SCOPE}${relative}`));
    await worker.dispatch('activate', {});
    expect(worker.caches.stores.has('bz-shell-old')).toBe(false);
    expect(worker.caches.stores.has('bz-audio-v1')).toBe(true);
    expect(worker.state.claimed).toBe(true);
  });

  it('通信できない画面遷移では保存済みapp shellを返す', async () => {
    const worker = loadWorker();
    await worker.dispatch('install', {});
    expect(await (await worker.dispatch('fetch', { request: request(`${SCOPE}?x=1`, { navigate: true }) })).text())
      .toBe(`network:${SCOPE}?x=1`);
    worker.state.online = false;
    expect(await (await worker.dispatch('fetch', { request: request(SCOPE, { navigate: true }) })).text())
      .toBe(`precached:${SCOPE}`);
  });

  it('content JSONはnetwork優先で保存し、通信できない時は保存済みを返す', async () => {
    const worker = loadWorker();
    const url = `${SCOPE}content/provenance/F001/000127.json`;
    expect(await (await worker.dispatch('fetch', { request: request(url) })).text()).toBe(`network:${url}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.state.online = false;
    expect(await (await worker.dispatch('fetch', { request: request(url) })).text()).toBe(`network:${url}`);
  });

  it('保存済み音声だけをcacheから返し、Rangeへ206で応える。未保存音声は保存しない', async () => {
    const worker = loadWorker();
    const url = `${SCOPE}audio/F001/a.wav`;
    await (await worker.caches.open('bz-audio-v1')).put(url, new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), {
      headers: { 'Content-Type': 'audio/wav' },
    }));
    const partial = await worker.dispatch('fetch', { request: request(url, { headers: { Range: 'bytes=2-3' } }) });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-3/6');
    expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([2, 3]);
    const suffix = await worker.dispatch('fetch', { request: request(url, { headers: { Range: 'bytes=-2' } }) });
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([4, 5]);
    const invalid = await worker.dispatch('fetch', { request: request(url, { headers: { Range: 'bytes=9-' } }) });
    expect(invalid.status).toBe(416);
    expect(worker.network).toEqual([]);

    const other = `${SCOPE}audio/F001/b.wav`;
    expect(await (await worker.dispatch('fetch', { request: request(other) })).text()).toBe(`network:${other}`);
    expect(await worker.caches.match(other)).toBeUndefined();
  });

  it('scope外・別origin・GET以外には応答しない', async () => {
    const worker = loadWorker();
    expect(await worker.dispatch('fetch', { request: request('https://evil.example/bungo-zundamon/app.js') })).toBeUndefined();
    expect(await worker.dispatch('fetch', { request: request('https://example.test/other/app.js') })).toBeUndefined();
    expect(await worker.dispatch('fetch', { request: request(`${SCOPE}content/catalog.json`, { method: 'POST', body: 'x' }) })).toBeUndefined();
  });
});
