# IT-F003 ブラウザ試験 attempt 2

- 候補commit: `e268ef4`
- 対象: Chromium
- 結果: FAIL
- 失敗: 10ケース

## 原因

- `f002-multi-author.spec.ts`が作者カード2件を固定期待しており、F003の3件を拒否した。
- 初期全閉へ変更後も複数のE2Eが閉じた`details`内の再生ボタンを直接操作し、30秒timeoutになった。
- 全asset取得を全browserで繰り返す構成は、F003の164MB候補で不要な試験時間を増やしていた。

## 回復

- 作者カード3件、太宰治3作品259台詞、公開5 routeへ期待値を更新する。
- 音声操作の前に`summary`を明示操作し、初期全閉を先に検証する。
- 全assetのHTTP 200照合はChromiumで一度だけ実行し、他browserはroute・UI・securityの同値試験を継続する。
