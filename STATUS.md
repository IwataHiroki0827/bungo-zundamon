---
phase: implement
feature: F003
updated: 2026-07-26T20:19:06+09:00
next_actions:
  - "T-042でF003の最終Catalog統合・既存公開不変・全asset整合を確認する"
  - "T-043でUT・IT・QT・自動ブラウザ・権利・容量受入を実施する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0としてGitHub Pagesへ公開・クローズ済み。公開サイトは2作者・6作品・213台詞で安定稼働中。
- 収録作品は作者ページを描画するたびに全件閉じた状態から開始し、ページ遷移後に戻った場合も閉じる回帰試験がPASSしている。
- F003は太宰治「女生徒」「走れメロス」「グッド・バイ」を小さい作業単位から順に追加する。
- SRS/FD/DD/QTに加えてUT-F003・IT-F003もApproved。ゲート①〜③を通過した。
- T-037で候補・原典・独立二重レビュー契約、T-038で太宰治画像・作品注意・provenance chainを実装済み。
- T-039で「女生徒」47候補を31承認・16除外・保留0へ確定し、31候補を30 WAV（6,204,200 bytes）へ対応して作品単位で`accepted`へ昇格した。
- T-040で「走れメロス」62候補を全件承認し、61 WAV（24,692,348 bytes）へ対応して作品単位で`accepted`へ昇格した。
- T-041で「グッド・バイ」173候補を166承認・7除外・保留0へ確定し、165音声参照（新規164 WAV、先行作品共有1）へ対応して作品単位で`accepted`へ昇格した。
- CHG-F003-002で固定v0.2.0 published baselineを作品受入・最終統合・dist・release verificationへ結合し、既存作者entryをcanonical exactで保護した。
- 永続証跡のpathはworkspace相対POSIXへ固定し、filesystem API直前だけ絶対解決する。危険path、secret、reparse point、既存`public`差分はいずれも0件。
- 現在の全自動検証はVitest 840件、typecheck、lint、build、F003 trace_checkがPASSしている。T-041是正後の独立再受け入れはHigh/Medium/Low 0件。

## 直近の作業（最新5件）

- T-041「グッド・バイ」をmanifest・2種journal・176対象ファイルへatomicに結合し、独立再受け入れPASS
- 固定v0.2.0 published baselineをwork preview・accept・release chainへ結合
- 173候補を166承認・7除外へ確定し、165音声参照を新規164 WAV・共有1 WAVで構成
- F003累積音声78,897,620 bytes、Pages 164,314,362 bytes、repository 165,455,869 bytesで容量PASS
- 全840テスト・typecheck・lint・build・trace coverage 100%を確認

## 次のアクション

- T-042で3作品の最終Catalog統合、既存公開不変、データ駆動route、全asset整合を確認する。
- T-043でUT・IT・QT・自動ブラウザ・権利・容量受入を同一candidateへ結合する。
- T-044でリリース前総点検後、GitHub Pagesへ段階公開し公開5 routeをスモーク確認する。

## 未解決事項

- C:の空きはT-041容量計測時約32.27 GBで逼迫判定。危険域5 GBではないため、削除せず統合・試験・公開の各段階で再計測する。
