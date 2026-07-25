import { describe, expect, it } from 'vitest';
import { acceptF002Release } from './release-checks.mjs';

const COMMIT = 'a'.repeat(40);
const DIST = 'b'.repeat(64);
const ARTIFACT = 'c'.repeat(64);
const NOW = '2026-07-25T03:00:00.000Z';

function candidate() {
  return {
    releaseCandidateBatchId: 'F002',
    feature: 'F002',
    releaseCommit: COMMIT,
    distSha256: DIST,
    artifactDigest: ARTIFACT,
  };
}

function evidence(result = 'pass') {
  return { result, candidate: candidate() };
}

function acceptanceContext() {
  return {
    now: NOW,
    releaseBuild: candidate(),
    checkout: {
      status: 'clean',
      releaseVerifyStatus: 'completed',
      headSha: COMMIT,
      releaseCommit: COMMIT,
    },
    authors: [{ authorId: '000879' }, { authorId: '000081' }],
    batches: [
      { batchId: 'F001', feature: 'F001', status: 'published' },
      { batchId: 'F002', feature: 'F002', status: 'accepted' },
    ],
    works: ['000473', '043752', '043754'].map((workId, index) => ({
      workId,
      status: 'accepted',
      pendingCount: 0,
      acceptedAudioSources: [{
        path: `content/batches/F002/accepted-audio/${workId}/${String(index + 1).repeat(64)}.wav`,
        sha256: 'd'.repeat(64),
        bytes: 44,
        configHash: 'e'.repeat(64),
      }],
    })),
    voiceEvidence: ['000473', '043752', '043754'].map((workId) => ({
      ...evidence(),
      workId,
      acceptedAudioCount: 1,
    })),
    f001: {
      baseline: evidence(),
      contentInvariant: evidence(),
      distInvariant: {
        ...evidence(),
        distSha256: DIST,
        artifactDigest: ARTIFACT,
      },
    },
    rights: {
      selection: evidence('unchanged'),
      predeploy: evidence('unchanged'),
    },
    policy: {
      selection: { status: 'unchanged', candidate: candidate() },
      predeploy: { status: 'changed-reviewed', candidate: candidate() },
    },
    artwork: evidence(),
    capacity: {
      ...candidate(),
      evidenceKind: 'actual',
      phase: 'release',
      result: 'pass',
    },
    security: { status: 'pass', candidate: candidate() },
    regression: {
      status: 'passed',
      unitTests: 337,
      browserTests: 78,
      f002Tests: 'passed',
      candidate: candidate(),
    },
    browser: {
      status: 'passed',
      viewports: ['390x844', '844x390', '1440x900'],
      accessibility: ['keyboard', 'screen-reader', 'reduced-motion'],
      manualBrowsers: ['Windows Chrome', 'Windows Edge', 'iOS Safari'],
      automatedBrowsers: ['chromium', 'firefox', 'webkit', 'android-viewport'],
      candidate: candidate(),
    },
    qtEvidence: Array.from({ length: 14 }, (_, index) => ({
      id: `QT-F002-${String(index + 1).padStart(3, '0')}`,
      status: 'passed',
      ...candidate(),
      executedAt: NOW,
      evidenceRefs: [`docs/evidence/qt/QT-F002-${index + 1}.json`],
    })),
  };
}

// @des DES-F002-003 @des DES-F002-005 @des DES-F002-009
// @des DES-F002-011 @des DES-F002-013 @des DES-F002-016
// @fun FUN-F002-030 @ut UT-F002-030
describe('FUN-F002-030 F002受入・証跡hash chain [UT-F002-030]', () => {
  it('exact clean commitと全14 QTが同じcandidate tupleのときだけreadyにする', async () => {
    await expect(acceptF002Release(acceptanceContext())).resolves.toEqual({
      status: 'ready_for_approval',
      ...candidate(),
    });
  });

  it('判定時刻とQT証跡時刻の同値を受理し、入力を変更しない', async () => {
    const context = acceptanceContext();
    const before = JSON.parse(JSON.stringify(context));
    await expect(acceptF002Release(context)).resolves.toMatchObject({ status: 'ready_for_approval' });
    expect(context).toEqual(before);
  });

  it.each([
    ['3作品未完了', (value) => { value.works[0].status = 'voiced'; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['3作品順序混在', (value) => { value.works.reverse(); }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio不完全', (value) => { value.works[0].acceptedAudioSources[0].sha256 = ''; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio親directory逸脱', (value) => { value.works[0].acceptedAudioSources[0].path = '../unsafe.wav'; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio絶対path', (value) => { value.works[0].acceptedAudioSources[0].path = '/tmp/unsafe.wav'; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio backslash', (value) => { value.works[0].acceptedAudioSources[0].path = String.raw`content\batches\F002\accepted-audio\000473\unsafe.wav`; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio control', (value) => { value.works[0].acceptedAudioSources[0].path = `content/batches/F002/accepted-audio/000473/${'f'.repeat(64)}\u0000.wav`; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio別work混入', (value) => { value.works[0].acceptedAudioSources[0].path = `content/batches/F002/accepted-audio/043752/${'f'.repeat(64)}.wav`; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio work内source重複', (value) => { value.works[0].acceptedAudioSources.push({ ...value.works[0].acceptedAudioSources[0] }); value.voiceEvidence[0].acceptedAudioCount = 2; }, 'ACCEPT_WORK_INCOMPLETE'],
    ['accepted audio全work横断filename重複', (value) => { value.works[1].acceptedAudioSources[0].path = value.works[1].acceptedAudioSources[0].path.replace(`${'2'.repeat(64)}.wav`, `${'1'.repeat(64)}.wav`); }, 'ACCEPT_WORK_INCOMPLETE'],
    ['未published batch混入', (value) => { value.batches.push({ batchId: 'F003', feature: 'F003', status: 'accepted' }); }, 'ACCEPT_WORK_INCOMPLETE'],
    ['作者数不足', (value) => { value.authors.pop(); }, 'ACCEPT_WORK_INCOMPLETE'],
    ['音声欠落', (value) => { value.voiceEvidence.pop(); }, 'ACCEPT_VOICE_INCOMPLETE'],
    ['音声判定discriminant矛盾', (value) => { value.voiceEvidence[0].status = 'blocked'; }, 'ACCEPT_VOICE_INCOMPLETE'],
    ['F001 dist blocked', (value) => { value.f001.distInvariant.result = 'blocked'; }, 'ACCEPT_F001_REGRESSION'],
    ['F001判定discriminant矛盾', (value) => { value.f001.contentInvariant.status = 'blocked'; }, 'ACCEPT_F001_REGRESSION'],
    ['権利blocked', (value) => { value.rights.predeploy.result = 'blocked'; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['権利にArtwork結果を流用', (value) => { value.rights.selection.result = 'pass'; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['権利にPolicy状態を流用', (value) => { delete value.rights.selection.result; value.rights.selection.status = 'changed-reviewed'; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['規約欠落', (value) => { delete value.policy.predeploy; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['規約にArtwork状態を流用', (value) => { value.policy.selection.status = 'pass'; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['規約にRights結果を流用', (value) => { delete value.policy.selection.status; value.policy.selection.result = 'unchanged'; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['artwork欠落', (value) => { delete value.artwork; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['artworkにRights結果を流用', (value) => { value.artwork.result = 'unchanged'; }, 'ACCEPT_RIGHTS_BLOCKED'],
    ['work容量report流用', (value) => { value.capacity.phase = 'work-preview'; }, 'ACCEPT_CAPACITY_BLOCKED'],
    ['capacity blocked', (value) => { value.capacity.result = 'blocked'; }, 'ACCEPT_CAPACITY_BLOCKED'],
    ['capacity判定discriminant矛盾', (value) => { value.capacity.status = 'pass'; }, 'ACCEPT_CAPACITY_BLOCKED'],
    ['security blocked', (value) => { value.security.status = 'blocked'; }, 'ACCEPT_SECURITY_BLOCKED'],
    ['security判定discriminant矛盾', (value) => { value.security.result = 'blocked'; }, 'ACCEPT_SECURITY_BLOCKED'],
    ['browser証跡欠落', (value) => { value.browser.viewports.pop(); }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['browser判定discriminant矛盾', (value) => { value.browser.result = 'blocked'; }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['回帰判定discriminant矛盾', (value) => { value.regression.result = 'blocked'; }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['回帰件数不足', (value) => { value.regression.unitTests = 336; }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['QT欠落', (value) => { value.qtEvidence.pop(); }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['QT失敗', (value) => { value.qtEvidence[0].status = 'failed'; }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['QT判定discriminant矛盾', (value) => { value.qtEvidence[0].result = 'blocked'; }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['QT evidence path逸脱', (value) => { value.qtEvidence[0].evidenceRefs[0] = '../outside.json'; }, 'ACCEPT_BROWSER_INCOMPLETE'],
    ['dirty checkout', (value) => { value.checkout.status = 'dirty'; }, 'ACCEPT_COMMIT_MISMATCH'],
    ['checkout commit混在', (value) => { value.checkout.headSha = 'd'.repeat(40); }, 'ACCEPT_COMMIT_MISMATCH'],
    ['voice tuple混在', (value) => { value.voiceEvidence[0].candidate.distSha256 = 'd'.repeat(64); }, 'ACCEPT_COMMIT_MISMATCH'],
    ['F001 upload digest混線', (value) => { value.f001.distInvariant.candidate.artifactDigest = 'd'.repeat(64); }, 'ACCEPT_COMMIT_MISMATCH'],
    ['capacity commit混線', (value) => { value.capacity.releaseCommit = 'd'.repeat(40); }, 'ACCEPT_COMMIT_MISMATCH'],
    ['QT tuple混在', (value) => { value.qtEvidence[13].artifactDigest = 'd'.repeat(64); }, 'ACCEPT_COMMIT_MISMATCH'],
  ])('%sを対応するACCEPT codeでblockedにする', async (_name, mutate, blocker) => {
    const context = acceptanceContext();
    mutate(context);
    await expect(acceptF002Release(context)).resolves.toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining([blocker]),
    });
  });
});
