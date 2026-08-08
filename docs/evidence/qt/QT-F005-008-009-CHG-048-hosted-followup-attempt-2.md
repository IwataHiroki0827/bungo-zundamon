# QT-F005-008/009 CHG-F005-048 hosted follow-up attempt 2

- commit: `9d73625616cadf6f73e5d7410fb0c570784d9577`
- Program SHA-256: `cd0b29ea69494287d1e34adf35c4b442bd7ef98d1eb8bb794aee975136d6e74e`
- production: run `31239894268` FAILURE（安全停止）
- Pages: run `31239894014` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: T-122対象未到達

attempt 2も前段の既知固定codeでfail-closedし、T-122 event tuple固定6分類へは未到達だった。Program pin、認可、候補保存、公開条件を変更せず、retry limit内のattempt 3へ継続する。
