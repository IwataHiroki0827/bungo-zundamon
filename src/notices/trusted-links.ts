import type { LinkPurpose, TrustedExternalLink } from './types.ts';

interface LinkPolicy {
  origin: string;
  pathPrefixes: readonly string[];
}

const LINK_POLICIES: Readonly<Record<LinkPurpose, readonly LinkPolicy[]>> = {
  aozora: [{ origin: 'https://www.aozora.gr.jp', pathPrefixes: ['/'] }],
  'aozora-card': [{ origin: 'https://www.aozora.gr.jp', pathPrefixes: ['/cards/'] }],
  'cc-by-4.0': [{ origin: 'https://creativecommons.org', pathPrefixes: ['/licenses/by/4.0/'] }],
  voicevox: [
    { origin: 'https://voicevox.hiroshiba.jp', pathPrefixes: ['/'] },
    { origin: 'https://github.com', pathPrefixes: ['/VOICEVOX/'] },
  ],
  sss: [{ origin: 'https://zunko.jp', pathPrefixes: ['/'] }],
  artwork: [
    { origin: 'https://seiga.nicovideo.jp', pathPrefixes: ['/seiga/'] },
    { origin: 'https://commons.nicovideo.jp', pathPrefixes: ['/works/'] },
    { origin: 'https://zunko.jp', pathPrefixes: ['/'] },
  ],
  dependency: [
    { origin: 'https://www.npmjs.com', pathPrefixes: ['/package/'] },
    { origin: 'https://github.com', pathPrefixes: ['/'] },
    { origin: 'https://vite.dev', pathPrefixes: ['/'] },
    { origin: 'https://vitest.dev', pathPrefixes: ['/'] },
    { origin: 'https://www.typescriptlang.org', pathPrefixes: ['/'] },
  ],
};

const PURPOSES = new Set<string>(Object.keys(LINK_POLICIES));
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function hasEncodedControlCharacter(value: string): boolean {
  return /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value);
}

function pathMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function isIpLiteral(hostname: string): boolean {
  return IPV4.test(hostname) || hostname.startsWith('[') || hostname.includes(':');
}

/** @des DES-F001-012,DES-F001-013 @fun FUN-F001-037 */
export function resolveTrustedExternalLink(value: string, purpose: LinkPurpose): TrustedExternalLink {
  if (!PURPOSES.has(purpose)) throw new TypeError('外部リンクの用途がallowlistにありません');
  if (!value || value.startsWith('//') || hasControlCharacter(value) || hasEncodedControlCharacter(value)) {
    throw new TypeError('外部リンクの形式が不正です');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('外部リンクは絶対HTTPS URLで指定してください');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    isIpLiteral(url.hostname)
  ) {
    throw new TypeError('外部リンクが安全なHTTPS URLの条件を満たしません');
  }

  const policy = LINK_POLICIES[purpose].find(
    (candidate) => url.origin === candidate.origin && candidate.pathPrefixes.some((prefix) => pathMatches(url.pathname, prefix)),
  );
  if (!policy) throw new TypeError('外部リンクのoriginまたはpathがallowlist外です');

  return Object.freeze({
    href: url.href,
    purpose,
    target: '_blank',
    rel: 'noopener noreferrer',
  });
}
