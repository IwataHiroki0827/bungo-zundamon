# QT-F005-008/009 CHG-F005-049 hosted attempt 2

- commit: `72f6bc1d16eeb6997ff6d6a4938967a5051c21bc`
- Program SHA-256: `95235ee661203e805e40234dc410c04d88d0e2f0f9ad2a7d29612490807ecd0f`
- production: run `31232225868` FAILURE（安全停止）
- Pages: run `31232225848` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE`
- candidate branch: 不存在

attempt 1とは異なる既知前段のpost-reservation writeでfail-closedし、T-123のcandidate多重性分類へ未到達だった。candidate保存・公開は行わず、同一Program pinの最終attempt 3へ継続する。
