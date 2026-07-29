import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  freezeF004Source,
  loadAndVerifyFixedF004Source,
  observeF004Rights,
  observeF004RightsSelection,
  type VerifiedF004Rights,
} from './f004-source.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from './batch-candidate.ts';
import {
  ProductionAozoraTransport,
  type BatchSelectionManifest,
  type TransportResponse,
} from './source.ts';

const workspace = resolve('.');

describe('F004権利・原典固定', () => {
  /** @des DES-F004-003 @fun FUN-F004-006 @test UT-F004-006 */
  it('公式書誌snapshotで宮沢賢治3作品の権利条件を固定する', async () => {
    const rights = await observeF004RightsSelection(workspace);

    expect(rights.works.map((work) => work.workId)).toEqual(['000466', '045679', '001918']);
    expect(rights.works.every((work) =>
      work.personId === '000081' &&
      work.personCopyright === 'なし' &&
      work.copyright === 'なし' &&
      work.role === '著者' &&
      work.status === '公開中' &&
      work.orthography === '新字新仮名'
    )).toBe(true);
    expect(rights.observation.works.every((work) => work.translatorPresent === false)).toBe(true);
    expect(Object.isFrozen(rights)).toBe(true);
  });

  /** @des DES-F004-003 @fun FUN-F004-007 @test UT-F004-007 */
  it('3 XHTMLをhash・Shift_JIS fatal decode・本文selectorへ結合する', async () => {
    const rights = await observeF004RightsSelection(workspace);
    const fixed = await Promise.all(
      rights.works.map((work) => loadAndVerifyFixedF004Source(workspace, work.workId, rights)),
    );

    expect(fixed.map((source) => source.work.rawBytes)).toEqual([20945, 25777, 28511]);
    expect(fixed.every((source) =>
      source.record.rawSha256 === source.work.rawSha256 &&
      source.decoded.adoptedCharset === 'Shift_JIS' &&
      source.decoded.text.includes('main_text') &&
      source.bodySelector === '.main_text'
    )).toBe(true);
    expect(new Set(fixed.map((source) => source.sourceSha256)).size).toBe(3);
  });

  /** @des DES-F004-003 @fun FUN-F004-007 @test UT-F004-007 */
  it('callerが複製したrightsと未承認work IDを拒否する', async () => {
    const rights = await observeF004RightsSelection(workspace);
    await expect(loadAndVerifyFixedF004Source(
      workspace,
      '000466',
      structuredClone(rights) as VerifiedF004Rights,
    )).rejects.toMatchObject({ code: 'F004_SOURCE_DRIFT' });
    await expect(loadAndVerifyFixedF004Source(workspace, '999999', rights))
      .rejects.toMatchObject({ code: 'F004_SOURCE_DRIFT' });
  });

  /** @des DES-F004-003 @fun FUN-F004-006 @test UT-F004-006 */
  it('ProductionAozoraTransportで承認manifestのselectionを再観測する', async () => {
    const [context, manifest, archive] = await Promise.all([
      loadAndVerifyBatchCandidate(
        workspace,
        BATCH_DEFINITION_REFS.F004.ref,
        BATCH_DEFINITION_REFS.F004.sha256,
        APPROVAL_POLICY_REFS.F004.ref,
        APPROVAL_POLICY_REFS.F004.sha256,
      ),
      readFile(resolve('content/batches/F004/batch.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as BatchSelectionManifest),
      readFile(resolve('data/batches/F003/work-artifacts/000275/bibliography/list_person_all_extended_utf8.zip')),
    ]);
    const transport = fakeTransport([response(archive, 'application/zip')]);
    const result = await observeF004Rights(context, manifest, 'selection', {
      transport,
      clock: () => new Date('2026-07-27T14:21:00.000Z'),
    });

    expect(result.phase).toBe('selection');
    expect(result.phase).toBe('selection');
    if (result.phase !== 'selection') throw new Error('selection expected');
    expect(result.works.map((work) => work.workId)).toEqual(['000466', '045679', '001918']);
    const predeploy = await observeF004Rights(context, manifest, 'predeploy', {
      transport: fakeTransport([response(archive, 'application/zip')]),
      clock: () => new Date('2026-07-27T14:33:00.000Z'),
      selection: result.observation,
      releaseCommit: 'a'.repeat(40),
      runId: 'F004-predeploy-test',
    });
    expect(predeploy).toMatchObject({
      phase: 'predeploy',
      decision: { result: 'unchanged' },
    });
  });

  /** @des DES-F004-003 @fun FUN-F004-007 @test UT-F004-007 */
  it('Verified rightsとApproved contextへ結合してproduction rawをatomic固定する', async () => {
    const [context, rights, raw] = await Promise.all([
      loadAndVerifyBatchCandidate(
        workspace,
        BATCH_DEFINITION_REFS.F004.ref,
        BATCH_DEFINITION_REFS.F004.sha256,
        APPROVAL_POLICY_REFS.F004.ref,
        APPROVAL_POLICY_REFS.F004.sha256,
      ),
      observeF004RightsSelection(workspace),
      readFile(resolve('data/batches/F004/sources/000466/source.raw')),
    ]);
    const fixed = await freezeF004Source(
      workspace,
      context,
      '000466',
      rights,
      fakeTransport([response(raw, 'text/html')]),
    );
    expect(fixed).toMatchObject({
      bodySelector: '.main_text',
      record: {
        workId: '000466',
        rawSha256: 'efd6aff174b43bd1d8bb7b286cf0a123a38e09f74fec55a5b7cc6482866713f1',
      },
      decoded: { adoptedCharset: 'Shift_JIS' },
    });
  });
});

function response(body: Uint8Array, mediaType: string): TransportResponse {
  return {
    status: 200,
    headers: {
      'content-type': mediaType,
      'content-length': String(body.byteLength),
    },
    body,
    elapsedMs: 14_999,
    fetchedAt: '2026-07-27T14:33:06.149Z',
    complete: true,
    peerAddress: '8.8.8.8',
    socketSecurity: { tlsAuthorized: true, hostnameVerified: true },
  };
}

function fakeTransport(responses: readonly TransportResponse[]): ProductionAozoraTransport {
  let index = 0;
  return new ProductionAozoraTransport({
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    pinnedSocketFactory: async () => {
      const value = responses[index];
      index += 1;
      if (!value) throw new Error('unexpected request');
      return value;
    },
  });
}
