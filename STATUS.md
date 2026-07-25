---
phase: testspec
feature: F003
updated: 2026-07-26T04:06:23+09:00
next_actions:
  - "T-036でdocs/tests/ut/UT-F003.mdを作成し、FUN-F003-001〜029の境界値・異常系を定義する"
  - "T-036でdocs/tests/it/IT-F003.mdを作成し、DES-F003-001〜012とQT-F003の結合シナリオを定義する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0としてGitHub Pagesへ公開・クローズ済み。公開サイトは2作者・6作品・213台詞で安定稼働中。
- F003は太宰治「女生徒」「走れメロス」「グッド・バイ」を小さい作業単位から順に追加する。
- SRS-F003、QT-F003、FD-F003、DD-F003はApproved。要求ゲート①と設計ゲート②を通過した。
- 設計はREQ 18件→DES 12件→FUN 29件を欠落なく追跡し、整合性・実現性・セキュリティの最終独立レビューが全てHigh/Medium/Low 0件となった。
- T-036のtestspecフェーズを開始した。

## 直近の作業（最新5件）

- F003要求仕様・QT仕様をApprovedにし、T-034〜T-044へWBS分解
- F002 v0.2.0をF003 immutable baselineの固定信頼起点へ設定
- F002固定のauthor/artwork/route条件をmanifest・catalog駆動へ再設計
- 独立編集authorization、Catalog 2.1 notice、machine画像review、容量・atomic・release契約を設計
- 3観点の反復レビュー指摘を全件解消し、設計ゲート②を通過

## 次のアクション

- T-036で`docs/tests/ut/UT-F003.md`を作成し、FUN 29件の正常・境界・異常系を定義する。
- T-036で`docs/tests/it/IT-F003.md`を作成し、DES 12件の結合、path、crash recovery、release chainを定義する。
- テスト仕様レビュー後、実装開始前の承認ゲート③へ進む。

## 未解決事項

- C:は空き率が低い警告域にあるため、F003音声生成前にdisk-guardを再実行する。
- `content/batch-candidates.json`とF003 approval bindingの最終artifact SHAはT-037で固定する。
