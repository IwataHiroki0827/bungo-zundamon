---
phase: testspec
feature: F001
updated: 2026-07-18T10:43:17+09:00
next_actions:
  - "ブラウザでQ-004を開き、UT・IT・QT試験仕様を確認して承認または修正指示を回答する"
  - "Q-004承認後、T-003を完了して$pf-implementでT-004〜T-008の実装を開始する"
blocked_by: [Q-004]
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- Q-003の設計承認を反映し、FD-F001とDD-F001は`Approved`である。
- `docs/tests/ut/UT-F001.md`（42件）と`docs/tests/it/IT-F001.md`（20件）を作成し、承認済みQT-F001（20件）を実行可能な試験契約へ補強した。
- テスト仕様レビューは網羅性 High 0 / Medium 0、試験品質 High 0 / Medium 0でPASSした。
- REQ→QT 30/30、DES→IT 19/19、FUN→UT 42/42を接続し、`trace_check`は対応漏れ0件である。
- 設計レベル変更`CHG-F001-001`を完了し、試験仕様承認ゲート③のQ-004を登録した。

## 直近の作業（最新5件）

- 承認済み設計と音声失敗時挙動の矛盾、catalog byte検査、SSRF fixture衝突を変更管理へ記録
- 青空文庫の書誌/XHTML取得をproduction transportで検証するTLS・DNS pin・要求回数契約へ統一
- VOICEVOX ENGINE版、speaker UUID/name、style ID/nameをruntime応答と照合する試験を追加
- リリース前の非破壊precheckと、承認後のcommit→artifact→deployment→Pages hash事後証跡を分離
- 網羅性・試験品質レビューとtrace_checkをPASSし、Q-004を登録

## 次のアクション

- ブラウザのQ-004でUT・IT・QT試験仕様を確認し、`承認`または`修正指示`を回答する。
- 承認時は自動再開によりT-003を完了し、`pf-implement`へ進む。

## 未解決事項

- Q-004（試験仕様承認）待ち。
- `TM-F001.md`には複数DES経由の同一FUN/UT/ITが重複表示されるが、trace判定と対応範囲には影響しない。
