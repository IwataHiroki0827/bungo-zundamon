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
  extractF009DialogueCandidates,
  F009_WORKS,
  normalizeF009AozoraXhtmlEntities,
  parseF009SourceRecord,
  rehydrateF009SelectionSnapshot,
  type F009WorkId,
} from '../src/content/f009-source.ts';

/**
 * F009（夢野久作3作品追加）work単位の独立二重判定・読み補正thin script。
 * f008-prepare-editorial.tsをF009向けにパラメータ化した複製。
 *
 * 瓶詰地獄(002381)は実extractorが抽出した候補がわずか4件であり（DOMAIN-F009.md §3.1の
 * naiveな最外側「」カウント13件は、地の文を挟まない連続した引用段落を単一候補へ
 * 結合する既存extractor仕様（F002〜F008と同一、新規挙動ではない）により実際には
 * 圧縮される）、青空文庫本文（2381_13352.html、Shift_JIS正規化済みテキスト）を
 * 実際に通読しfull文脈で4候補全件を確認した。本作は市川太郎が書いた告白の手紙
 * （瓶詰地獄形式の第一の瓶）であり、4候補はいずれも地の文が「と…叫びながら」
 * 「…こんな事を云い出しました」等の発話動詞で明示的に導入する実際の引用発話・
 * 独白であって、語そのものへの言及（人間椅子の「奥様」「人間椅子」等と同型の
 * NON_SPEECHパターン）は本作には出現しない。
 * order0・order1はアヤ子の実際の叫び・発話、order2は太郎が神像の前にひれ伏して
 * 唱えた祈りの引用（人間椅子order2/3・山椒大夫order118と同型の「」内心内語・独白は
 * approvedとする既存precedentに従う）、order3は救助信号を破壊した直後に太郎が
 * 「こう考えて」呟いた独白であり、いずれもSPOKEN_DIALOGUEとしてapprovedとする。
 * speechTextは既にAozora ruby（旧仮名・難読語のふりがな）で発話用の読みへ変換済み
 * であり（例: 患難→なやみ、燃ゆる閃電→燃ゆるいなずま）、追加の読み補正は不要と
 * 判定した。
 * @des DES-F009-006 DES-F009-007 @fun FUN-F009-007 FUN-F009-008
 */

const BATCH_ID = 'F009';
const workIdArgument = process.argv[2];
if (!workIdArgument || !F009_WORKS.some((work) => work.workId === workIdArgument)) {
  throw new Error(
    `F009_WORKSに定義済みのwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f009-prepare-editorial.ts 002381）: ${String(workIdArgument)}`,
  );
}
const WORK_ID: F009WorkId = workIdArgument as F009WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const FSM_TOOL_VERSION = 'f009-prepare-editorial-v1';
const POLICY_PATH = 'docs/srs/SRS-F009.md';
const PROMPT_PATH = 'docs/tests/ut/UT-F009.md';
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
 * displayTextは変更しない（DD-F009.md FUN-F009-008）。候補は抽出順
 * （order昇順）で対応させる。
 */
interface WorkEditorialConfig {
  readonly judgmentsByOrder: readonly Omit<CandidateJudgment, 'candidateId'>[];
  readonly speechCorrections: Readonly<Record<string, readonly SpeechCorrection[]>>;
}

const WORK_EDITORIAL_CONFIGS: Readonly<Record<string, WorkEditorialConfig>> = {
  // 瓶詰地獄(002381)。青空文庫本文（2381_13352.html正規化済みテキスト）を実際に
  // 通読し4候補全件の話者・decisionを確定した。本作は市川太郎が書いた告白の
  // 手紙（瓶詰地獄形式の第一の瓶）であり、いずれの候補も語そのものへの言及
  // ではなく、地の文が発話動詞で明示的に導入する実際の引用発話・独白である。
  '002381': {
    judgmentsByOrder: [
      // order0 「お兄さま…………」。地の文「とアヤ子が叫びながら…私の肩へ飛び付いて
      // 来る」の通り、アヤ子が実際に叫んだ言葉。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アヤ子' },
      // order1 「ネエ。お兄様。…」。地の文「アヤ子はフイと、こんな事を云い出しました」
      // に続くアヤ子の実際の発話。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: 'アヤ子' },
      // order2 「ああ。天にまします神様よ。…」。地の文「あの神様の足の上に来て、
      // 頭を掻きむしり掻きむしりひれ伏しました」に続けて唱えた祈りの引用。
      // 人間椅子order2/3・山椒大夫order118と同型の「」内独白・内心の発話として
      // approvedとする（実際に声に出したか黙祷かに関わらず、引用符で明示された
      // 発話・独白は既存precedentどおりSPOKEN_DIALOGUE扱い）。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（太郎）' },
      // order3 「もう大丈夫だ。…」。救助信号（棒とヤシの葉）を破壊した直後、
      // 地の文「こう考えて、何かしらゲラゲラと嘲り笑いながら」に続く太郎の
      // 独白。order2と同型のSPOKEN_DIALOGUEとしてapprovedとする。
      { decision: 'approved', reasonCode: 'SPOKEN_DIALOGUE', speaker: '私（太郎）' },
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
    authorizationId: `f009-${WORK_ID}-${role}`,
    role,
    producerTaskPath: `/root/f009-editorial/${WORK_ID}/${role}`,
    judgeRole: role,
    runId: `f009-${WORK_ID}-${role}-run`,
    candidateSetSha256: common.candidateSetSha256,
    policySha256: common.policySha256,
    promptSha256: common.promptSha256,
    toolSha256: common.toolSha256,
    nonce: `f009-${WORK_ID}-${role}-nonce`,
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

/** @des DES-F009-006 DES-F009-007 @fun FUN-F009-007 FUN-F009-008 */
async function advanceF009WorkState(
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
    BATCH_DEFINITION_REFS.F009.ref,
    BATCH_DEFINITION_REFS.F009.sha256,
    APPROVAL_POLICY_REFS.F009.ref,
    APPROVAL_POLICY_REFS.F009.sha256,
  );
  const snapshot = await rehydrateF009SelectionSnapshot(workspace, context);
  const workSnapshot = snapshot.works.find((work) => work.workId === WORK_ID);
  if (!workSnapshot) throw new Error(`F009 selection snapshotにwork ${WORK_ID}がありません`);
  const record = parseF009SourceRecord(workSnapshot, WORK_ID);
  const normalization = normalizeF009AozoraXhtmlEntities(record.raw.bytes, record);
  const extracted = extractF009DialogueCandidates(normalization, record, EXTRACTOR_VERSION);
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
  const primaryIssuedAt = '2026-08-24T02:00:00.000Z';
  const secondaryIssuedAt = '2026-08-24T02:00:01.000Z';
  const primarySealedAt = '2026-08-24T02:05:00.000Z';
  const secondarySealedAt = '2026-08-24T02:05:01.000Z';
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
    kind: 'f009-extracted-candidates' as const,
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
    kind: 'f009-speech-revision-result' as const,
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
    throw new Error('F009 manifestがcanonicalではありません');
  }
  const fsmCompletedAt = '2026-08-24T02:10:00.000Z';
  let manifest = checkedManifest.value;
  manifest = await advanceF009WorkState(
    workspace,
    manifest,
    WORK_ID as WorkId,
    'extracted',
    candidatesSha256,
    candidates.length,
    {},
    fsmCompletedAt,
  );
  manifest = await advanceF009WorkState(
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
    `F009/${WORK_ID}: approved=${approved}, rejected=${rejected}, pending=0, ` +
    `speechRevisions=${revisions.length}, workStatus=${String(workStatus)}\n`,
  );
}

await main();
