---
phase: design
feature: F004
updated: 2026-07-26T22:54:00+09:00
next_actions:
  - "T-051/T-052でFD-F004/DD-F004を作成し、同一作者mergeと3作品pipelineを設計する"
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
- F004は宮沢賢治へ「オツベルと象」「雪渡り」「カイロ団長」を追加する。Tier大調査と独立反証評価High/Medium/Low 0を完了し、SRS-F004のREQ 17件とQT-F004の14件をゲート①でApprovedにした。
- T-050でT-051〜T-061へWBS分解し、既存CLI・Playwright・VOICEVOXを再利用、追加MCP不要と判定した。F004はdesignへ移行した。

## 直近の作業（最新5件）

- T-050でF004を設計から段階公開まで11タスクへ分解し、検証環境を整備
- F004の追加3作品を確定し、SRS-F004/QT-F004をゲート①でApproved
- 既存抽出器で46/64/102候補、最大242/278/290字、音声安全側予測66.65 MiBを確認
- F003 v0.3.0をGitHub Pagesへ公開し、公開後スモークPASS
- CHG-F003-004で公開5 routeとpublished後の固定Catalog復元を是正し、独立再レビューHigh/Medium/Low 0

## 次のアクション

- T-051/T-052で`docs/design/FD-F004.md`と`docs/design/DD-F004.md`を作成し、REQ-F004-001〜017を設計へ展開する。

## 未解決事項

- C:の空きはT-043完了時約26.8 GBで逼迫判定。危険域5 GBではないため、削除せずリリース・公開の各段階で再計測する。
