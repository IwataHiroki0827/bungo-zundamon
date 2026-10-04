import { describe, expect, it, vi } from 'vitest';

import { AudioController, PLAYBACK_RATES } from './audio-controller';
import type { AudioPort, CatalogDialogue, UICatalog } from './types';

class FakeAudio implements AudioPort {
  src = '';
  currentTime = 0;
  preload = '';
  playbackRate = 1;
  defaultPlaybackRate = 1;
  volume = 1;
  play = vi.fn<() => Promise<void>>(async () => undefined);
  pause = vi.fn();
  load = vi.fn(() => {
    // HTMLMediaElement.load()と同じく、再生速度を既定値へ戻す。
    this.playbackRate = this.defaultPlaybackRate;
  });
  removeAttribute = vi.fn((name: 'src') => {
    if (name === 'src') this.src = '';
  });
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: 'ended' | 'error', listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: 'ended' | 'error', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'ended' | 'error'): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

function dialogue(id: string, order: number): CatalogDialogue {
  return {
    dialogueId: id,
    order,
    displayText: `「${id}」`,
    speechText: `「${id}」`,
    audioId: `audio-${id}`,
    sourceAnchor: { bodySelector: '.main_text', startToken: order, endToken: order + 1 },
    review: {
      candidateId: id,
      revision: 1,
      status: 'approved',
      reasonCode: 'SPOKEN_DIALOGUE',
      note: '発話',
      reviewer: 'reviewer',
      reviewedAt: '2026-07-18T00:00:00Z',
      policyCheckedAt: '2026-07-18T00:00:00Z',
    },
  } as CatalogDialogue;
}

const ITEMS = [dialogue('d1', 1), dialogue('d2', 2), dialogue('d3', 3)];

function catalog(): UICatalog {
  return {
    works: [{ workId: 'w1', title: '作品', dialogues: ITEMS }],
    audioAssets: ITEMS.map((item) => ({
      audioId: item.audioId,
      path: `audio/F001/${item.audioId}.wav`,
      sha256: 'a'.repeat(64),
      bytes: 100,
      durationMs: 1000,
      configHash: 'b'.repeat(64),
    })),
  } as unknown as UICatalog;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function setup(): { audio: FakeAudio; controller: AudioController } {
  const audio = new FakeAudio();
  const controller = new AudioController(catalog(), new URL('https://example.test/bungo-zundamon/'), () => audio);
  return { audio, controller };
}

/** @des DES-F012-001 @fun FUN-F012-001 @ut UT-F012-001 */
describe('UT-F012-001 AudioController連続再生', () => {
  it('作品内の台詞を順に再生し、最後でendedへ戻る', async () => {
    const { audio, controller } = setup();
    await controller.playSequence('work:w1', ITEMS);
    expect(controller.state).toMatchObject({ status: 'playing', dialogueId: 'd1' });
    expect(controller.state.message).toContain('連続再生 1/3');
    expect(controller.sequence).toEqual({ key: 'work:w1', index: 0, total: 3 });
    audio.emit('ended');
    await flush();
    expect(controller.state).toMatchObject({ status: 'playing', dialogueId: 'd2' });
    expect(audio.src).toContain('audio-d2.wav');
    audio.emit('ended');
    await flush();
    audio.emit('ended');
    await flush();
    expect(controller.state).toMatchObject({ status: 'ended', dialogueId: 'd3', message: '連続再生が終わりました。' });
    expect(controller.sequence).toBeNull();
    expect(audio.play).toHaveBeenCalledTimes(3);
  });

  it('一時停止・再開では連続再生を保持し、停止・別台詞・route切替・エラーで解除する', async () => {
    const { audio, controller } = setup();
    await controller.playSequence('work:w1', ITEMS);
    controller.control('toggle', 'd1');
    expect(controller.state.status).toBe('paused');
    expect(controller.sequence).not.toBeNull();
    const trigger = document.createElement('button');
    trigger.dataset.dialogueId = 'd1';
    await controller.play(ITEMS[0]!, trigger);
    expect(controller.state.status).toBe('playing');
    expect(controller.sequence?.index).toBe(0);

    controller.stopSequence();
    expect(controller.sequence).toBeNull();
    expect(controller.state.status).toBe('stopped');

    await controller.playSequence('work:w1', ITEMS);
    const other = document.createElement('button');
    other.dataset.dialogueId = 'd3';
    await controller.play(ITEMS[2]!, other);
    expect(controller.sequence).toBeNull();
    audio.emit('ended');
    await flush();
    expect(controller.state).toMatchObject({ status: 'ended', dialogueId: 'd3' });

    await controller.playSequence('work:w1', ITEMS);
    controller.onRouteChange({ kind: 'home' });
    expect(controller.sequence).toBeNull();

    await controller.playSequence('work:w1', ITEMS);
    audio.emit('error');
    expect(controller.sequence).toBeNull();
    expect(controller.state.status).toBe('error');
  });

  it('未知の台詞を含む一覧・空のkeyでは開始しない', async () => {
    const { audio, controller } = setup();
    await controller.playSequence('work:w1', [...ITEMS, dialogue('unknown', 9)]);
    await controller.playSequence('', ITEMS);
    expect(controller.sequence).toBeNull();
    expect(audio.play).not.toHaveBeenCalled();
  });
});

/** @des DES-F012-004 @fun FUN-F012-009 @ut UT-F012-009 */
describe('UT-F012-009 AudioController再生速度・音量', () => {
  it('許可された速度だけを受け付け、load後も再適用する', async () => {
    const { audio, controller } = setup();
    expect(PLAYBACK_RATES).toEqual([0.75, 1, 1.25, 1.5]);
    expect(controller.setPlaybackRate(1.5).rate).toBe(1.5);
    expect(controller.setPlaybackRate(3).rate).toBe(1.5);
    expect(controller.setPlaybackRate(Number.NaN).rate).toBe(1.5);
    const trigger = document.createElement('button');
    trigger.dataset.dialogueId = 'd1';
    await controller.play(ITEMS[0]!, trigger);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.defaultPlaybackRate).toBe(1.5);
  });

  it('音量を0〜1へ丸めて適用し、非数を無視する', () => {
    const { audio, controller } = setup();
    expect(controller.setVolume(0.555).volume).toBe(0.56);
    expect(controller.setVolume(2).volume).toBe(1);
    expect(controller.setVolume(-1).volume).toBe(0);
    expect(controller.setVolume(Number.POSITIVE_INFINITY).volume).toBe(0);
    expect(audio.volume).toBe(0);
    controller.dispose();
    expect(controller.setVolume(0.5).volume).toBe(0);
  });
});
