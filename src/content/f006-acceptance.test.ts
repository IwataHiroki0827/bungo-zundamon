import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hashBatchManifest, validateBatchManifest, type WorkId } from './batch.ts';
import {
  acceptF006Work,
  F006AcceptanceError,
  prepareF006WorkAcceptance,
  recoverF006WorkAcceptance,
} from './f006-acceptance.ts';
import { readFile } from 'node:fs/promises';

/**
 * IT-F006-006（完全, 山月記(000624)・名人伝(000621)・弟子(001738)全3作品分）:
 * F006 work単位atomic受入。実プロジェクトの永続化済みcanonical artifact
 * （T-151/T-152/T-153で3作品ともaccepted済み）を対象に、
 * prepareF006WorkAcceptance/acceptF006Work/recoverF006WorkAcceptanceが
 * mock無しの実データで冪等に動作すること、およびallowlist/work順違反を
 * 拒否することを検証する。T-153（弟子）完了により3作品全てがaccepted済みと
 * なったため、「work順違反」ケースはmanifestに存在しないworkId（未voiced/
 * 未accepted相当の代替）で再現する。
 * @des DES-F006-009 @fun FUN-F006-010 @ut UT-F006-010
 */

const workspace = resolve(process.cwd());
const MANIFEST_PATH = 'content/batches/F006/batch.json';
// assertOrderは対象workIdより後続のworkがacceptedであることを許さないため、
// 3作品全acceptedとなった今はmanifest末尾（最後にaccept遷移した）work IDのみが
// 再検証対象になり得る。
const ACCEPTED_WORK_ID = '001738' as WorkId;
// F006の3作品（000624/000621/001738）は全てaccepted済みのため、
// work順違反（F006_WORK_ORDER）はmanifestに存在しないwork IDで再現する
// （assertOrderはindex<0も同一エラーコードで拒否する）。
const UNKNOWN_WORK_ID = '999999' as WorkId;

describe('f006-acceptance', () => {
  it('永続化済みcanonical artifactからprepareし、accepted workをbrandedに再検証できる', async () => {
    // preview tree(904 files)の実bytes再検証・二重promote呼出を含むため、
    // 並列実行下のI/O競合を見込みfull suite既定の5秒より長い猶予を持たせる。
    const manifestText = await readFile(resolve(workspace, ...MANIFEST_PATH.split('/')), 'utf8');
    const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.workProgress[checked.value.workIds.indexOf(ACCEPTED_WORK_ID)]?.status).toBe('accepted');

    const prepared = await prepareF006WorkAcceptance(workspace, MANIFEST_PATH, ACCEPTED_WORK_ID);
    expect(prepared.batchId).toBe('F006');
    expect(prepared.workId).toBe(ACCEPTED_WORK_ID);
    expect(prepared.actual.result === 'pass' || prepared.actual.result === 'pass_with_warning').toBe(true);
    expect(prepared.contentInvariant.result).toBe('pass');
    expect(prepared.distInvariant.result).toBe('pass');

    const expectedManifestSha = hashBatchManifest(checked.value);
    const result = await acceptF006Work(workspace, prepared, expectedManifestSha);
    expect(result.evidence.kind).toBe('accepted');
    expect(result.manifest.workProgress[result.manifest.workIds.indexOf(ACCEPTED_WORK_ID)]?.status).toBe('accepted');

    // 同一tupleでの再開（journal verifiedからの冪等再検証）も成功する。
    const recovered = await recoverF006WorkAcceptance(workspace, prepared, expectedManifestSha);
    expect(recovered.evidence.kind).toBe('accepted');
  }, 30_000);

  it('mintされていないprepared値では受入を拒否する', async () => {
    const manifestText = await readFile(resolve(workspace, ...MANIFEST_PATH.split('/')), 'utf8');
    const checked = validateBatchManifest(JSON.parse(manifestText) as unknown);
    if (!checked.ok) throw new Error('fixture manifest invalid');
    const expectedManifestSha = hashBatchManifest(checked.value);
    const forged = {
      __brand: 'PreparedF006WorkAcceptance',
      batchId: 'F006',
      workId: ACCEPTED_WORK_ID,
      manifestPath: MANIFEST_PATH,
      expectedManifestSha,
    } as unknown as Parameters<typeof acceptF006Work>[1];
    await expect(acceptF006Work(workspace, forged, expectedManifestSha)).rejects.toThrow(F006AcceptanceError);
  });

  it('manifestに存在しないwork IDはwork順違反として拒否する', async () => {
    await expect(prepareF006WorkAcceptance(workspace, MANIFEST_PATH, UNKNOWN_WORK_ID))
      .rejects.toMatchObject({ code: 'F006_WORK_ORDER' });
  });

  it('manifest pathがallowlist外なら拒否する', async () => {
    await expect(prepareF006WorkAcceptance(workspace, 'content/batches/F002/batch.json', ACCEPTED_WORK_ID))
      .rejects.toMatchObject({ code: 'F006_ACCEPTANCE_PATH' });
  });

  it('workId形式が不正なら拒否する', async () => {
    await expect(prepareF006WorkAcceptance(workspace, MANIFEST_PATH, 'not-a-work-id'))
      .rejects.toMatchObject({ code: 'F006_ACCEPTANCE_PATH' });
  });
});
