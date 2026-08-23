import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../content/artifacts.ts';
import { resolveTrustedExternalLink } from './trusted-links.ts';
import type { TrustedExternalLink } from './types.ts';
import { WORK_NOTICE_TEXT, type WorkNoticeTextKey } from './work-notice-text.ts';

export { WORK_NOTICE_TEXT, type WorkNoticeTextKey } from './work-notice-text.ts';
export type WorkNoticePlacement = 'work-list' | 'work-detail' | 'credits';

export interface WorkNotice {
  readonly textKey: WorkNoticeTextKey;
  readonly placements: readonly WorkNoticePlacement[];
}

export interface WorkNoticeEntry {
  readonly workId: string;
  readonly title: string;
  readonly completionStatus: 'complete' | 'unfinished';
  readonly cardUrl: string;
  readonly notices: readonly WorkNotice[];
}

export interface WorkNoticeRegistry {
  readonly schemaVersion: '1.0.0';
  readonly authorId: string;
  readonly works: readonly WorkNoticeEntry[];
}

export interface WorkNoticeSourceFact {
  readonly workId: string;
  readonly title: string;
  readonly authorId: string;
  readonly cardUrl: string;
  readonly officialContentWarning: boolean;
  readonly unfinished: boolean;
}

export interface ValidatedWorkNoticeEntry extends WorkNoticeEntry {
  readonly links: readonly TrustedExternalLink[];
  readonly renderedNotices: readonly {
    readonly textKey: WorkNoticeTextKey;
    readonly text: string;
    readonly placements: readonly WorkNoticePlacement[];
  }[];
}

export interface WorkNoticeReport {
  readonly result: 'pass';
  readonly authorId: string;
  readonly works: readonly ValidatedWorkNoticeEntry[];
}

export class WorkNoticeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorkNoticeError';
  }
}

const SAFE_ID = /^[0-9]{6}$/u;
const REQUIRED_PLACEMENTS = Object.freeze(['work-list', 'work-detail', 'credits'] as const);
const TRUSTED_REGISTRY_BINDINGS = Object.freeze({
  '000035': Object.freeze({
    path: 'content/batches/F003/work-notices.json',
    sha256: 'cca216476c56c285807c88df6ea435405066606714d016c346f47d145c5734a6',
    sourceFacts: Object.freeze([
      Object.freeze({
        workId: '000275',
        title: '女生徒',
        authorId: '000035',
        cardUrl: 'https://www.aozora.gr.jp/cards/000035/card275.html',
        officialContentWarning: true,
        unfinished: false,
      }),
      Object.freeze({
        workId: '001567',
        title: '走れメロス',
        authorId: '000035',
        cardUrl: 'https://www.aozora.gr.jp/cards/000035/card1567.html',
        officialContentWarning: false,
        unfinished: false,
      }),
      Object.freeze({
        workId: '000258',
        title: 'グッド・バイ',
        authorId: '000035',
        cardUrl: 'https://www.aozora.gr.jp/cards/000035/card258.html',
        officialContentWarning: true,
        unfinished: true,
      }),
    ] satisfies readonly WorkNoticeSourceFact[]),
  }),
  '000129': Object.freeze({
    path: 'content/batches/F007/work-notices.json',
    sha256: '231bf96587915d78cfc0a0a873312c5c995a65e414c4684ad3b34b24fb166f02',
    sourceFacts: Object.freeze([
      Object.freeze({
        workId: '058126',
        title: '舞姫',
        authorId: '000129',
        cardUrl: 'https://www.aozora.gr.jp/cards/000129/card58126.html',
        officialContentWarning: true,
        unfinished: false,
      }),
      Object.freeze({
        workId: '045245',
        title: '高瀬舟',
        authorId: '000129',
        cardUrl: 'https://www.aozora.gr.jp/cards/000129/card45245.html',
        officialContentWarning: false,
        unfinished: false,
      }),
      Object.freeze({
        workId: '000689',
        title: '山椒大夫',
        authorId: '000129',
        cardUrl: 'https://www.aozora.gr.jp/cards/000129/card689.html',
        officialContentWarning: false,
        unfinished: false,
      }),
    ] satisfies readonly WorkNoticeSourceFact[]),
  }),
  '001779': Object.freeze({
    path: 'content/batches/F008/work-notices.json',
    sha256: '2b0d5dd87a482deeac6206c46d8dd5e2ca93fc8b9fbbfe3924588e18a555c139',
    sourceFacts: Object.freeze([
      Object.freeze({
        workId: '056648',
        title: '人間椅子',
        authorId: '001779',
        cardUrl: 'https://www.aozora.gr.jp/cards/001779/card56648.html',
        officialContentWarning: true,
        unfinished: false,
      }),
      Object.freeze({
        workId: '056650',
        title: 'Ｄ坂の殺人事件',
        authorId: '001779',
        cardUrl: 'https://www.aozora.gr.jp/cards/001779/card56650.html',
        officialContentWarning: true,
        unfinished: false,
      }),
      Object.freeze({
        workId: '057193',
        title: '一人二役',
        authorId: '001779',
        cardUrl: 'https://www.aozora.gr.jp/cards/001779/card57193.html',
        officialContentWarning: false,
        unfinished: false,
      }),
    ] satisfies readonly WorkNoticeSourceFact[]),
  }),
  '000096': Object.freeze({
    path: 'content/batches/F009/work-notices.json',
    sha256: '6791b09c950bc2ba6aedaad935daa48443ef38fc82ece271e59f3edd668a1c06',
    sourceFacts: Object.freeze([
      Object.freeze({
        workId: '002381',
        title: '瓶詰地獄',
        authorId: '000096',
        cardUrl: 'https://www.aozora.gr.jp/cards/000096/card2381.html',
        officialContentWarning: true,
        unfinished: false,
      }),
      Object.freeze({
        workId: '046694',
        title: 'きのこ会議',
        authorId: '000096',
        cardUrl: 'https://www.aozora.gr.jp/cards/000096/card46694.html',
        officialContentWarning: false,
        unfinished: false,
      }),
      Object.freeze({
        workId: '002380',
        title: '死後の恋',
        authorId: '000096',
        cardUrl: 'https://www.aozora.gr.jp/cards/000096/card2380.html',
        officialContentWarning: true,
        unfinished: false,
      }),
    ] satisfies readonly WorkNoticeSourceFact[]),
  }),
} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validPlainText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512 &&
    !/[<>]/u.test(value) && ![...value].some((character) => (character.codePointAt(0) ?? 0) < 32);
}

function exactPlacements(value: unknown): value is readonly WorkNoticePlacement[] {
  return Array.isArray(value) && value.length === REQUIRED_PLACEMENTS.length &&
    REQUIRED_PLACEMENTS.every((placement) => value.includes(placement)) &&
    new Set(value).size === value.length;
}

function validateNotice(value: unknown): asserts value is WorkNotice {
  if (!isRecord(value) || !exactKeys(value, ['placements', 'textKey']) ||
    typeof value.textKey !== 'string' ||
    !Object.prototype.hasOwnProperty.call(WORK_NOTICE_TEXT, value.textKey) ||
    !exactPlacements(value.placements)) {
    throw new WorkNoticeError('WORK_NOTICE_INVALID', 'notice textKeyまたは配置matrixが不正です');
  }
}

/**
 * 作品注意・未完状態・抜粋scopeを公式図書カード由来のsource factsへ結合する。
 * @des DES-F003-009 @fun FUN-F003-023 @ut UT-F003-023
 */
export function validateWorkNoticesAndCredits(
  registryValue: unknown,
): WorkNoticeReport {
  if (!isRecord(registryValue) || !exactKeys(registryValue, ['authorId', 'schemaVersion', 'works']) ||
    registryValue.schemaVersion !== '1.0.0' || typeof registryValue.authorId !== 'string' ||
    !SAFE_ID.test(registryValue.authorId) || !Array.isArray(registryValue.works) ||
    registryValue.works.length === 0) {
    throw new WorkNoticeError('WORK_NOTICE_REGISTRY_INVALID', 'work notice registry exact schemaが不正です');
  }
  const binding = TRUSTED_REGISTRY_BINDINGS[
    registryValue.authorId as keyof typeof TRUSTED_REGISTRY_BINDINGS
  ];
  if (!binding || sha256(canonicalJson(registryValue)) !== binding.sha256) {
    throw new WorkNoticeError(
      'WORK_NOTICE_PROVENANCE_MISMATCH',
      'work notice registryがProjectFactoryの固定source bindingと一致しません',
    );
  }
  const sourceFacts: readonly WorkNoticeSourceFact[] = binding.sourceFacts;
  const entries = registryValue.works;
  const workIds = entries.map((value) => isRecord(value) ? value.workId : undefined);
  if (new Set(workIds).size !== entries.length || sourceFacts.length !== entries.length ||
    new Set(sourceFacts.map((fact) => fact.workId)).size !== sourceFacts.length) {
    throw new WorkNoticeError('WORK_NOTICE_PROVENANCE_MISMATCH', '作品集合が重複または欠落しています');
  }
  const validated = entries.map((value): ValidatedWorkNoticeEntry => {
    if (!isRecord(value) || !exactKeys(value, [
      'cardUrl', 'completionStatus', 'notices', 'title', 'workId',
    ]) || typeof value.workId !== 'string' || !SAFE_ID.test(value.workId) ||
      !validPlainText(value.title) || !['complete', 'unfinished'].includes(String(value.completionStatus)) ||
      typeof value.cardUrl !== 'string' || !Array.isArray(value.notices) || value.notices.length === 0) {
      throw new WorkNoticeError('WORK_NOTICE_INVALID', '作品notice exact schemaが不正です');
    }
    value.notices.forEach(validateNotice);
    const notices = value.notices as unknown as readonly WorkNotice[];
    const keys = notices.map((notice) => notice.textKey);
    if (new Set(keys).size !== keys.length || !keys.includes('dialogue-excerpt-scope')) {
      throw new WorkNoticeError('WORK_NOTICE_SCOPE_MISSING', '全作品に括弧発話の抜粋scopeが必要です');
    }
    const fact = sourceFacts.find((candidate) => candidate.workId === value.workId);
    if (!fact || fact.authorId !== registryValue.authorId || fact.title !== value.title ||
      fact.cardUrl !== value.cardUrl || fact.unfinished !== (value.completionStatus === 'unfinished')) {
      throw new WorkNoticeError('WORK_NOTICE_PROVENANCE_MISMATCH', '作品noticeと公式source factが一致しません');
    }
    if (fact.officialContentWarning !== keys.includes('official-content-warning') ||
      fact.unfinished !== keys.includes('unfinished')) {
      throw new WorkNoticeError('WORK_NOTICE_REQUIRED_MISSING', '公式注意または未完表示がsource factと一致しません');
    }
    const link = resolveTrustedExternalLink(value.cardUrl, 'aozora-card');
    return Object.freeze({
      workId: value.workId,
      title: value.title,
      completionStatus: value.completionStatus as 'complete' | 'unfinished',
      cardUrl: value.cardUrl,
      notices: Object.freeze(notices.map((notice) => Object.freeze({
        textKey: notice.textKey,
        placements: Object.freeze([...notice.placements]),
      }))),
      links: Object.freeze([link]),
      renderedNotices: Object.freeze(notices.map((notice) => Object.freeze({
        textKey: notice.textKey,
        text: WORK_NOTICE_TEXT[notice.textKey],
        placements: Object.freeze([...notice.placements]),
      }))),
    });
  });
  return Object.freeze({
    result: 'pass',
    authorId: registryValue.authorId,
    works: Object.freeze(validated),
  });
}

/**
 * 固定pathの正規registryだけを読み、改ざん不能な公式source bindingへ結合する。
 * @des DES-F003-009 @fun FUN-F003-023 @ut UT-F003-023
 */
export async function loadAndValidateWorkNotices(
  workspace: string,
  authorId = '000035',
): Promise<WorkNoticeReport> {
  if (!isAbsolute(workspace) || !Object.prototype.hasOwnProperty.call(TRUSTED_REGISTRY_BINDINGS, authorId)) {
    throw new WorkNoticeError('WORK_NOTICE_PROVENANCE_MISMATCH', 'workspaceまたは作者bindingが不正です');
  }
  const root = resolve(workspace);
  const binding = TRUSTED_REGISTRY_BINDINGS[authorId as keyof typeof TRUSTED_REGISTRY_BINDINGS];
  const target = resolve(root, ...binding.path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new WorkNoticeError('WORK_NOTICE_PROVENANCE_MISMATCH', 'notice registry pathがworkspace外です');
  }
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error('unsafe workspace');
    }
    let cursor = root;
    for (const part of relation.split(sep)) {
      cursor = `${cursor}${sep}${part}`;
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('reparse point');
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || await realpath(target) !== target) {
      throw new Error('unsafe registry');
    }
    const raw = await readFile(target, 'utf8');
    const value: unknown = JSON.parse(raw);
    if (raw !== canonicalJson(value) || sha256(raw) !== binding.sha256) {
      throw new Error('registry hash mismatch');
    }
    return validateWorkNoticesAndCredits(value);
  } catch (error) {
    if (error instanceof WorkNoticeError) throw error;
    throw new WorkNoticeError('WORK_NOTICE_PROVENANCE_MISMATCH', '固定notice registryを安全に検証できません');
  }
}
