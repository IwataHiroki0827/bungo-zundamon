# IT-F003 RuntimeAcceptance attempt 4

- 実施日: 2026-07-26
- 対象commit: `75aecfa`
- 結果: FAIL
- Chromium: PASS
- Firefox: PASS
- WebKit: 19 PASS / 1 skip / 1 fail
- Android相当: WebKit失敗で未実行

## 原因

セキュリティ操作試験が状態遷移確認時にも公開WAV実体の取得完了を5秒で待っていた。Chromiumで164 MiB・495ファイルの全公開アセット検査を行った後のWebKit実行でI/O待ちが5秒を超え、アプリ状態が`idle`のまま期限切れになった。外部通信・CSP・storage等の違反は検出されていない。

## 回復

音声実体のHTTP 200検査はdelivery試験へ維持し、セキュリティ操作試験では同一originの音声応答を決定的に返す。これにより、検査対象である外部通信0件・状態遷移・Cookie/storage/form/CSP 0件を大容量I/O待ちから分離する。
