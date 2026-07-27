---
phase: implement
feature: F004
updated: 2026-07-28T01:59:40+09:00
next_actions:
  - "T-057で雪渡りを抽出・二重レビュー・音声化し作品単位でatomic受入する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0、F003はv0.3.0としてGitHub Pagesへ公開・クローズ済み。公開サイトは3作者・9作品・472台詞・463音声で安定稼働中。
- 収録作品は作者ページを描画するたびに全件閉じた状態から開始し、ページ遷移後に戻った場合も閉じる回帰試験がPASSしている。
- F003は太宰治「女生徒」「走れメロス」「グッド・バイ」を小さい作業単位から順に追加する。
- SRS/FD/DD/QTに加えてUT-F003・IT-F003もApproved。ゲート①〜③を通過した。
- T-037で候補・原典・独立二重レビュー契約、T-038で太宰治画像・作品注意・provenance chainを実装済み。
- T-039で「女生徒」47候補を31承認・16除外・保留0へ確定し、31候補を30 WAV（6,204,200 bytes）へ対応して作品単位で`accepted`へ昇格した。
- T-040で「走れメロス」62候補を全件承認し、61 WAV（24,692,348 bytes）へ対応して作品単位で`accepted`へ昇格した。
- T-041で「グッド・バイ」173候補を166承認・7除外・保留0へ確定し、165音声参照（新規164 WAV、先行作品共有1）へ対応して作品単位で`accepted`へ昇格した。
- CHG-F003-002で固定v0.2.0 published baselineを作品受入・最終統合・dist・release verificationへ結合し、既存作者entryをcanonical exactで保護した。
- 永続証跡のpathはworkspace相対POSIXへ固定し、filesystem API直前だけ絶対解決する。危険path、secret、reparse point、既存`public`差分はいずれも0件。
- T-042で固定F001・固定v0.2.0 F002・accepted F003を最終統合し、3作者・9作品・472台詞・463音声・492ファイルを確認した。
- T-043でVitest 853件、typecheck、lint、495ファイルのbuild、依存監査、4環境81件をPASSした。3件のskipはChromiumで実施した全asset照合の重複省略である。
- RuntimeAcceptance schema 1.1へclean commit、test source、4ブラウザ生レポート、public、distをhash結合し、独立再受入High/Medium/Low 0件でPASSした。
- v0.3.0はActions run 30203760729で段階公開し、公開5 route、初期全閉、画像、音声Range、CSP・外部通信を自動スモークしてPASSした。
- F003 manifestは実公開3証跡のexact tupleで`published`へ遷移し、公開後状態の全857試験・lint・typecheck・build・trace_checkをPASSした。
- F004は宮沢賢治へ「オツベルと象」「雪渡り」「カイロ団長」を追加し、台詞を端末内へ保存して作者横断で見返せるお気に入りを提供する。CHG-F004-001でREQ 21件・QT 16件へ更新し、直接要望と包括承認をQ-023へ記録した。
- T-050でT-051〜T-062へWBS分解し、既存CLI・Playwright・VOICEVOXを再利用、追加MCP不要と判定した。
- T-051/T-052でFD-F004のDES 13件、DD-F004のFUN 37件を作成した。固定v0.3.0二重baseline、同一作者reuse、端末内お気に入り、generic batch、preview/final型分離、公開後rollbackを定義し、3観点の最終独立レビューHigh/Medium/Low 0、ゲート②承認を完了した。
- T-053でUT-F004 37件、IT-F004 15件を作成し、QT-F004 16件と合わせて全REQ/DES/FUNを網羅した。網羅性・試験設計・CHG-F004-002のセキュリティ再レビューは最終High/Medium/Low 0、trace_check 100%である。
- Q-025へ包括承認を記録してテストファーストゲート③を通過した。F004はimplementへ移行した。
- T-054でcanonical definition/policy・ApprovedBatchContext・固定v0.3.0二重baselineを実装した。宮沢賢治3作品のexact tuple、公開Catalog identity、selection/predeploy権利再検証、production transport取得、3 XHTML atomic固定を全880試験と独立受入でPASSし、T-055を開始した。
- T-055でF003新規作者/F004既存作者追記の共通Catalog projector、preview/final brand、canonical manifest/source/audio join、既存宮沢画像のexact再利用、実public/dist非破壊previewを実装した。全893試験と独立受入をPASSし、T-062のお気に入り実装を開始した。
- T-062で全公開台詞のお気に入り切替、固定key/version/上限付き端末内保存、storage障害時のmemory縮退、共有FavoriteController、`#/favorites`、元作品へのone-shot移動を実装した。全918試験、495ファイルbuild、独立受入High/Medium/Low 0をPASSした。
- T-056で「オツベルと象」46候補を独立二重レビューと第三裁定により44採用・2除外・保留0へ確定した。43 WAV・9,322,340 bytesを生成し、journal付きatomic受入で`000466=accepted`へ昇格した。全930試験と独立受入をPASSし、public差分0を確認した。

## 直近の作業（最新5件）

- T-056「オツベルと象」を44台詞・43音声でatomic受入し、全930試験・独立受入PASS
- T-062のお気に入り・端末内保存・作者横断一覧を全918試験と独立受入でPASS
- T-055の共通Catalog・既存画像再利用・実public previewを全893試験と独立受入でPASS
- T-054の候補tuple・承認binding・baseline・3原典を全880試験と独立受入でPASS
- UT-F004 37件・IT-F004 15件をApproved、ゲート③通過、trace 100%

## 次のアクション

- T-057で「雪渡り」を抽出・独立二重レビュー・音声化し、作品単位でatomic受入する（REQ-F004-007〜013）。

## 未解決事項

- C:の空きはT-043完了時約26.8 GBで逼迫判定。危険域5 GBではないため、削除せずリリース・公開の各段階で再計測する。
