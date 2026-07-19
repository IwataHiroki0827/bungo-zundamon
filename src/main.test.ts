import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBungoZundamon, startBungoZundamon } from './main';
import type { ApplicationHandle } from './main';
import { REQUIRED_NOTICE_TEXT, validateReleaseNotices } from './notices';
import type { ArtworkProvenanceManifest, LicenseManifest, ValidatedNoticeBundle } from './notices';
import type { AudioPort, UICatalog } from './ui/types';

class QuietAudio implements AudioPort {
  src = '';
  currentTime = 0;
  preload = '';
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

function fixtureCatalog(authorName = 'あくたがわずんのすけ'): UICatalog {
  const works = [
    ['000127', '羅生門', '127'],
    ['000092', '蜘蛛の糸', '92'],
    ['043015', '杜子春', '43015'],
  ] as const;
  return {
    schemaVersion: '1.0.0',
    author: {
      authorId: '000879',
      name: authorName,
      slug: 'akutagawa-zunnosuke',
      originalName: '芥川龍之介',
      artwork: {
        path: 'artwork/akutagawa-zundamon.png',
        alt: '文豪風の装いで本を持つ、あくたがわずんのすけのイラスト',
      },
    },
    works: works.map(([workId, title, cardId], index) => ({
      workId,
      title,
      cardLink: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
      source: {
        cardUrl: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
        textUrl: `https://www.aozora.gr.jp/cards/000879/files/${workId === '000127' ? '127_15260' : workId === '000092' ? '92_14545' : '43015_17432'}.html`,
        attribution: `青空文庫『${title}』（芥川龍之介）`,
        baseEdition: workId === '000127' ? '芥川龍之介全集1' : workId === '000092' ? '芥川龍之介全集2' : '蜘蛛の糸・杜子春',
        inputter: workId === '043015' ? '蒋龍' : '野口英司、平山誠',
        proofreader: workId === '043015' ? 'noriko saito' : 'もりみつじゅんじ',
        fetchedAt: '2026-07-18T00:00:00Z',
        transformation: '公式XHTMLを宣言charsetでdecodeし、「」候補を抽出して表示文・読み上げ文へ決定的に正規化',
        sourceSha256: `${index + 1}`.repeat(64),
      },
      dialogues: [{
        dialogueId: `dialogue-${index + 1}`,
        order: 1,
        displayText: `「${title}の台詞」`,
        speechText: `${title}の台詞`,
        audioId: `audio-${index + 1}`,
        sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
        review: {
          candidateId: `dialogue-${index + 1}`,
          revision: 1,
          status: 'approved',
          reasonCode: 'SPOKEN_DIALOGUE',
          note: '発話',
          reviewer: 'reviewer',
          reviewedAt: '2026-07-18T00:00:00Z',
          policyCheckedAt: '2026-07-18T00:00:00Z',
        },
      }],
    })),
    audioAssets: works.map((_, index) => ({
      audioId: `audio-${index + 1}`,
      path: `audio/audio-${index + 1}.wav`,
      sha256: 'a'.repeat(64),
      bytes: 1024,
      durationMs: 1000,
      configHash: 'b'.repeat(64),
    })),
    candidateCounts: {
      total: 3,
      published: 3,
      editorialExcluded: 0,
      audioExcluded: 0,
      editorialReasons: {},
      audioFailureReasons: {},
    },
    creditsRef: 'content/licenses.json',
    futureExpansionPolicy: {
      eligibilityCriteria: '著作権と書誌を確認する',
      rightsRecheck: '追加時に再確認する',
      stagedAddition: '段階的に追加する',
    },
  };
}

function fixtureNoticeBundle(): ValidatedNoticeBundle {
  const checkedAt = '2026-07-01T00:00:00Z';
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const artwork: ArtworkProvenanceManifest = {
    schemaVersion: '1.0.0',
    manifestId: 'artwork-F001-001',
    creationMethod: 'authorized-source-edit',
    inputAllowlist: ['zundamon-standing'],
    inputs: [{
      id: 'zundamon-standing',
      sourcePage: 'https://seiga.nicovideo.jp/seiga/im11206626',
      distributionUrl: 'https://ux.getuploader.com/s_ahiru/download/59',
      distributionVersion: 'V3.2',
      downloadedAt: checkedAt,
      archiveSha256: hashB,
      archiveEntry: 'ずんだもん立ち絵素材V3.2/ずんだもん立ち絵素材V3.2_基本版.psd',
      bundledReadmeSha256: hashA,
      sha256: hashA,
    }],
    editorSource: 'zundamon-standing',
    transformations: ['文豪風の衣装・紙・墨の意匠を追加'],
    output: { path: 'artwork/akutagawa-zundamon.png', sha256: hashB },
    specificAkutagawaPhotographUsed: false,
    usesSakamotoArtworkAsInput: true,
    artistStyleImitated: false,
    reviewer: '権利確認者',
    reviewedAt: checkedAt,
  };
  const license: LicenseManifest = {
    schemaVersion: '1.0.0',
    notices: { ...REQUIRED_NOTICE_TEXT, contactPolicy: '問い合わせはIssueで受け付けます。' },
    bibliographyLicense: {
      name: 'CC BY 4.0',
      scope: 'bibliography-only',
      attribution: '青空文庫の書誌データを利用しています。',
      changeNotice: '初期公開3作品へ絞りました。',
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
      readmeSha256: hashA,
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
    dependencies: [{
      name: 'Vite',
      notice: 'MIT License',
      link: { label: 'Vite', purpose: 'dependency', url: 'https://vite.dev/' },
    }],
    commercial: { free: true, advertising: false, payments: false, tracking: false, forms: false },
    jurisdictionBasis: 'JP',
    terms: {
      url: 'https://zunko.jp/guideline.html',
      checkedAt,
      validUntil: '2030-08-01T00:00:00Z',
      reviewer: '権利確認者',
    },
  };
  const validated = validateReleaseNotices(license, artwork, new Date('2026-07-18T00:00:00Z'));
  if (!validated.ok) throw new Error('test-notice-fixture-invalid');
  return Object.freeze({ license: validated.value, artwork: Object.freeze(artwork) });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('文豪ずんだもんの画面', () => {
  let handle: ApplicationHandle | undefined;

  beforeEach(() => {
    vi.stubEnv('BASE_URL', '/bungo-zundamon/');
    document.body.replaceChildren(Object.assign(document.createElement('main'), { id: 'app' }));
    location.hash = '#/';
  });

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  /** @des DES-F001-001 DES-F001-010 @ut UT-F001-002 UT-F001-022 */
  it('トップにサイト説明・作者・非公式表記を描画する', () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    handle = mountBungoZundamon(root, {
      catalog: fixtureCatalog(),
      baseUrl: new URL('http://localhost/bungo-zundamon/'),
      audioFactory: () => new QuietAudio(),
      mediaQuery: { matches: false },
    });

    expect(root.querySelector('h1')?.textContent).toBe('文豪ずんだもん');
    expect(root.textContent).toContain('あくたがわずんのすけ');
    expect(root.textContent).toContain('原著者：芥川龍之介');
    expect(root.textContent).toContain('3作品・3の台詞を収録');
    expect(root.textContent).toContain('非公式ファンサイトです');
    expect(root.querySelector('a[href="#/authors/akutagawa-zunnosuke"]')).not.toBeNull();
  });

  /** @des DES-F001-001 DES-F001-002 DES-F001-010 @ut UT-F001-023 UT-F001-024 */
  it('作者routeに3作品と操作可能な台詞一覧を描画する', () => {
    location.hash = '#/authors/akutagawa-zunnosuke';
    const root = document.querySelector<HTMLElement>('#app')!;
    handle = mountBungoZundamon(root, {
      catalog: fixtureCatalog(),
      baseUrl: new URL('http://localhost/bungo-zundamon/'),
      audioFactory: () => new QuietAudio(),
      mediaQuery: { matches: false },
    });

    expect(root.querySelector('h1')?.textContent).toBe('あくたがわずんのすけ');
    expect(root.querySelectorAll('details.work-panel')).toHaveLength(3);
    expect(root.querySelector('details.work-panel')?.hasAttribute('open')).toBe(true);
    expect(root.querySelectorAll('button.play-button')).toHaveLength(3);
    expect(root.querySelectorAll('button.stop-button')).toHaveLength(3);
    expect(root.querySelector('blockquote p')?.textContent).toBe('「羅生門の台詞」');
    expect(root.querySelector('blockquote p')?.textContent).not.toContain('「「');
    expect(root.querySelector('.play-button')?.getAttribute('aria-label')).toContain('再生：');
    expect(root.querySelectorAll('a[target="_blank"][rel="noopener noreferrer"]')).toHaveLength(6);
    expect(root.querySelectorAll('.dialogue-source-link')).toHaveLength(3);
  });

  /** @des DES-F001-001 @ut UT-F001-001 UT-F001-002 */
  it('未知routeを安全な404にしhash変更でトップへ戻れる', () => {
    location.hash = '#/https://evil.example';
    const root = document.querySelector<HTMLElement>('#app')!;
    handle = mountBungoZundamon(root, {
      catalog: fixtureCatalog(),
      baseUrl: new URL('http://localhost/bungo-zundamon/'),
      audioFactory: () => new QuietAudio(),
      mediaQuery: { matches: false },
    });
    expect(root.querySelector('[data-page="not-found"]')).not.toBeNull();
    expect(root.querySelector('a')?.href).not.toContain('evil.example');

    location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.querySelector('[data-page="home"]')).not.toBeNull();
  });

  /** @des DES-F001-011 DES-F001-013 @ut UT-F001-022 UT-F001-025 UT-F001-027 */
  it('表示文字をHTMLとして解釈せず演出低減を反映する', () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    handle = mountBungoZundamon(root, {
      catalog: fixtureCatalog('<img src=x onerror=alert(1)>'),
      baseUrl: new URL('http://localhost/bungo-zundamon/'),
      audioFactory: () => new QuietAudio(),
      mediaQuery: { matches: true },
    });

    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.querySelectorAll('.author-card img')).toHaveLength(1);
    expect(root.querySelector('.author-card img')?.getAttribute('src')).toContain('artwork/akutagawa-zundamon.png');
    expect(root.dataset.motion).toBe('reduced');
    expect(root.querySelector('.motion-toggle')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('.motion-toggle')?.disabled).toBe(true);
    expect(root.querySelector('.motion-toggle')?.textContent).toContain('端末設定により動きを停止中');
  });

  it('演出設定の現在状態と停止対象を表示して切替結果を明確にする', () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    handle = mountBungoZundamon(root, {
      catalog: fixtureCatalog(),
      baseUrl: new URL('http://localhost/bungo-zundamon/'),
      audioFactory: () => new QuietAudio(),
      mediaQuery: { matches: false },
    });

    const standard = root.querySelector<HTMLButtonElement>('.motion-toggle')!;
    expect(standard.textContent).toContain('演出：標準');
    expect(standard.textContent).toContain('ページ切替と再生アイコンが動きます');
    expect(standard.getAttribute('aria-label')).toBe('演出を控えめにする');

    standard.click();

    const reduced = root.querySelector<HTMLButtonElement>('.motion-toggle')!;
    expect(root.dataset.motion).toBe('reduced');
    expect(reduced.textContent).toContain('演出：控えめ');
    expect(reduced.textContent).toContain('ページ切替と再生アイコンの動きを停止中');
    expect(reduced.getAttribute('aria-label')).toBe('演出を標準に戻す');
  });

  it('catalogと検証済みnoticeを同じsignalで読み、実クレジットへ結合する', async () => {
    location.hash = '#/credits';
    const root = document.querySelector<HTMLElement>('#app')!;
    let catalogSignal: AbortSignal | undefined;
    let noticeSignal: AbortSignal | undefined;
    const catalogLoader = vi.fn(async (_base: URL, signal?: AbortSignal) => {
      catalogSignal = signal;
      return fixtureCatalog();
    });
    const noticeLoader = vi.fn(async (_base: URL, signal?: AbortSignal) => {
      noticeSignal = signal;
      return fixtureNoticeBundle();
    });

    handle = (await startBungoZundamon(root, catalogLoader, noticeLoader)) ?? undefined;

    expect(catalogSignal).toBe(noticeSignal);
    expect(catalogSignal?.aborted).toBe(false);
    expect(root.querySelector('[data-page="credits"]')).not.toBeNull();
    expect(root.textContent).toContain('青空文庫の書誌データを利用しています。');
    expect(root.textContent).toContain('立ち絵：坂本アヒル');
  });

  it.each(['catalog', 'notice'] as const)(
    '競合する古い起動の%s側が拒否されても現在画面を上書きしない',
    async (failureSide) => {
    const root = document.querySelector<HTMLElement>('#app')!;
    const catalogs = [deferred<UICatalog>(), deferred<UICatalog>()];
    const notices = [deferred<ValidatedNoticeBundle>(), deferred<ValidatedNoticeBundle>()];
    const catalogSignals: Array<AbortSignal | undefined> = [];
    const noticeSignals: Array<AbortSignal | undefined> = [];
    let catalogCall = 0;
    let noticeCall = 0;
    const first = startBungoZundamon(
      root,
      async (_base, signal) => {
        catalogSignals.push(signal);
        return catalogs[catalogCall++]!.promise;
      },
      async (_base, signal) => {
        noticeSignals.push(signal);
        return notices[noticeCall++]!.promise;
      },
    );
    const second = startBungoZundamon(
      root,
      async (_base, signal) => {
        catalogSignals.push(signal);
        return catalogs[catalogCall++]!.promise;
      },
      async (_base, signal) => {
        noticeSignals.push(signal);
        return notices[noticeCall++]!.promise;
      },
    );

    catalogs[1]!.resolve(fixtureCatalog('現在の作者'));
    notices[1]!.resolve(fixtureNoticeBundle());
    handle = (await second) ?? undefined;
    expect(root.textContent).toContain('現在の作者');
    if (failureSide === 'catalog') {
      catalogs[0]!.reject(new Error('古いcatalog起動の失敗'));
      notices[0]!.resolve(fixtureNoticeBundle());
    } else {
      catalogs[0]!.resolve(fixtureCatalog('古い作者'));
      notices[0]!.reject(new Error('古いnotice起動の失敗'));
    }
    expect(await first).toBeNull();

    expect(catalogSignals[0]).toBe(noticeSignals[0]);
    expect(catalogSignals[0]?.aborted).toBe(true);
    expect(catalogSignals[1]).toBe(noticeSignals[1]);
    expect(root.textContent).toContain('現在の作者');
    expect(root.textContent).not.toContain('作品を読み込めませんでした');
    expect(root.textContent).not.toContain('古い作者');
  });

  it('notice欠損・不正時は部分描画せず日本語の再試行画面にする', async () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    const result = await startBungoZundamon(
      root,
      async () => fixtureCatalog(),
      async () => ({ license: {}, artwork: {} } as unknown as ValidatedNoticeBundle),
    );

    expect(result).toBeNull();
    expect(root.textContent).toContain('作品を読み込めませんでした');
    expect(root.textContent).toContain('公開データを確認できませんでした');
    expect(root.querySelector('button')?.textContent).toBe('もう一度読み込む');
    expect(root.querySelector('[data-page]')).toBeNull();
  });

  it('current generationの片方が失敗すると兄弟loaderをabortし、ボタンから再試行できる', async () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    let catalogCalls = 0;
    let noticeCalls = 0;
    let firstSignal: AbortSignal | undefined;
    let siblingAborted = false;
    const catalogLoader = async (): Promise<UICatalog> => {
      catalogCalls += 1;
      if (catalogCalls === 1) throw new Error('catalog-load-failed');
      return fixtureCatalog('再試行後の作者');
    };
    const noticeLoader = async (_base: URL, signal?: AbortSignal): Promise<ValidatedNoticeBundle> => {
      noticeCalls += 1;
      if (noticeCalls > 1) return fixtureNoticeBundle();
      firstSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          siblingAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    };

    expect(await startBungoZundamon(root, catalogLoader, noticeLoader)).toBeNull();
    expect(firstSignal?.aborted).toBe(true);
    expect(siblingAborted).toBe(true);
    root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain('再試行後の作者'));
    expect(catalogCalls).toBe(2);
    expect(noticeCalls).toBe(2);

    handle = (await startBungoZundamon(root, catalogLoader, noticeLoader)) ?? undefined;
  });

  it('disposeで起動signalと画面listenerを停止し、複数回呼んでも安全である', async () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    let signal: AbortSignal | undefined;
    handle = (await startBungoZundamon(
      root,
      async (_base, currentSignal) => {
        signal = currentSignal;
        return fixtureCatalog();
      },
      async () => fixtureNoticeBundle(),
    )) ?? undefined;
    expect(signal?.aborted).toBe(false);
    const original = root.innerHTML;

    handle!.dispose();
    handle!.dispose();
    handle = undefined;
    expect(signal?.aborted).toBe(true);
    location.hash = '#/authors/akutagawa-zunnosuke';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.innerHTML).toBe(original);
  });
});
