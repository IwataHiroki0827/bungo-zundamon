# 文豪ずんだもん F001 振り返り

## 結果

- リリース: `v0.1.0`
- release commit: `2733b5fd368e847a01708724511f993f5e1b2484`
- 公開URL: `https://iwatahiroki0827.github.io/bungo-zundamon/`
- 最終判定: `RELEASED_WITH_ACCEPTED_RISK`
- 収録: 3作品、レビュー済み59台詞、音声失敗0件

## うまくいった点

- 要求・設計・UT/IT/QT・実装をタグで追跡し、最終`trace_check`で対応漏れ0件を維持した。
- UT 337件、Playwright E2E 78件、Chromium/Firefox/WebKit/Android相当/Chrome/Edge、hosted成功・制御失敗runを組み合わせて確認した。
- deployを承認対象SHA、`PAGES_DEPLOY_ENABLED`、`PAGES_DEPLOY_COMMIT`へ拘束し、承認前および別SHAの公開をfail-closedにした。
- 初回公開後のHTTP 200だけで完了にせず、実ブラウザsmokeを続けたことで、390px幅クレジットの横overflowをtag push前に検出できた。
- 不具合検出後はPages停止・repository Private化へrollbackし、原因修正・再発防止E2E・全回帰・hosted再検証・再承認を経て再公開した。

## 問題点と改善

### 手動証跡入力が重かった

Q-005/Q-009では、端末・版・操作・画像など多くの入力をユーザーへ求め、回答負荷が高くなった。Codexが取得できるGitHub API、Windows Chrome/Edge、規約証跡は先に自動収集し、物理端末だけを依頼する設計へ途中で改善した。iOS Safariとスクリーンリーダーの詳細証跡は、当該リリース限りのオーナー受容として残った。

### 公開前E2Eのroute網羅が不足した

レスポンシブE2Eはトップ・作者を確認していたが、長いSHA-256を表示するクレジット画面を同じoverflow検査へ含めていなかった。公開後smokeで`scrollWidth=576`、`clientWidth=390`を検出した。`.credits-page li`へ折返しを追加し、全3 viewportでクレジットも確認するよう恒久化した。

### GitHub複数アカウントで選択ダイアログが出た

Git Credential Managerに2アカウントが登録され、username未指定の認証で選択ダイアログが出た。子repositoryのlocal git configへ`credential.https://github.com.username=IwataHiroki0827`を設定し、他repositoryへ影響させず自動選択するようにした。認証情報はremote URLや設定へ保存していない。

### artifact取得のリダイレクト処理を一度誤った

GitHub artifactの外部ストレージリダイレクトへAuthorizationを持ち越したため401となり、fail-closed rollbackが作動した。`requests`のcross-host redirect処理へ変更し、artifact zip/digest/catalog hashを検証できた。

## メトリクス

| 項目 | 値 |
|---|---:|
| タスク | 14件（最終的に全件done） |
| queue | 11件（question 4、approval 7、最終的に全件closed） |
| retry台帳 | 11 attempt（pass 7、fail 4） |
| リリース公開attempt | 2回（1回rollback、2回目成功） |
| UT | 337/337 PASS |
| E2E | 78/78 PASS |
| QT | 20/20 PASS |
| 最終build | 66 files / 30,403,023 bytes |
| cost記録 | close前21件、見積token合計417,000 |
| エスカレーション | 物理iOS/スクリーンリーダー証跡1件（オーナー受容） |

## 次期リリース条件

- iOS Safari物理端末とスクリーンリーダーの詳細証跡を取得する。
- 長いhash・URL・英数字連続文字列を含む全routeのmobile overflowを継続検査する。
- GitHub artifact取得はcross-host redirectで認証ヘッダーを転送しない。
- 複数GitHubアカウント環境ではrepository localのusername固定を初期設定へ含める。
