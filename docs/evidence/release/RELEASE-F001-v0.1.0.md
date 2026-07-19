# F001 v0.1.0 リリース結果

## 判定

**RELEASED**。修正版commit `2733b5fd368e847a01708724511f993f5e1b2484`をmainへfast-forwardし、GitHub Pages公開、artifact/deployment/catalog hash chain、公開後browser smoke、deploy変数無効化、remote tagを完了した。

## Release chain

| 項目 | 結果 |
|---|---|
| 承認 | Q-011 `承認（公開）`、正規化値`承認`、対象SHA一致 |
| Actions | run `29691164266`、build/deploy success |
| artifact | ID `8443611253`、digest `sha256:668f9ee1d9da903e6bb83ac48c529d46512956dbd657a38507a3f28b950d31d2` |
| deployment | ID `5511558405`、`github-pages`、success |
| catalog chain | artifact・deployment・Pagesとも`5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1` |
| Pages | `https://iwatahiroki0827.github.io/bungo-zundamon/`、index/catalog HTTP 200 |
| deploy変数 | `PAGES_DEPLOY_ENABLED=false`、`PAGES_DEPLOY_COMMIT`削除 |
| repository | Public |
| tag | remote `v0.1.0`のpeeled commitが修正版SHAと一致 |

## 公開後browser smoke

Chrome stableとEdge stableで390×844、844×390、1440×900を確認した。トップ・作者・3作品・音声の再生/一時停止/再開/停止・クレジット遷移を完遂し、クレジットの横overflow、外部通信、request failure、console/page errorはいずれも0件だった。

## 既知の残余リスク

iOS Safari物理端末とスクリーンリーダーの詳細証跡は未取得。Q-009およびQ-011で、当該リリース限りのプロジェクトオーナー受容として開示済みである。
