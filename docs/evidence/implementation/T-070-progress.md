# T-070 中間実装・安全停止証跡

## 現在の判定

- 対象: 夏目漱石「夢十夜」`000799`
- 中間実装commit: `1f9db443d39fc4664ba21675e1202ede402fd897`
- 容量予測commit: `1715397`
- 最新原典再確認commit: `d086208`
- 二段受入commit: `8e0aa42`
- runner SHA正本修正・実preflight commit: `7329f55`
- 判定: **継続中（T-070は未完了）**
- 二段作品受入・runner独立受け入れ: High 0 / Medium 0 / Low 0
- 残件: 手動昇格なしでkernel ETWを利用できる環境での実音声生成・作品受入

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
- `scripts/f005-run-work.ts`へvoice→build→preview→build→stageの監視session内5 phase、session close後のactual測定、metadata-only finalizeを接続した。
- native identity必須のrename/delete CAS、全transaction事前走査、同一SHA・別identity差替えの保持、phase別crash回復を実装し、CHG-F005-002とT-076を完了した。
- runnerがcapacity forecastのApproved Context結合SHAを台詞候補file SHAと誤比較していた不整合を、`candidate + definition + policy`の正本関数へ統一した。両SHAが異なる正常case、stale forecast、非canonical候補の回帰試験を追加した。

## 安全停止理由

- commit `7329f55`のclean HEADでproduction runnerを実行し、Approved Context SHA照合まで通過した。
- 固定native binaryの実preflightは`F005_ETW_PRIVILEGE_REQUIRED`で停止した。現在のCodex processはMedium integrityであり、kernel ETW正常系を開始できない。
- 手動UACや監視なしfallbackは使用していない。したがって音声生成、accepted audio、manifest `accepted`、`public`更新は行っていない。

## 検証結果

- runner修正重点回帰: 2 files / 44 tests PASS
- 二段受入重点回帰: 7 files / 180 tests PASS
- 独立再開受入: High 0 / Medium 0 / Low 0
- 二段受入・production runner独立受入: High 0 / Medium 0 / Low 0
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS、697 files / 229,936,251 bytes
- `npm audit --audit-level=high`: 脆弱性0
- 全体回帰: 70 files / 1,241 tests PASS
- `git diff --check`: PASS

## 非変更範囲

- `public`は694 files / 229,844,709 bytesの固定v0.4.0と一致し、差分0である。
- F005 manifestは`draft`、3作品はすべて`pending`のままである。
- F005の音声、native closed journal、actual容量、作品単位受入、サイト公開は未実施である。

## 次の作業

1. 手動操作なしでkernel ETWを利用できる実行環境になった時点でproduction runnerを再実行する。
2. runner内の容量再計測を通過した場合だけ、62音声を生成する。
3. native closed journalと全証拠を再読込し、`000799`を作品単位でatomic acceptedへ昇格する。
