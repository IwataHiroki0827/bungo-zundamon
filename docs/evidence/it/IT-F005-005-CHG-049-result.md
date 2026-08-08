# IT-F005-005 CHG-F005-049 結果

- 実行日: 2026-08-08
- 判定: PASS
- implementation commit: `038c587f13133048014b3fce3679c331b7725609`
- native executable rules: 784/784件PASS
- 関連Vitest: 6 files / 148件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `95235ee661203e805e40234dc410c04d88d0e2f0f9ad2a7d29612490807ecd0f`
- project SHA-256: `a2275dbb0f3db2f34f08f0b48eee7e4c459be01e8d23305f30f7ad131b88a867`
- binary SHA-256: `9fe6b5bc24c524044b90e39e8e663f99b081d1167a1fdf2b52bc668621970e96`
- binary size: 75,183,964 bytes
- completion-drain / reservation fence: 50 + 4件
- `public/`・`data/`差分: 0件
- 独立受入: High 0 / Medium 0 / Low 0でPASS

同一`WRITE_ACTIVE_LEASE_MISSING`へ分類されたlate candidateが2件以上の場合だけ、88文字の`COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`で停止する。snapshotとaggregate直後、全handoff前の同一gate内で決定し、exact 1の既存handoffは非変更である。

count境界、順序非依存、Task/barrierによるsame-gate、semantic fingerprint不変、後段非fall-through、reply/journal/runner/workflow annotationのsentinel非漏洩、50+4 allowlistとunknown/extra/exact128 generic化を確認した。

全repo Vitestの13失敗は既存期限fixture 6件と並列I/O timeout 7件で、timeout対象は単独PASS、影響6 filesは148/148件PASSしたため本変更非起因と判定した。
