import { describe, expect, it, vi } from 'vitest';

import {
  loadCatalog,
  publicBaseUrl,
  resolvePublicAsset,
  resolvePublicAssetV2,
  validateCatalog,
  validateCatalogV2,
} from './catalog-loader';
import { parseRoute, resolveMotionPreference } from './routes';

function rawCatalog(): Record<string, unknown> {
  const textFiles = { '000127': '127_15260.html', '000092': '92_14545.html', '043015': '43015_17432.html' } as const;
  const workDefinitions = [
    ['000127', '羅生門', '127'],
    ['000092', '蜘蛛の糸', '92'],
    ['043015', '杜子春', '43015'],
  ] as const;
  const sourceMetadata = {
    '000127': { baseEdition: '芥川龍之介全集1', inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ' },
    '000092': { baseEdition: '芥川龍之介全集2', inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ' },
    '043015': { baseEdition: '蜘蛛の糸・杜子春', inputter: '蒋龍', proofreader: 'noriko saito' },
  } as const;
  const works = workDefinitions.map(([workId, title, cardId], index) => ({
    workId,
    title,
    cardLink: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
    source: {
      cardUrl: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
      textUrl: `https://www.aozora.gr.jp/cards/000879/files/${textFiles[workId]}`,
      attribution: `青空文庫『${title}』（芥川龍之介）`,
      ...sourceMetadata[workId],
      fetchedAt: '2026-07-18T00:00:00Z',
      transformation: '公式XHTMLを宣言charsetでdecodeし、「」候補を抽出して表示文・読み上げ文へ決定的に正規化',
      sourceSha256: `${index + 1}`.repeat(64),
    },
    dialogues: [{
      dialogueId: `dialogue-${index + 1}`,
      order: 1,
      displayText: `${title}の台詞`,
      speechText: `${title}の台詞`,
      audioId: `audio-${index + 1}`,
      sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
      review: {
        candidateId: `dialogue-${index + 1}`,
        revision: 1,
        status: 'approved',
        reasonCode: 'SPOKEN_DIALOGUE',
        note: '発話として確認',
        reviewer: 'reviewer',
        reviewedAt: '2026-07-18T00:00:00Z',
        policyCheckedAt: '2026-07-18T00:00:00Z',
      },
    }],
  }));
  return {
    schemaVersion: '1.0.0',
    author: {
      authorId: '000879', name: 'あくたがわずんのすけ', originalName: '芥川龍之介', slug: 'akutagawa-zunnosuke',
      artwork: { path: 'artwork/akutagawa-zundamon.png', alt: '文豪風の装いで本を持つ、あくたがわずんのすけのイラスト' },
    },
    works,
    audioAssets: works.map((_, index) => ({
      audioId: `audio-${index + 1}`,
      path: `audio/audio-${index + 1}.wav`,
      sha256: 'a'.repeat(64),
      bytes: 100,
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
    futureExpansionPolicy: { eligibilityCriteria: '確認', rightsRecheck: '再確認', stagedAddition: '段階追加' },
  };
}

function rawCatalogV2(includeSecondAuthor = true): Record<string, unknown> {
  const definitions = [
    { batchId: 'F001', authorId: '000879', slug: 'akutagawa-zunnosuke', name: 'あくたがわずんのすけ', originalName: '芥川龍之介', workId: '000127', title: '羅生門' },
    ...(includeSecondAuthor
      ? [{ batchId: 'F002', authorId: '000081', slug: 'miyazawa-zunji', name: 'みやざわずんじ', originalName: '宮沢賢治', workId: '000473', title: 'よだかの星' }]
      : []),
  ];
  const batches = definitions.map((item) => ({
    batchId: item.batchId,
    feature: item.batchId,
    status: 'published',
    authorId: item.authorId,
    workIds: [item.workId],
    acceptedAt: '2026-07-20T00:00:00Z',
    publishedAt: '2026-07-20T01:00:00Z',
    evidenceSha256: 'e'.repeat(64),
  }));
  const authors = definitions.map((item) => ({
    authorId: item.authorId,
    name: item.name,
    originalName: item.originalName,
    slug: item.slug,
    artwork: { path: `artwork/${item.slug}.png`, alt: `${item.name}のイラスト`, sha256: 'f'.repeat(64) },
    introducedByBatchId: item.batchId,
    identitySha256: 'd'.repeat(64),
  }));
  const works = definitions.map((item, index) => {
    const numericWorkId = item.workId.replace(/^0+/u, '');
    const cardUrl = `https://www.aozora.gr.jp/cards/${item.authorId}/card${numericWorkId}.html`;
    return {
      workId: item.workId,
      authorId: item.authorId,
      batchId: item.batchId,
      title: item.title,
      cardLink: cardUrl,
      source: {
        cardUrl,
        textUrl: `https://www.aozora.gr.jp/cards/${item.authorId}/files/${numericWorkId}_fixture.html`,
        attribution: `青空文庫『${item.title}』（${item.originalName}）`,
        baseEdition: '底本',
        inputter: '入力者',
        proofreader: '校正者',
        fetchedAt: '2026-07-20T00:00:00Z',
        transformation: '原典から決定的に変換',
        sourceSha256: `${index + 1}`.repeat(64),
        provenancePath: `content/provenance/${item.batchId}/${item.workId}.json`,
        provenanceSha256: 'c'.repeat(64),
      },
      dialogues: [{
        dialogueId: `dialogue-${index + 1}`,
        workId: item.workId,
        order: 0,
        displayText: `${item.title}の台詞`,
        speechText: `${item.title}の台詞`,
        audioId: 'shared-audio',
        sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
        review: {
          candidateId: `dialogue-${index + 1}`,
          workId: item.workId,
          revision: 1,
          status: 'approved',
          reasonCode: 'SPOKEN_DIALOGUE',
          reviewer: 'reviewer',
          reviewedAt: '2026-07-20T00:00:00Z',
          policyCheckedAt: '2026-07-20T00:00:00Z',
          policyDecision: 'allowed',
        },
      }],
    };
  });
  const byBatch = Object.fromEntries(definitions.map((item) => [item.batchId, {
    total: 1, published: 1, editorialExcluded: 0, audioExcluded: 0,
  }]));
  return {
    schemaVersion: '2.0.0',
    authors,
    works,
    audioAssets: [{
      audioId: 'shared-audio', batchId: 'F001', path: 'audio/F001/shared.wav', sha256: 'a'.repeat(64),
      bytes: 100, durationMs: 1000, configHash: 'b'.repeat(64),
    }],
    batches,
    candidateCounts: {
      total: definitions.length,
      published: definitions.length,
      editorialExcluded: 0,
      audioExcluded: 0,
      byBatch,
    },
    creditsRef: 'content/licenses.json',
  };
}

describe('routeとcatalog境界', () => {
  /** @des DES-F001-001 @ut UT-F001-001 */
  it('固定hashだけをrouteとして受理する', () => {
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/authors/akutagawa-zunnosuke')).toEqual({
      kind: 'author', authorId: '000879', slug: 'akutagawa-zunnosuke',
    });
    expect(parseRoute('#/credits')).toEqual({ kind: 'credits' });
    expect(parseRoute('#/authors/evil')).toEqual({ kind: 'notFound' });
    expect(parseRoute('#/%ZZ')).toEqual({ kind: 'notFound' });
    expect(parseRoute(`#/${'a'.repeat(255)}`)).toEqual({ kind: 'notFound' });
  });

  /** @des DES-F001-013 DES-F001-015 @ut UT-F001-028 */
  it('公開assetをPages base内の相対pathだけに限定する', () => {
    const base = new URL('https://example.github.io/bungo-zundamon/');
    expect(resolvePublicAsset(base, 'audio/a.wav').href).toBe('https://example.github.io/bungo-zundamon/audio/a.wav');
    for (const path of ['https://evil.example/a.wav', '//evil.example/a.wav', '/a.wav', '../a.wav', 'audio\\a.wav']) {
      expect(() => resolvePublicAsset(base, path)).toThrow();
    }
  });

  /** @des DES-F002-006 DES-F002-012 @fun FUN-F002-026 @ut UT-F002-026 */
  it.each([
    'audio/F002/a.wav',
    'artwork/miyazawa-zundamon.png',
    'content/catalog.json',
    'a',
  ])('生成された公開root相対pathを加工せずbase配下へ解決する: %s', (path) => {
    const base = new URL('https://example.test/bungo-zundamon/');
    expect(resolvePublicAssetV2(base, path).href).toBe(`${base.href}${path}`);
  });

  /** @des DES-F002-006 DES-F002-012 @fun FUN-F002-026 @ut UT-F002-026 */
  it.each([
    '/audio/a.wav',
    'audio//a.wav',
    'audio/',
    './audio.wav',
    'audio/./a.wav',
    '../audio.wav',
    'audio/../a.wav',
    'audio\\a.wav',
    'https://evil.example/a.wav',
    '//evil.example/a.wav',
    'audio/a.wav?download=1',
    'audio/a.wav#fragment',
    'audio/\u0000a.wav',
    'audio/%2fa.wav',
    'audio/%5Ca.wav',
    'audio/%2e%2e/a.wav',
  ])('危険な公開pathをASSET_PATH_UNSAFEで拒否する: %s', (path) => {
    expect(() => resolvePublicAssetV2(new URL('https://example.test/bungo-zundamon/'), path))
      .toThrow(expect.objectContaining({ code: 'ASSET_PATH_UNSAFE' }));
  });

  /** @des DES-F002-006 DES-F002-012 @fun FUN-F002-026 @ut UT-F002-026 */
  it.each([
    'https://example.test/bungo-zundamon',
    'https://user:pass@example.test/bungo-zundamon/',
    'https://example.test/bungo-zundamon/?q=1',
    'ftp://example.test/bungo-zundamon/',
  ])('不正なbaseをASSET_BASE_INVALIDで拒否する: %s', (base) => {
    expect(() => resolvePublicAssetV2(new URL(base), 'audio/a.wav'))
      .toThrow(expect.objectContaining({ code: 'ASSET_BASE_INVALID' }));
  });

  /** @des DES-F001-002 DES-F001-013 @ut UT-F001-004 */
  it('3作品・参照・候補集計が整合するcatalogだけを受理する', () => {
    expect(validateCatalog(rawCatalog(), 4096).works).toHaveLength(3);
    const broken = structuredClone(rawCatalog());
    (broken.candidateCounts as Record<string, unknown>).published = 2;
    expect(() => validateCatalog(broken, 4096)).toThrow(/candidate-count-mismatch/);
  });

  it('原典先頭候補を示す0始まりの台詞orderを受理する', () => {
    const zeroBased = structuredClone(rawCatalog());
    (((zeroBased.works as unknown[])[0] as Record<string, unknown>).dialogues as Array<Record<string, unknown>>)[0]!.order = 0;
    expect(validateCatalog(zeroBased, 4096).works[0]?.dialogues[0]?.order).toBe(0);
  });

  it.each([
    ['もじり作者名', (catalog: Record<string, unknown>) => { (catalog.author as Record<string, unknown>).name = '芥川龍之介'; }],
    ['原著者名', (catalog: Record<string, unknown>) => { delete (catalog.author as Record<string, unknown>).originalName; }],
    ['固定画像', (catalog: Record<string, unknown>) => { delete (catalog.author as Record<string, unknown>).artwork; }],
    ['画像path', (catalog: Record<string, unknown>) => { ((catalog.author as Record<string, unknown>).artwork as Record<string, unknown>).path = 'artwork/other.png'; }],
    ['日本語alt', (catalog: Record<string, unknown>) => { ((catalog.author as Record<string, unknown>).artwork as Record<string, unknown>).alt = ' '; }],
  ])('作者の必須契約「%s」を改ざん・欠落すると拒否する', (_label, mutate) => {
    const broken = structuredClone(rawCatalog());
    mutate(broken);
    expect(() => validateCatalog(broken, 4096)).toThrow(/author/);
  });

  it.each(['textUrl', 'attribution', 'baseEdition', 'inputter', 'proofreader', 'fetchedAt', 'transformation', 'sourceSha256'])(
    'source必須field %sの欠落を拒否する', (field) => {
    const broken = structuredClone(rawCatalog());
    const source = ((broken.works as Array<Record<string, unknown>>)[0]!.source as Record<string, unknown>);
    delete source[field];
    expect(() => validateCatalog(broken, 4096)).toThrow(/work-source/);
    },
  );

  /** @des DES-F001-002 DES-F001-013 @ut UT-F001-004.error.card-mapping */
  it.each([
    ['000127', '92'],
    ['000092', '127'],
    ['043015', '430'],
  ])('workId=%sと別図書カードの組合せを拒否する', (workId, wrongCardId) => {
    const broken = structuredClone(rawCatalog());
    const work = (broken.works as Array<Record<string, unknown>>).find((item) => item.workId === workId)!;
    const wrongCard = `https://www.aozora.gr.jp/cards/000879/card${wrongCardId}.html`;
    work.cardLink = wrongCard;
    (work.source as Record<string, unknown>).cardUrl = wrongCard;
    expect(() => validateCatalog(broken, 4096)).toThrow(/work-card-link-invalid/);
  });

  /** @des DES-F001-002 DES-F001-013 @ut UT-F001-004.error.card-url */
  it.each([
    ['cardLink/source不一致', (work: Record<string, unknown>) => {
      (work.source as Record<string, unknown>).cardUrl = 'https://www.aozora.gr.jp/cards/000879/card92.html';
    }],
    ['query付き', (work: Record<string, unknown>) => {
      work.cardLink = `${String(work.cardLink)}?from=unsafe`;
      (work.source as Record<string, unknown>).cardUrl = work.cardLink;
    }],
    ['fragment付き', (work: Record<string, unknown>) => {
      work.cardLink = `${String(work.cardLink)}#fragment`;
      (work.source as Record<string, unknown>).cardUrl = work.cardLink;
    }],
    ['credential付き', (work: Record<string, unknown>) => {
      work.cardLink = 'https://user:pass@www.aozora.gr.jp/cards/000879/card127.html';
      (work.source as Record<string, unknown>).cardUrl = work.cardLink;
    }],
    ['非既定port付き', (work: Record<string, unknown>) => {
      work.cardLink = 'https://www.aozora.gr.jp:444/cards/000879/card127.html';
      (work.source as Record<string, unknown>).cardUrl = work.cardLink;
    }],
    ['既定port明記', (work: Record<string, unknown>) => {
      work.cardLink = 'https://www.aozora.gr.jp:443/cards/000879/card127.html';
      (work.source as Record<string, unknown>).cardUrl = work.cardLink;
    }],
  ])('図書カードURLの%sをfail-closedで拒否する', (_label, mutate) => {
    const broken = structuredClone(rawCatalog());
    const work = (broken.works as Array<Record<string, unknown>>)[0]!;
    mutate(work);
    expect(() => validateCatalog(broken, 4096)).toThrow();
  });

  /** @des DES-F001-002 DES-F001-013 @ut UT-F001-004.error.text-url */
  it('作品IDと異なるXHTML URLをfail-closedで拒否する', () => {
    const broken = structuredClone(rawCatalog());
    const work = (broken.works as Array<Record<string, unknown>>)[0]!;
    (work.source as Record<string, unknown>).textUrl = 'https://www.aozora.gr.jp/cards/000879/files/92_14545.html';
    expect(() => validateCatalog(broken, 4096)).toThrow(/work-source-text-link-invalid/);
  });

  /** @des DES-F001-002 DES-F001-013 @ut UT-F001-004 */
  it.each([
    ['台詞order', (catalog: Record<string, unknown>) => {
      (((catalog.works as unknown[])[0] as Record<string, unknown>).dialogues as Array<Record<string, unknown>>)[0]!.order = 1.5;
    }],
    ['sourceAnchor範囲', (catalog: Record<string, unknown>) => {
      const dialogue = (((catalog.works as unknown[])[0] as Record<string, unknown>).dialogues as Array<Record<string, unknown>>)[0]!;
      (dialogue.sourceAnchor as Record<string, unknown>).endToken = 0;
    }],
    ['sourceAnchor空範囲', (catalog: Record<string, unknown>) => {
      const dialogue = (((catalog.works as unknown[])[0] as Record<string, unknown>).dialogues as Array<Record<string, unknown>>)[0]!;
      (dialogue.sourceAnchor as Record<string, unknown>).endToken = 1;
    }],
    ['review状態', (catalog: Record<string, unknown>) => {
      const dialogue = (((catalog.works as unknown[])[0] as Record<string, unknown>).dialogues as Array<Record<string, unknown>>)[0]!;
      (dialogue.review as Record<string, unknown>).status = 'pending';
    }],
    ['底本', (catalog: Record<string, unknown>) => {
      (((catalog.works as unknown[])[0] as Record<string, unknown>).source as Record<string, unknown>).baseEdition = ' ';
    }],
    ['入力者', (catalog: Record<string, unknown>) => {
      (((catalog.works as unknown[])[0] as Record<string, unknown>).source as Record<string, unknown>).inputter = '';
    }],
    ['校正者', (catalog: Record<string, unknown>) => {
      (((catalog.works as unknown[])[0] as Record<string, unknown>).source as Record<string, unknown>).proofreader = '';
    }],
    ['取得日', (catalog: Record<string, unknown>) => {
      (((catalog.works as unknown[])[0] as Record<string, unknown>).source as Record<string, unknown>).fetchedAt = 'not-a-date';
    }],
    ['加工内容', (catalog: Record<string, unknown>) => {
      (((catalog.works as unknown[])[0] as Record<string, unknown>).source as Record<string, unknown>).transformation = '';
    }],
  ])('%sの異常を部分採用せず拒否する', (_label, mutate) => {
    const broken = structuredClone(rawCatalog());
    mutate(broken);
    expect(() => validateCatalog(broken, 4096)).toThrow();
  });

  /** @des DES-F001-002 DES-F001-013 @ut UT-F001-004 */
  it('depth 64超過・文字列上限超過・理由別集計不一致を拒否する', () => {
    const tooDeep = structuredClone(rawCatalog());
    let nested: unknown = 'leaf';
    for (let index = 0; index < 65; index += 1) nested = { nested };
    tooDeep.extra = nested;
    expect(() => validateCatalog(tooDeep, 4096)).toThrow(/catalog-depth-invalid/);

    const tooLong = structuredClone(rawCatalog());
    tooLong.extra = 'あ'.repeat(32_769);
    expect(() => validateCatalog(tooLong, 4096)).toThrow(/catalog-string-invalid/);

    const badReasons = structuredClone(rawCatalog());
    const counts = badReasons.candidateCounts as Record<string, unknown>;
    counts.total = 4;
    counts.editorialExcluded = 1;
    expect(() => validateCatalog(badReasons, 4096)).toThrow(/candidate-editorial-reasons-invalid/);
  });

  /** @des DES-F001-015 @ut UT-F001-030 */
  it('固定Pages baseだけを現在originへ解決する', () => {
    expect(publicBaseUrl({ origin: 'https://example.github.io' }, '/bungo-zundamon/').href)
      .toBe('https://example.github.io/bungo-zundamon/');
    for (const base of ['/bungo-zundamon', '/', 'https://evil.example/bungo-zundamon/']) {
      expect(() => publicBaseUrl({ origin: 'https://example.github.io' }, base)).toThrow(/public-base-invalid/);
    }
    expect(() => publicBaseUrl({ origin: 'https://user:pass@example.github.io' }, '/bungo-zundamon/'))
      .toThrow(/public-origin-invalid/);
  });

  /** @des DES-F001-002 DES-F001-013 DES-F001-015 @ut UT-F001-003 */
  it('同一originのcatalogを読みUTF-8 byte数とschemaを検証する', async () => {
    const json = JSON.stringify(rawCatalog());
    const fetcher = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValue(new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const base = new URL('/bungo-zundamon/', location.origin);
    const catalog = await loadCatalog(base, undefined, fetcher as typeof fetch);
    expect(catalog.author.name).toBe('あくたがわずんのすけ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(new URL('content/catalog.json', base).href);
  });

  /** @des DES-F001-011 @ut UT-F001-025 */
  it('OSまたはメモリ内設定のどちらかが低減なら演出を低減する', () => {
    expect(resolveMotionPreference({ matches: false })).toBe('full');
    expect(resolveMotionPreference({ matches: true }, 'full')).toBe('reduced');
    expect(resolveMotionPreference({ matches: false }, 'reduced')).toBe('reduced');
  });
});

describe('FUN-F002-004 CatalogV2検証 [DES-F002-001][DES-F002-006][DES-F002-012][UT-F002-004]', () => {
  it('固定作者条件なしで複数作者・共有audio・batch参照を受理する', () => {
    const result = validateCatalogV2(rawCatalogV2(), 8_388_608);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authors.map((author) => author.slug)).toEqual(['akutagawa-zunnosuke', 'miyazawa-zunji']);
    expect(result.value.works).toHaveLength(2);
    expect(result.value.audioAssets).toHaveLength(1);
    expect(validateCatalog(rawCatalogV2(), 4096).works).toHaveLength(2);
  });

  it('作者・作品各1件の最小catalogと上限ちょうどを受理し、byte上限+1を拒否する', () => {
    expect(validateCatalogV2(rawCatalogV2(false), 8_388_608).ok).toBe(true);
    expect(validateCatalogV2(rawCatalogV2(false), 8_388_609)).toMatchObject({
      ok: false, error: { code: 'CATALOG_RESOURCE_LIMIT' },
    });
  });

  it('32,768 scalarと深さ64を受理し、各+1をresource limitとして拒否する', () => {
    const stringAtLimit = rawCatalogV2(false);
    stringAtLimit.extra = 'あ'.repeat(32_768);
    expect(validateCatalogV2(stringAtLimit, 4096).ok).toBe(true);

    const stringOver = rawCatalogV2(false);
    stringOver.extra = 'あ'.repeat(32_769);
    expect(validateCatalogV2(stringOver, 4096)).toMatchObject({
      ok: false, error: { code: 'CATALOG_RESOURCE_LIMIT' },
    });

    const depthAtLimit = rawCatalogV2(false);
    let nested: unknown = 'leaf';
    for (let index = 0; index < 62; index += 1) nested = { nested };
    depthAtLimit.extra = nested;
    expect(validateCatalogV2(depthAtLimit, 4096).ok).toBe(true);

    const depthOver = rawCatalogV2(false);
    nested = 'leaf';
    for (let index = 0; index < 63; index += 1) nested = { nested };
    depthOver.extra = nested;
    expect(validateCatalogV2(depthOver, 4096)).toMatchObject({
      ok: false, error: { code: 'CATALOG_RESOURCE_LIMIT' },
    });
  });

  it.each([
    ['slug重複', (catalog: Record<string, unknown>) => {
      const authors = catalog.authors as Array<Record<string, unknown>>;
      authors[1]!.slug = authors[0]!.slug;
    }, 'CATALOG_DUPLICATE_ID'],
    ['audio ID重複', (catalog: Record<string, unknown>) => {
      const audio = (catalog.audioAssets as Array<Record<string, unknown>>)[0]!;
      (catalog.audioAssets as unknown[]).push(structuredClone(audio));
    }, 'CATALOG_DUPLICATE_ID'],
    ['孤立audio参照', (catalog: Record<string, unknown>) => {
      const work = (catalog.works as Array<Record<string, unknown>>)[0]!;
      ((work.dialogues as Array<Record<string, unknown>>)[0]!).audioId = 'missing-audio';
    }, 'CATALOG_ORPHAN_REFERENCE'],
    ['authorとbatch混線', (catalog: Record<string, unknown>) => {
      (catalog.works as Array<Record<string, unknown>>)[1]!.authorId = '000879';
    }, 'CATALOG_AUTHOR_MIXED'],
    ['dialogue work混線', (catalog: Record<string, unknown>) => {
      const work = (catalog.works as Array<Record<string, unknown>>)[1]!;
      ((work.dialogues as Array<Record<string, unknown>>)[0]!).workId = '000127';
    }, 'CATALOG_AUTHOR_MIXED'],
    ['危険asset path', (catalog: Record<string, unknown>) => {
      (catalog.audioAssets as Array<Record<string, unknown>>)[0]!.path = '../outside.wav';
    }, 'CATALOG_PATH_UNSAFE'],
    ['危険provenance path', (catalog: Record<string, unknown>) => {
      const work = (catalog.works as Array<Record<string, unknown>>)[0]!;
      (work.source as Record<string, unknown>).provenancePath = 'https://evil.example/p.json';
    }, 'CATALOG_PATH_UNSAFE'],
    ['別作者source URL', (catalog: Record<string, unknown>) => {
      const work = (catalog.works as Array<Record<string, unknown>>)[1]!;
      (work.source as Record<string, unknown>).textUrl = 'https://www.aozora.gr.jp/cards/000879/files/473_fixture.html';
    }, 'CATALOG_PATH_UNSAFE'],
    ['全体件数不一致', (catalog: Record<string, unknown>) => {
      (catalog.candidateCounts as Record<string, unknown>).published = 1;
    }, 'CATALOG_COUNT_MISMATCH'],
    ['batch別件数不一致', (catalog: Record<string, unknown>) => {
      const byBatch = (catalog.candidateCounts as Record<string, unknown>).byBatch as Record<string, Record<string, unknown>>;
      byBatch.F002!.published = 0;
      byBatch.F002!.total = 0;
    }, 'CATALOG_COUNT_MISMATCH'],
  ])('%sを指定codeで全体拒否する', (_label, mutate, code) => {
    const catalog = rawCatalogV2();
    mutate(catalog);
    expect(validateCatalogV2(catalog, 4096)).toMatchObject({ ok: false, error: { code } });
  });
});
