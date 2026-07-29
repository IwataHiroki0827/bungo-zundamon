# T-070 中間実装・安全停止証跡

## 現在の判定

- 対象: 夏目漱石「夢十夜」`000799`
- 中間実装commit: `1f9db443d39fc4664ba21675e1202ede402fd897`
- 容量予測commit: `1715397`
- 最新原典再確認commit: `d086208`
- 判定: **継続中（T-070は未完了）**
- 独立受け入れ: High 1 / Medium 0 / Low 0
- High残件: production runnerが未実装

## 完了した作業

- 青空文庫の公式書誌、作者ページ、3作品のカード・XHTMLと、VOICEVOX・ずんだもんの3規約をcanonical snapshotへ固定した。
- HTTP charsetが省略された実公式応答では、本文先頭16 KiB内の宣言charsetを厳格に照合する。矛盾・複数宣言・未知値は拒否する。
- 保存済みselection snapshotを再起動後に再読込し、native handle、path、SHA、bytes、ZIPから再導出したCSV、書誌、規約判断、Approved Contextへ再結合できるようにした。
- 17,156,699 bytesの実書誌CSVを64 MiB固定上限内で安全に読めるようにし、hardlink・junction・読込中のidentity変更を拒否する。
- `2026-07-29T05:39:32.444Z`にpredeploy再取得を行い、selectionからのdriftなし、権利・利用条件`allow`を確認した。
- 65候補を独立二重レビューし、run-03で63採用・2除外・保留0のAgreementを確定した。採用63件は重複をまとめて62音声となる。
- candidate safetyをPASSし、既存WAV 13,401件を照合して完全一致0、生成62件、追加音声見積り12,521,800 bytesを確定した。
- planned audioを含む6区分容量予測を実行し、workspace peak 12,521,800 bytes、peak後空き7,816,679,096 bytes、警告0でPASSした。
- Windows native guardへJob Object、kernel ETW FileIO、認証named pipe、session通算sequence、相対path、durable journalを実装した。
- native journalのphase、notice、ETW observation、producer pin、path/from/to、容量集計をTypeScript側でも再計算し、actual容量測定へ接続した。
- preview 6証跡と受入6証跡を実path・SHA・kind・workId・preview SHAへ結合し、closed recoveryでもmanifest・backup・targetを再検証する。

## 安全停止理由

- production runnerがまだなく、`startF005NativeCapacitySession`、音声生成、preview、actual容量測定、atomic acceptを一本の実運用経路で接続できていない。
- 固定native binaryの実preflightは`ETW_PRIVILEGE_REQUIRED`で停止した。現在のCodex processはMedium integrityであり、kernel ETW正常系を開始できない。
- 手動UACや監視なしfallbackは使用していない。したがって音声生成、accepted audio、manifest `accepted`、`public`更新は行っていない。

## 検証結果

- F005重点回帰: context/source/foundation/review/voice/native/acceptanceの8 files / 182 tests PASS
- 独立再開受入: High 0 / Medium 0 / Low 0
- 独立T-070全体受入: 修正済み5論点PASS、production runner High 1のためREDO
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS、697 files / 229,936,251 bytes
- `npm audit --audit-level=high`: 脆弱性0
- 全体回帰: 1,160 PASS / 5 timeout。timeout 5件は単独再実行79/79 PASSで、機能失敗は0件
- `git diff --check`: PASS

## 非変更範囲

- `public`は694 files / 229,844,709 bytesの固定v0.4.0と一致し、差分0である。
- F005 manifestは`draft`、3作品はすべて`pending`のままである。
- F005の音声、native closed journal、actual容量、作品単位受入、サイト公開は未実施である。

## 次の作業

1. production runnerを実装し、forecast・voice・preview・build・accept・actualの循環しない証拠順序を確定する。
2. 手動操作なしでkernel ETWを利用できる実行環境を用意できた場合だけ、62音声を生成する。
3. native closed journalと全証拠を再読込し、`000799`を作品単位でatomic acceptedへ昇格する。
