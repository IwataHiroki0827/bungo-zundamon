# QT-F005-008 CHG-F005-035 hosted follow-up attempt 2

- commit: `66d9c497e9d8278221a38b2ddf6293278fa98e83`
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- production: run `31237211590` FAILURE（安全停止）
- Pages: run `31237211591` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: T-109対象未到達

attempt 2はcompletion drainのCHG-F005-049固定codeで安全停止し、T-109固有stageへの到達は確認できなかった。candidate保存・公開は行っていない。同一pinの最終attempt 3へ継続する。
