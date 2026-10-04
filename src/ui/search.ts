import type { CatalogDialogue, DisplayAuthorV2, DisplayWorkV2, UICatalogV2 } from './types';

/** F012 台詞検索。新しいrouteを作らず、トップ画面内で絞り込む。 */
export const SEARCH_RESULT_LIMIT = 30;
export const SEARCH_QUERY_MAX = 64;

export interface DialogueSearchHit {
  readonly author: DisplayAuthorV2;
  readonly work: DisplayWorkV2;
  readonly dialogue: CatalogDialogue;
}

export interface DialogueSearchResult {
  readonly total: number;
  readonly hits: readonly DialogueSearchHit[];
}

/**
 * 検索用の正規化。NFKC・小文字化・カタカナ→ひらがな・空白と括弧類の除去を行う。
 * @des DES-F012-003 @fun FUN-F012-007
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/gu, (character) => String.fromCodePoint(character.codePointAt(0)! - 0x60))
    .replace(/[\s「」『』（）()【】〔〕、。・,.!?！？…―ー~〜]/gu, '');
}

/**
 * Catalog順に台詞・作品名・作者名(表示名/原著者名)へ部分一致する台詞を返す。
 * 空のqueryは作者絞り込みのみとして扱い、作者も未指定なら0件とする。
 * @des DES-F012-003 @fun FUN-F012-007
 */
export function searchDialogues(
  catalog: UICatalogV2,
  query: string,
  authorId = '',
  limit = SEARCH_RESULT_LIMIT,
): DialogueSearchResult {
  const needle = normalizeSearchText(query.slice(0, SEARCH_QUERY_MAX));
  if (needle.length === 0 && authorId === '') return Object.freeze({ total: 0, hits: Object.freeze([]) });
  const hits: DialogueSearchHit[] = [];
  let total = 0;
  for (const entry of searchIndex(catalog)) {
    if (authorId !== '' && entry.hit.work.authorId !== authorId) continue;
    if (needle.length > 0 && !entry.context.includes(needle) && !entry.text.includes(needle)) continue;
    total += 1;
    if (hits.length < limit) hits.push(entry.hit);
  }
  return Object.freeze({ total, hits: Object.freeze(hits) });
}

interface SearchIndexEntry {
  readonly hit: DialogueSearchHit;
  readonly context: string;
  readonly text: string;
}

const INDEXES = new WeakMap<UICatalogV2, readonly SearchIndexEntry[]>();

/** Catalogごとに正規化済み文字列を1回だけ作る(入力のたびに全件を正規化しない)。 */
function searchIndex(catalog: UICatalogV2): readonly SearchIndexEntry[] {
  const cached = INDEXES.get(catalog);
  if (cached) return cached;
  const authors = new Map(catalog.authors.map((author) => [author.authorId, author]));
  const entries: SearchIndexEntry[] = [];
  for (const work of catalog.works) {
    const author = authors.get(work.authorId);
    if (!author) continue;
    const context = normalizeSearchText(`${work.title}${author.name}${author.originalName}`);
    for (const dialogue of work.dialogues) {
      entries.push(Object.freeze({
        hit: Object.freeze({ author, work, dialogue }),
        context,
        text: normalizeSearchText(dialogue.displayText),
      }));
    }
  }
  const frozen = Object.freeze(entries);
  INDEXES.set(catalog, frozen);
  return frozen;
}
