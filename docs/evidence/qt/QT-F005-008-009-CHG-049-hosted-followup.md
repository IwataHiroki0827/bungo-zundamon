# QT-F005-008/009 CHG-F005-049 hosted後続到達確認

- 確認日: 2026-08-08
- source系統: CHG-F005-050 implementation commit `2d75f58d6595cfd0737ca4ceb470a40f733177c7`
- CHG-F005-049 Program SHA-256: `95235ee661203e805e40234dc410c04d88d0e2f0f9ad2a7d29612490807ecd0f`
- production: run `31233549836` FAILURE（期待した安全停止）
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在
- Pages公開: なし
- 判定: PASS

CHG-F005-050のhosted影響試験中に、前段として残っていたCHG-F005-049のcandidate多重性固定codeへ到達した。候補2件以上を認可せず固定codeへ分離し、candidate保存・公開へ進まないことを確認したため、3 attempt時点の未到達を解消する後続到達証拠としてT-123を完了する。
