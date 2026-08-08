# QT-F005-008/009 CHG-F005-038 hosted follow-up attempt 1

- commit: `f6a7a9b3fceae09979f3dde2ce8fe4e632247dde`
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- production: run `31236568096` FAILURE（安全停止）
- Pages: run `31236568111` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: T-112対象未到達

現行の後続安全機構を含むProgram pinでT-112不変binding proof再生のfollow-up影響試験を開始した。attempt 1はhandoffより前のCHG-F005-051固定codeで安全停止し、proof再生後段への到達は確認できなかった。candidate保存・公開は行っていない。同一pinのattempt 2へ継続する。
