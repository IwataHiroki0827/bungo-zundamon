# F001 v0.1.0 リリース前総点検

- 実施日: 2026-07-19
- 承認対象commit: `2733b5fd368e847a01708724511f993f5e1b2484`
- branch: `feature/F001`
- catalog SHA-256: `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`
- 判定: **RELEASED_WITH_ACCEPTED_RISK**

## 総点検結果

| 項目 | 結果 | 根拠 |
|---|---|---|
| 候補SHA固定 | PASS | local HEAD、local `feature/F001`、remote `feature/F001`が同一SHA |
| 型検査 | PASS | `npm run typecheck` |
| lint | PASS | `npm run lint -- --max-warnings 0`。初回はCodexの一時証跡runnerが混入したため削除後再実行 |
| UT | PASS | Vitest 19 files、337/337件 |
| E2E | PASS | Playwright 6 projects、78/78件 |
| production build | PASS | 66 files、30,403,006 bytes |
| QT | PASS | QT-F001 20/20件。iOS等の例外受容を含む |
| TM | PASS | `trace_check.py bungo-zundamon --feature F001`で対応漏れなし |
| 変更管理 | PASS | CHG-F001-001〜005がすべて`done` |
| シークレット簡易検査 | PASS | tracked production 212 filesで認証情報形式0件。testのURL credential負例fixture 2ファイルは意図どおり除外 |
| hosted/visibility | PASS | private repository、Pages未構成、deploy変数未設定、候補run/artifact/catalog hash一致、negative run非deploy |

初回候補`5337d2752e5a288b8d3078c2d1d133ebdef6ed21`はActions deployとHTTP/catalog smokeまで成功したが、公開後Chrome 390pxのクレジット画面で横overflowを検出したため、Pages停止・repository Private化へrollbackした。修正版候補では`.credits-page li`の長いSHA-256を折り返し、全6ブラウザprojectの3 viewportへクレジットoverflow検査を追加した。

- 修正版ローカル検証: typecheck、lint、UT 337/337、E2E 78/78、build 66 files PASS
- 修正版installed Chrome/Edge: 3 viewport、native audio状態遷移、クレジットoverflow、外部通信・errorをPASS
- 修正版hosted run: `29690629227` success、artifact `8443454793`、catalog hash一致、deploy skipped、deployment 0件

## 環境マトリクス差分

| 環境 | 種別 | 状態 | 承認判断への開示 |
|---|---|---|---|
| Chromium | Playwright自動 | PASS 13/13 | なし |
| Firefox | Playwright自動 | PASS 13/13 | なし |
| WebKit | Playwright自動 | PASS 13/13 | iOS Safari実機の代替ではない |
| Android相当 Pixel 7 | Playwright自動 | PASS 13/13 | Android実機の代替ではない |
| Windows Chrome stable | installed browser | PASS 13/13、追加native audio確認 | なし |
| Windows Edge stable | installed browser | PASS 13/13、追加native audio確認 | なし |
| iOS Safari | 物理端末 | 詳細証跡未取得 | オーナーが当該リリース限りで受容。β相当の初回公開とし次期条件へ継続 |
| スクリーンリーダー | 手動支援技術 | 詳細証跡未取得 | オーナーが当該リリース限りで受容。次期条件へ継続 |

## 公開範囲とロールバック

- 承認後、repositoryをprivateからpublicへ変更し、承認対象SHAだけをmainへ反映してGitHub Pagesを公開する。
- `PAGES_DEPLOY_ENABLED=true`と`PAGES_DEPLOY_COMMIT=承認対象SHA`を一回限り設定し、deploy後は無効化する。
- 初回公開で旧版tagがないため、失敗時はPages無効化をrollback手段とする。
- `v0.1.0`はローカルtagとして修正版承認対象SHAへ固定し、deploy成功と本番browser smoke確認後にremoteへpushする。
