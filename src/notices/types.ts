export const REQUIRED_NOTICE_TEXT = {
  voicevox: 'VOICEVOX:ずんだもん',
  unofficial: '東北ずん子・ずんだもんプロジェクトの非公式ファンサイトです',
  service: '本サイトは無料で利用でき、広告・課金はありません。',
  privacy: '入力フォーム、Cookie、アクセス解析などによる追跡は行いません。',
  jurisdiction:
    '収録作品は日本法を基準に権利状態を確認しており、日本国外での権利状態を一律に保証しません。',
} as const;

export type LinkPurpose =
  | 'aozora'
  | 'aozora-card'
  | 'cc-by-4.0'
  | 'voicevox'
  | 'sss'
  | 'artwork'
  | 'dependency';

export interface TrustedExternalLink {
  readonly href: string;
  readonly purpose: LinkPurpose;
  readonly target: '_blank';
  readonly rel: 'noopener noreferrer';
}

export interface LicenseExternalLink {
  label: string;
  purpose: LinkPurpose;
  url: string;
}

export interface ArtworkInput {
  id: string;
  sourcePage: string;
  distributionUrl: string;
  distributionVersion: string;
  downloadedAt: string;
  archiveSha256: string;
  archiveEntry: string;
  bundledReadmeSha256: string;
  sha256: string;
}

export interface ArtworkProvenanceManifest {
  schemaVersion: string;
  manifestId: string;
  creationMethod: 'authorized-source-edit';
  inputAllowlist: string[];
  inputs: ArtworkInput[];
  editorSource: string;
  transformations: string[];
  output: {
    path: string;
    sha256: string;
  };
  specificAkutagawaPhotographUsed: false;
  usesSakamotoArtworkAsInput: true;
  artistStyleImitated: false;
  reviewer: string;
  reviewedAt: string;
}

export interface LicenseManifest {
  schemaVersion: string;
  notices: {
    voicevox: string;
    unofficial: string;
    service: string;
    privacy: string;
    jurisdiction: string;
    contactPolicy: string;
  };
  bibliographyLicense: {
    name: 'CC BY 4.0';
    scope: 'bibliography-only';
    attribution: string;
    changeNotice: string;
    bodyCovered: false;
    url: string;
  };
  externalLinks: LicenseExternalLink[];
  materials: {
    readmeVersion: string;
    readmeSha256: string;
    originalPsdIncluded: false;
    artworkProvenance: {
      manifestId: string;
      outputSha256: string;
      creationMethod: 'authorized-source-edit';
      specificAkutagawaPhotographUsed: false;
      usesSakamotoArtworkAsInput: true;
      artistStyleImitated: false;
      reviewer: string;
      reviewedAt: string;
    };
  };
  dependencies: Array<{
    name: string;
    notice: string;
    link: LicenseExternalLink;
  }>;
  commercial: {
    free: true;
    advertising: false;
    payments: false;
    tracking: false;
    forms: false;
  };
  jurisdictionBasis: 'JP';
  terms: {
    url: string;
    checkedAt: string;
    validUntil: string;
    reviewer: string;
  };
}

export interface NoticeValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; success: true; value: T; issues: [] }
  | { ok: false; success: false; issues: NoticeValidationIssue[]; errors: NoticeValidationIssue[] };

export interface CreditsCatalog {
  author?: { name?: string };
  works: Array<{
    title: string;
    cardLink: string;
    source: {
      cardUrl: string;
      attribution: string;
      baseEdition: string;
      inputter: string;
      proofreader: string;
      fetchedAt: string;
      transformation: string;
    };
  }>;
}
