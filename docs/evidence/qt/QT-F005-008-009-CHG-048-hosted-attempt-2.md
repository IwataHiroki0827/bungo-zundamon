# QT-F005-008/009 CHG-F005-048 hosted attempt 2

- commit: `18f7e58d1cce067ef9505f2aec39d735b0a4145d`
- Program SHA-256: `db59663c44f5cb18dd66882f1ab8c721ef17c3e574fe509f1f6a1a5551ff8018`
- production: run `31229994538` FAILURE（安全停止）
- Pages: run `31229994493` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_ACTIVE_LEASE_MISSING`
- candidate branch: 不存在

attempt 1とは異なる既知前段のactive lease検査でfail-closedし、T-122のevent tuple固定6分類へ未到達だった。candidate保存・公開は行わず、同一Program pinの最終attempt 3へ継続する。
