# QT-F002 実施結果

- 更新日時: 2026-07-26 02:13 JST
- 現在判定: **自動試験PASS／exact release candidateへの最終結合待ち**
- 仕様ID照合: `QT-F002-001`〜`QT-F002-014`の14/14件を自動試験へ直接対応、未対応0件、余剰0件
- 手動・実機・目視・聴取・スクリーンリーダー入力: F002必須証跡には含めない

## source段階の自動試験

| 範囲 | 結果 |
|---|---:|
| Chromium Pages preview | 21/21 PASS |
| Firefox Pages preview | 21/21 PASS |
| WebKit Pages preview | 21/21 PASS |
| Android相当（Pixel 7 / Chromium） | 21/21 PASS |
| 合計 | **84/84 PASS** |

- unexpected: 0件
- skipped: 0件
- flaky: 0件
- 実行時間: 156.446秒
- JSON生ログ: `docs/evidence/qt/QT-F002-browser-attempt-1.json`
- 生ログSHA-256: `b86840c799ceaec6289967798aab379dc61405f0a459b1ac424e0bb291290833`
- 仕様対応表: `docs/evidence/qt/spec-match.md`
- 付帯回帰: Vitest 734/734、typecheck、lint、production build、依存脆弱性検査をすべてPASS

## 残る自動処理

本結果はsource段階の回帰PASSを示す。QT-F002の正式な最終PASSは、`prepare-release`で生成したrelease commitを別clean checkoutから`release-verify`し、最終dist SHA-256、artifact digest、容量、権利・規約・画像判断、security、84件のブラウザ結果を同一candidate tupleへ結合した後に確定する。追加のユーザー入力は要求しない。
