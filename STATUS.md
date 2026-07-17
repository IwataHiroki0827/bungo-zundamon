---
phase: requirements
feature: F001
updated: 2026-07-18T00:07:00+09:00
next_actions:
  - "ProjectFactoryダッシュボードで Q-001（初期公開の収録範囲）へ回答する"
  - "回答をSRS-F001/QT-F001へ反映し、要求仕様承認ゲート①へ進む"
blocked_by:
  - Q-001
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001のドメイン調査、SRS、QA、QTドラフトを作成済み。
- 青空文庫は権利条件を満たす芥川原著だけを選定し、VOICEVOX音声は事前生成してGitHub Pagesへ静的配信する方針。
- 初期公開の収録範囲についてQ-001の回答待ち。回答後に要求仕様を確定し、承認ゲート①へ進む。

## 直近の作業(最新5件)

- `bungo-zundamon`としてWebアプリテンプレートを複製
- `REQUEST.md`へ青空文庫台詞抽出、ずんだもん音声、静的Pages公開の要求を記録
- 青空文庫、文化庁、VOICEVOX、SSS、坂本アヒル氏配布素材、GitHub Pagesの一次情報を調査
- `docs/domain/DOMAIN-F001.md`、`docs/srs/SRS-F001.md`、`docs/qa/QA-F001.md`、`docs/tests/qt/QT-F001.md`を作成

## 次のアクション

- Q-001へ回答する
- 回答後にSRS/QTを確定し、要求仕様承認ゲート①へ進む

## 未解決事項

- Q-001: 初期公開の作品数・1作品当たり台詞上限
- ProjectFactoryの承認ゲートは自動承認で省略せず、成果物完成後に明示承認を受ける
