# IT-F005-005 CHG-F005-040 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 493/493件PASS
- 関連Vitest: 4 files / 57件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- 独立受入: PASS（High 0 / Medium 0 / Low 0）
- Program SHA-256: `57adea83b070090aa19393f742738bbb6c3e7d37bd55771d7cf920a987f54f64`
- binary SHA-256: `3eb63d297172f6776925921895c233577aca4cb75d9d378e04ce59276e7c003f`
- binary size: 75,143,004 bytes
- `public/`・`data/`差分: 0件

exact late拒否位置の純粋診断集約、write/setinfo×5最初不一致軸、完全一致最優先、same lease不変条件のgeneric fail-close、同一bucket、異なbucket、候補順反転、empty/unknown、generic混在をproduction共有rule/fixtureで確認した。native/TSの35 exact code集合は差分0、workflowは35全件を受理し、SAME_LEASE/unknown/extra/exact 128文字は全層で拒否した。実Windows ETWでの不一致軸確定はQT-F005-008/009のhosted再観測へ引き継ぐ。
