# IT-F004 実施結果

- 実施日: 2026-07-29
- 対象候補コミット: `8fe2538ffeb2c322b3519249b962cc7202546679`
- exact dist SHA-256: `c542f435f0adb27cd253788680b58baf102f61fbec33a91d73087bb07d40b8b9`
- 判定: **IT-F004-001〜015 PASS**
- 手動確認: 必須証跡に含めない

## 自動結合試験

| 範囲 | 結果 | 実測 | 正式生ログSHA-256 |
|---|---|---:|---|
| F004結合Vitest | PASS | 47 suites / 252 tests | `5aebabd33483a1cd6f46881117d6a3a64131173ad76b7b3b1a42b8c0819ecc00` |
| Chromium | PASS | 24 pass / 0 skip / 0 fail | `da64d45164e998f7b4343b538443d1fe70deb02b76fbb51be6f80b4d91d0da32` |
| Firefox | PASS | 23 pass / 1意図的skip / 0 fail | `eba7028e3d52069d811ca37d98d8ba18e3fa6c298105011d06bb2f0dc4cc098e` |
| WebKit | PASS | 23 pass / 1意図的skip / 0 fail | `807aa3b1314dfa9ce0f39fffbfc560ef598eab4eea5af16a6a78979d674819d0` |
| Android相当 | PASS | 23 pass / 1意図的skip / 0 fail | `25322750115e6abe7f4aae4a88b829f525d80e9ba1aac97b50cc48ecb83e6c63` |

4環境の最終範囲は合計93 pass、3意図的skip、fail 0である。skipは697配布資産の全件検査をChromiumだけで一度実行し、他3環境では同一内容の重複走査を省いたものに限定される。

## 回帰範囲

- 3作者・12作品・674台詞・662音声のCatalogと、宮沢賢治6作品・356台詞を検証した。
- 全作者route、favorites route、credits、404隔離、音声の単一再生、keyboard操作、3 viewport、reduced motion、CSP・外部通信・Cookie・Storage・form境界を検証した。
- お気に入りは登録・解除、再読込、作者横断一覧、元台詞へのone-shot focus、quota超過時のmemory縮退を検証した。
- 初期状態で全作品パネルが閉じていることを各作者routeで検証した。

初期attemptの失敗は、旧F003件数の期待値、試験側のbutton名判定、WebKit固有のpointer hit-testに切り分けた。実DOM契約とkeyboard操作へ試験を同期し、最終attemptでは全環境でfail 0となった。失敗と復旧の全履歴は`docs/evidence/retries.yaml`に保持する。
