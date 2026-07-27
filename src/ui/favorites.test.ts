import { describe, expect, it, vi } from 'vitest';

import type { AudioController } from './audio-controller';
import { validateCatalogV2 } from './catalog-loader';
import {
  FAVORITE_RAW_MAX_CODE_UNITS,
  FAVORITE_STORAGE_KEY,
  createFavoriteController,
  createFavoriteNavigation,
  createFavoritePersistence,
  parseFavoriteStore,
  selectFavoriteDialogueViews,
  toggleFavorite,
  type FavoriteStoreV1,
  type StorageLike,
} from './favorites';
import { renderFavoritesRoute, renderRoute } from './render';
import type { PlayerState, UICatalogV2 } from './types';

function catalogFixture(dialogueIds = ['dialogue-b', 'dialogue-a', 'dialogue-c']): UICatalogV2 {
  const authors = [
    {
      authorId: '000001', name: '作者一', originalName: '作者一', slug: 'author-one',
      artwork: { path: 'artwork/a.png', alt: '作者一', sha256: 'a'.repeat(64) },
      introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64),
    },
    {
      authorId: '000002', name: '作者二', originalName: '作者二', slug: 'author-two',
      artwork: { path: 'artwork/b.png', alt: '作者二', sha256: 'c'.repeat(64) },
      introducedByBatchId: 'F002', identitySha256: 'd'.repeat(64),
    },
  ];
  const firstIds = dialogueIds.slice(0, Math.max(1, dialogueIds.length - 1));
  const secondIds = dialogueIds.slice(firstIds.length);
  const makeWork = (workId: string, authorId: string, batchId: string, ids: readonly string[]) => ({
    workId,
    authorId,
    batchId,
    title: `作品${workId}`,
    cardLink: `https://www.aozora.gr.jp/cards/${authorId}/card${Number(workId)}.html`,
    source: {
      cardUrl: `https://www.aozora.gr.jp/cards/${authorId}/card${Number(workId)}.html`,
      textUrl: `https://www.aozora.gr.jp/cards/${authorId}/files/${Number(workId)}_1.html`,
      attribution: '青空文庫', baseEdition: '底本', inputter: '入力者', proofreader: '校正者',
      fetchedAt: '2026-07-28T00:00:00Z', transformation: '変換',
      sourceSha256: 'e'.repeat(64), provenancePath: `content/${workId}.json`,
      provenanceSha256: 'f'.repeat(64),
    },
    dialogues: ids.map((dialogueId, index) => ({
      dialogueId,
      workId,
      order: index,
      displayText: `台詞${dialogueId}`,
      speechText: `台詞${dialogueId}`,
      audioId: `audio-${dialogueId}`,
      sourceAnchor: { bodySelector: '.main_text', startToken: index, endToken: index + 1 },
      review: {
        candidateId: dialogueId, workId, revision: 1, status: 'approved' as const,
        reasonCode: 'SPOKEN_DIALOGUE', reviewer: 'reviewer',
        reviewedAt: '2026-07-28T00:00:00Z', policyCheckedAt: '2026-07-28T00:00:00Z',
      },
    })),
  });
  const works = [
    makeWork('000001', '000001', 'F001', firstIds),
    ...(secondIds.length > 0 ? [makeWork('000002', '000002', 'F002', secondIds)] : []),
  ];
  return {
    schemaVersion: '2.0.0',
    authors: secondIds.length > 0 ? authors : authors.slice(0, 1),
    works,
    audioAssets: dialogueIds.map((dialogueId, index) => ({
      audioId: `audio-${dialogueId}`,
      batchId: index < firstIds.length ? 'F001' : 'F002',
      path: `audio/${dialogueId}.wav`,
      sha256: 'a'.repeat(64),
      bytes: 44,
      durationMs: 1,
      configHash: 'b'.repeat(64),
    })),
    batches: [
      {
        batchId: 'F001', feature: 'F001', status: 'published', authorId: '000001',
        workIds: ['000001'], acceptedAt: '2026-07-28T00:00:00Z',
        publishedAt: '2026-07-28T00:00:00Z', evidenceSha256: '1'.repeat(64),
      },
      ...(secondIds.length > 0 ? [{
        batchId: 'F002', feature: 'F002', status: 'accepted' as const, authorId: '000002',
        workIds: ['000002'], acceptedAt: '2026-07-28T00:00:00Z',
        evidenceSha256: '2'.repeat(64),
      }] : []),
    ],
    candidateCounts: {
      total: dialogueIds.length,
      published: dialogueIds.length,
      editorialExcluded: 0,
      audioExcluded: 0,
      byBatch: {
        F001: {
          total: firstIds.length,
          published: firstIds.length,
          editorialExcluded: 0,
          audioExcluded: 0,
        },
        ...(secondIds.length > 0 ? {
          F002: {
            total: secondIds.length,
            published: secondIds.length,
            editorialExcluded: 0,
            audioExcluded: 0,
          },
        } : {}),
      },
    },
    creditsRef: 'content/licenses.json',
  };
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  readonly calls: Array<{ operation: string; key: string }> = [];

  getItem(key: string): string | null {
    this.calls.push({ operation: 'get', key });
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.calls.push({ operation: 'set', key });
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.calls.push({ operation: 'remove', key });
    this.values.delete(key);
  }
}

function audioControllerFixture(): {
  controller: AudioController;
  play: ReturnType<typeof vi.fn>;
} {
  const state: PlayerState = { status: 'idle', dialogueId: null, message: '停止中' };
  const play = vi.fn(async () => state);
  return {
    controller: {
      play,
      control: vi.fn(() => state),
      subscribe(listener: (next: PlayerState) => void) {
        listener(state);
        return () => undefined;
      },
    } as unknown as AudioController,
    play,
  };
}

/** @des DES-F004-009 @fun FUN-F004-025 @ut UT-F004-025 */
describe('UT-F004-025 favorite store parser', () => {
  it('exact schemaと境界を検査し、未知・重複IDだけをCatalog順uniqueへ正規化する', () => {
    const catalog = catalogFixture();
    expect(parseFavoriteStore(null, catalog)).toMatchObject({
      store: { version: 1, dialogueIds: [] }, rewriteRequired: false, reason: 'empty',
    });
    expect(parseFavoriteStore('{"version":1,"dialogueIds":["dialogue-a"]}', catalog)).toMatchObject({
      store: { dialogueIds: ['dialogue-a'] }, rewriteRequired: false,
    });
    expect(parseFavoriteStore(
      '{"version":1,"dialogueIds":["unknown","dialogue-a","dialogue-b","dialogue-a"]}',
      catalog,
    )).toMatchObject({
      store: { dialogueIds: ['dialogue-b', 'dialogue-a'] },
      rewriteRequired: true,
      reason: 'normalized',
    });

    const boundaryId = 'a'.repeat(128);
    expect(parseFavoriteStore(
      JSON.stringify({ version: 1, dialogueIds: [boundaryId] }),
      catalogFixture([boundaryId]),
    ).store.dialogueIds).toEqual([boundaryId]);
    for (const raw of [
      JSON.stringify({ version: 1, dialogueIds: ['a'.repeat(129)] }),
      JSON.stringify({ version: 2, dialogueIds: [] }),
      JSON.stringify({ version: 1, dialogueIds: [], text: '本文' }),
      JSON.stringify({ version: 1, dialogueIds: [1] }),
      '{"version":',
      '['.repeat(10_000),
    ]) {
      expect(parseFavoriteStore(raw, catalog)).toMatchObject({
        store: { dialogueIds: [] }, rewriteRequired: true,
      });
    }
    expect(parseFavoriteStore(' '.repeat(FAVORITE_RAW_MAX_CODE_UNITS), catalog).reason).toBe('malformed');
    expect(parseFavoriteStore(' '.repeat(FAVORITE_RAW_MAX_CODE_UNITS + 1), catalog).reason).toBe('raw-too-large');
  });

  it('5000件を受理し5001件をparse後にemptyへ閉じる', () => {
    const ids = Array.from({ length: 5_001 }, (_, index) => `d${index.toString().padStart(4, '0')}`);
    const catalog = catalogFixture(ids);
    expect(parseFavoriteStore(
      JSON.stringify({ version: 1, dialogueIds: ids.slice(0, 5_000) }),
      catalog,
    ).store.dialogueIds).toHaveLength(5_000);
    expect(parseFavoriteStore(
      JSON.stringify({ version: 1, dialogueIds: ids }),
      catalog,
    )).toMatchObject({ store: { dialogueIds: [] }, rewriteRequired: true });
  });
});

/** @des DES-F004-009 @fun FUN-F004-026 @ut UT-F004-026 */
describe('UT-F004-026 storage provider boundary', () => {
  it('exact keyだけをread/write/removeし、正規化値を同じkeyへrewriteする', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      FAVORITE_STORAGE_KEY,
      '{"version":1,"dialogueIds":["unknown","dialogue-a","dialogue-b","dialogue-a"]}',
    );
    const persistence = createFavoritePersistence(() => storage, catalogFixture());
    expect(persistence.initial.store.dialogueIds).toEqual(['dialogue-b', 'dialogue-a']);
    expect(storage.values.get(FAVORITE_STORAGE_KEY))
      .toBe('{"version":1,"dialogueIds":["dialogue-b","dialogue-a"]}');
    persistence.save({ version: 1, dialogueIds: [] });
    expect(storage.values.has(FAVORITE_STORAGE_KEY)).toBe(false);
    expect(new Set(storage.calls.map((call) => call.key))).toEqual(new Set([FAVORITE_STORAGE_KEY]));
  });

  it.each(['provider', 'read', 'write', 'remove'] as const)(
    '%s例外をmemoryへ隔離して旧storage bytesを維持する',
    (phase) => {
      const storage = new MemoryStorage();
      const old = '{"version":1,"dialogueIds":["dialogue-a"]}';
      storage.values.set(FAVORITE_STORAGE_KEY, old);
      const provider = (): StorageLike => {
        if (phase === 'provider') throw new DOMException('denied', 'SecurityError');
        return {
          getItem: (key) => {
            if (phase === 'read') throw new DOMException('denied', 'SecurityError');
            return storage.getItem(key);
          },
          setItem: (key, value) => {
            if (phase === 'write') throw new DOMException('quota', 'QuotaExceededError');
            storage.setItem(key, value);
          },
          removeItem: (key) => {
            if (phase === 'remove') throw new DOMException('denied', 'SecurityError');
            storage.removeItem(key);
          },
        };
      };
      const persistence = createFavoritePersistence(provider, catalogFixture());
      if (phase === 'provider' || phase === 'read') {
        expect(persistence.mode).toBe('memory');
        expect(persistence.initial.store.dialogueIds).toEqual([]);
      } else {
        const result = persistence.save(phase === 'remove'
          ? { version: 1, dialogueIds: [] }
          : { version: 1, dialogueIds: ['dialogue-b'] });
        expect(result).toBe('memory');
        expect(storage.values.get(FAVORITE_STORAGE_KEY)).toBe(old);
      }
    },
  );
});

/** @des DES-F004-009 @fun FUN-F004-027 @ut UT-F004-027 */
describe('UT-F004-027 favorite toggle', () => {
  it('有効IDだけをCatalog順でtoggleしcontrol状態を同じtransitionから返す', () => {
    const catalog = catalogFixture();
    const empty: FavoriteStoreV1 = { version: 1, dialogueIds: [] };
    const added = toggleFavorite(empty, 'dialogue-a', catalog);
    expect(added).toMatchObject({
      changed: true,
      store: { dialogueIds: ['dialogue-a'] },
      control: {
        ariaPressed: 'true',
        label: 'お気に入りから削除',
        className: 'favorite-button is-favorite',
      },
    });
    expect(toggleFavorite(added.store, 'dialogue-a', catalog)).toMatchObject({
      changed: true,
      store: { dialogueIds: [] },
      control: { ariaPressed: 'false', label: 'お気に入りに追加' },
    });
    expect(toggleFavorite(empty, 'unknown', catalog)).toMatchObject({ changed: false, store: empty });
  });

  it('controllerは論理toggleごとexact 1通知しwrite失敗後もmemory snapshotを維持する', () => {
    const storage = new MemoryStorage();
    storage.setItem = vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const controller = createFavoriteController(() => storage, catalogFixture());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    listener.mockClear();
    controller.toggle('dialogue-a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toMatchObject({
      dialogueIds: ['dialogue-a'], persistence: 'memory',
    });
    controller.toggle('unknown');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

/** @des DES-F004-010 @fun FUN-F004-028 @ut UT-F004-028 */
describe('UT-F004-028 favorite view selector', () => {
  it('保存順ではなくCatalog順にauthor/work/dialogue/audioをjoinし未知IDを表示へ渡さない', () => {
    const catalog = catalogFixture();
    const views = selectFavoriteDialogueViews(
      { dialogueIds: ['unknown', 'dialogue-c', 'dialogue-b', 'dialogue-b'] },
      catalog,
    );
    expect(views.map((view) => ({
      author: view.author.authorId,
      work: view.work.workId,
      dialogue: view.dialogue.dialogueId,
      audio: view.audio.audioId,
    }))).toEqual([
      { author: '000001', work: '000001', dialogue: 'dialogue-b', audio: 'audio-dialogue-b' },
      { author: '000002', work: '000002', dialogue: 'dialogue-c', audio: 'audio-dialogue-c' },
    ]);
    const broken = structuredClone(catalog);
    broken.audioAssets.pop();
    expect(validateCatalogV2(catalog, JSON.stringify(catalog).length).ok).toBe(true);
    expect(validateCatalogV2(broken, JSON.stringify(broken).length)).toMatchObject({
      ok: false,
      error: { code: 'CATALOG_ORPHAN_REFERENCE' },
    });
  });
});

/** @des DES-F004-010 @fun FUN-F004-029 @ut UT-F004-029 */
describe('UT-F004-029 favorites route and one-shot navigation', () => {
  it.each([
    ['先頭', ['dialogue-b', 'dialogue-a', 'dialogue-c'], 0, 'dialogue-a'],
    ['中間', ['dialogue-b', 'dialogue-a', 'dialogue-c'], 1, 'dialogue-c'],
    ['末尾', ['dialogue-b', 'dialogue-a', 'dialogue-c'], 2, 'dialogue-a'],
  ] as const)('%s解除後は次項目、次がなければ直前の末尾へfocusする', (
    _label,
    selected,
    removeIndex,
    expectedFocus,
  ) => {
    const catalog = catalogFixture();
    const favoriteController = createFavoriteController(() => new MemoryStorage(), catalog);
    for (const dialogueId of selected) favoriteController.toggle(dialogueId);
    const page = renderFavoritesRoute(
      catalog,
      audioControllerFixture().controller,
      favoriteController,
      createFavoriteNavigation(catalog, vi.fn()),
    );
    document.body.replaceChildren(page);
    const controls = Array.from(page.querySelectorAll<HTMLButtonElement>(
      '.favorite-item > .favorite-route-actions > .favorite-button',
    ));
    controls[removeIndex]!.click();
    expect((document.activeElement as HTMLElement | null)?.dataset.dialogueId).toBe(expectedFocus);
  });

  it('最後の1件を解除した場合は空状態見出しへfocusする', () => {
    const catalog = catalogFixture();
    const favoriteController = createFavoriteController(() => new MemoryStorage(), catalog);
    favoriteController.toggle('dialogue-c');
    const page = renderFavoritesRoute(
      catalog,
      audioControllerFixture().controller,
      favoriteController,
      createFavoriteNavigation(catalog, vi.fn()),
    );
    document.body.replaceChildren(page);
    page.querySelector<HTMLButtonElement>('.favorite-item .favorite-button')!.click();
    expect(document.activeElement).toBe(page.querySelector('.favorite-empty-title'));
  });

  it('Catalog順一覧・解除focus・空状態・元作品への一回だけの展開をtext nodeで描画する', () => {
    const catalog = catalogFixture();
    const favoriteController = createFavoriteController(() => new MemoryStorage(), catalog);
    favoriteController.toggle('dialogue-c');
    favoriteController.toggle('dialogue-b');
    const navigate = vi.fn();
    const favoriteNavigation = createFavoriteNavigation(catalog, navigate);
    const { controller, play } = audioControllerFixture();
    const page = renderFavoritesRoute(catalog, controller, favoriteController, favoriteNavigation);
    document.body.replaceChildren(page);

    expect(Array.from(page.querySelectorAll<HTMLElement>('.favorite-item')).map((item) => item.dataset.dialogueId))
      .toEqual(['dialogue-b', 'dialogue-c']);
    const firstRemove = page.querySelector<HTMLButtonElement>('.favorite-item .favorite-button')!;
    expect(firstRemove.childNodes).toHaveLength(1);
    firstRemove.click();
    expect(play).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(page.querySelector('.favorite-item .favorite-button'));

    page.querySelector<HTMLAnchorElement>('.favorite-original-link')!.click();
    expect(navigate).toHaveBeenCalledWith('#/authors/author-two');
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    const context = {
      controller,
      favoriteController,
      favoriteNavigation,
      baseUrl: new URL('https://example.test/app/'),
      motion: 'reduced' as const,
      motionLockedByOs: false,
      onMotionToggle: vi.fn(),
    };
    renderRoute(
      root,
      { kind: 'author', authorId: '000002', slug: 'author-two' },
      catalog,
      context,
    );
    expect(root.querySelectorAll('details.work-panel[open]')).toHaveLength(1);
    expect((document.activeElement as HTMLElement | null)?.dataset.dialogueId).toBe('dialogue-c');
    renderRoute(
      root,
      { kind: 'author', authorId: '000002', slug: 'author-two' },
      catalog,
      context,
    );
    expect(root.querySelectorAll('details.work-panel[open]')).toHaveLength(0);

    renderRoute(root, { kind: 'favorites' }, catalog, context);
    expect(root.querySelector('nav a[href="#/favorites"]')?.getAttribute('aria-current')).toBe('page');
    root.querySelector<HTMLButtonElement>('.favorite-item .favorite-button')!.click();
    expect(root.querySelector('.favorite-empty-title')?.textContent).toBe('お気に入りはまだありません');
    expect(document.activeElement).toBe(root.querySelector('.favorite-empty-title'));
  });
});

/** @des DES-F004-009 DES-F004-010 @fun FUN-F004-030 @ut UT-F004-030 */
describe('UT-F004-030 FavoriteController lifecycle', () => {
  it('複数subscriber、route共有、dispose、remountを1つのstorage snapshotで扱う', () => {
    const storage = new MemoryStorage();
    const catalog = catalogFixture();
    const controller = createFavoriteController(() => storage, catalog);
    const author = vi.fn();
    const favorites = vi.fn();
    controller.subscribe(author);
    controller.subscribe(favorites);
    author.mockClear();
    favorites.mockClear();
    controller.toggle('dialogue-a');
    expect(author).toHaveBeenCalledTimes(1);
    expect(favorites).toHaveBeenCalledTimes(1);
    expect(author.mock.calls[0]![0]).toBe(favorites.mock.calls[0]![0]);
    controller.dispose();
    controller.toggle('dialogue-b');
    expect(author).toHaveBeenCalledTimes(1);

    const remounted = createFavoriteController(() => storage, catalog);
    expect(remounted.snapshot.dialogueIds).toEqual(['dialogue-a']);
  });

  it('Catalog join済みone-shot intentだけを生成・消費する', () => {
    const navigate = vi.fn();
    const navigation = createFavoriteNavigation(catalogFixture(), navigate);
    expect(navigation.activate('unknown')).toBeNull();
    const intent = navigation.activate('dialogue-c');
    expect(intent).toMatchObject({
      authorId: '000002', workId: '000002', dialogueId: 'dialogue-c',
    });
    expect(navigate).toHaveBeenCalledWith('#/authors/author-two');
    expect(navigation.consume('000002')).toBe(intent);
    expect(navigation.consume('000002')).toBeNull();
  });
});
