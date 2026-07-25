# CHG-F002-002 変更・影響試験結果

## 判定

ACCEPT。F002の手動確認必須条件を廃止し、自動試験と機械検証可能な既存判断artifactだけで受入可能な状態へ変更した。

## 変更確認

- F002の`acceptF002Release`は`manualBrowsers`を要求しない。
- F002の`runReleaseChecks`は`manualBrowsers`、`deviceTests`、手動reviewer入力を要求しない。
- F002のbrowser必須集合はPlaywright `chromium/firefox/webkit/android-viewport`の4系統である。
- viewportは`390x844/844x390/1440x900`、accessibilityは`keyboard/semantic-aria/reduced-motion`をexact setで要求する。
- 手動・実機・目視・聴取の未実施をPASSへ転記しない。
- F001のmanual/automated/device browser証跡は、従来どおりreviewerと`authorizedReviewer=true`を要求する。
- CLIの停止状態は`awaiting_evidence_gate`となり、手動入力ではなく承認済みartifactの検出後に再開する。

## 独立レビュー

初回レビューはHigh 2件だった。

1. F001のautomated browser証跡からreviewer必須条件まで外れていた。
2. 仕様にだけinstalled Chrome/Edge必須条件が残り、実装のPlaywright 4系統と不一致だった。

修正後の再レビューはACCEPT、High 0 / Medium 0 / Low 0となった。F001には従来条件を維持し、F002の仕様・設計・試験・実装は再現可能なPlaywright 4系統へ統一した。

## 影響試験

| 検査 | 結果 |
|---|---|
| 対象UT・統合試験 | 5ファイル・152件PASS |
| 全Vitest | 38ファイル・734件PASS |
| TypeScript | PASS |
| ESLint | PASS |
| production build | PASS、229 files / 81,723,316 bytes |
| Playwright必須4系統 | 84/84 PASS |
| F002 trace_check | 対応漏れなし |
| YAML parse | PASS |
| git diff check | PASS |

## E2Eフローバック

最初の全E2Eでは、F001向けシナリオが作者カードと「作品と台詞を聴く」リンクを1件と仮定していたため、2作者化後にstrict locator違反となり、6 browser projectで同じ8ケース、計48件が失敗した。作者カードを原著者名で明示選択し、複数作者化後の広告・スポンサー表記へ期待値を合わせた。最小再現10件がPASSした後、必須4系統84件を再実行して全件PASSを確認した。

## 容量ガード

C:は35.5GB空きで今回の既知build規模には十分だったが、空き率3.8%のため警告域だった。削除は行わず、生成量が小さい既存試験・buildだけを順次実行した。
