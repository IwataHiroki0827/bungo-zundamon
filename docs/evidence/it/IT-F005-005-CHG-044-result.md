# IT-F005-005 CHG-F005-044 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 593/593件PASS
- 関連Vitest: 5 files / 128件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `f52f120b11a0e8eb1b41c8803afcc070645f2f732fd4c2487b423f3b94df84f6`
- binary SHA-256: `5d1b2cc01152acfc2b5bfdac2d79fadad45c2324bdb8e26c4fdb54d7bbcbd247`
- binary size: 75,151,196 bytes
- 外部exact code: 39件（変更なし）
- `public/`・`data/`差分: 0件
- 独立受入: 初回High 0 / Medium 1 / Low 0、修正後High 0 / Medium 0 / Low 0でPASS

単一late candidate、exact `POST_RESERVATION_WRITE`、System/BIRTH_MISSING、nonzeroかつunbound FileObject、CompletedRetained旧seal parent、同一active voice phase、別active lease、phase instance一致、same parent、active予約後の完全条件だけが`activeDirectoryHandoff`へ進むことを確認した。candidate 0/2、他bucket、setinfo、非System PID、FileObject 0/bound、seal・phase・lease・parent・QPC各falseは引き渡さない。

handoff時はbound-lease認可、failureCode確認、after-lease認可、failureCode確認の順で各1回だけ評価し、両falseかつ非poisonは`F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED`で停止する。reserved/completed SetInfo、known directory認可へfall-throughしない。handoff markerは通常seal、completed-write handoff、post-request replay markerと排他的で、PASS snapshotはSealSequence null、normal epoch、通常`OtherBound` proofを使う。

適用時はretained OtherBound identity、context排他、afterまたはboundのtuple/process、capacityの順を固定した。after processはPID、start key、sequence、signaled、Job membershipとinspection例外をPreflightとApplyの共通helperで再検査する。独立受入の初回Medium指摘後はPreflightとApplyの両方で両context排他を個別process helperより先行させ、拒否時にstateを変更しない構造を一致させた。proof-present/immediateの双方でcontext検査を省略せず、外部39 code、IPC、公開データは変更しない。実Windows ETWでの到達確認はQT-F005-008/009のhosted再観測へ引き継ぐ。
