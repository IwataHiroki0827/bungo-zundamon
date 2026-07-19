import { isValidatedLicenseManifest } from './release-notices';
import { resolveTrustedExternalLink } from './trusted-links';
import type { CreditsCatalog, LicenseManifest, TrustedExternalLink } from './types';

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
