---
phase: design
feature: F002
updated: 2026-07-20T06:34:23+09:00
next_actions:
  - "docs/design/FD-F002.mdを作成し、REQ-F002-001〜020をDESへ展開する（T-016）"
  - "docs/design/DD-F002.mdを作成し、FUNとデータ・状態遷移契約へ展開する（T-017）"
  - "設計レビューとtrace_check完了後、ProjectFactoryへ設計承認ゲート②を登録する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。公開URLは https://iwatahiroki0827.github.io/bungo-zundamon/ 。
- F002の要求承認Q-012を受理し、SRS-F002/QT-F002をApproved、T-015をdoneへ更新した。
- setupでT-016〜T-030の15タスクを生成し、REQ-F002-001〜020の実装coverage 20/20、依存循環0を確認した。
- Node v24.11.0、npm 11.6.1、VOICEVOX本体/ENGINE、Playwrightを確認し、新規MCP・専用agentは不要と判断した。
- F002コード変更前baselineはtypecheck・lint・Vitest 337件・offline build 66 files / 30,403,023 bytesがPASS。
- F002はdesignへ移行し、T-016から開始する。

## 直近の作業（最新5件）

- F002要求レビューの容量算入範囲・規約2時点証跡・F001基準固定を修正しHigh 0 / Medium 0でPASS
- ProjectFactory画面のQ-012承認をSRS/QT・tasks・queueへ3点セットで反映
- F002 WBSを設計2、試験仕様1、実装9、試験2、リリース1の15タスクへ分解
- 3作品を「よだかの星」→「どんぐりと山猫」→「注文の多い料理店」の直列依存に設定
- docs/evidence/setup/SETUP-F002.mdとCLAUDE.mdへ環境・検証・VOICEVOX・容量条件を記録

## 次のアクション

- T-016でdocs/design/FD-F002.mdを作成し、複数作者catalog、継続batch、権利snapshot、容量preflight、F001不変検査を設計する。
- T-017でdocs/design/DD-F002.mdを作成し、hardcode除去対象と関数・schema・asset統合契約を定義する。
- pf-reviewerによる整合性・実現性・セキュリティレビューとtrace_checkを完了し、ゲート②だけをProjectFactory画面へ提示する。

## 未解決事項

- 現行コードは人物ID、作者slug、3作品、59台詞、F001 cache・証跡・公開pathを広範囲に固定しており、設計で移行境界を明示する必要がある。
- F001で未取得だったiOS Safari物理端末とスクリーンリーダーの詳細証跡は、F002リリース条件として継続する。
- Q-008由来の演出切替廃止・常時標準・クレジット遷移統一は、F002とは分離した変更候補として未着手。
- VOICEVOX ENGINEはsetup時点で未起動。T-024開始前にloopback限定で起動し、版・speaker UUID・styleを再照合する。
