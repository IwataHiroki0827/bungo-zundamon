---
phase: requirements
feature: F003
updated: 2026-07-26T03:05:00+09:00
next_actions:
  - "T-033でF003の次回作者・代表3作品・権利・台詞量・容量を調査する"
  - "既存方針の宮沢賢治「雪渡り」と次作者候補・太宰治を比較し、1作者・代表3作品のF003範囲を決定する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002はv0.2.0として公開・クローズ済み。公開サイトは2作者・6作品・213台詞である。
- 宮沢賢治3作品は154台詞、accepted音声152件、SHA重複排除後の公開WAV151件、編集除外13件で公開した。
- exact commit `84c985f382910216e381a96901f6fd569165a27e`のrelease-verify、GitHub Actions build/deploy、公開後スモークはすべてPASSした。
- F003のrequirementsフェーズを開始し、次作者候補・太宰治と宮沢賢治「雪渡り」を起点に次回収録範囲を調査中。

## 直近の作業（最新5件）

- v0.2.0をcommit `84c985f`からGitHub Pagesへ段階デプロイ
- feature CI、hosted artifact digest、exact release-verify、容量判定を同一candidateへ結合してPASS
- 公開4 route、2作者・6作品・213台詞、クレジット、F002 WAV Range取得を実サイトで確認
- デプロイ変数を公開直後に無効化し、remote tag `v0.2.0`を発行
- `recordPublishedBatch`でF002 manifestをatomicに`published`へ遷移

## 次のアクション

- T-033でF003のTier大ドメイン調査、候補比較、SRS・QA・QTドラフトを作成する。
- 手入力を要求せず、既存方針・青空文庫実データ・権利・容量から推奨範囲を先に固める。

## 未解決事項

- C:は空き率が低い警告域にあるため、F003音声生成前にdisk-guardを再実行する。
- F003の最終収録範囲は要求分析・自動レビュー後に確定する。
