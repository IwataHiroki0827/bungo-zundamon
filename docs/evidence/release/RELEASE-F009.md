# F009 v0.9.0 リリース結果

- 判定: PASS
- 公開日時: 2026-08-24 04:02 JST
- 公開URL: https://iwatahiroki0827.github.io/bungo-zundamon/
- release commit: `5327f12767d02a0da44856018ada5b6c63db6adc`
- tag: `v0.9.0`
- GitHub Actions run: `32659045364`
- production artifact ID: `9498451724`
- production artifact SHA-256: `66cb15e4579007bb44488fb8cbbc7e51f1ad93cb3503254f5ada54cee41ee4ee`
- dist SHA-256: `6f5a826bf7b95b9908c26f8a58739b0f3817ab6419013c9e452b5dfe3128ea93`
- catalog SHA-256: `da8f51748206d057c28636bfe78cb04b7e723e2b43965cd0ecf2cbc690f14bca`

## 実装中に発見・対処した実問題

1. **F008 batch.jsonの未published状態(既知パターン)**。F005〜F007で確認済みの`recordPublishedBatch`相当のstatus更新が欠落するパターンがF008にも残っており、F009の`loadAcceptedBatches`が既存7作者を6作者としてしか認識できず`verifyF009ArtworkAgainstCatalog`の「既存7作者以上」チェックで発覚した。実evidence(`F008-deployment.json`/`F008-smoke.json`、GitHub Actions run 32647228172)を根拠に`scripts/f008-mark-published.ts`で是正した(コンテンツ本体は無変更)。
2. **rightsSnapshotIdsの空欄(既知パターン)**。F005〜F008と同型で、F009のbatch.jsonもbatch level `rights-verified`遷移を経由せず`rightsSnapshotIds`が空のままだったため、`scripts/f009-backfill-rights-snapshot-ids.ts`で実evidence(`source-snapshots/selection.json`)から是正した。
3. **長大候補分割の初の実end-to-end発動(REQ-F009-019)**。死後の恋の実測1,748文字候補が、F007で発見・F008で踏襲されたが実データでは一度も発動していなかった600文字閾値の分割ロジックを、F009で初めて実際にトリガーした(3 piece、632/628/344文字)。DD-F009.mdの設計どおり、分割後の各pieceを独立二重判定・独立VOICEVOX合成した。
4. **外字(gaiji)検出の常時有効化(REQ-F009-007)**。瓶詰地獄・死後の恋の地の文に実在する`class="gaiji"`要素(F005〜F008の9作品では一度も検出されなかった新規パターン)に対し、F008と異なり検出手順を無効化せず選定時・公開直前の両方で常時有効のまま適用し、候補内0件を確認した。

## 公開後スモーク

| 対象 | 結果 |
|---|---|
| トップ | HTTP 200、8作者 |
| 芥川龍之介〜江戸川乱歩route | 既存分・不変(7作者24作品1199台詞) |
| 夢野久作route | 3作品(瓶詰地獄・きのこ会議・死後の恋) |
| 夢野久作作者画像 | HTTP 200 |
| 夢野久作artwork-provenance | HTTP 200 |
| 夢野久作音声ファイル(瓶詰地獄サンプル) | HTTP 200 |
| 夢野久作provenance(002381) | HTTP 200 |
| CatalogV2 | 8作者・27作品・1226台詞・1209音声(既存7作者24作品1199台詞は不変) |
| candidateCounts.byBatch.F009 | published=27・editorialExcluded=14(NON_SPEECH)・audioExcluded=0を実データで確認 |
| 瓶詰地獄・死後の恋の公式表現注意 | work-list/work-detail/creditsの3配置へ表示(きのこ会議には非表示)、実ブラウザe2eで検証 |
| F009固有e2e spec | 4 tests全PASS(public/昇格後にローカル実行して確認)、フルe2eスイート253 passed・5 skipped・失敗0 |

デプロイ完了後、`PAGES_DEPLOY_ENABLED`を`false`へ戻し、`PAGES_DEPLOY_COMMIT`を次回リリースまで無効化する運用とする。

## 次のアクション

「10人になるまで進めて」directiveに従い、F010(9人目、次点候補の要求分析)を継続する。現在8作者/目標10作者。
