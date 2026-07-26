export const WORK_NOTICE_TEXT = Object.freeze({
  'dialogue-excerpt-scope': '本サービスは作品全文の朗読や要約ではなく、括弧で示された発話の抜粋を収録しています。',
  'official-content-warning': '青空文庫の図書カードに、今日からみれば不適切と受け取られる可能性のある表現を含む旨の注意があります。',
  unfinished: '未完',
} as const);

export type WorkNoticeTextKey = keyof typeof WORK_NOTICE_TEXT;
