---
task: T-062
feature: F004
phase: implement
result: PASS
completed_at: 2026-07-28T01:06:31+09:00
---

# T-062 実装証跡

## 実装結果

- 全公開台詞へ、お気に入り登録・解除ボタンを追加した。
- `aria-pressed`、可視ラベル、状態classを同一transitionから更新し、お気に入り操作では音声を再生しない。
- 固定key `bungo-zundamon:favorites:v1` とversion 1のID専用schemaで端末内へ保存する。
- raw 262,144 UTF-16 code unit、ID長128、5,000件の上限を設け、未知ID・重複IDを現行Catalog順へ正規化する。
- storage provider取得、read、write、remove、quotaの例外時は、閲覧を停止せずページ寿命のmemory stateへ縮退する。
- application mountごとにFavoriteControllerを1個生成し、作者routeと`#/favorites`で共有する。
- お気に入り一覧で作者・作品・台詞・音声をCatalog順に表示し、単一音声再生、解除後focus、空状態を提供する。
- 元作品への明示操作時だけone-shot intentを生成し、対象作品を展開して台詞へfocusする。直アクセス・再読込・back/forwardは初期全閉を維持する。
- security checkerはお気に入りmoduleの固定storage token・key・version・get/set/remove・schemaだけを許可し、他storage、Cookie、form、IndexedDBを拒否する。

## 自動検証

- `npm test`: 54 files / 918 tests PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: 495 files / 164,323,640 bytes PASS
- `git diff --check`: PASS
- 独立受け入れ判定: PASS（High / Medium / Low = 0 / 0 / 0）
