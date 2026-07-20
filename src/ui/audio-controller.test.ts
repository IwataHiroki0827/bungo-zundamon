import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioController } from './audio-controller';
import type { AudioPort, UICatalog } from './types';

class FakeAudio implements AudioPort {
  src = '';
  currentTime = 0;
  preload = '';
  play = vi.fn<() => Promise<void>>(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: 'src') => {
    if (name === 'src') this.src = '';
  });
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: 'ended' | 'error', listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'ended' | 'error', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'ended' | 'error'): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

function catalog(): UICatalog {
  const dialogue = (id: string, audioId: string) => ({
    dialogueId: id,
    order: 1,
    displayText: `${id}の本文`,
    speechText: `${id}の本文`,
    audioId,
    sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
    review: {
      candidateId: id,
      revision: 1,
      status: 'approved' as const,
      reasonCode: 'SPOKEN_DIALOGUE',
      note: '発話',
      reviewer: 'reviewer',
      reviewedAt: '2026-07-18T00:00:00Z',
      policyCheckedAt: '2026-07-18T00:00:00Z',
    },
  });
  const source = (cardId: string, suffix: string) => ({
    cardUrl: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
    textUrl: `https://www.aozora.gr.jp/cards/000879/files/${cardId === '127' ? '127_15260' : cardId === '92' ? '92_14545' : '43015_17432'}.html`,
    attribution: '底本・入力者・校正者を記録',
    baseEdition: '底本',
    inputter: '入力者',
    proofreader: '校正者',
    fetchedAt: '2026-07-18T00:00:00Z',
    transformation: '台詞抽出・構造化',
    sourceSha256: suffix.repeat(64),
  });
  return {
    schemaVersion: '1.0.0',
    author: {
      authorId: '000879', name: 'あくたがわずんのすけ', originalName: '芥川龍之介', slug: 'akutagawa-zunnosuke',
      artwork: { path: 'artwork/akutagawa-zundamon.png', alt: '文豪風の装いで本を持つ、あくたがわずんのすけのイラスト' },
    },
    works: [
      {
        workId: '000127', title: '羅生門', cardLink: 'https://www.aozora.gr.jp/cards/000879/card127.html',
        source: source('127', '1'), dialogues: [dialogue('d1', 'a1'), dialogue('d2', 'a2')],
      },
      {
        workId: '000092', title: '蜘蛛の糸', cardLink: 'https://www.aozora.gr.jp/cards/000879/card92.html',
        source: source('92', '2'), dialogues: [],
      },
      {
        workId: '043015', title: '杜子春', cardLink: 'https://www.aozora.gr.jp/cards/000879/card43015.html',
        source: source('43015', '3'), dialogues: [],
      },
    ],
    audioAssets: [
      { audioId: 'a1', path: 'audio/a1.wav', sha256: 'a'.repeat(64), bytes: 10, durationMs: 1000, configHash: 'b'.repeat(64) },
      { audioId: 'a2', path: 'audio/a2.wav', sha256: 'c'.repeat(64), bytes: 10, durationMs: 1000, configHash: 'b'.repeat(64) },
    ],
    candidateCounts: { total: 2, published: 2, editorialExcluded: 0, audioExcluded: 0, editorialReasons: {}, audioFailureReasons: {} },
    creditsRef: 'content/licenses.json',
    futureExpansionPolicy: { eligibilityCriteria: '確認', rightsRecheck: '再確認', stagedAddition: '段階追加' },
  };
}

function trigger(id: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.dataset.dialogueId = id;
  return button;
}

describe('AudioController', () => {
  let audio: FakeAudio;
  let controller: AudioController;
  const data = catalog();
  const [first, second] = data.works[0]!.dialogues;

  beforeEach(() => {
    audio = new FakeAudio();
    controller = new AudioController(data, new URL('http://localhost/bungo-zundamon/'), () => audio);
  });

  /** @des DES-F001-009 DES-F001-014 @ut UT-F001-019 */
  it('明示操作まで音声を取得せず単一Audioで対象だけを再生する', async () => {
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();

    await controller.play(first!, trigger('d1'));
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('http://localhost/bungo-zundamon/audio/a1.wav');
    expect(controller.state.status).toBe('playing');
  });

  /** @des DES-F001-009 @ut UT-F001-019 UT-F001-020 */
  it('pauseは位置を保持しresumeは同位置、stopだけが先頭へ戻す', async () => {
    await controller.play(first!, trigger('d1'));
    audio.currentTime = 12.5;
    await controller.play(first!, trigger('d1'));
    expect(controller.state.status).toBe('paused');
    expect(audio.currentTime).toBe(12.5);

    await controller.play(first!, trigger('d1'));
    expect(controller.state.status).toBe('playing');
    expect(audio.currentTime).toBe(12.5);
    expect(audio.load).toHaveBeenCalledTimes(1);

    controller.control('stop', 'd1');
    expect(controller.state.status).toBe('stopped');
    expect(audio.currentTime).toBe(0);
  });

  /** @des DES-F001-009 @ut UT-F001-019 UT-F001-020 */
  it('別台詞へ切り替える前に前音声を止めて位置を戻す', async () => {
    await controller.play(first!, trigger('d1'));
    audio.currentTime = 8;
    await controller.play(second!, trigger('d2'));

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.src).toBe('http://localhost/bungo-zundamon/audio/a2.wav');
    expect(controller.state).toMatchObject({ status: 'playing', dialogueId: 'd2' });
  });

  /** @des DES-F001-009 DES-F001-019 @ut UT-F001-021 */
  it('再生拒否を対象項目の固定日本語エラーへ隔離し内部情報を表示しない', async () => {
    audio.play.mockRejectedValueOnce(new Error('https://secret.example/audio token=secret'));
    const state = await controller.play(first!, trigger('d1'));

    expect(state).toMatchObject({ status: 'error', dialogueId: 'd1' });
    expect(state.message).toContain('音声を再生できませんでした');
    expect(state.message).not.toContain('secret');
    expect(state.message).not.toContain('http');

    audio.play.mockResolvedValueOnce(undefined);
    await controller.play(second!, trigger('d2'));
    expect(controller.state).toMatchObject({ status: 'playing', dialogueId: 'd2' });
  });

  /** @des DES-F001-009 @ut UT-F001-020 */
  it('音声終了と未知IDを安全に処理する', async () => {
    const before = controller.state;
    expect(controller.control('toggle', 'unknown')).toBe(before);
    await controller.play(first!, trigger('d1'));
    audio.emit('ended');
    expect(controller.state).toMatchObject({ status: 'ended', dialogueId: 'd1' });
  });

  /** @des DES-F001-009 @ut UT-F001-019 UT-F001-020 */
  it('loading中の同じ再生操作は二重読込せず一時停止として処理する', async () => {
    let resolvePlay: (() => void) | undefined;
    audio.play.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePlay = resolve;
    }));

    const firstPlay = controller.play(first!, trigger('d1'));
    expect(controller.state.status).toBe('loading');
    const paused = await controller.play(first!, trigger('d1'));
    expect(paused.status).toBe('paused');
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);

    resolvePlay?.();
    await firstPlay;
    expect(controller.state.status).toBe('paused');
  });

  /** @des DES-F002-008 DES-F002-013 @fun FUN-F002-024 @ut UT-F002-024 */
  it.each(['playing', 'paused', 'error', 'stopped'] as const)(
    'route変更時に%sから停止・src解除し、旧listenerをcleanupする',
    async (status) => {
      const order: string[] = [];
      let storedCurrentTime = 8;
      let storedSrc = 'http://localhost/bungo-zundamon/audio/a1.wav';
      Object.defineProperty(audio, 'currentTime', {
        configurable: true,
        get: () => storedCurrentTime,
        set: (value: number) => { order.push(`currentTime:${value}`); storedCurrentTime = value; },
      });
      Object.defineProperty(audio, 'src', {
        configurable: true,
        get: () => storedSrc,
        set: (value: string) => { order.push(`src:${value}`); storedSrc = value; },
      });
      audio.pause.mockImplementation(() => { order.push('pause'); });
      const notifications: string[] = [];
      controller.subscribe((state) => {
        notifications.push(state.status);
        if (state.status === 'stopped') order.push('stopped');
      });

      if (status !== 'stopped') {
        await controller.play(first!, trigger('d1'));
        if (status === 'paused') controller.control('toggle', 'd1');
        if (status === 'error') audio.emit('error');
      }
      order.length = 0;
      notifications.length = 0;
      const loadCalls = audio.load.mock.calls.length;
      const playCalls = audio.play.mock.calls.length;

      expect(controller.onRouteChange({ kind: 'home' })).toMatchObject({ status: 'stopped' });
      expect(order).toEqual(['pause', 'currentTime:0', 'src:', 'stopped']);
      expect(audio.removeAttribute).toHaveBeenCalledWith('src');
      expect(audio.load).toHaveBeenCalledTimes(loadCalls);
      expect(audio.play).toHaveBeenCalledTimes(playCalls);
      expect(notifications).toEqual(['stopped']);

      audio.emit('ended');
      audio.emit('error');
      expect(notifications).toEqual(['stopped']);
    },
  );

  /** @des DES-F002-008 DES-F002-013 @fun FUN-F002-024 @ut UT-F002-024 */
  it('browser Audio例外を内部codeへ隔離しroute停止とlistener cleanupを完遂する', async () => {
    await controller.play(first!, trigger('d1'));
    audio.pause.mockImplementation(() => { throw new DOMException('secret failure'); });
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => 9,
      set: () => { throw new DOMException('secret seek failure'); },
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    listener.mockClear();

    expect(() => controller.onRouteChange({ kind: 'credits' })).not.toThrow();
    expect(controller.state.status).toBe('stopped');
    expect(controller.lastDiagnosticCode).toBe('AUDIO_ROUTE_STOP_FAILED');
    expect(listener).toHaveBeenCalledTimes(1);
    audio.emit('error');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
