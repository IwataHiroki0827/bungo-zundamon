---
phase: requirements
feature: F002
updated: 2026-07-20T00:38:21+09:00
next_actions:
  - "ProjectFactory画面でQ-012を承認する"
  - "承認後にSRS-F002/QT-F002をApprovedへ更新し、pf-setupを自動起動する"
blocked_by:
  - Q-012
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。公開URLは https://iwatahiroki0827.github.io/bungo-zundamon/ 。
- 公開v0.1.0のred/blue診断はCritical/High/Medium 0。GitHub設定のLow 3件を修正し、独立受け入れPASS。
- F002「宮沢賢治追加と継続コンテンツ拡充基盤」をfeature/F002で開始した。
- 初回は宮沢賢治「よだかの星」「どんぐりと山猫」「注文の多い料理店」。約168候補、追加音声57～76 MiBを見込む。
- DOMAIN-F002、SRS-F002（20要求）、QA-F002（未回答0）、QT-F002（14件）を作成し、REQ→QT未追跡0件、独立レビューHigh 0 / Medium 0のPASSを確認した。
- T-015は要求仕様確定ゲートQ-012の承認待ち。

## 直近の作業（最新5件）

- 公開サイト・依存関係・ソース・GitHub設定をred/blue診断し、docs/redblue-report.mdへ記録
- GitHub Actions制限、完全SHA固定、Secret scanning、push protection、Dependabot、main保護を有効化
- disk-guardでC:空き111.7GB（12%）を確認しGO判定
- 公式情報と本文量で宮沢賢治・太宰治・夏目漱石を比較し、宮沢賢治3作品を選定
- SRS/QTの独立レビューを行い、容量算入範囲・規約証跡・F001不変基準を補正してHigh 0 / Medium 0でPASS

## 次のアクション

- ProjectFactory画面でQ-012「F002 要求仕様・適格性試験仕様の一括承認」を承認する。
- 承認後、SRS-F002.mdとQT-F002.mdをApprovedへ更新し、Q-012をclosed、T-015をdoneにする。
- run_mode:autoによりpf-setupを起動し、複数作者化・コンテンツ取得・音声差分生成をタスク分解する。

## 未解決事項

- F001で未取得だったiOS Safari物理端末とスクリーンリーダーの詳細証跡は、F002リリース条件として継続する。
- Q-008由来の演出切替廃止・常時標準・クレジット遷移統一は、F002とは分離した変更候補として未着手。
- trace_checkのREQ→DES 20件は設計前の予定差分であり、ゲート①後のpf-designで解消する。
- GitHub Pagesは公開サイト1GB上限があるため、公開総容量750 MiB超の見込みでは音声配信方式を見直す。
