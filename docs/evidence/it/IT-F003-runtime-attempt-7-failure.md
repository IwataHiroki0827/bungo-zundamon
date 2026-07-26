# IT-F003 RuntimeAcceptance attempt 7

- 実施日: 2026-07-26
- 対象commit: `de69d5f`
- 結果: FAIL
- Chromium: 21 PASS
- Firefox: 19 PASS / 1 skip / 1 fail
- WebKit・Android相当: 未実行

## 原因

セキュリティ操作試験が作者リンク遷移のanimation完了前に先頭作品の`summary`を押した。Firefoxでは展開直後にroute確定描画が行われ、展開したDOMが初期全閉DOMへ置き換わったため、`open`属性が5秒以内に維持されなかった。

## 回復

共通`expandFirstWork` helper内で現在routeのanimation完了を待ってから展開する。これにより呼び出し元ごとの待機漏れをなくし、初期全閉を維持した上で明示操作後だけ展開する。
