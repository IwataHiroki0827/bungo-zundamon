# UT-F003 実施結果

- 実施日: 2026-07-26
- 対象: F003 source候補
- 現在判定: **UT-F003-001〜029 PASS**
- 仕様ID照合: 29/29件対応、未対応0件、余剰0件
- 手動確認: 必須証跡に含めない

## 自動試験

| ゲート | 結果 | 実測 |
|---|---|---|
| Vitest全回帰 | PASS | 143 suites / 853 tests、失敗0、skip 0 |
| F003仕様対応表 | PASS | UT 29/29、IT 14/14、QT 15/15 |
| TypeScript型検査 | PASS | `tsc --noEmit`、終了コード0 |
| ESLint | PASS | warning 0、終了コード0 |

- 正式生ログ: `docs/evidence/ut/UT-F003-attempt-3.json`
- 生ログSHA-256: `dad4bd8e3e0423a92d346f35ed9a0270beb89f62d3b502e6e5ddf4e3d691e1fb`
- 対応表: `docs/evidence/ut/spec-match.md`

## 判定

F003の候補登録、固定baseline、権利観測、抽出、独立判定、音声、容量、atomic受入、Catalog、runtime acceptance、release verification、公開記録を対象とする29件すべてを実テストまたはproduction統合手順へ結合した。全回帰853件が失敗0件であるため、UT-F003-001〜029をPASSと判定する。
