# QT-F005-008/009 CHG-F005-056 hosted影響試験 attempt 1

- source commit: `091ddee4743f1b3cd43dfb236ae1299dbbc4778a`
- Program SHA-256: `5748b8055931423d5f5f6a1b3e377ad41aca91f0a1542ec41c0e7ba77f3d909f`
- native binary SHA-256: `cfb411f1f340b0e00a443893e5c740020b5f724c7608e3c7b05b892cf31824be`
- native binary size: 75,204,444 bytes
- production: run `31246255285` attempt 1、FAILURE（意図したfail-closed）
- fixed diagnostic: `F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_ALL`
- hosted native correlation: run `31246255279` attempt 1、SUCCESS、T-109 52/52
- Pages: run `31246255432` attempt 1、build failure、deploy `skipped`
- candidate branch: `candidate/f005-t070-091ddee4743f1b3cd43dfb236ae1299dbbc4778a` 不存在
- `public/`・`data/`差分: 0
- 判定: PASS

production runはcheckout、disk preflight、固定Node、lock済み依存、pin済みnative build、clean source再確認、VOICEVOX取得、T-070 production pipeline、安全診断公開までPASSした。fail-closed stepだけが固定codeで失敗し、candidate検証・保存は`skipped`となった。

既存snapshotと共有predicateで全late candidateが適格である`ALL`へ一意に分類した。候補の選択、active-directory handoff、proof admission、capacity apply、candidate branch保存、Pages deployは行っていない。`ALL`はhandoff可否やevent ownershipの証明ではなく、次の認可変更を自動承認しない。

同一source SHAのread-only hosted native correlationはWindows X64、image OS `win25-vs2026`、image version `20260803.193.1`、Windows build `26100.33158`、PowerShell `7.6.4`、.NET SDK `9.0.316` / runtime `9.0.18`でT-109 52/52、kernel ETW preflight、Pages deploy `skipped`をPASSした。
