import { describe, expect, it, vi } from 'vitest';

import { loadCatalog, publicBaseUrl, resolvePublicAsset, validateCatalog } from './catalog-loader';
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

describe('routeとcatalog境界', () => {
  /** @des DES-F001-001 @ut UT-F001-001 */
  it('固定hashだけをrouteとして受理する', () => {
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/authors/akutagawa-zunnosuke')).toEqual({ kind: 'author', slug: 'akutagawa-zunnosuke' });
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
