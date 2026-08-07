# QT-F005-008/009 CHG-F005-043 hosted attempt 2

- run: `31213980538`
- commit: `3e9fc635e3beebc757c86300c029f76328c010f0`
- Program SHA-256: `28b9eda7db0ab4da6a555cdc94d8a4ce2080d6c7be8316ff7c46119efb565073`
- production result: FAIL（既存固定bucketで設計どおり安全停止）
- candidate保存: skip
- candidate branch: 不存在
- Pages run: `31213982111` build failure / deploy skip

## 到達結果

全前段とT-070 production pipelineをPASSし、`audio-renamed`後に次の安全診断で停止した。

`F005_VOICE_NATIVE_OBSERVE_FAILED` → `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE`

## 判定

attempt 1の`WRITE_ACTIVE_LEASE_MISSING`とは異なる既存固定bucketへ分岐し、T-117対象`WRITE_AT_OR_BEFORE_ACTIVE_RESERVATION`には未到達だった。認可・実装・Program pinを変更せずretry_limit 3の最終attemptへ進む。candidate保存、candidate branch、Pages deployは0件である。
