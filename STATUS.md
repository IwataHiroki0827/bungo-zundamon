---
phase: implement
feature: F003
updated: 2026-07-26T15:34:44+09:00
next_actions:
  - "T-037でFUN-F003-009〜011の独立編集authorization・seal・照合・完結性をUT-F003-009〜011に従って実装する"
  - "T-037で既存F002原典取得・抽出・読み補正をFUN-F003-006〜008/012〜013へ接続する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0としてGitHub Pagesへ公開・クローズ済み。公開サイトは2作者・6作品・213台詞で安定稼働中。
- F003は太宰治「女生徒」「走れメロス」「グッド・バイ」を小さい作業単位から順に追加する。
- SRS/FD/DD/QTに加えてUT-F003・IT-F003もApproved。ゲート①〜③を通過した。
- UT 29件でFUN 29件、IT 14件でDES 12件を網羅し、独立レビュー2観点の最終結果はHigh/Medium/Low 0件、trace_check対応漏れ0となった。
- CHG-F001-006で全作者ページの収録作品を初期全閉へ変更し、単体737件・対象Playwright 5件・typecheck・lint・buildをPASSした。
- F003はT-037のimplementフェーズで、承認候補・Q-017 binding・固定F002 baseline（FUN-F003-001〜005）まで実装した。
- 現在の全自動検証はVitest 744件、typecheck、lint、buildがPASSしている。

## 直近の作業（最新5件）

- 作者route遷移・直アクセス・再読込・作者切替直後の収録作品を全件閉じるよう変更
- UT-F003 29件とIT-F003 14件を作成
- 第三裁定8/9証跡、authorization atomic seal、transport、容量、deploy冪等のレビュー指摘を全件解消
- テスト仕様ゲート③を承認済みにしF003実装へ移行
- F003候補registry・approval bindingと固定v0.2.0 Git object baselineを実装
- 生成途中descriptor混入、型、lintの不具合を修正し全744テストをPASS

## 次のアクション

- `src/content/editorial-independent.ts`で`FUN-F003-009`〜`011`を実装し、`UT-F003-009`〜`011`を追加する。
- 既存`source.ts`・`processing.ts`・`batch-production.ts`を再利用し、`FUN-F003-006`〜`008`・`012`〜`013`のF003タグと境界回帰を追加する。
- T-037は上記とacceptor PASS後にdoneへ移し、T-038へ進む。

## 未解決事項

- C:は空き率が低い警告域にあるため、F003音声生成前にdisk-guardを再実行する。
- 独立編集authorizationのsealとused遷移を同一transactionで回復する実装はT-037後半で行う。
