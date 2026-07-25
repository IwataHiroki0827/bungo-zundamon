---
phase: implement
feature: F002
updated: 2026-07-25T22:10:50+09:00
next_actions:
  - "T-027でF002最終catalog統合・F001不変・全asset整合を確認する [REQ-F002-001/002/003/004/005/011/012/013/014/015/016/017/018/020]"
  - "T-028でUT-F002を実施し、失敗を修正・再検証する [REQ-F002-001〜020]"
  - "T-029でIT・QT・実音声・ブラウザ・権利受入を実施する [REQ-F002-001〜020]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はimplementフェーズ。T-019〜T-026を完了し、T-027の最終catalog・asset統合確認へ進む。
- 宮沢賢治の3作品はすべて作品単位accepted。F002公開対象は154台詞・152音声、編集除外13件である。

## 直近の作業（最新5件）

- 「注文の多い料理店」を独立受け入れPASS（78候補、65承認、13引用除外、12読み補正）
- 64 WAV、17,576,192 bytes、366,113 msをaccepted正本へ昇格
- F002累積3作品154台詞・152音声、全体preview 2作者・6作品・213台詞・209音声を照合
- 容量実測はrepository 814,330,905 bytesのみ警告、1GB停止未満で総合pass_with_warning
- 全648 tests、型・lint・build・audit、先行88 WAV・F001・public不変をPASS

## 次のアクション

- T-027でaccepted 3作品、作者画像、権利・規約証跡を最終CatalogV2候補へ統合する。
- F001 content/dist不変、全152 WAV、route、credit、provenance、容量警告を一括検証する。
- 実装タスク完了後にT-028のUT-F002実施へ進む。

## 未解決事項

- T-027の最終実装統合が未完了。
- source repositoryは814,330,905 bytesで750 MB警告中。1 GB停止上限まで185,669,095 bytesの余裕がある。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
