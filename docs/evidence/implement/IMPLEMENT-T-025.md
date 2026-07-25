# T-025 実装・作品単位受け入れ証跡

## 判定

- タスク: T-025（「どんぐりと山猫」の全候補レビュー・音声生成・作品単位受入）
- 対象feature / batch / work: F002 / F002 / 043752
- 実装判定: PASS
- 独立受け入れ判定: PASS
- 判定日: 2026-07-25

## 原典・権利・レビュー

- 青空文庫の公式書誌を正本とし、宮沢賢治（人物ID`000081`）、作品ID`043752`、カード`https://www.aozora.gr.jp/cards/000081/card43752.html`、本文`https://www.aozora.gr.jp/cards/000081/files/43752_17657.html`を照合した。
- 人物・作品著作権`なし`、役割`著者`、翻訳者なし、状態`公開中`、文字遣い`新字新仮名`を確認した。
- scratch previewで原典から63候補を抽出し、全件を前後文脈まで確認した。レビューは63件すべて`approved`、`SPOKEN_DIALOGUE`、権利判断`allowed`、pending 0である。
- 候補とレビューのID・順序0〜62・core SHA-256は完全一致し、抽出source tree hashは`f74393388ca3d8c8d91560decdca815bfdb67eea7c1188a966a890ed9e4c8183`、review output hashは`079a0433707f8fbcb2c8e150cb4e74058a55061e32f6b3b9feee7835d21236d8`である。
- 読み補正は3候補・3履歴で、表示本文は原典のまま保持した。補正artifact SHA-256は`d30477b3f317cb6ee31433fd596405c599b59c21ff9d1ab6976c9c8ddd0d1c50`である。
  - order 38: 2回目の「押しっこ」を「おしっこ」へ補正
  - order 55: 「みょうにち出頭」を「ミョウニチ出頭」へ補正
  - order 57: 「きんのどんぐり一しょうと」を「きんのどんぐり、いっしょうと」へ補正
- VOICEVOX 0.25.2 / style 3の`audio_query`を63候補すべてで確認し、補正後に明確な誤読が残っていないことを確認した。

## VOICEVOX音声生成

- 接続: `127.0.0.1:50021`のloopback限定
- 話者: ずんだもん / UUID `388f246b-8c41-4ac1-8e2d-5d79f3ff56d9` / style 3 `ノーマル`
- 正規化設定hash: `0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691`
- クレジット: `VOICEVOX:ずんだもん`

63候補のうち同一発話1件を作品内でdeduplicateし、62種類を生成した。事前推定は19,261,288 bytes、plan digestは`a176c5cf29443ea80e08452e94634a2254c1017796d310cf8574b614651304c4`でPASSした。

受け入れ正本`content/batches/F002/accepted-audio/043752/`には62 WAV、合計17,130,664 bytes、356,837 msをatomic昇格した。全件についてregular file、非reparse、RIFF/WAVE header、audio ID、設定hash、SHA-256、byte数、duration、staging/accepted一致を確認し、欠損・孤立は0件だった。

- generation digest: `f8ebc186820a6f9c446a64caec6fbdeec795bcdab9c696daa871fcfc2998dd0d`
- completeness digest: `085c77e3cc30e1d8a5a20de43663c5af6f43e69fd3e9544a1e049660b51f58ca`
- 作品状態: `accepted`
- 受入時刻: `2026-07-25T12:40:58.612Z`

## 累積preview・容量・不変性

統合previewは154 files / 64,063,832 bytes、全体で2作者・5作品、F002公開候補は2作品・台詞89件・重複除外後音声88件で、build SHA-256は`333833baced3a34bdb36202ca0247a51e9162a06dc71758d63688f3847d697eb`である。

| 区分 | 実測 | 上限・下限 | 判定 |
|---|---:|---:|---|
| 累積追加音声 | 30,165,748 bytes | 100 MiB以下 | PASS |
| Pages artifact | 64,140,132 bytes | 750 MiB以下 | PASS |
| 単一Git object | 17,155,886 bytes | 100 MiB以下 | PASS |
| source repository | 625,062,373 bytes | 1,000,000,000 bytes以下 | PASS |
| 作業ドライブ空き | 45,021,392,896 bytes | 603,979,776 bytes以上 | PASS |

- 先行作品000473は26 WAV / 13,290,104 bytesとaccepted tree digestを維持した。
- F001 content / dist固定baselineはともにPASSした。
- `public/`の63 files / 30,347,061 bytesとtree digestは不変で、Git差分は0件だった。
- 後続作品043754は`pending`のまま維持した。

## 容量計測の修正

WindowsのCRLF候補を`git hash-object`で測定した際、clean filter後のOIDとCRLF実体byte数を同じblobとして扱い、同一OIDのlogical bytes不一致で安全停止する問題を検出した。未追跡候補は`git hash-object --no-filters`でraw実体のOIDへ結合するよう修正し、CRLF候補と既存LF blobが誤ってdeduplicateされない回帰試験を追加した。

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- 対象試験: 3 files / 39 tests PASS
- `npm test`: 36 files / 648 tests PASS
- `npm run build`: PASS（66 files / 30,423,361 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- 独立受け入れでは、権利、63候補、3読み補正、62 WAV、manifest証跡連鎖、容量5区分、先行作品・F001・`public/`不変を実物から再計算し、残るHigh/Medium不適合なしでPASSとした。
