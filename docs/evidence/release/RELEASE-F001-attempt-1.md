# F001 v0.1.0 初回公開attempt 1

## 結果

**ROLLED_BACK**。承認対象commit `5337d2752e5a288b8d3078c2d1d133ebdef6ed21`のActions deploy、artifact/catalog hash、deployment、Pages HTTP 200まではPASSした。続くinstalled Chrome 390×844の本番browser smokeで、クレジット画面の`documentElement.scrollWidth=576`、`clientWidth=390`を検出したため公開完了とせず、Pagesを削除してrepositoryをPrivateへ戻した。

## 成功したrelease chain

- Q-010回答: `承認（公開）`
- Actions run: `29690261586` attempt 2、build/deploy success
- artifact: `8443370383`、digest `sha256:58e6ba34e5ffa5ae0e19256e3e15d6501c84438131f24d73ac12cb86dfc72bcc`
- artifact/catalog/Pages catalog hash: `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`
- deployment: `5511375149`、`github-pages`、success
- Pages HTTP: index 200、catalog 200
- deploy変数: 検証後に`PAGES_DEPLOY_ENABLED=false`、`PAGES_DEPLOY_COMMIT`削除

## 失敗原因と修正

- 原因: クレジットの素材README SHA-256（64文字）が`li`内で折り返されなかった。
- 修正: `.credits-page li { overflow-wrap: anywhere; }`を追加。
- 再発防止: 既存の3 viewport E2Eでクレジット画面にも`assertNoHorizontalOverflow`を実行。
- 修正版候補: `2733b5fd368e847a01708724511f993f5e1b2484`
- rollback後確認: repository Private、Pages API 404、deploy enabled false、deploy commit未設定。
