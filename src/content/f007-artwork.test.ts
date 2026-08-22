import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { computeDHash64V1 } from './f005-artwork.ts';
import {
  F007ArtworkError,
  isMintedF007ArtworkAcceptance,
  isMintedF007ArtworkProvenance,
  parseAndRehydrateF007ArtworkProvenance,
  sealF007ArtworkProvenance,
  serializeF007ArtworkProvenance,
  verifyF007ArtworkAgainstCatalog,
  type ArtworkGenerationF007Input,
  type ArtworkInputsF007,
  type ArtworkProvenanceF007,
  type ExistingArtworkInputF007,
  type F007FinalArtworkInput,
} from './f007-artwork.ts';

const workspace = process.cwd();
const sourcePath = 'content/batches/F007/public-files/artwork/mori-ogai-zundamon.png';
const publicPath = 'artwork/mori-ogai-zundamon.png';

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

function generation(bytes: Uint8Array): ArtworkGenerationF007Input {
  return {
    generator: 'ComfyUI (local)',
    generatorVersion: '0.19.3',
    model: 'flux1-schnell-fp8.safetensors',
    workflow: 'UNETLoader -> DualCLIPLoader -> VAELoader -> CLIPTextEncode -> EmptySD3LatentImage -> KSampler -> VAEDecode -> SaveImage',
    prompt: '森鴎外を想起させる独自の文豪風ずんだもん。',
    negativePrompt: '',
    seed: 208_070_129,
    generatedAt: '2026-08-21T16:34:40.907Z',
    originalImageBytes: bytes,
  };
}

const noInputs: ArtworkInputsF007 = { referenceInputs: [] };

function finalImage(bytes: Uint8Array): F007FinalArtworkInput {
  return {
    sourcePath,
    publicPath,
    credit: '森鴎外ずんだもん：ローカルComfyUI(FLUX.1 schnell)による独自生成（入力・参照画像なし）',
    bytes,
  };
}

function rehydratedProvenance(
  bytes: Uint8Array,
  generationInput = generation(bytes),
  inputLineage: ArtworkInputsF007 = noInputs,
): ArtworkProvenanceF007 {
  const sealed = sealF007ArtworkProvenance(generationInput, inputLineage, finalImage(bytes));
  return parseAndRehydrateF007ArtworkProvenance(
    serializeF007ArtworkProvenance(sealed),
    generationInput,
    inputLineage,
    finalImage(bytes),
  );
}

function expectedError(operation: () => unknown, code: F007ArtworkError['code']): void {
  expect(operation).toThrowError(F007ArtworkError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

/** @des DES-F007-012 @fun FUN-F007-014 @ut UT-F007-014 */
describe('UT-F007-014 ArtworkProvenanceF007 seal', () => {
  it('exact final image path・参照入力exact []・実generationをsealする', () => {
    const bytes = patternedDHash(0n);
    const provenance = sealF007ArtworkProvenance(generation(bytes), noInputs, finalImage(bytes));
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      manifestId: 'artwork-F007-000129-v1',
      identity: { batchId: 'F007', authorId: '000129', outputPath: publicPath },
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
    const sealed = sealF007ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    expect(isMintedF007ArtworkProvenance(sealed)).toBe(true);
    const serialized = serializeF007ArtworkProvenance(sealed);
    expect(serialized).toBe(canonicalJson(JSON.parse(serialized)));
    const restored = parseAndRehydrateF007ArtworkProvenance(
      serialized,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    expect(isMintedF007ArtworkProvenance(restored)).toBe(true);
    expect(serializeF007ArtworkProvenance(restored)).toBe(serialized);
  });

  it('exact final image pathの不一致を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF007ArtworkProvenance(generation(bytes), noInputs, {
        ...finalImage(bytes),
        publicPath: 'artwork/other.png' as never,
      }),
      'F007_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('参照入力1件以上を拒否する', () => {
    const bytes = patternedDHash(0n);
    expectedError(
      () => sealF007ArtworkProvenance(
        generation(bytes),
        { referenceInputs: ['x'] } as unknown as ArtworkInputsF007,
        finalImage(bytes),
      ),
      'F007_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('必須fieldの欠落を拒否する', () => {
    const bytes = patternedDHash(0n);
    const valid = generation(bytes);
    for (const key of Object.keys(valid)) {
      const invalid = { ...valid } as Record<string, unknown>;
      delete invalid[key];
      expectedError(
        () => sealF007ArtworkProvenance(
          invalid as unknown as ArtworkGenerationF007Input,
          noInputs,
          finalImage(bytes),
        ),
        'F007_ARTWORK_PROVENANCE_INVALID',
      );
    }
  });

  it('PNG decode失敗を拒否する（既存verifyPngjsLockfileIntegrity経由）', () => {
    const invalidPng = new Uint8Array([1, 2, 3]);
    expectedError(
      () => sealF007ArtworkProvenance(generation(invalidPng), noInputs, finalImage(invalidPng)),
      'F007_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('生成原本SHAと最終SHAの不一致を拒否する', () => {
    const original = patternedDHash(0n);
    const changed = patternedDHash(0x1ffn);
    expectedError(
      () => sealF007ArtworkProvenance(generation(original), noInputs, finalImage(changed)),
      'F007_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('全field tamperとseal再計算だけではrehydrateできない', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF007ArtworkProvenance(generationInput, noInputs, finalImage(bytes));
    const original = JSON.parse(serializeF007ArtworkProvenance(sealed)) as Record<string, unknown>;
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
      expect(() => parseAndRehydrateF007ArtworkProvenance(
        canonicalJson(changed),
        generationInput,
        noInputs,
        finalImage(bytes),
      )).toThrowError(F007ArtworkError);
    }
  });
});

/** @des DES-F007-012 @fun FUN-F007-015 @ut UT-F007-015 */
describe('UT-F007-015 byte/SHA/dHash near-duplicate acceptance', () => {
  function existing(authorId: string, path: string, bytes: Uint8Array): ExistingArtworkInputF007 {
    return { authorId, path, bytes, sha256: sha256(bytes), dHash64: computeDHash64V1(bytes) };
  }

  function provenance(bytes: Uint8Array): ArtworkProvenanceF007 {
    return rehydratedProvenance(bytes);
  }

  const five = (override?: readonly ExistingArtworkInputF007[]) => override ?? [
    existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
    existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
    existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
    existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
    existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
  ];

  it('dHash距離8を拒否し9以上を受理する', () => {
    const final = patternedDHash(0n);
    const pass = verifyF007ArtworkAgainstCatalog(provenance(final), final, five());
    expect(pass.minimumHammingDistance).toBeGreaterThanOrEqual(9);

    const distance8 = patternedDHash(0xffn);
    expectedError(
      () => verifyF007ArtworkAgainstCatalog(provenance(final), final, five([
        existing('a', 'artwork/a.png', distance8),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
      ])),
      'F007_ARTWORK_NEAR_DUPLICATE',
    );
  });

  it('byte一致・既存側の偽SHA・偽dHash・件数不一致を拒否する', () => {
    const final = patternedDHash(0n);
    const identical = existing('z', 'artwork/z.png', final);
    expectedError(
      () => verifyF007ArtworkAgainstCatalog(provenance(final), final, five([
        existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        identical,
      ])),
      'F007_ARTWORK_NEAR_DUPLICATE',
    );
    const farA = existing('a', 'artwork/a.png', patternedDHash(0x1ffn));
    expectedError(
      () => verifyF007ArtworkAgainstCatalog(provenance(final), final, five([
        { ...farA, sha256: '0'.repeat(64) },
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
      ])),
      'F007_ARTWORK_EXISTING_INVALID',
    );
    expectedError(
      () => verifyF007ArtworkAgainstCatalog(provenance(final), final, five().slice(0, 3)),
      'F007_ARTWORK_EXISTING_INVALID',
    );
  });

  it('authorId 000129の衝突を拒否する', () => {
    const final = patternedDHash(0n);
    expectedError(
      () => verifyF007ArtworkAgainstCatalog(provenance(final), final, five([
        existing('000129', 'artwork/a.png', patternedDHash(0x1ffn)),
        existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
        existing('d', 'artwork/d.png', patternedDHash(0x0f0f_0f0f_0f0f_0f0fn)),
        existing('e', 'artwork/e.png', patternedDHash(0x3333_3333_3333_3333n)),
      ])),
      'F007_ARTWORK_EXISTING_INVALID',
    );
  });

  it('ArtworkAcceptanceをWeakSet brandでmintし構造clone・sealedOnly比較を拒否する', () => {
    const final = patternedDHash(0n);
    const sealedOnly = sealF007ArtworkProvenance(generation(final), noInputs, finalImage(final));
    const acceptance = verifyF007ArtworkAgainstCatalog(sealedOnly, final, five());
    expect(isMintedF007ArtworkAcceptance(acceptance)).toBe(true);
    expect(isMintedF007ArtworkAcceptance(structuredClone(acceptance))).toBe(false);
  });
});

/** @des DES-F007-012 @fun FUN-F007-014 FUN-F007-015 @it IT-F007-008 */
describe('IT-F007-008 actual F007 artwork acceptance', () => {
  it('永続provenanceを再結合し、配置済み森鴎外画像を既存公開5画像と実byte/SHA/dHash比較して受理する', async () => {
    const finalBytes = new Uint8Array(await readFile(resolve(workspace, sourcePath)));
    const artifactText = await readFile(
      resolve(workspace, 'content/batches/F007/artwork-provenance.json'),
      'utf8',
    );
    const artifact = JSON.parse(artifactText) as ArtworkProvenanceF007;
    const artifactGeneration: ArtworkGenerationF007Input = {
      generator: 'ComfyUI (local)',
      generatorVersion: artifact.generation.generatorVersion,
      model: artifact.generation.model,
      workflow: artifact.generation.workflow,
      prompt: artifact.generation.prompt,
      negativePrompt: artifact.generation.negativePrompt,
      seed: artifact.generation.seed,
      generatedAt: artifact.generation.generatedAt,
      originalImageBytes: finalBytes,
    };
    const provenance = parseAndRehydrateF007ArtworkProvenance(
      artifactText,
      artifactGeneration,
      noInputs,
      { sourcePath, publicPath, credit: artifact.credit, bytes: finalBytes },
    );
    expect(serializeF007ArtworkProvenance(provenance)).toBe(artifactText);
    expect(provenance.output.dHash64).toBe('d6ccc76e73bbd27a');
    expect(provenance.output.sha256).toBe(
      '05497a8c663d96c8152e4e815a38e16d4934b027ae0f5252acab2efd7f7ef0b8',
    );

    const files = [
      ['000879', 'artwork/akutagawa-zundamon.png'],
      ['000081', 'artwork/miyazawa-zundamon.png'],
      ['000035', 'artwork/dazai-zundamon.png'],
      ['000148', 'artwork/natsume-zundamon.png'],
      ['000119', 'artwork/nakajima-zundamon.png'],
    ] as const;
    const existingArtwork: ExistingArtworkInputF007[] = [];
    for (const [authorId, path] of files) {
      const bytes = new Uint8Array(await readFile(resolve(workspace, 'public', path)));
      existingArtwork.push({
        authorId,
        path,
        bytes,
        sha256: sha256(bytes),
        dHash64: computeDHash64V1(bytes),
      });
    }
    const acceptance = verifyF007ArtworkAgainstCatalog(provenance, finalBytes, existingArtwork);
    expect(acceptance).toMatchObject({
      result: 'pass',
      path: publicPath,
      alt: '森鴎外をイメージしたずんだもんの独自イラスト',
      sha256: sha256(finalBytes),
      sourceProvenancePath: 'content/batches/F007/artwork-provenance.json',
    });
    expect(acceptance.minimumHammingDistance).toBeGreaterThanOrEqual(9);
    expect(acceptance.comparisons.every((comparison) => comparison.hammingDistance >= 9)).toBe(true);

    // 参照入力1件混入は拒否される
    expect(() => sealF007ArtworkProvenance(
      artifactGeneration,
      { referenceInputs: ['x'] } as unknown as ArtworkInputsF007,
      { sourcePath, publicPath, credit: artifact.credit, bytes: finalBytes },
    )).toThrowError(F007ArtworkError);

    // authorId衝突は拒否される
    expect(() => verifyF007ArtworkAgainstCatalog(provenance, finalBytes, [
      { ...existingArtwork[0]!, authorId: '000129' },
      ...existingArtwork.slice(1),
    ])).toThrowError(F007ArtworkError);
  });
});
