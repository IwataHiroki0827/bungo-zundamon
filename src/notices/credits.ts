import { isValidatedLicenseManifest } from './release-notices';
import { resolveTrustedExternalLink } from './trusted-links';
import { REQUIRED_NOTICE_TEXT } from './types';
import { WORK_NOTICE_TEXT } from './work-notice-text';
import { formatDisplayProofreader, type UICatalogV2 } from '../ui/types';
import type { ValidatedNoticeBundle } from './manifest-loader';
import type { CreditsCatalog, LicenseManifest, TrustedExternalLink } from './types';

const SHA256 = /^[a-f\d]{64}$/iu;

export class CreditsRenderError extends Error {
  constructor(public readonly code:
    | 'CREDITS_WORK_MISSING'
    | 'CREDITS_PROVENANCE_MISSING'
    | 'CREDITS_POLICY_STALE'
    | 'CREDITS_ARTWORK_MISMATCH') {
    super(code);
    this.name = 'CreditsRenderError';
  }
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function externalAnchor(label: string, link: TrustedExternalLink): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.textContent = label;
  anchor.href = link.href;
  anchor.target = link.target;
  anchor.rel = link.rel;
  return anchor;
}

function listItem(label: string, link?: TrustedExternalLink): HTMLLIElement {
  const item = document.createElement('li');
  item.append(link ? externalAnchor(label, link) : document.createTextNode(label));
  return item;
}

/** @des DES-F001-012,DES-F001-018 @fun FUN-F001-026 */
export function renderCredits(catalog: CreditsCatalog, licenseManifest: LicenseManifest): HTMLElement {
  if (!isValidatedLicenseManifest(licenseManifest)) {
    throw new TypeError('検証済みのLicenseManifestだけをクレジットへ描画できます');
  }
  if (!Array.isArray(catalog.works) || catalog.works.length !== 3) {
    throw new TypeError('クレジット用catalogには初期公開3作品が必要です');
  }
  for (const work of catalog.works) {
    const required = [
      work.title,
      work.cardLink,
      work.source?.cardUrl,
      work.source?.attribution,
      work.source?.baseEdition,
      work.source?.inputter,
      work.source?.proofreader,
      work.source?.fetchedAt,
      work.source?.transformation,
    ];
    if (required.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError('作品の由来情報が欠落しています');
    }
  }

  const page = document.createElement('article');
  page.className = 'credits-page';
  page.dataset.page = 'credits';
  page.append(textElement('h1', 'クレジット・出典・利用条件'));

  const required = document.createElement('section');
  required.append(textElement('h2', 'このサイトについて'));
  const notices = document.createElement('ul');
  notices.append(
    listItem(licenseManifest.notices.voicevox),
    listItem(licenseManifest.notices.unofficial),
    listItem(licenseManifest.notices.service),
    listItem(licenseManifest.notices.privacy),
    listItem(licenseManifest.notices.contactPolicy),
    listItem(licenseManifest.notices.jurisdiction),
  );
  required.append(notices);

  const sources = document.createElement('section');
  sources.append(textElement('h2', '作品の出典'));
  const sourceList = document.createElement('ul');
  for (const work of catalog.works) {
    const cardUrl = work.source.cardUrl;
    const label = `${work.title} — ${work.source.attribution}／底本: ${work.source.baseEdition}／入力者: ${work.source.inputter}／校正者: ${work.source.proofreader}／取得日: ${work.source.fetchedAt}／加工内容: ${work.source.transformation}`;
    sourceList.append(
      listItem(label, resolveTrustedExternalLink(cardUrl, 'aozora-card')),
    );
  }
  sources.append(sourceList);

  const bibliography = document.createElement('section');
  bibliography.append(textElement('h2', '青空文庫の書誌データ'));
  bibliography.append(
    textElement('p', licenseManifest.bibliographyLicense.attribution),
    textElement('p', licenseManifest.bibliographyLicense.changeNotice),
    textElement('p', 'CC BY 4.0の表示は書誌データだけに適用され、作品本文には適用されません。'),
    externalAnchor(
      licenseManifest.bibliographyLicense.name,
      resolveTrustedExternalLink(licenseManifest.bibliographyLicense.url, 'cc-by-4.0'),
    ),
  );

  const credits = document.createElement('section');
  credits.append(textElement('h2', '素材・ソフトウェア'));
  const creditList = document.createElement('ul');
  for (const link of licenseManifest.externalLinks) {
    creditList.append(listItem(link.label, resolveTrustedExternalLink(link.url, link.purpose)));
  }
  for (const dependency of licenseManifest.dependencies) {
    creditList.append(
      listItem(
        `${dependency.name} — ${dependency.notice}`,
        resolveTrustedExternalLink(dependency.link.url, dependency.link.purpose),
      ),
    );
  }
  creditList.append(
    listItem(`素材README版: ${licenseManifest.materials.readmeVersion}`),
    listItem(`素材README SHA-256: ${licenseManifest.materials.readmeSha256}`),
    listItem('サムネイル制作：坂本アヒル氏「ずんだもん立ち絵素材V3.2」基本版を許諾条件内で改変'),
    listItem('編集元素材の配布版・取得日・archive/PSD/README hashと加工内容を画像由来manifestに記録しています。'),
    listItem('特定の芥川龍之介写真は使用していません。'),
    listItem('元PSDは公開物に同梱していません。'),
  );
  credits.append(creditList);

  const confirmation = document.createElement('section');
  confirmation.append(
    textElement('h2', '規約確認'),
    textElement('p', `確認日時: ${licenseManifest.terms.checkedAt}`),
    textElement('p', `確認者: ${licenseManifest.terms.reviewer}`),
    externalAnchor('確認した利用規約', resolveTrustedExternalLink(licenseManifest.terms.url, 'sss')),
  );

  page.append(required, sources, bibliography, credits, confirmation);
  return page;
}

function requireCreditText(value: unknown, code: CreditsRenderError['code']): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CreditsRenderError(code);
  return value;
}

function validateCreditsV2Inputs(catalog: UICatalogV2, notices: ValidatedNoticeBundle): void {
  if (!notices || !isValidatedLicenseManifest(notices.license)) {
    throw new CreditsRenderError('CREDITS_PROVENANCE_MISSING');
  }
  if (!catalog || !Array.isArray(catalog.authors) || catalog.authors.length === 0 ||
      !Array.isArray(catalog.works) || catalog.works.length === 0) {
    throw new CreditsRenderError('CREDITS_WORK_MISSING');
  }

  const authorById = new Map<string, UICatalogV2['authors'][number]>();
  for (const author of catalog.authors) {
    requireCreditText(author.authorId, 'CREDITS_WORK_MISSING');
    requireCreditText(author.name, 'CREDITS_WORK_MISSING');
    requireCreditText(author.originalName, 'CREDITS_WORK_MISSING');
    if (authorById.has(author.authorId)) throw new CreditsRenderError('CREDITS_WORK_MISSING');
    authorById.set(author.authorId, author);
  }

  const representedAuthors = new Set<string>();
  for (const work of catalog.works) {
    const author = authorById.get(requireCreditText(work.authorId, 'CREDITS_WORK_MISSING'));
    if (!author) throw new CreditsRenderError('CREDITS_WORK_MISSING');
    representedAuthors.add(author.authorId);
    requireCreditText(work.workId, 'CREDITS_WORK_MISSING');
    requireCreditText(work.title, 'CREDITS_WORK_MISSING');
    const source = work.source;
    for (const value of [
      source?.cardUrl,
      source?.attribution,
      source?.baseEdition,
      source?.inputter,
      source?.fetchedAt,
      source?.transformation,
      source?.provenancePath,
      source?.provenanceSha256,
    ]) requireCreditText(value, 'CREDITS_PROVENANCE_MISSING');
    if (work.batchId === 'F005' && work.workId === '000799') {
      if (source.proofreader !== null) throw new CreditsRenderError('CREDITS_PROVENANCE_MISSING');
    } else {
      requireCreditText(source.proofreader, 'CREDITS_PROVENANCE_MISSING');
    }
    if (!SHA256.test(source.provenanceSha256)) throw new CreditsRenderError('CREDITS_PROVENANCE_MISSING');
    try {
      resolveTrustedExternalLink(source.cardUrl, 'aozora-card');
      if (work.cardLink !== source.cardUrl) throw new Error('card-url-mismatch');
    } catch {
      throw new CreditsRenderError('CREDITS_PROVENANCE_MISSING');
    }
  }
  if (representedAuthors.size !== authorById.size) throw new CreditsRenderError('CREDITS_WORK_MISSING');

  const terms = notices.license.terms;
  // CHG-F002-005/CHG-F002-006: 規約再確認の「期限」という概念を廃止した。
  // 実質的な再確認はF005 predeployが担う。規約本文を公開直前に再取得し、
  // 選定時snapshotとSHA-256を突き合わせ、変化していればF005_SOURCE_DRIFTで
  // 公開を止める。暦の経過ではなく規約そのものの変化を見る方が強い。
  // checkedAtは「いつ確認したか」の表示用記録として形式だけ検査する。
  const checkedAt = Date.parse(requireCreditText(terms?.checkedAt, 'CREDITS_POLICY_STALE'));
  if (!Number.isFinite(checkedAt)) {
    throw new CreditsRenderError('CREDITS_POLICY_STALE');
  }
  try {
    resolveTrustedExternalLink(terms.url, 'sss');
  } catch {
    throw new CreditsRenderError('CREDITS_POLICY_STALE');
  }
  if (
    notices.license.notices.voicevox !== REQUIRED_NOTICE_TEXT.voicevox ||
    notices.license.notices.unofficial !== REQUIRED_NOTICE_TEXT.unofficial ||
    notices.license.notices.jurisdiction !== REQUIRED_NOTICE_TEXT.jurisdiction ||
    notices.license.commercial.advertising !== false
  ) throw new CreditsRenderError('CREDITS_POLICY_STALE');

  if (!Array.isArray(notices.artworks)) {
    // F001旧treeの単一manifest互換。複数作者では集約manifestを必須にする。
    if (catalog.authors.length !== 1 || !notices.artwork?.output ||
      notices.artwork.output.path !== catalog.authors[0]!.artwork.path ||
      notices.artwork.output.sha256 !== catalog.authors[0]!.artwork.sha256) {
      throw new CreditsRenderError('CREDITS_ARTWORK_MISMATCH');
    }
    return;
  }
  if (notices.artworks.length !== catalog.authors.length) throw new CreditsRenderError('CREDITS_ARTWORK_MISMATCH');
  const artworkByAuthor = new Map(notices.artworks.map((entry) => [entry.authorId, entry]));
  if (artworkByAuthor.size !== notices.artworks.length) throw new CreditsRenderError('CREDITS_ARTWORK_MISMATCH');
  for (const author of catalog.authors) {
    const entry = artworkByAuthor.get(author.authorId);
    if (!entry || entry.batchId !== author.introducedByBatchId ||
      !SHA256.test(author.artwork.sha256) ||
      entry.output.path !== author.artwork.path || entry.output.sha256 !== author.artwork.sha256) {
      throw new CreditsRenderError('CREDITS_ARTWORK_MISMATCH');
    }
  }
}

/** @des DES-F002-009 DES-F002-010 DES-F002-012 DES-F002-013 @fun FUN-F002-025 */
export function renderCreditsV2(catalog: UICatalogV2, notices: ValidatedNoticeBundle): HTMLElement {
  validateCreditsV2Inputs(catalog, notices);
  const license = notices.license;
  const authorById = new Map(catalog.authors.map((author) => [author.authorId, author]));
  const page = document.createElement('article');
  page.className = 'credits-page';
  page.dataset.page = 'credits';
  page.append(textElement('h1', 'クレジット・出典・利用条件'));

  const site = document.createElement('section');
  site.append(textElement('h2', 'このサイトについて'));
  const siteNotices = document.createElement('ul');
  siteNotices.append(
    listItem(REQUIRED_NOTICE_TEXT.voicevox),
    listItem(REQUIRED_NOTICE_TEXT.unofficial),
    listItem('本サイトに広告・スポンサー・課金はありません。'),
    listItem(REQUIRED_NOTICE_TEXT.jurisdiction),
    listItem(license.notices.privacy),
    listItem(license.notices.contactPolicy),
  );
  site.append(siteNotices);

  const sources = document.createElement('section');
  sources.append(textElement('h2', '収録作品の出典'));
  const sourceList = document.createElement('ul');
  for (const work of catalog.works) {
    const author = authorById.get(work.authorId)!;
    const label = `${work.title} — ${author.name}（原著者: ${author.originalName}）／${work.source.attribution}／底本: ${work.source.baseEdition}／入力者: ${work.source.inputter}／校正者: ${formatDisplayProofreader(work.source.proofreader)}／取得日: ${work.source.fetchedAt}／加工内容: ${work.source.transformation}／由来証跡: ${work.source.provenancePath}（SHA-256: ${work.source.provenanceSha256}）`;
    sourceList.append(listItem(label, resolveTrustedExternalLink(work.source.cardUrl, 'aozora-card')));
    for (const notice of work.notices ?? []) {
      if (notice.placements.includes('credits')) {
        sourceList.append(listItem(`${work.title}：${WORK_NOTICE_TEXT[notice.textKey]}`));
      }
    }
  }
  sources.append(sourceList);

  const policies = document.createElement('section');
  policies.append(
    textElement('h2', '規約確認'),
    textElement('p', `確認日時: ${license.terms.checkedAt}`),
    textElement('p', `確認者: ${license.terms.reviewer}`),
    externalAnchor('確認した利用規約', resolveTrustedExternalLink(license.terms.url, 'sss')),
  );

  const bibliography = document.createElement('section');
  bibliography.append(
    textElement('h2', '青空文庫の書誌データ'),
    textElement('p', license.bibliographyLicense.attribution),
    textElement('p', license.bibliographyLicense.changeNotice),
    textElement('p', 'CC BY 4.0の表示は書誌データだけに適用され、作品本文には適用されません。'),
    externalAnchor(
      license.bibliographyLicense.name,
      resolveTrustedExternalLink(license.bibliographyLicense.url, 'cc-by-4.0'),
    ),
  );

  const artwork = document.createElement('section');
  artwork.append(textElement('h2', '作者画像の由来'));
  const artworkList = document.createElement('ul');
  for (const author of catalog.authors) {
    const credit = notices.artworks?.find((entry) => entry.authorId === author.authorId)?.credit;
    artworkList.append(listItem(
      `${author.name}: ${credit ? `${credit}／` : ''}${author.artwork.path}／SHA-256: ${author.artwork.sha256}`,
    ));
  }
  artwork.append(artworkList);

  const materials = document.createElement('section');
  materials.append(textElement('h2', '素材・ソフトウェア'));
  const materialList = document.createElement('ul');
  for (const link of license.externalLinks) {
    materialList.append(listItem(link.label, resolveTrustedExternalLink(link.url, link.purpose)));
  }
  for (const dependency of license.dependencies) {
    materialList.append(listItem(
      `${dependency.name} — ${dependency.notice}`,
      resolveTrustedExternalLink(dependency.link.url, dependency.link.purpose),
    ));
  }
  materials.append(materialList);

  page.append(site, sources, bibliography, artwork, materials, policies);
  return page;
}
