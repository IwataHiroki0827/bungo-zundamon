# QT-F005-008/009 CHG-F005-051 hosted attempt 1

- implementation commit: `afe1bac57b14f2862d80f2909d928b9b7993765c`
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- native probe: run `31235424464` SUCCESS
- production: run `31235424462` FAILURE（安全停止）
- Pages: run `31235424482` build failure / deploy skip
- failure progress: `wav-validated`
- failure code: `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_UNKNOWN_PATH_OTHER_OTHER_FILE_NO_LEASE`
- candidate branch: 不存在
- 判定: 未到達

attempt 1は本変更の対象より前段にある既知のSystem process unbound FileObject setinfo分類で安全停止した。candidate保存・公開は行っていない。Program pinを変更せず、workflow self-pathだけを更新してattempt 2へ継続する。
