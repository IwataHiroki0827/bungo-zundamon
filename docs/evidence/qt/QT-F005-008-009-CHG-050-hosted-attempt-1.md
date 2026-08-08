# QT-F005-008/009 CHG-F005-050 hosted attempt 1

- commit: `2d75f58d6595cfd0737ca4ceb470a40f733177c7`
- Program SHA-256: `20cbf87874aa0a2c93d0ce912aa0720f8a9c739940e379b7e1689b1886238b72`
- native probe: run `31233549809` SUCCESS
- production: run `31233549836` FAILURE（安全停止）
- Pages: run `31233549843` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在

attempt 1は本変更の対象より前段にあるCHG-F005-049のno-lease candidate多重性で安全停止した。candidate保存・公開は行っていない。本実行をT-123の後続hosted到達PASSとして採用し、T-124は同一Program pinのattempt 2へ継続する。
