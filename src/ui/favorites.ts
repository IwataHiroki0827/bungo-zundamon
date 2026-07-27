import type {
  CatalogDialogue,
  DisplayAuthor,
  DisplayAuthorV2,
  DisplayWork,
  DisplayWorkV2,
  UICatalog,
  UICatalogV2,
} from './types';

/** @des DES-F004-009 @fun FUN-F004-025 FUN-F004-026 */
export const FAVORITE_STORAGE_KEY = 'bungo-zundamon:favorites:v1';
export const FAVORITE_RAW_MAX_CODE_UNITS = 262_144;
export const FAVORITE_ID_MAX_CODE_UNITS = 128;
export const FAVORITE_MAX_IDS = 5_000;

const FAVORITE_ID = /^[A-Za-z0-9._~-]+$/u;

export interface FavoriteStoreV1 {
  readonly version: 1;
  readonly dialogueIds: readonly string[];
}

export type FavoriteLoadReason =
  | 'empty'
  | 'valid'
  | 'normalized'
  | 'raw-too-large'
  | 'malformed'
  | 'schema-invalid';

export interface FavoriteLoadResult {
  readonly store: FavoriteStoreV1;
  readonly rewriteRequired: boolean;
  readonly reason: FavoriteLoadReason;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Browser storage access is intentionally confined to this module. */
export function browserFavoriteStorageProvider(): StorageLike {
  return window.localStorage;
}

export type FavoritePersistenceMode = 'local-storage' | 'memory';

export interface FavoritePersistence {
  readonly initial: FavoriteLoadResult;
  readonly mode: FavoritePersistenceMode;
  save(store: FavoriteStoreV1): FavoritePersistenceMode;
}

export interface FavoriteTransition {
  readonly store: FavoriteStoreV1;
  readonly changed: boolean;
  readonly control: Readonly<{
    ariaPressed: 'true' | 'false';
    label: 'お気に入りに追加' | 'お気に入りから削除';
    className: 'favorite-button is-favorite' | 'favorite-button';
  }>;
}

export interface FavoriteSnapshot extends FavoriteStoreV1 {
  readonly persistence: FavoritePersistenceMode;
  readonly message: string | null;
}

export type FavoriteListener = (snapshot: FavoriteSnapshot) => void;

export interface FavoriteController {
  readonly snapshot: FavoriteSnapshot;
  toggle(dialogueId: string): FavoriteSnapshot;
  subscribe(listener: FavoriteListener): () => void;
  dispose(): void;
}

export interface FavoriteDialogueView {
  readonly author: DisplayAuthor | DisplayAuthorV2;
  readonly work: DisplayWork | DisplayWorkV2;
  readonly dialogue: CatalogDialogue;
  readonly audio: UICatalog['audioAssets'][number] | UICatalogV2['audioAssets'][number];
}

export interface FavoriteNavigationIntent {
  readonly authorId: string;
  readonly workId: string;
  readonly dialogueId: string;
  readonly activationId: string;
}

export interface FavoriteNavigation {
  activate(dialogueId: string): FavoriteNavigationIntent | null;
  consume(authorId: string): FavoriteNavigationIntent | null;
  clear(): void;
}

interface CatalogDialogueEntry {
  readonly author: DisplayAuthor | DisplayAuthorV2;
  readonly work: DisplayWork | DisplayWorkV2;
  readonly dialogue: CatalogDialogue;
  readonly audio: UICatalog['audioAssets'][number] | UICatalogV2['audioAssets'][number];
  readonly authorId: string;
  readonly authorSlug: string;
}

function emptyStore(): FavoriteStoreV1 {
  return Object.freeze({ version: 1 as const, dialogueIds: Object.freeze([] as string[]) });
}

function freezeStore(dialogueIds: readonly string[]): FavoriteStoreV1 {
  return Object.freeze({
    version: 1 as const,
    dialogueIds: Object.freeze([...dialogueIds]),
  });
}

function isCatalogV2(catalog: UICatalog | UICatalogV2): catalog is UICatalogV2 {
  return catalog.schemaVersion === '2.0.0' && 'authors' in catalog && Array.isArray(catalog.authors);
}

/** Existing Catalog ID syntax intersected with the favorite-specific 128 code-unit limit. */
export function isFavoriteDialogueId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= FAVORITE_ID_MAX_CODE_UNITS &&
    FAVORITE_ID.test(value);
}

function catalogEntries(catalog: UICatalog | UICatalogV2): readonly CatalogDialogueEntry[] {
  const audioById = new Map<string, Array<UICatalog['audioAssets'][number] | UICatalogV2['audioAssets'][number]>>();
  for (const audio of catalog.audioAssets) {
    const prior = audioById.get(audio.audioId) ?? [];
    prior.push(audio);
    audioById.set(audio.audioId, prior);
  }
  const entries: CatalogDialogueEntry[] = [];
  const dialogueIds = new Set<string>();
  if (isCatalogV2(catalog)) {
    const authors = new Map(catalog.authors.map((author) => [author.authorId, author]));
    for (const work of catalog.works) {
      const author = authors.get(work.authorId);
      if (!author) throw new TypeError('favorite-catalog-author-reference-invalid');
      for (const dialogue of work.dialogues) {
        const assets = audioById.get(dialogue.audioId);
        if (!isFavoriteDialogueId(dialogue.dialogueId) || dialogueIds.has(dialogue.dialogueId) ||
          dialogue.workId !== work.workId || assets?.length !== 1) {
          throw new TypeError('favorite-catalog-dialogue-reference-invalid');
        }
        dialogueIds.add(dialogue.dialogueId);
        entries.push({
          author,
          work,
          dialogue,
          audio: assets[0]!,
          authorId: author.authorId,
          authorSlug: author.slug,
        });
      }
    }
  } else {
    for (const work of catalog.works) {
      for (const dialogue of work.dialogues) {
        const assets = audioById.get(dialogue.audioId);
        if (!isFavoriteDialogueId(dialogue.dialogueId) || dialogueIds.has(dialogue.dialogueId) ||
          assets?.length !== 1) {
          throw new TypeError('favorite-catalog-dialogue-reference-invalid');
        }
        dialogueIds.add(dialogue.dialogueId);
        entries.push({
          author: catalog.author,
          work,
          dialogue,
          audio: assets[0]!,
          authorId: catalog.author.authorId,
          authorSlug: catalog.author.slug,
        });
      }
    }
  }
  return Object.freeze(entries);
}

function normalizeIds(ids: readonly string[], catalog: UICatalog | UICatalogV2): readonly string[] {
  const requested = new Set(ids);
  return Object.freeze(
    catalogEntries(catalog)
      .map((entry) => entry.dialogue.dialogueId)
      .filter((dialogueId) => requested.has(dialogueId)),
  );
}

function canonicalFavoriteJson(store: FavoriteStoreV1): string {
  return JSON.stringify({ version: 1, dialogueIds: [...store.dialogueIds] });
}

/** @des DES-F004-009 @fun FUN-F004-025 @ut UT-F004-025 */
export function parseFavoriteStore(
  raw: string | null,
  catalog: UICatalog | UICatalogV2,
): FavoriteLoadResult {
  if (raw === null) {
    return Object.freeze({ store: emptyStore(), rewriteRequired: false, reason: 'empty' as const });
  }
  if (raw.length > FAVORITE_RAW_MAX_CODE_UNITS) {
    return Object.freeze({ store: emptyStore(), rewriteRequired: true, reason: 'raw-too-large' as const });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return Object.freeze({ store: emptyStore(), rewriteRequired: true, reason: 'malformed' as const });
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== 'dialogueIds\0version'
  ) {
    return Object.freeze({ store: emptyStore(), rewriteRequired: true, reason: 'schema-invalid' as const });
  }
  const candidate = value as { version?: unknown; dialogueIds?: unknown };
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.dialogueIds) ||
    candidate.dialogueIds.length > FAVORITE_MAX_IDS ||
    candidate.dialogueIds.some((dialogueId) => !isFavoriteDialogueId(dialogueId))
  ) {
    return Object.freeze({ store: emptyStore(), rewriteRequired: true, reason: 'schema-invalid' as const });
  }
  const inputIds = candidate.dialogueIds as string[];
  const normalized = normalizeIds(inputIds, catalog);
  const store = freezeStore(normalized);
  const duplicateOrUnknown = normalized.length !== inputIds.length ||
    normalized.some((dialogueId, index) => dialogueId !== inputIds[index]);
  const rewriteRequired = duplicateOrUnknown || raw !== canonicalFavoriteJson(store);
  return Object.freeze({
    store,
    rewriteRequired,
    reason: rewriteRequired ? 'normalized' as const : 'valid' as const,
  });
}

/** @des DES-F004-009 @fun FUN-F004-026 @ut UT-F004-026 */
export function createFavoritePersistence(
  storageProvider: () => StorageLike,
  catalog: UICatalog | UICatalogV2,
): FavoritePersistence {
  let storage: StorageLike | null = null;
  let mode: FavoritePersistenceMode = 'local-storage';
  let initial: FavoriteLoadResult;
  try {
    storage = storageProvider();
    const raw = storage.getItem(FAVORITE_STORAGE_KEY);
    initial = parseFavoriteStore(raw, catalog);
  } catch {
    storage = null;
    mode = 'memory';
    initial = Object.freeze({ store: emptyStore(), rewriteRequired: false, reason: 'empty' as const });
  }

  const save = (store: FavoriteStoreV1): FavoritePersistenceMode => {
    if (!storage || mode === 'memory') return 'memory';
    try {
      if (store.dialogueIds.length === 0) storage.removeItem(FAVORITE_STORAGE_KEY);
      else storage.setItem(FAVORITE_STORAGE_KEY, canonicalFavoriteJson(store));
      return 'local-storage';
    } catch {
      mode = 'memory';
      return 'memory';
    }
  };

  if (initial.rewriteRequired) mode = save(initial.store);
  return {
    get initial() {
      return initial;
    },
    get mode() {
      return mode;
    },
    save,
  };
}

function favoriteControl(active: boolean): FavoriteTransition['control'] {
  return Object.freeze(active
    ? {
        ariaPressed: 'true' as const,
        label: 'お気に入りから削除' as const,
        className: 'favorite-button is-favorite' as const,
      }
    : {
        ariaPressed: 'false' as const,
        label: 'お気に入りに追加' as const,
        className: 'favorite-button' as const,
      });
}

/** @des DES-F004-009 @fun FUN-F004-027 @ut UT-F004-027 */
export function toggleFavorite(
  state: FavoriteStoreV1,
  dialogueId: string,
  catalog: UICatalog | UICatalogV2,
): FavoriteTransition {
  const catalogIds = new Set(catalogEntries(catalog).map((entry) => entry.dialogue.dialogueId));
  const active = state.dialogueIds.includes(dialogueId);
  if (!isFavoriteDialogueId(dialogueId) || !catalogIds.has(dialogueId) ||
    (!active && state.dialogueIds.length >= FAVORITE_MAX_IDS)) {
    return Object.freeze({ store: state, changed: false, control: favoriteControl(active) });
  }
  const requested = active
    ? state.dialogueIds.filter((id) => id !== dialogueId)
    : [...state.dialogueIds, dialogueId];
  const store = freezeStore(normalizeIds(requested, catalog));
  return Object.freeze({
    store,
    changed: true,
    control: favoriteControl(!active),
  });
}

/** @des DES-F004-010 @fun FUN-F004-028 @ut UT-F004-028 */
export function selectFavoriteDialogueViews(
  store: Pick<FavoriteStoreV1, 'dialogueIds'>,
  catalog: UICatalog | UICatalogV2,
): readonly FavoriteDialogueView[] {
  const selected = new Set(store.dialogueIds.filter(isFavoriteDialogueId));
  return Object.freeze(
    catalogEntries(catalog)
      .filter((entry) => selected.has(entry.dialogue.dialogueId))
      .map((entry) => Object.freeze({
        author: entry.author,
        work: entry.work,
        dialogue: entry.dialogue,
        audio: entry.audio,
      })),
  );
}

function snapshot(store: FavoriteStoreV1, persistence: FavoritePersistenceMode): FavoriteSnapshot {
  return Object.freeze({
    version: 1 as const,
    dialogueIds: store.dialogueIds,
    persistence,
    message: persistence === 'memory'
      ? 'お気に入りはこのページを開いている間だけ保持されます。'
      : null,
  });
}

/** @des DES-F004-009 DES-F004-010 @fun FUN-F004-030 @ut UT-F004-030 */
export function createFavoriteController(
  storageProvider: () => StorageLike,
  catalog: UICatalog | UICatalogV2,
): FavoriteController {
  const persistence = createFavoritePersistence(storageProvider, catalog);
  const listeners = new Set<FavoriteListener>();
  let current = snapshot(persistence.initial.store, persistence.mode);
  let disposed = false;
  return {
    get snapshot() {
      return current;
    },
    toggle(dialogueId: string): FavoriteSnapshot {
      if (disposed) return current;
      const transition = toggleFavorite(current, dialogueId, catalog);
      if (!transition.changed) return current;
      const mode = persistence.save(transition.store);
      current = snapshot(transition.store, mode);
      for (const listener of [...listeners]) listener(current);
      return current;
    },
    subscribe(listener: FavoriteListener): () => void {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      current = snapshot(emptyStore(), 'memory');
    },
  };
}

/** @des DES-F004-010 @fun FUN-F004-029 @ut UT-F004-029 */
export function createFavoriteNavigation(
  catalog: UICatalog | UICatalogV2,
  navigate: (hash: string) => void,
): FavoriteNavigation {
  const entries = new Map(catalogEntries(catalog).map((entry) => [entry.dialogue.dialogueId, entry]));
  let pending: FavoriteNavigationIntent | null = null;
  let activation = 0;
  return {
    activate(dialogueId: string): FavoriteNavigationIntent | null {
      const entry = entries.get(dialogueId);
      if (!entry) return null;
      activation += 1;
      pending = Object.freeze({
        authorId: entry.authorId,
        workId: entry.work.workId,
        dialogueId: entry.dialogue.dialogueId,
        activationId: `favorite-activation-${activation}`,
      });
      navigate(`#/authors/${encodeURIComponent(entry.authorSlug)}`);
      return pending;
    },
    consume(authorId: string): FavoriteNavigationIntent | null {
      const intent = pending;
      pending = null;
      return intent?.authorId === authorId ? intent : null;
    },
    clear(): void {
      pending = null;
    },
  };
}
