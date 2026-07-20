import { describe, expect, it } from 'vitest';

import {
  REQUIRED_NOTICE_TEXT,
  loadReleaseNoticeBundle,
  renderCredits,
  renderCreditsV2,
  resolveTrustedExternalLink,
  validateReleaseNotices,
  type ArtworkProvenanceManifest,
  type LicenseManifest,
} from './index';
import type { UICatalogV2 } from '../ui/types';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CHECKED_AT = '2026-07-01T00:00:00Z';
const VALID_UNTIL = '2026-08-01T00:00:00Z';

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

    expect(seenSignals).toEqual([signal, signal]);
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
    const secondArtwork = structuredClone(artwork);
    secondArtwork.manifestId = 'artwork-F002-001';
    secondArtwork.output = { path: 'artwork/miyazawa-zundamon.png', sha256: 'c'.repeat(64) };
    const validated = validateReleaseNotices(manifest, artwork, new Date(CHECKED_AT));
    if (!validated.ok) throw new Error('fixture-validation-failed');
    return { license: validated.value, artwork, artworks: [artwork, secondArtwork] } as const;
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

  it('作者・作品が各1件の境界でも完全なクレジットを描画する', () => {
    const catalog = structuredClone(catalogV2Fixture());
    catalog.authors.splice(1);
    catalog.works.splice(1);
    catalog.batches.splice(1);
    delete catalog.candidateCounts.byBatch.F002;
    const bundle = validatedBundle();
    const page = renderCreditsV2(catalog, { ...bundle, artworks: [bundle.artwork] });
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
