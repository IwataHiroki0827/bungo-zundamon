# IT-F005-005 CHG-F005-043 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 573/573件PASS
- 関連Vitest: 5 files / 128件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `28b9eda7db0ab4da6a555cdc94d8a4ce2080d6c7be8316ff7c46119efb565073`
- binary SHA-256: `b5fce071df9137d93b7bdce209ef5e8cbd0ecec67436f5fd0ca5221368abfc43`
- binary size: 75,147,100 bytes
- `public/`・`data/`差分: 0件
- 独立受入: High 0 / Medium 0 / Low 0

exact late `WRITE_AT_OR_BEFORE_ACTIVE_RESERVATION`だけがactive producer birth分類へ進み、active leaseのstart keyでimmutable registered process recordを0/1件に決定することを確認した。record PID/start key/sequence、phase instance、phase→birth→reservation、event→reservationの完全tupleを満たす場合に限りeventをbirth同値以前またはbirth後へ分離し、record欠落とtuple差を含む4固定codeで既存throw位置から停止する。

phase/birth同値・+1、birth/reservation同値・+1、event/birthの-1・同値・+1、event/reservation同値・+1、PID/start key/sequence/phase instance各falseを固定した。分類は1回だけで、`processBirthByPid`、process再inspection、raw process/QPC値を参照しない。全分類が非認可であり、selected seal、proof/replay、queue、ledger、semantic、capacity、notice、Observation、seal/lease stateを変更しない。native/bridge/runner/workflowの39 exact code同期とunknown/extra codeのgeneric化を確認した。実Windows ETWでの4分類到達はQT-F005-008/009のhosted再観測へ引き継ぐ。
