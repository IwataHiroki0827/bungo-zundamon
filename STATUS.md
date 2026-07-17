---
phase: requirements
feature: F001
updated: 2026-07-18T01:10:49+09:00
next_actions:
  - "docs/srs/SRS-F001.md と docs/tests/qt/QT-F001.md を確認し、Q-002で要求仕様を承認する"
  - "承認後は approval_resume:auto により $pf-setup へ自動再開する"
blocked_by:
  - Q-002
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001のドメイン調査、SRS、QA、QTドラフトを作成済み。
- 青空文庫は権利条件を満たす芥川原著だけを選定し、VOICEVOX音声は事前生成してGitHub Pagesへ静的配信する方針。
- Q-001回答「代表作3作品ですべてのセリフ」を反映し、「羅生門」「蜘蛛の糸」「杜子春」の全確認済み発話を初期収録範囲に確定した。
- 未回答QAは0件。SRS/QTの要求仕様承認ゲート①（Q-002）で明示承認を待っている。

## 直近の作業(最新5件)

- `bungo-zundamon`としてWebアプリテンプレートを複製
- `REQUEST.md`へ青空文庫台詞抽出、ずんだもん音声、静的Pages公開の要求を記録
- 青空文庫、文化庁、VOICEVOX、SSS、坂本アヒル氏配布素材、GitHub Pagesの一次情報を調査
- `docs/domain/DOMAIN-F001.md`、`docs/srs/SRS-F001.md`、`docs/qa/QA-F001.md`、`docs/tests/qt/QT-F001.md`を作成
- Q-001のブラウザ回答をQA/SRS/QTへ反映し、Q-001をclosed化
- 要求仕様承認ゲート①としてQ-002を登録

## 次のアクション

- `docs/srs/SRS-F001.md`と`docs/tests/qt/QT-F001.md`を確認する
- ProjectFactoryダッシュボードのQ-002で「承認」を押す

## 未解決事項

- Q-002: F001要求仕様・適格性試験仕様の明示承認
- 自動再開は承認を代行せず、承認ボタンで記録した後の`$pf-setup`起動だけを自動化する
