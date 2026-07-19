# F002 設計レビュー証跡

## 対象

- 機能設計書: `docs/design/FD-F002.md`
- 関数設計書: `docs/design/DD-F002.md`
- 対象要求: REQ-F002-001〜REQ-F002-020
- 最終設計ID: DES-F002-001〜DES-F002-016、FUN-F002-001〜FUN-F002-040
- 実施日: 2026-07-20

## レビューパネル

| 観点 | 初回判定 | 最終判定 |
|---|---:|---:|
| 要求・設計・関数・状態遷移の整合性 | REDO（High 1 / Medium 3） | PASS（High 0 / Medium 0 / Low 0） |
| 現行コードからの実現可能性・運用可能性 | REDO（High 2 / Medium 6） | PASS（High 0 / Medium 0 / Low 0） |
| セキュリティ・権利・公開境界 | REDO（High 0 / Medium 6） | PASS（High 0 / Medium 0 / Low 0） |

レビューは各修正後に現行文書を読み直して反復し、最終判定は3観点とも未解消指摘0件で確定した。

## 主な修正

- 3作品をwork単位の`pending → extracted → reviewed → budget-approved → voiced → accepted`で直列処理し、後続作品のpendingが先行作品を停止しない契約へ変更した。
- 容量判定を生成前forecastと生成後actualへ分離し、音声、Git object、完全なPages dist、作業ディスクをbyte単位で検査するようにした。
- F001 baselineをprebuild読込、統合content不変検査、最終dist不変検査へ分離し、芥川3作品・59音声を同じcontent/dist SHAへ拘束した。
- work-previewへactive manifest、先行accepted work、当該stagingを渡し、現作品までの累積treeと完全distを検証するようにした。
- 検証済みF002 WAVをwork別の`accepted-audio`へbatch lock・journal付きでatomic昇格し、manifestと冪等に結合した。`.cache`への依存を除いてclean checkoutから再現可能にした。
- releaseを`source/manifest/codeのcommit → prepare-release → publicのcommit → exact SHAのrelease-verify`へ分離し、commit SHAの循環を解消した。
- release treeを既published batch全件と今回のaccepted候補1件だけに限定し、batch ID・feature・commitを承認、artifact、deploy、published遷移まで結合した。
- 規約取得のSSRF対策、VOICEVOX loopback限定、path/reparse point拒否、atomic promotion、Windows回復、secret非公開、作者画像provenanceを関数契約へ明記した。

## 機械検証

- 文書構造: REQ 20件、DES 16件、FUN 40件。DES/FUNは欠番・重複なし。
- 関数契約: FUN 40件すべてに入力、出力、エラーcodeを定義。
- IDカウンタ: `counters.F002.DES: 16`、`counters.F002.FUN: 40`。
- traceability: REQ→QT、REQ→DES、DES→FUNの対応漏れ0件。
- `trace_check`: DES→UT/ITの16件だけ未作成。これは次工程T-018でUT-F002/IT-F002を作成すると解消する計画済みgapであり、設計工程の未追跡ではない。

## 結論

設計承認ゲート②へ進める。承認後はT-018でUT-F002・IT-F002を作成し、DES→UT/ITの16件を閉じる。
