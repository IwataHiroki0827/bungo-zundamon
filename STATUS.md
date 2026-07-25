---
phase: test
feature: F002
updated: 2026-07-26T00:27:00+09:00
next_actions:
  - "T-029でIT・QT・実音声・ブラウザ・権利受入を実施する [REQ-F002-001〜020]"
  - "T-030でリリース前総点検・ゲート④・GitHub Pages公開を実施する [REQ-F002-001〜020]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はtestフェーズ。T-019〜T-028を完了し、T-029のIT・QT・実音声・ブラウザ・権利受入へ進む。
- 宮沢賢治の3作品はすべて作品単位accepted。F002公開対象は154台詞・accepted音声152件、SHA重複排除後の公開WAV151件、編集除外13件である。
- exact commit `00fed9a8e3f63534bde2ce427a0593e4b99bb73a`のrelease-verifyは独立再実行を含めPASSした。

## 直近の作業（最新5件）

- UT-F002 40/40件をテストコードへ直接照合し、正式attempt 3で37ファイル・719/719 testsをPASS
- 欠落していたF002最終受入判定とpublished atomic transactionを実装し、release経路へ接続
- 証跡型・accepted音声path・実体hash・canonical route・再起動journal recoveryのfail-openを修正し、独立受入ACCEPT（指摘0）
- CatalogV2を2作者・6作品・213台詞・208公開音声へ統合し、tracked public 224 files / 81,641,935 bytesへ更新
- F002 accepted音声152件をSHA単位で151公開WAVへ決定的統合し、dialogue/candidate参照を再結合

## 次のアクション

- T-029でIT-F002 18件、QT-F002 14件、実音声・ブラウザ・権利・容量証跡を同一candidateへ結合する。
- 自動化できるIT/QTを先行実行し、実機・手動証跡が必要な項目を分離する。
- T-029完了後、T-030のリリース前総点検・ゲート④・GitHub Pages公開へ進む。

## 未解決事項

- T-029のIT・QT・実音声・ブラウザ・権利受入が未完了。
- source repositoryはGit実体再計測145,406,059 bytesで警告・停止閾値未満。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
