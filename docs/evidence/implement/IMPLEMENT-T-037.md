# T-037 F003候補・原典・独立二重レビュー契約 実装証跡

## 判定

- タスク: T-037（F003候補manifest・権利原典・独立二重レビュー契約を整備）
- 対象feature / batch: F003 / F003
- 実装判定: PASS
- 独立受け入れ判定: ACCEPT
- 最終指摘: High 0件 / Medium 0件
- 判定日: 2026-07-26

## 実装範囲

- `FUN-F003-001`〜`005`: 承認済み候補registry、Q-017 binding、F002 v0.2.0固定baselineを実装した。
- `FUN-F003-006`〜`008`: F002のproduction transport・書誌選定・原典取得・fatal charset decode・外側括弧抽出・atomic promotionをF003へ接続した。
- `FUN-F003-009`〜`011`: 独立したprimary / secondary / adjudicatorのauthorization、canonical seal、二判定照合、第三裁定、完結性判定を実装した。
- `FUN-F003-012`〜`013`: 表示文を保持する連続読み補正と、固定F002校正profileによる文字数・時間・WAV容量予測を実装した。

## 信頼境界と回復性

- closed approvalはmodule-localな検証済みobjectだけを候補選定へ渡し、自己整合した偽造approvalを拒否する。
- 編集判定はauthorization store、seal path / SHA-256、candidate・policy・prompt・tool hash、usedAt、全文candidate joinを照合する。
- crash recoveryまたはプロセス再開後は永続store / sealをcanonical JSONとして再検証し、deep-freezeしたobjectだけを信頼状態へ戻す。
- `prepared`、`old-moved`、`new-moved`、`verified`の各停止位置から、回復・secondary seal・2件再読込・reconcile成功まで確認した。
- 書誌snapshotはexact schema、公式URL、path、hash、bytes、media type、取得時刻を検証し、3作品の権利・役割・公開状態・文字遣い・URLと一致しない場合は原典取得前に停止する。
- 音声容量profileはF002の固定release、151音声source set、音声設定、PCM条件、校正誤差、artifact SHA-256を照合し、任意の自己署名profileを拒否する。

## 固定校正profile

- source release: `84c985f382910216e381a96901f6fd569165a27e`
- source set SHA-256: `0951c2da012c91d646b2a435b96ea6c7d9fa18809e84419245191114cf2605ff`
- config SHA-256: `0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691`
- profile artifact SHA-256: `f3d23c29a03d140e9203360923caaacb5a42c805990c81fe7593850559b298b0`
- sample count: 151
- observed actual bytes: 47,741,940
- observed relative error: 0.1667098945251888（上限0.20）

## 検証結果

- F003対象の独立受け入れ試験: 43 / 43 PASS
- F002再利用回帰: 180 / 180 PASS
- 全Vitest suite: 42 files / 780 tests PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS（229 files / 81,723,285 bytes）
- `trace_check --feature F003`: 対応漏れなし
- 作業ドライブ空き: 約40.5 GB（約4.3%）
- 独立T-037受け入れ: ACCEPT（High 0 / Medium 0）
