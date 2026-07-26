# IT-F003 RuntimeAcceptance attempt 6

- 実施日: 2026-07-26
- 対象commit: `e23de96`
- 結果: FAIL
- Chromium: 20 PASS / 1 fail
- 後続3環境: 未実行

## 原因

2件目の画面遷移開始時にWindows loopback通信が`net::ERR_NO_BUFFER_SPACE`を返した。アプリassertion、候補データ、セキュリティ違反による失敗ではなく、短時間に同じ4187番ポートで大容量HTTP試験を反復した際の一時的なsocket資源不足である。

## 回復

4ブラウザへ4191〜4194の別ポートを割り当て、前回server・接続状態を分離する。runnerは子processのstdout/stderrも失わず診断へ含める。
