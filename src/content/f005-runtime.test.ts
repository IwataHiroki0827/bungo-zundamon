import { describe, expect, it, vi } from 'vitest';

const catalogBrands = vi.hoisted(() => ({
  minted: new WeakSet<object>(),
}));

vi.mock('./f005-catalog.ts', () => ({
  isMintedF005Catalog(value: unknown) {
    return value !== null && typeof value === 'object' && catalogBrands.minted.has(value);
  },
}));

import { AudioController } from '../ui/audio-controller.ts';
import {
  createFavoriteController,
  createFavoriteNavigation,
  type FavoriteController,
  type FavoriteNavigationIntent,
  type StorageLike,
} from '../ui/favorites.ts';
import { renderRoute } from '../ui/render.ts';
import type { AudioPort, PlayerState } from '../ui/types.ts';
import type { F005FinalCatalog } from './f005-catalog.ts';
import {
  F005RuntimeError,
  validateF005RuntimeState,
} from './f005-runtime.ts';

function catalogFixture(dialogueIds = ['dialogue-a', 'dialogue-b']): F005FinalCatalog {
  const workId = '000799';
  const baselineAuthors = [
    ['000879', 'akutagawa-zunnosuke'],
    ['000081', 'miyazawa-kenji'],
    ['000035', 'dazai-osamu'],
  ] as const;
  const authors = [
    ...baselineAuthors.map(([authorId, slug], index) => ({
      authorId,
      name: `作者${index}`,
      originalName: `作者${index}`,
      slug,
      artwork: { path: `artwork/${slug}.png`, alt: `作者${index}`, sha256: `${index + 1}`.repeat(64) },
      introducedByBatchId: `F00${index + 1}`,
      identitySha256: `${index + 4}`.repeat(64),
    })),
    {
      authorId: '000148',
      name: 'なつめそうせき',
      originalName: '夏目漱石',
      slug: 'natsume-soseki',
      artwork: { path: 'artwork/natsume-soseki.png', alt: '夏目漱石', sha256: 'a'.repeat(64) },
      introducedByBatchId: 'F005',
      identitySha256: 'b'.repeat(64),
    },
  ];
  const baselineWorks = baselineAuthors.flatMap(([authorId], authorIndex) =>
    Array.from({ length: 4 }, (_, workIndex) => {
      const baselineWorkId = `${authorIndex + 1}${workIndex + 1}`.padStart(6, '0');
      const dialogueId = `baseline-${authorIndex + 1}-${workIndex + 1}`;
      return {
        workId: baselineWorkId,
        authorId,
        batchId: `F00${authorIndex + 1}`,
        title: `既存作品${baselineWorkId}`,
        cardLink: `https://www.aozora.gr.jp/cards/${authorId}/card${Number(baselineWorkId)}.html`,
        source: {
          cardUrl: `https://www.aozora.gr.jp/cards/${authorId}/card${Number(baselineWorkId)}.html`,
          textUrl: `https://www.aozora.gr.jp/cards/${authorId}/files/${Number(baselineWorkId)}_1.html`,
          attribution: '青空文庫',
          baseEdition: '底本',
          inputter: '入力者',
          proofreader: '校正者',
          fetchedAt: '2026-07-29T00:00:00Z',
          transformation: '変換',
          sourceSha256: 'c'.repeat(64),
          provenancePath: `content/${baselineWorkId}.json`,
          provenanceSha256: 'd'.repeat(64),
        },
        dialogues: [{
          dialogueId,
          workId: baselineWorkId,
          order: 0,
          displayText: dialogueId,
          speechText: dialogueId,
          audioId: `audio-${dialogueId}`,
          sourceAnchor: { bodySelector: '.main_text', startToken: 0, endToken: 1 },
          review: {
            candidateId: dialogueId,
            workId: baselineWorkId,
            revision: 1,
            status: 'approved' as const,
            reasonCode: 'SPOKEN_DIALOGUE',
            reviewer: 'reviewer',
            reviewedAt: '2026-07-29T00:00:00Z',
            policyCheckedAt: '2026-07-29T00:00:00Z',
          },
        }],
      };
    }));
  const f005Work = {
    workId,
    authorId: '000148',
    batchId: 'F005',
    title: '夢十夜',
    cardLink: 'https://www.aozora.gr.jp/cards/000148/card799.html',
    source: {
      cardUrl: 'https://www.aozora.gr.jp/cards/000148/card799.html',
      textUrl: 'https://www.aozora.gr.jp/cards/000148/files/799_14972.html',
      attribution: '青空文庫',
      baseEdition: '底本',
      inputter: '入力者',
      proofreader: '校正者',
      fetchedAt: '2026-07-29T00:00:00Z',
      transformation: '変換',
      sourceSha256: 'c'.repeat(64),
      provenancePath: 'content/batches/F005/works/000799/source.json',
      provenanceSha256: 'd'.repeat(64),
    },
    dialogues: dialogueIds.map((dialogueId, index) => ({
      dialogueId,
      workId,
      order: index,
      displayText: `台詞${index + 1}`,
      speechText: `台詞${index + 1}`,
      audioId: `audio-${index + 1}`,
      sourceAnchor: { bodySelector: '.main_text', startToken: index, endToken: index + 1 },
      review: {
        candidateId: `candidate-${index + 1}`,
        workId,
        revision: 1,
        status: 'approved' as const,
        reasonCode: 'SPOKEN_DIALOGUE',
        reviewer: 'reviewer',
        reviewedAt: '2026-07-29T00:00:00Z',
        policyCheckedAt: '2026-07-29T00:00:00Z',
      },
    })),
  };
  const extraF005Works = ([
    ['001076', '倫敦塔'],
    ['001104', '趣味の遺伝'],
  ] as const).map(([extraWorkId, title], index) => ({
    ...f005Work,
    workId: extraWorkId,
    title,
    cardLink: `https://www.aozora.gr.jp/cards/000148/card${Number(extraWorkId)}.html`,
    source: {
      ...f005Work.source,
      cardUrl: `https://www.aozora.gr.jp/cards/000148/card${Number(extraWorkId)}.html`,
      textUrl: `https://www.aozora.gr.jp/cards/000148/files/${Number(extraWorkId)}_1.html`,
      provenancePath: `content/batches/F005/works/${extraWorkId}/source.json`,
    },
    dialogues: [{
      ...f005Work.dialogues[0]!,
      dialogueId: `extra-dialogue-${index + 1}`,
      workId: extraWorkId,
      audioId: `audio-extra-${index + 1}`,
    }],
  }));
  const baselineAudio = baselineWorks.map((work) => ({
    audioId: work.dialogues[0]!.audioId,
    batchId: work.batchId,
    path: `audio/${work.dialogues[0]!.dialogueId}.wav`,
    sha256: 'e'.repeat(64),
    bytes: 44,
    durationMs: 1,
    configHash: 'f'.repeat(64),
  }));
  const catalog = {
    mode: 'final' as const,
    schemaVersion: '2.0.0',
    authors,
    works: [f005Work, ...extraF005Works, ...baselineWorks],
    audioAssets: [...baselineAudio, ...dialogueIds.map((_dialogueId, index) => ({
      audioId: `audio-${index + 1}`,
      batchId: 'F005',
      path: `audio/F005/000799/${index + 1}.wav`,
      sha256: 'e'.repeat(64),
      bytes: 44,
      durationMs: 1,
      configHash: 'f'.repeat(64),
    })), ...extraF005Works.map((work, index) => ({
      audioId: work.dialogues[0]!.audioId,
      batchId: 'F005',
      path: `audio/F005/${work.workId}/${index + 1}.wav`,
      sha256: 'e'.repeat(64),
      bytes: 44,
      durationMs: 1,
      configHash: 'f'.repeat(64),
    }))],
    batches: [...baselineAuthors.map(([authorId], index) => ({
      batchId: `F00${index + 1}`,
      feature: `F00${index + 1}`,
      status: 'published' as const,
      authorId,
      workIds: baselineWorks
        .filter((work) => work.authorId === authorId)
        .map((work) => work.workId),
      acceptedAt: '2026-07-29T00:00:00Z',
      publishedAt: '2026-07-29T00:00:00Z',
      evidenceSha256: `${index + 1}`.repeat(64),
    })), {
      batchId: 'F005',
      feature: 'F005',
      status: 'accepted',
      authorId: '000148',
      workIds: [workId, '001076', '001104'],
      acceptedAt: '2026-07-29T00:00:00Z',
      evidenceSha256: '1'.repeat(64),
    }],
    candidateCounts: {
      total: dialogueIds.length,
      published: dialogueIds.length,
      editorialExcluded: 0,
      audioExcluded: 0,
      byBatch: {
        F005: {
          total: dialogueIds.length,
          published: dialogueIds.length,
          editorialExcluded: 0,
          audioExcluded: 0,
        },
      },
    },
    creditsRef: 'content/licenses.json',
  } as unknown as F005FinalCatalog;
  catalogBrands.minted.add(catalog);
  return catalog;
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function idleAudioController(): Pick<AudioController, 'state'> {
  const state: PlayerState = Object.freeze({
    status: 'idle',
    dialogueId: null,
    message: '音声は停止しています。',
  });
  return { get state() { return state; } };
}

function controllerWithSnapshot(snapshot: unknown): Pick<FavoriteController, 'snapshot'> {
  return { get snapshot() { return snapshot; } } as Pick<FavoriteController, 'snapshot'>;
}

function expectRuntimeError(operation: () => unknown, code: F005RuntimeError['code']): void {
  expect(operation).toThrowError(F005RuntimeError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

/** @des DES-F005-009 @fun FUN-F005-031 @ut UT-F005-031 */
describe('UT-F005-031 runtime state', () => {
  it('mint済みfinal Catalogだけを受理しplain/preview/空/count差を拒否する', () => {
    const final = catalogFixture();
    const favorite = createFavoriteController(() => new MemoryStorage(), final);
    const invalid: unknown[] = [
      structuredClone(final),
      Object.assign(catalogFixture(), { mode: 'work-preview' }),
      Object.assign({}, { mode: 'final' }),
    ];
    catalogBrands.minted.add(invalid[2] as object);
    const authorMissing = structuredClone(final) as unknown as F005FinalCatalog;
    authorMissing.authors.pop();
    catalogBrands.minted.add(authorMissing);
    const workMissing = structuredClone(final) as unknown as F005FinalCatalog;
    workMissing.works.pop();
    catalogBrands.minted.add(workMissing);
    invalid.push(authorMissing, workMissing);
    for (const catalog of invalid) {
      expectRuntimeError(
        () => validateF005RuntimeState(
          catalog as F005FinalCatalog,
          favorite,
          idleAudioController(),
          null,
        ),
        'F005_RUNTIME_CATALOG_INVALID',
      );
    }
  });

  it('unminted/nested getterとprototypeを実行前に拒否する', () => {
    const getter = vi.fn(() => []);
    const hostilePlain = {};
    Object.defineProperties(hostilePlain, {
      mode: { get: getter, enumerable: true },
      authors: { get: getter, enumerable: true },
    });
    expectRuntimeError(
      () => validateF005RuntimeState(
        hostilePlain as F005FinalCatalog,
        {} as FavoriteController,
        idleAudioController(),
        null,
      ),
      'F005_RUNTIME_CATALOG_INVALID',
    );
    expect(getter).not.toHaveBeenCalled();

    const nestedGetter = vi.fn(() => '000879');
    const accessorCatalog = structuredClone(catalogFixture()) as unknown as F005FinalCatalog;
    Object.defineProperty(accessorCatalog.authors[0]!, 'authorId', {
      get: nestedGetter,
      enumerable: true,
      configurable: true,
    });
    catalogBrands.minted.add(accessorCatalog);
    expectRuntimeError(
      () => validateF005RuntimeState(
        accessorCatalog,
        createFavoriteController(() => new MemoryStorage(), catalogFixture()),
        idleAudioController(),
        null,
      ),
      'F005_RUNTIME_CATALOG_INVALID',
    );
    expect(nestedGetter).not.toHaveBeenCalled();

    const inheritedCatalog = structuredClone(catalogFixture()) as unknown as F005FinalCatalog;
    inheritedCatalog.authors[0] = Object.create(inheritedCatalog.authors[0]!) as
      F005FinalCatalog['authors'][number];
    catalogBrands.minted.add(inheritedCatalog);
    expectRuntimeError(
      () => validateF005RuntimeState(
        inheritedCatalog,
        createFavoriteController(() => new MemoryStorage(), catalogFixture()),
        idleAudioController(),
        null,
      ),
      'F005_RUNTIME_CATALOG_INVALID',
    );
  });

  it('通常入口をopen 0とし、Catalog join済みfavorite/audioだけをreportする', () => {
    const catalog = catalogFixture();
    const favoriteController = createFavoriteController(() => new MemoryStorage(), catalog);
    favoriteController.toggle('dialogue-b');
    const report = validateF005RuntimeState(
      catalog,
      favoriteController,
      idleAudioController(),
      null,
    );

    expect(report).toEqual({
      schemaVersion: 'f005-runtime-v1',
      favorite: {
        dialogueIds: ['dialogue-b'],
        persistence: 'local-storage',
      },
      audio: {
        status: 'idle',
        dialogueId: null,
        activeAudioCount: 0,
      },
      navigation: {
        kind: 'normal-entry',
        initialOpenPanelCount: 0,
      },
    });
  });

  it('favorite navigationが消費したone-shot intentだけを安全なrouteとopen 1へ投影する', () => {
    const catalog = catalogFixture();
    const navigation = createFavoriteNavigation(catalog, vi.fn());
    const intent = navigation.activate('dialogue-b');
    expect(intent).not.toBeNull();
    const consumed = navigation.consume('000148');
    const report = validateF005RuntimeState(
      catalog,
      createFavoriteController(() => new MemoryStorage(), catalog),
      idleAudioController(),
      consumed,
    );
    expect(report.navigation).toEqual({
      kind: 'favorite-one-shot',
      initialOpenPanelCount: 1,
      activationId: 'favorite-activation-1',
      authorId: '000148',
      workId: '000799',
      dialogueId: 'dialogue-b',
      routeHash: '#/authors/natsume-soseki',
    });
    expect(navigation.consume('000148')).toBeNull();
    expect(validateF005RuntimeState(
      catalog,
      createFavoriteController(() => new MemoryStorage(), catalog),
      idleAudioController(),
      null,
    ).navigation.initialOpenPanelCount).toBe(0);
  });

  it.each([
    ['CSS selector', 'dialogue[a]'],
    ['path separator', '../dialogue-a'],
    ['Windows path', String.raw`dialogue\a`],
    ['URL', 'https://evil.test/x'],
    ['control', 'dialogue\u0000a'],
    ['prototype', '__proto__'],
    ['constructor', 'constructor'],
  ])('%s hostile favorite IDをCatalogに存在しても拒否する', (_label, hostileId) => {
    const catalog = catalogFixture([hostileId]);
    const snapshot = Object.freeze({
      version: 1 as const,
      dialogueIds: Object.freeze([hostileId]),
      persistence: 'memory' as const,
      message: null,
    });
    expectRuntimeError(
      () => validateF005RuntimeState(
        catalog,
        controllerWithSnapshot(snapshot),
        idleAudioController(),
        null,
      ),
      'F005_RUNTIME_CATALOG_INVALID',
    );
  });

  it('prototype汚染object、getter、余分field、重複・未知・非canonical IDを拒否する', () => {
    const catalog = catalogFixture();
    const valid = {
      version: 1 as const,
      dialogueIds: ['dialogue-a'],
      persistence: 'memory' as const,
      message: null,
    };
    const inherited = Object.assign(Object.create({ polluted: true }) as object, valid);
    const getter = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(getter, {
      version: { value: 1, enumerable: true },
      dialogueIds: {
        get: vi.fn(() => ['dialogue-a']),
        enumerable: true,
      },
      persistence: { value: 'memory', enumerable: true },
      message: { value: null, enumerable: true },
    });
    const values = [
      inherited,
      getter,
      { ...valid, extra: true },
      { ...valid, dialogueIds: ['dialogue-a', 'dialogue-a'] },
      { ...valid, dialogueIds: ['unknown'] },
      { ...valid, dialogueIds: ['dialogue-b', 'dialogue-a'] },
    ];
    for (const value of values) {
      expectRuntimeError(
        () => validateF005RuntimeState(
          catalog,
          controllerWithSnapshot(value),
          idleAudioController(),
          null,
        ),
        'F005_RUNTIME_FAVORITE_INVALID',
      );
    }
    expect((Object.getOwnPropertyDescriptor(getter, 'dialogueIds')?.get as ReturnType<typeof vi.fn>))
      .not.toHaveBeenCalled();
  });

  it('navigation intentのgetter、prototype、tuple混線、hostile activationを拒否する', () => {
    const catalog = catalogFixture();
    const valid: FavoriteNavigationIntent = Object.freeze({
      authorId: '000148',
      workId: '000799',
      dialogueId: 'dialogue-a',
      activationId: 'favorite-activation-1',
    });
    const getter = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(getter, {
      authorId: { value: '000148', enumerable: true },
      workId: { value: '000799', enumerable: true },
      dialogueId: {
        get: vi.fn(() => 'dialogue-a'),
        enumerable: true,
      },
      activationId: { value: 'favorite-activation-1', enumerable: true },
    });
    const values: unknown[] = [
      Object.assign(Object.create({ polluted: true }) as object, valid),
      getter,
      { ...valid, workId: '001076' },
      { ...valid, dialogueId: 'https://evil.test/x' },
      { ...valid, activationId: 'favorite-activation-1#evil' },
      { ...valid, extra: 'x' },
    ];
    for (const value of values) {
      expectRuntimeError(
        () => validateF005RuntimeState(
          catalog,
          createFavoriteController(() => new MemoryStorage(), catalog),
          idleAudioController(),
          value as FavoriteNavigationIntent,
        ),
        'F005_RUNTIME_NAVIGATION_INVALID',
      );
    }
    expect((Object.getOwnPropertyDescriptor(getter, 'dialogueId')?.get as ReturnType<typeof vi.fn>))
      .not.toHaveBeenCalled();
  });

  it('audio stateはCatalog join済み1件だけをactiveとし、未知IDとgetterを拒否する', () => {
    const catalog = catalogFixture();
    const favorite = createFavoriteController(() => new MemoryStorage(), catalog);
    const playing: PlayerState = Object.freeze({
      status: 'playing',
      dialogueId: 'dialogue-a',
      message: '読み上げています。',
    });
    expect(validateF005RuntimeState(
      catalog,
      favorite,
      { get state() { return playing; } },
      null,
    ).audio).toMatchObject({ dialogueId: 'dialogue-a', activeAudioCount: 1 });

    for (const state of [
      { status: 'playing', dialogueId: 'unknown', message: 'x' },
      { status: 'idle', dialogueId: 'dialogue-a', message: 'x' },
      { status: 'playing', dialogueId: null, message: 'x' },
    ]) {
      expectRuntimeError(
        () => validateF005RuntimeState(
          catalog,
          favorite,
          { get state() { return state as PlayerState; } },
          null,
        ),
        'F005_RUNTIME_AUDIO_INVALID',
      );
    }
    const hostileController = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileController, 'state', {
      get() { throw new Error('must be contained'); },
    });
    expectRuntimeError(
      () => validateF005RuntimeState(
        catalog,
        favorite,
        hostileController as Pick<AudioController, 'state'>,
        null,
      ),
      'F005_RUNTIME_AUDIO_INVALID',
    );
  });
});

/** @des DES-F005-009 @fun FUN-F005-031 @ut UT-F005-031 @it IT-F005-009 */
describe('IT-F005-009 single AudioController route lifecycle', () => {
  it('単一portで再生を切り替え、route変更時にpause/reset/src解除して古いeventを無視する', async () => {
    const listeners = new Map<'ended' | 'error', EventListener>();
    const removeAttribute = vi.fn();
    const port: AudioPort = {
      src: '',
      currentTime: 0,
      preload: 'none',
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute,
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    };
    const factory = vi.fn(() => port);
    const catalog = catalogFixture();
    const controller = new AudioController(catalog, new URL('https://example.test/app/'), factory);
    const first = document.createElement('button');
    first.dataset.dialogueId = 'dialogue-a';
    const second = document.createElement('button');
    second.dataset.dialogueId = 'dialogue-b';
    await controller.play(catalog.works[0]!.dialogues[0]!, first);
    await controller.play(catalog.works[0]!.dialogues[1]!, second);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(port.pause).toHaveBeenCalledTimes(2);
    controller.onRouteChange({ kind: 'favorites' });
    expect(port.pause).toHaveBeenCalledTimes(3);
    expect(port.currentTime).toBe(0);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(controller.state.status).toBe('stopped');
    listeners.get('ended')?.(new Event('ended'));
    listeners.get('error')?.(new Event('error'));
    expect(controller.state.status).toBe('stopped');
  });

  it('通常author入口は全閉、favorite移動だけ1回展開し、favorite操作は再生しない', () => {
    const catalog = catalogFixture();
    const favorite = createFavoriteController(() => new MemoryStorage(), catalog);
    const port: AudioPort = {
      src: '',
      currentTime: 0,
      preload: 'none',
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const controller = new AudioController(
      catalog,
      new URL('https://example.test/app/'),
      () => port,
    );
    const navigation = createFavoriteNavigation(catalog, vi.fn());
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    const context = {
      controller,
      favoriteController: favorite,
      favoriteNavigation: navigation,
      baseUrl: new URL('https://example.test/app/'),
      motion: 'reduced' as const,
      motionLockedByOs: false,
      onMotionToggle: vi.fn(),
    };

    renderRoute(
      root,
      { kind: 'author', authorId: '000148', slug: 'natsume-soseki' },
      catalog,
      context,
    );
    expect(root.querySelectorAll('details.work-panel[open]')).toHaveLength(0);
    favorite.toggle('dialogue-a');
    expect(port.play).not.toHaveBeenCalled();

    navigation.activate('dialogue-b');
    renderRoute(
      root,
      { kind: 'author', authorId: '000148', slug: 'natsume-soseki' },
      catalog,
      context,
    );
    expect(root.querySelectorAll('details.work-panel[open]')).toHaveLength(1);
    expect((document.activeElement as HTMLElement | null)?.dataset.dialogueId).toBe('dialogue-b');

    renderRoute(
      root,
      { kind: 'author', authorId: '000148', slug: 'natsume-soseki' },
      catalog,
      context,
    );
    expect(root.querySelectorAll('details.work-panel[open]')).toHaveLength(0);
    expect(port.play).not.toHaveBeenCalled();
  });
});
