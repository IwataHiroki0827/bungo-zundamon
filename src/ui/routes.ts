import type { MotionChoice, MotionMode, ParsedRoute, Route, UICatalogV2 } from './types';
import { hasAnyControlCharacter } from './text-safety.ts';

const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type { ParsedRoute } from './types';

function hasUnsafeScalar(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) as number;
    if ((point >= 0xd800 && point <= 0xdfff) || (point >= 0xfdd0 && point <= 0xfdef) || (point & 0xfffe) === 0xfffe) {
      return true;
    }
  }
  return false;
}

/** @des DES-F002-007 DES-F002-012 @fun FUN-F002-020 */
export function parseRouteV2(hash: string): ParsedRoute {
  if (hash.length === 0 || hash.length > 256 || hasAnyControlCharacter(hash) || hasUnsafeScalar(hash)) {
    return { kind: 'notFound' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash);
  } catch {
    return { kind: 'notFound' };
  }
  if (hasAnyControlCharacter(decoded) || hasUnsafeScalar(decoded)) return { kind: 'notFound' };
  if (decoded === '#/') return { kind: 'home' };
  if (decoded === '#/credits') return { kind: 'credits' };
  const segments = decoded.split('/');
  if (segments.length === 3 && segments[0] === '#' && segments[1] === 'authors' && AUTHOR_SLUG.test(segments[2] ?? '')) {
    return { kind: 'authorSlug', slug: segments[2] as string };
  }
  return { kind: 'notFound' };
}

/** @des DES-F002-007 DES-F002-008 @fun FUN-F002-021 */
export function resolveRoute(parsed: ParsedRoute, catalog: UICatalogV2): Route {
  if (parsed.kind !== 'authorSlug') return parsed;
  const authors = catalog.authors.filter((author) => author.slug === parsed.slug);
  if (authors.length !== 1 || typeof authors[0]?.authorId !== 'string' || authors[0].authorId.length === 0) {
    return { kind: 'notFound' };
  }
  return { kind: 'author', authorId: authors[0].authorId, slug: authors[0].slug };
}

/** @des DES-F001-001 @fun FUN-F001-001 */
export function parseRoute(hash: string): Route {
  if (hash === '' || hash === '#') return { kind: 'home' };
  const parsed = parseRouteV2(hash);
  if (parsed.kind === 'home' || parsed.kind === 'credits' || parsed.kind === 'notFound') return parsed;
  if (parsed.slug === 'akutagawa-zunnosuke') {
    return { kind: 'author', authorId: '000879', slug: 'akutagawa-zunnosuke' };
  }
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
