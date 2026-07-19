---
phase: test
feature: F001
updated: 2026-07-19T12:22:59+09:00
next_actions:
  - "pf-testでtasks.yamlのT-010を実施し、QT-F001-019/020のhosted・手動3環境・自動4範囲を完了する"
  - "T-010完了後、pf-releaseでtasks.yamlのT-011を実施してリリース判定ゲート④へ進む"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- CHG-F001-003で3作品67候補を全件再レビューし、二重括弧を解消して59台詞・57共有音声資産を公開した。
- Q-005の10回答は保存・監査済み。Chrome等の確認メモは受領したが、Firefox・Androidは試験範囲への意見、hosted Actionsは手順不明であり、全項目実機PASSには転記していない。
- CHG-F001-004で演出設定へ現在状態・動く/停止する対象・端末設定優先理由を表示し、独立再受け入れPASSでT-013を完了した。
- Q-007でCHG-F001-005が承認され、手動必須をWindows Chrome/Edge・iOS Safari、自動継続試験をChromium/Firefox/WebKit・Android相当、hosted Actionsを候補push後の実施へ変更した。
- T-014で`.github/workflows/pages.yml`と`scripts/release-checks.mjs`を承認SHA拘束・新ブラウザ証跡・hosted/visibility hash chainへ適合させた。
- 初回受け入れで偽の承認IDを通すHigh 1件を検出し、信頼済みqueue承認レコードとの実在照合を追加した。再受け入れはHigh 0 / Medium 0 / Low 0でPASSした。
- T-014検証は対象78/78、全UT 337/337、lint、typecheck、production build（66 files / 30,403,006 bytes）をすべてPASSした。
- Q-008の短い目視試験はPASSとして受理済み。切替廃止・常時標準・クレジット遷移統一の意向は未実装の変更候補として分離している。

## 直近の作業（最新5件）

- Q-007を3点セットで閉じ、CHG-F001-005をSRS/FD/DD/UT/IT/QTへ反映してT-014を生成
- workflowのdeploy条件へ`PAGES_DEPLOY_COMMIT == github.sha`を追加
- 手動3環境・自動4範囲・リスク3件・条件付き追加実機のrelease判定を実装
- hosted buildと承認前後visibilityのrepository/SHA/artifact/catalog/Pages証跡chainを実装
- 承認ID偽装Highを修正し、独立再受け入れと337件の全UTをPASS

## 次のアクション

- `tasks.yaml`のT-010を`pf-test`で実施し、`IT-F001-016/017`と`QT-F001-019/020`の影響試験を完了する。
- リリース候補をprivate `feature/F001`へcommit/pushし、GitHub hosted Actionsのrun URL・artifact digest・候補commit・catalog hashを証跡化する。
- Windows Chrome/Edge・iOS Safariの手動3環境と、Chromium/Firefox/WebKit・Android相当の自動4範囲を完了する。
- 影響試験完了後、`docs/changes/changes.yaml`と`docs/changes/CHG-F001-005.md`を`done`へ更新し、T-011の`pf-release`へ進む。

## 未解決事項

- CHG-F001-005: Q-007承認・文書反映・T-014実装修正は完了。T-010の影響試験が未完了のため`in-review`。
- hosted Actions: リリース候補のprivate `feature/F001`へのcommit/push前なので未実施。
- 手動3環境: Windows Chrome/Edge・iOS Safariの候補commit一致証跡が未取得。
- Q-008追加意向: 切替廃止・常時標準・クレジット遷移統一は`docs/evidence/changes/CHG-F001-004-result.md`へ記録済みで、変更管理・実装は未着手。
- `TM-F001.md`には複数DES経由の同一FUN/UT/ITが重複表示されるが、trace判定と対応範囲には影響しない。
