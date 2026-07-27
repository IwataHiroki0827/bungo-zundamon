import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CandidateWithRevisions } from './batch-production.ts';
import {
  EDITORIAL_TRANSACTION_ROOT,
  hashEditorialCandidates,
  type EditorialJudgmentExternalResult,
  type ReviewRunAuthorization,
} from './editorial-independent.ts';
import {
  F004EditorialError,
  compileF004SpeechRevisions,
  extractF004DialogueCandidates,
  reconcileF004Judgments,
  registerF004ReviewAuthorizations,
  sealF004JudgmentSet,
  type F004SpeechRevision,
} from './f004-editorial.ts';
import type { FixedF004Source } from './f004-source.ts';

const roots: string[] = [];
const H = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function source(body: string): FixedF004Source {
  const rawSha256 = H(body);
  return {
    __brand: 'FixedF004Source',
    work: {
      workId: '000466',
      title: 'オツベルと象',
      cardUrl: 'https://www.aozora.gr.jp/cards/000081/card466.html',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000081/files/466_42316.html',
      recordPath: 'data/source.json',
      rawPath: 'data/source.raw',
      rawSha256,
      rawBytes: body.length,
      bibliographyCharset: 'Shift_JIS',
      baseEdition: '新編　銀河鉄道の夜',
      inputter: 'r.sawai',
      proofreader: '篠宮康彰',
      sourceUpdatedAt: '2011-02-14',
      fetchedAt: '2026-07-27T14:33:06.149Z',
    },
    record: {
      workId: '000466',
      sourceUrl: 'https://www.aozora.gr.jp/cards/000081/files/466_42316.html',
      rawPath: '000466/source.raw',
      rawSha256,
      bibliographyCharset: 'Shift_JIS',
      httpCharset: 'Shift_JIS',
      mediaType: 'text/html',
      fetchedAt: '2026-07-27T14:33:06.149Z',
    },
    decoded: {
      workId: '000466',
      rawSha256,
      httpCharset: 'Shift_JIS',
      metaCharset: 'Shift_JIS',
      bibliographyCharset: 'Shift_JIS',
      adoptedCharset: 'Shift_JIS',
      text: `<?xml version="1.0" encoding="UTF-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><body>
          <p>本文外「除外」</p>
          <div class="main_text">${body}</div>
        </body></html>`,
    },
    bodySelector: '.main_text',
    sourceSha256: H(`fixed:${body}`),
  } as unknown as FixedF004Source;
}

function authorization(
  role: 'primary' | 'secondary',
  candidates: ReturnType<typeof extractF004DialogueCandidates>['reviewCandidates'],
): ReviewRunAuthorization {
  const suffix = role;
  return {
    authorizationId: `f004-000466-${suffix}`,
    role,
    producerTaskPath: `/root/f004/reviewer-${suffix}`,
    judgeRole: role,
    runId: `f004-000466-${suffix}-run`,
    candidateSetSha256: hashEditorialCandidates(candidates),
    policySha256: H('policy'),
    promptSha256: H(`prompt:${role}`),
    toolSha256: H('tool'),
    nonce: `f004-000466-${suffix}-nonce`,
    issuedAt: '2026-07-28T00:00:00.000Z',
    inputRefs: [
      {
        kind: 'candidateSet',
        path: 'data/batches/F004/work-artifacts/000466/intermediate/000466/candidates.json',
        sha256: H('candidate-artifact'),
      },
      { kind: 'policy', path: 'docs/srs/SRS-F004.md', sha256: H('policy') },
      { kind: 'prompt', path: 'docs/tests/ut/UT-F004.md', sha256: H(`prompt:${role}`) },
      { kind: 'tool', path: 'src/content/f004-editorial.ts', sha256: H('tool') },
    ],
    candidates,
  };
}

function external(
  auth: ReviewRunAuthorization,
  decision: 'approved' | 'rejected' = 'approved',
): EditorialJudgmentExternalResult {
  return {
    schemaVersion: '1.0.0',
    authorizationId: auth.authorizationId,
    role: auth.role,
    runId: auth.runId,
    candidateSetSha256: auth.candidateSetSha256,
    policySha256: auth.policySha256,
    promptSha256: auth.promptSha256,
    toolSha256: auth.toolSha256,
    judgments: auth.candidates.map((candidate) => ({
      ...candidate,
      decision,
      reasonCode: decision === 'approved' ? 'SPOKEN_DIALOGUE' : 'NON_SPEECH',
      speaker: decision === 'approved' ? '白象' : null,
    })),
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-f004-editorial-'));
  roots.push(root);
  await mkdir(join(root, ...EDITORIAL_TRANSACTION_ROOT.split('/')), { recursive: true });
  return root;
}

describe('UT-F004-008 外側括弧抽出 [DES-F004-004][FUN-F004-008]', () => {
  it('本文内の外側「」だけをruby・入れ子・複数行込みで決定的に候補化する', () => {
    const fixed = source(
      '<p>「白い<ruby><rb>象</rb><rt>ぞう</rt></ruby>だ。<br />「内側」もある」『対象外』</p><p>「次だ」</p>',
    );
    const first = extractF004DialogueCandidates(fixed);
    const second = extractF004DialogueCandidates(fixed);
    expect(first).toEqual(second);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates[0]?.displayText).toContain('「内側」');
    expect(first.candidates[0]?.speechText).toContain('ぞう');
    expect(first.candidates.every((candidate, index) => candidate.order === index)).toBe(true);
    expect(first.reviewCandidateSetSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('壊れた外側括弧と未承認extractor versionをfail-closedにする', () => {
    expect(() => extractF004DialogueCandidates(source('<p>「閉じない</p>')))
      .toThrowError(expect.objectContaining({ code: 'F004_EXTRACTION_INVALID' }));
    expect(() => extractF004DialogueCandidates(source('<p>「台詞」</p>'), '2.0.0'))
      .toThrowError(expect.objectContaining({ code: 'F004_EXTRACTION_INVALID' }));
  });
});

describe('UT-F004-009〜010 独立review seal・照合 [DES-F004-004][FUN-F004-009][FUN-F004-010]', () => {
  it('exact F004 authorizationだけを登録・sealし、二つの独立一致判定を確定する', async () => {
    const candidates = extractF004DialogueCandidates(source('<p>「そうだ」</p>')).reviewCandidates;
    const primary = authorization('primary', candidates);
    const secondary = authorization('secondary', candidates);
    const root = await workspace();
    await registerF004ReviewAuthorizations(root, [primary, secondary]);
    const primarySet = await sealF004JudgmentSet(root, primary, external(primary));
    const secondarySet = await sealF004JudgmentSet(root, secondary, external(secondary));
    const result = reconcileF004Judgments(candidates, primarySet, secondarySet);
    expect(result.pendingIds).toEqual([]);
    expect(result.resolutions[0]).toMatchObject({
      finalDecision: 'approved',
      resolutionSource: 'agreement',
      speaker: '白象',
    });
    await expect(sealF004JudgmentSet(root, primary, external(primary)))
      .rejects.toMatchObject({ code: 'F004_REVIEW_AUTHORIZATION_INVALID' });
  });

  it('work path差を拒否し、二判定不一致をpendingとして停止する', async () => {
    const candidates = extractF004DialogueCandidates(source('<p>「そうだ」</p>')).reviewCandidates;
    const primary = authorization('primary', candidates);
    const secondary = authorization('secondary', candidates);
    await expect(registerF004ReviewAuthorizations(await workspace(), [{
      ...primary,
      inputRefs: primary.inputRefs.map((reference) =>
        reference.kind === 'candidateSet' ? { ...reference, path: 'data/other.json' } : reference),
    }])).rejects.toMatchObject({ code: 'F004_REVIEW_AUTHORIZATION_INVALID' });

    const root = await workspace();
    await registerF004ReviewAuthorizations(root, [primary, secondary]);
    const primarySet = await sealF004JudgmentSet(root, primary, external(primary, 'approved'));
    const secondarySet = await sealF004JudgmentSet(root, secondary, external(secondary, 'rejected'));
    expect(() => reconcileF004Judgments(candidates, primarySet, secondarySet))
      .toThrowError(expect.objectContaining({ code: 'F004_REVIEW_PENDING' }));
  });
});

describe('UT-F004-011 speech revision chain [DES-F004-004][FUN-F004-011]', () => {
  function approved(): CandidateWithRevisions {
    return extractF004DialogueCandidates(source('<p>「そうだ」</p>')).candidates[0]!;
  }

  function revision(candidate: CandidateWithRevisions, after = '「そうなのだ」'): F004SpeechRevision {
    return {
      candidateId: candidate.candidateId,
      revision: 1,
      before: candidate.speechText,
      beforeSha256: H(candidate.speechText),
      after,
      afterSha256: H(after),
      reason: 'VOICEVOX読み調整',
      reviewer: 'editor',
      reviewedAt: '2026-07-28T00:00:00.000Z',
    };
  }

  it('display textを保持し、連続するspeech hash chainだけを適用する', () => {
    const candidate = approved();
    const result = compileF004SpeechRevisions([candidate], [revision(candidate)]);
    expect(result[0]?.displayText).toBe(candidate.displayText);
    expect(result[0]?.speechText).toBe('「そうなのだ」');
    expect(result[0]?.speechSha256).toBe(H('「そうなのだ」'));
  });

  it('hash差・飛越し・循環・別candidateを拒否する', () => {
    const candidate = approved();
    const valid = revision(candidate);
    const invalidCases: readonly F004SpeechRevision[][] = [
      [{ ...valid, beforeSha256: H('different') }],
      [{ ...valid, revision: 2 }],
      [{ ...valid, after: candidate.speechText, afterSha256: H(candidate.speechText) }],
      [{ ...valid, candidateId: 'another-candidate' }],
    ];
    for (const invalid of invalidCases) {
      expect(() => compileF004SpeechRevisions([candidate], invalid))
        .toThrowError(F004EditorialError);
    }
  });
});
