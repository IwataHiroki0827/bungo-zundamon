# UT-F001 実施結果

- 実施日時: 2026-07-19 12:27 JST
- attempt: 3（T-010影響再試験）
- 実行コマンド: `npm test`
- 仕様ID照合: `UT-F001-001`〜`UT-F001-042`の42/42件をテストコードへ直接対応、未対応0件
- 結果: **PASS**
- Test Files: 19 passed / 19
- Tests: 337 passed / 337
- 実行時間: 3.80秒
- 生ログ: `docs/evidence/ut/UT-F001-attempt-3.log`
- 付帯検証: `npm run lint` PASS、`npm run typecheck` PASS

## 注記

jsdomが`HTMLMediaElement.pause()`を未実装として出す警告が6件あるが、テスト失敗ではない。実ブラウザでの音声操作はIT/QTで別途検証する。今回の仕様ID補完は既存試験suite名へのタグ追記だけであり、試験ロジック、期待値、fixtureは変更していない。

## 過去の実施履歴

| attempt | 実施日時 | Test Files | Tests | 結果 | 生ログ |
|---|---|---:|---:|---|---|
| 1 | 2026-07-18 21:39 JST | 16/16 | 276/276 | PASS | `UT-F001-attempt-1.log` |
| 2 | 2026-07-19 00:49 JST | 19/19 | 301/301 | PASS | `UT-F001-attempt-2.log` |
| 3 | 2026-07-19 12:27 JST | 19/19 | 337/337 | PASS | `UT-F001-attempt-3.log` |
