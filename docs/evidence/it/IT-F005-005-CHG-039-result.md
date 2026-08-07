# IT-F005-005 CHG-F005-039 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 470/470件PASS
- 関連Vitest: 4 files / 57件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `b8f6a84091f424f8dbedbce5e67c8a09d95f755c32c7267fc0c6e0adab037777`
- binary SHA-256: `30224484b9cef4c3eaae89a1412a62354fef878dfce47c397ccc83f33ae783e1`
- binary size: 75,134,812 bytes
- `public/`・`data/`差分: 0件
- 独立受入: PASS（High 0 / Medium 0 / Low 1）

exact late拒否位置の純粋診断、全複合条件のtrue/false軸、write/setinfoの100/102文字code、generic fallback、23 exact codeのnative/bridge/runner/workflow同期、unknown/extra/exact 128文字の一般化、失敗前後のstate不変を確認した。実Windows ETWでの診断bucket確定はQT-F005-008/009のhosted再観測へ引き継ぐ。

独立受入の関連Vitest初回で、既知のWindows高速終了テスト1件が5秒timeoutとなった。単独再試験PASS後に4 files / 57件を全件再実行してPASSし、機能assert失敗がないことを確認した。
