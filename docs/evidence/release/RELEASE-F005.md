# F005 v0.5.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-21 09:37 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `9293852043f2cb76544598d8e23989e49aa2af95`
- tag: `v0.5.0`
- GitHub Actions run: `32432910266`
- production artifact ID: `9429844733`
- production artifact SHA-256: `b00b21b44e2cc150d81ed9df57740610887cd9fc95db7124296b3f4609cc7c2e`
- dist SHA-256: `668460423c77d116dc694d9428eede4454ae43bc78c790dcdc2709091d0ffbde`
- catalog SHA-256: `20338c968177ed5fb7494da7234b89007fdbca3bbfbbca8bb9150cb55f21f361`

## リリース経路の方針転換(CHG-F005-083)

F005専用のETW検証付きリリースパイプライン(FUN-F005-035〜039等)は設計のみで未実装だったため、オーナー承認のもとF001〜F004・v0.4.1パッチ(PR #3)で実績のある汎用経路(`scripts/verify-project.mjs` + GitHub Actions `PAGES_DEPLOY_ENABLED`/`PAGES_DEPLOY_COMMIT`ゲート)を採用した。

## mainマージ後に発覚したCI red対応(CHG-F005-084、以降)

1. `feature/F005`を`origin/main`へfast-forward pushした直後、native guard(Windows専用ETW機構)に依存するテストがubuntu-latest CIで失敗。既存の`it.runIf(process.platform === 'win32')`パターンを22件・期待値OS分岐を2件へ適用し解消(CHG-F005-084)。
2. 2回目のCI実行で、`f005-catalog.test.ts`の`beforeAll`が`git clone --branch feature/F005`していたためCI環境(ローカルにfeature/F005 refが存在しない)で失敗。branch名指定を除去し、対象commitへの直接checkoutのみへ変更して解消。
3. 3回目のCI実行でbuild/deploy共に成功。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、4作者 |
| 芥川龍之介route | 3作品 |
| 宮沢賢治route | 6作品 |
| 太宰治route | 3作品 |
| 夏目漱石route | 3作品(夢十夜・倫敦塔・趣味の遺伝) |
| 夏目漱石作者画像 | HTTP 200 |
| 夏目漱石artwork-provenance | HTTP 200 |
| CatalogV2 | 4作者・15作品(既存3作者12作品674台詞662音声は不変) |
| 趣味の遺伝の公式表現注意 | Catalogへ反映済み(FUN-F005-014実装、CHG-F005-081) |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。
