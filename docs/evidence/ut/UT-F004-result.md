# UT-F004 実施結果

- 実施日: 2026-07-29
- 対象候補コミット: `8fe2538ffeb2c322b3519249b962cc7202546679`
- 判定: **UT-F004-001〜037 PASS**
- 仕様ID照合: 37/37件対応、未対応0件、余剰0件
- 手動確認: 必須証跡に含めない

## 自動試験

| ゲート | 結果 | 実測 |
|---|---|---|
| Vitest全回帰 | PASS | 169 suites / 935 tests、失敗0、skip 0 |
| F004仕様対応表 | PASS | UT 37/37、IT 15/15、QT 16/16 |
| TypeScript型検査 | PASS | `tsc --noEmit`、終了コード0 |
| ESLint | PASS | warning 0、終了コード0 |

- 正式生ログ: `docs/evidence/ut/UT-F004-attempt-2.json`
- 生ログSHA-256: `d1d3adfcad683e1ac3ae6e4252fecc8cf99533dca6e5aa7cfcd08bb98b86d8a3`
- 対応表: `docs/evidence/ut/spec-match.md`

## 判定

F004の承認文脈、固定baseline、権利証跡、編集、音声、容量、atomic受入、FinalCatalog、お気に入り、runtime境界、release checkを対象とする37件すべてを自動試験へ結合した。公式CSV全体の更新とJSON key挿入順を対象作品の権利変更と誤認しない回帰試験を追加し、全回帰935件が失敗0件であるため、UT-F004-001〜037をPASSと判定する。
