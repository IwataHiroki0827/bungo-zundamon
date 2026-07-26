# IMPLEMENT-T-042 F003最終Catalog統合

## 結果

- 対象source commit: `6376dca96dc85b03a4711288102e9f5b10c9cc10`
- 結果: `pass`
- 最終content build SHA-256: `cd92007ecdddaa0a4c2b3ec28fac07650cc42c17fa23a9ab77bc6ce5062410ea`
- 最終Catalog SHA-256: `591b127e62e4c7686f3a47dc1476426185fe0c825e9092af892cd00e62d97769`
- 統合report SHA-256: `d61a5ff4be6665042988a163cc7ef307005fe38c000f86024c83490dc8d2008c`

## 統合内容

- 固定F001、固定v0.2.0 F002、accepted F003をbatch順に統合した。
- 永続artifactだけから太宰治3作品の候補・編集判定・音声・出典・noticeを再構築した。
- 3作者、9作品、472台詞、463音声、492ファイルを参照と実体で逆joinした。
- F003は282候補のうち259件を公開対象、23件を編集除外、音声除外0件とした。
- F003の259台詞を255個の一意音声へ対応した。
- `グッド・バイ`だけを`unfinished`とし、未完・公式内容注意・括弧発話抜粋を3配置へ結合した。
- `女生徒`は公式内容注意と括弧発話抜粋、`走れメロス`は括弧発話抜粋を3配置へ結合した。

## 既存公開不変

- F001 baseline SHA-256: `722b88affbc84a3e1250bcc1e2e6d538957a02d94483b706bb55609483b9fbc9`
- F001 content invariant: `pass`
- 固定v0.2.0 published baseline SHA-256: `305ab8e6984eff15887bd8a0ac50d9ab8619abeeb0b5c3e3dea3ff6d8b5730b6`
- published invariant report SHA-256: `88fcc8c976a8a7cfbc35659cb02ef0dcabff4de4f0a31e072fa8fb93b79f006e`
- published invariant mismatches: 0件
- 既存`public/`差分: 0件

## 検証

- 最終統合production script: PASS
- Vitest: 47 files / 841 tests PASS
- TypeScript: `tsc --noEmit` PASS
- ESLint: warning 0 / error 0
- production build: 229 files / 81,725,259 bytes PASS
- F003 trace coverage: 100%、gap 0

## 独立受け入れ

- 判定: PASS
- 重大度: High 0 / Medium 0 / Low 0
- `sourceCommit`と実行時HEADが`6376dca96dc85b03a4711288102e9f5b10c9cc10`で完全一致することを確認した。
- build・Catalog・reportの各SHA-256、3作者・9作品・472台詞・463音声・492ファイルを独立照合した。
- F003の282候補、公開259件、編集除外23件、一意音声255個、作品注意、既存公開不変、`public/`差分0件を確認した。
