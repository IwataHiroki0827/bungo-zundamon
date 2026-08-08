# CHG-F005-061 hosted影響試験

- 対象commit: `1e063b0`
- production run: `31252362866`
- attempt 1/2: `...AFTER_RESERVATION_BIRTH_AT_OR_BEFORE_INITIAL`
- attempt 3: `...EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_NO_LATE_PROOF`

全attemptは候補保存前にfail-closedした。candidate branch・Pages deploy・`public/`/`data/`変更はない。集合handoffのlocal/独立受け入れとhosted非回帰をPASSとし、次のlookup固定診断へ継続する。
