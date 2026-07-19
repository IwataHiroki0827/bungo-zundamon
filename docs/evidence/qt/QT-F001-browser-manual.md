# QT-F001 主要ブラウザ実機確認テンプレート

## Q-005回答検証（attempt 1、2026-07-19）

- 回答: 完了申告、10項目すべてPASS。
- 検証結果: **REJECTED**。必須証跡として有効なメモを確認できないため、6実機行と関連QTの判定は更新しない。
- Q-005は`pending`へ戻し、T-010の`blocked_by: [Q-005]`を維持した。

| check | 受領判定 | 不足している証跡 |
|---|---|---|
| Chrome / Edge | PASS | OS・browser版、全操作結果、画面証拠、CSP・通信結果 |
| Firefox | PASS | メモが必須試験を否定しており判定と矛盾。OS・browser版、操作、画面証拠 |
| Safari / iOS Safari | PASS | 端末・OS/browser版、LAN接続、縦横表示、音声操作、画面証拠 |
| Android Chrome | PASS | メモが必須試験を否定しており判定と矛盾。端末・OS/browser版、縦横、操作、画面証拠 |
| visual | PASS | 3 viewport、reduced motion、44px操作領域の各結果と画面証拠 |
| screen_reader | PASS | 製品名・版、読み上げ、keyboard操作、状態通知の結果 |
| hosted_actions | PASS | メモが未実施を示す。run URL、artifact digest、job結果 |
| repository_settings | PASS | Private、Pages無効、`PAGES_DEPLOY_ENABLED`状態、画面証拠 |

再回答では、各メモへ環境/版、実施操作、確認結果、証拠の参照を記録する。端末・権限を用意できない項目はPASSにせず、要求変更相談を選択する。

## 自動継続試験

| 範囲 | 実施日時 | commit | 結果 | ログ・SHA-256 |
|---|---|---|---|---|
| Chromium | 2026-07-19T12:45:05+09:00 | `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` | PASS 13/13 | `QT-F001-automated-attempt-4.log` / `72ee3c8adfedb97a7299aa8286fbad936e4ffb65f84f424034f4eff11cf40c15` |
| Firefox | 2026-07-19T12:45:05+09:00 | `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` | PASS 13/13 | 同上 |
| WebKit | 2026-07-19T12:45:05+09:00 | `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` | PASS 13/13 | 同上 |
| Android相当（Pixel 7 / Chromium、390×844・844×390を含む） | 2026-07-19T12:45:05+09:00 | `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` | PASS 13/13 | 同上 |

CHG-F001-005承認後は、Firefox、desktop Safari相当のWebKit、Android相当viewportを上記の自動継続試験で判定する。自動試験失敗、ブラウザ固有リスク、表示・音声差異が見つかった場合は、該当installed browserまたはmobile実機試験を追加する。

> 手動3環境はリリース候補で実施する。hosted Actionsは候補commitをprivate feature branchへpushした後、そのcommitのrun URLとartifact digestを記録する。

## 実施者・候補版

- 判定者: Codex `pf-worker`（自動4範囲のみ）
- 実施日時: 2026-07-19T12:45:05+09:00（自動4範囲）
- commit / catalog hash: `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` / `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`
- 接続方法: 同一release commit / catalog hashから生成したLAN preview等（ゲート④前の本番Pagesは使用しない）

## 実機結果

| 端末 | OS版 | ブラウザ版 | トップ→作者 | 再生→一時停止→再開→停止→先頭再生 | 390/844系表示 | CSP・外部通信 | 証拠 | 判定 |
|---|---|---|---|---|---|---|---|---|
| Windows実機 | Windows 11 Home 10.0.26200 | Chrome stable 150.0.7871.127 | PASS | PASS | PASS | PASS（違反・外部通信・console/page error 0） | `screenshots/q009/chrome-stable-*.png`、`QT-F001-q009-browser-evidence.json` | PASS |
| Windows実機 | Windows 11 Home 10.0.26200 | Edge stable 150.0.4078.83 | PASS | PASS | PASS | PASS（違反・外部通信・console/page error 0） | `screenshots/q009/edge-stable-*.png`、`QT-F001-q009-browser-evidence.json` | PASS |
| iPhone/iPad実機 | 未記録 | iOS Safari 版未記録 | ユーザー`OK`申告 | 未記録 | 未記録 | 未記録 | 未添付 | PASS（2026-07-19オーナー例外受容） |

## 判定規則

- プロジェクト所有者または明示委任された検証者が実施する。
- 手動3行すべてに端末/OS/browser版、操作結果、画面または動画証拠、判定者を記録する。
- Firefox/WebKit/Android相当viewportは自動結果、実行日時、対象commit、ログ参照を記録する。
- 自動試験失敗または固有リスクを検出した場合は、該当実機を追加し同じ証跡項目を満たす。
- 端末を用意できない場合は原則PASSにしない。本リリースではプロジェクトオーナーが詳細証跡不足を明示的に受容したため、未実施環境をゲート④へ開示する条件で例外とする。

## ブラウザリスク判定

| scope | triggers | requiresDeviceTest | 根拠 | 判定者 | 判定日時 | 解消日時・追加実機証跡 |
|---|---|---|---|---|---|---|
| firefox | `[]` | false | 自動13/13 PASS。repository内に未解決browser defect記録がなく、Chromiumとの差異を検出しなかった | Codex `pf-worker` | 2026-07-19T12:45:05+09:00 | 不要 |
| webkit | `[]` | false | 自動13/13 PASS。repository内に未解決browser defect記録がなく、Chromiumとの差異を検出しなかった | Codex `pf-worker` | 2026-07-19T12:45:05+09:00 | 不要 |
| android-viewport | `[]` | false | Pixel 7相当自動13/13 PASS。390×844・844×390でoverflow、操作、音声、CSP差異を検出しなかった | Codex `pf-worker` | 2026-07-19T12:45:05+09:00 | 不要 |

triggerは`automated-failure`、`open-browser-defect`、`behavior-difference`だけを使用する。1件以上あれば`requiresDeviceTest=true`とし、修正後自動PASSと該当実機PASSの両方を記録する。

## HostedBuildEvidence

| 項目 | 証跡 |
|---|---|
| repository ID / URL | `1304106620` / `https://github.com/IwataHiroki0827/bungo-zundamon` |
| run ID / URL | `29672450957` / `https://github.com/IwataHiroki0827/bungo-zundamon/actions/runs/29672450957` |
| event / ref / head SHA | `push` / `feature/F001` / `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` |
| workflow path / workflow SHA / conclusion | `.github/workflows/pages.yml` / blob `a0e1dcdc6828d6ccf35d94768062100e55980eb7` / `success` |
| artifact ID / name / digest | `8437750946` / `github-pages` / `sha256:ff98d38fd80a7a8acb1f6351606f1e7aa770d99cd80f407827be2642c863d58d` |
| artifact内catalog hash | `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`（候補と一致） |
| observedAt / reviewer | `2026-07-19T20:02:22+09:00` / Codex `pf-worker` |
| deployment不在 | 候補run deployment 0件、deploy job `skipped` |
| Pages hash before / after | canonical SHA-256 `99cb323d9334b3c4fe49bdb3585a59e6003849b38d918f9f6910f812c817d3b5` / 同一（Pages未構成） |
| negative run SHA / base candidate SHA / failure reason | attempt 2 `22425b31b2e46571db7f46ec73b16a9f44b9155e` / `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` / `CONTROLLED_HOSTED_NEGATIVE_QT_F001_019`専用fixture 1件だけFAIL。run `29684314188`、deploy skipped、artifact/deployment 0件 |

成功runは同一repositoryのprivate feature branch上の候補commitを対象とする。negative runは候補commitをbaseにした検証専用branch/PRで作成し、候補commit自体を変更・昇格しない。

## VisibilityPlanEvidence（承認前）

| 項目 | 証跡 |
|---|---|
| repository ID / URL | `1304106620` / `https://github.com/IwataHiroki0827/bungo-zundamon` |
| current visibility | `private=true` / `visibility=private` |
| Pages enabled | 未構成（API 404、`configured=false`） |
| `PAGES_DEPLOY_ENABLED` | Actions variables APIに存在しない（false相当） |
| `PAGES_DEPLOY_COMMIT` | Actions variables APIに存在しない（null相当） |
| release commit / catalog hash | `5337d2752e5a288b8d3078c2d1d133ebdef6ed21` / `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1` |
| Pages hash / observedAt / evidence | `99cb323d9334b3c4fe49bdb3585a59e6003849b38d918f9f6910f812c817d3b5` / `2026-07-19T20:02:22+09:00` / `QT-F001-github-api-evidence.md` |

2026-07-19T12:54:39+09:00に候補commitをprivate `feature/F001`へpushした。2026-07-19T20:02:22+09:00までにGit Credential Managerをプロセス内だけで利用してGitHub REST API証跡を取得し、repository・候補SHA・catalog hash・artifact・Pages状態を結合してPASSした。詳細は`QT-F001-github-api-evidence.md`。

## Q-005回答の受領結果（2026-07-19）

ProjectFactory受信箱から10項目すべてに`PASS`が送信された。ただし証跡メモを内容確認した結果、次は実施証拠ではなく要件・手順への指摘だったため、機械的に実機PASSへ転記しない。

- Firefox: 「FireFoxはいらんでしょう」— 対象ブラウザ要件の見直し提案。
- Android Chrome: 「androidなんてオタクしか使ってない」— 対象端末要件の見直し提案。
- hosted Actions: 「手順がよくわからない」— 当時は未実施として扱った。当時の候補変更が未コミット・未pushだったため、先にリリース候補をGitHubへ置く必要があった。
- 演出低減: 回答後に「効果が分からない」と追加指摘。CHG-F001-004で状態・停止対象・端末設定優先の説明を修正した。

Chrome、Edge、Safari、iOS Safari、一般目視、スクリーンリーダー、repository設定の回答メモは受領したが、OS/browser版・画面証拠が未記入のため、本表の厳密な実機PASS条件はまだ満たさない。Q-005は回答処理済みとして閉じ、試験範囲の選択と修正後の目視確認を新しい受信箱項目へ分離する。
