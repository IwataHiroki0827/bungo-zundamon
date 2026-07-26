# IT-F003 RuntimeAcceptance attempt 5

- 実施日: 2026-07-26
- 対象commit: `70b00f5`
- 結果: FAIL（試験開始前）
- エラー: `spawn EINVAL`

## 原因

WindowsのNode.js 24で`execFile`から`npm.cmd`を直接起動したため、build開始前にprocess生成が拒否された。アプリ、候補データ、ブラウザ試験の失敗ではない。

## 回復

`npm run`から渡される`npm_execpath`を取得し、Node.jsからnpm CLIのJavaScript実体を直接実行する。CLI実体が解決できない場合はfail-closedで停止する。
