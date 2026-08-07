# IT-F005-005 CHG-F005-042 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 556/556件PASS
- 関連Vitest: 5 files / 126件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- 独立受入: PASS（High 0 / Medium 0 / Low 0）
- Program SHA-256: `9e63d4aa05f34fa4a0a70a75f69ca5b86b78f79ab4c44da72f0d8c401554c10a`
- binary SHA-256: `16ad073892f52cf725ef8b95ef5044ac41984974708c4070dac4b6b1ecd7980f`
- binary size: 75,147,100 bytes
- `public/`・`data/`差分: 0件

epoch 0の単一late candidateがexact `SETINFO_SEAL_NOT_COMPLETED_RETAINED`で、sealが同一active voice phaseの`CompletionRequested`、current path・lease FileObject exact generation、`CompletionRequestedAtQpc < eventQpc <= DrainDeadlineQpc`、completed record不存在を満たす場合だけ、`PostRequestSystemSetInfo` marker付きでsealed replayへ接続することを確認した。候補0/2、write、parent、他bucket、deadline欠落・超過、record存在は停止し、後段認可へfall-throughしない。

replay前はmarker、SealSequence、`SealedCurrent` proof、EventCountを固定し、event/path/state/QPC/deadline/record不存在、proof kind・generation・state・path、producer tuple、effective/proof/retained current identity、retained process PID/start key/sequence/signaledを再検査する。通常epochとの重複、T-115 completed-write handoffとの混同はなく、queue/counter final fence、completed record作成、`CompletedRetained`遷移、atomic rollback、外部35 codeを維持した。実Windows ETWでの本bucket通過または次の固定拒否stageはQT-F005-008/009のhosted再観測へ引き継ぐ。
