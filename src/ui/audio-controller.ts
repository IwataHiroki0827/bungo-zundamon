import { resolvePublicAssetV2 } from './catalog-loader';
import type {
  AudioFactory,
  AudioPort,
  CatalogDialogue,
  PlayerState,
  Route,
  UICatalog,
  UICatalogV2,
} from './types';

type StateListener = (state: PlayerState) => void;

/** F012: 選択可能な再生速度。session限りで保持し、端末へ保存しない。 */
export const PLAYBACK_RATES = Object.freeze([0.75, 1, 1.25, 1.5] as const);
export type PlaybackRate = typeof PLAYBACK_RATES[number];

export interface PlaybackSettings {
  readonly rate: PlaybackRate;
  readonly volume: number;
}

export interface SequenceProgress {
  readonly key: string;
  readonly index: number;
  readonly total: number;
}

interface SequenceState {
  readonly key: string;
  readonly items: readonly CatalogDialogue[];
  index: number;
}

const INITIAL_STATE: PlayerState = Object.freeze({
  status: 'idle',
  dialogueId: null,
  message: '音声は停止しています。',
});

function browserAudioFactory(): AudioPort {
  const audio = new Audio();
  audio.preload = 'none';
  return audio;
}

export function fixedAudioErrorMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
    return 'ブラウザが再生を許可しませんでした。もう一度ボタンを押してください。';
  }
  return '音声を再生できませんでした。通信状態を確認して、もう一度お試しください。';
}

/** @des DES-F001-009 DES-F001-019 @fun FUN-F001-021 */
export function presentAudioError(
  dialogueId: string,
  cause: unknown,
  notify: (state: PlayerState) => void,
): PlayerState {
  const state: PlayerState = Object.freeze({
    status: 'error',
    dialogueId,
    message: fixedAudioErrorMessage(cause),
  });
  notify(state);
  return state;
}

/** @des DES-F001-009 DES-F001-014 @fun FUN-F001-019 FUN-F001-020 */
export class AudioController {
  readonly #audio: AudioPort;
  readonly #assetById: ReadonlyMap<string, UICatalog['audioAssets'][number]>;
  readonly #dialogueById: ReadonlyMap<string, CatalogDialogue>;
  readonly #baseUrl: URL;
  readonly #listeners = new Set<StateListener>();
  #state: PlayerState = INITIAL_STATE;
  #requestVersion = 0;
  #disposed = false;
  #routeTransitioning = false;
  #lastDiagnosticCode: 'AUDIO_ROUTE_STOP_FAILED' | null = null;
  #sequence: SequenceState | null = null;
  #advancing = false;
  #settings: PlaybackSettings = Object.freeze({ rate: 1 as PlaybackRate, volume: 1 });

  readonly #handleEnded = (): void => {
    if (
      !this.#state.dialogueId ||
      this.#disposed ||
      this.#routeTransitioning ||
      !['loading', 'playing'].includes(this.#state.status)
    ) return;
    const sequence = this.#sequence;
    if (sequence && sequence.items[sequence.index]?.dialogueId === this.#state.dialogueId) {
      const next = sequence.items[sequence.index + 1];
      if (next) {
        sequence.index += 1;
        void this.#playSequenceItem(next);
        return;
      }
      this.#sequence = null;
      this.#publish({
        status: 'ended',
        dialogueId: this.#state.dialogueId,
        message: '連続再生が終わりました。',
      });
      return;
    }
    this.#publish({
      status: 'ended',
      dialogueId: this.#state.dialogueId,
      message: '読み上げが終わりました。',
    });
  };

  readonly #handleError = (): void => {
    if (
      !this.#state.dialogueId ||
      this.#disposed ||
      this.#routeTransitioning ||
      !['loading', 'playing'].includes(this.#state.status)
    ) return;
    this.#sequence = null;
    presentAudioError(this.#state.dialogueId, new Error('media-error'), (state) => this.#publish(state));
  };

  constructor(catalog: UICatalog | UICatalogV2, baseUrl: URL, audioFactory: AudioFactory = browserAudioFactory) {
    this.#baseUrl = new URL(baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
    this.#assetById = new Map(catalog.audioAssets.map((asset) => [asset.audioId, asset]));
    this.#dialogueById = new Map(
      catalog.works.flatMap((work) => work.dialogues.map((dialogue) => [dialogue.dialogueId, dialogue] as const)),
    );
    this.#audio = audioFactory();
    this.#audio.preload = 'none';
    this.#audio.addEventListener('ended', this.#handleEnded);
    this.#audio.addEventListener('error', this.#handleError);
  }

  get state(): PlayerState {
    return this.#state;
  }

  get lastDiagnosticCode(): 'AUDIO_ROUTE_STOP_FAILED' | null {
    return this.#lastDiagnosticCode;
  }

  /** @des DES-F012-001 @fun FUN-F012-001 */
  get sequence(): SequenceProgress | null {
    const sequence = this.#sequence;
    return sequence
      ? Object.freeze({ key: sequence.key, index: sequence.index, total: sequence.items.length })
      : null;
  }

  /** @des DES-F012-004 @fun FUN-F012-009 */
  get playbackSettings(): PlaybackSettings {
    return this.#settings;
  }

  /**
   * 作品内の台詞を先頭から順に自動再生する。明示操作(ボタン押下)を起点とし、
   * 別台詞の再生・停止・route切替・エラーで連続再生を解除する。
   * @des DES-F012-001 @fun FUN-F012-001
   */
  async playSequence(key: string, items: readonly CatalogDialogue[]): Promise<PlayerState> {
    if (this.#disposed || key.length === 0) return this.#state;
    const playable = items.filter((item) => this.#dialogueById.has(item.dialogueId));
    if (playable.length === 0 || playable.length !== items.length) return this.#state;
    this.#sequence = { key, items: Object.freeze([...playable]), index: 0 };
    return this.#playSequenceItem(playable[0]!);
  }

  /** 連続再生を解除して現在の音声を停止する。 @des DES-F012-001 @fun FUN-F012-001 */
  stopSequence(): PlayerState {
    if (!this.#sequence) return this.#state;
    this.#sequence = null;
    return this.control('stop');
  }

  /** @des DES-F012-004 @fun FUN-F012-009 */
  setPlaybackRate(rate: number): PlaybackSettings {
    if (this.#disposed || !(PLAYBACK_RATES as readonly number[]).includes(rate)) return this.#settings;
    this.#settings = Object.freeze({ ...this.#settings, rate: rate as PlaybackRate });
    this.#applySettings();
    return this.#settings;
  }

  /** @des DES-F012-004 @fun FUN-F012-009 */
  setVolume(volume: number): PlaybackSettings {
    if (this.#disposed || !Number.isFinite(volume)) return this.#settings;
    const clamped = Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
    this.#settings = Object.freeze({ ...this.#settings, volume: clamped });
    this.#applySettings();
    return this.#settings;
  }

  #applySettings(): void {
    try {
      this.#audio.defaultPlaybackRate = this.#settings.rate;
      this.#audio.playbackRate = this.#settings.rate;
      this.#audio.volume = this.#settings.volume;
    } catch {
      // 速度・音量に未対応の環境でも再生自体は継続する。
    }
  }

  async #playSequenceItem(item: CatalogDialogue): Promise<PlayerState> {
    const trigger = document.createElement('button');
    trigger.dataset.dialogueId = item.dialogueId;
    this.#advancing = true;
    try {
      // 同じ台詞が連続した場合も先頭から読み直すため、一度停止状態へ戻す。
      if (this.#state.dialogueId === item.dialogueId) {
        this.#state = Object.freeze({ ...this.#state, status: 'stopped' });
      }
      return await this.play(item, trigger);
    } finally {
      this.#advancing = false;
    }
  }

  #sequenceMessage(base: string): string {
    const sequence = this.#sequence;
    return sequence ? `${base}（連続再生 ${sequence.index + 1}/${sequence.items.length}）` : base;
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  /** @des DES-F001-009 DES-F001-014 DES-F001-015 @fun FUN-F001-019 */
  async play(item: CatalogDialogue, trigger: HTMLButtonElement): Promise<PlayerState> {
    if (
      this.#disposed ||
      trigger.tagName !== 'BUTTON' ||
      trigger.dataset.dialogueId !== item.dialogueId ||
      !this.#dialogueById.has(item.dialogueId)
    ) {
      return this.#state;
    }

    if (
      !this.#advancing &&
      this.#sequence &&
      this.#sequence.items[this.#sequence.index]?.dialogueId !== item.dialogueId
    ) {
      // 連続再生中に別の台詞を明示再生した場合は、連続再生を解除する。
      this.#sequence = null;
    }

    if (
      this.#state.dialogueId === item.dialogueId &&
      (this.#state.status === 'playing' || this.#state.status === 'loading')
    ) {
      return this.control('toggle', item.dialogueId);
    }

    const isResume = this.#state.dialogueId === item.dialogueId && this.#state.status === 'paused';
    const requestVersion = ++this.#requestVersion;

    if (!isResume) {
      this.#audio.pause();
      this.#audio.currentTime = 0;
      const asset = this.#assetById.get(item.audioId);
      if (!asset) {
        this.#sequence = null;
        return presentAudioError(item.dialogueId, new Error('asset-missing'), (state) => this.#publish(state));
      }
      try {
        this.#audio.src = resolvePublicAssetV2(this.#baseUrl, asset.path).href;
        this.#audio.load();
        // load()はplaybackRateをdefaultPlaybackRateへ戻すため、選択中の設定を再適用する。
        this.#applySettings();
      } catch (error) {
        this.#sequence = null;
        return presentAudioError(item.dialogueId, error, (state) => this.#publish(state));
      }
    }

    this.#publish({
      status: 'loading',
      dialogueId: item.dialogueId,
      message: this.#sequenceMessage(isResume ? '読み上げを再開しています。' : '音声を読み込んでいます。'),
    });

    try {
      await this.#audio.play();
      if (this.#disposed || requestVersion !== this.#requestVersion) return this.#state;
      return this.#publish({
        status: 'playing',
        dialogueId: item.dialogueId,
        message: this.#sequenceMessage('読み上げています。'),
      });
    } catch (error) {
      if (this.#disposed || requestVersion !== this.#requestVersion) return this.#state;
      this.#sequence = null;
      return presentAudioError(item.dialogueId, error, (state) => this.#publish(state));
    }
  }

  /** @des DES-F001-009 @fun FUN-F001-020 */
  control(action: 'toggle' | 'stop', dialogueId?: string): PlayerState {
    if (this.#disposed) return this.#state;
    if (dialogueId !== undefined && !this.#dialogueById.has(dialogueId)) return this.#state;
    if (dialogueId !== undefined && this.#state.dialogueId !== dialogueId) return this.#state;
    if (!this.#state.dialogueId) return this.#state;

    if (action === 'stop') {
      this.#sequence = null;
      this.#requestVersion += 1;
      this.#audio.pause();
      this.#audio.currentTime = 0;
      return this.#publish({
        status: 'stopped',
        dialogueId: this.#state.dialogueId,
        message: '読み上げを停止しました。',
      });
    }

    if (this.#state.status === 'playing' || this.#state.status === 'loading') {
      this.#requestVersion += 1;
      this.#audio.pause();
      return this.#publish({
        status: 'paused',
        dialogueId: this.#state.dialogueId,
        message: '読み上げを一時停止しました。',
      });
    }

    if (this.#state.status === 'paused') {
      const item = this.#dialogueById.get(this.#state.dialogueId);
      if (item) {
        const syntheticTrigger = document.createElement('button');
        syntheticTrigger.dataset.dialogueId = item.dialogueId;
        void this.play(item, syntheticTrigger);
      }
    }
    return this.#state;
  }

  stop(reason?: 'route-change'): PlayerState {
    if (reason === 'route-change') return this.#stopForRouteChange();
    return this.control('stop');
  }

  /** @des DES-F002-008 DES-F002-013 @fun FUN-F002-024 */
  onRouteChange(next: Route): PlayerState {
    void next;
    return this.stop('route-change');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#sequence = null;
    this.#requestVersion += 1;
    this.#audio.pause();
    this.#audio.currentTime = 0;
    this.#audio.removeEventListener('ended', this.#handleEnded);
    this.#audio.removeEventListener('error', this.#handleError);
    this.#listeners.clear();
    this.#disposed = true;
  }

  #publish(next: PlayerState): PlayerState {
    this.#state = Object.freeze({ ...next });
    for (const listener of this.#listeners) listener(this.#state);
    return this.#state;
  }

  #stopForRouteChange(): PlayerState {
    if (this.#disposed) return this.#state;
    this.#sequence = null;
    this.#requestVersion += 1;
    this.#routeTransitioning = true;
    this.#lastDiagnosticCode = null;
    let failed = false;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch {
        failed = true;
      }
    };

    // 順序はroute lifecycleの契約。途中のbrowser例外でも後続cleanupを必ず行う。
    attempt(() => this.#audio.pause());
    attempt(() => { this.#audio.currentTime = 0; });
    attempt(() => {
      // HTMLMediaElementでは空文字の代入が現在文書へのrequestになる実装があるため、
      // productionでは属性自体を外す。軽量test adapterだけ後方互換の代入を使う。
      if (typeof this.#audio.removeAttribute === 'function') this.#audio.removeAttribute('src');
      else this.#audio.src = '';
    });

    const stopped: PlayerState = Object.freeze({
      status: 'stopped',
      dialogueId: this.#state.dialogueId,
      message: '画面の切り替えに伴い、読み上げを停止しました。',
    });
    this.#state = stopped;
    for (const listener of this.#listeners) {
      try {
        listener(stopped);
      } catch {
        // 古い画面側の例外をnavigationへ伝播させない。
      }
    }
    this.#listeners.clear();
    this.#routeTransitioning = false;
    if (failed) this.#lastDiagnosticCode = 'AUDIO_ROUTE_STOP_FAILED';
    return stopped;
  }
}
