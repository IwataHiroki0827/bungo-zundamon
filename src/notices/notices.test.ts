import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  REQUIRED_NOTICE_TEXT,
  loadReleaseNoticeBundle,
  renderCredits,
  renderCreditsV2,
  resolveTrustedExternalLink,
  validateReleaseNotices,
  type ArtworkProvenanceManifest,
  type ArtworkCreditManifest,
  type LicenseManifest,
} from './index';
import type { UICatalogV2 } from '../ui/types';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CHECKED_AT = '2026-07-01T00:00:00Z';
const VALID_UNTIL = '2026-08-01T00:00:00Z';

interface MutableArtworkBundleFixture {
  schemaVersion: string;
  artworks: Array<{
    authorId: string;
    batchId: string;
    manifestId: string;
    provenanceRef: string;
    provenanceSha256: string;
    output: { path: string; sha256: string };
  }>;
}

function fixture(): { manifest: LicenseManifest; artwork: ArtworkProvenanceManifest } {
  const artwork: ArtworkProvenanceManifest = {
    schemaVersion: '1.0.0',
    manifestId: 'artwork-F001-001',
    creationMethod: 'authorized-source-edit',
    inputAllowlist: ['zundamon-standing'],
    inputs: [
      {
        id: 'zundamon-standing',
        sourcePage: 'https://seiga.nicovideo.jp/seiga/im11206626',
        distributionUrl: 'https://ux.getuploader.com/s_ahiru/download/59',
        distributionVersion: 'V3.2',
        downloadedAt: CHECKED_AT,
        archiveSha256: HASH_B,
        archiveEntry: 'ずんだもん立ち絵素材V3.2/ずんだもん立ち絵素材V3.2_基本版.psd',
        bundledReadmeSha256: HASH_A,
        sha256: HASH_A,
      },
    ],
    editorSource: 'zundamon-standing',
    transformations: ['文豪風の衣装・紙・墨の意匠を追加', 'Web向けPNGへ書き出し'],
    output: { path: 'artwork/akutagawa-zundamon.png', sha256: HASH_B },
    specificAkutagawaPhotographUsed: false,
    usesSakamotoArtworkAsInput: true,
    artistStyleImitated: false,
    reviewer: '権利確認者',
    reviewedAt: CHECKED_AT,
  };
  const manifest: LicenseManifest = {
    schemaVersion: '1.0.0',
    notices: {
      ...REQUIRED_NOTICE_TEXT,
      contactPolicy: '問い合わせ先はリポジトリのIssue案内に掲載します。入力フォームは設置しません。',
    },
    bibliographyLicense: {
      name: 'CC BY 4.0',
      scope: 'bibliography-only',
      attribution: '青空文庫の書誌データを利用しています。',
      changeNotice: '初期公開対象3作品へ絞り、公開表示用に項目を整形しました。',
      bodyCovered: false,
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    externalLinks: [
      { label: '青空文庫', purpose: 'aozora', url: 'https://www.aozora.gr.jp/' },
      { label: 'VOICEVOX', purpose: 'voicevox', url: 'https://voicevox.hiroshiba.jp/' },
      { label: 'キャラクター利用ガイドライン', purpose: 'sss', url: 'https://zunko.jp/guideline.html' },
      { label: '立ち絵：坂本アヒル', purpose: 'artwork', url: 'https://seiga.nicovideo.jp/seiga/im11206626' },
    ],
    materials: {
      readmeVersion: '2026-07-01',
      readmeSha256: HASH_A,
      originalPsdIncluded: false,
      artworkProvenance: {
        manifestId: artwork.manifestId,
        outputSha256: artwork.output.sha256,
        creationMethod: artwork.creationMethod,
        specificAkutagawaPhotographUsed: artwork.specificAkutagawaPhotographUsed,
        usesSakamotoArtworkAsInput: artwork.usesSakamotoArtworkAsInput,
        artistStyleImitated: artwork.artistStyleImitated,
        reviewer: artwork.reviewer,
        reviewedAt: artwork.reviewedAt,
      },
    },
    dependencies: [
      {
        name: 'Vite',
        notice: 'MIT License',
        link: { label: 'Vite', purpose: 'dependency', url: 'https://vite.dev/' },
      },
    ],
    commercial: { free: true, advertising: false, payments: false, tracking: false, forms: false },
    jurisdictionBasis: 'JP',
    terms: {
      url: 'https://zunko.jp/guideline.html',
      checkedAt: CHECKED_AT,
      validUntil: VALID_UNTIL,
      reviewer: '権利確認者',
    },
  };
  return { manifest, artwork };
}

function catalogV2Fixture(): UICatalogV2 {
  const authors = [
    ['000879', 'あくたがわずんのすけ', '芥川龍之介', 'akutagawa-zunnosuke', HASH_B],
    ['000081', 'みやざわずんじ', '宮沢賢治', 'miyazawa-zunji', 'c'.repeat(64)],
  ].map(([authorId, name, originalName, slug, sha256], index) => ({
    authorId: authorId!, name: name!, originalName: originalName!, slug: slug!,
    artwork: { path: `artwork/${index === 0 ? 'akutagawa' : 'miyazawa'}-zundamon.png`, alt: `${name}の画像`, sha256: sha256! },
    introducedByBatchId: `F00${index + 1}`,
    identitySha256: `${index + 1}`.repeat(64),
  }));
  const works = [
    ['000127', '000879', 'F001', '羅生門<script>alert(1)</script>', '127'],
    ['000473', '000081', 'F002', 'よだかの星', '473'],
  ].map(([workId, authorId, batchId, title, cardId], index) => ({
    workId: workId!, authorId: authorId!, batchId: batchId!, title: title!,
    cardLink: `https://www.aozora.gr.jp/cards/${authorId}/card${cardId}.html`,
    source: {
      cardUrl: `https://www.aozora.gr.jp/cards/${authorId}/card${cardId}.html`,
      textUrl: `https://www.aozora.gr.jp/cards/${authorId}/files/${cardId}.html`,
      attribution: '青空文庫の作品本文', baseEdition: '底本', inputter: '入力者', proofreader: '校正者',
      fetchedAt: CHECKED_AT, transformation: '台詞抽出・構造化', sourceSha256: `${index + 1}`.repeat(64),
      provenancePath: `content/provenance/${batchId}/${workId}.json`, provenanceSha256: 'd'.repeat(64),
    },
    dialogues: [],
  }));
  return {
    schemaVersion: '2.0.0', authors, works, audioAssets: [],
    batches: authors.map((author, index) => ({
      batchId: `F00${index + 1}`, feature: `F00${index + 1}`, status: 'published', authorId: author.authorId,
      workIds: [works[index]!.workId], acceptedAt: CHECKED_AT, publishedAt: CHECKED_AT, evidenceSha256: 'e'.repeat(64),
    })),
    candidateCounts: {
      total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0,
      byBatch: {
        F001: { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0 },
        F002: { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0 },
      },
    },
    creditsRef: 'content/licenses.json',
  };
}

function jsonWithExactBytes(value: unknown, bytes: number): string {
  const json = JSON.stringify(value);
  const length = new TextEncoder().encode(json).byteLength;
  if (length > bytes) throw new Error('test-json-too-large');
  return `${json}${' '.repeat(bytes - length)}`;
}

function shaText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectDeepFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value as Record<string, unknown>)) expectDeepFrozen(nested);
}

describe('FUN-F001-037 外部リンクallowlist [DES-F001-012][DES-F001-013][UT-F001-037]', () => {
  it.each([
    ['https://www.aozora.gr.jp/', 'aozora'],
    ['https://www.aozora.gr.jp/cards/', 'aozora-card'],
    ['https://creativecommons.org/licenses/by/4.0/', 'cc-by-4.0'],
    ['https://voicevox.hiroshiba.jp/', 'voicevox'],
    ['https://zunko.jp/guideline.html', 'sss'],
    ['https://seiga.nicovideo.jp/seiga/im10788496', 'artwork'],
    ['https://seiga.nicovideo.jp/seiga/im11206626', 'artwork'],
    ['https://vite.dev/', 'dependency'],
  ] as const)('用途別の固定origin/pathを許可する: %s', (url, purpose) => {
    expect(resolveTrustedExternalLink(url, purpose)).toEqual({
      href: url,
      purpose,
      target: '_blank',
      rel: 'noopener noreferrer',
    });
  });

  it.each([
    'http://www.aozora.gr.jp/',
    'javascript:alert(1)',
    '//www.aozora.gr.jp/',
    'https://127.0.0.1/cards/',
    'https://evil.example/cards/',
    'https://www.aozora.gr.jp/index.html#https://evil.example/',
    'https://www.aozora.gr.jp/%0aevil',
    'https://user:pass@www.aozora.gr.jp/',
    'https://www.aozora.gr.jp:444/',
  ])('危険なURLを拒否する: %s', (url) => {
    expect(() => resolveTrustedExternalLink(url, 'aozora')).toThrow();
  });

  it('用途とpathの取り違えを拒否する', () => {
    expect(() => resolveTrustedExternalLink('https://www.aozora.gr.jp/index.html', 'aozora-card')).toThrow();
  });
});

describe('FUN-F001-038 リリース権利表示 [DES-F001-011][DES-F001-012][DES-F001-013][DES-F001-018]', () => {
  it('全権利表示・画像由来が揃い、期限instant以下なら検証済みmanifestを返す', () => {
    const { manifest, artwork } = fixture();
    const result = validateReleaseNotices(manifest, artwork, new Date(VALID_UNTIL));
    expect(result).toMatchObject({ ok: true, success: true, value: manifest });
  });

  it('期限を1ms超過した場合は公開不可にする', () => {
    const { manifest, artwork } = fixture();
    const result = validateReleaseNotices(manifest, artwork, new Date(Date.parse(VALID_UNTIL) + 1));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ code: 'terms-expired' }));
  });

  it.each([
    ['日本法基準なし', (manifest: LicenseManifest) => Object.assign(manifest, { jurisdictionBasis: 'US' })],
    ['本文へのCC BY誤適用', (manifest: LicenseManifest) => Object.assign(manifest.bibliographyLicense, { bodyCovered: true })],
    ['広告あり', (manifest: LicenseManifest) => Object.assign(manifest.commercial, { advertising: true })],
    ['国外免責の改変', (manifest: LicenseManifest) => Object.assign(manifest.notices, { jurisdiction: '日本法基準です' })],
  ])('%sを補完せず拒否する', (_label, mutate) => {
    const { manifest, artwork } = fixture();
    mutate(manifest);
    expect(validateReleaseNotices(manifest, artwork, new Date(CHECKED_AT)).ok).toBe(false);
  });

  it('allowlist外入力と画像参照hash不一致を拒否する', () => {
    const { manifest, artwork } = fixture();
    artwork.inputs[0]!.sourcePage = 'https://evil.example/input.png';
    manifest.materials.artworkProvenance.outputSha256 = 'c'.repeat(64);
    const result = validateReleaseNotices(manifest, artwork, new Date(CHECKED_AT));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['artwork-source-untrusted', 'artwork-reference-mismatch']),
      );
    }
  });
});

describe('FUN-F001-026 notice bundle読込 [DES-F001-012][DES-F001-013][DES-F001-015]', () => {
  it('同一Pages baseから同じAbortSignalでJSON 2件を読み、検証後にfreezeする', async () => {
    const { manifest, artwork } = fixture();
    const signal = new AbortController().signal;
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    const seenOptions: RequestInit[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seenSignals.push(init?.signal);
      seenOptions.push(init ?? {});
      if (String(input).endsWith('/artwork-provenances.json')) {
        return new Response('', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      const value = String(input).endsWith('/licenses.json') ? manifest : artwork;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    };

    const bundle = await loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      fetcher as typeof fetch,
      signal,
    );

    expect(seenSignals).toEqual([signal, signal, signal]);
    expect(seenOptions.every((options) => options.redirect === 'error')).toBe(true);
    expect(seenOptions.every((options) => options.credentials === 'same-origin')).toBe(true);
    expectDeepFrozen(bundle.license);
    expectDeepFrozen(bundle.artwork);
    expect(Reflect.set(bundle.license.notices, 'voicevox', '改ざん')).toBe(false);
    expect(bundle.license.notices.voicevox).toBe(REQUIRED_NOTICE_TEXT.voicevox);
  });

  it('JSON以外のmedia typeとabortをfail-closedで区別する', async () => {
    const textFetcher = async (): Promise<Response> => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      textFetcher as typeof fetch,
    )).rejects.toThrow('notice-load-media-type-error');

    const abort = new AbortController();
    abort.abort();
    const abortingFetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBe(abort.signal);
      throw new DOMException('aborted', 'AbortError');
    };
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      abortingFetcher as typeof fetch,
      abort.signal,
    )).rejects.toThrow('notice-load-aborted');
  });

  it('全作者の集約manifestと参照元provenanceをSHA・author・pathまで検証する', async () => {
    const { manifest, artwork } = fixture();
    const legacyText = JSON.stringify(artwork);
    const second = {
      schemaVersion: '2.0.0',
      manifestId: 'artwork-F002-000081-v1',
      batchId: 'F002',
      authorId: '000081',
      credit: '宮沢賢治ずんだもん：独自生成',
      output: { publicPath: 'artwork/miyazawa-zundamon.png', sha256: 'c'.repeat(64) },
    };
    const secondText = JSON.stringify(second);
    const bundle = {
      schemaVersion: '1.0.0',
      artworks: [
        {
          authorId: '000879', batchId: 'F001', manifestId: artwork.manifestId,
          provenanceRef: 'content/artwork-provenance.json', provenanceSha256: shaText(legacyText),
          output: artwork.output,
        },
        {
          authorId: '000081', batchId: 'F002', manifestId: second.manifestId,
          provenanceRef: 'content/artwork-provenance/F002.json', provenanceSha256: shaText(secondText),
          output: { path: second.output.publicPath, sha256: second.output.sha256 },
        },
      ],
    };
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      const text = path.endsWith('/licenses.json') ? JSON.stringify(manifest)
        : path.endsWith('/artwork-provenances.json') ? JSON.stringify(bundle)
        : path.endsWith('/artwork-provenance/F002.json') ? secondText
        : legacyText;
      return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    };
    const loaded = await loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      fetcher as typeof fetch,
    );
    expect(loaded.artworks?.map((entry) => entry.authorId)).toEqual(['000879', '000081']);
    expectDeepFrozen(loaded.artworks);
  });

  it.each([
    ['author不一致', (bundle: MutableArtworkBundleFixture) => { bundle.artworks[1]!.authorId = '000999'; }],
    ['危険path', (bundle: MutableArtworkBundleFixture) => { bundle.artworks[1]!.provenanceRef = '../F002.json'; }],
    ['作者重複', (bundle: MutableArtworkBundleFixture) => { bundle.artworks[1]!.authorId = '000879'; }],
    ['参照SHA不一致', (bundle: MutableArtworkBundleFixture) => { bundle.artworks[1]!.provenanceSha256 = 'f'.repeat(64); }],
  ])('集約画像provenanceの%sを部分採用せず拒否する', async (_label, mutate) => {
    const { manifest, artwork } = fixture();
    const legacyText = JSON.stringify(artwork);
    const second = {
      schemaVersion: '2.0.0', manifestId: 'artwork-F002-000081-v1', batchId: 'F002', authorId: '000081',
      credit: '宮沢賢治ずんだもん：独自生成',
      output: { publicPath: 'artwork/miyazawa-zundamon.png', sha256: 'c'.repeat(64) },
    };
    const secondText = JSON.stringify(second);
    const bundle: MutableArtworkBundleFixture = {
      schemaVersion: '1.0.0',
      artworks: [
        {
          authorId: '000879', batchId: 'F001', manifestId: artwork.manifestId,
          provenanceRef: 'content/artwork-provenance.json', provenanceSha256: shaText(legacyText), output: artwork.output,
        },
        {
          authorId: '000081', batchId: 'F002', manifestId: second.manifestId,
          provenanceRef: 'content/artwork-provenance/F002.json', provenanceSha256: shaText(secondText),
          output: { path: second.output.publicPath, sha256: second.output.sha256 },
        },
      ],
    };
    mutate(bundle);
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      const text = path.endsWith('/licenses.json') ? JSON.stringify(manifest)
        : path.endsWith('/artwork-provenances.json') ? JSON.stringify(bundle)
        : path.endsWith('/artwork-provenance/F002.json') ? secondText
        : legacyText;
      return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    };
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      fetcher as typeof fetch,
    )).rejects.toThrow(/^notice-artwork-/);
  });

  it('size上限超過とschema不正を部分採用せず拒否する', async () => {
    const tooLargeFetcher = async (): Promise<Response> => new Response(`{"padding":"${'a'.repeat(262_145)}"}`, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      tooLargeFetcher as typeof fetch,
    )).rejects.toThrow('notice-load-size-error');

    const invalidFetcher = async (): Promise<Response> => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      invalidFetcher as typeof fetch,
    )).rejects.toThrow('notice-validation-error');
  });

  it('256KiBちょうどを受理し、1 byte超過を拒否する', async () => {
    const { manifest, artwork } = fixture();
    const exactFetcher = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith('/artwork-provenances.json')) {
        return new Response('', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      const value = String(input).endsWith('/licenses.json') ? manifest : artwork;
      return new Response(jsonWithExactBytes(value, 262_144), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      exactFetcher as typeof fetch,
    )).resolves.toMatchObject({ license: { jurisdictionBasis: 'JP' } });

    const overFetcher = async (): Promise<Response> => new Response(jsonWithExactBytes({}, 262_145), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      overFetcher as typeof fetch,
    )).rejects.toThrow('notice-load-size-error');
  });

  it('不正UTF-8とstream読込途中のabortを拒否する', async () => {
    const invalidUtf8Fetcher = async (): Promise<Response> => new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      invalidUtf8Fetcher as typeof fetch,
    )).rejects.toThrow('notice-load-format-error');

    const abort = new AbortController();
    const streamingFetcher = async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b]));
        queueMicrotask(() => {
          abort.abort();
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(loadReleaseNoticeBundle(
      new URL('/bungo-zundamon/', location.origin),
      new Date(CHECKED_AT),
      streamingFetcher as typeof fetch,
      abort.signal,
    )).rejects.toThrow('notice-load-aborted');
  });
});

describe('FUN-F001-026 クレジット描画 [DES-F001-012][DES-F001-018]', () => {
  const catalog = {
    works: [
      ['羅生門', '127'],
      ['蜘蛛の糸', '92'],
      ['杜子春', '43015'],
    ].map(([title, cardId]) => ({
      title: title!,
      cardLink: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
      source: {
        cardUrl: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
        attribution: '青空文庫の作品本文',
        baseEdition: `${title}の底本`,
        inputter: '入力者',
        proofreader: '校正者',
        fetchedAt: CHECKED_AT,
        transformation: '台詞抽出・構造化',
      },
    })),
  };

  it('検証済みmanifestだけから必須表示と安全なリンクを描画する', () => {
    const { manifest, artwork } = fixture();
    const validated = validateReleaseNotices(manifest, artwork, new Date(CHECKED_AT));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const page = renderCredits(catalog, validated.value);
    expect(page.textContent).toContain(REQUIRED_NOTICE_TEXT.voicevox);
    expect(page.textContent).toContain('立ち絵：坂本アヒル');
    expect(page.textContent).toContain('作品本文には適用されません');
    expect(page.textContent).toContain('日本国外での権利状態を一律に保証しません');
    expect(page.textContent).toContain('ずんだもん立ち絵素材V3.2');
    expect(page.textContent).toContain('底本: 羅生門の底本');
    expect(page.textContent).toContain('入力者: 入力者');
    expect(page.textContent).toContain('校正者: 校正者');
    expect(page.textContent).toContain('加工内容: 台詞抽出・構造化');
    expect(page.textContent).toContain('特定の芥川龍之介写真は使用していません');
    expect(Array.from(page.querySelectorAll('a')).every((link) => link.rel === 'noopener noreferrer')).toBe(true);
  });

  it('brandを持たない未検証manifestは描画しない', () => {
    const { manifest } = fixture();
    expect(() => renderCredits(catalog, manifest)).toThrow(/検証済み/);
  });

  it('3作品または底本・入力者・校正者・取得日・加工内容が欠けたcatalogを拒否する', () => {
    const { manifest, artwork } = fixture();
    const validated = validateReleaseNotices(manifest, artwork, new Date(CHECKED_AT));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(() => renderCredits({ works: [] }, validated.value)).toThrow(/3作品/);

    const missing = structuredClone(catalog);
    missing.works[0]!.source.inputter = '';
    expect(() => renderCredits(missing, validated.value)).toThrow(/由来情報/);
  });
});

describe('FUN-F002-025 複数作者クレジット [DES-F002-009][DES-F002-010][DES-F002-012][DES-F002-013][UT-F002-025]', () => {
  function validatedBundle(validUntil = VALID_UNTIL) {
    const { manifest, artwork } = fixture();
    manifest.terms.validUntil = validUntil;
    const artworks: ArtworkCreditManifest[] = [
      {
        authorId: '000879', batchId: 'F001', manifestId: artwork.manifestId,
        provenanceRef: 'content/artwork-provenance.json', provenanceSha256: '9'.repeat(64),
        output: artwork.output,
      },
      {
        authorId: '000081', batchId: 'F002', manifestId: 'artwork-F002-001',
        provenanceRef: 'content/artwork-provenance/F002.json', provenanceSha256: '8'.repeat(64),
        output: { path: 'artwork/miyazawa-zundamon.png', sha256: 'c'.repeat(64) },
      },
    ];
    const validated = validateReleaseNotices(manifest, artwork, new Date(CHECKED_AT));
    if (!validated.ok) throw new Error('fixture-validation-failed');
    return { license: validated.value, artwork, artworks } as const;
  }

  it('全作者・全作品・由来・規約・必須免責を安全なDOMへ描画する', () => {
    const page = renderCreditsV2(catalogV2Fixture(), validatedBundle());
    expect(page.textContent).toContain('あくたがわずんのすけ（原著者: 芥川龍之介）');
    expect(page.textContent).toContain('みやざわずんじ（原著者: 宮沢賢治）');
    expect(page.textContent).toContain('底本: 底本');
    expect(page.textContent).toContain('入力者: 入力者');
    expect(page.textContent).toContain('校正者: 校正者');
    expect(page.textContent).toContain('加工内容: 台詞抽出・構造化');
    expect(page.textContent).toContain('VOICEVOX:ずんだもん');
    expect(page.textContent).toContain('非公式ファンサイト');
    expect(page.textContent).toContain('広告・スポンサー・課金はありません');
    expect(page.textContent).toContain('日本国外での権利状態を一律に保証しません');
    expect(page.textContent).toContain('<script>alert(1)</script>');
    expect(page.querySelector('script')).toBeNull();
    expect(Array.from(page.querySelectorAll('a')).every((link) =>
      link.protocol === 'https:' && link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true);
  });

  /** @des DES-F005-003 @des DES-F005-010 @fun FUN-F005-024 @fun FUN-F005-032 */
  it('夢十夜のnullable校正者を実creditsへ「校正者: 記載なし」のtext nodeで描画する', () => {
    const catalog: UICatalogV2 = {
      ...catalogV2Fixture(),
      authors: [{
        authorId: '000148',
        name: 'なつめそうせき',
        originalName: '夏目漱石',
        slug: 'natsume-soseki',
        artwork: {
          path: 'artwork/natsume-zundamon.png',
          alt: '夏目漱石をイメージしたずんだもん',
          sha256: '7'.repeat(64),
        },
        introducedByBatchId: 'F005',
        identitySha256: '8'.repeat(64),
      }],
      works: [{
        workId: '000799',
        authorId: '000148',
        batchId: 'F005',
        title: '夢十夜',
        cardLink: 'https://www.aozora.gr.jp/cards/000148/card799.html',
        source: {
          cardUrl: 'https://www.aozora.gr.jp/cards/000148/card799.html',
          textUrl: 'https://www.aozora.gr.jp/cards/000148/files/799_14972.html',
          attribution: '青空文庫',
          baseEdition: '底本',
          inputter: '入力者',
          proofreader: null,
          fetchedAt: CHECKED_AT,
          transformation: '台詞抽出・構造化',
          sourceSha256: '6'.repeat(64),
          provenancePath: 'content/provenance/F005/000799.json',
          provenanceSha256: '5'.repeat(64),
        },
        dialogues: [],
      }],
      audioAssets: [],
      batches: [{
        batchId: 'F005',
        feature: 'F005',
        status: 'accepted',
        authorId: '000148',
        workIds: ['000799'],
        acceptedAt: CHECKED_AT,
        evidenceSha256: '4'.repeat(64),
      }],
      candidateCounts: {
        total: 0,
        published: 0,
        editorialExcluded: 0,
        audioExcluded: 0,
        byBatch: {
          F005: { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0 },
        },
      },
    };
    const bundle = validatedBundle();
    const page = renderCreditsV2(catalog, {
      ...bundle,
      artworks: [{
        authorId: '000148',
        batchId: 'F005',
        manifestId: 'artwork-F005-001',
        provenanceRef: 'content/artwork-provenance/F005.json',
        provenanceSha256: '3'.repeat(64),
        output: {
          path: 'artwork/natsume-zundamon.png',
          sha256: '7'.repeat(64),
        },
        credit: '独自生成画像',
      }],
    });
    const sourceItem = page.querySelector('section:nth-of-type(2) li');
    expect(sourceItem?.textContent).toContain('校正者: 記載なし');
    expect(sourceItem?.childNodes).toHaveLength(1);
    expect(sourceItem?.firstChild?.nodeName).toBe('A');
    expect(sourceItem?.querySelector('a')?.childNodes).toHaveLength(1);
    expect(sourceItem?.querySelector('a')?.firstChild?.nodeType).toBe(document.TEXT_NODE);
  });

  it('作品noticeをクレジット配置へ固定文言で描画する', () => {
    const catalog = catalogV2Fixture();
    catalog.works[0]!.completionStatus = 'unfinished';
    catalog.works[0]!.notices = [
      { textKey: 'unfinished', placements: ['work-list', 'work-detail', 'credits'] },
      { textKey: 'official-content-warning', placements: ['work-list', 'work-detail', 'credits'] },
      { textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] },
    ];
    const page = renderCreditsV2(catalog, validatedBundle());
    const sources = page.querySelector('section:nth-of-type(2)');
    expect(sources?.textContent).toContain('未完');
    expect(sources?.textContent).toContain('不適切と受け取られる可能性');
    expect(sources?.textContent).toContain('作品全文の朗読や要約ではなく');
  });

  it('作者・作品が各1件の境界でも完全なクレジットを描画する', () => {
    const catalog = structuredClone(catalogV2Fixture());
    catalog.authors.splice(1);
    catalog.works.splice(1);
    catalog.batches.splice(1);
    delete catalog.candidateCounts.byBatch.F002;
    const bundle = validatedBundle();
    const page = renderCreditsV2(catalog, { ...bundle, artworks: [bundle.artworks[0]!] });
    expect(page.textContent).toContain('羅生門<script>alert(1)</script>');
  });

  it('work由来欠落と画像hash不一致をcode付きで部分描画せず拒否する', () => {
    const missing = structuredClone(catalogV2Fixture());
    missing.works[0]!.source.inputter = '';
    expect(() => renderCreditsV2(missing, validatedBundle()))
      .toThrow(expect.objectContaining({ code: 'CREDITS_PROVENANCE_MISSING' }));

    const artworkMismatch = structuredClone(catalogV2Fixture());
    artworkMismatch.authors[1]!.artwork.sha256 = 'f'.repeat(64);
    expect(() => renderCreditsV2(artworkMismatch, validatedBundle()))
      .toThrow(expect.objectContaining({ code: 'CREDITS_ARTWORK_MISMATCH' }));
  });

  it('未検証または不完全なnotice bundleをCREDITS_*でfail-closedにする', () => {
    expect(() => renderCreditsV2(
      catalogV2Fixture(),
      { license: {}, artwork: {} } as never,
    )).toThrow(expect.objectContaining({ code: 'CREDITS_PROVENANCE_MISSING' }));

    const bundle = validatedBundle();
    expect(() => renderCreditsV2(
      catalogV2Fixture(),
      { ...bundle, artwork: undefined, artworks: undefined } as never,
    )).toThrow(expect.objectContaining({ code: 'CREDITS_ARTWORK_MISMATCH' }));
  });

  it('期限切れ規約snapshotをCREDITS_POLICY_STALEで拒否する', () => {
    expect(() => renderCreditsV2(catalogV2Fixture(), validatedBundle('2026-07-19T00:00:00Z')))
      .toThrow(expect.objectContaining({ code: 'CREDITS_POLICY_STALE' }));
  });
});
