import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import {
  type BatchApprovalGateRefs,
  type BatchAuthor,
  type BatchId,
  type BatchManifest,
  createNextBatchTemplate,
  type Sha256,
  type WorkspaceRelativePath,
} from './batch.ts';
import {
  canonicalJson,
  fingerprintArtifact,
  writeJsonArtifactAtomic,
} from './artifacts.ts';
import type { CatalogV2 } from './processing.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const BATCH_ID = /^F\d{3}$/u;
const AUTHOR_ID = /^\d{6}$/u;
const WORK_ID = /^\d{6}$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))[A-Za-z0-9._/-]+$/u;
const APPROVAL_PROJECTION_FIELDS = [
  'id',
  'type',
  'status',
  'target',
  'target_mode',
  'answer',
  'approved_at',
] as const;

type CandidateFailureCode =
  | 'CANDIDATE_REGISTRY_INVALID'
  | 'CANDIDATE_DUPLICATE'
  | 'CANDIDATE_PATH_UNSAFE'
  | 'CANDIDATE_APPROVAL_INVALID'
  | 'CANDIDATE_APPROVAL_CONFLICT'
  | 'F004_APPROVAL_MISMATCH';

export class BatchCandidateError extends Error {
  constructor(
    public readonly code: CandidateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'BatchCandidateError';
  }
}

export interface BatchCandidateRegistryWork {
  readonly workId: string;
  readonly title: string;
  readonly order: number;
  readonly cardUrl: string;
  readonly xhtmlUrl: string;
}

export interface ApprovalBindingDocument {
  readonly path: WorkspaceRelativePath;
  readonly sha256: Sha256;
}

export interface CandidateApprovalBindingV1 {
  readonly queueId: string;
  readonly approvalItemSha256: Sha256;
  readonly documents: readonly ApprovalBindingDocument[];
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
}

export interface CandidateApprovalBindingV2 {
  readonly queueIds: readonly string[];
  readonly approvalItemSha256s: Readonly<Record<string, Sha256>>;
  readonly documents: readonly ApprovalBindingDocument[];
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
}

export type CandidateApprovalBinding = CandidateApprovalBindingV1 | CandidateApprovalBindingV2;

export interface ApprovedBatchCandidateDefinition {
  readonly batchId: string;
  readonly feature: string;
  readonly author: BatchAuthor;
  readonly works: readonly BatchCandidateRegistryWork[];
  readonly approvalBinding: CandidateApprovalBinding;
}

export interface BatchCandidateRegistry {
  readonly schemaVersion: '1.0.0';
  readonly candidates: readonly ApprovedBatchCandidateDefinition[];
}

export interface LoadedBatchCandidateProjection {
  readonly __brand: 'LoadedBatchCandidateProjection';
  readonly feature: BatchId;
  readonly registrySha256: Sha256;
  readonly candidate: ApprovedBatchCandidateDefinition;
}

export interface VerifiedClosedApproval {
  readonly __brand: 'VerifiedClosedApproval';
  /** F003互換用。複数承認では静的policy上の先頭承認を表す。 */
  readonly queueId: string;
  readonly queueSha256: Sha256;
  /** F003互換用。複数承認では静的policy上の先頭承認を表す。 */
  readonly approvalItemSha256: Sha256;
  readonly queueIds: readonly string[];
  readonly approvalItemSha256s: Readonly<Record<string, Sha256>>;
  readonly feature: string;
  readonly target: WorkspaceRelativePath;
  readonly targets: readonly WorkspaceRelativePath[];
  readonly documents: readonly ApprovalBindingDocument[];
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
}

const verifiedClosedApprovals = new WeakSet<object>();

export interface VerifiedBatchDefinition {
  readonly __brand: 'VerifiedBatchDefinition';
  readonly ref: WorkspaceRelativePath;
  readonly sha256: Sha256;
  readonly batchId: BatchId;
  readonly feature: BatchId;
  readonly candidateRegistryPath: 'content/batch-candidates.json';
  readonly author: BatchAuthor;
  readonly workIds: readonly string[];
  readonly works: readonly BatchCandidateRegistryWork[];
  readonly authorExpectation: 'introduce' | 'reuse';
}

export interface VerifiedApprovalBindingPolicy {
  readonly __brand: 'VerifiedApprovalBindingPolicy';
  readonly ref: WorkspaceRelativePath;
  readonly sha256: Sha256;
  readonly feature: BatchId;
}

export interface ApprovedBatchContext {
  readonly __brand: 'ApprovedBatchContext';
  readonly candidate: ApprovedBatchCandidateDefinition;
  readonly definition: VerifiedBatchDefinition;
  readonly policy: VerifiedApprovalBindingPolicy;
  readonly approval: VerifiedClosedApproval;
}

export interface ExistingAuthorIdentity {
  readonly __brand: 'ExistingAuthorIdentity';
  readonly author: BatchAuthor;
  readonly introducedByBatchId: BatchId;
}

const verifiedBatchDefinitions = new WeakSet<object>();
const verifiedApprovalPolicies = new WeakSet<object>();
const approvedBatchContexts = new WeakSet<object>();
const existingAuthorIdentities = new WeakSet<object>();
const loadedBatchCandidateProjections = new WeakSet<object>();

export type CandidateValidationResult =
  | { readonly ok: true; readonly value: BatchCandidateRegistry }
  | { readonly ok: false; readonly code: CandidateFailureCode; readonly message: string };

export interface BindingEvidenceLocator {
  readonly path: WorkspaceRelativePath;
  readonly sha256: Sha256;
}

interface ApprovalBindingEvidenceV1 {
  readonly schemaVersion: '1.0.0';
  readonly feature: string;
  readonly queueId: string;
  readonly queuePath: 'queue.yaml';
  readonly queueSha256AtMigration: Sha256;
  readonly approvalProjectionFields: readonly string[];
  readonly approvalItemSha256: Sha256;
  readonly documents: readonly ApprovalBindingDocument[];
  readonly changes: readonly {
    readonly id: string;
    readonly level: string;
    readonly status: string;
  }[];
  readonly migratedAt: string;
}

interface ApprovalBindingEvidenceV2 {
  readonly schemaVersion: '1.1.0';
  readonly feature: string;
  readonly queuePath: 'queue.yaml';
  readonly queueSha256AtMigration: Sha256;
  readonly approvalProjectionFields: readonly string[];
  readonly approvals: readonly {
    readonly queueId: string;
    readonly approvalItemSha256: Sha256;
  }[];
  readonly documents: readonly ApprovalBindingDocument[];
  readonly changes: readonly {
    readonly id: string;
    readonly level: string;
    readonly status: string;
  }[];
  readonly migratedAt: string;
}

type ApprovalBindingEvidence = ApprovalBindingEvidenceV1 | ApprovalBindingEvidenceV2;

interface ApprovalPolicy {
  readonly feature: string;
  readonly authorExpectation: 'introduce' | 'reuse';
  readonly author?: BatchAuthor;
  readonly evidencePath: WorkspaceRelativePath;
  readonly evidenceSchemaVersion: '1.0.0' | '1.1.0';
  readonly approvals: readonly {
    readonly queueId: string;
    readonly target: WorkspaceRelativePath;
    readonly targetMode: 'document' | 'reference';
  }[];
  readonly documents: readonly {
    readonly path: WorkspaceRelativePath;
    readonly frontmatter: Readonly<Record<string, string>>;
  }[];
  readonly changes: readonly {
    readonly id: string;
    readonly level: string;
    readonly status: string;
  }[];
  readonly existingFeatureIds: readonly BatchId[];
}

/**
 * Callerがrequired state・path・authorExpectation相当を差し替えられないよう、
 * production codeが所有する固定ポリシーからだけ承認契約を選ぶ。
 * @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @ut UT-F004-001
 */
const APPROVAL_POLICIES = Object.freeze({
  F003: Object.freeze({
    feature: 'F003',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F003-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.0.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-017',
        target: 'docs/srs/SRS-F003.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F003.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F003', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F003.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F003', status: 'Approved' }),
      }),
    ]),
    changes: Object.freeze([
      Object.freeze({ id: 'CHG-F003-001', level: 'testspec', status: 'done' }),
    ]),
    existingFeatureIds: Object.freeze(['F001', 'F002'] as BatchId[]),
  }),
  F004: Object.freeze({
    feature: 'F004',
    authorExpectation: 'reuse',
    author: Object.freeze({
      authorId: '000081',
      identitySha256: 'f7b658e3729e6adb3bba4ac11a0ba2657779ab21e84e47f467db244adf6b1bac' as Sha256,
      name: 'みやざわずんじ',
      originalName: '宮沢賢治',
      slug: 'miyazawa-zunji',
    }),
    evidencePath: 'docs/evidence/requirements/F004-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.1.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-022',
        target: 'docs/srs/SRS-F004.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
      Object.freeze({
        queueId: 'Q-023',
        target: 'docs/changes/CHG-F004-001.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F004.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F004', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F004.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F004', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/changes/CHG-F004-001.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({
          id: 'CHG-F004-001',
          feature: 'F004',
          level: 'requirement',
          status: 'in-review',
        }),
      }),
    ]),
    changes: Object.freeze([
      Object.freeze({ id: 'CHG-F004-001', level: 'requirement', status: 'in-review' }),
    ]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003'] as BatchId[]),
  }),
  /**
   * F005はrequirement snapshot専用registryから共有registryへ互換移行する。
   * production contextのmintはf005-context.tsが内部取得する三段階controlだけが行う。
   * @des DES-F005-001 @des DES-F005-012 @fun FUN-F005-001 @fun FUN-F005-045
   * @fun FUN-F005-048 @ut UT-F005-001 @ut UT-F005-045 @ut UT-F005-048
   */
  F005: Object.freeze({
    feature: 'F005',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F005-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.1.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-027',
        target: 'docs/srs/SRS-F005.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
      Object.freeze({
        queueId: 'Q-028',
        target: 'docs/changes/CHG-F005-001.md' as WorkspaceRelativePath,
        targetMode: 'reference',
      }),
      Object.freeze({
        queueId: 'Q-029',
        target: 'docs/changes/CHG-F005-001.md' as WorkspaceRelativePath,
        targetMode: 'reference',
      }),
      Object.freeze({
        queueId: 'Q-030',
        target: 'docs/changes/CHG-F005-001.md' as WorkspaceRelativePath,
        targetMode: 'reference',
      }),
      Object.freeze({
        queueId: 'Q-031',
        target: 'docs/changes/CHG-F005-001.md' as WorkspaceRelativePath,
        targetMode: 'reference',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F005.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F005', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F005.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F005', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/changes/CHG-F005-001.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({
          id: 'CHG-F005-001',
          feature: 'F005',
          level: 'requirement',
          status: 'in-review',
        }),
      }),
    ]),
    changes: Object.freeze([
      Object.freeze({ id: 'CHG-F005-001', level: 'requirement', status: 'in-review' }),
    ]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003', 'F004'] as BatchId[]),
  }),
  /**
   * F006はF004型の静的descriptor経路を採用する（DD-F006.md FUN-F006-001確定記載）。
   * F005のETW/native guard機構・三段階controlは使わない。
   * @des DES-F006-001 @fun FUN-F006-001 @ut UT-F006-001
   */
  F006: Object.freeze({
    feature: 'F006',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F006-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.0.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-059',
        target: 'docs/srs/SRS-F006.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F006.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F006', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F006.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F006', status: 'Approved' }),
      }),
    ]),
    changes: Object.freeze([]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003', 'F004', 'F005'] as BatchId[]),
  }),
  /**
   * F007はF006と同じくF004型の静的descriptor経路を採用する（DD-F007.md FUN-F007-001確定記載）。
   * @des DES-F007-001 @fun FUN-F007-001 @ut UT-F007-001
   */
  F007: Object.freeze({
    feature: 'F007',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F007-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.0.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-062',
        target: 'docs/srs/SRS-F007.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F007.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F007', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F007.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F007', status: 'Approved' }),
      }),
    ]),
    changes: Object.freeze([]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003', 'F004', 'F005', 'F006'] as BatchId[]),
  }),
  /**
   * F008はF006/F007と同じくF004型の静的descriptor経路を採用する（DD-F008.md FUN-F008-001確定記載）。
   * @des DES-F008-001 @fun FUN-F008-001 @ut UT-F008-001
   */
  F008: Object.freeze({
    feature: 'F008',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F008-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.0.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-065',
        target: 'docs/srs/SRS-F008.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F008.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F008', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F008.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F008', status: 'Approved' }),
      }),
    ]),
    changes: Object.freeze([]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003', 'F004', 'F005', 'F006', 'F007'] as BatchId[]),
  }),
  /**
   * F009はF006〜F008と同じくF004型の静的descriptor経路を採用する（DD-F009.md FUN-F009-001確定記載）。
   * @des DES-F009-001 @fun FUN-F009-001 @ut UT-F009-001
   */
  F009: Object.freeze({
    feature: 'F009',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F009-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.0.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-068',
        target: 'docs/srs/SRS-F009.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F009.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F009', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F009.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F009', status: 'Approved' }),
      }),
    ]),
    changes: Object.freeze([]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003', 'F004', 'F005', 'F006', 'F007', 'F008'] as BatchId[]),
  }),
  /**
   * F010はF006〜F009と同じくF004型の静的descriptor経路を採用する（DD-F010.md FUN-F010-001確定記載）。
   * @des DES-F010-001 @fun FUN-F010-001 @ut UT-F010-001
   */
  F010: Object.freeze({
    feature: 'F010',
    authorExpectation: 'introduce',
    evidencePath: 'docs/evidence/requirements/F010-approval-binding.json' as WorkspaceRelativePath,
    evidenceSchemaVersion: '1.0.0',
    approvals: Object.freeze([
      Object.freeze({
        queueId: 'Q-069',
        target: 'docs/srs/SRS-F010.md' as WorkspaceRelativePath,
        targetMode: 'document',
      }),
    ]),
    documents: Object.freeze([
      Object.freeze({
        path: 'docs/srs/SRS-F010.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F010', status: 'Approved' }),
      }),
      Object.freeze({
        path: 'docs/tests/qt/QT-F010.md' as WorkspaceRelativePath,
        frontmatter: Object.freeze({ feature: 'F010', status: 'Approved' }),
      }),
    ]),
    changes: Object.freeze([]),
    existingFeatureIds: Object.freeze(['F001', 'F002', 'F003', 'F004', 'F005', 'F006', 'F007', 'F008', 'F009'] as BatchId[]),
  }),
} satisfies Readonly<Record<string, ApprovalPolicy>>);

export const BATCH_DEFINITION_REFS = Object.freeze({
  F003: Object.freeze({
    ref: 'content/batch-definitions/F003.json' as WorkspaceRelativePath,
    sha256: 'f673f70680d0f67a64facd8b141dfeef5e8f64cd0a2128a6e3d5d36eb7d8a97f' as Sha256,
  }),
  F004: Object.freeze({
    ref: 'content/batch-definitions/F004.json' as WorkspaceRelativePath,
    sha256: 'cdf88fdee3b844812a6ae78be60a2161e6afb97f28bdbae10c4daa797012701b' as Sha256,
  }),
  F006: Object.freeze({
    ref: 'content/batch-definitions/F006.json' as WorkspaceRelativePath,
    sha256: '8c2e0b6301e3702aef40163a0853dba6699a64ae6397baebfd4de4abbbce539a' as Sha256,
  }),
  F007: Object.freeze({
    ref: 'content/batch-definitions/F007.json' as WorkspaceRelativePath,
    sha256: '642155a21800f332759a4c52d28a99edbee4336e59a9e5a766d786607bcb9bbe' as Sha256,
  }),
  F008: Object.freeze({
    ref: 'content/batch-definitions/F008.json' as WorkspaceRelativePath,
    sha256: '3e9dd563b0a761cdcbff5bb707e499b809338f661fd31ce303d37d40d838deb7' as Sha256,
  }),
  F009: Object.freeze({
    ref: 'content/batch-definitions/F009.json' as WorkspaceRelativePath,
    sha256: '81507155667c9b2717c8762d2d6644087489c3773cfc30e94de01c4d3d56b066' as Sha256,
  }),
  F010: Object.freeze({
    ref: 'content/batch-definitions/F010.json' as WorkspaceRelativePath,
    sha256: '5f5aa8d1383a44f1b7e6646afd7c09feb6cb0d1ac47bb18b52a669b9ca3c7e31' as Sha256,
  }),
});

export const APPROVAL_POLICY_REFS = Object.freeze({
  F003: Object.freeze({
    ref: 'content/approval-policies/F003.json' as WorkspaceRelativePath,
    sha256: 'e33b3ab1dd36fd09aa39759c36602ba861a260a6d6ff227ccf4c73b424a3d6df' as Sha256,
  }),
  F004: Object.freeze({
    ref: 'content/approval-policies/F004.json' as WorkspaceRelativePath,
    sha256: '549e925c441e832fef1ac2a98bbe87bf46424f6cab8944ff2861f4144041ccbf' as Sha256,
  }),
  F006: Object.freeze({
    ref: 'content/approval-policies/F006.json' as WorkspaceRelativePath,
    sha256: '1df1e5e99e874748af4be930f3c3055399ba507f845fe43921d1a14a85b0dee2' as Sha256,
  }),
  F007: Object.freeze({
    ref: 'content/approval-policies/F007.json' as WorkspaceRelativePath,
    sha256: '6fb0a04799801b0f51471b7b0f6d8ddb664897558cd42bbf0bf8bf44512b742a' as Sha256,
  }),
  F008: Object.freeze({
    ref: 'content/approval-policies/F008.json' as WorkspaceRelativePath,
    sha256: '1a24caae0c35b716dfdda27ced672f41a2933e5abe9aefa0279cc9150e29f3db' as Sha256,
  }),
  F009: Object.freeze({
    ref: 'content/approval-policies/F009.json' as WorkspaceRelativePath,
    sha256: '99d754352c416f8cef0511af96d0c1b47ab770ebc5b2ca0e2c58b84c4b0e527c' as Sha256,
  }),
  F010: Object.freeze({
    ref: 'content/approval-policies/F010.json' as WorkspaceRelativePath,
    sha256: '22d464875129fa5930163e12c4d183ee4f60219dfccb6f5bd6f18974b189a5fd' as Sha256,
  }),
});
function hash(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
}

function isSha(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256.test(value);
}

function isSafePath(value: unknown): value is WorkspaceRelativePath {
  return typeof value === 'string' && SAFE_PATH.test(value) &&
    value.split('/').every((component) => component !== '' && component !== '.' && component !== '..');
}

function canonicalHttps(value: unknown, kind: 'card' | 'xhtml'): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.aozora.gr.jp' || url.port ||
      url.username || url.password || url.search || url.hash) return false;
    return kind === 'card'
      ? /^\/cards\/\d{6}\/card\d+\.html$/u.test(url.pathname)
      : /^\/cards\/\d{6}\/files\/[A-Za-z0-9_-]+\.html$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function authorIdentity(author: Omit<BatchAuthor, 'identitySha256'>): Sha256 {
  return hash(canonicalJson(author));
}

function validateAuthor(value: unknown): value is BatchAuthor {
  if (!isRecord(value) ||
    !exactKeys(value, ['authorId', 'name', 'originalName', 'slug', 'identitySha256']) ||
    typeof value.authorId !== 'string' || !AUTHOR_ID.test(value.authorId) ||
    !isText(value.name) || !isText(value.originalName) ||
    typeof value.slug !== 'string' || !SLUG.test(value.slug) || !isSha(value.identitySha256)) return false;
  return value.identitySha256 === authorIdentity({
    authorId: value.authorId,
    name: value.name,
    originalName: value.originalName,
    slug: value.slug,
  });
}

function approvalPolicyForFeature(feature: unknown): ApprovalPolicy | null {
  if (typeof feature !== 'string' || !Object.hasOwn(APPROVAL_POLICIES, feature)) return null;
  return APPROVAL_POLICIES[feature as keyof typeof APPROVAL_POLICIES];
}

function approvalPolicyForEvidencePath(path: unknown): ApprovalPolicy | null {
  if (!isSafePath(path)) return null;
  return Object.values(APPROVAL_POLICIES).find((policy) => policy.evidencePath === path) ?? null;
}

function validateCandidateAuthor(value: unknown, policy: ApprovalPolicy): value is BatchAuthor {
  if (policy.authorExpectation === 'introduce') return validateAuthor(value);
  return validateAuthorShape(value) && policy.author !== undefined &&
    canonicalJson(value) === canonicalJson(policy.author);
}

function validateAuthorShape(value: unknown): value is BatchAuthor {
  return isRecord(value) &&
    exactKeys(value, ['authorId', 'name', 'originalName', 'slug', 'identitySha256']) &&
    typeof value.authorId === 'string' && AUTHOR_ID.test(value.authorId) &&
    isText(value.name) && isText(value.originalName) &&
    typeof value.slug === 'string' && SLUG.test(value.slug) && isSha(value.identitySha256);
}

function validateDocuments(
  value: unknown,
  policy: ApprovalPolicy,
): value is readonly ApprovalBindingDocument[] {
  if (!Array.isArray(value) || value.length !== policy.documents.length) return false;
  const paths = new Set<string>();
  for (const document of value) {
    if (!isRecord(document) || !exactKeys(document, ['path', 'sha256']) ||
      !isSafePath(document.path) || !isSha(document.sha256) || paths.has(document.path)) return false;
    paths.add(document.path);
  }
  return policy.documents.every((document) => paths.has(document.path)) &&
    canonicalJson(value.map((document) => (document as ApprovalBindingDocument).path)) ===
      canonicalJson(policy.documents.map((document) => document.path));
}

function validateApprovalBinding(
  value: unknown,
  policy: ApprovalPolicy,
): value is CandidateApprovalBinding {
  if (!isRecord(value) || value.evidenceRef !== policy.evidencePath ||
    !isSha(value.evidenceSha256) || !validateDocuments(value.documents, policy)) return false;
  if (policy.evidenceSchemaVersion === '1.0.0') {
    return exactKeys(value, [
      'queueId', 'approvalItemSha256', 'documents', 'evidenceRef', 'evidenceSha256',
    ]) &&
      value.queueId === policy.approvals[0]?.queueId && isSha(value.approvalItemSha256);
  }
  if (!exactKeys(value, [
    'queueIds', 'approvalItemSha256s', 'documents', 'evidenceRef', 'evidenceSha256',
  ]) || !Array.isArray(value.queueIds) || !isRecord(value.approvalItemSha256s)) return false;
  const expectedIds = policy.approvals.map((approval) => approval.queueId);
  const approvalItemSha256s = value.approvalItemSha256s;
  return canonicalJson(value.queueIds) === canonicalJson(expectedIds) &&
    exactKeys(approvalItemSha256s, expectedIds) &&
    expectedIds.every((queueId) => isSha(approvalItemSha256s[queueId]));
}

function validateWork(value: unknown): value is BatchCandidateRegistryWork {
  return isRecord(value) && exactKeys(value, ['workId', 'title', 'order', 'cardUrl', 'xhtmlUrl']) &&
    typeof value.workId === 'string' && WORK_ID.test(value.workId) && isText(value.title) &&
    Number.isSafeInteger(value.order) && (value.order as number) >= 1 &&
    canonicalHttps(value.cardUrl, 'card') && canonicalHttps(value.xhtmlUrl, 'xhtml');
}

/** @des DES-F003-001 @fun FUN-F003-001 @ut UT-F003-001 */
export function validateBatchCandidateRegistry(value: unknown): CandidateValidationResult {
  const fail = (code: CandidateFailureCode, message: string): CandidateValidationResult =>
    Object.freeze({ ok: false, code, message });
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'candidates']) ||
    value.schemaVersion !== '1.0.0' || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    return fail('CANDIDATE_REGISTRY_INVALID', 'candidate registryのtop-level schemaが不正です');
  }
  const batchIds = new Set<string>();
  const features = new Set<string>();
  for (const candidate of value.candidates) {
    const policy = isRecord(candidate) ? approvalPolicyForFeature(candidate.feature) : null;
    if (!isRecord(candidate) ||
      !exactKeys(candidate, ['batchId', 'feature', 'author', 'works', 'approvalBinding']) ||
      typeof candidate.batchId !== 'string' || !BATCH_ID.test(candidate.batchId) ||
      typeof candidate.feature !== 'string' || candidate.feature !== candidate.batchId ||
      policy === null ||
      !validateCandidateAuthor(candidate.author, policy) ||
      !Array.isArray(candidate.works) || candidate.works.length !== 3 ||
      !candidate.works.every(validateWork) || !validateApprovalBinding(candidate.approvalBinding, policy)) {
      return fail('CANDIDATE_REGISTRY_INVALID', 'candidateのexact schemaまたはidentityが不正です');
    }
    if (batchIds.has(candidate.batchId) || features.has(candidate.feature) ||
      new Set(candidate.works.map((work) => work.workId)).size !== 3) {
      return fail('CANDIDATE_DUPLICATE', 'batch、feature、work IDは一意である必要があります');
    }
    const works = candidate.works as unknown as readonly BatchCandidateRegistryWork[];
    const ordered = [...works].sort((left, right) => left.order - right.order);
    if (ordered.some((work, index) => work.order !== index + 1) ||
      ordered.some((work, index) => work !== works[index])) {
      return fail('CANDIDATE_REGISTRY_INVALID', 'work orderは配列順の1〜3である必要があります');
    }
    batchIds.add(candidate.batchId);
    features.add(candidate.feature);
  }
  return Object.freeze({
    ok: true,
    value: structuredClone(value) as unknown as BatchCandidateRegistry,
  });
}

/** @des DES-F003-001 @fun FUN-F003-001 @ut UT-F003-001 */
export async function writeBatchCandidateRegistryAtomic(
  workspace: string,
  registryPath: WorkspaceRelativePath,
  value: unknown,
  expectedSha: Sha256 | null,
): Promise<Sha256> {
  if (registryPath !== 'content/batch-candidates.json') {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'candidate registry pathがcanonical pathではありません');
  }
  const validated = validateBatchCandidateRegistry(value);
  if (!validated.ok) throw new BatchCandidateError(validated.code, validated.message);
  const target = join(workspace, ...registryPath.split('/'));
  const current = await fingerprintArtifact(target);
  let currentSha: Sha256 | null = null;
  try {
    currentSha = hash(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (currentSha !== expectedSha) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'candidate registryのexpected SHAが一致しません');
  }
  await writeJsonArtifactAtomic(workspace, target, validated.value, { expectedFingerprint: current });
  const written = await readFile(target);
  const expected = canonicalJson(validated.value);
  if (written.toString('utf8') !== expected) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'candidate registryのpost-read検証に失敗しました');
  }
  return hash(written);
}

async function verifiedWorkspaceFile(workspace: string, path: WorkspaceRelativePath): Promise<string> {
  if (!isAbsolute(workspace) || !isSafePath(path)) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'workspaceまたはpathが不正です');
  }
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'workspace実体が不正です');
  }
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'pathがworkspace外です');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', 'pathにreparse/symbolic linkがあります');
    }
  }
  const info = await lstat(target);
  if (!info.isFile() || await realpath(target) !== target) {
    throw new BatchCandidateError('CANDIDATE_PATH_UNSAFE', '対象がcanonical regular fileではありません');
  }
  return target;
}

function parseYamlSequence(raw: string): readonly unknown[] {
  const document = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'queue YAMLが厳密に解析できません');
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(value) || !exactKeys(value, ['items']) || !Array.isArray(value.items)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'queueはitemsだけを持つmappingである必要があります');
  }
  return value.items;
}

function approvalProjection(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(APPROVAL_PROJECTION_FIELDS.map((field) => [field, item[field]]));
}

function approvalFailureCode(policy: ApprovalPolicy): CandidateFailureCode {
  return policy.feature === 'F004' ? 'F004_APPROVAL_MISMATCH' : 'CANDIDATE_APPROVAL_INVALID';
}

function validateEvidenceChanges(value: unknown, policy: ApprovalPolicy): boolean {
  return Array.isArray(value) && value.length === policy.changes.length &&
    value.every((change) => isRecord(change) && exactKeys(change, ['id', 'level', 'status'])) &&
    canonicalJson(value) === canonicalJson(policy.changes);
}

function parseBindingEvidence(value: unknown, policy: ApprovalPolicy): ApprovalBindingEvidence {
  const common =
    isRecord(value) &&
    value.feature === policy.feature &&
    value.queuePath === 'queue.yaml' &&
    isSha(value.queueSha256AtMigration) &&
    Array.isArray(value.approvalProjectionFields) &&
    canonicalJson(value.approvalProjectionFields) === canonicalJson(APPROVAL_PROJECTION_FIELDS) &&
    validateDocuments(value.documents, policy) &&
    validateEvidenceChanges(value.changes, policy) &&
    typeof value.migratedAt === 'string' &&
    Number.isFinite(Date.parse(value.migratedAt));
  if (!common) {
    throw new BatchCandidateError(approvalFailureCode(policy), 'approval binding evidenceが不正です');
  }
  if (policy.evidenceSchemaVersion === '1.0.0') {
    const keys = [
      'schemaVersion', 'feature', 'queueId', 'queuePath', 'queueSha256AtMigration',
      'approvalProjectionFields', 'approvalItemSha256', 'documents', 'changes', 'migratedAt',
    ];
    if (!exactKeys(value, keys) || value.schemaVersion !== '1.0.0' ||
      value.queueId !== policy.approvals[0]?.queueId || !isSha(value.approvalItemSha256)) {
      throw new BatchCandidateError(approvalFailureCode(policy), '単一approval binding evidenceが不正です');
    }
    return value as unknown as ApprovalBindingEvidenceV1;
  }
  const keys = [
    'schemaVersion', 'feature', 'queuePath', 'queueSha256AtMigration',
    'approvalProjectionFields', 'approvals', 'documents', 'changes', 'migratedAt',
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== '1.1.0' || !Array.isArray(value.approvals) ||
    value.approvals.length !== policy.approvals.length ||
    !value.approvals.every((approval) =>
      isRecord(approval) &&
      exactKeys(approval, ['queueId', 'approvalItemSha256']) &&
      typeof approval.queueId === 'string' &&
      isSha(approval.approvalItemSha256)) ||
    canonicalJson(value.approvals.map((approval) => (approval as { queueId: string }).queueId)) !==
      canonicalJson(policy.approvals.map((approval) => approval.queueId))) {
    throw new BatchCandidateError(approvalFailureCode(policy), '複数approval binding evidenceが不正です');
  }
  return value as unknown as ApprovalBindingEvidenceV2;
}

function hasExpectedFrontmatter(
  raw: string,
  expected: Readonly<Record<string, string>>,
): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match?.[1]) return false;
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) return false;
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  return isRecord(value) &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

/**
 * Canonical evidence refから静的policyを選び、全承認と文書実体を再検算する。
 * @des DES-F003-001 @fun FUN-F003-002 @ut UT-F003-002
 * @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @ut UT-F004-001
 */
export async function loadAndVerifyClosedApproval(
  workspace: string,
  queuePath: WorkspaceRelativePath,
  expectedQueueSha: Sha256,
  bindingEvidence: BindingEvidenceLocator,
): Promise<VerifiedClosedApproval> {
  const policy = approvalPolicyForEvidencePath(bindingEvidence.path);
  if (queuePath !== 'queue.yaml' || !isSha(expectedQueueSha) ||
    policy === null || !isSha(bindingEvidence.sha256)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'approval loaderの入力が不正です');
  }
  const queueFile = await verifiedWorkspaceFile(workspace, queuePath);
  const queueRaw = await readFile(queueFile, 'utf8');
  const queueSha = hash(queueRaw);
  if (queueSha !== expectedQueueSha) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'queue全体SHAがexpected値と一致しません');
  }
  const evidenceFile = await verifiedWorkspaceFile(workspace, bindingEvidence.path);
  const evidenceRaw = await readFile(evidenceFile, 'utf8');
  if (hash(evidenceRaw) !== bindingEvidence.sha256) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'binding evidence SHAが一致しません');
  }
  let evidenceValue: unknown;
  try {
    evidenceValue = JSON.parse(evidenceRaw) as unknown;
  } catch {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'binding evidence JSONが不正です');
  }
  if (evidenceRaw !== canonicalJson(evidenceValue)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'binding evidenceがcanonical JSONではありません');
  }
  const evidence = parseBindingEvidence(evidenceValue, policy);
  const queue = parseYamlSequence(queueRaw);
  const evidenceApprovals = evidence.schemaVersion === '1.0.0'
    ? [{ queueId: evidence.queueId, approvalItemSha256: evidence.approvalItemSha256 }]
    : evidence.approvals;
  const approvalHashes: Record<string, Sha256> = {};
  const targets: WorkspaceRelativePath[] = [];
  for (const approvalPolicy of policy.approvals) {
    const evidenceApproval = evidenceApprovals.find(
      (approval) => approval.queueId === approvalPolicy.queueId,
    );
    const matches = queue.filter((item) => isRecord(item) && item.id === approvalPolicy.queueId);
    if (!evidenceApproval || matches.length !== 1 || !isRecord(matches[0])) {
      throw new BatchCandidateError(
        approvalFailureCode(policy),
        `${approvalPolicy.queueId}が一意に存在しません`,
      );
    }
    const item = matches[0];
    // 2026-08-20制定の自動承認方針により、品質条件を満たした自動承認は
    // answer: '承認（自動）' + approval_answer_normalized: '承認' で記録される。
    // 人手承認の answer: '承認' 単独とあわせて、どちらも承認済みとして扱う。
    const isApproved = item.answer === '承認' || item.approval_answer_normalized === '承認';
    if (item.type !== 'approval' || item.status !== 'closed' ||
      item.target !== approvalPolicy.target || item.target_mode !== approvalPolicy.targetMode ||
      !isApproved || typeof item.approved_at !== 'string' ||
      !Number.isFinite(Date.parse(item.approved_at))) {
      throw new BatchCandidateError(
        approvalFailureCode(policy),
        `${approvalPolicy.queueId}は要求されたclosed document approvalではありません`,
      );
    }
    const projectionSha = hash(canonicalJson(approvalProjection(item)));
    if (projectionSha !== evidenceApproval.approvalItemSha256) {
      throw new BatchCandidateError(
        policy.feature === 'F004' ? 'F004_APPROVAL_MISMATCH' : 'CANDIDATE_APPROVAL_CONFLICT',
        `${approvalPolicy.queueId} canonical projection SHAが一致しません`,
      );
    }
    approvalHashes[approvalPolicy.queueId] = projectionSha;
    targets.push(approvalPolicy.target);
  }
  for (const document of evidence.documents) {
    const documentPolicy = policy.documents.find((entry) => entry.path === document.path);
    if (!documentPolicy) {
      throw new BatchCandidateError(approvalFailureCode(policy), `未許可文書です: ${document.path}`);
    }
    const documentFile = await verifiedWorkspaceFile(workspace, document.path);
    const raw = await readFile(documentFile, 'utf8');
    if (!hasExpectedFrontmatter(raw, documentPolicy.frontmatter) || hash(raw) !== document.sha256) {
      throw new BatchCandidateError(
        policy.feature === 'F004' ? 'F004_APPROVAL_MISMATCH' : 'CANDIDATE_APPROVAL_CONFLICT',
        `承認文書SHAまたはstateが一致しません: ${document.path}`,
      );
    }
  }
  const firstApproval = policy.approvals[0];
  if (!firstApproval) {
    throw new BatchCandidateError(approvalFailureCode(policy), '承認policyが空です');
  }
  const verified = Object.freeze({
    __brand: 'VerifiedClosedApproval',
    queueId: firstApproval.queueId,
    queueSha256: queueSha,
    approvalItemSha256: approvalHashes[firstApproval.queueId] as Sha256,
    queueIds: Object.freeze(policy.approvals.map((approval) => approval.queueId)),
    approvalItemSha256s: Object.freeze({ ...approvalHashes }),
    feature: evidence.feature,
    target: firstApproval.target,
    targets: Object.freeze(targets),
    documents: Object.freeze(evidence.documents.map((document) => Object.freeze({ ...document }))),
    evidenceRef: bindingEvidence.path,
    evidenceSha256: bindingEvidence.sha256,
  });
  verifiedClosedApprovals.add(verified);
  return verified;
}

function sameDocuments(left: readonly ApprovalBindingDocument[], right: readonly ApprovalBindingDocument[]): boolean {
  const ordered = (value: readonly ApprovalBindingDocument[]) =>
    [...value].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return canonicalJson(ordered(left)) === canonicalJson(ordered(right));
}

function sameApprovalBinding(
  binding: CandidateApprovalBinding,
  approval: VerifiedClosedApproval,
  policy: ApprovalPolicy,
): boolean {
  const common = binding.evidenceRef === approval.evidenceRef &&
    binding.evidenceSha256 === approval.evidenceSha256 &&
    sameDocuments(binding.documents, approval.documents);
  if (!common) return false;
  if (policy.evidenceSchemaVersion === '1.0.0') {
    return 'queueId' in binding &&
      binding.queueId === approval.queueId &&
      binding.approvalItemSha256 === approval.approvalItemSha256;
  }
  return 'queueIds' in binding &&
    canonicalJson(binding.queueIds) === canonicalJson(approval.queueIds) &&
    canonicalJson(binding.approvalItemSha256s) === canonicalJson(approval.approvalItemSha256s);
}

/**
 * Verified approvalと候補bindingの完全一致後だけgeneric templateへ変換する。
 * @des DES-F003-001 @fun FUN-F003-003 @ut UT-F003-003
 * @des DES-F004-001 @fun FUN-F004-001 @fun FUN-F004-005 @ut UT-F004-001 @ut UT-F004-005
 */
export function selectApprovedBatchCandidateAndCreateTemplate(
  registryValue: unknown,
  approval: VerifiedClosedApproval,
  feature: BatchId,
  gateRefs: BatchApprovalGateRefs,
): BatchManifest {
  if (feature !== 'F003') {
    throw new BatchCandidateError(
      'CANDIDATE_APPROVAL_INVALID',
      'F004以降はApprovedBatchContext経路だけを使用できます',
    );
  }
  const registry = validateBatchCandidateRegistry(registryValue);
  if (!registry.ok) throw new BatchCandidateError(registry.code, registry.message);
  const policy = approvalPolicyForFeature(feature);
  if (!isRecord(approval) || !verifiedClosedApprovals.has(approval) ||
    approval.__brand !== 'VerifiedClosedApproval' ||
    approval.feature !== feature || policy === null ||
    !isSha(approval.approvalItemSha256) || !isSha(approval.evidenceSha256) ||
    canonicalJson(approval.queueIds) !==
      canonicalJson(policy.approvals.map((policyApproval) => policyApproval.queueId))) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'verified approvalがfeatureと一致しません');
  }
  const candidates = registry.value.candidates.filter((candidate) => candidate.feature === feature);
  if (candidates.length !== 1) {
    throw new BatchCandidateError('CANDIDATE_DUPLICATE', 'featureに対する承認候補が一意ではありません');
  }
  const candidate = candidates[0];
  if (!candidate || candidate.batchId !== feature ||
    !sameApprovalBinding(candidate.approvalBinding, approval, policy)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_CONFLICT', 'candidate approval bindingが検証済み承認と一致しません');
  }
  return createNextBatchTemplate({
    candidateId: candidate.batchId,
    approved: true,
    author: candidate.author,
    works: candidate.works.map((work) => ({ workId: work.workId, title: work.title })),
    approvalGateRefs: gateRefs,
    existingFeatureIds: policy.existingFeatureIds,
  }, feature);
}

function descriptorFeature(
  definitionRef: WorkspaceRelativePath,
  expectedDefinitionSha: Sha256,
  policyRef: WorkspaceRelativePath,
  expectedPolicySha: Sha256,
): keyof typeof APPROVAL_POLICIES {
  const feature = (Object.keys(BATCH_DEFINITION_REFS) as Array<keyof typeof BATCH_DEFINITION_REFS>)
    .find((key) => BATCH_DEFINITION_REFS[key].ref === definitionRef);
  if (!feature ||
    BATCH_DEFINITION_REFS[feature].sha256 !== expectedDefinitionSha ||
    APPROVAL_POLICY_REFS[feature].ref !== policyRef ||
    APPROVAL_POLICY_REFS[feature].sha256 !== expectedPolicySha) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'definition/policy refとexpected SHAがallowlist外です');
  }
  return feature;
}

function policyDescriptor(policy: ApprovalPolicy): unknown {
  return {
    approvals: policy.approvals.map((approval) => ({
      queueId: approval.queueId,
      target: approval.target,
      targetMode: approval.targetMode,
    })),
    changes: policy.changes.map((change) => ({ ...change })),
    documents: policy.documents.map((document) => ({
      frontmatter: { ...document.frontmatter },
      path: document.path,
    })),
    evidencePath: policy.evidencePath,
    evidenceSchemaVersion: policy.evidenceSchemaVersion,
    existingFeatureIds: [...policy.existingFeatureIds],
    feature: policy.feature,
    queuePath: 'queue.yaml',
    schemaVersion: '1.0.0',
  };
}

function parseCanonicalDescriptor(raw: string, code: CandidateFailureCode): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BatchCandidateError(code, `descriptor JSONが不正です: ${String(error)}`);
  }
  if (raw !== canonicalJson(value)) {
    throw new BatchCandidateError(code, 'descriptorはcanonical JSONである必要があります');
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

/**
 * canonical definition/policyと全原artifactを再読込し、production loaderだけが3 brandをmintする。
 * @des DES-F004-001 @des DES-F004-011 @fun FUN-F004-001 @ut UT-F004-001
 */
export async function loadAndVerifyBatchCandidate(
  workspace: string,
  definitionRef: WorkspaceRelativePath,
  expectedDefinitionSha: Sha256,
  policyRef: WorkspaceRelativePath,
  expectedPolicySha: Sha256,
): Promise<ApprovedBatchContext> {
  const feature = descriptorFeature(
    definitionRef,
    expectedDefinitionSha,
    policyRef,
    expectedPolicySha,
  );
  const policySource = APPROVAL_POLICIES[feature];
  const [definitionFile, policyFile] = await Promise.all([
    verifiedWorkspaceFile(workspace, definitionRef),
    verifiedWorkspaceFile(workspace, policyRef),
  ]);
  const [definitionRaw, policyRaw] = await Promise.all([
    readFile(definitionFile, 'utf8'),
    readFile(policyFile, 'utf8'),
  ]);
  if (hash(definitionRaw) !== expectedDefinitionSha || hash(policyRaw) !== expectedPolicySha) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'definition/policy descriptor SHAが一致しません');
  }
  const definitionValue = parseCanonicalDescriptor(definitionRaw, 'CANDIDATE_REGISTRY_INVALID');
  const policyValue = parseCanonicalDescriptor(policyRaw, 'F004_APPROVAL_MISMATCH');
  if (!isRecord(definitionValue) ||
    !exactKeys(definitionValue, [
      'authorExpectation', 'batchId', 'candidateRegistryPath', 'feature', 'schemaVersion', 'works',
    ]) ||
    definitionValue.schemaVersion !== '1.0.0' ||
    definitionValue.batchId !== feature || definitionValue.feature !== feature ||
    definitionValue.candidateRegistryPath !== 'content/batch-candidates.json' ||
    definitionValue.authorExpectation !== policySource.authorExpectation ||
    !Array.isArray(definitionValue.works) || definitionValue.works.length !== 3 ||
    definitionValue.works.some((work) => !validateWork(work)) ||
    new Set(definitionValue.works.map((work) => (work as BatchCandidateRegistryWork).workId)).size !== 3 ||
    canonicalJson(policyValue) !== canonicalJson(policyDescriptor(policySource))) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'definition/policy descriptor schemaが不正です');
  }

  const registryFile = await verifiedWorkspaceFile(workspace, 'content/batch-candidates.json' as WorkspaceRelativePath);
  const registryRaw = await readFile(registryFile, 'utf8');
  const registryValue = parseCanonicalDescriptor(registryRaw, 'CANDIDATE_REGISTRY_INVALID');
  const registry = validateBatchCandidateRegistry(registryValue);
  if (!registry.ok) throw new BatchCandidateError(registry.code, registry.message);
  const candidates = registry.value.candidates.filter((candidate) => candidate.feature === feature);
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate ||
    canonicalJson(candidate.works) !== canonicalJson(definitionValue.works) ||
    candidate.batchId !== definitionValue.batchId ||
    candidate.feature !== definitionValue.feature ||
    (policySource.authorExpectation === 'reuse' &&
      (!policySource.author || canonicalJson(candidate.author) !== canonicalJson(policySource.author)))) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'candidateがverified definitionと一致しません');
  }

  const queueFile = await verifiedWorkspaceFile(workspace, 'queue.yaml' as WorkspaceRelativePath);
  const queueSha = hash(await readFile(queueFile));
  const evidenceRef = candidate.approvalBinding.evidenceRef;
  const evidenceSha = candidate.approvalBinding.evidenceSha256;
  const approval = await loadAndVerifyClosedApproval(
    workspace,
    'queue.yaml' as WorkspaceRelativePath,
    queueSha,
    { path: evidenceRef, sha256: evidenceSha },
  );
  if (!sameApprovalBinding(candidate.approvalBinding, approval, policySource)) {
    throw new BatchCandidateError('F004_APPROVAL_MISMATCH', 'candidateとverified approval policyが一致しません');
  }

  const definition = freezeDeep({
    __brand: 'VerifiedBatchDefinition' as const,
    ref: definitionRef,
    sha256: expectedDefinitionSha,
    batchId: feature as BatchId,
    feature: feature as BatchId,
    candidateRegistryPath: 'content/batch-candidates.json' as const,
    author: structuredClone(candidate.author),
    workIds: definitionValue.works.map((work) => (work as BatchCandidateRegistryWork).workId),
    works: structuredClone(definitionValue.works) as BatchCandidateRegistryWork[],
    authorExpectation: policySource.authorExpectation,
  });
  const verifiedPolicy = freezeDeep({
    __brand: 'VerifiedApprovalBindingPolicy' as const,
    ref: policyRef,
    sha256: expectedPolicySha,
    feature: feature as BatchId,
  });
  verifiedBatchDefinitions.add(definition);
  verifiedApprovalPolicies.add(verifiedPolicy);
  const context = freezeDeep({
    __brand: 'ApprovedBatchContext' as const,
    candidate: structuredClone(candidate),
    definition,
    policy: verifiedPolicy,
    approval,
  });
  approvedBatchContexts.add(context);
  return context;
}

/**
 * 共有registryの実production parserを通し、一意なfeature projectionを返す。
 * Approval contextはmintせず、registry migrationのloader回帰にも同じlogicを使う。
 * @des DES-F003-001 @des DES-F004-001 @des DES-F005-001
 * @fun FUN-F003-001 @fun FUN-F004-001 @fun FUN-F005-048
 * @ut UT-F003-001 @ut UT-F004-001 @ut UT-F005-048
 */
export async function loadBatchCandidateRegistryProjection(
  workspace: string,
  feature: BatchId,
): Promise<LoadedBatchCandidateProjection> {
  if (approvalPolicyForFeature(feature) === null) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', '未登録featureです');
  }
  const registryFile = await verifiedWorkspaceFile(workspace, 'content/batch-candidates.json' as WorkspaceRelativePath);
  const raw = await readFile(registryFile, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'candidate registry JSONが不正です');
  }
  if (raw !== canonicalJson(value)) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'candidate registryがcanonical JSONではありません');
  }
  const checked = validateBatchCandidateRegistry(value);
  if (!checked.ok) throw new BatchCandidateError(checked.code, checked.message);
  const matches = checked.value.candidates.filter((candidate) => candidate.feature === feature);
  const candidate = matches[0];
  if (matches.length !== 1 || !candidate) {
    throw new BatchCandidateError('CANDIDATE_DUPLICATE', 'feature candidateが一意ではありません');
  }
  const projection = freezeDeep({
    __brand: 'LoadedBatchCandidateProjection' as const,
    feature,
    registrySha256: hash(raw),
    candidate: structuredClone(candidate),
  });
  loadedBatchCandidateProjections.add(projection);
  return projection;
}

export function isMintedLoadedBatchCandidateProjection(
  value: unknown,
): value is LoadedBatchCandidateProjection {
  return isRecord(value) && loadedBatchCandidateProjections.has(value) &&
    value.__brand === 'LoadedBatchCandidateProjection';
}

/**
 * Mint済みcontextからだけbatch templateを作成し、caller object経路を閉じる。
 * @des DES-F004-001 @fun FUN-F004-005 @ut UT-F004-005
 */
export function createBatchManifestFromApprovedContext(
  context: ApprovedBatchContext,
  gateRefs: BatchApprovalGateRefs,
): BatchManifest {
  if (!isRecord(context) || !approvedBatchContexts.has(context) ||
    context.__brand !== 'ApprovedBatchContext' ||
    !verifiedBatchDefinitions.has(context.definition) ||
    !verifiedApprovalPolicies.has(context.policy)) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'production loaderがmintしたcontextが必要です');
  }
  const policy = approvalPolicyForFeature(context.definition.feature);
  if (policy === null) {
    throw new BatchCandidateError('CANDIDATE_APPROVAL_INVALID', 'context featureに対応するpolicyがありません');
  }
  return createNextBatchTemplate({
    candidateId: context.candidate.batchId,
    approved: true,
    author: context.candidate.author,
    works: context.candidate.works.map((work) => ({ workId: work.workId, title: work.title })),
    approvalGateRefs: gateRefs,
    existingFeatureIds: policy.existingFeatureIds,
  }, context.definition.feature);
}

export function isMintedApprovedBatchContext(value: unknown): value is ApprovedBatchContext {
  return isRecord(value) && approvedBatchContexts.has(value) &&
    value.__brand === 'ApprovedBatchContext' &&
    isRecord(value.definition) && isRecord(value.policy) &&
    verifiedBatchDefinitions.has(value.definition) &&
    verifiedApprovalPolicies.has(value.policy);
}

/** @des DES-F004-011 @fun FUN-F004-021 @ut UT-F004-021 */
export function isMintedVerifiedBatchDefinition(value: unknown): value is VerifiedBatchDefinition {
  return isRecord(value) && verifiedBatchDefinitions.has(value) &&
    value.__brand === 'VerifiedBatchDefinition';
}

/**
 * reuse definitionを公開baseline Catalogのexact 1作者へ結合する。
 * @des DES-F004-001 @des DES-F004-007 @fun FUN-F004-004 @ut UT-F004-004
 */
export function verifyExistingAuthorIdentity(
  context: ApprovedBatchContext,
  catalog: CatalogV2,
): ExistingAuthorIdentity {
  if (!isRecord(context) || !approvedBatchContexts.has(context) ||
    context.definition.authorExpectation !== 'reuse' ||
    !isRecord(catalog) || !Array.isArray(catalog.authors)) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'reuse作者検証入力が不正です');
  }
  const matches = catalog.authors.filter((author) => author.authorId === context.candidate.author.authorId);
  const author = matches[0];
  if (matches.length !== 1 || !author ||
    canonicalJson({
      authorId: author.authorId,
      identitySha256: author.identitySha256,
      name: author.name,
      originalName: author.originalName,
      slug: author.slug,
    }) !== canonicalJson(context.candidate.author) ||
    typeof author.introducedByBatchId !== 'string' || !BATCH_ID.test(author.introducedByBatchId)) {
    throw new BatchCandidateError('CANDIDATE_REGISTRY_INVALID', 'F004_AUTHOR_IDENTITY_CONFLICT');
  }
  const verified = freezeDeep({
    __brand: 'ExistingAuthorIdentity' as const,
    author: structuredClone(context.candidate.author),
    introducedByBatchId: author.introducedByBatchId as BatchId,
  });
  existingAuthorIdentities.add(verified);
  return verified;
}
