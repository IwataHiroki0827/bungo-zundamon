---
feature: F006
title: 中島敦3作品追加ドメイン調査
tier: 大
status: Draft
researched_at: 2026-08-21
---

# ドメイン調査 F006（中島敦3作品）

## 1. Tier判定

調査Tierは**大**とする。外部公開サイトへ文学作品本文を変換した合成音声と新作者画像を追加するため、著作権、青空文庫の利用条件、VOICEVOX・ずんだもん規約、文学表現の編集判断、GitHub Pages容量が関係する。F001〜F005の公開済みpipelineを再利用し、青空文庫の公式作者一覧・図書カード・XHTML、文化庁の保護期間資料を一次情報として確認した。

## 2. 作者選定

DOMAIN-F005.mdに記載の固定式（2022年公式XHTML上位500行のうち拡充CSVで役割が`著者`の公開作品を人物IDへ結合し、人物IDごとにXHTML閲覧数を合計、score降順・同点は人物ID数値昇順）を2026-08-21に再取得データで再実行した。

- 入力: 青空文庫 2022年XHTML版アクセスランキング（`2022_xhtml.html`、上位500行、2026-08-21取得、`text/html;charset=utf-8`）と、拡充CSV（`list_person_all_extended_utf8.zip`／`.csv`、2026-08-21取得）。
- 結合: 上位500行のうち499行が拡充CSVで役割`著者`に一致（1行は翻訳者役割のため除外、`人物ID235`「作品ID2259」）。
- 集計・digest: 500行×（順位・人物ID・作品ID・閲覧数・役割）のタブ区切り行をUTF-8で連結したSHA-256は`580164841c4ade8bc41862bc1ef295e92fba5b20f4b3907e04c95e972176b423`。
- 結果: score上位は宮沢賢治(081)・太宰治(035)・夏目漱石(148)・芥川竜之介(879)の既存4作者が占め、これらを除いた最上位は**中島敦（人物ID`000119`、score 301,573）**である。続く順位は森鴎外(129, 262,489)・江戸川乱歩(1779, 226,526)・夢野久作(96, 210,182)・梶井基次郎(74, 208,558)・新美南吉(121, 201,724)であり、DOMAIN-F005.md記載の「中島敦、森鴎外、江戸川乱歩、夢野久作、梶井基次郎、新美南吉」の順序と完全一致した。2026-07-29調査から約3週間経過後も、同一年度・同一母集団・同一式で結果は変化していない。

中島敦（1909年5月5日生、1942年12月4日没）を採用する。

- 青空文庫 公式作者ページ（`person119.html`）と拡充CSVはいずれも人物著作権フラグ`なし`、生年月日1909-05-05、没年月日1942-12-04として一致公開している。文化庁が示す個人著作物の原則的な保護期間（著作者の死後70年）を没後84年経過した現在すでに大幅に超過しており、保護期間は経過している。
- 青空文庫の作者ページ「公開中の作品」欄（35作品）に採用候補3作品（山月記624・名人伝621・弟子1738）がすべて掲載されており、「作業中の作品」欄には含まれない。
- 2022年XHTML版アクセスランキングでの代表作品順位は「山月記」4位（214,078閲覧）、「名人伝」88位（19,581閲覧）、「文字禍」130位（14,762閲覧）、「李陵」174位（11,393閲覧）、「弟子」215位（9,664閲覧）であり、知名度は既存4作者に次いで高い。

「他に有名な作家を知名度順に10人まで続ける」は、DOMAIN-F005.mdの解釈（公開済み3作者を含め合計10作者、追加作者は最大7人）を継続する。F005で追加1人目（夏目漱石）が完了し公開済みv0.5.0で4作者となったため、F006は追加2人目、完了時5作者、残り5人、最終上限10作者である。`targetAdditionalAuthors=7`、baseline 3作者、追加済み数（F005完了時点で1）、残数、author identityの重複0を各バッチで機械検証する運用をF006にも継続する。

## 3. 作品選定

F006は次の新字新仮名3作品を候補とする。

| 処理順 | 作品 | 作品ID | XHTML内`「」`概算 | 発話文字概算 | 判断 |
|---:|---|---:|---:|---:|---|
| 1 | 山月記 | `000624` | 3 | 43 | 2022年アクセス4位・国語教科書にも採られる代表作。台詞は少ないが必須の看板作品 |
| 2 | 名人伝 | `000621` | 4 | 127 | アクセス88位で「山月記」に次ぐ知名度。短編で容量負荷が小さい |
| 3 | 弟子 | `001738` | 57 | 2,242 | アクセス215位。子路と孔子の対話が中心で会話文密度が高く、3作品全体の台詞量を確保する |

概算は2026-08-21取得の公式XHTML（`https://www.aozora.gr.jp/cards/000119/files/`配下）をShift_JISで復号し、`<div class="main_text">`から`<div class="bibliographical_information">`直前までを本文範囲として、単純な最外側`「...」`で計測した値である。3作品ともXHTML内に未定義entity・`gaiji_list`の`&nbsp;`問題は検出されなかった（下記4節・5節参照）。合計`「」`64件、発話文字概算2,412文字。

F004実測の音声65,195,572 bytes / speech 7,900文字（8,252.60 bytes/文字）を基準に20%余裕を加えた安全側予測は次のとおり。

| 作品 | 発話文字概算 | raw概算(bytes) | 20%余裕後(bytes) |
|---|---:|---:|---:|
| 山月記 | 43 | 354,862 | 425,834 |
| 名人伝 | 127 | 1,048,081 | 1,257,697 |
| 弟子 | 2,242 | 18,502,338 | 22,202,806 |
| 合計 | 2,412 | 19,905,281 | 23,886,337（22.78 MiB） |

いずれも受入値へ流用せず、原典byte列、charset、本文selector、SHA-256を固定した後に既存抽出器で再確定する。

## 4. 見送り候補と容量

| 候補 | `「」`概算 | 発話文字概算 | 20%余裕後(bytes) | 判断 |
|---|---:|---:|---:|---|
| 文字禍 `000622` | 3 | 153 | 1,515,178 | アクセス130位で知名度は高いが、台詞がほぼなく採用3作品との重複性が高いため見送り |
| 悟浄歎異 `000617` | 30 | 1,407 | 13,933,697 | 会話量はあるが、後述の`gaiji_list`未定義entity（`&nbsp;`2件）への追加対応が必要なため次回以降へ分離 |
| 李陵 `001737` | 28 | 329 | 3,258,128 | 大作（原文17万byte）だが台詞が非常に少なく、`gaiji_list`未定義entity（`&nbsp;`4件）もあり見送り |
| 光と風と夢 `001743` | 236 | 6,919 | 68,519,721 | 会話量は最大だが単作で65.35 MiBの安全側予測となり、F006の容量目標に対して大きすぎるため次回以降へ分離 |
| 悟浄出世 `002521` | 76 | 8,011 | 79,333,933 | 会話量・容量ともに最大級。`gaiji_list`未定義entity（`&nbsp;`10件）もあり、単独バッチでの扱いが必要 |

2026-08-21計測時点のdist実測サイズは284,181,963 bytes（既存build、公開済みv0.5.0相当）である。採用3作品の安全側追加予測23,886,337 bytesを加えた公開予測は308,068,300 bytes（293.80 MiB）であり、GitHub Pages公式hard limit 1 GiB（1,073,741,824 bytes）に対し765,673,524 bytes（730.20 MiB）の余裕がある。2026-08-21計測のC:空き60,220,198,912 bytes（56.08 GiB）は、既存の生成前forecast停止基準（最大同時書込み後にも5 GiB以上残る場合だけ生成）を十分満たす。

生成前forecastでは、F005と同様に追加audio、公開dist、source repository、単一object、同時に存在するcache/preview/dist/rollback用旧publicを含むworkspace peak、`freeAfterPeak`の6区分をbyte単位で算出する。追加WAV 100 MiB以下、Pages 500/750 MiB、repository 750 MB/1 GB、単一object 100 MiBを維持し、GitHub Pages公式hard limit 1 GiBより十分手前で停止する。forecast artifactはcandidate定義hashへ結合し、review完了後にactualへ置換する。

## 5. 権利・編集・公開

- 公式作者ページ、図書カード、拡充CSVで人物・作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を選定時と公開直前に独立snapshotで確認する。取得日時、source URL、raw byte SHA-256をrelease commit/runへ結合する。
- VOICEVOXソフトウェア利用規約、VOICEVOXキャラクター利用規約、ずんだもん利用ガイドラインを公開直前に再取得し、必要な`VOICEVOX:ずんだもん`表記とsnapshot hashを照合する（2026-08-21時点で3規約URLはいずれもHTTP 200で到達可能、条文変更の有無は公開直前に再確認する）。
- 図書カードの「入力」「校正」欄は3作品とも記載あり（山月記: 入力=平松大樹／校正=林めぐみ、名人伝: 入力=大内章／校正=j.utiyama、弟子: 入力=大内章／校正=川向直樹）。F005で扱った校正者欄なしのケース（`proofreader: null`）はF006の3作品には該当しない。
- 3作品のXHTML（`624_14544.html`／`621_14498.html`／`1738_16623.html`）はいずれも`application/xhtml+xml`として問題になる未定義entityを含まない。ただし同一作者の他作品（李陵・悟浄歎異・悟浄出世）には`gaiji_list`セクション内`<td>&nbsp;&nbsp;</td>`相当の未定義entityがあり、F005の「趣味の遺伝」と同種の問題が別作品で再現する。F006採用3作品では対応不要だが、次回バッチでこれらを採用する場合はF005確立済みのversion付きexact allowlist正規化手順を再利用する。
- 3作品ともXHTML内に表現上の注意書き（F005「趣味の遺伝」相当の公式注記）は図書カード「作品について」欄に確認できなかった。公開直前に図書カード全文を再確認し、注記が新設されていないか照合する。
- 本文領域内の最外側全角`「...」`だけを候補とし、全候補を独立二重判定する。不一致は第三裁定まで`pending`として音声生成を止める（F005と同一運用）。
- 原文表示と読み上げ文を分離し、旧語・固有名・外来語の補正をrevision/hash chainで保持する。
- 新作者画像は独自生成し、generator/version・利用規約snapshot・prompt・negative prompt・未承認参照入力0・加工入力一覧・生成原本SHA・最終SHA・creditをsealed artifactへ記録する。既存作者画像とのbyte完全重複に加え、dHash64-v1（EXIF orientation適用、白背景へalpha合成、BT.601 grayscale、9×8 bilinear resize、左画素>右画素を1とする64 bit）のHamming距離8以下を近似として拒否する。第三者二次創作は入力に使わず、全入力の由来を保持する。
- 公開済みv0.5.0を固定baselineとして、4作者・15作品・877台詞・861音声とお気に入り機能をexact維持する。
- 全routeの作品は初期全閉を維持し、手動・目視・聴取を必須証跡にしない。
- 公開route集合は既存route（`#/`、4作者、`#/favorites`、`#/credits`）に、中島敦の作者route（設計phase確定時にproject既存slug命名規則「姓ローマ字-ずんだもんキャラクター名/名ローマ字」に沿って命名する。候補: `#/authors/nakajima-atsushi`）を1件加えたexact集合とし、順序に依存せず重複・欠落・未知routeを拒否する。具体的なslug文字列は設計フェーズ（pf-design）で確定する。

## 6. 一次情報

- 青空文庫 中島敦: https://www.aozora.gr.jp/index_pages/person119.html
- 山月記: https://www.aozora.gr.jp/cards/000119/card624.html
- 名人伝: https://www.aozora.gr.jp/cards/000119/card621.html
- 弟子: https://www.aozora.gr.jp/cards/000119/card1738.html
- 文字禍（比較候補）: https://www.aozora.gr.jp/cards/000119/card622.html
- 李陵（比較候補）: https://www.aozora.gr.jp/cards/000119/card1737.html
- 悟浄歎異（比較候補）: https://www.aozora.gr.jp/cards/000119/card617.html
- 光と風と夢（比較候補）: https://www.aozora.gr.jp/cards/000119/card1743.html
- 悟浄出世（比較候補）: https://www.aozora.gr.jp/cards/000119/card2521.html
- 青空文庫 公式拡充CSV: https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip
- 青空文庫 XHTML版アクセスランキング（2022年）: https://www.aozora.gr.jp/access_ranking/2022_xhtml.html
- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- 文化庁 著作物等の保護期間の延長に関するQ&A: https://www.bunka.go.jp/seisaku/chosakuken/hokaisei/kantaiheiyo_chosakuken/1411890.html
- 青空文庫収録ファイルの取り扱い規準: https://www.aozora.gr.jp/guide/kijyunn.html
- 青空文庫収録ファイルの朗読配信について: https://www.aozora.gr.jp/guide/roudoku.html
- VOICEVOXソフトウェア利用規約: https://voicevox.hiroshiba.jp/term/
- ずんだもん音源利用規約: https://www.zunko.jp/con_ongen_kiyaku.html
- 東北ずん子・ずんだもん等キャラクター利用ガイドライン: https://zunko.jp/guideline.html

公開直前の規約判定では、無料・広告なし・課金なし・スポンサーなし・非公式サイトという用途分類と必須creditを各snapshotへ適用する。全条件が許可される場合だけ`decision: allow`とし、差分、取得失敗、条件未判定、禁止条件該当はfail-closedで公開を止める。
