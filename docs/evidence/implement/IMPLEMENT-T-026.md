# T-026 実装・作品単位受け入れ証跡

## 判定

- タスク: T-026（「注文の多い料理店」の全候補レビュー・音声生成・作品単位受入）
- 対象feature / batch / work: F002 / F002 / 043754
- 実装判定: PASS_WITH_WARNING
- 独立受け入れ判定: PASS_WITH_WARNING
- 警告: `CAPACITY_ACTUAL_REPOSITORY_WARNING`
- 判定日: 2026-07-25

## 原典・権利・全候補レビュー

- 青空文庫の公式書誌を正本とし、宮沢賢治（人物ID`000081`）、作品ID`043754`、カード`https://www.aozora.gr.jp/cards/000081/card43754.html`、本文`https://www.aozora.gr.jp/cards/000081/files/43754_17659.html`を照合した。
- 人物・作品著作権`なし`、役割`著者`、翻訳者なし、状態`公開中`、文字遣い`新字新仮名`を確認した。
- 原典から78候補を抽出し、全件の前後文脈を確認した。発話65件を`SPOKEN_DIALOGUE`として承認し、扉・看板等に書かれた資料13件を`QUOTED_MATERIAL`として音声対象から除外した。pendingは0件である。
- 候補とレビューのID・順序0〜77・core SHA-256・表示本文は完全一致した。
- 抽出source tree hashは`fe25cec8e663b5b4977faebe377fd24c049d380a4813240c374bcb94dcc7ed86`、review output hashは`5f5235ef63070f33aaccf238ef47f6e0c44d40d100af05652d462f4ed7df368c`である。
- 読み補正は12候補・12履歴で、表示本文は原典のまま保持した。補正artifact SHA-256は`9998b36e312c5bfd364b5cb2eb121fa7c9ac2146f8f50a451ebe0000bf69440d`である。
- 「二三発」「し腹」の語境界、「空いた」「開けてる」「ははあ」「これはね」「気」「書きよう」「客さん」「さま方」「ぐゎあ」「くゎあ」等を音声用表記だけで補正した。
- VOICEVOX 0.25.2 / style 3の`audio_query`を78候補すべてで確認し、12件の修正版も再照合した。

## VOICEVOX音声生成

- 接続: `127.0.0.1:50021`のloopback限定
- 話者: ずんだもん / UUID `388f246b-8c41-4ac1-8e2d-5d79f3ff56d9` / style 3 `ノーマル`
- 正規化設定hash: `0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691`
- クレジット: `VOICEVOX:ずんだもん`

承認65候補のうち同一発話1組をdeduplicateし、64種類を生成した。除外13候補には音声を生成していない。事前推定は19,676,096 bytes、plan digestは`869c414ef804778eb5e622f0fa04b20c1b1d2b1e7e01296c4d88c3f0a5dad2c5`でPASSした。

受け入れ正本`content/batches/F002/accepted-audio/043754/`には64 WAV、合計17,576,192 bytes、366,113 msをatomic昇格した。全件についてregular file、非reparse、RIFF/WAVE header、audio ID、設定hash、SHA-256、byte数、duration、staging/accepted一致を確認し、欠損・孤立は0件だった。

- generation digest: `517208c840e0008a0b788c9d974f7453c62a1207746064a7f2063e78cb995718`
- completeness digest: `174ea1e2c6b4acef2c8507c5fcb542556de7cde709f4aafdc0d850dac8f38765`
- 作品状態: `accepted`
- 受入時刻: `2026-07-25T13:05:34.300Z`

## 3作品累積preview・容量

統合previewは219 files / 81,762,548 bytes、F002の全3作品・公開台詞154件・重複除外後音声152件・編集除外13件で、build SHA-256は`ecb5528b43b6754780234a9e244a7da500bde1d3f942a05c53edfa3cefa62287`である。

| 区分 | 実測 | 上限・下限 | 判定 |
|---|---:|---:|---|
| 累積追加音声 | 47,741,940 bytes | 100 MiB以下 | PASS |
| Pages artifact | 81,838,848 bytes | 750 MiB以下 | PASS |
| 単一Git object | 17,155,886 bytes | 100 MiB以下 | PASS |
| source repository | 814,330,905 bytes | 警告750,000,000 / 停止1,000,000,000 bytes | WARNING |
| 作業ドライブ空き | 44,658,331,648 bytes | 603,979,776 bytes以上 | PASS |

repositoryは警告閾値を64,330,905 bytes超過したが、停止上限まで185,669,095 bytesの余裕がある。仕様どおり総合判定を`pass_with_warning`とし、警告を証跡へ固定して受け入れを継続した。

## 不変性

- 先行2作品は88 WAV / 30,420,768 bytes、accepted tree digest `8ce3ed603f4f9fc5ee00d51f83d05192e9f7f68f498d9269fcab8521942f75fc`を受け入れ前後で維持した。
- 受け入れ後は3作品152 WAV / 47,996,960 bytes、accepted tree digest `b1198c61a7378710bcf87fde629be896df78925ddd0dc947d9302858ce67a2d3`となった。
- F001 content / dist固定baselineはともにPASSした。
- `public/`は63 files / 30,347,061 bytesと固定tree digestを維持し、Git差分は0件だった。
- F002 batch内の3作品はすべて`accepted`となった。

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: 36 files / 648 tests PASS
- `npm run build`: PASS（66 files / 30,423,361 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- 独立受け入れでは、権利、78候補、12読み補正、65承認・13除外、64 WAV、manifest証跡連鎖、容量5区分、先行作品・F001・`public/`不変を実物から再計算し、repository警告以外のHigh/Medium不適合なしでPASS_WITH_WARNINGとした。
