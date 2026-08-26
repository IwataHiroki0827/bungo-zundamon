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

# 文豪ずんだもん F002〜F011 一括振り返り(v0.2.0〜v1.0.0)

2026-08-26実施。F002以降pf-close(振り返り)が一度も走らず10リリース分未記載だったため、
複数エージェント協議(反復欠陥・プロセス定義・テスト/CI運用の3観点)により一括で実施した。
この「振り返りが構造的に走らない」こと自体が最大の発見であり、pf-close二段化
(フィーチャークローズ/プロジェクトクローズ)の恒久対策をProjectFactory側へ適用済み。

## 結果

- v0.2.0(宮沢賢治)〜v1.0.0(新美南吉)の10リリースで「10人になるまで進めて」directive
  (合計10作者)を達成。最終: 10作者・33作品・1314台詞・1296音声
- 全リリースでデプロイSHA拘束・実ブラウザsmoke・evidence 4点セットを維持

## うまくいった点

- 承認ゲート自動承認方針(2026-08-20)以降、品質ゲート(レビューゼロ化・trace_check・
  テスト全PASS)を維持したまま10リリースを高速に完遂した
- 音声重複のような実バグを毎回リリース前に検出し、公開後の欠陥流出は0件
- 委譲成果物の実物検証により、fork/エージェントの誤った修正(F011の56eda3e等)を
  本流へ入る前に捕捉できた

## 問題点と改善(→は適用済みの恒久対策)

1. **published未反映6連続・rightsSnapshotIds空欄7連続**: デプロイ後台帳書戻しが
   どのフェーズの責務でもなく、毎回次フィーチャーで発覚→後追い是正スクリプト計11本。
   → CLAUDE.md「公開後更新チェックリスト」新設、pf-release「デプロイ後台帳書戻し」工程化、
   pf-implementゲートチェックで前フィーチャー完結確認(二重防御)、汎用mark-published.ts共通化(KB-0015)
2. **音声重複3変種**(audioId衝突×2、byte内容一致×1)がいずれも後段検出。
   → 入力hash段+出力hash段の2段検証をKB-0012へ。CHG-F008-004/CHG-F011-001/CHG-F011-002
3. **CI既知フレーク3種が4リリース連続**(rerun毎回2〜3回)。「既知」ラベルが恒久修正の
   動機を消した。→ stderrフィルタ・autocrlf永続化・serialレーン・明示timeoutの恒久修正、
   フレーク台帳運用+2リリース連続で恒久修正強制起票(KB-0013/KB-0014)
4. **f0NN-*.tsスクリプト71本のクローン反復**、欠陥ごと複製の再発2件。
   → パラメータ化共通化第一候補の規約(pf-setup/pf-implement)、CHG履歴全件反映の複製条件
5. **F005の過剰設計**(設計のみ10サブシステム、CHG100件中84件がF005起因)。
   → pf-design「設計は実装可能な最小限に」規約
6. **forward-only FSMの手戻りコスト**(reset script 4本、無関係作品への巻き戻し波及)。
   → KB-0016(検証付き正規rewind経路の事前設計)

## KB転記(今回実施)

KB-0011(VOICEVOX 1335字制約)・KB-0012(ID一意性2段検証)・KB-0013(CIフレーク台帳)・
KB-0014(git -c/autocrlf罠)・KB-0015(台帳書戻し)・KB-0016(FSM rewind)
