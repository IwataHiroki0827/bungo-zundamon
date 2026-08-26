# F011 v1.0.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-26 12:39 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `06a7066d5d0ac08f81be1febac4e2dcebd5d3b2b`
- tag: `v1.0.0`
- GitHub Actions run: `32926144352`
- production artifact ID: `9591962599`
- production artifact SHA-256: `65aa6e90ee7f2327ba805a5c19eeea0c606768d98952cd753fae7c4958f0d7f0`
- dist SHA-256: `6ea42fc9261ffc9c59c712f83b1af4e11ecf34eb8827518f9941942dda032e67`
- catalog SHA-256: `f9b63298aae468ddeb3856cfe3006c3c40a61c3831fd7399ace7224dba8d0625`

## 「10人になるまで進めて」directive達成

本リリースで新美南吉(にいみなんきち)を10人目・最終目標の作者として追加し、基礎3作者+追加7作者=合計10作者の作者拡充目標を達成した。これに伴い、0.x系のプレリリース運用から1.0.0(最初の安定マイルストーン)へバージョニング方針を移行した。

## 実装中に発見・対処した実問題

1. **ごん狐(000628)のaudioId string衝突(既知パターン、CHG-F011-001)**。2候補が既公開v0.10.0 baselineのaudioIdと偶然一致し、`CHG-F008-004`で確立した`audioExcluded`機構により音声段階でのみ除外した(候補自体は編集承認済みのまま)。
2. **手袋を買いに(000637)のbyte内容重複(新規発見、CHG-F011-002)**。`npm run build`のローカル検証(`scripts/release-checks.mjs`の`verifyAssetBudget`)が`DUPLICATE_AUDIO_HASH`で検出。候補`PZmXbdvjp3qGWT0xGU3bSIXS1SevkBxRog70My_3brE`(「あっ」という短い感嘆詞)の合成音声が、F008の既公開音声とaudioId(text+config由来)は異なるにもかかわらずVOICEVOX出力のbyte内容が偶然一致していた。audioId自体は衝突していないため CHG-F011-001 とは異なる root cause と判断し、新規`AUDIO_CONTENT_DUPLICATE`理由コードを追加したうえで同じ`audioExcluded`機構で解消した(`computeExclusionCounts`のreason override機構を拡張)。この過程で000628・004718も一時的にaccept順序制約(work配列内の前方work完了必須)により巻き戻し・再受理が必要になったが、両作品の候補・レビューデータ自体は無変更。
3. **e2e specの台詞数期待値の追随**。上記2件のaudio除外反映後、合計台詞数が当初想定の68(27+30+11)から実測67(26+30+11)へ変化したため、`tests/e2e/f011-niimi-author.spec.ts`の期待値を実測値へ更新した。
4. **F005 native guard binary欠損(環境要因、無関係)**。ローカル検証時に`.cache/dotnet-f005/publish/f005-guard.exe`が存在せずF005関連テストがcascade的に失敗した。`native/f005-guard/build.ps1`(公式.NET SDK取得→pinned SHA-512照合→publish→固定実行ファイルSHA検証)で再構築し解消。F011実装とは無関係な環境セットアップ欠落。
5. **`f005-catalog.test.ts`の既知環境フレーク(無関係、対応不要と判断)**。同specは固定した過去commit(`0c4c5ba2234df5443b65ee1c2a0a6370e44e0d28`、F005era)へ`git clone --shared`+checkoutして`content/batch-candidates.json`のcanonical JSON自己検査を行うが、このWindows環境のglobal `core.autocrlf=true`と、当該過去commitが`.gitattributes`の`*.json text eol=lf`ルール追加より前のものであることの組み合わせにより、checkout結果がCRLF化しcanonical検査に失敗する。現HEADの変更内容とは無関係な、frozen historical commit checkoutのgit環境依存フレークであることを、vitest外で同じclone+checkoutを再現して確認済み。F011機能自体には影響しないため本リリースをブロックしない。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、10作者 |
| 芥川龍之介〜梶井基次郎route | 既存分・不変(9作者30作品1247台詞) |
| 新美南吉route | 3作品(手袋を買いに・ごん狐・二ひきの蛙) |
| 新美南吉作者画像 | HTTP 200 |
| 新美南吉artwork-provenance | HTTP 200 |
| 新美南吉音声ファイル(手袋を買いにサンプル) | HTTP 200 |
| 新美南吉provenance(000637/000628/004718) | HTTP 200(3件とも) |
| CatalogV2 | 10作者・33作品・1314台詞・1296音声(既存9作者30作品1247台詞は不変) |
| candidateCounts.byBatch.F011 | audioExcluded=3(AUDIO_ID_COLLISION×2 + AUDIO_CONTENT_DUPLICATE×1)を実データで確認 |
| 3作品の公式表現注意 | 「非存在」を実ブラウザe2eで明示確認(work-list/work-detail/creditsの全配置で0件) |
| F011固有e2e spec | 4 tests×6ブラウザ=24/24 PASS、フルe2eスイート301 passed・5 skipped・失敗0 |
| vitest全件(fileParallelism=false) | 1643 passed・1 file failed(上記5.の環境無関係フレークのみ) |
| GitHub Actions build job | 初回・2回目は既知flaky(baseline.test.ts 5000msタイムアウト・batch-runtime.test.ts 30000msタイムアウト・offline-build.integration.test.tsのVite pluginタイミング出力ノイズ)で失敗、3回目再実行でPASS |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。

## 次のアクション

「10人になるまで進めて」directiveの作者拡充目標(合計10作者)を本リリースで達成した。追加の作者拡充(F012以降)は本directiveの範囲外であり、着手にはユーザーからの新規の明示的指示が必要。
