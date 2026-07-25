---
phase: test
feature: F002
updated: 2026-07-26T01:31:00+09:00
next_actions:
  - "T-029で自動IT・QT・ブラウザ・権利・容量証跡を同一candidateへ結合する [REQ-F002-001〜020]"
  - "T-030でリリース前総点検・ゲート④・GitHub Pages公開を実施する [REQ-F002-001〜020]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はtestフェーズ。T-019〜T-028とCHG-F002-002影響試験T-032を完了し、T-029の自動IT・QT・ブラウザ・権利・容量受入へ進む。
- 宮沢賢治の3作品はすべて作品単位accepted。F002公開対象は154台詞・accepted音声152件、SHA重複排除後の公開WAV151件、編集除外13件である。
- exact commit `00fed9a8e3f63534bde2ce427a0593e4b99bb73a`のrelease-verifyは独立再実行を含めPASSした。

## 直近の作業（最新5件）

- CHG-F002-002で手動・実機・目視・聴取・手動スクリーンリーダーをF002必須条件から除外し、自動証跡専用へ変更
- 独立再レビューHigh/Medium/Low 0、対象152 tests、全Vitest 734 tests、Playwright必須4系統84 testsをPASS
- UT-F002 40/40件をテストコードへ直接照合し、正式attempt 3で37ファイル・719/719 testsをPASS
- 欠落していたF002最終受入判定とpublished atomic transactionを実装し、release経路へ接続
- 証跡型・accepted音声path・実体hash・canonical route・再起動journal recoveryのfail-openを修正し、独立受入ACCEPT（指摘0）

## 次のアクション

- T-029でIT-F002 18件、QT-F002 14件、自動ブラウザ・権利・容量証跡を同一candidateへ結合する。
- F002の判定は自動試験と機械検証可能な既存判断artifactだけで完結させ、手動入力を待たない。
- T-029完了後、T-030のリリース前総点検・ゲート④・GitHub Pages公開へ進む。

## 未解決事項

- T-029のIT・QT・ブラウザ・権利・容量の自動受入証跡結合が未完了。
- source repositoryはGit実体再計測145,406,059 bytesで警告・停止閾値未満。
- C:は35.5GB空きだが空き率3.8%のため容量警告域。今回のbuild 81,723,316 bytesは安全に完了した。
