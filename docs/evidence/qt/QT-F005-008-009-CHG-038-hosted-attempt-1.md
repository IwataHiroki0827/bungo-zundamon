# QT-F005-008/009 CHG-F005-038 hosted attempt 1

- run: `31197869896`
- commit: `4dc7d2b44c1fefe80b0816185e560917e547755b`
- native probe run: `31197869761` SUCCESS
- production result: FAIL（安全停止）
- candidate保存: skip
- Pages公開: なし

## 到達結果

checkout、clean source、disk preflight、fixed Node、locked dependencies、pinned native build/verify、prepared source clean、fixed VOICEVOX ENGINEはすべてPASSした。T-070 production pipelineは安全診断を生成し、`temporary-written`後に次で停止した。

`F005_VOICE_NATIVE_OBSERVE_FAILED` → `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_EVENT_AFTER_SEAL`

## 確認できた事実

exact late tupleがgeneric `LATE_EVENT_AFTER_SEAL`で停止した。event kind、current/parent、seal state、active lease有無/同一性、same parent、現在予約QPCとの関係は現行診断から確定できない。

## フローバック

旧completed-retained parentと別active leaseの競合は仮説の一つだが、run証跡はevent provenanceを証明しない。旧eventを新leaseへ誤帰属し得る遮蔽案は撤回した。CHG-F005-039/T-113では認可を変更せず、複合条件一致時だけwrite/setinfoの2固定codeへ細分化して再観測する。
