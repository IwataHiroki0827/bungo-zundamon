# QT-F005-008/009 CHG-F005-045 hosted attempt 2

- commit: `1dc636acc389b9ba5d00f6876ce865d7a80da5a0`
- Program SHA-256: `bdfeb0655295f2405fc8d14f269eb9bc3c53797233a8e36ed7b56f4be8ff367b`
- production: run `31221136732` FAILURE（安全停止）
- Pages: run `31221136576` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE`
- candidate branch: 不存在

attempt 1と同じ既知前段でfail-closedし、T-119の予約時producer birth分類へ未到達だった。candidate保存・公開は行わず、同一Program pinの最終attempt 3へ継続する。
