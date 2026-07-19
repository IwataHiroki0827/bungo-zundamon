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
| Chromium | 2026-07-19T12:45:05+09:00 | working tree base `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`（未コミット） | PASS 13/13 | `QT-F001-automated-attempt-4.log` / `72ee3c8adfedb97a7299aa8286fbad936e4ffb65f84f424034f4eff11cf40c15` |
| Firefox | 2026-07-19T12:45:05+09:00 | working tree base `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`（未コミット） | PASS 13/13 | 同上 |
| WebKit | 2026-07-19T12:45:05+09:00 | working tree base `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`（未コミット） | PASS 13/13 | 同上 |
| Android相当（Pixel 7 / Chromium、390×844・844×390を含む） | 2026-07-19T12:45:05+09:00 | working tree base `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`（未コミット） | PASS 13/13 | 同上 |

CHG-F001-005承認後は、Firefox、desktop Safari相当のWebKit、Android相当viewportを上記の自動継続試験で判定する。自動試験失敗、ブラウザ固有リスク、表示・音声差異が見つかった場合は、該当installed browserまたはmobile実機試験を追加する。

> 手動3環境はリリース候補で実施する。hosted Actionsは候補commitをprivate feature branchへpushした後、そのcommitのrun URLとartifact digestを記録する。

## 実施者・候補版

- 判定者: Codex `pf-worker`（自動4範囲のみ）
- 実施日時: 2026-07-19T12:45:05+09:00（自動4範囲）
- commit / catalog hash: working tree base `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`（未コミット） / `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`
- 接続方法: 同一release commit / catalog hashから生成したLAN preview等（ゲート④前の本番Pagesは使用しない）

## 実機結果

| 端末 | OS版 | ブラウザ版 | トップ→作者 | 再生→一時停止→再開→停止→先頭再生 | 390/844系表示 | CSP・外部通信 | 証拠 | 判定 |
|---|---|---|---|---|---|---|---|---|
| Windows実機 | 未実施 | Chrome stable 未実施 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 未添付 | NOT RUN |
| Windows実機 | 未実施 | Edge stable 未実施 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 未添付 | NOT RUN |
| iPhone/iPad実機 | 未実施 | iOS Safari 未実施 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 未添付 | NOT RUN |

## 判定規則

- プロジェクト所有者または明示委任された検証者が実施する。
- 手動3行すべてに端末/OS/browser版、操作結果、画面または動画証拠、判定者を記録する。
- Firefox/WebKit/Android相当viewportは自動結果、実行日時、対象commit、ログ参照を記録する。
- 自動試験失敗または固有リスクを検出した場合は、該当実機を追加し同じ証跡項目を満たす。
- 端末を用意できない場合はPASSにせず、ProjectFactoryのqueueへ検証協力または要求変更を登録する。

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
| repository ID / URL | 未実施 |
| run ID / URL | 未実施 |
| event / ref / head SHA | 未実施 |
| workflow path / workflow SHA / conclusion | 未実施 |
| artifact ID / name / digest | 未実施 |
| artifact内catalog hash | 未実施 |
| observedAt / reviewer | 未実施 |
| deployment不在 | 未実施 |
| Pages hash before / after | 未実施 |
| negative run SHA / base candidate SHA / failure reason | 未実施 |

成功runは同一repositoryのprivate feature branch上の候補commitを対象とする。negative runは候補commitをbaseにした検証専用branch/PRで作成し、候補commit自体を変更・昇格しない。

## VisibilityPlanEvidence（承認前）

| 項目 | 証跡 |
|---|---|
| repository ID / URL | NOT RUN（GitHub CLI未認証） |
| current visibility | NOT RUN（privateのread-only実観測なし） |
| Pages enabled | NOT RUN |
| `PAGES_DEPLOY_ENABLED` | NOT RUN |
| `PAGES_DEPLOY_COMMIT` | NOT RUN |
| release commit / catalog hash | 候補commit未確定 / `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1` |
| Pages hash / observedAt / evidence | NOT RUN |

2026-07-19T12:45:05+09:00時点でworking treeは未コミット、`gh auth status`は未認証だった。実状態を推測でPASSにせず、候補commitのcommit/push後に同一repository・SHA・catalog hashへ結合して取得する。

## Q-005回答の受領結果（2026-07-19）

ProjectFactory受信箱から10項目すべてに`PASS`が送信された。ただし証跡メモを内容確認した結果、次は実施証拠ではなく要件・手順への指摘だったため、機械的に実機PASSへ転記しない。

- Firefox: 「FireFoxはいらんでしょう」— 対象ブラウザ要件の見直し提案。
- Android Chrome: 「androidなんてオタクしか使ってない」— 対象端末要件の見直し提案。
- hosted Actions: 「手順がよくわからない」— 未実施として扱う。現在の候補変更が未コミット・未pushのため、先にリリース候補をGitHubへ置く必要がある。
- 演出低減: 回答後に「効果が分からない」と追加指摘。CHG-F001-004で状態・停止対象・端末設定優先の説明を修正した。

Chrome、Edge、Safari、iOS Safari、一般目視、スクリーンリーダー、repository設定の回答メモは受領したが、OS/browser版・画面証拠が未記入のため、本表の厳密な実機PASS条件はまだ満たさない。Q-005は回答処理済みとして閉じ、試験範囲の選択と修正後の目視確認を新しい受信箱項目へ分離する。
