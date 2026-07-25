# UT-F002 実施結果

- 実施日時: 2026-07-26 00:26 JST
- attempt: 3
- 実行コマンド: `npm test -- --reporter=json --outputFile=docs/evidence/ut/UT-F002-attempt-3.log`
- 仕様ID照合: `UT-F002-001`〜`UT-F002-040`の40/40件をテストコードへ直接対応、未対応0件、余剰0件
- 結果: **PASS**
- 独立受入結果: **ACCEPT**（High 0件、Medium 0件、Low 0件）
- Test Files: 37 passed / 37
- Tests: 719 passed / 719
- 実行時間: 10.78秒
- 生ログ: `docs/evidence/ut/UT-F002-attempt-3.log`
- 付帯検証: `npm run typecheck` PASS、`npm run lint` PASS

## 実行前照合でのフローバック

初回の仕様ID機械照合は22/40件で、18件の直接タグが不足していた。調査により16件は既存試験suiteのタグ不足、`UT-F002-030`と`UT-F002-037`は実装・試験の欠落と判明した。正式attemptには数えず、次を補完して40/40件の照合PASS後にattempt 1を実行した。

- `FUN-F002-030 acceptF002Release`: exact clean release commit、3作品、音声、F001不変、権利・規約・画像、actual容量、security、browser・回帰、QT 14件を同一candidate tupleへ結合する受入判定を実装し、`runReleaseChecks`へ接続した。
- `FUN-F002-037 recordPublishedBatch`: approval/deploy/smokeの同一tuple、deploy変数無効化、published manifestのexpected SHA付きatomic write、4段階journal、停止後の冪等再開、第三者競合の非上書きを実装した。

詳細な対応表は`docs/evidence/ut/spec-match.md`を参照する。

## 注記

jsdomが`HTMLMediaElement.pause()`未実装の診断を出すが試験失敗ではない。実ブラウザの音声操作はIT/QTで別途検証する。GitのLF/CRLF警告も試験失敗ではなく、追跡ファイルの内容変更は発生していない。

## attempt 1 独立受入指摘

- WorkRightsDecision、PolicyDecision、ArtworkDecisionの許可状態を共通集合で扱い、型として不可能な状態を受理していた。
- accepted音声pathがcanonical workspace相対path・作品所有・一意性を検証していなかった。
- publish時のapproval/deployment/smoke証跡参照が実体・hash・candidate tupleを検証せず、不完全なroute集合も受理していた。
- journal停止後にdisk上のpublished manifestを再読込した実process再起動相当の復旧が成立しなかった。

attempt 2で前回4件を修正後、再審査中にroute集合の自己申告と判定discriminant矛盾の追加fail-open候補を検出した。F002 canonical 4 routeへの固定と全判定型の`status/result`矛盾拒否を追加し、attempt 3で全自動試験と独立受入を再実施してACCEPTとなった。

## 実施履歴

| attempt | Test Files | Tests | 自動結果 | 独立受入 | 生ログ |
|---|---:|---:|---|---|---|
| 1 | 37/37 | 689/689 | PASS | REDO（High 3、Medium 1） | `UT-F002-attempt-1.log` |
| 2 | 37/37 | 710/710 | PASS | 追加fail-open候補の修正へ継続 | `UT-F002-attempt-2.log` |
| 3 | 37/37 | 719/719 | PASS | ACCEPT（指摘0） | `UT-F002-attempt-3.log` |
