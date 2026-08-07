# QT-F005-008/009 CHG-F005-045 hosted attempt 1

- commit: `4a2152aefda335b0f109c4f3cb2d838669108d6e`
- Program SHA-256: `bdfeb0655295f2405fc8d14f269eb9bc3c53797233a8e36ed7b56f4be8ff367b`
- native probe: run `31220780207` SUCCESS
- production: run `31220780289` FAILURE（安全停止）
- Pages: run `31220780215` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE`
- candidate branch: 不存在

T-119の予約時producer birth分類へは未到達だった。既知の前段post-reservation writeでfail-closedし、candidate保存・公開は行っていない。同一Program pinでhosted attempt 2へ継続する。
