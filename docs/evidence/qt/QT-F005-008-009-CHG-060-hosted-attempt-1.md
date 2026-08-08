# CHG-F005-060 hosted影響試験 attempt 1

- 対象commit: `6386ca76231c9a0f311ce72641419addf52faf9a`
- production run: `31251365842`
- native probe: `31251365837` SUCCESS
- Pages run: `31251365840` deploy skipped

productionは`F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_IDENTITY_MATCH_AMBIGUOUS`で安全停止した。current identity一致sealが複数であることを固定し、候補保存・candidate branch・Pages deploy・`public/`/`data/`変更がないことを確認した。
