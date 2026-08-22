import { createHash } from 'node:crypto';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { computeDHash64V1 } from './f005-artwork.ts';
import {
  F008ArtworkError,
  isMintedF008ArtworkAcceptance,
  isMintedF008ArtworkProvenance,
  parseAndRehydrateF008ArtworkProvenance,
  sealF008ArtworkProvenance,
  serializeF008ArtworkProvenance,
  verifyF008ArtworkAgainstCatalog,
  type ArtworkGenerationF008Input,
  type ArtworkInputsF008,
  type ArtworkProvenanceF008,
  type ExistingArtworkInputF008,
  type F008FinalArtworkInput,
} from './f008-artwork.ts';

/**
 * 本セッション（2026-08-22）はローカルComfyUI（`http://127.0.0.1:59008`）へ
 * 接続できず、江戸川乱歩の作者画像を実生成していない。そのためF007の
 * `f007-artwork.test.ts`が持つIT-F008相当（実配置画像・実provenance
 * artifactを読む結合試験）は本ファイルには含めず、UT相当（seal/rehydrate/
 * near-duplicate判定ロジック）だけを合成PNGで検証する。実データ生成後に
 * 追加すること。
 */

const sourcePath = 'content/batches/F008/public-files/artwork/edogawa-ranpo-zundamon.png';
const publicPath = 'artwork/edogawa-ranpo-zundamon.png';

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

function generation(bytes: Uint8Array): ArtworkGenerationF008Input {
  return {
    generator: 'ComfyUI (local)',
    generatorVersion: '0.19.3',
    model: 'flux1-schnell-fp8.safetensors',
    workflow: 'UNETLoader -> DualCLIPLoader -> VAELoader -> CLIPTextEncode -> EmptySD3LatentImage -> KSampler -> VAEDecode -> SaveImage',
    prompt: '江戸川乱歩を想起させる独自の文豪風ずんだもん。',
    negativePrompt: '',
    seed: 208_001_779,
    generatedAt: '2026-08-22T00:00:00.000Z',
    originalImageBytes: bytes,
  };
}

const noInputs: ArtworkInputsF008 = { referenceInputs: [] };

function finalImage(bytes: Uint8Array): F008FinalArtworkInput {
  return {
    sourcePath,
    publicPath,
    credit: '江戸川乱歩ずんだもん：ローカルComfyUI(FLUX.1 schnell)による独自生成（入力・参照画像なし）',
    bytes,
  };
}

function rehydratedProvenance(
  bytes: Uint8Array,
  generationInput = generation(bytes),
  inputLineage: ArtworkInputsF008 = noInputs,
): ArtworkProvenanceF008 {
  const sealed = sealF008ArtworkProvenance(generationInput, inputLineage, finalImage(bytes));
  return parseAndRehydrateF008ArtworkProvenance(
    serializeF008ArtworkProvenance(sealed),
    generationInput,
    inputLineage,
    finalImage(bytes),
  );
}

function expectedError(operation: () => unknown, code: F008ArtworkError['code']): void {
  expect(operation).toThrowError(F008ArtworkError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

/** @des DES-F008-012 @fun FUN-F008-014 @ut UT-F008-014 */
describe('UT-F008-014 ArtworkProvenanceF008 seal', () => {
  it('exact final image path・参照入力exact []・実generationをsealする', () => {
    const bytes = patternedDHash(0n);
    const provenance = sealF008ArtworkProvenance(generation(bytes), noInputs, finalImage(bytes));
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      manifestId: 'artwork-F008-001779-v1',
      identity: { batchId: 'F008', authorId: '001779', outputPath: publicPath },
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
    const sealed = sealF008ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    expect(isMintedF008ArtworkProvenance(sealed)).toBe(true);
    const serialized = serializeF008ArtworkProvenance(sealed);
    expect(serialized).toBe(canonicalJson(JSON.parse(serialized)));
    const restored = parseAndRehydrateF008ArtworkProvenance(
      serialized,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    expect(isMintedF008ArtworkProvenance(restored)).toBe(true);
    expect(serializeF008ArtworkProvenance(restored)).toBe(serialized);
  });

  it('exact final image pathの不一致を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF008ArtworkProvenance(generation(bytes), noInputs, {
        ...finalImage(bytes),
        publicPath: 'artwork/other.png' as never,
      }),
      'F008_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('参照入力1件以上を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF008ArtworkProvenance(
        generation(bytes),
        { referenceInputs: ['x'] } as unknown as ArtworkInputsF008,
        finalImage(bytes),
      ),
      'F008_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('必須fieldの欠落を拒否する', () => {
    const bytes = patternedDHash(0n);
    const valid = generation(bytes);
    for (const key of Object.keys(valid)) {
      const invalid = { ...valid } as Record<string, unknown>;
      delete invalid[key];
      expectedError(
        () => sealF008ArtworkProvenance(
          invalid as unknown as ArtworkGenerationF008Input,
          noInputs,
          finalImage(bytes),
        ),
        'F008_ARTWORK_PROVENANCE_INVALID',
      );
    }
  });

  it('PNG decode失敗を拒否する（既存verifyPngjsLockfileIntegrity経由）', () => {
    const invalidPng = new Uint8Array([1, 2, 3]);
    expectedError(
      () => sealF008ArtworkProvenance(generation(invalidPng), noInputs, finalImage(invalidPng)),
      'F008_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('生成原本SHAと最終SHAの不一致を拒否する', () => {
    const original = patternedDHash(0n);
    const changed = patternedDHash(0x1ffn);
    expectedError(
      () => sealF008ArtworkProvenance(generation(original), noInputs, finalImage(changed)),
      'F008_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('全field tamperとseal再計算だけではrehydrateできない', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF008ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    const original = JSON.parse(serializeF008ArtworkProvenance(sealed)) as Record<string, unknown>;
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
      expect(() => parseAndRehydrateF008ArtworkProvenance(
        canonicalJson(changed),
        generationInput,
        noInputs,
        finalImage(bytes),
      )).toThrowError(F008ArtworkError);
    }
  });
});

/** @des DES-F008-012 @fun FUN-F008-015 @ut UT-F008-015 */
describe('UT-F008-015 byte/SHA/dHash near-duplicate acceptance', () => {
  function existing(authorId: string, path: string, bytes: Uint8Array): ExistingArtworkInputF008 {
    return { authorId, path, bytes, sha256: sha256(bytes), dHash64: computeDHash64V1(bytes) };
  }

  function provenance(bytes: Uint8Array): ArtworkProvenanceF008 {
    return rehydratedProvenance(bytes);
  }

  const six = (override?: readonly ExistingArtworkInputF008[]) => override ?? [
    existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
    existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
    existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
    existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
    existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
    existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
  ];

  it('dHash距離8を拒否し9以上を受理する', () => {
    const final = patternedDHash(0n);
    const pass = verifyF008ArtworkAgainstCatalog(provenance(final), final, six());
    expect(pass.minimumHammingDistance).toBeGreaterThanOrEqual(9);

    const distance8 = patternedDHash(0xffn);
    expectedError(
      () => verifyF008ArtworkAgainstCatalog(provenance(final), final, six([
        existing('a', 'artwork/a.png', distance8),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
      ])),
      'F008_ARTWORK_NEAR_DUPLICATE',
    );
  });

  it('byte一致・既存側の偽SHA・偽dHash・件数不足を拒否する', () => {
    const final = patternedDHash(0n);
    const identical = existing('z', 'artwork/z.png', final);
    expectedError(
      () => verifyF008ArtworkAgainstCatalog(provenance(final), final, six([
        existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        identical,
      ])),
      'F008_ARTWORK_NEAR_DUPLICATE',
    );
    const farA = existing('a', 'artwork/a.png', patternedDHash(0x1ffn));
    expectedError(
      () => verifyF008ArtworkAgainstCatalog(provenance(final), final, six([
        { ...farA, sha256: '0'.repeat(64) },
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
      ])),
      'F008_ARTWORK_EXISTING_INVALID',
    );
    // 既存6作者未満（下限判定）は拒否する
    expectedError(
      () => verifyF008ArtworkAgainstCatalog(provenance(final), final, six().slice(0, 5)),
      'F008_ARTWORK_EXISTING_INVALID',
    );
  });

  it('7作者目（既存7件）でも下限判定を通過し受理する（将来のF009統合を想定）', () => {
    const final = patternedDHash(0n);
    const pass = verifyF008ArtworkAgainstCatalog(provenance(final), final, [
      ...six(),
      existing('g', 'artwork/g.png', patternedDHash(0x6666_6666_6666_6666n)),
    ]);
    expect(pass.result).toBe('pass');
  });

  it('authorId 001779の衝突を拒否する', () => {
    const final = patternedDHash(0n);
    expectedError(
      () => verifyF008ArtworkAgainstCatalog(provenance(final), final, six([
        existing('001779', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
        existing('f', 'artwork/f.png', patternedDHash(0x0000_ffff_0000_ffffn)),
      ])),
      'F008_ARTWORK_EXISTING_INVALID',
    );
  });

  it('ArtworkAcceptanceをWeakSet brandでmintし構造clone・sealedOnly比較を拒否する', () => {
    const final = patternedDHash(0n);
    const sealedOnly = sealF008ArtworkProvenance(generation(final), noInputs, finalImage(final));
    const acceptance = verifyF008ArtworkAgainstCatalog(sealedOnly, final, six());
    expect(isMintedF008ArtworkAcceptance(acceptance)).toBe(true);
    expect(isMintedF008ArtworkAcceptance(structuredClone(acceptance))).toBe(false);
  });
});
