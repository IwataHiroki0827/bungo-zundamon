import { createHash } from 'node:crypto';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { computeDHash64V1 } from './f005-artwork.ts';
import {
  F009ArtworkError,
  isMintedF009ArtworkAcceptance,
  isMintedF009ArtworkProvenance,
  parseAndRehydrateF009ArtworkProvenance,
  sealF009ArtworkProvenance,
  serializeF009ArtworkProvenance,
  verifyF009ArtworkAgainstCatalog,
  type ArtworkGenerationF009Input,
  type ArtworkInputsF009,
  type ArtworkProvenanceF009,
  type ExistingArtworkInputF009,
  type F009FinalArtworkInput,
} from './f009-artwork.ts';

/**
 * 本セッション（2026-08-23）はローカルComfyUI（FLUX.1 schnell）で夢野久作の
 * 作者画像を実生成済みであり、`f009-catalog.test.ts`/実データ側でIT-F009相当
 * （実配置画像・実provenance artifactを読む結合試験）を別途カバーする。本
 * ファイルはUT相当（seal/rehydrate/near-duplicate判定ロジック）を合成PNGで
 * 検証する。
 */

const sourcePath = 'content/batches/F009/public-files/artwork/yumeno-kyusaku-zundamon.png';
const publicPath = 'artwork/yumeno-kyusaku-zundamon.png';

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

function generation(bytes: Uint8Array): ArtworkGenerationF009Input {
  return {
    generator: 'ComfyUI (local)',
    generatorVersion: '0.19.3',
    model: 'flux1-schnell-fp8.safetensors',
    workflow: 'UNETLoader -> DualCLIPLoader -> VAELoader -> CLIPTextEncode -> EmptySD3LatentImage -> KSampler -> VAEDecode -> SaveImage',
    prompt: '夢野久作を想起させる独自の文豪風ずんだもん。',
    negativePrompt: '',
    seed: 419_283_651,
    generatedAt: '2026-08-23T17:05:32.236Z',
    originalImageBytes: bytes,
  };
}

const noInputs: ArtworkInputsF009 = { referenceInputs: [] };

function finalImage(bytes: Uint8Array): F009FinalArtworkInput {
  return {
    sourcePath,
    publicPath,
    credit: '夢野久作ずんだもん：ローカルComfyUI(FLUX.1 schnell)による独自生成（入力・参照画像なし）',
    bytes,
  };
}

function rehydratedProvenance(
  bytes: Uint8Array,
  generationInput = generation(bytes),
  inputLineage: ArtworkInputsF009 = noInputs,
): ArtworkProvenanceF009 {
  const sealed = sealF009ArtworkProvenance(generationInput, inputLineage, finalImage(bytes));
  return parseAndRehydrateF009ArtworkProvenance(
    serializeF009ArtworkProvenance(sealed),
    generationInput,
    inputLineage,
    finalImage(bytes),
  );
}

function expectedError(operation: () => unknown, code: F009ArtworkError['code']): void {
  expect(operation).toThrowError(F009ArtworkError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

/** @des DES-F009-012 @fun FUN-F009-014 @ut UT-F009-014 */
describe('UT-F009-014 ArtworkProvenanceF009 seal', () => {
  it('exact final image path・参照入力exact []・実generationをsealする', () => {
    const bytes = patternedDHash(0n);
    const provenance = sealF009ArtworkProvenance(generation(bytes), noInputs, finalImage(bytes));
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      manifestId: 'artwork-F009-000096-v1',
      identity: { batchId: 'F009', authorId: '000096', outputPath: publicPath },
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
    const sealed = sealF009ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    expect(isMintedF009ArtworkProvenance(sealed)).toBe(true);
    const serialized = serializeF009ArtworkProvenance(sealed);
    expect(serialized).toBe(canonicalJson(JSON.parse(serialized)));
    const restored = parseAndRehydrateF009ArtworkProvenance(
      serialized,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    expect(isMintedF009ArtworkProvenance(restored)).toBe(true);
    expect(serializeF009ArtworkProvenance(restored)).toBe(serialized);
  });

  it('exact final image pathの不一致を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF009ArtworkProvenance(generation(bytes), noInputs, {
        ...finalImage(bytes),
        publicPath: 'artwork/other.png' as never,
      }),
      'F009_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('参照入力1件以上を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF009ArtworkProvenance(
        generation(bytes),
        { referenceInputs: ['x'] } as unknown as ArtworkInputsF009,
        finalImage(bytes),
      ),
      'F009_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('必須fieldの欠落を拒否する', () => {
    const bytes = patternedDHash(0n);
    const valid = generation(bytes);
    for (const key of Object.keys(valid)) {
      const invalid = { ...valid } as Record<string, unknown>;
      delete invalid[key];
      expectedError(
        () => sealF009ArtworkProvenance(
          invalid as unknown as ArtworkGenerationF009Input,
          noInputs,
          finalImage(bytes),
        ),
        'F009_ARTWORK_PROVENANCE_INVALID',
      );
    }
  });

  it('PNG decode失敗を拒否する（既存verifyPngjsLockfileIntegrity経由）', () => {
    const invalidPng = new Uint8Array([1, 2, 3]);
    expectedError(
      () => sealF009ArtworkProvenance(generation(invalidPng), noInputs, finalImage(invalidPng)),
      'F009_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('生成原本SHAと最終SHAの不一致を拒否する', () => {
    const original = patternedDHash(0n);
    const changed = patternedDHash(0x1ffn);
    expectedError(
      () => sealF009ArtworkProvenance(generation(original), noInputs, finalImage(changed)),
      'F009_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('全field tamperとseal再計算だけではrehydrateできない', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF009ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    const original = JSON.parse(serializeF009ArtworkProvenance(sealed)) as Record<string, unknown>;
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
      expect(() => parseAndRehydrateF009ArtworkProvenance(
        canonicalJson(changed),
        generationInput,
        noInputs,
        finalImage(bytes),
      )).toThrowError(F009ArtworkError);
    }
  });
});

/** @des DES-F009-012 @fun FUN-F009-015 @ut UT-F009-015 */
describe('UT-F009-015 byte/SHA/dHash near-duplicate acceptance', () => {
  function existing(authorId: string, path: string, bytes: Uint8Array): ExistingArtworkInputF009 {
    return { authorId, path, bytes, sha256: sha256(bytes), dHash64: computeDHash64V1(bytes) };
  }

  function provenance(bytes: Uint8Array): ArtworkProvenanceF009 {
    return rehydratedProvenance(bytes);
  }

  const seven = (override?: readonly ExistingArtworkInputF009[]) => override ?? [
    existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
    existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
    existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
    existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
    existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
    existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
    existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
  ];

  it('dHash距離8を拒否し9以上を受理する', () => {
    const final = patternedDHash(0n);
    const pass = verifyF009ArtworkAgainstCatalog(provenance(final), final, seven());
    expect(pass.minimumHammingDistance).toBeGreaterThanOrEqual(9);

    const distance8 = patternedDHash(0xffn);
    expectedError(
      () => verifyF009ArtworkAgainstCatalog(provenance(final), final, seven([
        existing('a', 'artwork/a.png', distance8),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
      ])),
      'F009_ARTWORK_NEAR_DUPLICATE',
    );
  });

  it('byte一致・既存側の偽SHA・偽dHash・件数不足を拒否する', () => {
    const final = patternedDHash(0n);
    const identical = existing('z', 'artwork/z.png', final);
    expectedError(
      () => verifyF009ArtworkAgainstCatalog(provenance(final), final, seven([
        existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        identical,
      ])),
      'F009_ARTWORK_NEAR_DUPLICATE',
    );
    const farA = existing('a', 'artwork/a.png', patternedDHash(0x1ffn));
    expectedError(
      () => verifyF009ArtworkAgainstCatalog(provenance(final), final, seven([
        { ...farA, sha256: '0'.repeat(64) },
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
      ])),
      'F009_ARTWORK_EXISTING_INVALID',
    );
    // 既存7作者未満（下限判定）は拒否する
    expectedError(
      () => verifyF009ArtworkAgainstCatalog(provenance(final), final, seven().slice(0, 6)),
      'F009_ARTWORK_EXISTING_INVALID',
    );
  });

  it('8作者目（既存8件）でも下限判定を通過し受理する（将来のF010統合を想定）', () => {
    const final = patternedDHash(0n);
    const pass = verifyF009ArtworkAgainstCatalog(provenance(final), final, [
      ...seven(),
      existing('h', 'artwork/h.png', patternedDHash(0x7777_7777_7777_7777n)),
    ]);
    expect(pass.result).toBe('pass');
  });

  it('authorId 000096の衝突を拒否する', () => {
    const final = patternedDHash(0n);
    expectedError(
      () => verifyF009ArtworkAgainstCatalog(provenance(final), final, seven([
        existing('000096', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
        existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
      ])),
      'F009_ARTWORK_EXISTING_INVALID',
    );
  });

  it('ArtworkAcceptanceをWeakSet brandでmintし構造clone・sealedOnly比較を拒否する', () => {
    const final = patternedDHash(0n);
    const sealedOnly = sealF009ArtworkProvenance(generation(final), noInputs, finalImage(final));
    const acceptance = verifyF009ArtworkAgainstCatalog(sealedOnly, final, seven());
    expect(isMintedF009ArtworkAcceptance(acceptance)).toBe(true);
    expect(isMintedF009ArtworkAcceptance(structuredClone(acceptance))).toBe(false);
  });
});
