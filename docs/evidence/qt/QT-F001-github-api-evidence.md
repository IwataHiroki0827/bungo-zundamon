# QT-F001 GitHub API外部証跡

- 観測完了: 2026-07-19T11:02:22.4652590Z（2026-07-19T20:02:22+09:00）
- 判定者: Codex `pf-worker`
- 対象候補: `5337d2752e5a288b8d3078c2d1d133ebdef6ed21`
- 最終判定: **PASS**
- 機械可読証跡: `docs/evidence/qt/QT-F001-github-api-evidence.json`

Git Credential Managerから取得した資格情報はPowerShellプロセス内だけで使用した。Authorization header、PAT、password、redirect先の署名付きURLはログ・証跡・ファイルへ出力していない。artifactは認証済みAPIからredirect先だけを受け取り、そのURLへAuthorization headerを付けずにメモリ取得した。

## Repository・Pages・承認switch

| 項目 | 実観測 | 判定 |
|---|---|---|
| repository | ID `1304106620` / `IwataHiroki0827/bungo-zundamon` / <https://github.com/IwataHiroki0827/bungo-zundamon> | PASS |
| visibility | `private=true` / `visibility=private` | PASS |
| Pages before | `GET /pages` = 404、`configured=false`、canonical SHA-256 `99cb323d9334b3c4fe49bdb3585a59e6003849b38d918f9f6910f812c817d3b5` | PASS |
| Pages after | negative attempt 2完了後も404、同一canonical SHA-256 | PASS |
| `PAGES_DEPLOY_ENABLED` | Actions variables API上に存在しない。workflow式の`== 'true'`はfalse | PASS |
| `PAGES_DEPLOY_COMMIT` | Actions variables API上に存在しない（null相当） | PASS |

Pagesのcanonical JSONはbefore/afterとも`{"http_status":404,"configured":false}`である。beforeは2026-07-19T10:58:37.6878664Z、afterはnegative attempt 2完了後の2026-07-19T11:02:22.4652590Zに観測した。

## 候補hosted run

| 項目 | 証跡 |
|---|---|
| run | [29672450957](https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29672450957) |
| event / ref / head | `push` / `feature/F001` / `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` |
| workflow | ID `316006692` / `.github/workflows/pages.yml` / Git blob `a0e1dcdc6828d6ccf35d94768062100e55980eb7` / active |
| conclusion | `success` |
| build job | [88153800312](https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29672450957/job/88153800312) / `success` |
| deploy job | [88153875625](https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29672450957/job/88153875625) / `skipped` |
| deployment | 0件 |

## github-pages artifact

| 項目 | 証跡 | 判定 |
|---|---|---|
| ID / name | `8437750946` / `github-pages` | PASS |
| API digest | `sha256:ff98d38fd80a7a8acb1f6351606f1e7aa770d99cd80f407827be2642c863d58d` | PASS |
| download SHA-256 | `ff98d38fd80a7a8acb1f6351606f1e7aa770d99cd80f407827be2642c863d58d` | API digestと一致 |
| ZIP | `artifact.tar` 1件、path安全 | PASS |
| TAR | 71 entries、path traversal 0件、symlink/hardlink 0件 | PASS |
| catalog | `./content/catalog.json` / 109,185 bytes / SHA-256 `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1` | 指定候補hashと一致 |

ZIP/TARはディスクへ展開せず、各entry名について絶対path、drive prefix、`..` segmentを拒否し、link entryも拒否対象として検査した。

## negative run

### Evidence attempt 1: FAIL

- commit: `a51ba33ebff31467f13b126fe4526c0ebe93eee4`（parentは候補commit）
- run: [29672593611](https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29672593611)
- 結果: runは`failure`、deployは`skipped`、artifact/deploymentは0件だった。
- 不合格理由: `Verify without content retrieval`内のworkflow静的契約検査が331 PASS / 6 FAILとなり、後続の`Controlled hosted negative fixture`は`skipped`だった。想定していた明示的fixture失敗を実証していない。

この失敗attemptは削除せず証跡として保持し、fixtureを通常検証内の専用testへ移して再試行した。

### Evidence attempt 2: PASS

| 項目 | 証跡 | 判定 |
|---|---|---|
| commit / base | `22425b31b2e46571db7f46ec73b16a9f44b9155e` / 候補`5337d2752e5a288b8d3078c2d1d133ebdef6ed21`を祖先に持つ | PASS |
| run | [29684314188](https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29684314188) / `push` / `test/F001-hosted-negative` / `failure` | PASS |
| workflow | 候補と同一Git blob `a0e1dcdc6828d6ccf35d94768062100e55980eb7` | PASS |
| controlled fixture | `scripts/hosted-negative.test.mjs` / `CONTROLLED_HOSTED_NEGATIVE_QT_F001_019` | PASS |
| test集計 | 19 test files PASS / 1 fixture file FAIL、337 tests PASS / 1 fixture test FAIL | PASS |
| build log | SHA-256 `d65046e0430aff8b47693eab50116dfccc2cd3090b6dd6023a54c229ce9621f3` | PASS |
| deploy job | [88185912381](https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29684314188/job/88185912381) / `skipped` | PASS |
| artifact / deployment | 0件 / 0件 | PASS |

attempt 2では通常検証337件がPASSし、追加した検証専用fixture 1件だけが指定markerで失敗した。候補と同一のworkflowを使用し、artifact uploadへ進まず、deploy jobも実行されず、Pages状態も変化していない。

## 総合判定

repository・候補SHA・workflow・artifact digest・artifact内catalog hashを一つのhosted chainとして拘束できた。承認前のrepositoryはprivate、Pages未構成、deploy用2変数は未設定であり、候補runと制御失敗runのどちらにもdeploymentは存在しない。negative evidenceはattempt 1の不備をattempt 2で解消したため、GitHub外部証跡を**PASS**とする。
