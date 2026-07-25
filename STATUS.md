---
phase: design
feature: F003
updated: 2026-07-26T03:28:20+09:00
next_actions:
  - "T-034でdocs/design/FD-F003.mdを作成し、REQ-F003-001〜018を設計へ展開する"
  - "T-035でdocs/design/DD-F003.mdを作成し、候補manifest・二重レビュー・容量・atomic受入の関数契約を定義する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0としてGitHub Pagesへ公開・クローズ済み。
- 公開サイトは2作者・6作品・213台詞で、F002の公開後全route・CatalogV2・画像・音声スモークはPASSした。
- F003は太宰治「女生徒」「走れメロス」「グッド・バイ」を小さい作業単位から順に追加する。
- SRS-F003のREQ 18件とQT-F003の15件はApproved。独立再レビューHigh/Medium/Low 0、REQ→QT欠落0でゲート①を通過した。
- pf-setupでT-034〜T-044のWBS、実行形態、検証コマンドを整備し、designフェーズへ移行した。

## 直近の作業（最新5件）

- v0.2.0をcommit `84c985f`から段階デプロイし、公開後スモークPASS
- 公開後metadata commitのCI回帰を修正し、main CI成功・deploy skippedを確認
- F003 Tier大ドメイン調査と太宰治3作品の候補比較を実施
- 単一候補・容量境界、独立二重編集判定、データ駆動再利用をSRS/QTへ固定
- 独立再レビュー指摘を全件解消し、要求ゲート①とsetupを完了

## 次のアクション

- T-034で`docs/design/FD-F003.md`を作成し、既存F002パイプラインの再利用境界とF003固有データを設計する。
- T-035で`docs/design/DD-F003.md`を作成し、`content/batch-candidates.json`、二重レビュー、単一候補安全性、作品単位atomic受入の関数契約を定義する。
- 設計レビュー後、承認ゲート②へ進む。

## 未解決事項

- C:は空き率が低い警告域にあるため、F003音声生成前にdisk-guardを再実行する。
- `content/batch-candidates.json`は設計でschemaを確定し、T-037で実体を追加する。
