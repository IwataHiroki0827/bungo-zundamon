# F003 v0.3.0 リリース結果

- 判定: PASS
- 公開日時: 2026-07-26 22:19 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `79d12825b83459b92da58e14a32f853bae6d92d9`
- tag: `v0.3.0`
- GitHub Actions run: `30203760729`
- deployment ID: `5610537281`
- production artifact ID: `8632449934`
- production artifact SHA-256: `aa103dfb5e323aa1d4f78fd42a7fd6d37b393077e05a0ed89bf2f5bd811a23e5`
- dist SHA-256: `c1656d8e5514ee151310109cbc6601af4515ce47ca8b214bf3a83a9aa5c3c5a6`
- catalog SHA-256: `591b127e62e4c7686f3a47dc1476426185fe0c825e9092af892cd00e62d97769`

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、3作者 |
| 芥川龍之介route | 3作品、初期open 0 |
| 宮沢賢治route | 3作品、初期open 0 |
| 太宰治route | 3作品、初期open 0、先頭作品の展開成功 |
| クレジット | 必須表記あり |
| CatalogV2 | 3作者・9作品・472台詞・463音声 |
| 作者画像 | 3件とも読込成功、naturalWidth 1254 |
| 音声 | HTTP 206、`audio/wav`、Range取得成功 |
| console / page error | 0件 |
| 外部request / CSP違反 | 0件 |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`が存在しないことを確認した。公開後のmanifest更新は`recordPublishedBatch`のatomic transactionで実施し、SHA-256 `b26a06c6cbab039a91e24a95150a29d92688256ef9923d1e3b0b7f4612b45a2e`の`published`状態へ遷移した。
