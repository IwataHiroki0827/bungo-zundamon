---
phase: closed
feature: F001
updated: 2026-07-19T23:42:19+09:00
next_actions: []
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- T-014は独立再受け入れHigh 0 / Medium 0 / Low 0で完了済み。
- UTは仕様ID42/42・337/337件、ITは仕様ID20/20・production build・Playwright 65/65件、QT自動4範囲は52/52件をPASSした。
- 候補`5337d2752e5a288b8d3078c2d1d133ebdef6ed21`をprivate `feature/F001`へpush済み。catalog SHA-256は`5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`。
- GitHub REST APIでrepository private、Pages未構成、deploy変数未設定、候補run `29672450957`成功、artifact digest/download/catalog hash一致、deploy/deployment不在を確認した。
- negative attempt 1のfixture不備をattempt 2で修正し、run `29684314188`で通常337件PASS・専用fixture 1件だけ制御失敗、deploy/artifact/deploymentなしを確認した。
- Windows 11のChrome 150.0.7871.127とEdge 150.0.4078.83でネイティブ音声全操作、3 viewport、CSP・外部通信0件を確認し、PNG 8枚を保存した。
- 公式規約・クレジットは現行URLと照合してPASSした。
- Q-009はプロジェクトオーナーの直接指示によりcloseした。iOS Safariとスクリーンリーダーの詳細証跡不足は、当該リリース限りの残余リスクとして受容し、ゲート④へ開示する。
- QTは20/20件PASS、T-010とCHG-F001-005は完了し、T-011のリリースフェーズへ移行した。
- リリース前総点検はtypecheck、lint、UT 337/337、E2E 78/78、build、TM、変更台帳、production secret scan、hosted/visibilityをPASSした。
- `v0.1.0`のローカルannotated tagを候補SHAへ作成し、公開範囲と環境差分を明記した承認ゲート④ Q-010を登録した。tagのremote pushはdeploy成功後まで行わない。
- Q-010承認後のattempt 1はActions deploy・HTTP 200・catalog hashまでPASSしたが、本番Chrome 390pxのクレジット画面で長いSHA-256による横overflowを検出したため、Pages停止・repository Private化へrollbackした。
- `.credits-page li`の折返しと3 viewport再発防止E2Eを追加した修正版候補`2733b5fd368e847a01708724511f993f5e1b2484`を作成した。typecheck、lint、UT 337/337、E2E 78/78、Chrome/Edge native audio・3 viewport、private hosted run `29690629227`をPASSした。
- `v0.1.0`のローカルtagを修正版SHAへ付け直し、修正版の承認ゲート④ Q-011を登録して再承認を受けた。
- Q-011承認後、修正版commit `2733b5fd368e847a01708724511f993f5e1b2484`をmainへ公開した。Actions run `29691164266`、deployment `5511558405`、artifact/catalog/Pages hash chain、Chrome/Edge 3 viewport・native audio・クレジットoverflowをPASSした。
- deploy変数を無効化し、remote `v0.1.0` tagを修正版SHAへpushした。公開URLは`https://iwatahiroki0827.github.io/bungo-zundamon/`。
- `docs/retrospective.md`へ振り返りを作成し、KB-0007/KB-0008をProjectFactoryナレッジへ登録した。全task・queueを完了し、registryを`archived`へ変更した。

## 直近の作業（最新5件）

- GitHub APIで候補hosted run・artifact・visibility chainを実証
- negative runのfixture不備を検出し、専用testへ分離して再試験PASS
- Chrome/Edge stableをネイティブHTML Audioで自動操作し画面証跡8枚を保存
- CC BY 4.0・青空文庫・VOICEVOX・ずんずんPJの現行規約URLを確認
- Q-009の詳細証跡不足をオーナー例外受容として記録し、QT 20/20件をPASSへ更新
- T-010完了、CHG-F001-005 done、T-011 doingへ更新
- v0.1.0リリース前総点検PASS、CHANGELOG・precheck・local tag作成、Q-010登録
- attempt 1の公開後overflow検出、即時rollback、修正・全回帰・hosted再検証PASS
- 修正版candidate/tagを`2733b5f`へ更新し、Q-011再承認を登録
- 修正版を公開し、release chain・公開後browser smoke・remote tagを完了
- 振り返り・ナレッジ転記・アーカイブ化を完了

## 次のアクション

- なし。再開する場合は`registry.yaml`の`visibility`を`visible`へ戻す。

## 未解決事項

- iOS Safariとスクリーンリーダーの詳細証跡は未取得。オーナーが当該リリース限りで受容済みであり、ゲート④の環境差分へ明記する。
- iOS Safari物理端末とスクリーンリーダーの詳細証跡は次期リリース条件として`docs/retrospective.md`へ継続した。
- Q-008追加意向: 切替廃止・常時標準・クレジット遷移統一は別変更候補として未着手。
