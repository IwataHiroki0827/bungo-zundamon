---
feature: F002
reviewed_at: 2026-07-20T09:19:40+09:00
result: PASS
change: CHG-F002-001
---

# F002 試験仕様レビュー証跡

## 対象

- `docs/tests/ut/UT-F002.md`: UT 40件
- `docs/tests/it/IT-F002.md`: IT 18件
- `docs/tests/qt/QT-F002.md`: QT 14件
- `docs/design/FD-F002.md`: DES 16件
- `docs/design/DD-F002.md`: FUN 40件
- `docs/changes/CHG-F002-001.md`

## レビュー結果

| 観点 | 初回 | 最終 | 判定 |
|---|---|---|---|
| 要求・設計・試験の網羅性 | High 0 / Medium 3 / Low 0 | High 0 / Medium 0 / Low 0 | PASS |
| 試験設計品質・実行可能性 | High 3 / Medium 3 / Low 0 | High 0 / Medium 0 / Low 0 | PASS |

各修正後に現行文書を読み直して反復し、最終判定は両観点とも未解消指摘0件で確定した。

## 主な指摘対応

- 全QTをcanonical `ReleaseBuildContext/CandidateEvidence`の同一candidate tupleへ結合した。
- manifest/published/accepted-audio/publicのatomic transactionにdurability・競合・Windows回復oracleを定義した。
- VoiceConfig範囲、Aozora/policy transportの8 MiB・15秒、権利観測commit/run/phase、空き容量式を固定した。
- work容量reportのrelease流用を禁止し、exact clean releaseCommitで実Git pack/looseと完全distを再実測する試験を追加した。
- Actions remote `uses:`の40桁commit SHA pin、transport別SSRF/TOCTOU、published manifest crash recoveryを追加した。
- KB-0001に従い、生成側のpath/ID/hashを消費側・Vite・browserまで同じfixtureで通すITを追加した。

## 機械検査

- REQ→QT: 20/20
- REQ→DES: 20/20
- DES→FUN/UT/IT: 16/16
- FUN→UT: 40/40
- ID: REQ 20、DES 16、FUN 40、UT 40、IT 18、QT 14。欠番・重複・未定義参照0件。
- `trace_check.py --path <project> --feature F002`: 対応漏れなし（exit 0）
- `git diff --check`: エラーなし（改行形式warningのみ）

## 判定

High 0 / Medium 0のため、テストファースト承認ゲート③へ進行可能と判定する。
