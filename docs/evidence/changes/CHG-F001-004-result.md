# CHG-F001-004 検証結果

実施日: 2026-07-19

## 原因再現

従来実装は設定切替後に`data-motion="reduced"`となりCSSアニメーションを停止していたが、見える説明は「演出を標準に戻す」のみだった。停止対象のページ切替は420ms、再生アイコンは再生中だけのため、効果を認知しにくかった。OS reduced時も同じ操作可能な見た目だったが、設定優先順位により標準へ戻せなかった。

## 修正後の実物確認

- 標準: `演出：標準 / ページ切替と再生アイコンが動きます`。
- サイト設定低減: `演出：控えめ / ページ切替と再生アイコンの動きを停止中`。
- OS reduced: `演出：控えめ / 端末設定により動きを停止中`、button disabled。
- 実配信`http://localhost:4173/bungo-zundamon/`で標準→控えめの表示変化をPlaywrightから確認した。

## 回帰試験

- `npm test`: 19ファイル、302/302件PASS。
- `npm run typecheck`: PASS。
- `npm run lint`: PASS。
- `npm run build`: PASS（66ファイル、30,403,006 bytes）。
- Playwright: Chromium、Firefox、WebKit、Chrome stable、Edge stableの合計65/65件PASS。

初回独立受け入れでは、E2E後の`playwright-report/**`をESLintが走査する問題をMedium 1件として検出した。`eslint.config.js`のglobal ignoresへPlaywright生成物を追加し、E2E生成物が残る状態でlintを再実行してPASSした。

## Q-008 目視確認（2026-07-19）

- 回答: 「修正後の演出説明を確認した」。
- `motion_clarity`: **PASS**。現在状態と効果の説明が分かるというCHG-F001-004の確認目的を満たしたため、QT-F001-015の目視確認を受理した。
- 証跡メモには、サイト内の演出切替を廃止して常に標準演出にすること、クレジット遷移を含めサイト全体の演出を統一することへの変更意向が含まれていた。
- 上記の追加意向はQ-008のPASS判定と分離した。`pf-test`では実装せず、Q-007の`pf-change`再開時に要求・設計への影響を変更管理する。
