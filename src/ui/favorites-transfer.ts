import {
  FAVORITE_MAX_IDS,
  FAVORITE_RAW_MAX_CODE_UNITS,
  isFavoriteDialogueId,
  selectFavoriteDialogueViews,
  type FavoriteStoreV1,
} from './favorites';
import type { UICatalog, UICatalogV2 } from './types';

/**
 * F012 お気に入りの書き出し・取り込み(ファイル/共有URL)。
 * 端末の保存領域へは触れず、検証済みIDだけをFavoriteController.mergeへ渡す。
 * 保存処理はお気に入りmodule(src/ui/favorites.ts)だけが担う(F002静的検査の契約)。
 */
export const FAVORITE_EXPORT_FORMAT = 'bungo-zundamon-favorites' as const;
export const FAVORITE_EXPORT_FILE_NAME = 'bungo-zundamon-favorites.json' as const;
/** 共有URLへ載せる上限。URL長(約13 KB)を抑え、多くの環境で扱える範囲に留める。 */
export const FAVORITE_SHARE_MAX_IDS = 100;
export const FAVORITE_SHARE_PARAM = 'fav' as const;
const SHARE_PREFIX = 'v1:';
const SHARE_RAW_MAX = SHARE_PREFIX.length + FAVORITE_SHARE_MAX_IDS * 129;

export interface FavoriteExportDocument {
  readonly format: typeof FAVORITE_EXPORT_FORMAT;
  readonly version: 1;
  readonly dialogueIds: readonly string[];
}

export type FavoriteImportFailure =
  | 'too-large'
  | 'malformed'
  | 'schema-invalid'
  | 'empty';

export type FavoriteImportResult =
  | { readonly ok: true; readonly dialogueIds: readonly string[]; readonly unknownCount: number }
  | { readonly ok: false; readonly reason: FavoriteImportFailure };

function knownIds(catalog: UICatalog | UICatalogV2, ids: readonly string[]): readonly string[] {
  return selectFavoriteDialogueViews({ dialogueIds: ids }, catalog).map((view) => view.dialogue.dialogueId);
}

function success(ids: readonly string[], catalog: UICatalog | UICatalogV2): FavoriteImportResult {
  const unique = [...new Set(ids)];
  const known = knownIds(catalog, unique);
  if (known.length === 0) return Object.freeze({ ok: false as const, reason: 'empty' as const });
  return Object.freeze({
    ok: true as const,
    dialogueIds: Object.freeze([...known]),
    unknownCount: unique.length - known.length,
  });
}

/** @des DES-F012-002 @fun FUN-F012-003 */
export function buildFavoriteExport(store: Pick<FavoriteStoreV1, 'dialogueIds'>): string {
  const document: FavoriteExportDocument = {
    format: FAVORITE_EXPORT_FORMAT,
    version: 1,
    dialogueIds: [...store.dialogueIds].filter(isFavoriteDialogueId),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * 書き出しファイルをexact schemaで検証する。未知key・型違い・上限超過は全体を拒否し、
 * Catalogに存在しないIDだけを件数として除外する。
 * @des DES-F012-002 @fun FUN-F012-003
 */
export function parseFavoriteImport(raw: string, catalog: UICatalog | UICatalogV2): FavoriteImportResult {
  if (typeof raw !== 'string' || raw.length > FAVORITE_RAW_MAX_CODE_UNITS) {
    return Object.freeze({ ok: false as const, reason: 'too-large' as const });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    return Object.freeze({ ok: false as const, reason: 'malformed' as const });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== 'dialogueIds,format,version') {
    return Object.freeze({ ok: false as const, reason: 'schema-invalid' as const });
  }
  const candidate = value as { format?: unknown; version?: unknown; dialogueIds?: unknown };
  if (
    candidate.format !== FAVORITE_EXPORT_FORMAT ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.dialogueIds) ||
    candidate.dialogueIds.length > FAVORITE_MAX_IDS ||
    !candidate.dialogueIds.every(isFavoriteDialogueId)
  ) {
    return Object.freeze({ ok: false as const, reason: 'schema-invalid' as const });
  }
  return success(candidate.dialogueIds as string[], catalog);
}

/**
 * 共有URLを作る。hash routeは`#/favorites`固定とし、IDはquery(`?fav=v1:...`)へ載せる。
 * 上限を超える場合はnullを返し、ファイル書き出しを案内する。
 * @des DES-F012-002 @fun FUN-F012-004
 */
export function buildFavoriteShareUrl(baseUrl: URL, dialogueIds: readonly string[]): string | null {
  const ids = dialogueIds.filter(isFavoriteDialogueId);
  if (ids.length === 0 || ids.length > FAVORITE_SHARE_MAX_IDS) return null;
  const url = new URL(baseUrl.href);
  url.search = '';
  url.hash = '#/favorites';
  url.searchParams.set(FAVORITE_SHARE_PARAM, `${SHARE_PREFIX}${ids.join(',')}`);
  return url.href;
}

/** @des DES-F012-002 @fun FUN-F012-004 */
export function parseFavoriteShareParam(
  search: string,
  catalog: UICatalog | UICatalogV2,
): FavoriteImportResult | null {
  if (typeof search !== 'string' || search.length === 0 || search.length > SHARE_RAW_MAX * 3 + 16) {
    return search ? Object.freeze({ ok: false as const, reason: 'too-large' as const }) : null;
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return Object.freeze({ ok: false as const, reason: 'malformed' as const });
  }
  const values = params.getAll(FAVORITE_SHARE_PARAM);
  if (values.length === 0) return null;
  const raw = values[0]!;
  if (values.length !== 1 || raw.length > SHARE_RAW_MAX || !raw.startsWith(SHARE_PREFIX)) {
    return Object.freeze({ ok: false as const, reason: 'schema-invalid' as const });
  }
  const ids = raw.slice(SHARE_PREFIX.length).split(',');
  if (ids.length > FAVORITE_SHARE_MAX_IDS || !ids.every(isFavoriteDialogueId)) {
    return Object.freeze({ ok: false as const, reason: 'schema-invalid' as const });
  }
  return success(ids, catalog);
}

/** 共有queryだけを取り除いたURL(履歴置換用)。 @des DES-F012-002 @fun FUN-F012-004 */
export function withoutFavoriteShareParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(FAVORITE_SHARE_PARAM);
  return url.href;
}
