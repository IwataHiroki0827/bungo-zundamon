import { resolveTrustedExternalLink } from './trusted-links.ts';
import {
  REQUIRED_NOTICE_TEXT,
  type ArtworkProvenanceManifest,
  type LicenseManifest,
  type NoticeValidationIssue,
  type ValidationResult,
} from './types.ts';

const SHA256 = /^[a-f\d]{64}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const validatedManifests = new WeakSet<object>();

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes(':')) return false;
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function addIssue(issues: NoticeValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function validInstant(value: string): number | null {
  if (!RFC3339.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function requireText(issues: NoticeValidationIssue[], value: unknown, path: string): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(issues, 'required-text-missing', path, `${path}に空でない文字列が必要です`);
    return false;
  }
  return true;
}

function requireHash(issues: NoticeValidationIssue[], value: unknown, path: string): value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    addIssue(issues, 'invalid-sha256', path, `${path}は64桁のSHA-256 hexが必要です`);
    return false;
  }
  return true;
}

function checkRequiredNotices(manifest: LicenseManifest, issues: NoticeValidationIssue[]): void {
  for (const [key, expected] of Object.entries(REQUIRED_NOTICE_TEXT)) {
    if (manifest.notices?.[key as keyof typeof REQUIRED_NOTICE_TEXT] !== expected) {
      addIssue(issues, 'required-notice-mismatch', `notices.${key}`, '必須表示が欠落または改変されています');
    }
  }
  requireText(issues, manifest.notices?.contactPolicy, 'notices.contactPolicy');
  if (manifest.jurisdictionBasis !== 'JP') {
    addIssue(issues, 'jurisdiction-basis-invalid', 'jurisdictionBasis', '権利確認基準はJPである必要があります');
  }
  if (
    manifest.commercial?.free !== true ||
    manifest.commercial?.advertising !== false ||
    manifest.commercial?.payments !== false ||
    manifest.commercial?.tracking !== false ||
    manifest.commercial?.forms !== false
  ) {
    addIssue(issues, 'commercial-or-privacy-policy-invalid', 'commercial', '無料・広告なし・課金なし・追跡なし・フォームなしが必要です');
  }
}

function checkBibliographyLicense(manifest: LicenseManifest, issues: NoticeValidationIssue[]): void {
  const notice = manifest.bibliographyLicense;
  if (
    notice?.name !== 'CC BY 4.0' ||
    notice.scope !== 'bibliography-only' ||
    notice.bodyCovered !== false
  ) {
    addIssue(issues, 'cc-by-scope-invalid', 'bibliographyLicense', 'CC BY 4.0は書誌データだけへ適用してください');
  }
  requireText(issues, notice?.attribution, 'bibliographyLicense.attribution');
  requireText(issues, notice?.changeNotice, 'bibliographyLicense.changeNotice');
  try {
    resolveTrustedExternalLink(notice?.url ?? '', 'cc-by-4.0');
  } catch {
    addIssue(issues, 'cc-by-url-untrusted', 'bibliographyLicense.url', 'CC BY 4.0 URLがallowlist外です');
  }
}

function checkLinks(manifest: LicenseManifest, issues: NoticeValidationIssue[]): void {
  const links = [...(manifest.externalLinks ?? []), ...(manifest.dependencies ?? []).map((item) => item.link)];
  const requiredPurposes = new Set(['aozora', 'voicevox', 'sss', 'artwork']);
  const seenLinks = new Set<string>();
  for (const [index, link] of links.entries()) {
    requireText(issues, link?.label, `externalLinks[${index}].label`);
    try {
      const trusted = resolveTrustedExternalLink(link?.url ?? '', link?.purpose);
      const key = `${trusted.purpose}:${trusted.href}`;
      if (seenLinks.has(key)) {
        addIssue(issues, 'external-link-duplicate', `externalLinks[${index}]`, '同じ用途とURLの外部リンクが重複しています');
      }
      seenLinks.add(key);
      requiredPurposes.delete(link.purpose);
    } catch {
      addIssue(issues, 'external-link-untrusted', `externalLinks[${index}].url`, '外部リンクが用途別allowlist外です');
    }
  }
  for (const purpose of requiredPurposes) {
    addIssue(issues, 'required-link-missing', 'externalLinks', `必須の${purpose}リンクがありません`);
  }
  if (!(manifest.externalLinks ?? []).some((link) => link.purpose === 'artwork' && link.label === '立ち絵：坂本アヒル')) {
    addIssue(issues, 'artwork-credit-missing', 'externalLinks', '「立ち絵：坂本アヒル」の表記が必要です');
  }
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0) {
    addIssue(issues, 'dependency-notices-missing', 'dependencies', '依存物のクレジットが必要です');
  }
  for (const [index, dependency] of (manifest.dependencies ?? []).entries()) {
    requireText(issues, dependency.name, `dependencies[${index}].name`);
    requireText(issues, dependency.notice, `dependencies[${index}].notice`);
  }
}

function checkArtwork(
  manifest: LicenseManifest,
  artwork: ArtworkProvenanceManifest,
  nowTime: number,
  issues: NoticeValidationIssue[],
): void {
  requireText(issues, artwork.schemaVersion, 'artwork.schemaVersion');
  requireText(issues, artwork.manifestId, 'artwork.manifestId');
  if (artwork.creationMethod !== 'authorized-source-edit') {
    addIssue(issues, 'artwork-creation-method-invalid', 'artwork.creationMethod', '許諾済み配布素材を入力にした編集である必要があります');
  }
  if (!Array.isArray(artwork.inputAllowlist) || artwork.inputAllowlist.length === 0) {
    addIssue(issues, 'artwork-allowlist-missing', 'artwork.inputAllowlist', '画像入力allowlistが必要です');
  }
  const allowlist = new Set(artwork.inputAllowlist ?? []);
  const ids = new Set<string>();
  if (!Array.isArray(artwork.inputs) || artwork.inputs.length === 0) {
    addIssue(issues, 'artwork-input-missing', 'artwork.inputs', '画像入力とhashが必要です');
  }
  for (const [index, input] of (artwork.inputs ?? []).entries()) {
    requireText(issues, input.id, `artwork.inputs[${index}].id`);
    if (ids.has(input.id)) addIssue(issues, 'artwork-input-duplicate', `artwork.inputs[${index}].id`, '画像入力IDが重複しています');
    ids.add(input.id);
    if (!allowlist.has(input.id)) {
      addIssue(issues, 'artwork-input-not-allowed', `artwork.inputs[${index}].id`, '画像入力がallowlist外です');
    }
    try {
      resolveTrustedExternalLink(input.sourcePage ?? '', 'artwork');
    } catch {
      addIssue(issues, 'artwork-source-untrusted', `artwork.inputs[${index}].sourcePage`, '配布案内ページがallowlist外です');
    }
    if (input.distributionUrl !== 'https://ux.getuploader.com/s_ahiru/download/59') {
      addIssue(issues, 'artwork-distribution-url-invalid', `artwork.inputs[${index}].distributionUrl`, '正規配布URLが固定値と一致しません');
    }
    if (input.distributionVersion !== 'V3.2') {
      addIssue(issues, 'artwork-version-invalid', `artwork.inputs[${index}].distributionVersion`, '素材版はV3.2である必要があります');
    }
    const downloadedAt = validInstant(input.downloadedAt ?? '');
    if (downloadedAt === null || downloadedAt > nowTime) {
      addIssue(issues, 'artwork-downloaded-at-invalid', `artwork.inputs[${index}].downloadedAt`, '取得日は現在以前のRFC 3339 instantが必要です');
    }
    if (input.archiveEntry !== 'ずんだもん立ち絵素材V3.2/ずんだもん立ち絵素材V3.2_基本版.psd') {
      addIssue(issues, 'artwork-archive-entry-invalid', `artwork.inputs[${index}].archiveEntry`, '編集元PSDのarchive entryが固定値と一致しません');
    }
    requireHash(issues, input.archiveSha256, `artwork.inputs[${index}].archiveSha256`);
    requireHash(issues, input.bundledReadmeSha256, `artwork.inputs[${index}].bundledReadmeSha256`);
    requireHash(issues, input.sha256, `artwork.inputs[${index}].sha256`);
  }
  for (const [index, allowed] of (artwork.inputAllowlist ?? []).entries()) {
    if (!artwork.inputs.some((input) => input.id === allowed)) {
      addIssue(issues, 'artwork-allowlist-orphan', `artwork.inputAllowlist[${index}]`, 'allowlistに由来記録のない入力があります');
    }
  }
  if (!ids.has(artwork.editorSource)) {
    addIssue(issues, 'artwork-editor-source-unknown', 'artwork.editorSource', '編集元が画像入力を参照していません');
  }
  if (!Array.isArray(artwork.transformations) || artwork.transformations.length === 0) {
    addIssue(issues, 'artwork-transformations-missing', 'artwork.transformations', '画像の変換手順が必要です');
  } else {
    artwork.transformations.forEach((value, index) => requireText(issues, value, `artwork.transformations[${index}]`));
  }
  if (!isSafeRelativePath(artwork.output?.path ?? '')) {
    addIssue(issues, 'artwork-output-path-invalid', 'artwork.output.path', '画像出力pathは安全な相対pathが必要です');
  }
  requireHash(issues, artwork.output?.sha256, 'artwork.output.sha256');
  if (artwork.specificAkutagawaPhotographUsed !== false) {
    addIssue(issues, 'specific-photograph-used', 'artwork.specificAkutagawaPhotographUsed', '特定の芥川写真は入力・合成できません');
  }
  if (artwork.usesSakamotoArtworkAsInput !== true) {
    addIssue(issues, 'sakamoto-artwork-input-missing', 'artwork.usesSakamotoArtworkAsInput', '坂本アヒル氏の正規配布素材を編集元として明示する必要があります');
  }
  if (artwork.artistStyleImitated !== false) {
    addIssue(issues, 'artist-style-imitated', 'artwork.artistStyleImitated', '特定作家の画風を模倣した画像は使用できません');
  }
  requireText(issues, artwork.reviewer, 'artwork.reviewer');
  const reviewedAt = validInstant(artwork.reviewedAt);
  if (reviewedAt === null || reviewedAt > nowTime) {
    addIssue(issues, 'artwork-reviewed-at-invalid', 'artwork.reviewedAt', '画像確認日は過去または現在のRFC 3339 instantが必要です');
  }

  const reference = manifest.materials?.artworkProvenance;
  const referencedHash = typeof reference?.outputSha256 === 'string' ? reference.outputSha256.toLowerCase() : null;
  const artworkHash = typeof artwork.output?.sha256 === 'string' ? artwork.output.sha256.toLowerCase() : null;
  if (
    reference?.manifestId !== artwork.manifestId ||
    referencedHash === null ||
    artworkHash === null ||
    referencedHash !== artworkHash ||
    reference?.creationMethod !== artwork.creationMethod ||
    reference?.specificAkutagawaPhotographUsed !== artwork.specificAkutagawaPhotographUsed ||
    reference?.usesSakamotoArtworkAsInput !== artwork.usesSakamotoArtworkAsInput ||
    reference?.artistStyleImitated !== artwork.artistStyleImitated ||
    reference?.reviewer !== artwork.reviewer ||
    reference?.reviewedAt !== artwork.reviewedAt
  ) {
    addIssue(issues, 'artwork-reference-mismatch', 'materials.artworkProvenance', 'LicenseManifestと画像由来の参照が一致しません');
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  }
  return value;
}

/** @des DES-F001-011,DES-F001-012,DES-F001-013,DES-F001-018 @fun FUN-F001-038 */
export function validateReleaseNotices(
  manifest: LicenseManifest,
  artwork: ArtworkProvenanceManifest,
  now: Date,
): ValidationResult<LicenseManifest> {
  const issues: NoticeValidationIssue[] = [];
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) addIssue(issues, 'release-time-invalid', 'now', 'リリース判定時刻が不正です');

  requireText(issues, manifest.schemaVersion, 'schemaVersion');
  checkRequiredNotices(manifest, issues);
  checkBibliographyLicense(manifest, issues);
  checkLinks(manifest, issues);
  requireText(issues, manifest.materials?.readmeVersion, 'materials.readmeVersion');
  requireHash(issues, manifest.materials?.readmeSha256, 'materials.readmeSha256');
  if (manifest.materials?.originalPsdIncluded !== false) {
    addIssue(issues, 'original-psd-included', 'materials.originalPsdIncluded', '元PSDは公開物へ同梱できません');
  }

  try {
    resolveTrustedExternalLink(manifest.terms?.url ?? '', 'sss');
  } catch {
    addIssue(issues, 'terms-url-untrusted', 'terms.url', '規約URLがallowlist外です');
  }
  const checkedAt = validInstant(manifest.terms?.checkedAt ?? '');
  const validUntil = validInstant(manifest.terms?.validUntil ?? '');
  if (checkedAt === null) addIssue(issues, 'terms-checked-at-invalid', 'terms.checkedAt', '規約確認日はRFC 3339 instantが必要です');
  if (validUntil === null) addIssue(issues, 'terms-valid-until-invalid', 'terms.validUntil', '規約有効期限はRFC 3339 instantが必要です');
  if (checkedAt !== null && validUntil !== null && checkedAt > validUntil) {
    addIssue(issues, 'terms-period-invalid', 'terms', '規約確認日が有効期限より後です');
  }
  if (checkedAt !== null && Number.isFinite(nowTime) && checkedAt > nowTime) {
    addIssue(issues, 'terms-checked-at-future', 'terms.checkedAt', '規約確認日はリリース判定時刻以前である必要があります');
  }
  if (validUntil !== null && Number.isFinite(nowTime) && nowTime > validUntil) {
    addIssue(issues, 'terms-expired', 'terms.validUntil', '規約確認期限を超過しています');
  }
  requireText(issues, manifest.terms?.reviewer, 'terms.reviewer');
  checkArtwork(manifest, artwork, nowTime, issues);

  if (issues.length > 0) return { ok: false, success: false, issues, errors: issues };
  freezeDeep(manifest);
  validatedManifests.add(manifest);
  return { ok: true, success: true, value: manifest, issues: [] };
}

export function isValidatedLicenseManifest(value: LicenseManifest): boolean {
  return typeof value === 'object' && value !== null && validatedManifests.has(value);
}
