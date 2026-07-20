import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AudioController } from './audio-controller';
import { renderAuthorIndex, renderAuthorPageV2, renderRoute } from './render';
import type { PlayerState, UICatalogV2 } from './types';

const IDLE: PlayerState = { status: 'idle', dialogueId: null, message: '音声は停止しています。' };

function controllerFixture(): { controller: AudioController; play: ReturnType<typeof vi.fn>; control: ReturnType<typeof vi.fn> } {
  const play = vi.fn(async () => IDLE);
  const control = vi.fn(() => IDLE);
  return {
    controller: {
      play,
      control,
      subscribe(listener: (state: PlayerState) => void) {
        listener(IDLE);
        return () => undefined;
      },
    } as unknown as AudioController,
    play,
    control,
  };
}

function catalogFixture(): UICatalogV2 {
  const authors = [
    {
      authorId: '000879', name: '<strong>あくたがわずんのすけ</strong>', originalName: '芥川龍之介', slug: 'akutagawa-zunnosuke',
      artwork: { path: 'artwork/akutagawa.png', alt: '芥川の画像', sha256: 'a'.repeat(64) }, introducedByBatchId: 'F001', identitySha256: 'b'.repeat(64),
    },
    {
      authorId: '000081', name: 'みやざわずんじ', originalName: '宮沢賢治', slug: 'miyazawa-zunji',
      artwork: { path: 'artwork/miyazawa.png', alt: '宮沢の画像', sha256: 'c'.repeat(64) }, introducedByBatchId: 'F002', identitySha256: 'd'.repeat(64),
    },
  ];
  const works = [
    {
      workId: '000127', authorId: '000879', batchId: 'F001', title: '羅生門',
      cardLink: 'https://www.aozora.gr.jp/cards/000879/card127.html',
      source: {
        cardUrl: 'https://www.aozora.gr.jp/cards/000879/card127.html', textUrl: 'https://www.aozora.gr.jp/cards/000879/files/127_15260.html',
        attribution: '青空文庫', baseEdition: '底本A', inputter: '入力A', proofreader: '校正A', fetchedAt: '2026-07-01T00:00:00.000Z',
        transformation: '変換A', sourceSha256: 'e'.repeat(64), provenancePath: 'content/provenance/F001/000127.json', provenanceSha256: 'f'.repeat(64),
      },
      dialogues: [{
        dialogueId: 'dialogue-a', workId: '000127', order: 1, displayText: '芥川の台詞', speechText: '芥川の台詞', audioId: 'audio-a',
        sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
        review: {
          candidateId: 'dialogue-a', revision: 1, status: 'approved' as const, reasonCode: 'SPOKEN_DIALOGUE', reviewer: 'reviewer',
          reviewedAt: '2026-07-01T00:00:00.000Z', policyCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      }],
    },
    ...(['000473', '043752', '043754'] as const).map((workId, index) => ({
      workId, authorId: '000081', batchId: 'F002', title: ['よだかの星', '雪渡り', '注文の多い料理店'][index]!,
      cardLink: `https://www.aozora.gr.jp/cards/000081/card${Number(workId)}.html`,
      source: {
        cardUrl: `https://www.aozora.gr.jp/cards/000081/card${Number(workId)}.html`, textUrl: `https://www.aozora.gr.jp/cards/000081/files/${Number(workId)}_1.html`,
        attribution: '青空文庫', baseEdition: `底本${index + 1}`, inputter: `入力${index + 1}`, proofreader: `校正${index + 1}`,
        fetchedAt: '2026-07-02T00:00:00.000Z', transformation: '変換B', sourceSha256: `${index + 1}`.repeat(64),
        provenancePath: `content/provenance/F002/${workId}.json`, provenanceSha256: `${index + 4}`.repeat(64),
      },
      dialogues: [{
        dialogueId: `dialogue-m-${index}`, workId, order: 1, displayText: `宮沢の台詞${index + 1}`, speechText: `宮沢の台詞${index + 1}`,
        audioId: `audio-m-${index}`, sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
        review: {
          candidateId: `dialogue-m-${index}`, workId, revision: 1, status: 'approved' as const, reasonCode: 'SPOKEN_DIALOGUE', reviewer: 'reviewer',
          reviewedAt: '2026-07-02T00:00:00.000Z', policyCheckedAt: '2026-07-02T00:00:00.000Z',
        },
      }],
    })),
  ];
  const audioAssets = [
    { audioId: 'audio-a', batchId: 'F001', path: 'audio/F001/audio-a.wav', sha256: '8'.repeat(64), bytes: 10, durationMs: 1000, configHash: '9'.repeat(64) },
    ...[0, 1, 2].map((index) => ({
      audioId: `audio-m-${index}`, batchId: 'F002', path: `audio/F002/audio-m-${index}.wav`, sha256: 'a'.repeat(64),
      bytes: 10, durationMs: 1000, configHash: 'b'.repeat(64),
    })),
  ];
  return {
    schemaVersion: '2.0.0', authors, works, audioAssets,
    batches: [
      { batchId: 'F001', feature: 'F001', status: 'published', authorId: '000879', workIds: ['000127'], acceptedAt: '2026-07-01T00:00:00.000Z', publishedAt: '2026-07-01T01:00:00.000Z', evidenceSha256: 'c'.repeat(64) },
      { batchId: 'F002', feature: 'F002', status: 'accepted', authorId: '000081', workIds: ['000473', '043752', '043754'], acceptedAt: '2026-07-02T00:00:00.000Z', evidenceSha256: 'd'.repeat(64) },
    ],
    candidateCounts: {
      total: 4, published: 4, editorialExcluded: 0, audioExcluded: 0,
      byBatch: {
        F001: { total: 1, published: 1, editorialExcluded: 0, audioExcluded: 0 },
        F002: { total: 3, published: 3, editorialExcluded: 0, audioExcluded: 0 },
      },
    },
    creditsRef: 'content/licenses.json',
  };
}

describe('FUN-F002-022 renderAuthorIndex', () => {
  it('全作者をsemantic listへ安全なtext、件数、画像、encoded slugで描画する', () => {
    const catalog = catalogFixture();
    const page = renderAuthorIndex(catalog, new URL('https://example.test/bungo-zundamon/'));
    const items = page.querySelectorAll(':scope .author-list > li');
    expect(items).toHaveLength(2);
    expect(page.querySelector('script, strong')).toBeNull();
    expect(items[0]!.querySelector('h2')?.textContent).toBe('<strong>あくたがわずんのすけ</strong>');
    expect(items[0]!.textContent).toContain('1作品・1台詞');
    expect(items[1]!.textContent).toContain('3作品・3台詞');
    expect(items[1]!.textContent).toContain('原著者: 宮沢賢治');
    expect(items[1]!.querySelector('a')?.getAttribute('href')).toBe('#/authors/miyazawa-zunji');
    expect((items[1]!.querySelector('img') as HTMLImageElement).src).toBe('https://example.test/bungo-zundamon/artwork/miyazawa.png');
  });

  it.each([
    ['0作品author', (catalog: UICatalogV2) => ({ ...catalog, works: catalog.works.filter((work) => work.authorId !== '000081') })],
    ['cross-author batch', (catalog: UICatalogV2) => ({ ...catalog, works: catalog.works.map((work, index) => index === 0 ? { ...work, authorId: '000081' } : work) })],
    ['危険画像path', (catalog: UICatalogV2) => ({ ...catalog, authors: catalog.authors.map((author, index) => index === 0 ? { ...author, artwork: { ...author.artwork, path: 'https://evil.test/x.png' } } : author) })],
  ] as const)('%sはUI_AUTHOR_REFERENCE_INVALIDでfail-closedにする', (_label, mutate) => {
    expect(() => renderAuthorIndex(mutate(catalogFixture()), new URL('https://example.test/app/')))
      .toThrow(expect.objectContaining({ code: 'UI_AUTHOR_REFERENCE_INVALID' }));
  });
});

describe('FUN-F002-023 renderAuthorPageV2', () => {
  it('指定作者の作品・台詞・出典だけを共有controllerへ結び、描画時に再生しない', () => {
    const catalog = catalogFixture();
    const { controller, play, control } = controllerFixture();
    const page = renderAuthorPageV2('000081', catalog, controller, new URL('https://example.test/app/'));
    expect(page.querySelector('h1')?.textContent).toBe('みやざわずんじ');
    expect(page.textContent).toContain('原著者: 宮沢賢治');
    expect(page.textContent).toContain('よだかの星');
    expect(page.textContent).toContain('雪渡り');
    expect(page.textContent).not.toContain('羅生門');
    expect(page.textContent).not.toContain('芥川の台詞');
    expect(page.querySelectorAll('.work-panel')).toHaveLength(3);
    expect(page.querySelectorAll('.dialogue-card')).toHaveLength(3);
    expect(page.querySelector('.source-link')?.getAttribute('href')).toMatch(/^https:\/\/www\.aozora\.gr\.jp\/cards\/000081\//u);
    expect(play).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });

  it.each([
    ['author不在', (catalog: UICatalogV2) => ({ authorId: '999999', catalog, code: 'UI_AUTHOR_NOT_FOUND' })],
    ['0作品', (catalog: UICatalogV2) => ({ authorId: '000081', catalog: { ...catalog, works: catalog.works.filter((work) => work.authorId !== '000081') }, code: 'UI_WORK_AUTHOR_MISMATCH' })],
    ['work/batch作者混線', (catalog: UICatalogV2) => ({ authorId: '000081', catalog: { ...catalog, batches: catalog.batches.map((batch) => batch.batchId === 'F002' ? { ...batch, authorId: '000879' } : batch) }, code: 'UI_WORK_AUTHOR_MISMATCH' })],
    ['dialogue/work混線', (catalog: UICatalogV2) => ({ authorId: '000081', catalog: { ...catalog, works: catalog.works.map((work) => work.workId === '000473' ? { ...work, dialogues: work.dialogues.map((dialogue) => ({ ...dialogue, workId: '000127' })) } : work) }, code: 'UI_DIALOGUE_REFERENCE_INVALID' })],
    ['audio欠落', (catalog: UICatalogV2) => ({ authorId: '000081', catalog: { ...catalog, audioAssets: catalog.audioAssets.filter((asset) => asset.audioId !== 'audio-m-0') }, code: 'UI_DIALOGUE_REFERENCE_INVALID' })],
    ['危険な出典', (catalog: UICatalogV2) => ({ authorId: '000081', catalog: { ...catalog, works: catalog.works.map((work) => work.workId === '000473' ? { ...work, cardLink: 'https://evil.test/card' } : work) }, code: 'UI_WORK_AUTHOR_MISMATCH' })],
  ] as const)('%sを対応UI_*でfail-closedにする', (_label, arrange) => {
    const testCase = arrange(catalogFixture());
    expect(() => renderAuthorPageV2(testCase.authorId, testCase.catalog, controllerFixture().controller, new URL('https://example.test/app/')))
      .toThrow(expect.objectContaining({ code: testCase.code }));
  });

  it('操作targetの44px下限と狭いviewport向けoverflow防止規則を維持する', async () => {
    const css = await readFile(join(process.cwd(), 'src', 'style.css'), 'utf8');
    expect(css).toMatch(/\.play-button,[\s\S]*?min-height:\s*48px;/u);
    expect(css).toMatch(/\.author-list\s*>\s*li,[\s\S]*?min-width:\s*0;/u);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.author-card,[\s\S]*?grid-template-columns:\s*1fr;/u);
  });
});

describe('renderRoute CatalogV2 integration', () => {
  it('解決済みrouteをV2 index・author page・credits・not-foundへ接続する', () => {
    const catalog = catalogFixture();
    const { controller } = controllerFixture();
    const root = document.createElement('main');
    const creditsRenderer = vi.fn(() => {
      const page = document.createElement('article');
      page.dataset.page = 'credits-v2';
      return page;
    });
    const context = {
      controller,
      baseUrl: new URL('https://example.test/app/'),
      motion: 'reduced' as const,
      motionLockedByOs: false,
      onMotionToggle: vi.fn(),
      creditsRenderer,
    };

    renderRoute(root, { kind: 'home' }, catalog, context);
    expect(root.querySelectorAll('.author-list > li')).toHaveLength(2);
    renderRoute(root, { kind: 'author', authorId: '000081', slug: 'miyazawa-zunji' }, catalog, context);
    expect(root.querySelector('[data-author-id="000081"] h1')?.textContent).toBe('みやざわずんじ');
    expect(root.querySelector('.site-header a[aria-current="page"]')?.getAttribute('href')).toBe('#/authors/miyazawa-zunji');
    renderRoute(root, { kind: 'credits' }, catalog, context);
    expect(creditsRenderer).toHaveBeenCalledWith(catalog);
    expect(root.querySelector('[data-page="credits-v2"]')).not.toBeNull();
    renderRoute(root, { kind: 'notFound' }, catalog, context);
    expect(root.querySelector('[data-page="not-found"]')).not.toBeNull();
  });
});
