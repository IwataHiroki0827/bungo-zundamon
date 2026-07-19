import { describe, expect, it, vi } from 'vitest';

import { observeAudioLazyLoading, type TextObserverFactory } from './lazy-loading';

describe('FUN-F001-029 音声遅延読込計画 [DES-F001-014]', () => {
  /** @ut UT-F001-029.normal */
  it('IntersectionObserverは表示テキストだけを観測し、音声取得を開始しない', () => {
    const cards = [document.createElement('article'), document.createElement('article')];
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    let callback: Parameters<TextObserverFactory>[0] | undefined;
    const factory: TextObserverFactory = (listener) => {
      callback = listener;
      return { observe, unobserve, disconnect };
    };
    const audio = document.createElement('audio');
    const load = vi.spyOn(audio, 'load');

    const plan = observeAudioLazyLoading(cards, factory);
    expect(plan).toMatchObject({ strategy: 'intersection-observer', observedCount: 2 });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(cards.every((card) => card.dataset.lazyText === 'pending')).toBe(true);
    expect(load).not.toHaveBeenCalled();

    callback?.([{ isIntersecting: true, target: cards[0]! }]);
    expect(cards[0]!.dataset.lazyText).toBe('visible');
    expect(unobserve).toHaveBeenCalledWith(cards[0]);
    expect(load).not.toHaveBeenCalled();
    plan.disconnect();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  /** @ut UT-F001-029.error.no-observer */
  it('Observer非対応や初期化例外ではテキストを即時表示し、音声へ触れない', () => {
    const card = document.createElement('article');
    const plan = observeAudioLazyLoading([card], () => {
      throw new Error('observer unavailable');
    });
    expect(plan).toMatchObject({ strategy: 'immediate-text', observedCount: 0 });
    expect(card.dataset.lazyText).toBe('visible');
    expect(card.querySelector('audio')).toBeNull();
  });
});
