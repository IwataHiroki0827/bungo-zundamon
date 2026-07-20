import type {
  AudioAsset,
  Catalog,
  CatalogAuthor,
  CatalogAuthorV2,
  CatalogDialogue,
  CatalogV2,
  CatalogWork,
  CatalogWorkV2,
} from '../content/processing';

export type { AudioAsset, CatalogDialogue, CatalogWork };

export interface DisplayCatalogSource {
  readonly cardUrl: string;
  readonly textUrl: string;
  readonly attribution: string;
  readonly baseEdition: string;
  readonly inputter: string;
  readonly proofreader: string;
  readonly fetchedAt: string;
  readonly transformation: string;
  readonly sourceSha256: string;
}

export type DisplayWork = Omit<CatalogWork, 'source'> & {
  readonly source: DisplayCatalogSource;
};

export type DisplayAuthor = CatalogAuthor;

export type UICatalog = Omit<Catalog, 'author' | 'works'> & {
  readonly author: DisplayAuthor;
  readonly works: DisplayWork[];
};

export type DisplayAuthorV2 = CatalogAuthorV2;
export type DisplayWorkV2 = CatalogWorkV2;

export type UICatalogV2 = Omit<CatalogV2, 'authors' | 'works'> & {
  readonly authors: DisplayAuthorV2[];
  readonly works: DisplayWorkV2[];
};

export type DialogueCard = HTMLElement;

export interface LazyLoadPlan {
  readonly strategy: 'intersection-observer' | 'immediate-text';
  readonly observedCount: number;
  disconnect(): void;
}

export type ParsedRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'authorSlug'; readonly slug: string }
  | { readonly kind: 'credits' }
  | { readonly kind: 'notFound' };

export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'author'; readonly authorId: string; readonly slug: string }
  | { readonly kind: 'credits' }
  | { readonly kind: 'notFound' };

export type MotionChoice = 'full' | 'reduced';
export type MotionMode = 'full' | 'reduced';

export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'ended'
  | 'error';

export interface PlayerState {
  readonly status: PlayerStatus;
  readonly dialogueId: string | null;
  readonly message: string;
}

export interface AudioPort {
  src: string;
  currentTime: number;
  preload: string;
  removeAttribute?(name: 'src'): void;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: 'ended' | 'error', listener: EventListener): void;
  removeEventListener(type: 'ended' | 'error', listener: EventListener): void;
}

export type AudioFactory = () => AudioPort;
