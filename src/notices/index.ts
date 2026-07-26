export { CreditsRenderError, renderCredits, renderCreditsV2 } from './credits';
export { loadReleaseNoticeBundle } from './manifest-loader';
export {
  assertArtworkProvenanceMatches,
  artworkCreditFromProvenance,
  validateArtworkProvenanceBundle,
  type ArtworkCreditManifest,
  type ArtworkProvenanceBundle,
} from './artwork-bundle';
export { isValidatedLicenseManifest, validateReleaseNotices } from './release-notices';
export { resolveTrustedExternalLink } from './trusted-links';
export { WORK_NOTICE_TEXT, type WorkNoticeTextKey } from './work-notice-text';
export { REQUIRED_NOTICE_TEXT } from './types';
export type {
  ArtworkInput,
  ArtworkProvenanceManifest,
  CreditsCatalog,
  LicenseExternalLink,
  LicenseManifest,
  LinkPurpose,
  NoticeValidationIssue,
  TrustedExternalLink,
  ValidationResult,
} from './types';
export type { ValidatedNoticeBundle } from './manifest-loader';
