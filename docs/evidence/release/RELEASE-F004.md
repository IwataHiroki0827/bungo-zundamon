# F004 v0.4.0 リリース結果

- 判定: PASS
- 公開日時: 2026-07-29 04:06 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `f0a2c91effd17d1fcf75a578dad2c562ba7949c2`
- tag: `v0.4.0`
- GitHub Actions run: `30390224028`
- deployment ID: `5645861744`
- production artifact ID: `8700661389`
- production artifact SHA-256: `e74f65f5061746567c4df47f220159701fb28263a9c295cd269c42287514658f`
- dist SHA-256: `c542f435f0adb27cd253788680b58baf102f61fbec33a91d73087bb07d40b8b9`
- catalog SHA-256: `857401c774ed8dabaaf0e67d8f3e5f710a83fa1fefcd9965498590aab629f6e5`

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、3作者 |
| 芥川龍之介route | 3作品、初期open 0 |
| 宮沢賢治route | 6作品、初期open 0 |
| 太宰治route | 3作品、初期open 0 |
| お気に入り | 空状態、登録、再読込保持、一覧、解除をPASS |
| クレジット | 必須表記あり |
| CatalogV2 | 3作者・12作品・674台詞・662音声 |
| 宮沢賢治画像 | HTTP 200 |
| 音声 | HTTP 206、`audio/wav`、Range取得成功 |
| console / page error | 0件 |
| 外部request / CSP違反 | 0件 |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`が存在しないことを確認した。公開後のmanifest更新は`recordPublishedBatch`のatomic transactionで実施し、SHA-256 `beaea5e9da89b6baa3c82f0d11bd5d326b8f248d223073d94d95224a6b26f445`の`published`状態へ遷移した。

初回の旧`public`候補による無変更デプロイは、公開スモークで未反映を検出した。旧v0.3.0の正常稼働を維持したまま公開treeをatomic昇格し、exact候補を再検証して本デプロイを完了した。
