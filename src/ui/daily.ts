import type { CatalogDialogue, DisplayAuthorV2, DisplayWorkV2, UICatalogV2 } from './types';

/** F012「今日の一台詞」。日本時間の日付だけから決定的に1件を選ぶ(外部通信・保存なし)。 */
export interface DailyDialogue {
  readonly dateKey: string;
  readonly author: DisplayAuthorV2;
  readonly work: DisplayWorkV2;
  readonly dialogue: CatalogDialogue;
}

/** @des DES-F012-005 @fun FUN-F012-011 */
export function tokyoDateKey(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('daily-date-invalid');
  // Asia/Tokyoは夏時間がないため、UTC+9の固定offsetで暦日を決める。
  const tokyo = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const month = String(tokyo.getUTCMonth() + 1).padStart(2, '0');
  const day = String(tokyo.getUTCDate()).padStart(2, '0');
  return `${tokyo.getUTCFullYear()}-${month}-${day}`;
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Catalog順の全台詞から、`FNV-1a32("bungo-zundamon:daily:" + YYYY-MM-DD) mod 件数`番目を選ぶ。
 * 同じ日付・同じCatalogなら全端末で同じ台詞になる。
 * @des DES-F012-005 @fun FUN-F012-011
 */
export function selectDailyDialogue(catalog: UICatalogV2, dateKey: string): DailyDialogue | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) throw new TypeError('daily-date-key-invalid');
  const authors = new Map(catalog.authors.map((author) => [author.authorId, author]));
  const entries: Array<Omit<DailyDialogue, 'dateKey'>> = [];
  for (const work of catalog.works) {
    const author = authors.get(work.authorId);
    if (!author) continue;
    for (const dialogue of work.dialogues) entries.push({ author, work, dialogue });
  }
  if (entries.length === 0) return null;
  const picked = entries[fnv1a32(`bungo-zundamon:daily:${dateKey}`) % entries.length]!;
  return Object.freeze({ dateKey, ...picked });
}
