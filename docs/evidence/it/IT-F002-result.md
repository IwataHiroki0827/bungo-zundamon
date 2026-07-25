# IT-F002 実施結果

- 実施日時: 2026-07-26 02:09〜02:12 JST
- attempt: 1
- 実行対象: `956b8bd4fcd028ad32dbd227875eda0517e61f1d`と同一の実装・試験内容（commit直前に実行し、commit差分はメタデータのみ）
- 仕様ID照合: `IT-F002-001`〜`IT-F002-018`の18/18件をテストコードへ直接対応、未対応0件、余剰0件
- 結果: **PASS（18/18仕様ID、FAIL 0件）**

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
- 仕様対応表: `docs/evidence/it/spec-match.md`

## 判定

IT-F002-001〜018を直接参照する試験を含む全Vitest回帰がPASSした。jsdomの`HTMLMediaElement.pause()`未実装診断とGitのLF/CRLF警告は試験失敗ではなく、実ブラウザ音声結合はQTのPlaywright 4範囲で別途PASSしている。

exact release commit、最終dist digest、deploy先の一致はITの外部境界であり、`QT-F002-result.md`およびリリース証跡で同一candidateへ結合する。
