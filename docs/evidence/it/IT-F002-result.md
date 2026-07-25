# IT-F002 実施結果

- 実施日時: 2026-07-26 02:09〜02:12 JST
- attempt: 1
- 実行対象: `956b8bd4fcd028ad32dbd227875eda0517e61f1d`と同一の実装・試験内容（commit直前に実行し、commit差分はメタデータのみ）
- 仕様ID照合: `IT-F002-001`〜`IT-F002-018`の18/18件をテストコードへ直接対応、未対応0件、余剰0件
- 現在判定: **source段階の実装・fixture試験PASS／exact release candidate結合は未確定**

## 自動試験結果

| ゲート | 結果 | 実測 |
|---|---|---|
| Vitest全回帰 | PASS | 116 suites / 734 tests、失敗0、skip 0 |
| TypeScript型検査 | PASS | `tsc --noEmit`、終了コード0 |
| ESLint | PASS | warning 0、終了コード0 |
| オフラインproduction build | PASS | 229 files / 81,723,316 bytes |
| 依存脆弱性 | PASS | `npm audit --audit-level=high --omit=dev`、0 vulnerabilities |

- Vitest生ログ: `docs/evidence/it/IT-F002-attempt-1.json`
- 生ログSHA-256: `d7a14c481997b3127adadd0a163c7c862a994d9d6d44cc5cd69f07a474e4cbb1`
- 付帯検証生ログ: `docs/evidence/qt/QT-F002-auxiliary-attempt-1.json`
- 付帯検証SHA-256: `076567b40e7f12f802fbf28df093fd4871f5446ab4250319cc301d41083cb88c`
- 実行環境: Windows `10.0.26200` x64、Node.js `v24.11.0`、npm `11.6.1`
- 仕様対応表: `docs/evidence/it/spec-match.md`

## 判定

IT-F002-001〜018を直接参照する実装・fixture試験を含む全Vitest回帰がPASSした。jsdomの`HTMLMediaElement.pause()`未実装診断とGitのLF/CRLF警告は試験失敗ではなく、実ブラウザ音声結合はQTのPlaywright 4範囲で別途PASSしている。

ただし、IT-F002-008/012/013/015/018が要求するexact release commit、predeploy観測、release容量、最終dist/artifact digest、candidate tupleはまだ固定前である。したがって18/18の正式PASSは記録せず、clean candidate上の再実行・機械証跡と`QT-F002-result.md`を同一tupleへ結合した後に確定する。
