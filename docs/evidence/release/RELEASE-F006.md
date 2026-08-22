# F006 v0.6.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-22 15:22 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `166556111de642770916c6397931ca4b61c786d9`
- tag: `v0.6.0`
- GitHub Actions run: `32556527623`
- production artifact ID: `9471657617`
- production artifact SHA-256: `327e392a6d0a2e62bd9e29f7a7dabd769d8f5678c5f57a8052709d8dae57a8d5`
- dist SHA-256: `de440fbf1f6dccaa79ce369e470d8fe9ce322e68912ac9968d9f97e336ef14e9`
- catalog SHA-256: `7e362d767e7936af41b42e027b491c44d838e259cd92d0baf9bdc2bf14cf5967`

## リリース前に解消したCI回帰(このリリース作業中に発見)

F005を`published`状態へ是正した際の副作用で、CIにおいて以下2件が新規に壊れていた。いずれもF006固有の不具合ではなく、F005修正の波及として本リリース作業の中で発見・修正した。

1. `f005-run-work.test.ts`: 実F005 manifestをdraftへ巻き戻すfixtureが新規publish項目(`publishedAt`等)を削除し忘れていた。
2. `batch-catalog.ts`(F004時代のレガシーpreviewer): F005が`published`として発見されるようになったことで対応catalog fragmentの解決に失敗していた。`f003-catalog.ts`へ汎用dispatch関数を新設して解消。

続いて、CI2回目の実行で残っていた以下2件も解消した。

3. `f006-acceptance.test.ts`: ローカルでaccept-workスクリプトを実行した開発機にだけ残るgitignore対象journalに依存しており、フレッシュcheckout(CI)では複製元が無くthrowしていた。既存コメントの意図通り、複製元が無い場合はtest context `skip()`で明示的にskipするよう修正。
4. `published-baseline.test.ts`: `public/`全体をcpするtestがdefault 5000msのtest timeoutを超過していた。同ファイル内の既存の重いtestと同じ30,000msのtimeoutを追加。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、5作者 |
| 芥川龍之介route | 3作品(既存・不変) |
| 宮沢賢治route | 6作品(既存・不変) |
| 太宰治route | 3作品(既存・不変) |
| 夏目漱石route | 3作品(既存・不変) |
| 中島敦route | 3作品(山月記・名人伝・弟子) |
| 中島敦作者画像 | HTTP 200 |
| 中島敦artwork-provenance | HTTP 200 |
| CatalogV2 | 5作者・18作品・939台詞(既存4作者15作品は不変) |

Chrome拡張(claude-in-chrome)が未接続だったため、KB-0008が推奨する実ブラウザでのroute別画面確認は今回未実施。代わりにHTTPレベル(index/catalog/artwork/artwork-provenance)と公開`catalog.json`実データ(著者数・作品数・台詞数)での確認に留めた。次回リリース時にブラウザ接続が可能であれば実施する。

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。
