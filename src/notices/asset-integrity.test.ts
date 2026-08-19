import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderCredits, validateReleaseNotices } from './index';
import type { ArtworkProvenanceManifest, CreditsCatalog, LicenseManifest } from './types';

const workspace = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(workspace, path), 'utf8')) as T;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(resolve(workspace, path))).digest('hex');
}

describe('公開権利表示asset [FUN-F001-026][FUN-F001-038]', () => {
  const catalog: CreditsCatalog = {
    works: [
      ['羅生門', '127'],
      ['蜘蛛の糸', '92'],
      ['杜子春', '43015'],
    ].map(([title, cardId]) => ({
      title: title!,
      cardLink: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
      source: {
        cardUrl: `https://www.aozora.gr.jp/cards/000879/card${cardId}.html`,
        attribution: '青空文庫の作品本文',
        baseEdition: `${title}の底本`,
        inputter: '入力者',
        proofreader: '校正者',
        fetchedAt: '2026-07-18T07:25:00Z',
        transformation: '台詞抽出・構造化',
      },
    })),
  };

  /** @des DES-F001-011 DES-F001-012 DES-F001-013 DES-F001-018 @ut UT-F001-038 */
  it('実ファイルhash・由来・写真/既存画風不使用宣言が一致する', () => {
    const license = readJson<LicenseManifest>('content/licenses.json');
    const artwork = readJson<ArtworkProvenanceManifest>('content/artwork-provenance.json');
    const result = validateReleaseNotices(license, artwork, new Date('2026-07-18T08:00:00Z'));

    expect(result.ok).toBe(true);
    expect(sha256('public/artwork/akutagawa-zundamon.png')).toBe(artwork.output.sha256);
    expect(sha256('content/artwork/README.md')).toBe(license.materials.readmeSha256);
    expect(artwork).toMatchObject({
      creationMethod: 'authorized-source-edit',
      specificAkutagawaPhotographUsed: false,
      usesSakamotoArtworkAsInput: true,
      artistStyleImitated: false,
    });
    expect(artwork.inputs[0]).toMatchObject({
      sourcePage: 'https://seiga.nicovideo.jp/seiga/im11206626',
      distributionUrl: 'https://ux.getuploader.com/s_ahiru/download/59',
      distributionVersion: 'V3.2',
      archiveSha256: '41358f8b4d050fadc4be7073f2939fafa043caef6086bc8c6549f49c6b78f488',
      sha256: '0eacd1ca6d7a3e66a9544d1c37b229ab522886a8aa9d954e86ed515188bd88f4',
    });
  });

  /** @des DES-F001-011 DES-F001-013 @ut UT-F001-038 */
  it('公開サムネイルはPNG実体で、元PSDを公開物へ含めない', () => {
    const png = readFileSync(resolve(workspace, 'public/artwork/akutagawa-zundamon.png'));
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(artworkFiles()).not.toContain('psd');
  });

  /** @des DES-F001-012 DES-F001-018 @ut UT-F001-026 */
  it('実manifestから必須表示と正確なサムネイル由来を描画する', () => {
    const license = readJson<LicenseManifest>('content/licenses.json');
    const artwork = readJson<ArtworkProvenanceManifest>('content/artwork-provenance.json');
    const validated = validateReleaseNotices(license, artwork, new Date('2026-07-18T08:00:00Z'));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const page = renderCredits(catalog, validated.value);
    expect(page.textContent).toContain('立ち絵：坂本アヒル');
    expect(page.textContent).toContain('ずんだもん立ち絵素材V3.2');
    expect(page.textContent).toContain('底本: 羅生門の底本');
    expect(Array.from(page.querySelectorAll('a')).every((link) => link.rel === 'noopener noreferrer')).toBe(true);
  });
});

function artworkFiles(): string[] {
  return readdirSync(resolve(workspace, 'public/artwork')).map((path) => path.split('.').at(-1)?.toLowerCase() ?? '');
}
