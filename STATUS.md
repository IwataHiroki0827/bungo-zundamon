---
phase: implement
feature: F002
updated: 2026-07-20T14:20:54+09:00
next_actions:
  - "T-021で作者一覧・route・再生UI・クレジットを複数作者化する [REQ-F002-003/004/005/014/015/017/020]"
  - "T-022でF001不変照合・容量・repository・Pages・security preflightを実装する [REQ-F002-001/012/013/015/017/018/019/020]"
  - "T-023で宮沢賢治画像・規約snapshot・権利証跡を整備する [REQ-F002-004/007/015/016]"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002のSRS・FD・DD・UT・IT・QTはすべてApproved、traceability対応漏れ0件。
- F002はimplementフェーズ。T-019とT-020を独立受け入れPASSで完了した。
- 複数作者batch、CatalogV2、音声差分・完全性、accepted/public atomic統合、production `content:batch`を利用できる。

## 直近の作業（最新5件）

- T-020を独立受け入れPASSで完了（全482テスト、型、lint、build、npm audit 0件）
- voice artifactをpre-voice/voiced manifestとstage recordへ結合し、正規voice→accept連結試験を追加
- release-verifyをcandidate tuple、実artifact SHA、再生成build SHA、tracked public byte一致へ結合
- 共有音声、累積preview、実SIGKILL/stale lock、orphan・未知owner隔離を実装
- CatalogV2と複数batch公開tree、F001互換・不変照合基盤を実装

## 次のアクション

- T-021で作者一覧・route・再生UI・クレジットを複数作者対応する。
- T-022で容量・repository・Pages・security preflightを実装する。
- T-023で宮沢賢治の画像provenance、規約snapshot、作品権利証跡を整備する。

## 未解決事項

- T-021〜T-027の実装タスクが未完了。
- 実コンテンツ音声生成はT-024、最終受け入れ・公開判定はT-027以降で実施する。
- VOICEVOX ENGINEは作品音声生成T-024前にloopback限定で起動・版照合する。
- iOS Safari物理端末とスクリーンリーダー詳細証跡はF002リリース条件として継続する。
