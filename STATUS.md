---
phase: implement
feature: F003
updated: 2026-07-26T18:49:00+09:00
next_actions:
  - "T-040で走れメロスの全候補レビューと音声生成を作品単位で完了する"
  - "T-040の容量forecast・実測・音声完全性を照合してacceptedへ遷移する"
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
- 永続証跡のpathはworkspace相対POSIXへ固定し、filesystem API直前だけ絶対解決する。危険path、secret、reparse point、既存`public`差分はいずれも0件。
- 現在の全自動検証はVitest 838件、typecheck、lint、build、F003 trace_checkがPASSしている。T-039の独立受け入れはHigh/Medium/Low 0件。

## 直近の作業（最新5件）

- T-039「女生徒」をprepared digest・manifest・2種journal・30 accepted audioへatomicに結合し独立受け入れPASS
- 絶対path、authority、ADS、query、fragment、percent、制御文字を拒否する相対POSIX path境界と否定試験を追加
- 47候補のprimary/secondary判定と第三裁定を31承認・16除外・保留0で完結
- VOICEVOX 0.25.2で31候補を30 WAVへ生成し、容量actual・F001/F002 invariantをPASS
- 作者routeへ戻った場合も収録作品を全件閉じる回帰修正をコミット

## 次のアクション

- T-040で「走れメロス」の原典抽出結果を固定し、全候補の独立二重レビューを開始する。
- 承認台詞だけを同時生成1で音声化し、容量forecast・実測・音声完全性を照合する。
- 「走れメロス」の作品単位証跡chainが完結した場合だけ`accepted`へ遷移する。

## 未解決事項

- C:の空きは約35.05 GB（3.77%）で逼迫判定。危険域5 GBではないため、削除せず作品単位・同時生成1・生成前後再計測で進める。
