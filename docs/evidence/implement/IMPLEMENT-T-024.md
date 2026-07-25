# T-024 実装・作品単位受け入れ証跡

## 判定

- タスク: T-024（「よだかの星」の全候補レビュー・音声生成・作品単位受入）
- 対象feature / batch / work: F002 / F002 / 000473
- 実装判定: PASS
- 独立受け入れ判定: PASS
- 判定日: 2026-07-25

## 原典・権利選定

- 青空文庫の公式全作品書誌を取得し、ZIPとCSVのbyte数・SHA-256・取得時刻・source URLを`rights-selection.json`へ固定した。
- 書誌CSVは17,155,886 bytes、SHA-256は`7546211a06b110c329b3aed94c0e6df236ecd7297315bc56def65713beba1a93`、観測時刻は`2026-07-25T11:47:02.232Z`である。
- 宮沢賢治（人物ID`000081`）の3作品を照合し、人物・作品著作権`なし`、役割`著者`、翻訳者なし、状態`公開中`、文字遣い`新字新仮名`を確認した。
- 「よだかの星」は作品ID`000473`、カード`https://www.aozora.gr.jp/cards/000081/card473.html`、本文`https://www.aozora.gr.jp/cards/000081/files/473_42318.html`を正本とした。
- 権利選定成果物SHA-256は`ef0bdfb76e9599cdf82afd9177c2192d19acd708b197b25192de11f82ce7619e`である。
- `ShiftJIS`表記を正規形`Shift_JIS`へ統一し、未知・曖昧なcharsetはfail-closedにした。

## 台詞候補・読み補正・レビュー

- 原典から台詞候補26件を抽出し、候補ID、順序、原典SHA-256、token範囲を固定した。
- 全26件を前後文脈と照合し、すべて`approved`、`SPOKEN_DIALOGUE`、権利判断`allowed`とした。候補とレビューのID集合は完全一致し、重複・欠落は0件である。
- 表示本文`displayText`は原典のまま保持し、音声用`speechText`だけを補正した。
- 読み補正artifactは18候補・22履歴で、SHA-256は`2d519f33979512c58627a7ced4c38867be0acc5c8d758c09d05423b35611c507`である。
- base candidate ID、順序、原典SHA-256、token範囲、before/after連鎖を実行時に再検証し、孤立・重複・旧ID・余剰fieldを拒否する。
- VOICEVOXの26件`audio_query`を実行し、「いい名」「はちすずめ」「お日さん」「金」等の明確な誤読を追加補正した。補正後の再照合では新たな明確な誤読は0件だった。
- 読み補正を含む正規化・レビュー工程を新しい入力hashで再実行し、source tree SHA-256を`8f5821fa0b2aa87c1e55a59fdd41ecdafb7cf85e4f04298dcba62d365caa8ef3`へ固定した。

## VOICEVOX音声生成

- engine: VOICEVOX ENGINE `0.25.2`
- 接続: `127.0.0.1:50021`のloopback限定
- 話者: ずんだもん / UUID `388f246b-8c41-4ac1-8e2d-5d79f3ff56d9` / style 3 `ノーマル`
- 設定: speed 1、pitch 0、intonation 1、volume 1、24,000 Hz、cache schema 2
- 正規化設定hash: `0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691`
- クレジット: `VOICEVOX:ずんだもん`

容量認可とmanifest hashを結合してから26件を実生成した。generation digestは`acb24cbef175b51165563299727183cfb2e52f450a9fbe6cc70dda2225d6bd08`、completeness digestは`fc7cef0824d37a3d62a8db5b8407a389ec279532247cb6fab5900a1c56ee2692`である。

受け入れ正本`content/batches/F002/accepted-audio/000473/`には26 WAV、合計13,290,104 bytes、276,857 msをatomic昇格した。全件についてRIFF/WAVE header、SHA-256、byte数、duration、audio ID、設定hashをmanifestおよび生成証跡と独立照合し、不一致は0件だった。作品状態は`accepted`、受入時刻は`2026-07-25T12:04:20.648Z`、残り2作品は`pending`のままとした。

## 容量・不変性

事前予測は26件すべてcache miss、推定14,274,424 bytes、plan digest `22e3ab470f498947e0ce337ba4c3354d19eb99d4d388d807c5b34632e78ec9b6`でPASSした。

| 区分 | 実測 | 上限・下限 | 判定 |
|---|---:|---:|---|
| 追加音声 | 13,290,104 bytes | 100 MiB以下 | PASS |
| Pages artifact | 46,891,430 bytes | 750 MiB以下 | PASS |
| 単一Git object | 17,155,886 bytes | 100 MiB以下 | PASS |
| source repository | 456,199,278 bytes | 1,000,000,000 bytes以下 | PASS |
| 作業ドライブ空き | 45,949,157,376 bytes | 603,979,776 bytes以上 | PASS |

- 統合previewは91 files、content build SHA-256は`b08e17f98fbb9af9d31cb93f9f7743858773029fc8cfb5c682001601c2aca452`。
- F001のcontent / dist固定baselineはともにPASSした。
- `public/`への差分は0件で、未受け入れのF002成果物を公開正本へ混入させていない。
- tree digestの列挙順をflat POSIX path順へ統一し、directory prefix衝突fixtureを追加した。

## 実装時に補強した境界

- production CLIに、規約観測・画像由来・青空文庫書誌から権利選定へ進む実工程を追加した。
- 読み補正artifactを候補正規化前に厳密適用し、入力hash・ID・順序・原典範囲・履歴連鎖を固定した。
- 容量認可をpre-budget manifestへ結合し、budget evidenceを介してvoice段階へ引き継ぐhash chainを実装した。
- 容量実測をvoiced evidenceとcurrent manifestの両方へ結合し、受け入れ時の証拠差し替えを拒否した。
- F001 baselineのtree digest順序差と、`capacity-actual`を正当な終端状態として扱えない受け入れ不整合を修正した。
- 欠落・未結合actual、孤立・改変読み補正、未知charset、prefix衝突をnegative fixtureで回帰固定した。

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- 対象試験: 6 files / 101 tests PASS
- `npm test`: 36 files / 647 tests PASS
- `npm run verify:build`: PASS（66 files / 30,423,361 bytes）
- `npm run build`: PASS（66 files / 30,423,361 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- 独立受け入れでは、権利選定、22件の補正履歴、26件の`audio_query`とWAV、manifest証跡連鎖、容量5区分、F001不変、`public/`不変を実物から再計算し、残るHigh/Medium不適合なしでPASSとした。
