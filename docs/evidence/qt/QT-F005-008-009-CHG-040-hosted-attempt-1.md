# QT-F005-008/009 CHG-F005-040 hosted attempt 1

- run: `31205281066`
- commit: `c58792691b422dd4682d1fe04b2bc1cb50a35691`
- native probe run: `31205282610` SUCCESS
- production result: FAIL（設計どおり安全停止）
- candidate保存: skip
- candidate branch: 不存在
- Pages deploy: skip

## 到達結果

checkout、clean source、disk preflight、fixed Node、locked dependencies、pinned native build/verify、prepared source clean、fixed VOICEVOX ENGINE、T-070 production pipelineはすべてPASSした。`wav-validated`後の安全診断は次である。

`F005_VOICE_NATIVE_OBSERVE_FAILED` → `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_CURRENT_PATH`

## 確認できた事実

late candidateはcompleted-retained sealのcurrent pathに対するSystem `setinfo`である。`ProofCandidate`によりseal lease FileObject、exact generation、current identity、current pathの不変proofは成立している。raw path/QPC/FileObject/identity/process値は公開していない。

## フローバック

既存のcompleted-write System SetInfo認可は、phase、予約QPC後、完了2秒window、FileObject binding、current existence、identityを固定順で再検査するが、completion drain拒否が先行して未到達である。CHG-F005-041/T-115で、候補1件の`SETINFO_CURRENT_PATH`とcompleted record/seal不変tupleが一致する場合だけ、後段全体へfall-throughせずcompleted-write認可へ明示的に引き渡す。
