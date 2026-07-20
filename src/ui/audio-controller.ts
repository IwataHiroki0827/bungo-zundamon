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

  readonly #handleEnded = (): void => {
    if (
      !this.#state.dialogueId ||
      this.#disposed ||
      this.#routeTransitioning ||
      !['loading', 'playing'].includes(this.#state.status)
    ) return;
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
        return presentAudioError(item.dialogueId, new Error('asset-missing'), (state) => this.#publish(state));
      }
      try {
        this.#audio.src = resolvePublicAssetV2(this.#baseUrl, asset.path).href;
        this.#audio.load();
      } catch (error) {
        return presentAudioError(item.dialogueId, error, (state) => this.#publish(state));
      }
    }

    this.#publish({
      status: 'loading',
      dialogueId: item.dialogueId,
      message: isResume ? '読み上げを再開しています。' : '音声を読み込んでいます。',
    });

    try {
      await this.#audio.play();
      if (this.#disposed || requestVersion !== this.#requestVersion) return this.#state;
      return this.#publish({
        status: 'playing',
        dialogueId: item.dialogueId,
        message: '読み上げています。',
      });
    } catch (error) {
      if (this.#disposed || requestVersion !== this.#requestVersion) return this.#state;
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
