---
phase: implement
feature: F004
updated: 2026-07-27T23:00:16+09:00
next_actions:
  - "T-054でF004候補manifest・固定v0.3.0二重baseline・権利原典を実装する"
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
- Q-025へ包括承認を記録してテストファーストゲート③を通過した。F004はimplementへ移行し、T-054を開始した。

## 直近の作業（最新5件）

- UT-F004 37件・IT-F004 15件をApproved、ゲート③通過、trace 100%
- CHG-F004-002でdeploy有効化前journal pre-armと別process cleanupを設計・試験化
- お気に入り要求をCHG-F004-001で追加し、FD/DDをDES 13件・FUN 37件でApproved
- 既存抽出器で46/64/102候補、最大242/278/290字、音声安全側予測66.65 MiBを確認
- F003 v0.3.0をGitHub Pagesへ公開し、公開後スモークPASS

## 次のアクション

- T-054で承認済み候補binding、固定v0.3.0 release/control baseline、3作品の権利・原典を実装する。

## 未解決事項

- C:の空きはT-043完了時約26.8 GBで逼迫判定。危険域5 GBではないため、削除せずリリース・公開の各段階で再計測する。
