import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  loadAndVerifyEditorialJudgmentSets,
  type EditorialJudgmentExternalResult,
  type EditorialJudgmentSet,
  type ReviewRunAuthorization,
} from '../src/content/editorial-independent.ts';
import {
  reconcileF004Judgments,
  sealF004JudgmentSet,
  type F004CandidateSet,
} from '../src/content/f004-editorial.ts';

const WORK_ID = process.argv[2];
if (!WORK_ID || !/^[0-9]{6}$/u.test(WORK_ID)) throw new Error('6桁のwork IDが必要です');
const BUNDLE_PATH = `content/batches/F004/review-inputs/${WORK_ID}-authorizations.json`;
const REVIEW_INPUT_PATH = `content/batches/F004/review-inputs/${WORK_ID}.json`;
const ROLES = ['primary', 'secondary', 'adjudicator'] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function sealOrResume(
  workspace: string,
  authorization: ReviewRunAuthorization,
  external: EditorialJudgmentExternalResult,
): Promise<EditorialJudgmentSet> {
  const existing = (await loadAndVerifyEditorialJudgmentSets(workspace))
    .find((item) => item.header.authorizationId === authorization.authorizationId);
  if (existing) return existing;
  return sealF004JudgmentSet(workspace, authorization, external);
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [bundleArtifact, candidateArtifact] = await Promise.all([
    canonicalArtifact<{
      schemaVersion: '1.0.0';
      kind: 'f004-review-authorization-bundle';
      batchId: 'F004';
      workId: string;
      authorizations: readonly ReviewRunAuthorization[];
    }>(workspace, BUNDLE_PATH),
    canonicalArtifact<F004CandidateSet>(workspace, REVIEW_INPUT_PATH),
  ]);
  const bundle = bundleArtifact.value;
  if (
    bundle.schemaVersion !== '1.0.0' ||
    bundle.kind !== 'f004-review-authorization-bundle' ||
    bundle.batchId !== 'F004' ||
    bundle.workId !== WORK_ID ||
    ![2, 3].includes(bundle.authorizations.length)
  ) {
    throw new Error('authorization bundleが不正です');
  }
  const sealed = new Map<string, EditorialJudgmentSet>();
  const requiredRoles = bundle.authorizations.some((item) => item.role === 'adjudicator')
    ? ROLES
    : ROLES.slice(0, 2);
  for (const role of requiredRoles) {
    const authorization = bundle.authorizations.find((item) => item.role === role);
    if (!authorization) throw new Error(`${role} authorizationがありません`);
    const externalPath = `.cache/f004-review/${WORK_ID}-${role}.json`;
    const external = await canonicalArtifact<EditorialJudgmentExternalResult>(workspace, externalPath);
    const judgmentSet = await sealOrResume(workspace, authorization, external.value);
    sealed.set(role, judgmentSet);
    await writeJsonArtifactAtomic(
      workspace,
      join(
        resolve(workspace),
        'content',
        'batches',
        'F004',
        'work-artifacts',
        WORK_ID,
        'reviews',
        role === 'adjudicator' ? 'adjudication.json' : `${role}.json`,
      ),
      judgmentSet,
    );
  }
  const primary = sealed.get('primary');
  const secondary = sealed.get('secondary');
  const adjudicator = sealed.get('adjudicator');
  if (!primary || !secondary) throw new Error('primary/secondary sealが揃っていません');
  const reconciliation = reconcileF004Judgments(
    candidateArtifact.value.reviewCandidates,
    primary,
    secondary,
    adjudicator,
  );
  const reconciliationPath =
    `content/batches/F004/work-artifacts/${WORK_ID}/review-reconciliation.json`;
  await writeJsonArtifactAtomic(
    workspace,
    join(resolve(workspace), ...reconciliationPath.split('/')),
    reconciliation,
  );
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    primaryArtifactSha256: primary.header.artifactSha256,
    secondaryArtifactSha256: secondary.header.artifactSha256,
    adjudicationArtifactSha256: adjudicator?.header.artifactSha256 ?? null,
    reconciliationPath,
    reconciliationSha256: sha256(canonicalJson(reconciliation)),
    approved: reconciliation.resolutions.filter((item) => item.finalDecision === 'approved').length,
    rejected: reconciliation.resolutions.filter((item) => item.finalDecision === 'rejected').length,
    pending: reconciliation.pendingIds.length,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
