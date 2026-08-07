# IT-F005-005 CHG-F005-038 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 454/454件PASS
- 関連Vitest: 4 files / 54件PASS
- typecheck、ESLint、production build、trace_check: PASS
- Program SHA-256: `cdbc34afc3db715bbbb28f5ffb88a005fe9fc343b82c93e4fb89c30ee2809de2`
- binary SHA-256: `a6870cd60443682f9c65d57532b312cd8fd1fab1c16291ed5485524aee56f0f1`
- binary size: 75,134,812 bytes
- `public/`・`data/`差分: 0件

prepareのadmission writer線形化、再利用後Cleanup拒否、sealed-parent exact Unbound、Cleanupを含むproof順batch、semantic rollback、rename target callback snapshot、identity/overflow/error priorityをproduction共有ruleと構造試験で確認した。実Windows ETWでの候補生成はQT-F005-008/009のhosted試験へ引き継ぐ。
