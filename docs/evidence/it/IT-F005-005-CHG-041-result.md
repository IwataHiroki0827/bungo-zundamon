# IT-F005-005 CHG-F005-041 結果

- 実行日: 2026-08-08
- 判定: PASS（ローカル結合範囲）
- native executable rules: 511/511件PASS
- 関連Vitest: 5 files / 126件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- 独立受入: PASS（High 0 / Medium 0 / Low 0）
- Program SHA-256: `405eee02e2f3f731306fabb5061b3f53cf81b0db8ef52396ddb2194246ec654d`
- binary SHA-256: `4528a246442d5cd88ab15182f04ecfe24df641d1cea31d4b7307e97d98b2feb2`
- binary size: 75,143,004 bytes
- `public/`・`data/`差分: 0件

単一exact late `SETINFO_CURRENT_PATH`とcompleted record/sealのworker PID、process sequence、phase instance、reserved QPC、identityが一致する場合だけ、通常completion-drain sealと別のhandoffを返すことを確認した。handoff後は既存completed-write認可だけを評価し、拒否時は即returnして他認可へfall-throughしない。PASS後は通常`OtherBound` proofを適用する一方、handoff sealのsealed proof/recheck/reorder/replay/EventCountを使用しない。候補0/2、write、parent、他bucket、MIXED、generic、record欠落、5軸各差は従来どおり停止し、外部35 codeは不変である。

並行負荷時の既存5秒timing試験timeoutは単独再実行と負荷なし関連全体再実行でPASSした。実Windows ETWでのhandoff通過または既存completed-write固定拒否stageは、QT-F005-008/009のhosted再観測へ引き継ぐ。
