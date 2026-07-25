# F002 v0.2.0 リリース結果

- 判定: PASS
- 公開日時: 2026-07-26 02:59 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `84c985f382910216e381a96901f6fd569165a27e`
- tag: `v0.2.0`
- GitHub Actions run: `30168689551`
- hosted artifact SHA-256: `08a5beed15eae8c4de2f5eb72601fa1628893799f8f55791a6075811d1ace6fc`
- dist SHA-256: `c60431bd4da3b1ba43ac71e299089f4dc8cbad563a58f3df3d2424fd952d9fde`
- release-verify容量判定: `pass`

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、2作者 |
| 芥川龍之介route | 3作品・59台詞 |
| 宮沢賢治route | 3作品・154台詞 |
| クレジット | 宮沢賢治ずんだもん・VOICEVOX表記あり |
| CatalogV2 | 2作者・6作品・213台詞 |
| F002音声 | HTTP 206、`audio/wav`、Range取得成功 |
| ブラウザconsole/page error | 0件 |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を削除した。公開後のmanifest更新は`recordPublishedBatch`のatomic transactionで実施した。
