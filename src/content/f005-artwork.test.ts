import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeDHash64V1,
  F005_ARTWORK_POLICY_SNAPSHOTS,
  F005ArtworkError,
  isMintedF005ArtworkAcceptance,
  isMintedF005ArtworkProvenance,
  parseAndRehydrateF005ArtworkProvenance,
  sealF005ArtworkProvenance,
  serializeF005ArtworkProvenance,
  verifyF005ArtworkAgainstCatalog,
  verifyPngjsLockfileIntegrity,
  type ArtworkGenerationV4Input,
  type ArtworkInputsV4,
  type ArtworkProvenanceV4,
  type ExistingArtworkInput,
  type F005FinalArtworkInput,
} from './f005-artwork.ts';
import { canonicalJson } from './artifacts.ts';
import {
  loadVerifiedF005Definition,
  type F005ApprovedBatchContext,
} from './f005-context.ts';

const workspace = process.cwd();
const outputPath =
  'content/batches/F005/public-files/artwork/natsume-zundamon.png';
const execFileAsync = promisify(execFile);
const acceptanceCommit = '0c4c5ba2234df5443b65ee1c2a0a6370e44e0d28';

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function exifOrientation(bytes: Uint8Array, orientation: number): Uint8Array {
  const payload = Uint8Array.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const type = new TextEncoder().encode('eXIf');
  const chunk = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.byteLength, false);
  chunk.set(type, 4);
  chunk.set(payload, 8);
  view.setUint32(8 + payload.byteLength, crc32(chunk.subarray(4, 8 + payload.byteLength)), false);
  const ihdrEnd = 8 + 12 + 13;
  const result = new Uint8Array(bytes.byteLength + chunk.byteLength);
  result.set(bytes.subarray(0, ihdrEnd));
  result.set(chunk, ihdrEnd);
  result.set(bytes.subarray(ihdrEnd), ihdrEnd + chunk.byteLength);
  return result;
}

function generation(bytes: Uint8Array): ArtworkGenerationV4Input {
  return {
    generator: 'OpenAI',
    generatorVersion: 'built-in-imagegen-2026-07',
    tool: 'built-in image_gen',
    providerTerms: { ...F005_ARTWORK_POLICY_SNAPSHOTS.providerTerms },
    characterGuideline: { ...F005_ARTWORK_POLICY_SNAPSHOTS.characterGuideline },
    prompt: '夏目漱石を想起させる独自の文豪風ずんだもん。',
    negativePrompt: '実在人物の写真、第三者画像、文字、ロゴ、透かし。',
    generatedAt: '2026-07-29T00:00:00Z',
    originalImageBytes: bytes,
  };
}

const noInputs: ArtworkInputsV4 = {
  referenceInputs: [],
  processingInputs: [],
};

function finalImage(bytes: Uint8Array): F005FinalArtworkInput {
  return {
    sourcePath: outputPath,
    publicPath: 'artwork/natsume-zundamon.png',
    credit: '夏目漱石ずんだもん：OpenAI built-in image_genによる独自生成（参照画像なし）',
    bytes,
  };
}

function rehydratedProvenance(
  bytes: Uint8Array,
  generationInput = generation(bytes),
  inputLineage: ArtworkInputsV4 = noInputs,
): ArtworkProvenanceV4 {
  const sealed = sealF005ArtworkProvenance(
    context,
    generationInput,
    inputLineage,
    finalImage(bytes),
  );
  return parseAndRehydrateF005ArtworkProvenance(
    context,
    serializeF005ArtworkProvenance(sealed),
    generationInput,
    inputLineage,
    finalImage(bytes),
  );
}

function expectedError(operation: () => unknown, code: F005ArtworkError['code']): void {
  expect(operation).toThrowError(F005ArtworkError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
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

let context: F005ApprovedBatchContext;
let cleanFixtureRoot: string;

beforeAll(async () => {
  cleanFixtureRoot = await mkdtemp(resolve(tmpdir(), 'f005-artwork-context-'));
  const checkout = resolve(cleanFixtureRoot, 'checkout');
  await execFileAsync(
    'git',
    ['clone', '--quiet', '--no-hardlinks', '-c', 'core.autocrlf=false', workspace, checkout],
  );
  await execFileAsync('git', ['checkout', '--quiet', '-b', 'f005-artwork-fixture', acceptanceCommit], {
    cwd: checkout,
  });
  context = await loadVerifiedF005Definition(checkout);
}, 120_000);

afterAll(async () => {
  if (cleanFixtureRoot) await rm(cleanFixtureRoot, { recursive: true, force: true });
});

/** @des DES-F005-008 @fun FUN-F005-028 @ut UT-F005-028 */
describe('UT-F005-028 PNG preflight and dHash64-v1', () => {
  it('pngjs 7.0.0の設計固定integrityだけを受理する', () => {
    const lockfile = readFileSync(resolve(workspace, 'package-lock.json'), 'utf8');
    expect(() => verifyPngjsLockfileIntegrity(lockfile)).not.toThrow();
    const changed = lockfile.replace(
      'sha512-LKWqWJRhstyYo9pGvgor/ivk2w94eSjE3RGVuzLGlr3NmD8bf7RcYGze1mNdEHRP6TRP6rMuDHk5t44hnTRyow==',
      `sha512-${'x'.repeat(88)}`,
    );
    expectedError(
      () => verifyPngjsLockfileIntegrity(changed),
      'F005_PNG_DECODER_INTEGRITY_INVALID',
    );
  });

  it('9x8増加・減少vectorを先頭bit MSBの固定hexへする', () => {
    expect(computeDHash64V1(png(9, 8, (x) => [31 * x, 31 * x, 31 * x])))
      .toBe('0000000000000000');
    expect(computeDHash64V1(png(9, 8, (x) => [31 * (8 - x), 31 * (8 - x), 31 * (8 - x)])))
      .toBe('ffffffffffffffff');
  });

  it('10x9非等倍vectorを16.16 half-up bilinearで5aへ固定する', () => {
    const bytes = png(10, 9, (x) => {
      const value = x % 2 === 0 ? 0 : 255;
      return [value, value, value];
    });
    expect(computeDHash64V1(bytes)).toBe('5a5a5a5a5a5a5a5a');
  });

  it('alphaを白背景合成しBT.601を適用し、eXIf orientationも反映する', () => {
    const increasing = png(9, 8, (x) => [31 * x, 31 * x, 31 * x, x === 0 ? 0 : 255]);
    expect(computeDHash64V1(increasing)).not.toBe('0000000000000000');
    const opaque = png(9, 8, (x) => [31 * x, 31 * x, 31 * x, 255]);
    expect(computeDHash64V1(exifOrientation(opaque, 3))).toBe('ffffffffffffffff');
  });

  it('encoded/dimension/chunk/APNG/trailing上限をdecode前に拒否する', () => {
    const base = png(9, 8, (x) => [x, x, x]);
    const oversized = new Uint8Array(16_777_217);
    const badWidth = new Uint8Array(base);
    new DataView(badWidth.buffer).setUint32(16, 4_097, false);
    const trailing = new Uint8Array(base.byteLength + 1);
    trailing.set(base);
    const apng = new Uint8Array(base);
    const idatType = new TextEncoder().encode('IDAT');
    const index = Buffer.from(apng).indexOf(idatType);
    apng.set(new TextEncoder().encode('acTL'), index);
    for (const value of [oversized, badWidth, trailing, apng, new Uint8Array([1, 2, 3])]) {
      expectedError(() => computeDHash64V1(value), 'F005_PNG_PREFLIGHT_INVALID');
    }
  });
});

/** @des DES-F005-008 @fun FUN-F005-029 @ut UT-F005-029 */
describe('UT-F005-029 ArtworkProvenanceV4 seal', () => {
  it('mint済みapproval context、author identity、参照入力0件、全lineageをsealする', () => {
    const bytes = patternedDHash(0n);
    const provenance = sealF005ArtworkProvenance(
      context,
      generation(bytes),
      noInputs,
      finalImage(bytes),
    );
    expect(provenance).toMatchObject({
      schemaVersion: '4.0.0',
      batchId: 'F005',
      authorId: '000148',
      approvalBinding: {
        requirementApprovalSnapshot: '18e3fa50edfe5214480a65ed2e840fe49a663ee2',
        candidateIdentitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f',
      },
      inputs: { referenceInputs: [], processingInputs: [] },
      output: {
        publicPath: 'artwork/natsume-zundamon.png',
        dHash64: '0000000000000000',
      },
    });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect('__brand' in provenance).toBe(false);
    expect(provenance.generation.originalImageSha256).toBe(sha256(bytes));
    expect(provenance.provenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('runtime brandをartifactへ混ぜずcanonical serialize→再起動rehydrateする', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF005ArtworkProvenance(
      context,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    expect(isMintedF005ArtworkProvenance(sealed)).toBe(false);
    const serialized = serializeF005ArtworkProvenance(sealed);
    expect(serialized).not.toContain('__brand');
    expect(serialized).toBe(canonicalJson(JSON.parse(serialized)));
    const restored = parseAndRehydrateF005ArtworkProvenance(
      context,
      serialized,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    expect(isMintedF005ArtworkProvenance(restored)).toBe(true);
    expect(serializeF005ArtworkProvenance(restored)).toBe(serialized);
  });

  it('OpenAI termsとcharacter guidelineの固定snapshot両方を必須にする', () => {
    const bytes = patternedDHash(0n);
    const valid = generation(bytes);
    const invalid = [
      { ...valid, providerTerms: undefined },
      { ...valid, characterGuideline: undefined },
      {
        ...valid,
        providerTerms: { ...valid.providerTerms, decision: 'deny' },
      },
      {
        ...valid,
        characterGuideline: {
          ...valid.characterGuideline,
          contentSha256: '0'.repeat(64),
        },
      },
    ];
    for (const generationInput of invalid) {
      expectedError(
        () => sealF005ArtworkProvenance(
          context,
          generationInput as unknown as ArtworkGenerationV4Input,
          noInputs,
          finalImage(bytes),
        ),
        'F005_ARTWORK_PROVENANCE_INVALID',
      );
    }
  });

  it('original A→final Bとprocessing差替えを拒否し、同一byte chainだけを記録する', () => {
    const original = patternedDHash(0n);
    const changed = patternedDHash(0x1ffn);
    expectedError(
      () => sealF005ArtworkProvenance(
        context,
        generation(original),
        noInputs,
        finalImage(changed),
      ),
      'F005_ARTWORK_PROVENANCE_INVALID',
    );
    expectedError(
      () => sealF005ArtworkProvenance(
        context,
        generation(original),
        {
          referenceInputs: [],
          processingInputs: [{
            order: 1,
            inputId: 'processing-1',
            path: 'content/batches/F005/artwork-processing/1.png',
            origin: 'generated-original',
            bytes: changed,
          }],
        },
        finalImage(original),
      ),
      'F005_ARTWORK_PROVENANCE_INVALID',
    );
    const lineage: ArtworkInputsV4 = {
      referenceInputs: [],
      processingInputs: [{
        order: 1,
        inputId: 'processing-1',
        path: 'content/batches/F005/artwork-processing/1.png',
        origin: 'generated-original',
        bytes: original,
      }],
    };
    const provenance = sealF005ArtworkProvenance(
      context,
      generation(original),
      lineage,
      finalImage(original),
    );
    expect(provenance.inputs).toMatchObject({
      generatedOriginal: { sha256: sha256(original), bytes: original.byteLength },
      processingInputs: [{
        order: 1,
        sha256: sha256(original),
        bytes: original.byteLength,
      }],
      finalInputSha256: sha256(original),
      finalInputBytes: original.byteLength,
    });
  });

  it('全field tamperとseal再計算だけではrehydrateできない', () => {
    const bytes = patternedDHash(0n);
    const generationInput = generation(bytes);
    const sealed = sealF005ArtworkProvenance(
      context,
      generationInput,
      noInputs,
      finalImage(bytes),
    );
    const original = JSON.parse(serializeF005ArtworkProvenance(sealed)) as Record<string, unknown>;
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
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) {
      const changed = structuredClone(original);
      let parent: unknown = changed;
      for (const segment of path.slice(0, -1)) {
        parent = (parent as Record<Segment, unknown>)[segment];
      }
      const key = path.at(-1)!;
      const record = parent as Record<Segment, unknown>;
      const current = record[key];
      record[key] = Array.isArray(current)
        ? ['tampered']
        : typeof current === 'number'
          ? current + 1
          : `${String(current)}-tampered`;
      if (!(path.length === 1 && path[0] === 'provenanceSha256')) {
        const { provenanceSha256: _oldSeal, ...payload } = changed;
        void _oldSeal;
        changed.provenanceSha256 = createHash('sha256').update(canonicalJson(payload)).digest('hex');
      }
      expectedError(
        () => parseAndRehydrateF005ArtworkProvenance(
          context,
          canonicalJson(changed),
          generationInput,
          noInputs,
          finalImage(bytes),
        ),
        'F005_ARTWORK_PROVENANCE_INVALID',
      );
    }
    const extra = structuredClone(original);
    extra.extra = true;
    const { provenanceSha256: _oldSeal, ...payload } = extra;
    void _oldSeal;
    extra.provenanceSha256 = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    expectedError(
      () => parseAndRehydrateF005ArtworkProvenance(
        context,
        canonicalJson(extra),
        generationInput,
        noInputs,
        finalImage(bytes),
      ),
      'F005_ARTWORK_PROVENANCE_INVALID',
    );
  });

  it('forged context、reference入力、schema余分、identity/path/terms/lineage差を拒否する', () => {
    const bytes = patternedDHash(0n);
    const validGeneration = generation(bytes);
    const validFinal = finalImage(bytes);
    const cases = [
      () => sealF005ArtworkProvenance(
        structuredClone(context),
        validGeneration,
        noInputs,
        validFinal,
      ),
      () => sealF005ArtworkProvenance(
        context,
        validGeneration,
        { referenceInputs: [{}] as unknown as [], processingInputs: [] },
        validFinal,
      ),
      () => sealF005ArtworkProvenance(
        context,
        { ...validGeneration, extra: true } as ArtworkGenerationV4Input,
        noInputs,
        validFinal,
      ),
      () => sealF005ArtworkProvenance(
        context,
        {
          ...validGeneration,
          providerTerms: { ...validGeneration.providerTerms, url: 'https://evil.test/' },
        } as unknown as ArtworkGenerationV4Input,
        noInputs,
        validFinal,
      ),
      () => sealF005ArtworkProvenance(
        context,
        validGeneration,
        noInputs,
        { ...validFinal, publicPath: '../x.png' } as unknown as F005FinalArtworkInput,
      ),
      () => sealF005ArtworkProvenance(
        context,
        validGeneration,
        {
          referenceInputs: [],
          processingInputs: [{
            order: 1,
            inputId: 'edit',
            path: 'content/edit.png',
            origin: 'generated-original',
            bytes: patternedDHash(1n),
          }],
        },
        validFinal,
      ),
    ];
    for (const operation of cases) expect(operation).toThrowError(F005ArtworkError);
  });
});

/** @des DES-F005-008 @fun FUN-F005-030 @ut UT-F005-030 */
describe('UT-F005-030 byte/SHA/dHash near-duplicate acceptance', () => {
  function existing(authorId: string, path: string, bytes: Uint8Array): ExistingArtworkInput {
    return {
      authorId,
      path,
      bytes,
      sha256: sha256(bytes),
      dHash64: computeDHash64V1(bytes),
    };
  }

  function provenance(bytes: Uint8Array): ArtworkProvenanceV4 {
    return rehydratedProvenance(bytes);
  }

  it('dHash距離8を拒否し9を受理する', () => {
    const final = patternedDHash(0n);
    const otherA = patternedDHash(0x1ffn);
    const otherB = patternedDHash(0xffff_ffff_ffff_ffffn);
    const otherC = patternedDHash(0x5555_5555_5555_5555n);
    const pass = verifyF005ArtworkAgainstCatalog(provenance(final), final, [
      existing('a', 'artwork/a.png', otherA),
      existing('b', 'artwork/b.png', otherB),
      existing('c', 'artwork/c.png', otherC),
    ]);
    expect(pass.minimumHammingDistance).toBe(9);

    const distance8 = patternedDHash(0xffn);
    expectedError(
      () => verifyF005ArtworkAgainstCatalog(provenance(final), final, [
        existing('a', 'artwork/a.png', distance8),
        existing('b', 'artwork/b.png', otherB),
        existing('c', 'artwork/c.png', otherC),
      ]),
      'F005_ARTWORK_NEAR_DUPLICATE',
    );
  });

  it('byte/SHA一致と既存側の偽SHA・偽dHashを拒否する', () => {
    const final = patternedDHash(0n);
    const farA = existing('a', 'artwork/a.png', patternedDHash(0xffffn));
    const farB = existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn));
    const identical = existing('c', 'artwork/c.png', final);
    expectedError(
      () => verifyF005ArtworkAgainstCatalog(provenance(final), final, [farA, farB, identical]),
      'F005_ARTWORK_NEAR_DUPLICATE',
    );
    expectedError(
      () => verifyF005ArtworkAgainstCatalog(provenance(final), final, [
        { ...farA, sha256: '0'.repeat(64) },
        farB,
        existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
      ]),
      'F005_ARTWORK_EXISTING_INVALID',
    );
  });

  it('ArtworkAcceptanceをWeakSet brandでmintし構造clone・全field tamperを拒否する', () => {
    const final = patternedDHash(0n);
    const far = [
      existing('a', 'artwork/a.png', patternedDHash(0x1ffn)),
      existing('b', 'artwork/b.png', patternedDHash(0xffff_ffffn)),
      existing('c', 'artwork/c.png', patternedDHash(0x5555_5555_5555_5555n)),
    ];
    const sealedOnly = sealF005ArtworkProvenance(
      context,
      generation(final),
      noInputs,
      finalImage(final),
    );
    expectedError(
      () => verifyF005ArtworkAgainstCatalog(sealedOnly, final, far),
      'F005_ARTWORK_BINDING_INVALID',
    );
    const acceptance = verifyF005ArtworkAgainstCatalog(provenance(final), final, far);
    expect(isMintedF005ArtworkAcceptance(acceptance)).toBe(true);
    expect(isMintedF005ArtworkAcceptance(structuredClone(acceptance))).toBe(false);
    for (const key of Object.keys(acceptance)) {
      const changed = structuredClone(acceptance) as unknown as Record<string, unknown>;
      changed[key] = key === 'minimumHammingDistance' ? 64 : 'tampered';
      expect(isMintedF005ArtworkAcceptance(changed)).toBe(false);
    }
  });
});

/** @des DES-F005-008 @fun FUN-F005-028 FUN-F005-029 FUN-F005-030 @it IT-F005-008 */
describe('IT-F005-008 actual F005 artwork acceptance', () => {
  it('永続provenanceを再結合し、配置済み夏目画像を既存公開3画像と実byte/SHA/dHash比較して受理する', async () => {
    const finalBytes = new Uint8Array(await readFile(resolve(workspace, outputPath)));
    const artifactText = await readFile(
      resolve(workspace, 'content/batches/F005/artwork-provenance.json'),
      'utf8',
    );
    const artifact = JSON.parse(artifactText) as ArtworkProvenanceV4;
    const artifactGeneration: ArtworkGenerationV4Input = {
      generator: artifact.generation.generator,
      generatorVersion: artifact.generation.generatorVersion,
      tool: artifact.generation.tool,
      providerTerms: artifact.generation.providerTerms,
      characterGuideline: artifact.generation.characterGuideline,
      prompt: artifact.generation.prompt,
      negativePrompt: artifact.generation.negativePrompt,
      generatedAt: artifact.generation.generatedAt,
      originalImageBytes: finalBytes,
    };
    const artifactFinalImage: F005FinalArtworkInput = {
      sourcePath: outputPath,
      publicPath: 'artwork/natsume-zundamon.png',
      credit: artifact.credit,
      bytes: finalBytes,
    };
    const provenance = parseAndRehydrateF005ArtworkProvenance(
      context,
      artifactText,
      artifactGeneration,
      noInputs,
      artifactFinalImage,
    );
    expect(serializeF005ArtworkProvenance(provenance)).toBe(artifactText);
    expect(provenance.generation).toMatchObject({
      generatedAt: '2026-07-29T03:09:36Z',
      originalImageSha256: '79f5e9b49446a29bdd6793cdaf6eee22e57974a60e5b90e1fa126502bdc61e9b',
      promptSha256: '8d866c9eaf995579d75a6886593faa766d68d8f388940a85393c817667d55bcb',
    });
    const files = [
      ['000879', 'artwork/akutagawa-zundamon.png'],
      ['000081', 'artwork/miyazawa-zundamon.png'],
      ['000035', 'artwork/dazai-zundamon.png'],
    ] as const;
    const existing: ExistingArtworkInput[] = [];
    for (const [authorId, path] of files) {
      const bytes = new Uint8Array(await readFile(resolve(workspace, 'public', path)));
      existing.push({
        authorId,
        path,
        bytes,
        sha256: sha256(bytes),
        dHash64: computeDHash64V1(bytes),
      });
    }
    const acceptance = verifyF005ArtworkAgainstCatalog(provenance, finalBytes, existing);
    expect(acceptance).toMatchObject({
      result: 'pass',
      path: 'artwork/natsume-zundamon.png',
      alt: '夏目漱石をイメージしたずんだもんの独自イラスト',
      sha256: sha256(finalBytes),
      sourceProvenancePath: 'content/batches/F005/artwork-provenance.json',
      publicProvenancePath: 'content/artwork-provenance/F005.json',
      provenancePath: 'content/artwork-provenance/F005.json',
      authorIdentitySha256: '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f',
    });
    expect(acceptance.comparisons).toHaveLength(3);
    expect(acceptance.minimumHammingDistance).toBeGreaterThan(8);
    expect(isMintedF005ArtworkAcceptance(acceptance)).toBe(true);
  });
});
