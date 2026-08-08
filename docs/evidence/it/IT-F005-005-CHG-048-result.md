# IT-F005-005 CHG-F005-048 結果

- 実行日: 2026-08-08
- 判定: PASS
- native executable rules: 772/772件PASS
- 関連Vitest: 6 files / 147件PASS
- typecheck、ESLint、trace_check、再現build 2回: PASS
- Program SHA-256: `db59663c44f5cb18dd66882f1ab8c721ef17c3e574fe509f1f6a1a5551ff8018`
- project SHA-256: `a2275dbb0f3db2f34f08f0b48eee7e4c459be01e8d23305f30f7ad131b88a867`
- binary SHA-256: `0721ba0d0b58401c7db50b77ce80b0fed4e6f49154068205f3ae436d78b374d4`
- binary size: 75,183,964 bytes
- completion-drain / reservation fence: 49 + 4件
- `public/`・`data/`差分: 0件
- 独立受入: High 0 / Medium 0 / Low 0でPASS

completion drain lookupをepoch-empty-no-late-proof、exact missing、exact ambiguousへ、sealed callback再検査をseal missing、seal ambiguous、fieldsへ固定分類した。post-request fieldsとidentityを分離し、fields通過後のidentity不一致は既存`EVENT_IDENTITY_FAILED`を維持した。

broad/epoch/exact/lateの境界、sealed count 0/1/2、normal/post-request各fieldのone-false、identity 2軸、診断後のstate非変更をproduction共有規則で確認した。49 completion-drain codeと予約fence 4 codeはnative reply、bridge、runner、workflowで同期し、127文字上限とunknown/extraのgeneric化も非回帰である。
