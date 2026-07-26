import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadAndVerifyTrustedArtworkMachineReview,
  validateArtworkProvenance,
  type ArtworkProvenanceV2,
  type ArtworkProvenanceV3,
  type ArtworkV3TrustContext,
} from './artwork-provenance.ts';

const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

function png(width = 1254, height = 1254): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

async function fixture(): Promise<{ workspace: string; bytes: Uint8Array; manifest: ArtworkProvenanceV2 }> {
  const workspace = await mkdtemp(join(tmpdir(), 'artwork-v2-'));
  const bytes = png();
  const sourcePath = 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png';
  await mkdir(join(workspace, 'content', 'batches', 'F002', 'public-files', 'artwork'), { recursive: true });
  await writeFile(join(workspace, ...sourcePath.split('/')), bytes);
  const prompt = 'original chibi green bean-themed mascot as a gentle poet';
  const recipe = '入力画像0件。built-in image_genの出力を編集せずPNG正本として採用。';
  return {
    workspace,
    bytes,
    manifest: {
      schemaVersion: '2.0.0',
      manifestId: 'artwork-F002-000081-v1',
      batchId: 'F002',
      authorId: '000081',
      creationMethod: 'original-generation',
      generatedOn: '2026-07-20',
      generation: {
        provider: 'OpenAI',
        tool: 'built-in image_gen',
        model: 'not exposed by built-in tool',
        modelVersion: 'not exposed by built-in tool',
        inputImageCount: 0,
        prompt,
        promptSha256: sha(prompt),
        recipe,
        recipeSha256: sha(recipe),
        providerTerms: {
          policyId: 'openai-terms',
          url: 'https://openai.com/policies/terms-of-use/',
          contentSha256: 'a'.repeat(64),
          fetchedAt: '2026-07-25T12:00:00.000Z',
          decisionSummary: '生成物の利用条件と禁止用途を確認',
        },
      },
      inputAllowlist: [],
      inputs: [],
      output: {
        sourcePath,
        publicPath: 'artwork/miyazawa-zundamon.png',
        sha256: sha(bytes),
        bytes: bytes.byteLength,
        mediaType: 'image/png',
        width: 1254,
        height: 1254,
        bitDepth: 8,
        colorType: 'RGB',
      },
      characterGuideline: {
        policyId: 'zundamon-character-guideline',
        url: 'https://zunko.jp/guideline.html',
        contentSha256: 'b'.repeat(64),
        fetchedAt: '2026-07-25T12:00:00.000Z',
        decisionSummary: '非公式ファンアートとしてcreditと非公式表示を行う',
        decision: 'allowed-original-fan-art',
      },
      humanReview: {
        reviewer: 'プロジェクトオーナー目視結果を記録したCodex',
        reviewedAt: '2026-07-25T12:05:00.000Z',
        promptConformance: true,
        noRealPhotographOrIdentifiableFace: true,
        noThirdPartyMaterial: true,
        noThirdPartyDerivative: true,
        noTrademarkOrLogo: true,
        noTextSignatureOrWatermark: true,
        handsNatural: true,
        decision: 'approved',
        summary: '架空chibi、豆さや髪、紺コート、帽子、本、和紙、星、草花を確認。文字・署名・watermark・logo・実在人物顔・第三者素材由来の識別要素は見当たらず、手指も自然。',
      },
      credit: '宮沢賢治ずんだもん：OpenAI built-in image_genによる独自生成（入力画像なし）',
    },
  };
}

async function v3Fixture(): Promise<{
  workspace: string;
  manifest: ArtworkProvenanceV3;
  trust: ArtworkV3TrustContext;
}> {
  const workspace = process.cwd();
  const manifest = JSON.parse(await readFile(
    join(workspace, 'content', 'batches', 'F003', 'artwork-provenance.json'),
    'utf8',
  )) as ArtworkProvenanceV3;
  const identity = {
    manifestId: manifest.manifestId,
    batchId: manifest.batchId,
    authorId: manifest.authorId,
    outputPath: manifest.output.publicPath,
  };
  return {
    workspace,
    manifest,
    trust: await loadAndVerifyTrustedArtworkMachineReview(workspace, identity),
  };
}

// Direct trace tags: QT-F002-010
describe('UT-F002-012 作者別ArtworkProvenanceV2', () => {
  it('F002 committed provenanceがtracked public-files正本と一致する', async () => {
    const workspace = process.cwd();
    const manifest = JSON.parse(await readFile(
      join(workspace, 'content', 'batches', 'F002', 'artwork-provenance.json'),
      'utf8',
    )) as ArtworkProvenanceV2;
    await expect(validateArtworkProvenance(manifest, workspace)).resolves.toMatchObject({
      result: 'pass',
      outputPath: 'artwork/miyazawa-zundamon.png',
      outputSha256: '6c059a93f09608bdba9a4dbe8b5b0af0b0b901b7dd7e4b2184cca4093110e087',
      outputBytes: 3_118_359,
      inputCount: 0,
    });
  });

  it('入力0件生成のprompt/recipe/provider/policy/人判断とsource実体をすべて照合する', async () => {
    const value = await fixture();
    await expect(validateArtworkProvenance(value.manifest, value.workspace)).resolves.toEqual({
      result: 'pass',
      manifestId: 'artwork-F002-000081-v1',
      authorId: '000081',
      outputPath: 'artwork/miyazawa-zundamon.png',
      outputSha256: sha(value.bytes),
      outputBytes: value.bytes.byteLength,
      inputCount: 0,
      reasoning: [
        value.manifest.generation.providerTerms.decisionSummary,
        value.manifest.characterGuideline.decisionSummary,
        value.manifest.humanReview.summary,
      ],
    });
  });

  it('source/public path混線、workspace外path、実hash/PNG metadata差分を拒否する', async () => {
    const value = await fixture();
    await expect(validateArtworkProvenance({
      ...value.manifest,
      output: { ...value.manifest.output, sourcePath: 'public/artwork/miyazawa-zundamon.png' },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_PATH_UNSAFE' });
    await expect(validateArtworkProvenance({
      ...value.manifest,
      output: { ...value.manifest.output, sourcePath: '../miyazawa-zundamon.png' },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_PATH_UNSAFE' });
    await expect(validateArtworkProvenance({
      ...value.manifest,
      output: { ...value.manifest.output, sha256: 'c'.repeat(64) },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_HASH_MISMATCH' });
    await expect(validateArtworkProvenance({
      ...value.manifest,
      output: { ...value.manifest.output, width: 1253 },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_HASH_MISMATCH' });
  });

  it('allowlist外入力・第三者二次創作物を拒否する', async () => {
    const value = await fixture();
    const input = {
      inputId: 'third-party',
      path: 'inputs/third-party.png',
      sha256: 'd'.repeat(64),
      source: 'unknown',
      license: 'unknown',
      redistributionAllowed: false,
      thirdPartyDerivative: true,
    };
    await expect(validateArtworkProvenance({
      ...value.manifest,
      inputAllowlist: ['third-party'],
      inputs: [input],
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_THIRD_PARTY_DERIVATIVE' });
  });

  it('provider terms・ずんだもん判断・目視判断・creditの欠落をhashだけでPASSにしない', async () => {
    const value = await fixture();
    await expect(validateArtworkProvenance({
      ...value.manifest,
      generation: {
        ...value.manifest.generation,
        providerTerms: { ...value.manifest.generation.providerTerms, contentSha256: '' },
      },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_PROVIDER_TERMS_MISSING' });
    await expect(validateArtworkProvenance({
      ...value.manifest,
      characterGuideline: { ...value.manifest.characterGuideline, decisionSummary: '' },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_RIGHTS_MISSING' });
    await expect(validateArtworkProvenance({
      ...value.manifest,
      humanReview: { ...value.manifest.humanReview, noThirdPartyMaterial: false as true },
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_REVIEW_MISSING' });
    await expect(validateArtworkProvenance({
      ...value.manifest,
      credit: '',
    }, value.workspace)).rejects.toMatchObject({ code: 'ARTWORK_REVIEW_MISSING' });
  });
});

describe('UT-F003-024 ArtworkProvenanceV3 machine review [DES-F003-009][FUN-F003-024]', () => {
  it('manifest identity・画像実体・正規machine review・trusted coordinator記録を全結合する', async () => {
    const value = await v3Fixture();
    await expect(validateArtworkProvenance(value.manifest, value.workspace, value.trust)).resolves.toMatchObject({
      result: 'pass',
      manifestId: 'artwork-F003-000035-v1',
      authorId: '000035',
      outputPath: 'artwork/dazai-zundamon.png',
      inputCount: 0,
    });
  });

  it.each([
    ['machine欠落', (value: Awaited<ReturnType<typeof v3Fixture>>) => ({
      manifest: { ...value.manifest, machineReview: undefined } as unknown as ArtworkProvenanceV3,
      trust: value.trust,
    })],
    ['identity差', (value: Awaited<ReturnType<typeof v3Fixture>>) => ({
      manifest: value.manifest,
      trust: { ...value.trust, identity: { ...value.trust.identity, authorId: 'forged' } },
    })],
    ['run差', (value: Awaited<ReturnType<typeof v3Fixture>>) => ({
      manifest: value.manifest,
      trust: {
        ...value.trust,
        coordinatorRecord: {
          ...value.trust.coordinatorRecord,
          machineReview: { ...value.trust.coordinatorRecord.machineReview, runId: 'forged-run' },
        },
      },
    })],
    ['image hash差', (value: Awaited<ReturnType<typeof v3Fixture>>) => ({
      manifest: {
        ...value.manifest,
        machineReview: { ...value.manifest.machineReview, imageSha256: '0'.repeat(64) },
      },
      trust: value.trust,
    })],
  ])('%sを拒否する', async (_label, mutate) => {
    const value = await v3Fixture();
    const changed = mutate(value);
    await expect(validateArtworkProvenance(changed.manifest, value.workspace, changed.trust))
      .rejects.toBeInstanceOf(Error);
  });

  it('F003 committed provenanceと生成PNG・coordinator recordが一致する', async () => {
    const workspace = process.cwd();
    const manifest = JSON.parse(await readFile(
      join(workspace, 'content', 'batches', 'F003', 'artwork-provenance.json'),
      'utf8',
    )) as ArtworkProvenanceV3;
    await expect(loadAndVerifyTrustedArtworkMachineReview(workspace, {
      manifestId: manifest.manifestId,
      batchId: manifest.batchId,
      authorId: 'forged',
      outputPath: manifest.output.publicPath,
    })).rejects.toMatchObject({ code: 'ARTWORK_REVIEW_MISSING' });
    const verifiedTrust = await loadAndVerifyTrustedArtworkMachineReview(workspace, {
      manifestId: manifest.manifestId,
      batchId: manifest.batchId,
      authorId: manifest.authorId,
      outputPath: manifest.output.publicPath,
    });
    await expect(validateArtworkProvenance(manifest, workspace, verifiedTrust)).resolves.toMatchObject({
      result: 'pass',
      outputSha256: 'c58b3233decc0b485f938c2d9f73dd16ade06d546ac72ad429fe86bbd22d31b6',
      outputBytes: 2_960_855,
    });
  });
});
