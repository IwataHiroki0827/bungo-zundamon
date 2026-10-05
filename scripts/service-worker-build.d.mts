import type { Plugin } from 'vite';

/** @des DES-F012-006 @fun FUN-F012-014 */
export declare const SERVICE_WORKER_FILE: 'sw.js';
export declare const WEB_MANIFEST_FILE: 'manifest.json';
export declare const REQUIRED_CONTENT_FILES: readonly string[];
export declare function renderServiceWorker(source: string, version: string, precache: readonly string[]): string;
export declare function requiredContentFiles(publicDir: string): string[];
export declare function buildWebManifest(iconFile: string | undefined): string;
export declare function serviceWorkerPlugin(options: { readonly projectRoot: string }): Plugin;
