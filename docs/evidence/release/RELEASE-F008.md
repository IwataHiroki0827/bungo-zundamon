# F008 v0.8.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-24 00:26 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `bddf37c7d25ff57fb6ecde9d6bc8a1f06139f197`
- tag: `v0.8.0`
- GitHub Actions run: `32647228172`
- production artifact ID: `9495528656`
- production artifact SHA-256: `c7ec3229764bcb3e1c9ea221b96efcababb7ead44b62666771b27b37c0877c04`
- dist SHA-256: `842042cfc8683fa7aa1d7e4aa3e38034b6d90360b093b7d4a536f75afbafc330`
- catalog SHA-256: `b46bfd5dd78d0ac6b343a2ee202acec901dc1394e8752df3129de2f3dc66e5cc`

## 実装中に発見・対処した実問題

1. **capacity forecastの自己悪化バグ(CHG-F008-001)**。`forecastCapacity`の`plannedPagesBytes`が現行`public/`サイズの100%倍増(単純ダブリング)を仮定していたため、`public/`が約375MBを超えた時点で`CAPACITY_FORECAST_PAGES_EXCEEDED`が発生する自己悪化構造だった。F008ローカルの`scripts/f008-prepare-voice.ts`のみへ、実測に対し十分な安全マージンを持つ固定150MB上限を実装して解決(真の安全網である`verifyActualCapacity`は倍増していない実バイト数を使用するため安全性は変わらない、共有汎用モジュールへは一切手を入れていない)。
2. **resume時のforecast不一致(CHG-F008-002)**。`budget-approved`遷移後に`f008-prepare-voice.ts`を再開すると、既に遷移が反映された最新manifestから`preManifestSha`を再計算していたため、保存済みforecastの`plan.planDigest`と一致せず必ず失敗していた。resume時は永続化済みforecastの`expectedManifestSha`を再利用するよう修正した。
3. **VOICEVOX長時間生成のharness制約(CHG-F008-003)**。Ｄ坂の殺人事件(85候補)の長時間音声生成がハーネスにより約2〜5分ごとに外部終了させられる問題に対し、staging済みWAVを永続cacheへ昇格・workを`reviewed`へ巻き戻して再開する累積的retryの型を確立して解決した(45個の残留zombie node.exeプロセスが一因と判明、`taskkill`で解消)。
4. **audioId衝突(CHG-F008-004、最も広範な調査)**。一人二役の候補「へええ」がF005/001104の既存候補と偶然同一のaudioId(入力text+config由来のhash)を持つが、実データ上の音声実体(WAVバイト列)は異なることが判明した。`src/ui/render.ts`が「1つのaudioAssetにつき音声資産は必ず1件・所属batchIdは自work一致」という書き換え不能な不変条件を持つため、build時のvalidation緩和(2案とも試行)は根本解決にならないと判断し、両方の緩和を完全撤回した(共有/凍結モジュールは最終的に無変更)。代わりに既存schemaの`audioExcluded`/`audioFailureReasons`機構(F002〜F007では常に0件で未使用)を初めて実使用し、当該候補1件のみを音声段階で公開から除外した(内容上の却下ではない、editorial承認は維持)。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、7作者 |
| 芥川龍之介〜森鴎外route | 既存分・不変(6作者21作品1099台詞) |
| 江戸川乱歩route | 3作品(人間椅子・Ｄ坂の殺人事件・一人二役) |
| 江戸川乱歩作者画像 | HTTP 200 |
| 江戸川乱歩artwork-provenance | HTTP 200 |
| 江戸川乱歩音声ファイル(人間椅子サンプル) | HTTP 200 |
| 江戸川乱歩provenance(056648) | HTTP 200 |
| CatalogV2 | 7作者・24作品・1199台詞・1182音声(既存6作者21作品1099台詞は不変) |
| candidateCounts.byBatch.F008 | audioExcluded=1・AUDIO_ID_COLLISION1件(「へええ」)を実データで確認 |
| 人間椅子・Ｄ坂の殺人事件の公式表現注意 | work-list/work-detail/creditsの3配置へ表示(一人二役には非表示)、実ブラウザe2eで検証 |
| F008固有e2e spec | 4 tests全PASS、フルe2eスイート229 passed・5 skipped・失敗0 |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。

## 次のアクション

「10人になるまで進めて」directiveに従い、F009(次点候補: 夢野久作、人物ID96、DOMAIN-F005.md/DOMAIN-F006.md記載のランキング準拠)の要求分析パイプラインを継続する。現在7作者/目標10作者。
