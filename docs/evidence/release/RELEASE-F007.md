# F007 v0.7.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-22 22:51 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `ab3db17bace7994df3ffccbbfd022a3662480149`
- tag: `v0.7.0`
- GitHub Actions run: `32576610868`
- production artifact ID: `9476796105`
- production artifact SHA-256: `94cc707a5e8a443983bb2644664c561e8eb8bcdaec6dde7d74a04a3eb6283173`
- dist SHA-256: `fa70c69e779ffc97fd0ec634ce7e67ad3b1ace24ebe9b6718b306f7aa6312cc6`
- catalog SHA-256: `66e2c91e0630be6e2e593761e6f5711cbd12058fd48d93d8326f8b014cfa33b0`

## 実装中に発見・対処した実問題

1. **VOICEVOX synthesis長大候補500エラー**(高瀬舟order12、speechText 2408文字)。実際に二分探索で境界を確定し(prefix 1334文字まで成功、1335文字以上でHTTP 500)、原因は特定の悪い文字ではなく長さそのものに起因する実在のengine制約と判明した。F007ローカルの抽出層(`src/content/f007-source.ts`)へ600文字閾値(実測境界に対し2倍以上の安全マージン)での句点分割を実装し解決した。F001〜F006が依存する共有汎用モジュール(`src/voice/generation.ts`等)へは一切手を入れていない。
2. **F006 batch.jsonのpublished未反映**(F005と同型の既知パターン)。F007のwork-preview構築が先行batchのstatus='published'を要求するため、F006側の未反映がF007の作者画像provenance完全検証(既存5作者要求)をブロックしていた。実evidence(T-156で作成済みのF006-{deployment,smoke}.json)を根拠に`scripts/f006-mark-published.ts`で是正した。
3. **ディスク容量逼迫**(55GB→7.5GB、930GBの0.8%)。原因はbungo-zundamon自体ではなく、同一マシン上のComfyUI outputフォルダ(2026年4月から他プロジェクト分も含め無制限蓄積、89.6GB/64,272ファイル)だった。ユーザー承認を得て直近7日分を残し84.8GB削除、92.5GBまで回復させた(KB-0010として知見化)。
4. **F007固有e2e specの欠落**。F005/F006の前例(専用author route spec)に反し、F007にはmori-ogai route固有のspecが無く、既存汎用スイートの全PASSはF007固有の描画・notice表示を実際には検証していなかった。`tests/e2e/f007-mori-ogai-author.spec.ts`を新規作成し実データで検証した。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、6作者 |
| 芥川龍之介〜中島敦route | 既存分・不変(5作者15作品) |
| 森鴎外route | 3作品(舞姫・高瀬舟・山椒大夫) |
| 森鴎外作者画像 | HTTP 200 |
| 森鴎外artwork-provenance | HTTP 200 |
| 森鴎外音声ファイル(舞姫サンプル) | HTTP 200 |
| CatalogV2 | 6作者・21作品・1099台詞(既存5作者18作品939台詞は不変) |
| 舞姫の公式表現注意 | work-list/work-detail/creditsの3配置へ表示(高瀬舟・山椒大夫には非表示)、実ブラウザe2eで検証 |
| F007固有e2e spec | 4 tests全PASS、フルe2eスイート205 passed・5 skipped・失敗0 |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。

## 次のアクション

「10人になるまで進めて」directiveに従い、F008(次点候補: 江戸川乱歩、DOMAIN-F006.md記載のランキング準拠)の要求分析を継続する。現在7作者/目標10作者。
