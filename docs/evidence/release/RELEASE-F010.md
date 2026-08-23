# F010 v0.10.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-24 06:35 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `88317b3102adf3645a0b8f2cf98541ad78879ad2`
- tag: `v0.10.0`
- GitHub Actions run: `32667081141`
- production artifact ID: `9500556995`
- production artifact SHA-256: `6ad2a3aecc1a3b70b9a490fbe20691af69ec200e023ab5b3b7e6d6f8cf4d42af`
- dist SHA-256: `5da5e5159282e105745429d949c8a3a8e31bcb69e0d52baf95ed58930a16f634`
- catalog SHA-256: `bc760bb5423c44c7e0646c91e24c627377828af7dcc0e64e68f65e738b99e89a`

## 実装中に発見・対処した実問題

1. **F009 batch.jsonの未published状態(既知パターン)**。F005〜F009で繰り返し確認済みの`recordPublishedBatch`相当のstatus更新欠落パターンがF009にも残っており、F010の`loadAcceptedBatches`が既存8作者を7作者としてしか認識できず`verifyF010ArtworkAgainstCatalog`のチェックで発覚した。実evidence(`F009-deployment.json`/`F009-smoke.json`、GitHub Actions run 32659045364)を根拠に`scripts/f009-mark-published.ts`で是正した(コンテンツ本体は無変更)。
2. **rightsSnapshotIdsの空欄(既知パターン)**。F005〜F009と同型で、F010のbatch.jsonもbatch level `rights-verified`遷移を経由せず`rightsSnapshotIds`が空のままだったため、`scripts/f010-backfill-rights-snapshot-ids.ts`(新規作成)で実evidence(`source-snapshots/selection.json`)から是正した。
3. **公式表現注意0件のケース(F005以降初)**。3作品(檸檬・Ｋの昇天・愛撫)いずれも青空文庫図書カードの公式表現注意に該当せず、`TRUSTED_REGISTRY_BINDINGS`へauthorId `000074`のentryを追加しない設計とした。代わりに`f010-catalog.ts`内に`loadF010WorkNotices`を新規実装し、`content/batches/F010/work-notices.json`(dialogue-excerpt-scopeのみ)を直接読み込む経路とした(新規application source分岐は追加せず)。
4. **長大候補分割ロジックの非実装(設計時点で確定)**。実測最大候補長135文字のため、`f010-source.ts`には`splitOverlongF010Candidates`型の分割関数を一切実装しなかった(DD-F010.md DES-F010-015の明示指示)。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、9作者 |
| 芥川龍之介〜夢野久作route | 既存分・不変(8作者27作品1226台詞) |
| 梶井基次郎route | 3作品(檸檬・Ｋの昇天・愛撫) |
| 梶井基次郎作者画像 | HTTP 200 |
| 梶井基次郎artwork-provenance | HTTP 200 |
| 梶井基次郎音声ファイル(檸檬サンプル) | HTTP 200 |
| 梶井基次郎provenance(000424) | HTTP 200 |
| CatalogV2 | 9作者・30作品・1247台詞・1230音声(既存8作者27作品1226台詞は不変) |
| candidateCounts.byBatch.F010 | published=21・editorialExcluded=17(NON_SPEECH)・audioExcluded=0を実データで確認 |
| 3作品の公式表現注意 | 「非存在」を実ブラウザe2eで明示確認(work-list/work-detail/creditsの全配置で0件) |
| F010固有e2e spec | 4 tests全PASS、フルe2eスイート276 passed・5 skipped・失敗1(f009-yumeno-author.spec.tsの既知フレーク、個別再実行でPASS、F010と無関係) |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。

## 次のアクション

「10人になるまで進めて」directiveに従い、F011(10人目、最終目標)の要求分析を継続する。現在9作者/目標10作者。
