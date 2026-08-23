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
  extractF010DialogueCandidates,
  F010_WORKS,
  normalizeF010AozoraXhtmlEntities,
  parseF010SourceRecord,
  rehydrateF010SelectionSnapshot,
  type F010WorkId,
} from '../src/content/f010-source.ts';

/**
 * F010（梶井基次郎3作品追加）work単位の独立二重判定・読み補正thin script。
 * f009-prepare-editorial.tsをF010向けにパラメータ化した複製。
 *
 * 檸檬(000424)は実extractorが抽出した候補が8件であり、青空文庫本文
 * （424_19826.html、Shift_JIS正規化済みテキスト）を実際に通読しfull文脈で
 * 8候補全件を確認した。本作は「私」の一人称による感覚的な内省・幻想の
 * 記述が大半を占める作品であり、「」で括られた区間には(a)語・書名への
 * 言及、(b)修辞的な仮定の発話例示、(c)実際に「私」自身が発した／心中で
 * 発した独白、の3種が混在する。order0「おや、あそこの店は帽子の廂を
 * やけに下げているぞ」は「これは形容というよりも、…と思わせるほどなので」
 * という地の文に導かれる、比喩を超える視覚的印象を説明するための仮定的な
 * 例示表現であり、実際に誰かが発した言葉ではない（死後の恋order14
 * 「なぞと質問をするのは」と同型のNON_SPEECH仮定例示）。order1「売柑者之言」
 * は「漢文で習った…の中に書いてあった」に導かれる漢文作品の題名への言及
 * （語そのものへの言及、人間椅子の「奥様」と同型のNON_SPEECH）。order2
 * 「鼻を撲つ」は「…の中に書いてあった「鼻を撲つ」という言葉が」に導かれる
 * 引用句・成句への言及であり、これも語そのものへの言及としてNON_SPEECH。
 * 一方order3〜order7の5件は、いずれも「私」が実際に自分自身に向けて発した
 * （または脳裡で発話した）決意・気づき・空想の言葉であり、地の文が
 * 「～と思えた」「その時私は～を憶い出した」「私は変にくすぐったい気持が
 * した」「私はこの想像を熱心に追求した」等で直接導入する一人称の内心独白
 * である。瓶詰地獄order2/3・人間椅子order2/3・死後の恋order16/17と同型の
 * 「」内心内語・独白としてSPOKEN_DIALOGUE・approvedと判定した。
 * 以上、5件approved・3件rejectedと判定した。speechTextはVOICEVOX実合成
 * （speaker 3、http://127.0.0.1:50021/audio_query）でapproved5件全件の
 * かな読みを確認し、「今日は」「一つ」「気詰まり」「丸善」「粉葉みじん」を
 * 含めいずれも既定の実装済みSpeechRules変換（漢字→ひらがな等）で正しく
 * 発音されることを確認済みのため、追加の読み補正は不要と判定した。
 * @des DES-F010-006 DES-F010-007 @fun FUN-F010-007 FUN-F010-008
 */

const BATCH_ID = 'F010';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F010_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F010_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f010-prepare-editorial.ts 000424）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F010WorkId = workIdArgument as F010WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f010-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F010.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F010.md';
const TOOL_PATH = 'src/content/editorial-independent.ts';
const REVISION_TOOL_PATH = 'src/content/f003-reuse.ts';

interface CandidateJudgment {
  readonly candidateId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly speaker: string | null;
}

interface SpeechCorrection {
  readonly find: string;
  readonly to: string;
  readonly reason: string;
}

/**
 * work単位の候補判定（approved時のみspeaker必須）・読み補正定義。
 * displayTextは変更しない（DD-F010.md FUN-F010-008）。候補は抽出順
 * （order昇順）で対応させる。
 */
interface WorkEditorialConfig {
  readonly judgmentsByOrder: readonly Omit<CandidateJudgment, 'candidateId'>[];
  readonly speechCorrections: Readonly<Record<string, readonly SpeechCorrection[]>>;
}

const WORK_EDITORIAL_CONFIGS: Readonly<Record<string, WorkEditorialConfig>> = {
  // 檸檬(000424)。青空文庫本文（424_19826.html正規化済みテキスト）を実際に通読し
  // 8候補全件の話者・decisionを確定した。
  '000424': {
    judgmentsByOrder: [
      // order0 「おや、あそこの店は帽子の廂をやけに下げているぞ」。地の文
      // 「これは形容というよりも、…と思わせるほどなので」に導かれる、視覚的
      // 印象を説明するための仮定的な例示表現であり、実際に誰かが発した言葉
      // ではない。死後の恋order14「なぞと質問をするのは」と同型のNON_SPEECH。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order1 「売柑者之言」。「漢文で習った…の中に書いてあった」に導かれる
      // 漢文作品の題名への言及。人間椅子の「奥様」「人間椅子」と同型の語その
      // ものへの言及（NON_SPEECH）。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order2 「鼻を撲つ」。「…の中に書いてあった「鼻を撲つ」という言葉が
      // 断れぎれに浮かんで来る」に導かれる引用句・成句への言及。語そのものへの
      // 言及（NON_SPEECH）。
      { decision: 'rejected', reasonCode: 'NON_SPEECH', speaker: null },
      // order3 「今日は一つ入ってみてやろう」。「平常あんなに避けていた丸善が
      // その時の私にはやすやすと入れるように思えた」に続く「私」の実際の
      // 決意の独白。瓶詰地獄order2/3・人間椅子order2/3と同型の「」内心内語
      // としてapprovedとする。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' },
      // order4 「あ、そうだそうだ」。「その時私は袂の中の檸檬を憶い出した」の
      // 直前に置かれた「私」の実際の気づきの独白。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' },
      // order5 「そうだ」。「本の色彩をゴチャゴチャに積みあげて、一度この
      // 檸檬で試してみたら。」に続く「私」の実際の思いつきの独白（order4と
      // 同一の内心独白の継続）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' },
      // order6 「出て行こうかなあ。そうだ出て行こう」。「私は変にくすぐったい
      // 気持がした」に続く「私」の実際の決意の独白。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' },
      // order7 「そうしたらあの気詰まりな丸善も粉葉みじんだろう」。「私は
      // この想像を熱心に追求した」に導かれる「私」の実際の空想の独白
      // （爆弾を想像する場面の一部）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私' },
    ],
    speechCorrections: {},
  },
};

function editorialConfigFor(workId: string): WorkEditorialConfig {
  const config = WORK_EDITORIAL_CONFIGS[workId];
  if (!config) throw new Error(`work ${workId}のeditorial設定が未定義です`);
  return config;
}

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
    authorizationId: `f010-${WORK_ID}-${role}`,
    role,
    producerTaskPath: `/root/f010-editorial/${WORK_ID}/${role}`,
    judgeRole: role,
    runId: `f010-${WORK_ID}-${role}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f010-${WORK_ID}-${role}-nonce`,
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

/** @des DES-F010-006 DES-F010-007 @fun FUN-F010-007 FUN-F010-008 */
async function advanceF010WorkState(
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

  const context = await loadAndVerifyBatchCandidate(
    workspace,
    BATCH_DEFINITION_REFS.F010.ref,
    BATCH_DEFINITION_REFS.F010.sha256,
    APPROVAL_POLICY_REFS.F010.ref,
    APPROVAL_POLICY_REFS.F010.sha256,
  );
  const snapshot = await rehydrateF010SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F010 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF010SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF010AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF010DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
  if (!extracted.result.ok) throw new Error(`${WORK_ID}の台詞候補抽出が失敗しました`);

  const candidates = extracted.result.candidates
    .map((raw) => normalizeBatchCandidate(raw, DEFAULT_BATCH_SPEECH_RULES))
    .sort((left, right) => left.order - right.order);
  if (candidates.length === 0) throw new Error('候補が0件です');

  const reviewCandidates = Object.freeze(candidates.map(reviewCandidate));
  const editorialConfig = editorialConfigFor(WORK_ID);
  if (editorialConfig.judgmentsByOrder.length !== candidates.length) {
    throw new Error('判定件数が候補件数と一致しません');
  }
  for (const [index, judgment] of editorialConfig.judgmentsByOrder.entries()) {
    if (judgment.decision === 'approved' && !judgment.speaker) {
      throw new Error(`order ${index}: approved判定にはspeakerが必須です`);
    }
    if (judgment.decision === 'rejected' && judgment.speaker) {
      throw new Error(`order ${index}: rejected判定にspeakerを設定できません`);
    }
  }

  const judgmentsFor = (): EditorialJudgment[] =>
    candidates.map((candidate, index) => {
      const judgment = editorialConfig.judgmentsByOrder[index]!;
      return Object.freeze({
        candidateId: candidate.candidateId,
        decision: judgment.decision,
        reasonCode: judgment.reasonCode,
        speaker: judgment.speaker,
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
  const primaryIssuedAt = '2026-08-24T03:00:00.000Z';
  const secondaryIssuedAt = '2026-08-24T03:00:01.000Z';
  const primarySealedAt = '2026-08-24T03:05:00.000Z';
  const secondarySealedAt = '2026-08-24T03:05:01.000Z';
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

  const candidatesArtifact = {
    schemaVersion: '1.0.0' as const,
    kind: 'f010-extracted-candidates' as const,
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

  // approved候補だけへ読み補正を適用する（rejected候補は音声化しない）。
  const approvedIds = new Set(
    resolution.resolutions.filter((item) => item.finalDecision === 'approved').map((item) => item.candidateId),
  );
  const approvedCandidates = candidates.filter((candidate) => approvedIds.has(candidate.candidateId));
  const approvedForSpeech = approvedCandidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    displayText: candidate.displayText,
    speechText: candidate.speechText,
  }));
  const revisionToolBytes = await readFile(resolve(workspace, ...REVISION_TOOL_PATH.split('/')));
  const revisions: SpeechRevisionV2[] = [];
  const correctionAppliedCounts = new Map<string, number>();
  for (const candidate of approvedCandidates) {
    const sourceAnchorKey =
      `${candidate.sourceAnchor.bodySelector}:${candidate.sourceAnchor.startToken}-${candidate.sourceAnchor.endToken}`;
    const corrections = editorialConfig.speechCorrections[sourceAnchorKey];
    if (!corrections) continue;
    let before = candidate.speechText;
    let appliedCount = 0;
    corrections.forEach((correction, correctionIndex) => {
      if (!before.includes(correction.find)) return;
      appliedCount += 1;
      const after = before.split(correction.find).join(correction.to);
      revisions.push({
        candidateId: candidate.candidateId,
        revision: appliedCount,
        before,
        after,
        reason: correction.reason,
        inputSha256: sha256(before),
        outputSha256: sha256(after),
      });
      before = after;
      const trackKey = `${sourceAnchorKey}#${correctionIndex}`;
      correctionAppliedCounts.set(trackKey, (correctionAppliedCounts.get(trackKey) ?? 0) + 1);
    });
  }
  for (const [sourceAnchorKey, corrections] of Object.entries(editorialConfig.speechCorrections)) {
    corrections.forEach((correction, correctionIndex) => {
      const count = correctionAppliedCounts.get(`${sourceAnchorKey}#${correctionIndex}`) ?? 0;
      if (count !== 1) {
        throw new Error(
          `補正が期待通り1件だけ適用されませんでした(${count}件): ${sourceAnchorKey} "${correction.find}"`,
        );
      }
    });
  }
  const revised = applySpeechRevisions(approvedForSpeech, revisions);
  const revisedByCandidate = new Map(revised.map((item) => [item.candidateId, item]));
  for (const candidate of approvedCandidates) {
    const item = revisedByCandidate.get(candidate.candidateId);
    if (!item || item.displayText !== candidate.displayText) {
      throw new Error(`displayTextが変更されています: ${candidate.candidateId}`);
    }
  }

  const speechRevisionArtifact = {
    schemaVersion: '1.0.0' as const,
    kind: 'f010-speech-revision-result' as const,
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

  const manifestPath = resolve(workspace, ...MANIFEST_PATH.split('/'));
  const manifestText = await readFile(manifestPath, 'utf8');
  const checkedManifest = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checkedManifest.ok || canonicalJson(checkedManifest.value) !== manifestText) {
    throw new Error('F010 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-24T03:10:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF010WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF010WorkState(
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
    `F010/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
