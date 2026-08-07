# IT-F005-005 CHG-F005-046 結果

- 実行日: 2026-08-08
- 判定: PASS
- native executable rules: 666/666件PASS
- 関連Vitest: 5 files / 129件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `eb384ec09822a65cad00ad969a0986d1903dc47b996e33f60b1a9f6da8353072`
- binary SHA-256: `5c4d6c9340caa551409325fafba6227a08716ab999c60687df053d2b697ba540`
- binary size: 75,163,484 bytes
- 予約fence raw code: 4件
- completion-drain external code: 43件（変更なし）
- `public/`・`data/`差分: 0件
- 独立受入: 初回High 0 / Medium 2 / Low 0、修正後High 0 / Medium 0 / Low 0でPASS

`ReserveWrite`のproducer handle identity初期検査後、同一gateの`Monitor.Wait`で最大10秒だけProcessStart recordを待ち、`ObserveProcessBirth`のmap更新後`PulseAll`で起床することを確認した。QPC deadlineのchecked生成、ceiling millisecond、spurious/false wake後の再判定、absent/stale/duplicate/matching/different fingerprintを固定した。

wake後はfirst failure、Dispose/cancel/journal、deadline、fingerprint、state、processの順に再検査し、保持processのPID/start key/sequence/non-signaled/Job membershipとphase/path/pending leaseを再確認した後だけ予約QPCを1回取得する。共有transactionはsnapshot、lease、pending stateを成功時だけ公開し、raw4各失敗では3状態をすべて未作成に保つ。

初回identity取得例外はprocess identity fixed codeへ限定正規化する。production共有lifecycleを用いた実Task/barrier fixtureで、gate内abort/Pulse、waiter即時起床、first failure保持、cancel、pipe task完了後だけresource破棄となることを動的確認した。raw4から`F005_`付き4 exact codeへのbridge、runner、workflow伝播、unknown/extraのgeneric化、completion-drain 43 code不変もPASSした。

hostedではcommit `5835bec134a13cb24d13aa81a1ff0ab138af28b1`のnative probe run `31224657482`がSUCCESSし、production run `31224657445`は予約fence通過後の`ACTIVE_LEASE_MISSING`へ到達した。candidate branchは作成されず、Pages run `31224657463`はdeploy skipである。
