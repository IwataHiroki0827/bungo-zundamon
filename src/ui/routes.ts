import type { MotionChoice, MotionMode, Route } from './types';
import { hasAnyControlCharacter } from './text-safety';

const AUTHOR_ROUTE = '#/authors/akutagawa-zunnosuke';

/** @des DES-F001-001 @fun FUN-F001-001 */
export function parseRoute(hash: string): Route {
  if (hash.length > 256 || hasAnyControlCharacter(hash)) return { kind: 'notFound' };

  let decoded: string;
  try {
    decoded = decodeURIComponent(hash || '#/');
  } catch {
    return { kind: 'notFound' };
  }

  if (decoded === '' || decoded === '#' || decoded === '#/') return { kind: 'home' };
  if (decoded === AUTHOR_ROUTE) return { kind: 'author', slug: 'akutagawa-zunnosuke' };
  if (decoded === '#/credits') return { kind: 'credits' };
  return { kind: 'notFound' };
}

/** @des DES-F001-011 @fun FUN-F001-025 */
export function resolveMotionPreference(
  media: Pick<MediaQueryList, 'matches'>,
  sessionChoice?: MotionChoice,
): MotionMode {
  try {
    return media.matches || sessionChoice === 'reduced' ? 'reduced' : 'full';
  } catch {
    return 'reduced';
  }
}
