# UT-F004 実施結果

- 実施日: 2026-07-29
- 対象コミット: `48c65092d2913c0ba8b15c051efc8dbb8a14c9fc`
- 判定: **UT-F004-001〜037 PASS**
- 仕様ID照合: 37/37件対応、未対応0件、余剰0件
- 手動確認: 必須証跡に含めない

## 自動試験

| ゲート | 結果 | 実測 |
|---|---|---|
| Vitest全回帰 | PASS | 169 suites / 934 tests、失敗0、skip 0 |
| F004仕様対応表 | PASS | UT 37/37、IT 15/15、QT 16/16 |
| TypeScript型検査 | PASS | `tsc --noEmit`、終了コード0 |
| ESLint | PASS | warning 0、終了コード0 |

- 正式生ログ: `docs/evidence/ut/UT-F004-attempt-1.json`
- 生ログSHA-256: `399cc523fb95abcf609e1ce7fc3508f19bb54420c68b90ce18864d1912171d2f`
- 対応表: `docs/evidence/ut/spec-match.md`

## 判定

F004の承認文脈、固定baseline、権利証跡、編集、音声、容量、atomic受入、FinalCatalog、お気に入り、runtime境界、release checkを対象とする37件すべてを自動試験へ結合した。全回帰934件が失敗0件であるため、UT-F004-001〜037をPASSと判定する。
