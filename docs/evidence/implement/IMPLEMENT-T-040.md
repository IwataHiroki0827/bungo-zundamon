# IMPLEMENT-T-040 走れメロスの作品単位受入

## 結果

- 対象: F003 / 太宰治「走れメロス」 (`001567`)
- 状態: `accepted`
- 全候補: 62件
- 編集判定: 承認62件、除外0件、保留0件
- 音声: 62候補を61個の一意WAVへ対応（同一発話1組を共有）
- 追加音声実測: 24,692,348 bytes
- 容量判定: `pass`
- 受入主体: `f003-acceptance:fd7e5588348a20973fb64c67099076316f5d9b6eace7d3ff0a836ad28cfa34fe`

## 実装・運用内容

1. 原典から抽出した62候補をprimary・secondaryが独立判定し、理由コードと話者表記の差を第三裁定で解消した。
2. trusted authorization storeへ後続作品のauthorizationを競合検出付きで追記できるようにし、既存sealを保持したまま62承認・保留0へ確定した。
3. F003補助スクリプトを作品ID指定へ拡張し、候補安全性、容量forecast、VOICEVOX生成、音声完全性、容量実測を順に実行した。
4. work previewを先行accepted作品との累積Catalogへ拡張し、「女生徒」31台詞と「走れメロス」62台詞、F003音声91件を同時検証した。
5. 9点allowlistの作品証跡を再読込し、accepted audio・manifest・journalを単一prepared digestへatomicに結合した。
6. acceptanceを再実行し、同一tree digestとjournal SHA-256へ冪等収束することを確認した。

## 容量証跡

- T040追加音声: 24,692,348 bytes
- F003累積音声: 30,896,548 bytes / 上限104,857,600 bytes
- Pages成果物: 115,853,994 bytes / 上限786,432,000 bytes
- repository候補: 121,109,914 bytes / 上限1,000,000,000 bytes
- 最大単一Git object: 17,155,886 bytes / 上限104,857,600 bytes
- 計測時の作業drive空き: 35,062,554,624 bytes / 必要最小150,994,944 bytes
- F001/F002 content・dist invariant: `pass`
- 既存`public/`差分: 0件

## 検証

- Vitest: 46 files / 839 tests PASS
- TypeScript: `tsc --noEmit` PASS
- ESLint: warning 0 / error 0
- production build: 229 files / 81,725,259 bytes PASS
- F003 trace coverage: 100%、gap 0
- 永続artifactの絶対path・ユーザー名・backslash・危険path: 0件
- secret pattern・reparse point: 0件
- acceptance再実行: 同一tree・journalを返してPASS

## 独立受け入れ

- 判定: PASS
- High: 0件
- Medium: 0件
- Low: 0件
- manifest、outer/audio journal、最終StageRecord、9証跡、trusted seal、62候補と61 WAVを実物から再計算して一致を確認した。
- 全WAVのSHA-256・bytes・RIFF/WAVEヘッダー、累積preview、F001/F002不変、既存`public/`差分0を確認した。
