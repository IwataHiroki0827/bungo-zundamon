# T-022 実装・受け入れ証跡

## 判定

- タスク: T-022（F001不変照合・容量・repository・Pages・security preflight）
- 対象feature: F002
- 実装判定: PASS
- 独立受け入れ判定: PASS
- 判定日: 2026-07-20

## 実装内容

- F001の固定baseline SHA-256 `722b88affbc84a3e1250bcc1e2e6d538957a02d94483b706bb55609483b9fbc9`と、raw Catalog v1 SHA-256 `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`を外部定数として固定した。
- 追跡raw snapshotからCatalogV2上のF001へ決定的に再構成し、3作品・59台詞・57音声・62公開fileを項目単位と実体hashで照合するようにした。
- 統合後の`public/content/catalog.json`はCatalogV2として扱い、固定raw snapshotとF001画像・音声・provenance等の公開実体検証を分離した。
- work previewとreleaseの双方でoffline Pages distを完全生成し、F001 content invariantとdist invariantを同じbuild/dist tupleへ結合した。
- 容量forecastとactualを分離し、追加音声100 MiB、総Pages 500 MiB警告・750 MiB停止、GitHub Pages 1 GB未満、作業drive必要空き容量を実測値で判定するようにした。
- Git objectはOID単位で重複排除し、repository、公開tree、accepted audio、生成候補、filesystem空き容量をruntimeで測定するようにした。
- production artifactから任意の`appSource`と`outputRoot`を除去し、appはexact workspace、distはworkspace内`.cache`の空random directoryへ固定して終了時に削除するようにした。
- security preflightをstatic build検査とfull release検査へ分離し、full検査では実browser観測、実`npm audit`証跡、悪性fixtureの結果が欠ける場合にblockedとした。
- Pages workflowのcheckout credential保持を無効化し、release検査でstatic結果をfull結果として再利用できないようにした。
- release-verifyをexact clean HEAD、固定baseline、IntegratedBuild再生成、F001 content invariant、offline Pages、F001 dist invariant、release実容量、candidate tuple/digestの順に接続し、公開昇格を行わない検証専用経路とした。

## 重点回帰試験

- baseline自己再hash、固定raw Catalog改変、F001 asset・provenance欠損/改変
- 統合後CatalogV2のpublicに対するF001 allowlist実体照合
- work/releaseの外部app・外部output指定、reparse、非空output、外部書込み0件
- Pages必須shell・JS・CSS・全content asset、offline固定、入力途中改変
- 容量の閾値境界、同一audio SHA重複、Git OID重複、work/release report混線
- releaseの別commit、dirty tree、別dist、artifact改変、blocked actual、work report流用
- CSP、危険DOM、外部通信、secret、dependency audit、workflow action pin
- static security証跡をfull releaseへ流用する偽陽性の拒否

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: 34 files / 621 tests PASS
- `npm run verify:build`: PASS（66 files / 30,423,361 bytes）
- `npm run build`: PASS（66 files / 30,423,361 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- secret pattern scan: 実認証情報0件
- 独立受け入れ再試験: targeted 5 files / 44 tests、content 19 files / 250 tests、全621 tests PASS

## 受け入れ経緯

初回受け入れでは、release-verifyのF001/Pages/容量接続不足とbaselineの自己再hash可能性を差し戻した。再確認で統合後publicを固定raw sourceとして誤用する問題、および任意app/outputへbuildできる境界も検出した。固定raw snapshotの分離、統合publicのF001実体照合、production入出力のworkspace固定、build前拒否とcleanupを追加し、4件すべてを解消した。

## 受け入れ結論

受け入れ担当は、固定F001、Pages完全dist、容量実測、repository/Git object集計、security preflight、release full chain、外部path遮断を実物で確認し、最終的にHigh/Medium不適合なしでPASSとした。
