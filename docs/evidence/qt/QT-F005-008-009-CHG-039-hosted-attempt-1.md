# QT-F005-008/009 CHG-F005-039 hosted attempt 1

- run: `31201498649`
- commit: `54d327bbdbf444974911158fb3ca33928189601c`
- native probe run: `31201499381` SUCCESS
- production result: FAIL（設計どおり安全停止）
- candidate保存: skip
- candidate branch: 不存在
- Pages deploy: skip

## 到達結果

checkout、clean source、disk preflight、fixed Node、locked dependencies、pinned native build/verify、prepared source clean、fixed VOICEVOX ENGINE、T-070 production pipelineはすべてPASSした。`temporary-written`後の安全診断は次である。

`F005_VOICE_NATIVE_OBSERVE_FAILED` → `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_EVENT_AFTER_SEAL`

## 確認できた事実

exact late candidateは存在するが、CHG-F005-039が固定した`CompletedRetained parent`、別active lease、same parent、現在予約QPC後の複合条件をすべて満たすwrite/setinfo候補はない。raw path/QPC/FileObject/identity/process値は公開していない。

## フローバック

認可集合とstateは変更せず、CHG-F005-040/T-114でlate candidateごとの最初不一致軸をevent kind別の固定bucketへ分類する。全candidateが同一軸ならその軸、複数軸なら`MIXED_CAUSES`とし、従来と同じ位置で安全停止する。
