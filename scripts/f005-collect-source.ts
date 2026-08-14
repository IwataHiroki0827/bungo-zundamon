import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/content/artifacts.ts';
import {
  DEFAULT_BATCH_SPEECH_RULES,
  normalizeBatchCandidate,
} from '../src/content/batch-production.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import {
  F005_WORKS,
  F005_SELECTION_SNAPSHOT_PATH,
  collectF005SourceSnapshot,
  evaluateF005RightsAndUsage,
  extractF005DialogueCandidates,
  normalizeAozoraXhtmlEntities,
  parseF005SourceRecord,
  rehydrateF005SelectionSnapshot,
  closeSafeWorkspaceFile,
  readSafeWorkspaceFile,
  renameSafeWorkspaceFile,
  resolveSafeWorkspaceFile,
  type SafeFileHandle,
  type F005Phase,
  type F005WorkId,
  type RawArtifactRef,
} from '../src/content/f005-source.ts';
import { EXTRACTOR_VERSION } from '../src/content/processing.ts';
import { ProductionAozoraTransport } from '../src/content/source.ts';
import {
  ProductionPolicyTransport,
} from '../src/notices/policy-snapshots.ts';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function absoluteArtifactPath(workspace: string, relativePath: string): string {
  const target = resolve(workspace, ...relativePath.split('/'));
  const relation = relative(workspace, target);
  if (
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`artifact pathが不正です: ${relativePath}`);
  }
  return target;
}

export async function writeF005SourceArtifactOnce(
  workspace: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = absoluteArtifactPath(workspace, relativePath);
  let existingCapability: SafeFileHandle | undefined;
  try {
    await lstat(target);
    existingCapability = await resolveSafeWorkspaceFile(workspace, relativePath, 'read');
    const existing = await readSafeWorkspaceFile(existingCapability);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw new Error(`既存binary artifactが不一致です: ${relativePath}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    if (existingCapability) await closeSafeWorkspaceFile(existingCapability);
  }
  const selectionArchivePath =
    'data/batches/F005/source-snapshots/selection/bibliography.zip';
  const anchorPath = relativePath === selectionArchivePath ||
    relativePath === F005_SELECTION_SNAPSHOT_PATH
    ? 'package.json'
    : relativePath.startsWith('data/batches/F005/source-snapshots/')
      ? selectionArchivePath
    : relativePath.startsWith('content/batches/F005/source-snapshots/')
      ? F005_SELECTION_SNAPSHOT_PATH
      : 'package.json';
  const anchor = await resolveSafeWorkspaceFile(workspace, anchorPath, 'read');
  const temporaryRelative = `.f005-source-${randomUUID()}.tmp`;
  const temporary = absoluteArtifactPath(workspace, temporaryRelative);
  let temporaryCapability: SafeFileHandle | undefined;
  try {
    const parent = await lstat(dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error(`artifact親directoryが不正です: ${relativePath}`);
    }
    await writeFile(temporary, bytes, { flag: 'wx' });
    temporaryCapability = await resolveSafeWorkspaceFile(workspace, temporaryRelative, 'rename-source');
    await renameSafeWorkspaceFile(
      temporaryCapability,
      relativePath,
      temporaryCapability.nativeIdentity,
    );
    const persistedCapability = await resolveSafeWorkspaceFile(workspace, relativePath, 'read');
    try {
      const persisted = await readSafeWorkspaceFile(persistedCapability);
      if (persisted.byteLength !== bytes.byteLength || sha256(persisted) !== sha256(bytes)) {
        throw new Error(`binary artifactの再読込に失敗しました: ${relativePath}`);
      }
    } finally {
      await closeSafeWorkspaceFile(persistedCapability);
    }
  } finally {
    try {
      if (temporaryCapability) await closeSafeWorkspaceFile(temporaryCapability);
      await rm(temporary, { force: true });
    } finally {
      await closeSafeWorkspaceFile(anchor);
    }
  }
}

async function readSealedJsonArtifact(
  workspace: string,
  relativePath: string,
): Promise<unknown> {
  const capability = await resolveSafeWorkspaceFile(workspace, relativePath, 'read');
  try {
    const bytes = await readSafeWorkspaceFile(capability);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new Error(`封緘済みartifactがcanonical JSONではありません: ${relativePath}`);
    }
    return value;
  } finally {
    await closeSafeWorkspaceFile(capability);
  }
}

async function writeJsonArtifactOnce(
  workspace: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  await writeF005SourceArtifactOnce(
    workspace,
    relativePath,
    new TextEncoder().encode(canonicalJson(value)),
  );
}

function metadata(artifact: RawArtifactRef, path: string): object {
  return {
    storage: 'sealed',
    path,
    sourceUrl: artifact.sourceUrl,
    fetchedAt: artifact.fetchedAt,
    mediaType: artifact.mediaType,
    charset: artifact.charset,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    transport: artifact.transport,
  };
}

function derivedMetadata(
  artifact: RawArtifactRef,
  parentPath: string,
  parentSha256: string,
): object {
  return {
    storage: 'derived',
    path: parentPath,
    derivedFromSha256: parentSha256,
    sourceUrl: artifact.sourceUrl,
    fetchedAt: artifact.fetchedAt,
    mediaType: artifact.mediaType,
    charset: artifact.charset,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    transport: artifact.transport,
  };
}

async function main(): Promise<void> {
  const phaseArg = process.argv[2] === 'selection' || process.argv[2] === 'predeploy'
    ? process.argv[2] as F005Phase
    : 'selection';
  const workIdArg = phaseArg === process.argv[2]
    ? process.argv[3] ?? '000799'
    : process.argv[2] ?? '000799';
  if (!F005_WORKS.some((work) => work.workId === workIdArg)) {
    throw new Error('F005の6桁work IDが必要です');
  }
  const workId = workIdArg as F005WorkId;
  const reviewInputPath = `content/batches/F005/review-inputs/${workId}.json`;
  const candidatePath = `content/batches/F005/work-artifacts/${workId}/candidates.json`;
  const sourceRecordPath =
    `content/batches/F005/work-artifacts/${workId}/source-record.json`;
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  // CHG-F005-073: work-artifacts配下は作品ごとに掘られる。1作品目は既存だが
  // 2作品目以降は存在せず、封緘書き込みが親directory不在で落ちる。
  await mkdir(absoluteArtifactPath(workspace, `content/batches/F005/work-artifacts/${workId}`), {
    recursive: true,
  });
  const contextRoot = await realpath(process.env.F005_CONTEXT_ROOT ?? workspace);
  const context = await loadVerifiedF005Definition(contextRoot);
  const selectionSnapshot = phaseArg === 'predeploy'
    ? await rehydrateF005SelectionSnapshot(workspace, context)
    : undefined;
  // CHG-F005-073: 選定snapshotはバッチ単位で一度だけ封緘する。2作品目以降の
  // collect-sourceで再取得すると、青空文庫が書誌を更新した分だけ封緘済み
  // artifactと衝突し、作品追加が上流で止まる。封緘済みならそれを復元して使う。
  const sealedSelection = phaseArg === 'selection' &&
      await lstat(absoluteArtifactPath(workspace, F005_SELECTION_SNAPSHOT_PATH))
        .then(() => true, () => false)
    ? await rehydrateF005SelectionSnapshot(workspace, context)
    : undefined;
  const snapshot = sealedSelection ?? await collectF005SourceSnapshot(
    new ProductionAozoraTransport(),
    context,
    phaseArg,
    () => new Date(),
    {
      policyTransport: new ProductionPolicyTransport(),
      trustedProjectRoot: workspace,
      workspace,
      ...(selectionSnapshot ? { selectionSnapshot } : {}),
    },
  );
  const rights = evaluateF005RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  if (rights.decision !== 'allow') {
    throw new Error(`F005 rights/usageがblockedです: ${rights.reasons.join(',')}`);
  }
  const predeployRun = snapshot.observedAt.replace(/[:.]/gu, '-');
  const snapshotPath = phaseArg === 'selection'
    ? F005_SELECTION_SNAPSHOT_PATH
    : `content/batches/F005/source-snapshots/predeploy-${predeployRun}.json`;
  const dataPath = (leaf: string): string => phaseArg === 'selection'
    ? `data/batches/F005/source-snapshots/selection/${leaf}`
    : `data/batches/F005/source-snapshots/selection/predeploy-${predeployRun}-${leaf.replace(/\//gu, '-')}`;

  const binaryEntries: Array<{
    readonly path: string;
    readonly artifact: RawArtifactRef;
  }> = [
    {
      path: dataPath('bibliography.zip'),
      artifact: snapshot.bibliographyArchive,
    },
    {
      path: dataPath('bibliography.csv'),
      artifact: snapshot.bibliographyCsv,
    },
    {
      path: dataPath('author-page.html'),
      artifact: snapshot.authorPage,
    },
    ...snapshot.policies.map((policy) => ({
      path: dataPath(`policies/${policy.policyId}.raw`),
      artifact: policy.artifact,
    })),
    ...snapshot.works.flatMap((work) => [
      {
        path: dataPath(`works/${work.workId}/card.html`),
        artifact: work.card,
      },
      {
        path: dataPath(`works/${work.workId}/source.raw`),
        artifact: work.xhtml,
      },
    ]),
  ];
  for (const [index, entry] of binaryEntries.entries()) {
    // 公式ZIPから決定的に再導出できるlarge CSVは重複保存せず、親SHAへ結合する。
    if (index === 1 && entry.artifact.byteLength > 8_388_608) continue;
    await writeF005SourceArtifactOnce(workspace, entry.path, entry.artifact.bytes);
  }

  const rebuiltArtifact = {
    schemaVersion: '2.0.0',
    kind: phaseArg === 'selection'
      ? 'f005-source-selection-snapshot'
      : 'f005-source-predeploy-snapshot',
    batchId: 'F005',
    authorId: snapshot.authorId,
    phase: snapshot.phase,
    observedAt: snapshot.observedAt,
    rights,
    bibliographyArchive: metadata(
      snapshot.bibliographyArchive,
      binaryEntries[0]!.path,
    ),
    bibliographyCsv: snapshot.bibliographyCsv.byteLength > 8_388_608
      ? derivedMetadata(
        snapshot.bibliographyCsv,
        binaryEntries[0]!.path,
        snapshot.bibliographyArchive.sha256,
      )
      : metadata(snapshot.bibliographyCsv, binaryEntries[1]!.path),
    authorPage: metadata(snapshot.authorPage, binaryEntries[2]!.path),
    policies: snapshot.policies.map((policy) => {
      const entry = binaryEntries.find((item) =>
        item.artifact === policy.artifact);
      if (!entry) throw new Error(`policy artifact pathがありません: ${policy.policyId}`);
      return {
        policyId: policy.policyId,
        versionOrLabel: policy.versionOrLabel,
        artifact: metadata(policy.artifact, entry.path),
        decision: policy.decision,
      };
    }),
    works: snapshot.works.map((work) => {
      const card = binaryEntries.find((item) => item.artifact === work.card);
      const xhtml = binaryEntries.find((item) => item.artifact === work.xhtml);
      if (!card || !xhtml) throw new Error(`work artifact pathがありません: ${work.workId}`);
      return {
        workId: work.workId,
        title: work.title,
        bibliography: work.bibliography,
        card: metadata(work.card, card.path),
        xhtml: metadata(work.xhtml, xhtml.path),
      };
    }),
  };
  // CHG-F005-073: 封緘済みsnapshotは再構築せず、そのまま正本とする。
  // 封緘時点のスクリプトと現行版では大容量CSVの表現が異なるため、
  // 同一artifactからでもbyte一致する文書を再構築できない。
  // 復元時にSHA照合済みであり、記録としての正しさは封緘済み文書側にある。
  const selectionArtifact = sealedSelection
    ? await readSealedJsonArtifact(workspace, snapshotPath)
    : rebuiltArtifact;
  if (!sealedSelection) {
    await writeJsonArtifactOnce(workspace, snapshotPath, rebuiltArtifact);
  }
  if (phaseArg === 'predeploy') {
    process.stdout.write(canonicalJson({
      ok: true,
      phase: phaseArg,
      workId,
      observedAt: snapshot.observedAt,
      selectionObservedAt: selectionSnapshot?.observedAt,
      rightsDecision: rights.decision,
      snapshotPath,
      snapshotSha256: sha256(canonicalJson(selectionArtifact)),
    }));
    return;
  }

  const workSnapshot = snapshot.works.find((work) => work.workId === workId);
  if (!workSnapshot) throw new Error(`snapshotに${workId}がありません`);
  const source = parseF005SourceRecord(workSnapshot, workId);
  const normalization = await normalizeAozoraXhtmlEntities(
    workSnapshot.xhtml.bytes,
    source,
    source.workId === '001104'
      ? 'aozora-xhtml-entity-v1'
      : 'aozora-xhtml-passthrough-v1',
    workspace,
  );
  const candidateSet = await extractF005DialogueCandidates(
    normalization,
    source,
    EXTRACTOR_VERSION,
  );
  if (!candidateSet.result.ok || !candidateSet.result.success) {
    throw new Error(`${workId}の台詞候補抽出に失敗しました`);
  }
  const candidates = candidateSet.result.candidates.map((candidate) =>
    normalizeBatchCandidate(candidate, DEFAULT_BATCH_SPEECH_RULES));
  const sourceRecordArtifact = {
    schemaVersion: source.schemaVersion,
    workId: source.workId,
    title: source.title,
    cardUrl: source.cardUrl,
    sourceUrl: source.sourceUrl,
    fetchedAt: source.fetchedAt,
    updatedAt: source.updatedAt,
    bibliographyCharset: source.bibliographyCharset,
    bodySelector: source.bodySelector,
    bibliography: source.bibliography,
    raw: metadata(
      source.raw,
      `data/batches/F005/source-snapshots/selection/works/${source.workId}/source.raw`,
    ),
    card: metadata(
      source.card,
      `data/batches/F005/source-snapshots/selection/works/${source.workId}/card.html`,
    ),
    normalization: {
      schemaVersion: normalization.schemaVersion,
      policyVersion: normalization.policyVersion,
      variant: normalization.variant,
      rawSha256: normalization.rawSha256,
      processed: {
        storage: normalization.processed.storage,
        path: normalization.processed.capability.relativePosixPath,
        sourceUrl: normalization.processed.sourceUrl,
        fetchedAt: normalization.processed.fetchedAt,
        mediaType: normalization.processed.mediaType,
        charset: normalization.processed.charset,
        byteLength: normalization.processed.byteLength,
        sha256: normalization.processed.sha256,
      },
      replacements: normalization.replacements,
    },
  };
  await writeJsonArtifactOnce(workspace, sourceRecordPath, sourceRecordArtifact);
  await writeJsonArtifactOnce(workspace, reviewInputPath, candidateSet);
  await writeJsonArtifactOnce(workspace, candidatePath, candidates);
  process.stdout.write(canonicalJson({
    ok: true,
    workId,
    observedAt: snapshot.observedAt,
    rightsDecision: rights.decision,
    sourceSha256: source.raw.sha256,
    processedSha256: normalization.processed.sha256,
    candidateCount: candidates.length,
    selectionPath: snapshotPath,
    selectionSha256: sha256(canonicalJson(selectionArtifact)),
    sourceRecordPath,
    sourceRecordSha256: sha256(canonicalJson(sourceRecordArtifact)),
    reviewInputPath,
    reviewInputSha256: sha256(canonicalJson(candidateSet)),
    candidatePath,
    candidateSha256: sha256(canonicalJson(candidates)),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
