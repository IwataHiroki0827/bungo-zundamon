# 文豪ずんだもん セキュリティ評価レポート

- 実施日時: 2026-07-20 00:02 JST
- 対象: `v0.1.0`（`2733b5fd368e847a01708724511f993f5e1b2484`）
- 本番: `https://iwatahiroki0827.github.io/bungo-zundamon/`
- 手法: ソース静的解析、依存関係監査、公開設定監査、本番ブラウザ動的解析、回帰試験

## Executive Summary

アプリケーション本体に Critical / High / Medium の脆弱性は検出されなかった。GitHubリポジトリ設定にLow相当の防御不足を3件検出し、すべて修正した。

| 重大度 | 検出 | 修正済み | 未修正 |
|---|---:|---:|---:|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 0 | 0 | 0 |
| Low | 3 | 3 | 0 |

## 指摘一覧

| ID | 問題 | 対象 | 重大度 | 工数 | ステータス |
|---|---|---|---|---|---|
| RT-001 | GitHub Actionsで任意の第三者Actionを許可し、完全SHA固定を強制していない | GitHub repository settings | Low | S | 🟢 修正済み |
| RT-002 | Secret scanning、push protection、Dependabot security updatesが無効 | GitHub repository settings | Low | S | 🟢 修正済み |
| RT-003 | `main`のforce-pushと削除をリポジトリ設定で禁止していない | GitHub branch protection | Low | S | 🟢 修正済み |

## RT-001

- **問題**: リポジトリ設定が`allowed_actions: all`、`sha_pinning_required: false`だった。
- **攻撃シナリオ**: 将来のworkflow変更で、タグ差替えや管理主体の異なるActionを不用意に追加すると、CI実行環境で任意コードを実行される可能性がある。
- **影響**: ビルド成果物の改ざん、workflowに付与された権限の悪用。
- **修正方針**: GitHub所有Actionだけを許可し、完全長commit SHA固定をリポジトリ設定でも強制する。
- **修正結果**: `allowed_actions: selected`、`github_owned_allowed: true`、`verified_allowed: false`、`sha_pinning_required: true`へ変更。既存workflowの全Actionが完全長SHA固定済みであることを再確認した。
- **ステータス**: 🟢 修正済み

## RT-002

- **問題**: Secret scanning、push protection、Dependabot security updatesが無効だった。
- **攻撃シナリオ**: 認証情報や既知脆弱性を含む依存関係が将来の変更で混入しても、push時または継続監視で検知できない。
- **影響**: 認証情報漏えい、既知脆弱性を含む依存関係の公開継続。
- **修正方針**: GitHubのリポジトリセキュリティ機能と脆弱性アラートを有効化する。
- **修正結果**: Secret scanning、push protection、Dependabot alerts/security updatesを有効化。修正後のopen alertはSecret scanning 0件、Dependabot 0件だった。
- **ステータス**: 🟢 修正済み

## RT-003

- **問題**: `main`が未保護で、force-pushやbranch削除をリポジトリ設定で防止していなかった。
- **攻撃シナリオ**: write権限の誤操作または侵害時に、公開元履歴をforce-pushで置換するかbranchを削除する。
- **影響**: 公開履歴の破壊、復旧遅延、意図しないPages更新。
- **修正方針**: 現行のProjectFactoryによる通常pushを維持しつつ、force-pushとbranch削除を禁止する最小branch protectionを設定する。
- **修正結果**: `main`をprotectedにし、`allow_force_pushes: false`、`allow_deletions: false`を確認した。通常push、必須status check、必須reviewの条件は変更していない。
- **ステータス**: 🟢 修正済み

## アプリケーション検査結果

- XSS: DOM生成は`textContent`/`replaceChildren`を使用。異常hash routeは404表示になり、外部request・HTML注入は発生しなかった。
- 外部リンク: 許可origin/pathを検証し、`target="_blank"`には`noopener noreferrer`が付与されている。
- CSP/通信: `default-src 'self'`を基準とするCSPを配信HTMLで確認。本番の全routeで同一origin以外のrequest、CSP違反、console errorは0件だった。
- 認証・保存: ログイン、form、Cookie、localStorage、sessionStorageは使用していない。
- ビルド時取得: 青空文庫HTTPS固定、DNS pin、private address拒否、redirect/proxy拒否、容量・timeout制限を確認した。
- ファイル処理: workspace外書込み、reparse point、ZIP path traversal、ZIP bombを拒否する検証を確認した。
- 機密情報: tracked secret filenameは`.env.example`だけで、値はplaceholder。既知のtoken/private-keyパターンは検出されなかった。
- 依存関係: `npm audit`は0件（Critical / High / Moderate / Lowすべて0）。

## 動的・回帰試験

- `npm run verify`: PASS
  - ESLint: PASS
  - Vitest: 19 files / 337 tests PASS
  - オフラインproduction build: 66 files / 30,403,023 bytes PASS
- `npm run test:e2e`: Chromium、Firefox、WebKit、Android相当、Chrome stable、Edge stableで78/78 PASS
- 本番巡回: home / author / credits / 異常hash routeでHTTP・描画・外部通信・Cookie/storage・consoleを検査しPASS
- 公開catalog: HTTP 200、`Content-Type: application/json; charset=utf-8`

## ホスティング上の観察事項

GitHub Pagesの応答はHSTSを含む一方、任意の`X-Frame-Options`や`X-Content-Type-Options`をアプリ側から設定できない。現状は認証、入力、状態変更、個人データを持たない静的閲覧・音声再生サイトであり、frame埋込みによる機密操作への影響はない。将来、認証や状態変更機能を追加する場合は、custom response headerを設定できる配信基盤への移行をセキュリティゲートにする。

## 判定

**PASS** — 検出した防御不足はすべて修正済みで、作者・作品・音声の追加へ進める。
