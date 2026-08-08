# QT-F005-008/009 CHG-F005-048 hosted attempt 1

- commit: `9cefde5feebcc55b49d7115d45d64b97e0ba64aa`
- Program SHA-256: `db59663c44f5cb18dd66882f1ab8c721ef17c3e574fe509f1f6a1a5551ff8018`
- native probe: run `31229785170` SUCCESS
- production: run `31229785177` FAILURE（安全停止）
- Pages: run `31229785195` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE`
- candidate branch: 不存在

T-122のevent tuple固定6分類へは未到達だった。既知の前段post-reservation writeでfail-closedし、candidate保存・公開は行っていない。同一Program pinでhosted attempt 2へ継続する。
