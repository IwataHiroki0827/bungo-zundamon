# IT-F005-005 CHG-F005-051 結果

- 実行日: 2026-08-08
- 判定: PASS
- implementation commit: `afe1bac57b14f2862d80f2909d928b9b7993765c`
- native executable rules: 820/820件PASS
- 関連Vitest: 6 files / 150件PASS
- typecheck、対象ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- project SHA-256: `a2275dbb0f3db2f34f08f0b48eee7e4c459be01e8d23305f30f7ad131b88a867`
- binary SHA-256: `faecba925eb5e4cdf42d0633aba496b01fa68e2c78961328c2b55b7dbbf496ad`
- binary size: 75,183,964 bytes
- completion-drain / reservation fence: 53 + 4件
- `public/`・`data/`差分: 0件
- 独立受入: High 0 / Medium 0 / Low 0でPASS

active-directory handoffの既存predicateから総candidate数だけを除いた共有規則を候補ごとに評価し、対象aggregateかつtotal 2以上を適格1件の`EXACT_ONE`、適格2件以上の`AMBIGUOUS`へ排他的に分類することを確認した。適格0件と不正countは`STATE_CHANGED`、対象外またはvalid total 1以下はnullとなる。候補順序反転、到達可能tuple、同一gate、全handoff非fall-through、semantic fingerprint不変、sentinel非漏洩、53+4 allowlistを確認した。count 1の既存active-directory handoffおよびcompleted-no-lease経路は非変更である。

全repo Vitestの12失敗は既知期限fixture 6件と並列timeout/`EBUSY` 6件で、影響6 filesは直列150/150件PASSしたため本変更非起因と判定した。
