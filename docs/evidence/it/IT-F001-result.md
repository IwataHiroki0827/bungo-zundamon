# IT-F001 実施結果

- 最終実施日時: 2026-07-19 12:36〜12:38 JST
- 最終attempt: 5
- 対象commit（実行開始時HEAD）: `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`
- 仕様ID照合: `IT-F001-001`〜`IT-F001-020`の20/20件対応、未対応0件
- 結果: **PASS（20/20仕様ID、FAIL 0件）**

## 最終実行結果

| ゲート | 結果 | 件数・成果物 |
|---|---|---|
| Vitest | PASS | 19ファイル、337/337件PASS |
| TypeScript型検査 | PASS | `tsc --noEmit`、終了コード0 |
| ESLint | PASS | warning 0、終了コード0 |
| オフラインproduction build | PASS | 66ファイル / 30,403,006 bytes |
| Playwright | PASS | Chromium / Firefox / WebKit / Chrome stable / Edge stable、65/65件PASS |

- 実行順: `npm test` → `npm run typecheck` → `npm run lint` → `npm run build` → `npm run test:e2e`
- 生ログ: `docs/evidence/it/IT-F001-attempt-5.log`
- Vitest中にjsdomの`HTMLMediaElement.pause()`未実装診断が6行出力されたが、対象テストは337/337件PASSし、実ブラウザ音声結合試験も65/65件PASSしたため非失敗診断と分類した。

## IT-F001-016/017の判定境界

- ローカルITでは、workflow最小権限、deploy event matrix、承認SHA拘束、承認前のread-only visibility plan、承認後のrelease/visibility hash chain、および不正証跡のblocker matrixを自動検証してPASSした。
- private `feature/F001`への候補push、GitHub hosted Actionsの実run URL・artifact digest、実repository/Pages hash、承認ゲート④後の可視性変更・deploy監査chainは外部状態を必要とするため、`QT-F001-019/020`およびリリース証跡へ分離した。
- よってITのローカル契約はPASSだが、外部hosted・visibility証跡の完了を意味しない。

## attempt 5の証跡記録

最初の実行は全ゲートPASSしたが、PowerShell transcriptがnative command出力を取り込まず生ログ本文が欠落した。試験内容や実装の失敗ではないためretry FAILには数えず、同一attemptを`Tee-Object`による出力捕捉で再実行し、337件・build成果物・65件のraw outputがログ内に存在することを確認した。
