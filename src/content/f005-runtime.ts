import type { AudioController } from '../ui/audio-controller.ts';
import {
  FAVORITE_ID_MAX_CODE_UNITS,
  FAVORITE_MAX_IDS,
  FAVORITE_RAW_MAX_CODE_UNITS,
  isFavoriteDialogueId,
  type FavoriteController,
  type FavoriteNavigationIntent,
  type FavoritePersistenceMode,
} from '../ui/favorites.ts';
import type { PlayerState } from '../ui/types.ts';
import {
  isMintedF005Catalog,
  type F005FinalCatalog,
} from './f005-catalog.ts';

const RESERVED_PROPERTY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const ACTIVATION_ID = /^favorite-activation-[1-9][0-9]*$/u;
const PLAYER_STATUS = new Set<PlayerState['status']>([
  'idle',
  'loading',
  'playing',
  'paused',
  'stopped',
  'ended',
  'error',
]);

export type F005RuntimeErrorCode =
  | 'F005_RUNTIME_CATALOG_INVALID'
  | 'F005_RUNTIME_FAVORITE_INVALID'
  | 'F005_RUNTIME_AUDIO_INVALID'
  | 'F005_RUNTIME_NAVIGATION_INVALID';

export class F005RuntimeError extends Error {
  constructor(
    public readonly code: F005RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'F005RuntimeError';
  }
}

export interface RuntimeContentReport {
  readonly schemaVersion: 'f005-runtime-v1';
  readonly favorite: Readonly<{
    dialogueIds: readonly string[];
    persistence: FavoritePersistenceMode;
  }>;
  readonly audio: Readonly<{
    status: PlayerState['status'];
    dialogueId: string | null;
    activeAudioCount: 0 | 1;
  }>;
  readonly navigation: Readonly<
    | {
        kind: 'normal-entry';
        initialOpenPanelCount: 0;
      }
    | {
        kind: 'favorite-one-shot';
        initialOpenPanelCount: 1;
        activationId: string;
        authorId: string;
        workId: string;
        dialogueId: string;
        routeHash: string;
      }
  >;
}

interface JoinedDialogue {
  readonly authorId: string;
  readonly authorSlug: string;
  readonly workId: string;
  readonly dialogueId: string;
}

function ownDataProperty(
  value: object,
  key: string,
  code: F005RuntimeErrorCode,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return runtimeError(code, `${key} descriptorを安全に読めません`);
  }
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
    return runtimeError(code, `${key}はown enumerable data propertyではありません`);
  }
  return descriptor.value;
}

function ownArrayValues(
  value: unknown,
  name: string,
  code: F005RuntimeErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return runtimeError(code, `${name}はplain arrayではありません`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(ownDataProperty(value, String(index), code));
  }
  if (Reflect.ownKeys(value).filter((key) => key !== 'length').length !== value.length) {
    return runtimeError(code, `${name}に余分なpropertyがあります`);
  }
  return result;
}

function runtimeError(code: F005RuntimeErrorCode, message: string): never {
  throw new F005RuntimeError(code, message);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * JSON.parseで生成される通常objectと同じprototypeを要求し、各fieldをgetterを
 * 発火させずに読み取る。Object.freeze後のdata propertyも受理する。
 */
function readPlainDataObject(
  value: unknown,
  exactKeys: readonly string[],
  code: F005RuntimeErrorCode,
): Readonly<Record<string, unknown>> {
  if (!isObject(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return runtimeError(code, 'plain JSON objectではありません');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.some((key) => typeof key !== 'string') ||
    [...actualKeys].sort().join('\0') !== [...exactKeys].sort().join('\0')
  ) {
    return runtimeError(code, 'object schemaが一致しません');
  }
  const result: Record<string, unknown> = {};
  for (const key of exactKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      return runtimeError(code, `${key}はown enumerable data propertyではありません`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readPlainStringArray(
  value: unknown,
  code: F005RuntimeErrorCode,
): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return runtimeError(code, 'ID一覧がplain JSON arrayではありません');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  const actualKeys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (
    actualKeys.some((key) => typeof key !== 'string') ||
    actualKeys.join('\0') !== expectedKeys.join('\0')
  ) {
    return runtimeError(code, 'ID一覧に余分なpropertyまたは欠番があります');
  }
  const result: string[] = [];
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true ||
      typeof descriptor.value !== 'string') {
      return runtimeError(code, 'ID一覧はown string data propertyだけを許可します');
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function isSafeJoinedId(value: unknown): value is string {
  return isFavoriteDialogueId(value) &&
    value.length <= FAVORITE_ID_MAX_CODE_UNITS &&
    !RESERVED_PROPERTY_NAMES.has(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..');
}

function buildJoinedDialogues(catalog: F005FinalCatalog): ReadonlyMap<string, JoinedDialogue> {
  const authorsValue = ownArrayValues(
    ownDataProperty(catalog, 'authors', 'F005_RUNTIME_CATALOG_INVALID'),
    'authors',
    'F005_RUNTIME_CATALOG_INVALID',
  );
  const worksValue = ownArrayValues(
    ownDataProperty(catalog, 'works', 'F005_RUNTIME_CATALOG_INVALID'),
    'works',
    'F005_RUNTIME_CATALOG_INVALID',
  );
  const audioValue = ownArrayValues(
    ownDataProperty(catalog, 'audioAssets', 'F005_RUNTIME_CATALOG_INVALID'),
    'audioAssets',
    'F005_RUNTIME_CATALOG_INVALID',
  );
  if (authorsValue.length !== 4 || worksValue.length !== 15) {
    return runtimeError('F005_RUNTIME_CATALOG_INVALID', 'final Catalogはexact 4作者・15作品が必要です');
  }
  const authors = new Map<string, { readonly authorId: string; readonly slug: string }>();
  const slugs = new Set<string>();
  for (const authorValue of authorsValue) {
    if (!isObject(authorValue)) {
      return runtimeError('F005_RUNTIME_CATALOG_INVALID', '作者entryが不正です');
    }
    const authorId = ownDataProperty(authorValue, 'authorId', 'F005_RUNTIME_CATALOG_INVALID');
    const slug = ownDataProperty(authorValue, 'slug', 'F005_RUNTIME_CATALOG_INVALID');
    if (
      typeof authorId !== 'string' ||
      typeof slug !== 'string' ||
      authors.has(authorId) ||
      slugs.has(slug) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)
    ) {
      return runtimeError('F005_RUNTIME_CATALOG_INVALID', '作者identityまたはslugが不正です');
    }
    authors.set(authorId, Object.freeze({ authorId, slug }));
    slugs.add(slug);
  }
  const routes = ['#/', '#/favorites', '#/credits', ...[...slugs].map((slug) => `#/authors/${slug}`)];
  if (routes.length !== 7 || new Set(routes).size !== 7) {
    return runtimeError('F005_RUNTIME_CATALOG_INVALID', 'final route集合はexact 7件が必要です');
  }
  const audioIds = new Set<string>();
  for (const audio of audioValue) {
    if (!isObject(audio)) {
      return runtimeError('F005_RUNTIME_CATALOG_INVALID', '音声entryが不正です');
    }
    const audioId = ownDataProperty(audio, 'audioId', 'F005_RUNTIME_CATALOG_INVALID');
    if (typeof audioId !== 'string' || audioIds.has(audioId)) {
      return runtimeError('F005_RUNTIME_CATALOG_INVALID', '音声IDが重複または不正です');
    }
    audioIds.add(audioId);
  }

  const joined = new Map<string, JoinedDialogue>();
  const workIds = new Set<string>();
  for (const work of worksValue) {
    if (!isObject(work)) {
      return runtimeError('F005_RUNTIME_CATALOG_INVALID', '作品entryが不正です');
    }
    const authorId = ownDataProperty(work, 'authorId', 'F005_RUNTIME_CATALOG_INVALID');
    const workId = ownDataProperty(work, 'workId', 'F005_RUNTIME_CATALOG_INVALID');
    const dialogues = ownArrayValues(
      ownDataProperty(work, 'dialogues', 'F005_RUNTIME_CATALOG_INVALID'),
      'dialogues',
      'F005_RUNTIME_CATALOG_INVALID',
    );
    const author = typeof authorId === 'string' ? authors.get(authorId) : undefined;
    if (!author || typeof workId !== 'string' || workIds.has(workId)) {
      return runtimeError('F005_RUNTIME_CATALOG_INVALID', '作品参照が不正です');
    }
    workIds.add(workId);
    for (const dialogue of dialogues) {
      if (!isObject(dialogue)) {
        return runtimeError('F005_RUNTIME_CATALOG_INVALID', '台詞entryが不正です');
      }
      const dialogueId = ownDataProperty(dialogue, 'dialogueId', 'F005_RUNTIME_CATALOG_INVALID');
      const dialogueWorkId = ownDataProperty(dialogue, 'workId', 'F005_RUNTIME_CATALOG_INVALID');
      const audioId = ownDataProperty(dialogue, 'audioId', 'F005_RUNTIME_CATALOG_INVALID');
      if (
        !isSafeJoinedId(dialogueId) ||
        joined.has(dialogueId) ||
        dialogueWorkId !== workId ||
        typeof audioId !== 'string' ||
        !audioIds.has(audioId)
      ) {
        return runtimeError('F005_RUNTIME_CATALOG_INVALID', '台詞参照が不正です');
      }
      joined.set(dialogueId, Object.freeze({
        authorId: author.authorId,
        authorSlug: author.slug,
        workId,
        dialogueId,
      }));
    }
  }
  return joined;
}

function readControllerState(controller: unknown, key: 'snapshot' | 'state', code: F005RuntimeErrorCode): unknown {
  if (!isObject(controller)) return runtimeError(code, 'controllerが不正です');
  try {
    return Reflect.get(controller, key);
  } catch {
    return runtimeError(code, `${key}を安全に読み取れません`);
  }
}

function validateFavorite(
  controller: Pick<FavoriteController, 'snapshot'>,
  joined: ReadonlyMap<string, JoinedDialogue>,
): RuntimeContentReport['favorite'] {
  const snapshot = readPlainDataObject(
    readControllerState(controller, 'snapshot', 'F005_RUNTIME_FAVORITE_INVALID'),
    ['version', 'dialogueIds', 'persistence', 'message'],
    'F005_RUNTIME_FAVORITE_INVALID',
  );
  if (
    snapshot.version !== 1 ||
    (snapshot.persistence !== 'local-storage' && snapshot.persistence !== 'memory') ||
    !(snapshot.message === null || typeof snapshot.message === 'string')
  ) {
    return runtimeError('F005_RUNTIME_FAVORITE_INVALID', 'favorite snapshotの値が不正です');
  }
  const inputIds = readPlainStringArray(
    snapshot.dialogueIds,
    'F005_RUNTIME_FAVORITE_INVALID',
  );
  if (inputIds.length > FAVORITE_MAX_IDS) {
    return runtimeError('F005_RUNTIME_FAVORITE_INVALID', 'favorite ID件数が上限を超えています');
  }
  const selected = new Set<string>();
  for (const id of inputIds) {
    if (!isSafeJoinedId(id) || selected.has(id) || !joined.has(id)) {
      return runtimeError('F005_RUNTIME_FAVORITE_INVALID', 'favorite IDが未知、重複、またはhostileです');
    }
    selected.add(id);
  }
  const catalogOrdered = [...joined.keys()].filter((id) => selected.has(id));
  if (catalogOrdered.some((id, index) => id !== inputIds[index])) {
    return runtimeError('F005_RUNTIME_FAVORITE_INVALID', 'favorite IDがcanonical Catalog順ではありません');
  }
  const canonicalRaw = JSON.stringify({ version: 1, dialogueIds: catalogOrdered });
  if (canonicalRaw.length > FAVORITE_RAW_MAX_CODE_UNITS) {
    return runtimeError('F005_RUNTIME_FAVORITE_INVALID', 'favorite JSONが文字数上限を超えています');
  }
  return Object.freeze({
    dialogueIds: Object.freeze(catalogOrdered),
    persistence: snapshot.persistence,
  }) as RuntimeContentReport['favorite'];
}

function validateAudio(
  controller: Pick<AudioController, 'state'>,
  joined: ReadonlyMap<string, JoinedDialogue>,
): RuntimeContentReport['audio'] {
  const state = readPlainDataObject(
    readControllerState(controller, 'state', 'F005_RUNTIME_AUDIO_INVALID'),
    ['status', 'dialogueId', 'message'],
    'F005_RUNTIME_AUDIO_INVALID',
  );
  if (
    typeof state.status !== 'string' ||
    !PLAYER_STATUS.has(state.status as PlayerState['status']) ||
    typeof state.message !== 'string' ||
    !(state.dialogueId === null || isSafeJoinedId(state.dialogueId))
  ) {
    return runtimeError('F005_RUNTIME_AUDIO_INVALID', 'audio stateが不正です');
  }
  const status = state.status as PlayerState['status'];
  const dialogueId = state.dialogueId as string | null;
  if (
    (status === 'idle' && dialogueId !== null) ||
    (status !== 'idle' && (dialogueId === null || !joined.has(dialogueId)))
  ) {
    return runtimeError('F005_RUNTIME_AUDIO_INVALID', 'audio stateをCatalogへjoinできません');
  }
  return Object.freeze({
    status,
    dialogueId,
    activeAudioCount: status === 'loading' || status === 'playing' ? 1 as const : 0 as const,
  });
}

function validateNavigation(
  intent: FavoriteNavigationIntent | null,
  joined: ReadonlyMap<string, JoinedDialogue>,
): RuntimeContentReport['navigation'] {
  if (intent === null) {
    return Object.freeze({ kind: 'normal-entry' as const, initialOpenPanelCount: 0 as const });
  }
  const value = readPlainDataObject(
    intent,
    ['authorId', 'workId', 'dialogueId', 'activationId'],
    'F005_RUNTIME_NAVIGATION_INVALID',
  );
  if (
    typeof value.authorId !== 'string' ||
    typeof value.workId !== 'string' ||
    !isSafeJoinedId(value.dialogueId) ||
    typeof value.activationId !== 'string' ||
    !ACTIVATION_ID.test(value.activationId)
  ) {
    return runtimeError('F005_RUNTIME_NAVIGATION_INVALID', 'navigation intentが不正です');
  }
  const entry = joined.get(value.dialogueId);
  if (!entry || entry.authorId !== value.authorId || entry.workId !== value.workId) {
    return runtimeError('F005_RUNTIME_NAVIGATION_INVALID', 'navigation intentをCatalogへjoinできません');
  }
  return Object.freeze({
    kind: 'favorite-one-shot' as const,
    initialOpenPanelCount: 1 as const,
    activationId: value.activationId,
    authorId: entry.authorId,
    workId: entry.workId,
    dialogueId: entry.dialogueId,
    routeHash: `#/authors/${encodeURIComponent(entry.authorSlug)}`,
  });
}

/**
 * Catalog join後のIDだけをUI境界へ返す。通常入口は全閉で、favorite一覧から
 * 消費したone-shot intentだけが対象panel 1件を開ける。
 *
 * @des DES-F005-009 @fun FUN-F005-031
 */
export function validateF005RuntimeState(
  catalog: F005FinalCatalog,
  favoriteController: Pick<FavoriteController, 'snapshot'>,
  audioController: Pick<AudioController, 'state'>,
  navigationIntent: FavoriteNavigationIntent | null,
): RuntimeContentReport {
  if (!isMintedF005Catalog(catalog)) {
    return runtimeError('F005_RUNTIME_CATALOG_INVALID', 'mint済みF005 Catalogが必要です');
  }
  const mode = ownDataProperty(catalog, 'mode', 'F005_RUNTIME_CATALOG_INVALID');
  if (mode !== 'final') {
    return runtimeError('F005_RUNTIME_CATALOG_INVALID', 'runtimeはfinal Catalogだけを受理します');
  }
  const joined = buildJoinedDialogues(catalog);
  return Object.freeze({
    schemaVersion: 'f005-runtime-v1' as const,
    favorite: validateFavorite(favoriteController, joined),
    audio: validateAudio(audioController, joined),
    navigation: validateNavigation(navigationIntent, joined),
  });
}
