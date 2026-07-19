import { describe, expect, it, vi } from 'vitest';

import {
  MAX_STRING_SCALARS,
  PUBLIC_AUTHOR,
  SOURCE_TRANSFORMATION,
  NormalizationError,
  ReviewError,
  applyEditorialReview,
  buildPublicCatalog,
  createCandidateId,
  extractDialogueCandidates,
  normalizeDisplayText,
  normalizeSpeechText,
  tokenizeAozoraBody,
  type AssetManifest,
  type Candidate,
  type ReviewRecord,
  type ReviewedContent,
  type TextToken,
  type VoiceGenerationResult,
} from './processing';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const WHEN = '2026-07-18T00:00:00Z';

function candidate(candidateId: string, workId = '000127', order = 0): Candidate {
  return {
    candidateId,
    workId,
    rawSourceSha256: HASH_A,
    order,
    rawTokenRange: { start: order * 10, end: order * 10 + 3 },
    displayText: `「表示${order}」`,
    speechText: `読み${order}`,
    contextBefore: '前',
    contextAfter: '後',
    sourceAnchor: { bodySelector: '.main_text', startToken: order * 10, endToken: order * 10 + 3 },
    extractorVersion: '1.0.0',
    normalizerVersion: '1.0.0',
  };
}

function review(candidateId: string, status: ReviewRecord['status'], revision = 1): ReviewRecord {
  return {
    candidateId,
    revision,
    status,
    reasonCode: status === 'approved' ? 'SPOKEN_DIALOGUE' : status === 'rejected' ? 'NON_SPEECH' : 'PENDING_EDITORIAL_REVIEW',
    reviewer: 'editor',
    reviewedAt: WHEN,
    policyCheckedAt: WHEN,
  };
}

describe('FUN-F001-010 DOM token化 [DES-F001-005][UT-F001-010]', () => {
  it('本文だけをtext/ruby/lineBreakへ変換し、危険・未知要素を除外する', () => {
    document.documentElement.innerHTML = `<body>
      <nav>混入しない</nav>
      <div class="main_text" onclick="globalThis.executed=true">
        <p>彼は<ruby>羅生門<rt>らしょうもん</rt></ruby><br/>へ行く<script>globalThis.executed=true</script></p>
        <widget>未知要素</widget><span class="footnote">脚注</span>
      </div>
    </body>`;

    const tokens = tokenizeAozoraBody(document);
    expect(tokens).toEqual([
      { type: 'text', value: '\n        ' },
      { type: 'text', value: '彼は' },
      { type: 'ruby', base: '羅生門', reading: 'らしょうもん' },
      { type: 'lineBreak' },
      { type: 'text', value: 'へ行く' },
      { type: 'lineBreak' },
      { type: 'text', value: '\n        ' },
      { type: 'text', value: '\n      ' },
    ]);
    expect(tokens.diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown-body-element', element: 'widget' }),
    ]);
    expect((globalThis as { executed?: boolean }).executed).toBeUndefined();
  });

  it('本文がなければfail-closedで拒否する', () => {
    document.documentElement.innerHTML = '<body><main>本文らしき文字</main></body>';
    expect(() => tokenizeAozoraBody(document)).toThrow(/本文コンテナ/);
  });
});

describe('FUN-F001-009 台詞候補抽出 [DES-F001-005][DES-F001-019][UT-F001-009]', () => {
  it('改行跨ぎ・同一段落複数・内側二重括弧・rubyを本文順に抽出する', () => {
    const result = extractDialogueCandidates(
      {
        workId: '000127',
        rawSha256: HASH_A,
        adoptedCharset: 'UTF-8',
        text: `<html><body><div class="main_text"><p>前「一つ<br/>続き『引用』」中「<ruby>言葉<rt>ことば</rt></ruby>」後</p></div></body></html>`,
      },
      '000127',
    );

    // Failure output is included in the assertion to make parser diagnostics actionable.
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
    expect(normalizeDisplayText(result.candidates[0]?.tokens ?? [])).toBe('「一つ\n続き『引用』」');
    expect(result.candidates[1]?.tokens).toContainEqual({ type: 'ruby', base: '言葉', reading: 'ことば' });
    expect(result.candidates.map((item) => item.order)).toEqual([0, 1]);
    expect(result.candidates[0]).not.toHaveProperty('displayText');
    expect(result.candidates[0]).not.toHaveProperty('candidateId');
  });

  it.each([
    ['括弧不足', '<html><body><div class="main_text">「未完</div></body></html>', 'unmatched-opening-bracket'],
    ['本文なし', '<html><body><p>「本文外」</p></body></html>', 'body-missing'],
    ['parser error', '<html><body><div class="main_text">', 'dom-parser-error'],
  ])('%sを理由コード付き失敗にする', (_label, text, code) => {
    const result = extractDialogueCandidates(
      { workId: '000127', rawSha256: HASH_A, adoptedCharset: 'UTF-8', text },
      '000127',
    );
    expect(result.ok).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });

  it('allowlist外workIdを拒否する', () => {
    const result = extractDialogueCandidates(
      {
        workId: 'outside',
        rawSha256: HASH_A,
        adoptedCharset: 'UTF-8',
        text: '<html><body><div class="main_text">「台詞」</div></body></html>',
      },
      'outside',
    );
    expect(result.ok).toBe(false);
  });

  it('Node CLIでDOMParser globalがなくてもinert parserを使用する', () => {
    vi.stubGlobal('DOMParser', undefined);
    try {
      const result = extractDialogueCandidates(
        {
          workId: '000127',
          rawSha256: HASH_A,
          adoptedCharset: 'UTF-8',
          text: '<html><body><div class="main_text">「台詞」<script>globalThis.executed=true</script></div></body></html>',
        },
        '000127',
      );
      expect(result.ok).toBe(true);
      expect((globalThis as { executed?: boolean }).executed).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('FUN-F001-011/012 表示・読み上げ正規化 [DES-F001-006][UT-F001-011][UT-F001-012]', () => {
  const tokens: TextToken[] = [
    { type: 'text', value: '「カ\u3099 ' },
    { type: 'ruby', base: '言葉', reading: 'ことば' },
    { type: 'lineBreak' },
    { type: 'text', value: '〓」' },
  ];

  it('表示文はruby表示と改行を保ってNFCにする', () => {
    expect(normalizeDisplayText(tokens)).toBe('「ガ 言葉\n〓」');
    expect(normalizeDisplayText([{ type: 'text', value: 'あ'.repeat(MAX_STRING_SCALARS) }])).toHaveLength(
      MAX_STRING_SCALARS,
    );
  });

  it.each(['\0', '\ud800', 'あ'.repeat(MAX_STRING_SCALARS + 1)])('不正表示文字列を拒否する', (value) => {
    expect(() => normalizeDisplayText([{ type: 'text', value }])).toThrow(NormalizationError);
  });

  it('ruby読み・外字・空白規則を決定的に適用する', () => {
    const rules = { version: '1.0.0', gaiji: { '〓': 'げた' } };
    expect(normalizeSpeechText(tokens, rules)).toBe('「ガ ことば げた」');
    expect(normalizeSpeechText(tokens, rules)).toBe(normalizeSpeechText(tokens, rules));
    expect(normalizeSpeechText([{ type: 'text', value: '一' }], rules)).toBe('一');
  });

  it('未知規則・未置換外字・空文字をNormalizationErrorにする', () => {
    expect(() => normalizeSpeechText(tokens, { version: '2.0.0' })).toThrow(NormalizationError);
    expect(() => normalizeSpeechText(tokens, { version: '1.0.0' })).toThrow(/外字/);
    expect(() => normalizeSpeechText([], { version: '1.0.0' })).toThrow(NormalizationError);
    expect(() => normalizeSpeechText([{ type: 'text', value: '   ' }], {
      version: '1.0.0',
      collapseWhitespace: false,
    })).toThrow(NormalizationError);
  });
});

describe('FUN-F001-013 安定candidate ID [DES-F001-002][DES-F001-006][UT-F001-013]', () => {
  it('同一tupleは同一URL安全ID、境界変更は別IDになる', () => {
    const args = ['000127', HASH_A, { start: 1, end: 4 }, '1.0.0', '1.0.0', HASH_B] as const;
    const first = createCandidateId(...args);
    expect(createCandidateId(...args)).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCandidateId('000127', HASH_A, { start: 1, end: 5 }, '1.0.0', '1.0.0', HASH_B)).not.toBe(first);
  });

  it.each([
    () => createCandidateId('outside', HASH_A, { start: 1, end: 2 }, '1.0.0', '1.0.0', HASH_B),
    () => createCandidateId('000127', 'bad', { start: 1, end: 2 }, '1.0.0', '1.0.0', HASH_B),
    () => createCandidateId('000127', HASH_A, { start: 2, end: 1 }, '1.0.0', '1.0.0', HASH_B),
    () => createCandidateId('000127', HASH_A, { start: 1, end: 2 }, 'v1', '1.0.0', HASH_B),
  ])('不正tupleではランダムfallbackを作らず停止する', (run) => {
    expect(run).toThrow();
  });
});

// IT-F001-003: 編集レビュー、公開catalog、権利・音声参照の結合境界を追跡する。
describe('FUN-F001-014 編集レビュー [DES-F001-007][UT-F001-014]', () => {
  it('最新revisionだけを採用してstatus・理由を集計する', () => {
    const candidates = [candidate('c1'), candidate('c2', '000127', 1)];
    const result = applyEditorialReview(candidates, [
      review('c1', 'rejected', 1),
      review('c1', 'approved', 2),
      review('c2', 'rejected', 1),
    ]);
    expect(result.counts).toEqual({ approved: 1, rejected: 1, pending: 0 });
    expect(result.approved[0]?.review.revision).toBe(2);
    expect(result.reasonCounts).toEqual({ SPOKEN_DIALOGUE: 1, NON_SPEECH: 1 });
  });

  it('実発話とまとまりのある内心をapproved理由として受理する', () => {
    const candidates = [candidate('spoken'), candidate('inner', '000127', 1)];
    const result = applyEditorialReview(candidates, [
      review('spoken', 'approved'),
      { ...review('inner', 'approved'), reasonCode: 'INNER_MONOLOGUE' },
    ]);

    expect(result.counts).toEqual({ approved: 2, rejected: 0, pending: 0 });
    expect(result.reasonCounts).toEqual({ SPOKEN_DIALOGUE: 1, INNER_MONOLOGUE: 1 });
  });

  it.each([
    () => applyEditorialReview([candidate('c1')], [review('old-id', 'approved')]),
    () => applyEditorialReview([candidate('c1')], [review('c1', 'approved'), review('c1', 'rejected')]),
    () => applyEditorialReview([candidate('c1')], [review('c1', 'pending')]),
    () => applyEditorialReview([candidate('c1')], [{ ...review('c1', 'approved'), reasonCode: '' }]),
    () => applyEditorialReview([candidate('c1')], [{ ...review('c1', 'approved'), reasonCode: 'NON_SPEECH' }]),
    () => applyEditorialReview([candidate('c1')], [{ ...review('c1', 'rejected'), reasonCode: 'SPOKEN_DIALOGUE' }]),
    () => applyEditorialReview([candidate('c1')], [{ ...review('c1', 'rejected'), reasonCode: 'UNKNOWN_REASON' }]),
    () => applyEditorialReview([candidate('c1')], [{ ...review('c1', 'rejected'), reasonCode: 'CONTEXT_RISK_AGGRESSIVE' }]),
    () => applyEditorialReview([candidate('c1'), candidate('c1')], [review('c1', 'approved')]),
  ])('孤立・競合・pending・理由なし・重複をfail-closedにする', (run) => {
    expect(run).toThrow(ReviewError);
  });
});

describe('FUN-F001-015 公開catalog [DES-F001-002][DES-F001-007][DES-F001-013][UT-F001-015]', () => {
  function fixture(): { input: ReviewedContent; voice: VoiceGenerationResult; assets: AssetManifest } {
    const candidates = [
      candidate('c1', '000127', 0),
      candidate('c2', '000092', 1),
      candidate('c3', '043015', 2),
      candidate('c4', '043015', 3),
    ];
    const reviewResult = applyEditorialReview(candidates, [
      review('c1', 'approved'),
      review('c2', 'approved'),
      review('c3', 'approved'),
      review('c4', 'rejected'),
    ]);
    const audio = {
      audioId: 'audio-shared',
      path: 'audio/F001/shared.wav',
      sha256: HASH_A,
      bytes: 100,
      durationMs: 1_000,
      configHash: HASH_B,
      candidateIds: ['c1', 'c2'],
    };
    return {
      input: {
        schemaVersion: '1.0.0',
        author: { ...PUBLIC_AUTHOR, artwork: { ...PUBLIC_AUTHOR.artwork } },
        works: [
          {
            workId: '000127',
            title: '羅生門',
            cardLink: 'https://www.aozora.gr.jp/cards/000879/card127.html',
            source: {
              cardUrl: 'https://www.aozora.gr.jp/cards/000879/card127.html',
              textUrl: 'https://www.aozora.gr.jp/cards/000879/files/127_15260.html',
              attribution: '青空文庫『羅生門』（芥川龍之介）', baseEdition: '芥川龍之介全集1',
              inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ', fetchedAt: WHEN,
              transformation: SOURCE_TRANSFORMATION, sourceSha256: HASH_A,
            },
            candidateIds: ['c1'],
          },
          {
            workId: '000092',
            title: '蜘蛛の糸',
            cardLink: 'https://www.aozora.gr.jp/cards/000879/card92.html',
            source: {
              cardUrl: 'https://www.aozora.gr.jp/cards/000879/card92.html',
              textUrl: 'https://www.aozora.gr.jp/cards/000879/files/92_14545.html',
              attribution: '青空文庫『蜘蛛の糸』（芥川龍之介）', baseEdition: '芥川龍之介全集2',
              inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ', fetchedAt: WHEN,
              transformation: SOURCE_TRANSFORMATION, sourceSha256: HASH_A,
            },
            candidateIds: ['c2'],
          },
          {
            workId: '043015',
            title: '杜子春',
            cardLink: 'https://www.aozora.gr.jp/cards/000879/card43015.html',
            source: {
              cardUrl: 'https://www.aozora.gr.jp/cards/000879/card43015.html',
              textUrl: 'https://www.aozora.gr.jp/cards/000879/files/43015_17432.html',
              attribution: '青空文庫『杜子春』（芥川龍之介）', baseEdition: '蜘蛛の糸・杜子春',
              inputter: '蒋龍', proofreader: 'noriko saito', fetchedAt: WHEN,
              transformation: SOURCE_TRANSFORMATION, sourceSha256: HASH_A,
            },
            candidateIds: ['c3', 'c4'],
          },
        ],
        review: reviewResult,
        creditsRef: 'content/credits.json',
        futureExpansionPolicy: {
          eligibilityCriteria: '対象条件を再確認する',
          rightsRecheck: '権利と規約を再確認する',
          stagedAddition: '作品単位で段階追加する',
        },
      },
      voice: {
        assets: [audio],
        failures: [{ audioId: 'failed-c3', candidateIds: ['c3'], reasonCode: 'wav-invalid' }],
        attempted: 2,
        succeeded: 1,
        failed: 1,
        configHash: HASH_B,
      },
      assets: { assets: [audio] },
    };
  }

  it('approvedかつ音声成功だけを公開し、共有audioと3区分集計を維持する', () => {
    const { input, voice, assets } = fixture();
    const catalog = buildPublicCatalog(input, voice, assets);
    expect(catalog.works.flatMap((work) => work.dialogues).map((item) => item.dialogueId)).toEqual(['c1', 'c2']);
    expect(catalog.works.flatMap((work) => work.dialogues).map((item) => item.audioId)).toEqual([
      'audio-shared',
      'audio-shared',
    ]);
    expect(catalog.audioAssets).toHaveLength(1);
    expect(catalog.candidateCounts).toMatchObject({
      total: 4,
      published: 2,
      editorialExcluded: 1,
      audioExcluded: 1,
    });
    expect(input.review.all).toHaveLength(4);
  });

  it('理由なし音声失敗・pending・孤立asset・絶対path・重複IDを拒否する', () => {
    const missingReason = fixture();
    missingReason.voice.failures[0]!.reasonCode = '';
    expect(() => buildPublicCatalog(missingReason.input, missingReason.voice, missingReason.assets)).toThrow();

    const pending = fixture();
    pending.input.review.pending.push(pending.input.review.approved[0]!);
    pending.input.review.counts.pending = 1;
    expect(() => buildPublicCatalog(pending.input, pending.voice, pending.assets)).toThrow(/pending/);

    const orphan = fixture();
    orphan.assets.assets.push({ ...orphan.assets.assets[0]!, audioId: 'orphan', path: 'audio/orphan.wav' });
    expect(() => buildPublicCatalog(orphan.input, orphan.voice, orphan.assets)).toThrow(/参照されない/);

    const absolute = fixture();
    absolute.assets.assets[0]!.path = 'https://evil.example/audio.wav';
    absolute.voice.assets[0]!.path = 'https://evil.example/audio.wav';
    expect(() => buildPublicCatalog(absolute.input, absolute.voice, absolute.assets)).toThrow(/相対path/);

    const duplicate = fixture();
    duplicate.input.review.all.push(duplicate.input.review.all[0]!);
    expect(() => buildPublicCatalog(duplicate.input, duplicate.voice, duplicate.assets)).toThrow();
  });

  it('固定作者・作品対応・青空文庫出典・レビューpartition・音声設定hashをfail-closedで検証する', () => {
    const badAuthor = fixture();
    badAuthor.input.author.name = '別人';
    expect(() => buildPublicCatalog(badAuthor.input, badAuthor.voice, badAuthor.assets)).toThrow(/作者/);

    const badOriginalAuthor = fixture();
    badOriginalAuthor.input.author.originalName = '別人';
    expect(() => buildPublicCatalog(badOriginalAuthor.input, badOriginalAuthor.voice, badOriginalAuthor.assets)).toThrow(/作者/);

    const badArtwork = fixture();
    badArtwork.input.author.artwork.path = 'artwork/other.png';
    expect(() => buildPublicCatalog(badArtwork.input, badArtwork.voice, badArtwork.assets)).toThrow(/作者/);

    const badTitle = fixture();
    badTitle.input.works[0]!.title = '同名別作品';
    expect(() => buildPublicCatalog(badTitle.input, badTitle.voice, badTitle.assets)).toThrow(/作品ID/);

    const badOrigin = fixture();
    badOrigin.input.works[0]!.cardLink = 'https://example.com/cards/000879/card127.html';
    expect(() => buildPublicCatalog(badOrigin.input, badOrigin.voice, badOrigin.assets)).toThrow(/固定origin/);

    const badSourceMetadata = fixture();
    badSourceMetadata.input.works[0]!.source.baseEdition = '別底本';
    expect(() => buildPublicCatalog(badSourceMetadata.input, badSourceMetadata.voice, badSourceMetadata.assets)).toThrow(/metadata/);

    const badSourceHash = fixture();
    badSourceHash.input.works[0]!.source.sourceSha256 = HASH_B;
    expect(() => buildPublicCatalog(badSourceHash.input, badSourceHash.voice, badSourceHash.assets)).toThrow(/SHA-256/);

    const tamperedPartition = fixture();
    tamperedPartition.input.review.approved[0] = {
      ...tamperedPartition.input.review.approved[0]!,
      review: { ...tamperedPartition.input.review.approved[0]!.review, status: 'rejected' },
    };
    expect(() => buildPublicCatalog(tamperedPartition.input, tamperedPartition.voice, tamperedPartition.assets)).toThrow(
      /status|partition/,
    );

    const wrongConfig = fixture();
    wrongConfig.assets.assets[0]!.configHash = HASH_A;
    wrongConfig.voice.assets[0]!.configHash = HASH_A;
    expect(() => buildPublicCatalog(wrongConfig.input, wrongConfig.voice, wrongConfig.assets)).toThrow(/設定hash/);
  });
});
