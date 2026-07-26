# IMPLEMENT-T-041 グッド・バイの作品単位受入

## 結果

- 対象: F003 / 太宰治「グッド・バイ」 (`000258`)
- 状態: `accepted`
- 全候補: 173件
- 編集判定: 承認166件、除外7件、保留0件
- 音声: 166候補を165個の一意WAVへ対応（新規配置164個、先行作品との共有1個）
- 対応音声実測: 48,044,636 bytes（新規配置48,001,072 bytes、共有43,564 bytes）
- 容量判定: `pass`
- 受入主体: `f003-acceptance:a69ebfdab15eeab2211244cad3e2a898e5b388b5d9c8566d0ffbc1feaa125c7d`

## 実装・運用内容

1. 原典から抽出した173候補をprimary・secondaryが独立判定し、理由コードと話者表記の差8件を第三裁定で解消した。
2. `SPOKEN_DIALOGUE` 166件、`QUOTED_MATERIAL` 3件、`EXPRESSION_EXAMPLE` 4件へ確定し、保留0件でtrusted authorization storeへ登録した。
3. 候補安全性、容量forecast、VOICEVOX生成、音声完全性、容量実測を順に実行し、166候補を165個の一意WAVへ対応した。
4. 先行accepted作品と同じ音声を再配置せず、候補IDの対応だけを累積Catalogへ統合する共有音声処理を追加した。
5. 3作品累積previewで492ファイルを検査し、「女生徒」「走れメロス」「グッド・バイ」を同時に再構築できることを確認した。
6. 固定v0.2.0公開baselineをpreviewへ投影し、既存F001/F002 entryのcanonical一致とF003 entryだけの追記を検証した。
7. published invariantを含む9点allowlistの作品証跡を再読込し、accepted audio・manifest・journalを単一prepared digestへatomicに結合した。
8. acceptanceを再実行し、対象176ファイルの集合SHA-256が前後一致して冪等収束することを確認した。

## 容量証跡

- T041新規配置音声: 48,001,072 bytes（164 WAV）
- 先行作品からの共有音声: 43,564 bytes（1 WAV、再配置なし）
- F003累積音声: 78,897,620 bytes / 上限104,857,600 bytes
- Pages成果物: 164,314,362 bytes / 上限786,432,000 bytes
- repository候補: 165,455,869 bytes / 上限1,000,000,000 bytes
- 最大単一Git object: 17,155,886 bytes / 上限104,857,600 bytes
- 計測時の作業drive空き: 32,273,739,776 bytes / 必要最小150,994,944 bytes
- F001/F002 content・dist invariant: `pass`
- 固定v0.2.0 published content invariant: `pass`
- published invariant report SHA-256: `a450cc96abf18ece5a7d05d18c2563568a3734c939ae0540560b66ba284f29b0`
- 既存`public/`差分: 0件

## 検証

- Vitest: 46 files / 840 tests PASS
- TypeScript: `tsc --noEmit` PASS
- ESLint: warning 0 / error 0
- production build: 229 files / 81,725,259 bytes PASS
- F003 trace coverage: 100%、gap 0
- 全165 WAVのSHA-256・bytes・RIFF/WAVEヘッダー: PASS
- 永続artifactの絶対path・ユーザー名・backslash・危険path: 0件
- secret pattern・reparse point: 0件
- acceptance再実行: 対象176ファイルの集合SHA-256が前後一致してPASS

## 独立受け入れ

- 初回判定: REDO
- 初回指摘: 固定v0.2.0 published baseline検査が作品受入chainへ未結合で、追記可能な作者画像集約manifestをファイル全体exactとして扱っていた。
- 是正: `CHG-F003-002`で固定Catalog projection、既存作者entry canonical exact、検証済みF003 entry追記、published invariant hash chainを明確化・実装した。
- 再受け入れ判定: PASS
- High: 0件
- Medium: 0件
- Low: 0件
- 固定v0.2.0 baseline、Catalog projection、作者画像由来、173候補、165音声参照、176対象ファイル、2種journal、manifest、acceptedBy、容量、冪等性を実物から再計算して一致した。
- 対象24試験、全840試験、typecheck、lint、build、trace_check、`public/`差分0を独立確認した。
