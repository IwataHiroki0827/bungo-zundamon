# QT-F005-008/009 CHG-F005-057 hosted影響試験 attempt 1

- implementation commit: `3aa6c1dda5764888887be0e8cffb0204fe916af2`
- production trigger commit: `04ebd7589f67e73ca80ef190905ec917c123e92c`（workflow再試行コメントだけ追加）
- Program SHA-256: `462b1163695b2f27f4ddb7f2454895e34099d4b32590dfdf91c7b7ba6ac6dfea`
- native binary SHA-256: `5cb78c5c6373e3fa947ac4d93fb10b48fa114a33183e4b589ef53a128c40adf1`
- native binary size: 75,204,444 bytes
- production: run `31247640858` attempt 1、FAILURE（意図したfail-closed）
- next fixed diagnostic: `F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_ACTIVE_PRODUCER_AFTER_RESERVATION_BIRTH`
- hosted native correlation: run `31247614372` attempt 2、SUCCESS、T-109 52/52
- implementation Pages: run `31247614376` attempt 1、build failure、deploy `skipped`
- production Pages: run `31247640907` attempt 1、build failure、deploy `skipped`
- candidate branch: `candidate/f005-t070-04ebd7589f67e73ca80ef190905ec917c123e92c` 不存在
- `public/`・`data/`差分: 0
- 判定: PASS

production runはcheckout、disk preflight、固定Node、lock済み依存、pin済みnative build、clean source再確認、VOICEVOX取得、T-070 production pipeline、安全診断公開までPASSした。CHG-F005-056の`ELIGIBLE_ALL`を再emitせず通過し、既存のactive producer時系列診断へ到達した。候補選択、旧seal proof/replay/EventCount、candidate保存、Pages deployは行っていない。

hosted native correlationのattempt 1はbuild、kernel ETW、T-109 52/52までPASSしたが、Pages deploy jobが直後に`skipped`へ確定する前のAPI結果を読み、`F005_T109_PAGES_DEPLOY_NOT_SKIPPED`で失敗した。Pages実結果の安定後にfailed jobだけを再実行し、attempt 2で同じimplementation commit、Program/binary SHA、T-109 52/52、Pages deploy `skipped`をPASSした。実装変更によるretryではない。

canonical evidenceはWindows X64、image OS `win25-vs2026`、image version `20260803.193.1`、Windows build `26100.33158`、PowerShell `7.6.4`、.NET SDK `9.0.316` / runtime `9.0.18`、kernel ETW preflight `pass`、result `pass`である。
