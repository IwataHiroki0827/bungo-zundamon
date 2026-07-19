import type { DialogueCard, LazyLoadPlan } from './types';

export interface TextObserverPort {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export type TextObserverFactory = (
  callback: (entries: readonly Pick<IntersectionObserverEntry, 'isIntersecting' | 'target'>[]) => void,
) => TextObserverPort;

function showAll(entries: readonly DialogueCard[]): void {
  for (const entry of entries) entry.dataset.lazyText = 'visible';
}

/** @des DES-F001-014 @fun FUN-F001-029 */
export function observeAudioLazyLoading(
  entries: readonly DialogueCard[],
  observerFactory?: TextObserverFactory,
): LazyLoadPlan {
  const factory = observerFactory ?? (
    typeof IntersectionObserver === 'function'
      ? (callback) => new IntersectionObserver(callback, { rootMargin: '320px 0px' })
      : undefined
  );
  if (!factory) {
    showAll(entries);
    return Object.freeze({
      strategy: 'immediate-text' as const,
      observedCount: 0,
      disconnect: () => undefined,
    });
  }

  let observer: TextObserverPort | undefined;
  try {
    observer = factory((observed) => {
      try {
        for (const item of observed) {
          if (!item.isIntersecting || !(item.target instanceof HTMLElement)) continue;
          item.target.dataset.lazyText = 'visible';
          observer?.unobserve(item.target);
        }
      } catch {
        showAll(entries);
        observer?.disconnect();
      }
    });
    for (const entry of entries) {
      entry.dataset.lazyText = 'pending';
      observer.observe(entry);
    }
    return Object.freeze({
      strategy: 'intersection-observer' as const,
      observedCount: entries.length,
      disconnect: () => observer?.disconnect(),
    });
  } catch {
    observer?.disconnect();
    showAll(entries);
    return Object.freeze({
      strategy: 'immediate-text' as const,
      observedCount: 0,
      disconnect: () => undefined,
    });
  }
}
