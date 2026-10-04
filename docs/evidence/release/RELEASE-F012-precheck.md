# F012 v1.1.0 リリース前総点検

- 判定: PASS(ローカル検証範囲)。公開(deploy)は未実施
- 判定日時: 2026-10-04 JST
- 作業ブランチ: `claude/legacy-program-review-tl4jv6`(セッション指定。mainへのmerge後に公開する)
- バージョン: `1.1.0`
- 公開予定URL: https://iwatahiroki0827.github.io/bungo-zundamon/

## 候補内容

- 10作者・33作品・1314台詞・音声1296件(v1.0.0から変更なし。`public/`は無変更)
- F012追加: 連続再生、再生速度・音量(session限り)、今日の一台詞、台詞検索、お気に入りの書き出し・取り込み・共有リンク、service workerによるオフライン化(お気に入り音声は明示的有効化時のみ・50 MB上限)、作品データカードと青空文庫本文link
- 公開route: exact 13件のまま(`?fav=`はqueryでありrouteではない)
- 公開物: 1369ファイル・559,267,817 bytes(v1.0.0比 +`sw.js`・`manifest.json`・favicon SVG)
- CSP: `worker-src 'none'` → `worker-src 'self'`だけを変更(CHG-F012-001)

## 自動検証(node v24.11.0 / npm 11.6.1)

| 項目 | 結果 |
|---|---|
| `npm ci` | PASS |
| `npm run typecheck` / `npm run lint` | PASS / PASS(warning 0) |
| `npm test`(Vitest) | 1556 passed・129 skipped・40 failed。失敗40件は8ファイル(f005-context・f005-source・f006〜f011-baseline)に限られ、いずれもこの作業環境固有(浅いclone(`--depth`)で固定済み過去commitの一部が取得できない・外部取得がproxyで403)。F012変更前の同環境baselineでも同じ8ファイルが失敗しており、F012由来の失敗0。F012追加の単体・結合試験(UT-F012-001〜019、IT-F012-001〜005)は全件PASS |
| `npm run build`(build verification) | PASS(`build verification passed: 1369 files / 559267817 bytes`、既存のTOTAL_WARNING_THRESHOLD warningのみ) |
| Playwright(既存全spec+F012 spec) | Chromium・Android相当(Pixel 7): 117 passed・1 skipped(既存の設計skip: 全asset照合はChromiumだけ) |
| Playwright Firefox / WebKit / Chrome stable / Edge stable | 未実施(この作業環境にブラウザ未導入。`playwright install`は禁止条件)。CIまたはローカルWindows環境で6 project実行が必要 |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| セキュリティ | CSP必須directive(worker-src 'self'含む)、危険DOM sink 0、storage契約(専用key 1件)、外部request 0、secret 0。レビューはFD-F012.md §3 |

## 公開手順(オーナー操作)

1. `claude/legacy-program-review-tl4jv6`をレビューし、mainへmerge(fast-forwardまたはmerge commit)してpushする。
2. mainのpushで起動するGitHub Actions `Pages build and deploy`のbuild jobがgreenであることを確認する(既知フレーク: baseline.test.ts/batch-runtime.test.tsのtimeoutは再実行で解消した前例あり)。
3. repository variablesを設定する: `gh variable set PAGES_DEPLOY_COMMIT --body <mainの対象commit SHA>`、`gh variable set PAGES_DEPLOY_ENABLED --body true`。
4. 同commitのworkflowを再実行(`gh run rerun <run-id>`)し、build・deploy両jobのsuccessを確認する。
5. 公開後スモーク: トップHTTP 200、`sw.js`・`manifest.json` HTTP 200、10作者表示、今日の一台詞・検索、作者ページの連続再生・作品データ、お気に入り書き出し、service worker制御後のoffline再読込。
6. `docs/evidence/release/{RELEASE-F012.md,F012-deployment.json,F012-smoke.json}`を実データで作成する。
7. `gh variable set PAGES_DEPLOY_ENABLED --body false`へ戻し、`gh variable list`で確認する。
8. tag `v1.1.0`をrelease commitへ作成・pushする。
9. 公開後更新チェックリスト(CLAUDE.md): F012はcontent batchを持たないため`mark-published.ts`・rightsSnapshotIdsの対象はない(該当なしとして記録)。`docs/features.yaml`のF012を`closed`へ、tasks.yamlのT-214を`done`へ更新する。
