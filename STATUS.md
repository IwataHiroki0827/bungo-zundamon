---
phase: implement
feature: F002
updated: 2026-07-20T13:04:00+09:00
next_actions:
  - "T-020でsrc/contentのcatalog・manifest・音声cache・公開asset統合を複数作者化する [REQ-F002-001/002/011/012/013/017/019]"
  - "T-022でF001不変照合・容量・repository・Pages・security preflightを実装する [REQ-F002-001/012/013/015/017/018/019/020]"
  - "T-023で宮沢賢治画像・規約snapshot・権利証跡を整備する [REQ-F002-004/007/015/016]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はimplementフェーズ。T-019のbatch・source・review基盤を実装し、独立受け入れPASSで完了した。
- `content:batch`実CLI、作品単位atomic昇格、実process停止回復、第三者改変隔離、review完全性検査を利用できる。

## 直近の作業（最新5件）

- `src/content/batch.ts`へmanifest schema、状態遷移、journal付きatomic保存を実装
- `src/content/batch-production.ts`へ書誌・原典・抽出・正規化の作品単位atomic処理を実装
- `src/content/processing.ts`へwork隔離・policy判断付き全件review gateを実装
- `scripts/content-cli.ts`と`src/content/batch-runtime.ts`へ`content:batch` production adapterを接続
- 型・lint・424 tests・build・npm audit・secret scanをPASSし、`docs/evidence/implement/IMPLEMENT-T-019.md`へ証跡化

## 次のアクション

- `src/content/`のcatalog、accepted manifest、音声cache、公開asset treeをT-020で複数作者対応する（REQ-F002-001/002/011/012/013/017/019）。
- T-020と並行可能な`src/content/`の容量・repository・Pages・security検査をT-022で実装する（REQ-F002-018等）。
- `content/batches/F002/`の宮沢賢治画像provenanceと4系統の規約snapshotをT-023で整備する（REQ-F002-015/016）。

## 未解決事項

- T-020〜T-027の実装タスクが未完了。
- capacity・voice・accept・buildのproduction adapterは後続タスク完了までfail-closedで停止する。
- VOICEVOX ENGINEは作品音声生成T-024前にloopback限定で起動・版照合する。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
