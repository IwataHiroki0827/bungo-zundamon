# QT-F005-008/009 CHG-F005-051 hosted attempt 3

- commit: `d413da998e40dac5969d7b395625d7313d4ad124`
- implementation commit: `afe1bac57b14f2862d80f2909d928b9b7993765c`
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- production: run `31235735225` FAILURE（安全停止）
- Pages: run `31235735251` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: 未到達

attempt 3も本変更の対象より前段にあるCHG-F005-049のno-lease candidate多重性で安全停止した。candidate保存・公開は行っていない。retry limit 3へ到達したためT-125をblockedとし、Q-041へエスカレーションする。実装・認可・Program pinは変更しない。
