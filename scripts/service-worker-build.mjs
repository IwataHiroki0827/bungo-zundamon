import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * F012 service worker・web app manifestのbuild補助。
 * @des DES-F012-006 @fun FUN-F012-014
 */
export const SERVICE_WORKER_FILE = 'sw.js';
export const WEB_MANIFEST_FILE = 'manifest.json';
/** 起動に必須の公開data。通信なしでも画面を開けるようinstall時に保存する。 */
export const REQUIRED_CONTENT_FILES = Object.freeze([
  'content/catalog.json',
  'content/licenses.json',
  'content/artwork-provenance.json',
  'content/artwork-provenances.json',
]);

const SAFE_RELATIVE = /^(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/u;

/** 版数とprecache一覧をservice worker sourceへ埋め込む。 */
export function renderServiceWorker(source, version, precache) {
  if (typeof source !== 'string' || !source.includes("'__BZ_SW_VERSION__'") || !source.includes("'__BZ_PRECACHE_JSON__'")) {
    throw new Error('SERVICE_WORKER_TEMPLATE_INVALID');
  }
  if (!/^[a-f0-9]{16,64}$/u.test(version)) throw new Error('SERVICE_WORKER_VERSION_INVALID');
  if (!Array.isArray(precache) || precache.some((entry) => typeof entry !== 'string' || !SAFE_RELATIVE.test(entry) || entry.includes('..'))) {
    throw new Error('SERVICE_WORKER_PRECACHE_INVALID');
  }
  return source
    .replace("'__BZ_SW_VERSION__'", JSON.stringify(version))
    .replace("'__BZ_PRECACHE_JSON__'", JSON.stringify(JSON.stringify([...new Set(precache)].sort())));
}

/** 公開publicDirから起動に必要なcontent fileを列挙する(artwork provenance参照を含む)。 */
export function requiredContentFiles(publicDir) {
  const files = new Set(REQUIRED_CONTENT_FILES);
  try {
    const bundle = JSON.parse(readFileSync(path.join(publicDir, 'content', 'artwork-provenances.json'), 'utf8'));
    for (const entry of Array.isArray(bundle?.artworks) ? bundle.artworks : []) {
      if (typeof entry?.provenanceRef === 'string' && SAFE_RELATIVE.test(entry.provenanceRef) && !entry.provenanceRef.includes('..')) {
        files.add(entry.provenanceRef);
      }
    }
  } catch {
    // bundleがない旧構成ではcatalog・licenses・単一provenanceだけを保存する。
  }
  return [...files].sort();
}

export function buildWebManifest(iconFile) {
  return `${JSON.stringify({
    name: '文豪ずんだもん',
    short_name: '文豪ずんだもん',
    description: '青空文庫の台詞をずんだもん音声で楽しむ非公式ファンサイト',
    lang: 'ja',
    start_url: './#/',
    scope: './',
    display: 'standalone',
    background_color: '#effde0',
    theme_color: '#2fe06b',
    icons: [
      ...(iconFile ? [{ src: `./${iconFile}`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] : []),
      { src: './artwork/akutagawa-zundamon.png', sizes: '1254x1254', type: 'image/png', purpose: 'any' },
    ],
  }, null, 2)}\n`;
}

/** Vite plugin。production buildだけでdist/sw.jsとdist/manifest.jsonを出力する。 */
export function serviceWorkerPlugin({ projectRoot }) {
  let publicDir = path.join(projectRoot, 'public');
  return {
    name: 'bungo-zundamon-service-worker',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir || publicDir;
    },
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const icon = files.find((file) => /^assets\/favicon-[^/]+\.svg$/u.test(file.fileName))?.fileName;
      const manifest = buildWebManifest(icon);
      this.emitFile({ type: 'asset', fileName: WEB_MANIFEST_FILE, source: manifest });
      const content = requiredContentFiles(publicDir);
      const precache = [
        '',
        WEB_MANIFEST_FILE,
        ...files.map((file) => file.fileName).filter((name) => name !== 'index.html' && !name.endsWith('.map')),
        ...content,
      ];
      const hash = createHash('sha256');
      for (const file of [...files].sort((left, right) => left.fileName.localeCompare(right.fileName, 'en'))) {
        hash.update(file.fileName);
        hash.update(file.type === 'chunk' ? file.code : file.source);
      }
      hash.update(manifest);
      for (const relative of content) {
        try {
          hash.update(readFileSync(path.join(publicDir, ...relative.split('/'))));
        } catch {
          hash.update(`missing:${relative}`);
        }
      }
      const version = hash.digest('hex').slice(0, 20);
      const template = readFileSync(path.join(projectRoot, 'src', 'sw', 'service-worker.js'), 'utf8');
      this.emitFile({ type: 'asset', fileName: SERVICE_WORKER_FILE, source: renderServiceWorker(template, version, precache) });
    },
  };
}
