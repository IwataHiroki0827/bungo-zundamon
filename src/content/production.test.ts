import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateId, EXTRACTOR_VERSION, SUPPORTED_SPEECH_RULE_VERSION, type Candidate, type RawCandidate } from './processing.ts';
import {
  INITIAL_WORK_IDS,
  INITIAL_WORK_SOURCE_URLS,
  type DecodedSource,
  type SourceRecord,
} from './source.ts';
import {
  PRODUCTION_ARTIFACTS,
  createProductionStageRunner,
  loadProductionCandidates,
  loadProductionDecodedSources,
  loadProductionRawCandidates,
  loadProductionSourceRecords,
} from './production.ts';

const temporaryDirectories: string[] = [];
const TITLES = { '000127': '羅生門', '000092': '蜘蛛の糸', '043015': '杜子春' } as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'bungo-production-'));
  temporaryDirectories.push(workspace);
  for (const workId of INITIAL_WORK_IDS) {
    const rawText = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div class="main_text">「${TITLES[workId]}」</div></body></html>`;
    const raw = Buffer.from(rawText, 'utf8');
    const source: SourceRecord = {
      workId,
      rawPath: `${workId}/source.raw`,
      rawSha256: sha256(raw),
      mediaType: 'application/xhtml+xml',
      httpCharset: 'UTF-8',
      bibliographyCharset: 'UTF-8',
      fetchedAt: '2026-07-18T00:00:00.000Z',
      sourceUrl: INITIAL_WORK_SOURCE_URLS[workId],
    };
    const decoded: DecodedSource = {
      workId,
      rawSha256: source.rawSha256,
      httpCharset: 'UTF-8',
      metaCharset: 'UTF-8',
      bibliographyCharset: 'UTF-8',
      adoptedCharset: 'UTF-8',
      text: rawText,
    };
    const displayText = `「${TITLES[workId]}」`;
    const rawCandidate: RawCandidate = {
      workId,
      rawSourceSha256: source.rawSha256,
      order: 0,
      rawTokenRange: { start: 0, end: Array.from(displayText).length },
      tokens: [{ type: 'text', value: displayText }],
      contextBefore: '',
      contextAfter: '',
      sourceAnchor: { bodySelector: '.main_text', startToken: 0, endToken: Array.from(displayText).length },
      extractorVersion: EXTRACTOR_VERSION,
    };
    const textHash = sha256(JSON.stringify([displayText, displayText]));
    const candidate: Candidate = {
      candidateId: createCandidateId(
        workId,
        source.rawSha256,
        rawCandidate.rawTokenRange,
        EXTRACTOR_VERSION,
        SUPPORTED_SPEECH_RULE_VERSION,
        textHash,
      ),
      workId,
      rawSourceSha256: source.rawSha256,
      order: 0,
      rawTokenRange: rawCandidate.rawTokenRange,
      displayText,
      speechText: displayText,
      contextBefore: '',
      contextAfter: '',
      sourceAnchor: rawCandidate.sourceAnchor,
      extractorVersion: EXTRACTOR_VERSION,
      normalizerVersion: SUPPORTED_SPEECH_RULE_VERSION,
    };
    const sourceDir = join(workspace, PRODUCTION_ARTIFACTS.sources, workId);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'source.raw'), raw);
    await writeJson(join(sourceDir, 'source.json'), source);
    const intermediate = join(workspace, PRODUCTION_ARTIFACTS.intermediate, workId);
    await writeJson(join(intermediate, 'decoded.json'), decoded);
    await writeJson(join(intermediate, 'raw-candidates.json'), [rawCandidate]);
    await writeJson(join(intermediate, 'candidates.json'), [candidate]);
  }
  return workspace;
}

describe('production artifact再読込のfail-closed検査 [DES-F001-004][DES-F001-017][DES-F001-019]', () => {
  it('正常な固定3作品artifactだけを順序どおり再読込する', async () => {
    const workspace = await fixtureWorkspace();
    expect((await loadProductionSourceRecords(workspace)).map(({ workId }) => workId)).toEqual(INITIAL_WORK_IDS);
    expect((await loadProductionDecodedSources(workspace)).map(({ workId }) => workId)).toEqual(INITIAL_WORK_IDS);
    expect((await loadProductionRawCandidates(workspace)).flat()).toHaveLength(3);
    expect((await loadProductionCandidates(workspace)).flat()).toHaveLength(3);
  });

  it.each([
    ['rawPath逸脱', { rawPath: '../../outside.raw' }],
    ['固定source URL差替え', { sourceUrl: 'https://www.aozora.gr.jp/cards/000879/files/127_other.html' }],
    ['workId差替え', { workId: '000092' }],
    ['raw hash形式不正', { rawSha256: 'invalid-hash' }],
    ['media type不正', { mediaType: 'text/plain' }],
    ['取得日時不正', { fetchedAt: 'today' }],
  ])('%sを持つSourceRecordを拒否する', async (_name, tamper) => {
    const workspace = await fixtureWorkspace();
    const path = join(workspace, PRODUCTION_ARTIFACTS.sources, '000127', 'source.json');
    const valid = (await loadProductionSourceRecords(workspace))[0]!;
    await writeJson(path, { ...valid, ...tamper });
    await expect(loadProductionSourceRecords(workspace)).rejects.toMatchObject({ code: 'SOURCE_RECORD_MISMATCH' });
  });

  it('raw bytesのhash/byte対応をdecode前に検証して差替えを拒否する', async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(join(workspace, PRODUCTION_ARTIFACTS.sources, '000127', 'source.raw'), 'tampered', 'utf8');
    const runner = createProductionStageRunner();
    await expect(runner('decode', { workspace, completed: [], voiceFailures: [] })).rejects.toMatchObject({
      code: 'SOURCE_RAW_MISMATCH',
    });
  });

  it('decoded/raw candidate/candidateの作品・hash・順序・ID対応差替えを拒否する', async () => {
    const workspace = await fixtureWorkspace();
    const decodedPath = join(workspace, PRODUCTION_ARTIFACTS.intermediate, '000127', 'decoded.json');
    const decoded = (await loadProductionDecodedSources(workspace))[0]!;
    await writeJson(decodedPath, { ...decoded, rawSha256: 'f'.repeat(64) });
    await expect(loadProductionDecodedSources(workspace)).rejects.toMatchObject({ code: 'DECODED_SOURCE_MISMATCH' });

    await writeJson(decodedPath, decoded);
    const rawPath = join(workspace, PRODUCTION_ARTIFACTS.intermediate, '000127', 'raw-candidates.json');
    const raw = (await loadProductionRawCandidates(workspace))[0]![0]!;
    await writeJson(rawPath, [{ ...raw, order: 1 }]);
    await expect(loadProductionRawCandidates(workspace)).rejects.toMatchObject({ code: 'RAW_CANDIDATE_MISMATCH' });

    await writeJson(rawPath, [raw]);
    const candidatePath = join(workspace, PRODUCTION_ARTIFACTS.intermediate, '000127', 'candidates.json');
    const candidate = (await loadProductionCandidates(workspace))[0]![0]!;
    await writeJson(candidatePath, [{ ...candidate, displayText: '差替え' }]);
    await expect(loadProductionCandidates(workspace)).rejects.toMatchObject({ code: 'CANDIDATE_MISMATCH' });
  });
});
