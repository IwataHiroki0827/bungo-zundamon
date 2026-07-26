# IMPLEMENT-T-039 女生徒の作品単位受入

## 結果

- 対象: F003 / 太宰治「女生徒」 (`000275`)
- 状態: `accepted`
- 全候補: 47件
- 編集判定: 承認31件、除外16件、保留0件
- 音声: 承認31候補を30個の一意WAVへ対応（同一発話1組を共有）
- 音声実測: 6,204,200 bytes
- 容量判定: `pass`
- 受入主体: `f003-acceptance:a8cd2b85050d77c71263c8fe3b7a21e4668970d7cea77887f59a9444feb39df0`

## 実装・運用内容

1. 原典から抽出した47候補をprimary・secondaryが独立判定し、意味差26件を第三裁定で解消した。
2. trusted authorization storeと3件のsealから、31承認・16除外・保留0のreconciliationを作成した。
3. candidate safety、容量forecast、VOICEVOX 0.25.2による同時生成1、音声完全性、実測容量、F001/F002不変確認を順に実行した。
4. 9点allowlistの作品証跡を再読込し、accepted audio・manifest・journalを単一prepared digestへatomicに結合した。
5. 独立受け入れで検出した端末固有絶対パスを、永続化時はworkspace相対POSIX表現、filesystem API直前だけ絶対解決する方式へ修正した。
6. path境界で先頭slash、空segment、`.`、`..`、backslash、scheme、authority、query、fragment、percent表現、制御文字、NTFS ADS形式を拒否する表駆動試験を追加した。
7. 旧受入状態は`.cache/f003-reaccept-backup/`へ退避し、`reviewed`から容量forecast・音声・実測容量・証跡envelope・atomic acceptを全再生成した。

## 容量証跡

- 追加音声: 6,204,200 bytes / 上限104,857,600 bytes
- Pages成果物: 90,987,987 bytes / 上限786,432,000 bytes
- repository候補: 111,930,324 bytes / 上限1,000,000,000 bytes
- 最大単一Git object: 17,155,886 bytes / 上限104,857,600 bytes
- 計測時の作業drive空き: 37,742,252,032 bytes / 必要最小150,994,944 bytes
- F001/F002 content・dist invariant: `pass`
- 既存`public/`差分: 0件

## 検証

- Vitest: 46 files / 838 tests PASS
- TypeScript: `tsc --noEmit` PASS
- ESLint: warning 0 / error 0
- production build: 229 files / 81,725,259 bytes PASS
- F003 trace check: 対応漏れなし
- 永続F003 JSONの絶対Windows path・ユーザー名: 0件
- acceptance再実行: 同一tree・journalを返してPASS

## 独立受け入れ

- 判定: PASS
- High: 0件
- Medium: 0件
- Low: 0件
- 9証跡、31承認・16除外、30 WAV、prepared digest、manifest・outer journal・audio journal、final StageRecordを実物から再計算して一致を確認した。
- path field 449件と全F003非binary artifactを走査し、危険path・secret・reparse point・公開差分が0件であることを確認した。
