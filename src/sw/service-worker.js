/*
 * 文豪ずんだもん service worker (F012)
 * @des DES-F012-006 @fun FUN-F012-013
 *
 * build時(scripts/service-worker-build.mjs)に版数とprecache一覧を埋め込み、dist/sw.jsとして出力する。
 * 取得方針:
 * - 画面遷移(navigate): network優先。通信できない時だけ保存済みのapp shellを返す。
 * - assets/(hash付きJS/CSS/画像)とprecache対象: cache優先。
 * - content/*.json: network優先で最新を保存し、通信できない時は保存済みを返す。
 * - artwork/: 保存済みを即時に返しつつ裏で更新する(stale-while-revalidate)。
 * - audio/: 利用者が有効化して保存した音声(bz-audio-v1)だけをcacheから返し、Range要求へ206で応える。
 *   未保存の音声はservice workerで保存せず、通常どおりnetworkから取得する。
 * cache照合はignoreVaryで行う(module scriptのOrigin header等、precache時と要求headerが異なってもhitさせる)。
 * 更新方針: 版数が変わるとinstallで新しいapp shellを保存し、activateで古いbz-shell-*を削除する。
 * classic scriptとして動かすため、moduleのimport/exportは使わない。
 */
'use strict';

const VERSION = '__BZ_SW_VERSION__';
const PRECACHE = JSON.parse('__BZ_PRECACHE_JSON__');
const SHELL_PREFIX = 'bz-shell-';
const SHELL_CACHE = SHELL_PREFIX + VERSION;
const DATA_CACHE = 'bz-data-v1';
const MEDIA_CACHE = 'bz-media-v1';
const AUDIO_CACHE = 'bz-audio-v1';
const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;

function scopedUrl(relative) {
  return SCOPE + relative;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((relative) => new Request(scopedUrl(relative), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

async function cachedAudio(request) {
  const cached = await caches.match(request.url, { cacheName: AUDIO_CACHE, ignoreSearch: true, ignoreVary: true });
  if (!cached) return fetch(request);
  const range = request.headers.get('Range');
  if (!range) return cached;
  const bytes = await cached.arrayBuffer();
  const parsed = parseRange(range, bytes.byteLength);
  if (!parsed) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
  }
  const body = bytes.slice(parsed.start, parsed.end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/wav',
      'Content-Length': String(body.byteLength),
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${bytes.byteLength}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreVary: true });
  return cached || fetch(request);
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName, ignoreVary: true })
      || await caches.match(request, { cacheName: SHELL_CACHE, ignoreVary: true });
    if (cached) return cached;
    throw error;
  }
}

async function navigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const shell = await caches.match(scopedUrl(''), { cacheName: SHELL_CACHE, ignoreSearch: true, ignoreVary: true });
    if (shell) return shell;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request, { cacheName: MEDIA_CACHE, ignoreVary: true });
  const update = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(MEDIA_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
    }
    return response;
  });
  if (cached) {
    update.catch(() => undefined);
    return cached;
  }
  return update;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const relative = url.pathname.slice(SCOPE_PATH.length);
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
  } else if (relative.startsWith('audio/')) {
    event.respondWith(cachedAudio(request));
  } else if (relative.startsWith('assets/') || PRECACHE.includes(relative)) {
    if (relative.startsWith('content/')) event.respondWith(networkFirst(request, DATA_CACHE));
    else event.respondWith(cacheFirst(request));
  } else if (relative.startsWith('content/') && relative.endsWith('.json')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
  } else if (relative.startsWith('artwork/')) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
