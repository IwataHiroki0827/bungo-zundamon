# T-068 実装受け入れ証跡

## 判定

- 対象: F005候補定義・固定baseline・権利原典・entity正規化基盤
- 判定: PASS
- 独立受け入れ: High 0 / Medium 0 / Low 0
- 判定日時: 2026-07-29T11:55:31+09:00

## 実装結果

- 夏目漱石「夢十夜」「倫敦塔」「趣味の遺伝」の承認済み候補定義を追加した。
- 公開済みv0.4.0の全694 content file、Catalog参照、bytes、SHA-256、Git modeを固定baselineへ記録した。
- Git index、全Git blob、`public/audio/F005`、`dist`、`.cache`を完全列挙する容量inventoryと、再列挙一致を要求するforecastを実装した。
- 青空文庫の3規約原文を実通信で取得し、TLS・接続先・本文完全性・条項判定をfail-closedで証跡化する原典取得を実装した。
- XHTML entityを検査・正規化し、原文bytes/SHAと正規化artifactを結合する基盤を実装した。
- Windowsのreparse point、hardlink、source/parent swap、target差し替えを固定SHAのself-contained native helperと保持中handleで防御した。
- `updatedAt`は実在する暦日だけを受理し、校正者なしは`null`のまま保持する。

## Registry三段階移行

1. 実装commit `ffdb47f08e5969bccb6d275f5bcb61052c7e7c77`でF003/F004 projectionを不変のままF005を統合した。
2. control commit `3a5620fe63270278613d928bd5558326328097ea`で移行証跡だけを追加した。
3. acceptance commit `0c4c5ba2234df5443b65ee1c2a0a6370e44e0d28`でF003/F004/F005の実loader証跡と受入証跡だけを追加した。

production controlは上記3 commitをGit objectから再計算し、統合registry SHA-256 `f36eb7fcc735dad6fa33e429fa88828d9075d6ee23c0c9e1aed0dcc1c21fc607`を確認してmintされた。

## 検証結果

- 全回帰: 62 test files / 1053 tests PASS
- 最終修正後重点回帰: 5 test files / 131 tests PASS
- native source/parent swap反復: 10 / 10 PASS、guard残留process 0
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS、697 files / 229,935,951 bytes
- `native/f005-guard/build.ps1`: PASS、固定SDK/runtimeのSHA-512検証、self-contained publish、evidence再読一致
- `git diff --check`: PASS

## 非変更範囲

- T-068では公開`public` tree、公開Catalog、公開音声、公開routeを変更していない。
- nullable書誌の画面統合、夏目漱石Catalog、独自画像、route、お気に入り統合はT-069で実施する。
- 完了時のC:空きは49,493,008,384 bytes（46.09 GiB）で、5 GiB停止基準を上回る。
