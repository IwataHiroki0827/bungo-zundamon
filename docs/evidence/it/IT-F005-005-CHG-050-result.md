# IT-F005-005 CHG-F005-050 結果

- 実行日: 2026-08-08
- 判定: PASS
- implementation commit: `2d75f58d6595cfd0737ca4ceb470a40f733177c7`
- native executable rules: 799/799件PASS
- 関連Vitest: 6 files / 149件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `20cbf87874aa0a2c93d0ce912aa0720f8a9c739940e379b7e1689b1886238b72`
- project SHA-256: `a2275dbb0f3db2f34f08f0b48eee7e4c459be01e8d23305f30f7ad131b88a867`
- binary SHA-256: `cba9543995f6da923140487f12bcb1218d243b7f7844b518eba4c36afa42d30c`
- binary size: 75,183,964 bytes
- completion-drain / reservation fence: 51 + 4件
- `public/`・`data/`差分: 0件
- 独立受入: High 0 / Medium 0 / Low 0でPASS

post-reservation exact aggregateかつlate candidateが2件以上の場合だけ、76文字の`ACTIVE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`で停止する。exact 2件とexact 1件＋別causeの両順序、count境界、同一gate、semantic fingerprint、全handoff非fall-through、全surface sentinel非漏洩、51+4 allowlistを確認した。count 1の既存CHG-F005-044規則は文字列完全一致で非変更である。

全repo Vitestの13失敗は既存期限fixture 6件と並列timeout 7件で、影響6 filesは149/149件、未変更timeout 3 filesも単独28/28件PASSしたため本変更非起因と判定した。
