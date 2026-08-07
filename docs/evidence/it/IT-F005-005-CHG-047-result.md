# IT-F005-005 CHG-F005-047 結果

- 実行日: 2026-08-08
- 判定: PASS
- native executable rules: 747/747件PASS
- 関連Vitest: 5 files / 132件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `eee1791e785b62c00441a99982a257d2f69b8557fcc90a78f7f31ea9f51e9476`
- project SHA-256: `a2275dbb0f3db2f34f08f0b48eee7e4c459be01e8d23305f30f7ad131b88a867`
- binary SHA-256: `c25563eef9d5ca96e34fe16f65861309880271e1b0e3eedbe9b3377d0b488d29`
- binary size: 75,179,868 bytes
- completion-drain / reservation fence: 43 + 4件（変更なし）
- `public/`・`data/`差分: 0件
- 独立受入: 初回High 0 / Medium 1 / Low 1、修正後High 0 / Medium 0 / Low 1で実装PASS

single exact late `WRITE_ACTIVE_LEASE_MISSING`だけを既存no-lease root directory完全認可へ最大1回handoffすることを確認した。setinfo、候補0/2、別bucket、seal/phase/path/lease/FileObject/QPC各false、他context混在は拒否し、false/poison後に他認可へfall-throughしない。

PASS後はSealSequence null、NormalEpoch、OtherBound proof、constructor-only contextを使い、旧seal replay/EventCountを変更しない。admit前およびpreflight/applyでphase/no lease/seal/root process/directory owner/proof/retained identity/generation handleを再検査する。

production共有`WriteCompletionReplayStore`と実ledgerを用いた実Task/barrier fixtureで5種のdriftとapply failureを実行した。semantic state未変更/rollback、poison中の内部証拠保持、再適用0、Dispose後解放、各上限を確認した。hosted productionは後続`EVENT_TUPLE_MISMATCH`へ進み、対象handoffを実Windowsで通過した。
