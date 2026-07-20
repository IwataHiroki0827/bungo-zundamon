---
phase: implement
feature: F002
updated: 2026-07-20T14:42:49+09:00
next_actions:
  - "T-022でF001不変照合・容量・repository・Pages・security preflightを実装する [REQ-F002-001/012/013/015/017/018/019/020]"
  - "T-023で宮沢賢治画像・規約snapshot・権利証跡を整備する [REQ-F002-004/007/015/016]"
  - "T-024で宮沢賢治3作品を実データ処理し音声生成・受入する [REQ-F002-002/006/008/009/010/011/012/013]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はimplementフェーズ。T-019〜T-021を独立受け入れPASSで完了した。
- 複数作者のbatch、CatalogV2、音声・公開統合、作者別route/UI、音声lifecycle、全作品creditsを利用できる。

## 直近の作業（最新5件）

- T-021を独立受け入れPASSで完了（全552テスト、型、lint、build、npm audit 0件）
- CatalogV2のslug一意解決、作者一覧・作者別作品/台詞・creditsを実装
- route変更前の音声停止、src属性解除、旧listener cleanup、例外隔離を実装
- 公開asset pathと作者/work/dialogue/audio参照のfail-closed検証を実装
- T-020をcommit `814343b`として`feature/F002`へpush

## 次のアクション

- T-022でF001 content/dist不変、容量、repository、Pages、security preflightを実装する。
- T-023で宮沢賢治画像provenance、規約snapshot、作品権利証跡を整備する。
- T-024で宮沢賢治3作品の実処理・VOICEVOX生成・作品単位受入へ進む。

## 未解決事項

- T-022〜T-027の実装タスクが未完了。
- 宮沢賢治の画像notice/provenance公開実体はT-023で追加する。
- VOICEVOX ENGINEは作品音声生成T-024前にloopback限定で起動・版照合する。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
