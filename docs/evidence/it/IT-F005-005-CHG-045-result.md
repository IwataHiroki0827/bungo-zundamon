# IT-F005-005 CHG-F005-045 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 623/623件PASS
- 関連Vitest: 5 files / 128件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `bdfeb0655295f2405fc8d14f269eb9bc3c53797233a8e36ed7b56f4be8ff367b`
- binary SHA-256: `9a46e600c8f0c71accfd7b87d8d0052ad43f05f8c0e01c5e9d93d2a410d5a773`
- binary size: 75,155,292 bytes
- 外部exact code: 43件
- `public/`・`data/`差分: 0件
- 独立受入: 初回High 0 / Medium 1 / Low 0、修正後High 0 / Medium 0 / Low 0でPASS

`ReserveWrite`の同一gate内でproducer identity後に予約QPCを1回、`processBirthByPid`を1回だけ取得し、record有無・sequence・started QPCとproducer/phase/reservation scalarをconstructor-only `ObservedProducerBirthSnapshot`へ保存することを確認した。`PendingWriteLease`はget-only propertyで所有し、`ProcessBirthRecord`やmap参照を保持しない。

snapshot後のmap追加・上書き・削除、同一PIDの別sequence callbackでも保存値は変わらない。予約QPC以前のProcessStartがgate待ちとなるfixtureでも予約handler時の未観測missingを維持する。record 0/1、sequence、phase→birth→reservation境界、PID/start key/lease sequence/record sequence/phase instance/phase start/reservation/eventの単独falseを固定した。

既存classifierを1回先行し、record有りのtuple mismatch、birth同値以前、birth後を不変とした。exact record missing時だけfallbackを1回評価し、reservation record missing、tuple mismatch、birth同値以前、birth後の4 exact codeへ排他的に分類する。registered record存在、active lease/phase差、event current予約後はSTATE_CHANGEDで停止する。分類後は同じthrow位置へ進み、後段認可、proof/replay、queue、ledger、semantic、capacity、notice、Observation、seal/lease stateを変更しない。

独立受入の初回Medium指摘後、birth tuple用のinitial reservationとevent上限用のcurrent path reservationを分離した。snapshot initial一致、`phase < birth <= initial`、`current >= initial`、`event <= current`を検査し、initial同値、initial+1/current同値、current+1、current逆転、rename promoteを固定した。rename後の`initial < event <= current`はbirth後codeへ分類し、current逆転とcurrent超過はSTATE_CHANGEDで停止する。

native reply、TypeScript bridge、runner、workflow annotationの43 code集合と127文字上限、unknown/extra code拒否を確認した。実Windows ETWでの到達確認はQT-F005-008/009のhosted再観測へ引き継ぐ。

hosted attempt 1はcommit `4a2152aefda335b0f109c4f3cb2d838669108d6e`で実施した。native probe run `31220780207`はSUCCESS、production run `31220780289`は既存`POST_RESERVATION_WRITE`で安全停止しT-119対象へ未到達だった。candidate branchは作成されず、Pages run `31220780215`はdeploy skipである。同一Program pinのattempt 2へ継続する。
