---
phase: implement
feature: F002
updated: 2026-07-25T20:14:07+09:00
next_actions:
  - "T-024で「よだかの星」の候補全件をレビューし、VOICEVOX音声を生成・作品単位受入する [REQ-F002-005/006/007/008/009/010/012/013/015/018/019]"
  - "T-025で「どんぐりと山猫」の候補全件レビュー・音声生成・作品単位受入を実施する [REQ-F002-005/006/008/009/010/012/013/015/018/019]"
  - "T-026で「注文の多い料理店」の候補全件レビュー・音声生成・作品単位受入を実施する [REQ-F002-005/006/008/009/010/012/013/015/018/019]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はimplementフェーズ。T-019〜T-023を完了し、T-024「よだかの星」の作品単位受入を開始した。
- T-023は公式規約5件の選定時観測、2時点変更gate、宮沢賢治画像provenance、公開tree結合を独立受け入れPASS済み。

## 直近の作業（最新5件）

- T-023を独立受け入れPASS（全639 tests、型・lint・verify:build・build・audit合格）
- 偽造response・偽造観測をruntime完全検証でfail-closed化
- `public/content`配下workspaceへのraw規約snapshot書込みを拒否し、攻撃fixtureでwrite 0を確認
- 宮沢賢治ずんだもん画像の完全prompt・入力0件・出力hash・規約hash・目視判断をprovenanceへ固定
- `brace-expansion`を5.0.8へ更新し、高重大度アドバイザリを解消

## 次のアクション

- `content/batches/F002/`の「よだかの星」候補を全件レビューし、文脈・読み・重複・完全性を確定する。
- VOICEVOX ENGINEをloopback限定で起動して版を照合し、accepted-audio正本へ作品単位でatomic昇格する。
- 容量100/500/750 MiBゲートを監視し、作品単位受け入れ証跡を`docs/evidence/implement/`へ保存する。

## 未解決事項

- T-024〜T-027の実装タスクが未完了。
- VOICEVOX ENGINEはT-024でloopback限定起動・版照合・credit固定を行う。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
