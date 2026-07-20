---
phase: implement
feature: F002
updated: 2026-07-20T15:54:00+09:00
next_actions:
  - "T-023で宮沢賢治画像・規約snapshot・権利証跡を整備する [REQ-F002-004/007/015/016]"
  - "T-024で「よだかの星」の全候補レビュー・音声生成・作品単位受入を実施する [REQ-F002-002/006/008/009/010/011/012/013]"
  - "T-025で残り2作品を順次受入する [REQ-F002-005/006/008/009/010/011/012/013]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はimplementフェーズ。T-019〜T-022を完了し、T-023の宮沢賢治画像・規約snapshot・権利証跡整備を開始した。
- T-022は固定F001、容量、Pages、security preflight、release検証を独立受け入れPASS済み。

## 直近の作業（最新5件）

- T-022を独立受け入れPASS（全621 tests、型・lint・build・audit合格）
- 固定raw Catalog v1と統合後publicのF001実体照合を分離
- work/releaseのPages入力をexact workspace、出力を`.cache`内一時directoryへ固定
- release-verifyへF001 content/dist invariantとrelease実容量を接続
- static/full securityを分離し、実証跡欠落時の偽PASSを禁止

## 次のアクション

- 宮沢賢治作者画像を生成し、入力0件・prompt・provider/model・出力hash・目視判断をprovenanceへ記録する。
- 青空文庫、VOICEVOX、ずんだもん、画像サービスの選定時規約snapshotと権利判断を固定する。
- T-023完了後、「よだかの星」の全候補レビューと実音声生成へ進む。

## 未解決事項

- T-023〜T-027の実装タスクが未完了。
- VOICEVOX ENGINEは作品音声生成T-024前にloopback限定で起動・版照合する。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
