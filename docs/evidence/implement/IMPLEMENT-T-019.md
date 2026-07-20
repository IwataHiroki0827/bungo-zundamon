# T-019 実装・受け入れ証跡

- 実施日: 2026-07-20
- フィーチャー: F002
- タスク: T-019「バッチ定義・青空文庫取得・抽出・レビュー基盤を複数作者化」
- 対応要求: REQ-F002-002、REQ-F002-006〜010、REQ-F002-019
- 受け入れ判定: PASS

## 実装結果

- `BatchManifest`、バッチ／作品状態遷移、競合検出付きatomic保存を実装した。
- 実process強制終了後のjournal回復、第三者改変の隔離、workspace外・reparse point・Windows危険pathの拒否を実装した。
- 青空文庫の書誌CSV／ZIP、選定観測、原典、provenance、抽出候補を作品単位の同一昇格トランザクションへ結合した。
- 表示文と読み上げ文の分離、revision連続性、全候補レビュー、policy判断、`pending: 0`ゲートを実装した。
- `content:batch`を実CLIへ接続し、既存F001のcontentコマンドとの後方互換を維持した。
- レビュー前にartifact tree、CSV／ZIP、全candidate SHA、順序、件数を前段証跡へ完全照合するfail-closed検証を実装した。

## 検証結果

| 検証 | 結果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS（23 files / 424 tests） |
| `npm run build` | PASS（66 files / 30,403,023 bytes） |
| `git diff --check` | PASS |
| `npm audit --audit-level=high` | PASS（0 vulnerabilities） |
| 変更ファイルsecretパターン検査 | PASS |

## 受け入れ検査

`pf-acceptor`による複数回の実物検査で、実CLI未接続、状態証跡の結合不足、journal回復不足、path traversal、候補差替えの各指摘を修正した。最終検査では対象7ファイル・160テストがPASSし、Highの未解決0件としてT-019を受け入れた。

非ブロッキング所見として、backup名のUUID表現をRFC形式へさらに限定する余地がある。固定prefix、safe basename、親直下、workspace descendant、reparse検査により現状でも経路逸脱は拒否されるため、後続の保守改善候補とする。
