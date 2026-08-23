import { createHash } from 'node:crypto';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { computeDHash64V1 } from './f005-artwork.ts';
import {
  F011ArtworkError,
  isMintedF011ArtworkAcceptance,
  isMintedF011ArtworkProvenance,
  parseAndRehydrateF011ArtworkProvenance,
  sealF011ArtworkProvenance,
  serializeF011ArtworkProvenance,
  verifyF011ArtworkAgainstCatalog,
  type ArtworkGenerationF011Input,
  type ArtworkInputsF011,
  type ArtworkProvenanceF011,
  type ExistingArtworkInputF011,
  type F011FinalArtworkInput,
} from './f011-artwork.ts';

/**
 * ComfyUIは本セッション時点で他プロジェクトの動画生成ジョブでビジー中のため、
 * 新美南吉の作者画像は本タスクでは実生成しない（別途実施）。本ファイルは
 * UT相当（seal/rehydrate/near-duplicate判定ロジック）を合成PNGだけで検証する
 * （`f010-artwork.test.ts`と同型）。IT-F011相当（実配置画像・実provenance
 * artifactを読む結合試験）はComfyUI生成完了後に別途カバーする。
 */

const sourcePath = 'content/batches/F011/public-files/artwork/niimi-nankichi-zundamon.png';
const publicPath = 'artwork/niimi-nankichi-zundamon.png';

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number?],
): Uint8Array {
  const image = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha = 255] = pixel(x, y);
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = alpha;
    }
  }
  return new Uint8Array(PNG.sync.write(image, { colorType: 6 }));
}

function patternedDHash(bits: bigint): Uint8Array {
  return png(9, 8, (x, y) => {
    let value = 128;
    for (let column = 0; column < x; column += 1) {
      const bit = 63 - (y * 8 + column);
      value += (bits & (1n << BigInt(bit))) === 0n ? 8 : -8;
    }
    return [value, value, value, 255];
  });
}

function generation(bytes: Uint8Array): ArtworkGenerationF011Input {
  return {
    generator: 'ComfyUI (local)',
    generatorVersion: '0.19.3',
    model: 'flux1-schnell-fp8.safetensors',
    workflow: 'UNETLoader -> DualCLIPLoader -> VAELoader -> CLIPTextEncode -> EmptySD3LatentImage -> KSampler -> VAEDecode -> SaveImage',
    prompt: '新美南吉を想起させる独自の文豪風ずんだもん。',
    negativePrompt: '',
    seed: 738_201_546,
    generatedAt: '2026-08-24T19:48:40.006Z',
    originalImageBytes: bytes,
  };
}

const noInputs: ArtworkInputsF011 = { referenceInputs: [] };

function finalImage(bytes: Uint8Array): F011FinalArtworkInput {
  return {
    sourcePath,
    publicPath,
    credit: '新美南吉ずんだもん：ローカルComfyUI(FLUX.1 schnell)による独自生成（入力・参照画像なし）',
    bytes,
  };
}

function rehydratedProvenance(
  bytes: Uint8Array,
  generationInput = generation(bytes),
  inputLineage: ArtworkInputsF011 = noInputs,
): ArtworkProvenanceF011 {
  const sealed = sealF011ArtworkProvenance(generationInput, inputLineage, finalImage(bytes));
  return parseAndRehydrateF011ArtworkProvenance(
    serializeF011ArtworkProvenance(sealed),
    generationInput,
    inputLineage,
    finalImage(bytes),
  );
}

function expectedError(operation: () => unknown, code: F011ArtworkError['code']): void {
  expect(operation).toThrowError(F011ArtworkError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

/** @des DES-F011-012 @fun FUN-F011-014 @ut UT-F011-014 */
describe('UT-F011-014 ArtworkProvenanceF011 seal', () => {
  it('exact final image path・参照入力exact []・実generationをsealする', () => {
    const bytes = patternedDHash(0n);
    const provenance = sealF011ArtworkProvenance(generation(bytes), noInputs, finalImage(bytes));
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      manifestId: 'artwork-F011-000121-v1',
      identity: { batchId: 'F011', authorId: '000121', outputPath: publicPath },
      inputs: { referenceInputs: [] },
      output: { publicPath, dHash64: '0000000000000000', mediaType: 'image/png' },
    });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(provenance.generation.originalImageSha256).toBe(sha256(bytes));
    expect(provenance.provenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('runtime brandをartifactへ混ぜずcanonical serialize→再起動rehydrateする', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF011ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    expect(isMintedF011ArtworkProvenance(sealed)).toBe(true);
    const serialized = serializeF011ArtworkProvenance(sealed);
    expect(serialized).toBe(canonicalJson(JSON.parse(serialized)));
    const restored = parseAndRehydrateF011ArtworkProvenance(
      serialized,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    expect(isMintedF011ArtworkProvenance(restored)).toBe(true);
    expect(serializeF011ArtworkProvenance(restored)).toBe(serialized);
  });

  it('exact final image pathの不一致を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF011ArtworkProvenance(generation(bytes), noInputs, {
        ...finalImage(bytes),
        publicPath: 'artwork/other.png' as never,
      }),
      'F011_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('参照入力1件以上を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF011ArtworkProvenance(
        generation(bytes),
        { referenceInputs: ['x'] } as unknown as ArtworkInputsF011,
        finalImage(bytes),
      ),
      'F011_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('必須fieldの欠落を拒否する', () => {
    const bytes = patternedDHash(0n);
    const valid = generation(bytes);
    for (const key of Object.keys(valid)) {
      const invalid = { ...valid } as Record<string, unknown>;
      delete invalid[key];
      expectedError(
        () => sealF011ArtworkProvenance(
          invalid as unknown as ArtworkGenerationF011Input,
          noInputs,
          finalImage(bytes),
        ),
        'F011_ARTWORK_PROVENANCE_INVALID',
      );
    }
  });

  it('PNG decode失敗を拒否する（既存verifyPngjsLockfileIntegrity経由）', () => {
    const invalidPng = new Uint8Array([1, 2, 3]);
    expectedError(
      () => sealF011ArtworkProvenance(generation(invalidPng), noInputs, finalImage(invalidPng)),
      'F011_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('生成原本SHAと最終SHAの不一致を拒否する', () => {
    const original = patternedDHash(0n);
    const changed = patternedDHash(0x1ffn);
    expectedError(
      () => sealF011ArtworkProvenance(generation(original), noInputs, finalImage(changed)),
      'F011_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('全field tamperとseal再計算だけではrehydrateできない', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF011ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    const original = JSON.parse(serializeF011ArtworkProvenance(sealed)) as Record<string, unknown>;
    type Segment = string | number;
    const leafPaths = (value: unknown, path: Segment[] = []): Segment[][] => {
      if (Array.isArray(value)) {
        if (value.length === 0) return [path];
        return value.flatMap((child, index) => leafPaths(child, [...path, index]));
      }
      if (value !== null && typeof value === 'object') {
        return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...path, key]));
      }
      return [path];
    };
    const paths = leafPaths(original);
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      const changed = structuredClone(original);
      let parent: unknown = changed;
      for (const segment of path.slice(0, -1)) parent = (parent as Record<string, unknown>)[segment as string];
      const lastKey = path.at(-1)!;
      const container = parent as Record<Segment, unknown>;
      container[lastKey] = typeof container[lastKey] === 'number' ? 999_999 : 'tampered';
      expect(() => parseAndRehydrateF011ArtworkProvenance(
        canonicalJson(changed),
        generationInput,
        noInputs,
        finalImage(bytes),
      )).toThrowError(F011ArtworkError);
    }
  });
});

/** @des DES-F011-012 @fun FUN-F011-015 @ut UT-F011-015 */
describe('UT-F011-015 byte/SHA/dHash near-duplicate acceptance', () => {
  function existing(authorId: string, path: string, bytes: Uint8Array): ExistingArtworkInputF011 {
    return { authorId, path, bytes, sha256: sha256(bytes), dHash64: computeDHash64V1(bytes) };
  }

  function provenance(bytes: Uint8Array): ArtworkProvenanceF011 {
    return rehydratedProvenance(bytes);
  }

  const nine = (override?: readonly ExistingArtworkInputF011[]) => override ?? [
    existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
    existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
    existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
    existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
    existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
    existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
    existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
    existing('h', 'artwork/h.png', patternedDHash(0x7777_7777_7777_7777n)),
    existing('i', 'artwork/i.png', patternedDHash(0x1234_5678_9abc_def0n)),
  ];

  it('dHash距離8を拒否し9以上を受理する', () => {
    const final = patternedDHash(0n);
    const pass = verifyF011ArtworkAgainstCatalog(provenance(final), final, nine());
    expect(pass.minimumHammingDistance).toBeGreaterThanOrEqual(9);

    const distance8 = patternedDHash(0xffn);
    expectedError(
      () => verifyF011ArtworkAgainstCatalog(provenance(final), final, nine([
        existing('a', 'artwork/a.png', distance8),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
        existing('h', 'artwork/h.png', patternedDHash(0x7777_7777_7777_7777n)),
        existing('i', 'artwork/i.png', patternedDHash(0x1234_5678_9abc_def0n)),
      ])),
      'F011_ARTWORK_NEAR_DUPLICATE',
    );
  });

  it('byte一致・既存側の偽SHA・偽dHash・件数不足を拒否する', () => {
    const final = patternedDHash(0n);
    const identical = existing('z', 'artwork/z.png', final);
    expectedError(
      () => verifyF011ArtworkAgainstCatalog(provenance(final), final, nine([
        existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
        existing('h', 'artwork/h.png', patternedDHash(0x7777_7777_7777_7777n)),
        identical,
      ])),
      'F011_ARTWORK_NEAR_DUPLICATE',
    );
    const farA = existing('a', 'artwork/a.png', patternedDHash(0x1ffn));
    expectedError(
      () => verifyF011ArtworkAgainstCatalog(provenance(final), final, nine([
        { ...farA, sha256: '0'.repeat(64) },
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
        existing('h', 'artwork/h.png', patternedDHash(0x7777_7777_7777_7777n)),
        existing('i', 'artwork/i.png', patternedDHash(0x1234_5678_9abc_def0n)),
      ])),
      'F011_ARTWORK_EXISTING_INVALID',
    );
    // 既存9作者未満（下限判定）は拒否する
    expectedError(
      () => verifyF011ArtworkAgainstCatalog(provenance(final), final, nine().slice(0, 8)),
      'F011_ARTWORK_EXISTING_INVALID',
    );
  });

  it('10作者目（既存10件）でも下限判定を通過し受理する（将来の作者統合を想定）', () => {
    const final = patternedDHash(0n);
    const pass = verifyF011ArtworkAgainstCatalog(provenance(final), final, [
      ...nine(),
      existing('j', 'artwork/j.png', patternedDHash(0x0fed_cba9_8765_4321n)),
    ]);
    expect(pass.result).toBe('pass');
  });

  it('authorId 000121の衝突を拒否する', () => {
    const final = patternedDHash(0n);
    expectedError(
      () => verifyF011ArtworkAgainstCatalog(provenance(final), final, nine([
        existing('000121', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
        existing('h', 'artwork/h.png', patternedDHash(0x7777_7777_7777_7777n)),
        existing('i', 'artwork/i.png', patternedDHash(0x1234_5678_9abc_def0n)),
      ])),
      'F011_ARTWORK_EXISTING_INVALID',
    );
  });

  it('ArtworkAcceptanceをWeakSet brandでmintし構造clone・sealedOnly比較を拒否する', () => {
    const final = patternedDHash(0n);
    const sealedOnly = sealF011ArtworkProvenance(generation(final), noInputs, finalImage(final));
    const acceptance = verifyF011ArtworkAgainstCatalog(sealedOnly, final, nine());
    expect(isMintedF011ArtworkAcceptance(acceptance)).toBe(true);
    expect(isMintedF011ArtworkAcceptance(structuredClone(acceptance))).toBe(false);
  });
});
