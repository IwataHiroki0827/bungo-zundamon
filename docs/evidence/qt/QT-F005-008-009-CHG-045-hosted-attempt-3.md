# QT-F005-008/009 CHG-F005-045 hosted attempt 3

- commit: `80387641d4cc39587a3a0aa02132a3e46e108c9a`
- Program SHA-256: `bdfeb0655295f2405fc8d14f269eb9bc3c53797233a8e36ed7b56f4be8ff367b`
- production: run `31221410484` FAILURE（対象診断への安全停止）
- Pages: run `31221412704` build failure / deploy skip
- failure progress: `temporary-written`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_ACTIVE_PRODUCER_RESERVATION_BIRTH_RECORD_MISSING`
- candidate branch: 不存在

CHG-F005-045が追加した予約handler時未観測の固定分類へ到達した。T-119のhosted影響確認はPASSであり、candidate保存・公開は行っていない。
