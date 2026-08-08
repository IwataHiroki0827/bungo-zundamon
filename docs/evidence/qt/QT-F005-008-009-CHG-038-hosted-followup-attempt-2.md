# QT-F005-008/009 CHG-F005-038 hosted follow-up attempt 2

- commit: `942911829de36408c083ea9513636e7eb7b2e6dd`
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- production: run `31236710778` FAILURE（安全停止）
- Pages: run `31236710775` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: T-112対象未到達

attempt 2はhandoffより前のCHG-F005-049固定codeで安全停止し、proof再生後段への到達は確認できなかった。candidate保存・公開は行っていない。同一pinの最終attempt 3へ継続する。
