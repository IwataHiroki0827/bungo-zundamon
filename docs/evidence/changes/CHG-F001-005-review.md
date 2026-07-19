# CHG-F001-005 再レビュー結果

実施日: 2026-07-19

## 対象

- `REQ-F001-026`、`REQ-F001-030`
- `DES-F001-016`、`DES-F001-018`
- `FUN-F001-032`、`FUN-F001-035`、`FUN-F001-042`
- `UT-F001-032`、`UT-F001-035`、`UT-F001-042`
- `IT-F001-016`、`IT-F001-017`
- `QT-F001-019`、`QT-F001-020`
- `docs/evidence/qt/QT-F001-browser-manual.md`

## 指摘と対応

初回pf-reviewerはHigh 2件、Medium 3件、Low 1件で差し戻した。再レビューでdeploy enableの承認SHA拘束、Pages有効化時刻順序、ブラウザ証跡の鮮度条件に追加指摘があり、次を反映した。

- `PAGES_DEPLOY_ENABLED`と`PAGES_DEPLOY_COMMIT == github.sha == 承認対象SHA`をdeploy必須条件にした。
- deploy後にenable/commit変数を無効化するone-shot契約を追加した。
- hosted証跡を同一repository、run、event、ref、head SHA、workflow、artifact、catalog hash、deployment不在、Pages hash不変へ結合した。
- Firefox/WebKit/Android相当の`BrowserRiskDecision`と追加実機の決定・解消規則を定義した。
- ブラウザ証跡の鮮度を候補commit/catalog hashの完全一致で判定するよう統一した。
- `approvedAt <= privateObservedAt < publicObservedAt <= pagesEnabledAt <= pagesDeployEnabledAt <= pagesDeployDisabledAt`を承認後の順序条件にした。
- 手動3環境、自動4範囲、risk、hosted証跡を記録できるテンプレートへ更新した。

## 判定

High 0件、Medium 0件。最終Lowの履歴表現も修正済み。

`trace_check.py bungo-zundamon --feature F001`は対応漏れなしでPASSした。実装と影響試験はT-014、T-010で継続する。
