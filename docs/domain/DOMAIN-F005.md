---
feature: F005
title: 夏目漱石3作品追加ドメイン調査
tier: 大
status: Completed
researched_at: 2026-07-29
---

# ドメイン調査 F005（夏目漱石3作品）

## 1. Tier判定

調査Tierは**大**とする。外部公開サイトへ文学作品本文を変換した合成音声と新作者画像を追加するため、著作権、青空文庫の利用条件、VOICEVOX・ずんだもん規約、文学表現の編集判断、GitHub Pages容量が関係する。F002〜F004の公開済みpipelineを再利用し、青空文庫の公式作者一覧・図書カード・XHTML、文化庁の保護期間資料を一次情報として確認した。

## 2. 作者選定

知名度順の次作者は**夏目漱石**（青空文庫人物ID`000148`）とする。

- 青空文庫で公開中113作品があり、新字新仮名の小説を複数選べる。
- 青空文庫の2022年XHTML版アクセス順位で「こころ」3位、「吾輩は猫である」7位、「夢十夜」8位、「坊っちゃん」15位、「草枕」17位である。
- 1867年生、1916年没で、青空文庫作者ページと図書カードはいずれも著者本人の作品として公開している。
- 文化庁が示す個人著作物の原則的な保護期間は著作者の死後70年であり、夏目漱石はこの期間を十分に経過している。選定時と公開直前に公式書誌・権利状態を再確認する。

「他に有名な作家を知名度順に10人まで続ける」は、公開済み3作者とは別に**追加作者を最大10人**と解釈する。したがってF005は追加1人目、完了時4作者、残り9人、最終上限13作者である。`targetAdditionalAuthors=10`、baseline 3作者、追加済み数、残数、author identityの重複0を各バッチで機械検証する。

知名度scoreは、2022年公式XHTML上位500行のうち拡充CSVで役割が`著者`の公開作品を人物IDへ結合し、人物IDごとにXHTML閲覧数を合計した整数とする。score降順、同点時は人物IDの数値昇順で一意に並べ、その入力行・結合結果・式をdigest化する。この固定式による後続の暫定上位は中島敦、森鴎外、江戸川乱歩、夢野久作、梶井基次郎、新美南吉、谷崎潤一郎、泉鏡花、鴨長明である。各開始時に同じ年度・母集団・式を再生し、公開中作品、権利、台詞密度を再評価する。保護期間中の作者は採用しない。

## 3. 作品選定

F005は次の新字新仮名3作品を候補とする。

| 処理順 | 作品 | 作品ID | XHTML内`「」`概算 | 発話文字概算 | 判断 |
|---:|---|---:|---:|---:|---|
| 1 | 夢十夜 | `000799` | 65 | 1,354 | 知名度が高く、短編連作として導入しやすい |
| 2 | 倫敦塔 | `001076` | 67 | 1,942 | 初期代表短編で、候補量と容量の均衡がよい |
| 3 | 趣味の遺伝 | `001104` | 97 | 4,034 | 代表的な初期短編の一つで、会話量を確保できる。公式の表現注意を3配置へ継承する |

概算は2026-07-29取得の公式XHTML `.main_text`をShift_JISで復号し、単純な最外側`「...」`で計測した安全側選定値である。現行tokenizerは`notation_notes`を除くため、entity正規化後の正式候補見込みは夢十夜65・倫敦塔67・趣味の遺伝96、計228件となる。いずれも受入値へ流用せず、原典byte列、charset、本文selector、SHA-256を固定した後に既存抽出器で再確定する。

## 4. 見送り候補と容量

| 候補 | `「」`概算 | 発話文字概算 | 判断 |
|---|---:|---:|---|
| 坊っちゃん `000752` | 340 | 16,124 | 知名度は高いが、単作だけでF005の100 MiB目標を超える安全側予測となるため次回以降へ分離 |
| 草枕 `000776` | 742 | 21,312 | 候補・音声容量が大きく、公開総容量の急増を避けるため見送り |
| 二百十日 `000751` | 904 | 23,353 | 会話密度が非常に高く、現行バッチ上限に適さない |
| 文鳥 `000753` | 1 | 76 | 現行`「」`抽出では収録台詞がほぼ得られない |
| 琴のそら音 `001073` | 253 | 9,976 | 代替候補。採用3作品より安全側容量が大きい |

F004実測の音声65,195,572 bytes / speech 7,900文字を基準に20%余裕を加えると、raw概算7,330文字による安全側予測は72,589,906 bytes（69.23 MiB）である。v0.4.0 build 229,935,951 bytesへ加えた安全側公開予測は302,525,857 bytesである。2026-07-29再計測のC:空き60,728,377,344 bytes（56.56 GiB）は、既存5 GiB停止基準より十分大きい。

生成前forecastでは、追加audio、公開dist、source repository、単一object、同時に存在するcache/preview/dist/rollback用旧publicを含むworkspace peak、`freeAfterPeak`の6区分をbyte単位で算出する。追加WAV 100 MiB以下、Pages 500/750 MiB、repository 750 MB/1 GB、単一object 100 MiBを維持し、GitHub Pages公式hard limit 1 GiBより十分手前で停止する。最大同時書込み後にも5 GiB以上残る場合だけ生成する。forecast artifactはcandidate定義hashへ結合し、review完了後にactualへ置換する。

## 5. 権利・編集・公開

- 公式作者ページ、図書カード、拡充CSVで人物・作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を選定時と公開直前に独立snapshotで確認する。取得日時、source URL、raw byte SHA-256をrelease commit/runへ結合する。
- VOICEVOXソフトウェア利用規約、VOICEVOXキャラクター利用規約、ずんだもん利用ガイドラインを公開直前に再取得し、必要な`VOICEVOX:ずんだもん`表記とsnapshot hashを照合する。
- card/XHTML URL、原典byte列、charset、本文selector、取得日時、SHA-256、底本、入力者、校正者、更新日を作品別に固定する。
- 「夢十夜」の公式図書カードには校正者欄がない。空文字や推測値で補わず`proofreader: null`をcanonical表現とし、公開表示は「校正者: 記載なし」とする。既存の非空string限定schemaはF005設計でnullableへ変更し、既存作品のserialized projectionを不変に保つ。
- 「趣味の遺伝」公式XHTMLには、本文後方の`div.notation_notes`内の表セル`<td>&nbsp;&nbsp;</td>`にXML未定義entityが連続2件ある。文書全体を`application/xhtml+xml`で解析する現行処理はそのままでは失敗する。raw SHA-256 `91209534d37abf5fc66a4720eb167b0315aefbd5ea8842cccd731d4155e982ef`とbyte列を不変保持し、parse専用入力だけをversion付きexact allowlistでこのcontextの2件を`&#160;`へ写像する。総数1件/3件、非連続、別section、未知named entityは拒否し、正規化規則とprocessed SHAを原典証跡へ結合する。
- 本文領域内の最外側全角`「...」`だけを候補とし、全候補を独立二重判定する。不一致は第三裁定まで`pending`として音声生成を止める。
- 原文表示と読み上げ文を分離し、旧語・固有名・外来語の補正をrevision/hash chainで保持する。
- 新作者画像は独自生成し、generator/version・利用規約snapshot・prompt・negative prompt・未承認参照入力0・加工入力一覧・生成原本SHA・最終SHA・creditをsealed artifactへ記録する。既存作者画像とのbyte完全重複に加え、dHash64-v1（EXIF orientation適用、白背景へalpha合成、BT.601 grayscale、9×8 bilinear resize、左画素>右画素を1とする64 bit）のHamming距離8以下を近似として拒否する。第三者二次創作は入力に使わず、全入力の由来を保持する。
- 「趣味の遺伝」は図書カードの「今日からみれば、不適切と受け取られる可能性のある表現」に関する公式注意を、改変防止hash・出典URL付きで作者画面、作品画面、creditsへ表示する。
- 公開済みv0.4.0を固定baselineとして、3作者・12作品・674台詞・662音声とお気に入り機能をexact維持する。
- 全routeの作品は初期全閉を維持し、手動・目視・聴取を必須証跡にしない。
- 公開route集合は`#/`、既存3作者、`#/authors/natsume-soseki`、`#/favorites`、`#/credits`のexact 7件とし、順序に依存せず重複・欠落・未知routeを拒否する。

## 6. 一次情報

- 青空文庫 夏目漱石: https://www.aozora.gr.jp/index_pages/person148.html
- 夢十夜: https://www.aozora.gr.jp/cards/000148/card799.html
- 倫敦塔: https://www.aozora.gr.jp/cards/000148/card1076.html
- 趣味の遺伝: https://www.aozora.gr.jp/cards/000148/card1104.html
- 坊っちゃん（比較候補）: https://www.aozora.gr.jp/cards/000148/card752.html
- 草枕（比較候補）: https://www.aozora.gr.jp/cards/000148/card776.html
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
