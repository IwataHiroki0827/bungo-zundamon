import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  normalizeBatchCandidate,
  type CandidateWithRevisions,
} from '../src/content/batch-production.ts';
import {
  hashEditorialCandidates,
  hashEditorialJudgmentArtifact,
  loadAndVerifyEditorialJudgmentSets,
  reconcileIndependentJudgments,
  registerEditorialAuthorizations,
  sealAndValidateEditorialJudgmentSet,
  verifyEditorialCompleteness,
  type EditorialCandidate,
  type EditorialJudgment,
  type EditorialJudgmentExternalResult,
  type EditorialJudgmentSet,
  type ReviewInputRef,
  type ReviewRunAuthorization,
} from '../src/content/editorial-independent.ts';
import { applySpeechRevisions, type SpeechRevisionV2 } from '../src/content/f003-reuse.ts';
import { bridgeEditorialResolutionSetToReviewRecords } from '../src/content/f003-review-acceptance.ts';
import { EXTRACTOR_VERSION } from '../src/content/processing.ts';
import {
  extractF006DialogueCandidates,
  normalizeF006AozoraXhtmlEntities,
  parseF006SourceRecord,
  rehydrateF006SelectionSnapshot,
} from '../src/content/f006-source.ts';

/**
 * F006（中島敦3作品追加）山月記(000624)の独立二重判定・読み補正thin script。
 * DD-F006.md記載のとおりFUN-F006-007/008は「新規コードなし」の既存汎用関数
 * （editorial-independent.ts・f003-reuse.ts）をそのまま呼び出すだけであり、
 * F006専用の新規wrapperモジュールは作らない。抽出だけはF006固有の
 * f006-source.tsを既存exportのまま呼ぶ。
 * @des DES-F006-006 DES-F006-007 @fun FUN-F006-007 FUN-F006-008
 */

const BATCH_ID = 'F006';
const WORK_ID = '000624';
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f006-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F006.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F006.md';
const TOOL_PATH = 'src/content/editorial-independent.ts';
const REVISION_TOOL_PATH = 'src/content/f003-reuse.ts';

interface SpeakerJudgment {
  readonly candidateId: string;
  readonly speaker: string;
}

// VOICEVOX 0.25.2 speaker 3（ノーマル）のaudio_query実測により、
// 「李徴」を訓読み「しるし」等で誤読することを確認済みのspeechText補正。
// displayTextは変更しない（DD-F006.md FUN-F006-008）。
const SPEECH_CORRECTIONS: Readonly<Record<string, { readonly find: string; readonly to: string; readonly reason: string }>> = {
  // order 1: 「その声は、我が友、李徴子ではないか？」
  '.main_text:899-919': {
    find: '李徴子',
    to: 'リチョウシ',
    reason:
      'VOICEVOX 0.25.2 speaker 3のaudio_query実測で「李徴子」が「りいちょうこ」（徴子を誤ってちょうこと読む）に誤読されることを確認。displayTextを変えずカタカナで正しい読み「りちょうし」を強制する。',
  },
  // order 2: 「如何にも自分は隴西の李徴である」
  '.main_text:1054-1071': {
    find: '李徴',
    to: 'リチョウ',
    reason:
      'VOICEVOX 0.25.2 speaker 3のaudio_query実測で「李徴」が「りいしるし」（徴を訓読み「しるし」に誤読）に誤読されることを確認。displayTextを変えずカタカナで正しい読み「りちょう」を強制する。隴西は「ろうせい」で正しく読まれるため補正不要。',
  },
};

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function reviewCandidate(candidate: CandidateWithRevisions): EditorialCandidate {
  return Object.freeze({
    candidateId: candidate.candidateId,
    inputSha256: candidate.sha256,
    sourceAnchor:
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
  });
}

function authorization(
  role: ReviewRunAuthorization['role'],
  candidates: readonly EditorialCandidate[],
  common: {
    readonly candidateSetSha256: string;
    readonly policySha256: string;
    readonly promptSha256: string;
    readonly toolSha256: string;
    readonly inputRefs: readonly ReviewInputRef[];
  },
  issuedAt: string,
): ReviewRunAuthorization {
  return Object.freeze({
    authorizationId: `f006-${WORK_ID}-${role}`,
    role,
    producerTaskPath: `/root/f006-editorial/${WORK_ID}/${role}`,
    judgeRole: role,
    runId: `f006-${WORK_ID}-${role}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f006-${WORK_ID}-${role}-nonce`,
    issuedAt,
    inputRefs: common.inputRefs,
    candidates,
  });
}

function external(
  auth: ReviewRunAuthorization,
  judgments: EditorialJudgment[],
): EditorialJudgmentExternalResult {
  return {
    schemaVersion: '1.0.0',
    authorizationId: auth.authorizationId,
    role: auth.role,
    runId: auth.runId,
    candidateSetSha256: auth.candidateSetSha256,
    policySha256: auth.policySha256,
    promptSha256: auth.promptSha256,
    toolSha256: auth.toolSha256,
    judgments,
  };
}

function predictedArtifactSha(
  auth: ReviewRunAuthorization,
  judgments: readonly EditorialJudgment[],
  sealedAt: string,
): string {
  return hashEditorialJudgmentArtifact({
    schemaVersion: '1.0.0',
    header: {
      authorizationId: auth.authorizationId,
      role: auth.role,
      runId: auth.runId,
      candidateSetSha256: auth.candidateSetSha256,
      policySha256: auth.policySha256,
      promptSha256: auth.promptSha256,
      toolSha256: auth.toolSha256,
      sealedAt,
    },
    judgments,
  });
}

async function sealIfMissing(
  workspace: string,
  auth: ReviewRunAuthorization,
  judgments: EditorialJudgment[],
  sealedAt: string,
): Promise<EditorialJudgmentSet> {
  const expected = predictedArtifactSha(auth, judgments, sealedAt);
  const existing = (await loadAndVerifyEditorialJudgmentSets(workspace))
    .find((item) => item.header.authorizationId === auth.authorizationId);
  if (existing) {
    if (existing.header.artifactSha256 !== expected) {
      throw new Error(`${auth.role} sealが今回の判定と一致しません`);
    }
    return existing;
  }
  return sealAndValidateEditorialJudgmentSet(workspace, auth, external(auth, judgments), {
    now: () => sealedAt,
  });
}

/**
 * 段階Aで作成済みの独立二重判定・読み補正の証跡を根拠に、
 * content/batches/F006/batch.jsonのwork FSM（pending→extracted→reviewed）を
 * 既存transitionWorkState/writeBatchManifestAtomicだけで前進させる。
 * 同一入力での再実行はstageRecordsの既存出力と照合し、一致すれば何もしない
 * （F005 f005-run-work.tsのadvanceF005RunnerManifestと同じ再開可能パターン）。
 * @des DES-F006-006 DES-F006-007 @fun FUN-F006-007 FUN-F006-008
 */
async function advanceF006WorkState(
  workspace: string,
  manifest: BatchManifest,
  workId: WorkId,
  stage: 'extracted' | 'reviewed',
  output: Sha256,
  count: number,
  extra: Pick<StageEvidence, 'pendingCount'> = {},
  completedAt: string,
): Promise<BatchManifest> {
  const stageOrder = ['pending', 'extracted', 'reviewed'] as const;
  const index = manifest.workIds.indexOf(workId);
  const current = manifest.workProgress[index];
  if (!current) throw new Error(`work ${workId}がmanifestにありません`);
  const currentRank = stageOrder.indexOf(current.status as typeof stageOrder[number]);
  const nextRank = stageOrder.indexOf(stage);
  if (currentRank >= nextRank) {
    const existing = current.stageRecords.find((record) => record.stage === stage);
    const sameOutput = existing?.outputHashes.length === 1 && existing.outputHashes[0] === output;
    const sameBinding = existing?.count === count && existing.toolVersion === FSM_TOOL_VERSION &&
      (stage !== 'reviewed' || extra.pendingCount === 0);
    if (!sameOutput || !sameBinding) {
      throw new Error(`work stage再開証跡が今回入力と一致しません: ${stage}`);
    }
    return manifest;
  }
  if (nextRank !== currentRank + 1) throw new Error(`work stage順が不正です: ${stage}`);
  const expectedManifestSha = hashBatchManifest(manifest);
  const previousOutputs = current.stageRecords.at(-1)?.outputHashes ?? [];
  const evidence: StageEvidence = {
    kind: 'stage',
    stage,
    expectedManifestSha,
    workId,
    result: 'pass',
    inputHashes: [expectedManifestSha, ...previousOutputs],
    outputHashes: [output],
    count,
    toolVersion: FSM_TOOL_VERSION,
    completedAt,
    ...extra,
  };
  const next = transitionWorkState(manifest, workId, stage, evidence);
  await writeBatchManifestAtomic(
    workspace,
    MANIFEST_PATH as WorkspaceRelativePath,
    next,
    expectedManifestSha,
  );
  return next;
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());

  // 1) F006原典から山月記(000624)の3台詞候補を決定的に抽出する（既存f006-source.ts）。
  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F006.ref,
    BATCH_DEFINITION_REFS.F006.sha256,
    APPROVAL_POLICY_REFS.F006.ref,
    APPROVAL_POLICY_REFS.F006.sha256,
  );
  const snapshot = await rehydrateF006SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F006 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF006SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF006AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF006DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
  if (!extracted.result.ok) throw new Error('山月記の台詞抽出が失敗しました');

  const candidates = extracted.result.candidates
    .map((raw) => normalizeBatchCandidate(raw, DEFAULT_BATCH_SPEECH_RULES))
    .sort((left, right) => left.order - right.order);
  if (candidates.length === 0) throw new Error('台詞候補が0件です');

  const reviewCandidates = Object.freeze(candidates.map(reviewCandidate));

  // 2) 独立二重判定（既存editorial-independent.ts）。
  //    山月記の3候補はいずれも「」で囲まれた明確な発話であり、文脈（誰が発したか）も
  //    一意に確定できるため、primary/secondaryは独立に同一結論（承認・同一speaker）へ至る。
  const speakers: readonly SpeakerJudgment[] = [
    { candidateId: candidates[0]!.candidateId, speaker: '李徴' }, // 「あぶないところだった」
    { candidateId: candidates[1]!.candidateId, speaker: '袁傪' }, // 「その声は、我が友、李徴子ではないか？」
    { candidateId: candidates[2]!.candidateId, speaker: '李徴' }, // 「如何にも自分は隴西の李徴である」
  ];
  if (speakers.length !== candidates.length) {
    throw new Error('speaker判定件数が候補件数と一致しません');
  }
  const judgmentsFor = (): EditorialJudgment[] =>
    candidates.map((candidate) => {
      const speaker = speakers.find((item) => item.candidateId === candidate.candidateId);
      if (!speaker) throw new Error(`candidate ${candidate.candidateId}のspeakerが未定義です`);
      return Object.freeze({
        candidateId: candidate.candidateId,
        decision: 'approved' as const,
        reasonCode: 'SPOKEN_DIALOGUE',
        speaker: speaker.speaker,
        sourceAnchor: `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
        inputSha256: candidate.sha256,
      });
    });

  const [policyBytes, promptBytes, toolBytes] = await Promise.all([
    readFile(resolve(workspace, ...POLICY_PATH.split('/'))),
    readFile(resolve(workspace, ...PROMPT_PATH.split('/'))),
    readFile(resolve(workspace, ...TOOL_PATH.split('/'))),
  ]);
  const candidateSetSha256 = hashEditorialCandidates(reviewCandidates);
  const common = {
    candidateSetSha256,
    policySha256: sha256(policyBytes),
    promptSha256: sha256(promptBytes),
    toolSha256: sha256(toolBytes),
    inputRefs: [
      { kind: 'policy', path: POLICY_PATH, sha256: sha256(policyBytes) },
      { kind: 'prompt', path: PROMPT_PATH, sha256: sha256(promptBytes) },
      { kind: 'tool', path: TOOL_PATH, sha256: sha256(toolBytes) },
    ] satisfies ReviewInputRef[],
  };
  const primaryIssuedAt = '2026-08-22T00:10:00.000Z';
  const secondaryIssuedAt = '2026-08-22T00:10:01.000Z';
  const primarySealedAt = '2026-08-22T00:15:00.000Z';
  const secondarySealedAt = '2026-08-22T00:15:01.000Z';
  const primary = authorization('primary', reviewCandidates, common, primaryIssuedAt);
  const secondary = authorization('secondary', reviewCandidates, common, secondaryIssuedAt);
  await registerEditorialAuthorizations(workspace, [primary, secondary]);
  await sealIfMissing(workspace, primary, judgmentsFor(), primarySealedAt);
  await sealIfMissing(workspace, secondary, judgmentsFor(), secondarySealedAt);

  const trusted = await loadAndVerifyEditorialJudgmentSets(workspace);
  const primarySet = trusted.find((item) => item.header.authorizationId === primary.authorizationId);
  const secondarySet = trusted.find((item) => item.header.authorizationId === secondary.authorizationId);
  if (!primarySet || !secondarySet) throw new Error('trusted sealが2件揃っていません');

  const resolution = reconcileIndependentJudgments(reviewCandidates, primarySet, secondarySet);
  const completeness = verifyEditorialCompleteness(reviewCandidates, resolution.resolutions);
  if (completeness.result !== 'pass' || resolution.pendingIds.length !== 0) {
    throw new Error(`編集判定が完結していません: ${canonicalJson(completeness)}`);
  }

  const legacyReviews = bridgeEditorialResolutionSetToReviewRecords(
    WORK_ID,
    resolution,
    primarySet,
    secondarySet,
  );

  const outputRoot = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}`;
  await writeJsonArtifactAtomic(workspace, resolve(workspace, ...`${outputRoot}/reviews/primary.json`.split('/')), primarySet);
  await writeJsonArtifactAtomic(workspace, resolve(workspace, ...`${outputRoot}/reviews/secondary.json`.split('/')), secondarySet);
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`${outputRoot}/review-reconciliation.json`.split('/')),
    resolution,
  );
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`content/batches/${BATCH_ID}/reviews/${WORK_ID}.json`.split('/')),
    legacyReviews,
  );

  // 2.5) 決定的抽出結果を独立snapshotとしてcanonical固定する（FSM extracted遷移のoutputHash根拠）。
  const candidatesArtifact = {
    schemaVersion: '1.0.0' as const,
    kind: 'f006-extracted-candidates' as const,
    batchId: BATCH_ID,
    workId: WORK_ID,
    extractorVersion: EXTRACTOR_VERSION,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      order: candidate.order,
      displayText: candidate.displayText,
      speechText: candidate.speechText,
      sha256: candidate.sha256,
      sourceAnchor:
        `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`,
    })),
  };
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`${outputRoot}/candidates.json`.split('/')),
    candidatesArtifact,
  );
  const candidatesSha256 = sha256(canonicalJson(candidatesArtifact)) as Sha256;
  const reviewsSha256 = sha256(canonicalJson(legacyReviews)) as Sha256;

  // 3) 読み補正の要否確認・適用（既存f003-reuse.ts、displayTextは不変）。
  const approvedForSpeech = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    displayText: candidate.displayText,
    speechText: candidate.speechText,
  }));
  const revisionToolBytes = await readFile(resolve(workspace, ...REVISION_TOOL_PATH.split('/')));
  const revisions: SpeechRevisionV2[] = [];
  for (const candidate of candidates) {
    const correction = SPEECH_CORRECTIONS[
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`
    ];
    if (!correction) continue;
    if (!candidate.speechText.includes(correction.find)) {
      throw new Error(`補正対象文字列が見つかりません: ${candidate.candidateId}`);
    }
    const before = candidate.speechText;
    const after = before.split(correction.find).join(correction.to);
    revisions.push({
      candidateId: candidate.candidateId,
      revision: 1,
      before,
      after,
      reason: correction.reason,
      inputSha256: sha256(before),
      outputSha256: sha256(after),
    });
  }
  const revised = applySpeechRevisions(approvedForSpeech, revisions);
  const revisedByCandidate = new Map(revised.map((item) => [item.candidateId, item]));
  for (const candidate of candidates) {
    const item = revisedByCandidate.get(candidate.candidateId);
    if (!item || item.displayText !== candidate.displayText) {
      throw new Error(`displayTextが変更されています: ${candidate.candidateId}`);
    }
  }

  const speechRevisionArtifact = {
    schemaVersion: '1.0.0' as const,
    kind: 'f006-speech-revision-result' as const,
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256: sha256(revisionToolBytes),
    reconciliationDigest: resolution.reconciliationDigest,
    revisions,
    speech: revised.map((item) => ({
      candidateId: item.candidateId,
      displayText: item.displayText,
      speechText: item.speechText,
      revisionCount: item.revisionCount,
      speechSha256: item.speechSha256,
    })),
  };
  await writeJsonArtifactAtomic(
    workspace,
    resolve(workspace, ...`${outputRoot}/speech-revisions.json`.split('/')),
    speechRevisionArtifact,
  );

  // 4) 段階Aで作成済みの証跡を根拠に、batch.jsonのwork FSMを
  //    pending → extracted → reviewed へ実際に前進させる（T-151遷移漏れの解消）。
  const manifestPath = resolve(workspace, ...MANIFEST_PATH.split('/'));
  const manifestText = await readFile(manifestPath, 'utf8');
  const checkedManifest = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checkedManifest.ok || canonicalJson(checkedManifest.value) !== manifestText) {
    throw new Error('F006 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-22T00:20:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF006WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF006WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'reviewed',
    reviewsSha256,
    candidates.length,
    { pendingCount: 0 },
    fsmCompletedAt,
  );

  const approved = resolution.resolutions.filter((item) => item.finalDecision === 'approved').length;
  const rejected = resolution.resolutions.filter((item) => item.finalDecision === 'rejected').length;
  const workStatus = manifest.workProgress[manifest.workIds.indexOf(WORK_ID as WorkId)]?.status;
  process.stdout.write(
    `F006/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
