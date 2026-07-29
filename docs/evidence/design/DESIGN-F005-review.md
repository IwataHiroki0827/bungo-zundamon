---
feature: F005
reviewed_at: 2026-07-29
result: PASS
---

# F005 設計レビュー結果

## 最終判定

承認可。整合性・実現性・セキュリティの3観点を独立レビューし、最終的にHigh 0件、Medium 0件、Low 0件となった。

## 対象

- `docs/design/FD-F005.md`（DES 13件）
- `docs/design/DD-F005.md`（FUN 48件）
- `docs/srs/SRS-F005.md`（REQ 18件）
- `docs/tests/qt/QT-F005.md`（QT 20件）
- requirement approval snapshot `18e3fa50edfe5214480a65ed2e840fe49a663ee2`

## 主な修正

- Q-028〜Q-031の変更管理を通じ、公開ゲート循環、approval binding、原典・画像・Windows path、nullable書誌、容量境界をfail-closed契約へ強化した。
- ETWを容量観測の正本とし、native guardがPID・file identity・length・free bytesをmintする。notice-only、sequence gap、Job逸脱を拒否し、登録JobのETW-only低レベルeventはactualへ算入する。
- 共有candidate registryを設計段階で変更せず、F005専用registryから旧F003/F004候補をexact維持してatomic統合する三段階migrationを定義した。
- migration、control、acceptanceをsingle-parent commitで分離し、canonical evidence以外のtree差分をpath・change kind・blob SHA・file modeまで拒否する。
- dHash64-v1へhalf-pixel、16.16/32.32丸め、alpha、BT.601、非等倍10×9 vectorを固定した。
- .NET SDK 9.0.316/runtime 9.0.18、native guard binary、PNG decoder integrityを固定した。

## レビュー結果

| 観点 | 最終判定 | High | Medium | Low |
|---|---|---:|---:|---:|
| 整合性 | PASS | 0 | 0 | 0 |
| 実現性 | PASS | 0 | 0 | 0 |
| セキュリティ・権利 | PASS | 0 | 0 | 0 |

## 検証

- `npm test -- --run src/content/f004-approved-context.test.ts`: 7/7 PASS
- approval snapshotのGit object内でdefinition・専用registry・policy・binding evidence・queue・SRS・QT・CHGのSHA chainがexact一致（後続の設計承認Q-032はsnapshot対象外）
- `trace_check.py --feature F005 --no-impl`: REQ→DES→FUN→QT欠落0件
- 残る13件はDES→UT/ITであり、T-067でUT-F005/IT-F005を作成する計画済み差分

## 承認

Q-032で、プロジェクトオーナーの「今回はすべてOK」「手動確認不要」「続けて」という包括承認を設計ゲート②へ結合した。
