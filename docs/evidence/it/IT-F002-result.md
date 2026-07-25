# IT-F002 実施結果

- 実施日時: 2026-07-26 02:09〜03:01 JST
- attempt: 1（source）+ exact candidate再検証
- 実行対象: `84c985f382910216e381a96901f6fd569165a27e`
- 仕様ID照合: `IT-F002-001`〜`IT-F002-018`の18/18件をテストコードへ直接対応、未対応0件、余剰0件
- 現在判定: **IT-F002-001〜018 正式PASS**

## 自動試験結果

| ゲート | 結果 | 実測 |
|---|---|---|
| Vitest全回帰 | PASS | 38 files / 737 tests、失敗0、skip 0 |
| TypeScript型検査 | PASS | `tsc --noEmit`、終了コード0 |
| ESLint | PASS | warning 0、終了コード0 |
| オフラインproduction build | PASS | 229 files / 81,723,316 bytes |
| 依存脆弱性 | PASS | `npm audit --audit-level=high`、0 vulnerabilities |
| exact prepare-release | PASS | public tree 226 files、SHA-256 `09652af7de82eb32569d280566897c8fcf0c7e033b94d607becb42172f2b02d4` |
| hosted Pages artifact | PASS | Actions run `30168446371`、SHA-256 `08a5beed15eae8c4de2f5eb72601fa1628893799f8f55791a6075811d1ace6fc` |
| exact release-verify | PASS | dist SHA-256 `c60431bd4da3b1ba43ac71e299089f4dc8cbad563a58f3df3d2424fd952d9fde`、容量判定`pass` |

- Vitest生ログ: `docs/evidence/it/IT-F002-attempt-1.json`
- 生ログSHA-256: `d7a14c481997b3127adadd0a163c7c862a994d9d6d44cc5cd69f07a474e4cbb1`
- 付帯検証生ログ: `docs/evidence/qt/QT-F002-auxiliary-attempt-1.json`
- 付帯検証SHA-256: `076567b40e7f12f802fbf28df093fd4871f5446ab4250319cc301d41083cb88c`
- 実行環境: Windows `10.0.26200` x64、Node.js `v24.11.0`、npm `11.6.1`
- 仕様対応表: `docs/evidence/it/spec-match.md`

## 判定

IT-F002-001〜018を直接参照する実装・fixture試験を含む全Vitest回帰がPASSした。jsdomの`HTMLMediaElement.pause()`未実装診断とGitのLF/CRLF警告は試験失敗ではなく、実ブラウザ音声結合はQTのPlaywright 4範囲で別途PASSしている。

IT-F002-008/012/013/015/018が要求するexact release commit、predeploy観測、release容量、最終dist/artifact digestを`84c985f`へ結合した。featureブランチのhosted build成功後に同一候補をmainへfast-forwardし、公開後スモークまで完了したため、IT-F002-001〜018を正式PASSと判定する。
