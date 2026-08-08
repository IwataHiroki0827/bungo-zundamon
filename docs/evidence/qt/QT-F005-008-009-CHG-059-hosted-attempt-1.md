# CHG-F005-059 hosted影響試験 attempt 1

- 対象commit: `9a87aeac8e175f140382c380fe78d68b4b58f905`
- production run: `31250367800`
- native probe: `31250367788` SUCCESS
- Pages run: `31250367796` deploy skipped

productionは新予約state診断をunknown化せず通過し、後続`F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`で安全停止した。候補保存・candidate branch作成・Pages deployはなく、`public/`・`data/`差分もない。T-133のhosted非回帰をPASSとする。
