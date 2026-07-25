---
feature: F003
reviewed_at: 2026-07-26
result: PASS
---

# F003 設計レビュー結果

## 最終判定

承認可。整合性・実現性・セキュリティの各独立レビューは、最終的にHigh 0件、Medium 0件、Low 0件となった。

## 対象

- `docs/design/FD-F003.md`（DES 12件）
- `docs/design/DD-F003.md`（FUN 29件）
- `docs/srs/SRS-F003.md`（REQ 18件）
- `docs/tests/qt/QT-F003.md`（QT 15件）

## 主な修正

- F002 v0.2.0のrelease commit、catalog/content/dist SHAをF001/F002不変性の固定信頼起点にした。
- F002固定のauthor、artwork、4 route条件をmanifest/catalog駆動へ汎用化した。
- Catalog 2.1.0へ汎用`completionStatus/notices[]`を追加し、loaderから作品一覧・作品画面・creditsまでの表示経路を定義した。
- 独立編集判定をProjectFactoryの別agentへ委譲し、trusted `ReviewRunAuthorization`、primary非開示、create-new seal、authorization再利用拒否を定義した。
- caller作成のPASSを信用せず、canonical artifactをproduction validatorで再読込・再計算する受入境界へ改めた。
- 単一候補profile、VOICEVOX config、5区分容量、作品単位atomic受入のexact型・path・境界を固定した。
- F002のrelease tuple exact keysを維持し、route set digestを`ReleaseRuntimeArtifact` 2.0.0 payload SHAへ結合した。
- ArtworkProvenance 2.0.0はread-only互換、F003の3.0.0はtrusted machine reviewを必須とした。
- SSRF、GitHub Actions SHA pin、credential非永続化、offline build、external link、secret scanのF002安全契約を維持した。

## トレーサビリティ

REQ 18件→DES 12件→FUN 29件は欠落0件である。`trace_check.py --feature F003 --no-impl`の残り12件はDES→UT/ITであり、設計後のT-036で作成する計画済み差分である。

## 変更管理

`CHG-F003-001`でQT-F003-005/007/009/012の試験oracleを明確化した。要求の製品範囲・閾値は変更していない。既存UT/IT/実装は未作成のため再実施対象はなく、新規fixture作成をT-036へ引き継ぐ。
