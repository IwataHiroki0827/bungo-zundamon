---
phase: test
feature: F002
updated: 2026-07-25T23:49:15+09:00
next_actions:
  - "T-028でUT-F002を実施し、失敗を修正・再検証する [REQ-F002-001〜020]"
  - "T-029でIT・QT・実音声・ブラウザ・権利受入を実施する [REQ-F002-001〜020]"
  - "T-030でリリース前総点検・ゲート④・GitHub Pages公開を実施する [REQ-F002-001〜020]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はtestフェーズ。T-019〜T-027を完了し、T-028のUT-F002実施へ進む。
- 宮沢賢治の3作品はすべて作品単位accepted。F002公開対象は154台詞・accepted音声152件、SHA重複排除後の公開WAV151件、編集除外13件である。
- exact commit `00fed9a8e3f63534bde2ce427a0593e4b99bb73a`のrelease-verifyは独立再実行を含めPASSした。

## 直近の作業（最新5件）

- CatalogV2を2作者・6作品・213台詞・208公開音声へ統合し、tracked public 224 files / 81,641,935 bytesへ更新
- F002 accepted音声152件をSHA単位で151公開WAVへ決定的統合し、dialogue/candidate参照を再結合
- provenance・review・speech revision各3件、作者画像1件、全assetのpath・SHA・bytesを照合
- release-verifyをexact clean commitで2回PASSし、public前後SHA、F001 content/dist、dist/artifactを確認
- release容量5区分を全PASS。全651 tests、型・lint・build・release checks 80件をPASS

## 次のアクション

- T-028でUT-F002 40件の仕様対応と全自動試験を実施し、失敗を修正・再検証する。
- 通常並列suiteで境界的に発生するrelease-runtime 5秒timeoutを試験ハーネス観点で再確認する。
- T-028完了後、T-029のIT・QT・実音声・ブラウザ・権利受入へ進む。

## 未解決事項

- T-028のUT-F002実施が未完了。
- source repositoryはGit実体再計測145,406,059 bytesで警告・停止閾値未満。
- 通常並列suiteではrelease-runtime試験が5秒境界でtimeoutする場合があるが、対象単独と1 worker全suiteはPASSしている。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
