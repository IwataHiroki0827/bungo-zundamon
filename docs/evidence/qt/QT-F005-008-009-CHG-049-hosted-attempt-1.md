# QT-F005-008/009 CHG-F005-049 hosted attempt 1

- implementation commit: `038c587f13133048014b3fce3679c331b7725609`
- Program SHA-256: `95235ee661203e805e40234dc410c04d88d0e2f0f9ad2a7d29612490807ecd0f`
- native probe: run `31232075275` SUCCESS
- production: run `31232075250` FAILURE（安全停止）
- Pages: run `31232075242` build failure / deploy skip
- failure progress: `temporary-written`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_ACTIVE_PRODUCER_AFTER_RESERVATION_BIRTH`
- candidate branch: 不存在

T-123の同一cause candidate多重性分類へは未到達だった。既知のactive producer birth境界でfail-closedし、candidate保存・公開は行っていない。同一Program pinでhosted attempt 2へ継続する。
