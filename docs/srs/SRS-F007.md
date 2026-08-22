---
feature: F007
title: 森鴎外3作品追加
status: Approved
version: 1.0.0
updated: 2026-08-22
---

# 要求仕様書 F007（森鴎外3作品追加）

## 1. 目的

公開済みv0.6.0を不変に保ち、6人目の作者として森鴎外の3作品と対応音声を追加する。公開容量を段階管理しながら、既存の継続バッチ、お気に入り、初期全閉、セキュリティを同じ自動証跡契約で維持する。

## 2. 対象範囲

- 森鴎外（人物ID`000129`、表示名は設計phaseで確定）
- `舞姫`（`058126`、新字新仮名）
- `高瀬舟`（`045245`、新字新仮名）
- `山椒大夫`（`000689`、新字新仮名）
- 新作者route、独自生成作者画像、台詞、同一origin WAV、書誌・権利・画像provenance
- 舞姫の公式表現注意（DOMAIN-F007.md §5）への、F005確立済み作品固有注記UI（FUN-F005-014）の再適用

F007では「阿部一族」「雁」「ヰタ・セクスアリス」等の見送り候補、作品全文朗読、音声圧縮方式変更、アカウント、外部同期、利用者追跡を行わない。

## 3. 要求一覧

| ID | 要求 | 優先度 | 受入基準 |
|---|---|---:|---|
| REQ-F007-001 | v0.6.0を固定baselineとして維持する | 高 | 公開済みrelease commitの5作者・18作品・939台詞・923音声、content/media、初期全閉、お気に入り挙動がexact一致する |
| REQ-F007-002 | F007を重複なし1作者・3作品バッチで管理する | 高 | 承認候補から3作品`pending`、4ゲート参照付きmanifestを生成する。各状態遷移は承認済み制御commitへ結合した証跡を再読込し、CAS・journalで順序どおりに行い、自動公開しない |
| REQ-F007-003 | 森鴎外を6人目の作者として追加する | 高 | authorId`000129`、原著者名`森鴎外`、表示名候補`もりおうがい`、slug候補`mori-ogai`（QA-F007.mdでオーナー確定）、identity hashが一意で、トップと固有routeから利用できる |
| REQ-F007-004 | 対象3作品を森鴎外だけへ所属させる | 高 | 舞姫`058126`→高瀬舟`045245`→山椒大夫`000689`の順序・所属が正しく、既存作者への混線と重複作品が0件である |
| REQ-F007-005 | 権利・利用規約の適格性を二重確認する | 高 | 選定時と公開直前の独立snapshotで人物・作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を確認する。公式originだけをSSRF耐性付きtransportで取得し、VOICEVOX・ずんだもん最新規約へ無料・広告なし・課金なし・スポンサーなし・非公式の用途と必須creditを適用する。全条件が許可された`decision: allow`だけを取得日時・URL・raw SHA・接続証跡付きでrelease commit/runへ結合し、差分・未判定・transport異常はfail-closedとする |
| REQ-F007-006 | 原典と書誌を再現可能に固定する | 高 | card/XHTMLごとにURL、取得時刻、raw byte列またはcanonical保存path、charset、本文selector、raw SHA-256、底本、入力者、校正者、更新日を同一snapshotへ保持する。対象3作品はいずれも公式card入力・校正欄が記載ありのためF005で導入した`proofreader: null`の適用対象はなく、通常の校正者名をcanonical値とする |
| REQ-F007-007 | 原典を安全かつ決定的に正規化して最外側全角かぎ括弧候補を抽出する | 高 | 対象3作品のXHTML（`058126_73682.html`／`045245_22007.html`／`000689_23257.html`）はraw取得時点でF005確立済みの未定義entity検出手順により未定義entity・`gaiji_list`問題が0件であることを選定時と公開直前の独立snapshotで確認し、raw byte列とSHA-256を不変保持する。allowlist正規化（F005 REQ-F005-007相当）は対象外のため適用しないが、公開直前検査で未定義entityが1件でも検出された場合はfail-closedで当該作品を`pending`に留め、F005確立済みのversion付きexact allowlist正規化手順を再利用するまで候補から除外する。固定原典のexact XHTML 1.1外部DOCTYPE宣言だけはnetwork/filesystem resolverなしで許し、internal subset、他DOCTYPE、ENTITY、XInclude、外部schema/stylesheetをアクセス前に拒否する。深さ・node・属性・text上限内だけを解析し、candidate ID・順序・表示文を決定的にする |
| REQ-F007-008 | 全候補を独立二重判定する | 高 | primary/secondaryを別principal・session・runとして、candidate set・prompt/template・policy・期限・audienceへ結合した一回限りのauthorizationで判定する。互いの結果を見せずsemantic fieldsと入力hashを全件保持し、不一致digestが確定するまで第三裁定tokenを発行せず、最終`pending: 0`とする |
| REQ-F007-009 | 原文表示と読み上げを分離する | 高 | 原文を保持し、旧語・固有名・外来語の読み補正をrevision/hash chainで再現する。舞姫のドイツ由来外来語・人名（エリス、豊太郎等）と高瀬舟・山椒大夫の旧語をVOICEVOX実測に基づき補正する |
| REQ-F007-010 | 収録範囲と作品固有注意を明示する | 高 | 括弧発話の抜粋・原作由来を3配置で示す。選定時点（DOMAIN-F007.md §5）で舞姫の図書カードに公式表現注意（不適切と受け取られる可能性のある表現に関する注記）を確認したため、舞姫にはF005「趣味の遺伝」で確立済みの作品固有注記UI（FUN-F005-014）をそのまま再適用する。高瀬舟・山椒大夫には該当注記がないため実装しない。公開直前に3作品の図書カード「作品について」欄を再確認し、注記の削除・新設・文言変更がないか照合する。差分が検出された場合はfail-closedで当該作品を`pending`に留める |
| REQ-F007-011 | 承認済み台詞だけを差分音声化する | 高 | 固定VOICEVOX tupleで未承認生成、失敗、欠損、孤立が0件となり、同一読み音声を決定的に再利用する |
| REQ-F007-012 | 単一候補と段階容量を生成前に検査する | 高 | 正規化後500 Unicode code point以下、120,000 ms以下、24 kHz・mono・16 bit PCMの予測`44 + ceil(durationMs × 48)`かつ5,760,044 bytes以下、追加WAV 104,857,600 bytes以下、Pages 500/750 MiB、repo 750 MB/1 GB、object 100 MiBを満たす。各停止上限は同値を許可し+1 byteで停止する。audio/public/repo/object/workspace peak/freeAfterPeakのforecastと、phase journal由来のactual peak・minimum freeをcandidate hashへ結合し、最大同時書込み後も5 GiB以上残す。書込み健全性の証明はF005確立済みの事後検証方式（`beginPhase`でのbaseline記録と`endPhase`での実測差分照合、CHG-F005-072）を継続利用する。宣言外のpathの新規出現・変更・消失は0件とする |
| REQ-F007-013 | 作品単位で論理atomic受入する | 高 | 舞姫→高瀬舟→山椒大夫の順に、`pending → extracted → reviewed → budget-approved → voiced → accepted`を証跡再計算とCASで遷移する。audio・artifact・manifestの複数pathはjournalへ旧/新SHA、phase、owner、参照を記録した論理transactionとして扱い、失敗時は旧publicを保持して実体から導いた回復へ収束する |
| REQ-F007-014 | Catalog・routeをデータ駆動で拡張する | 高 | application sourceへ作者・作品固有分岐を追加せず（舞姫の注記UIはF005確立済みの作品固有注記機構をデータ駆動で再利用し、新規application source分岐を追加しない）、6作者・21作品を参照整合付きで構築し、公開routeを`#/`・既存5作者（`nakajima-atsushi`を含む）・森鴎外作者route（`#/authors/mori-ogai`）・`#/favorites`・`#/credits`のexact 9件とする |
| REQ-F007-015 | 初期全閉・音声・お気に入り契約を維持する | 高 | 全dialogueとの1対1 control、`aria-pressed`、自動再生0を維持する。保存IDはplain JSONのexact schema・件数・長さ・文字種を検証し、Catalog join後だけURL/selector/DOM/pathに使う。prototype/getter、CSS/path注入、重複・未知ID、破損・未知version・上限・quota失敗は除去またはmemory縮退する。既存/F007 ID保持、one-shot元作品移動と通常入口の初期open 0、同時再生1、route切替停止、個別404隔離を満たす |
| REQ-F007-016 | 独自作者画像と権利表示を保持する | 高 | F006確立済みのF00N用汎用artwork provenance schemaへgenerator/version・規約snapshot・prompt・negative prompt・参照入力exact空配列・全入力由来・生成原本/最終SHA・credit・author identityをsealed化する。PNG decodeは形式・encoded/decoded bytes・幅・高さ・pixel・frame上限を固定し、既存画像とのbyte一致またはdHash64-v1（EXIF/alpha/BT.601・9×8 bilinear、bit順・hex表現固定）のHamming距離8以下を拒否し、3作品書誌とjoinする |
| REQ-F007-017 | セキュリティと自動リリース品質を維持する | 高 | phase差分対象の全pathをreparse point非該当・hardlink数1・`resolveSafeWorkspaceFile`解決結果とidentity一致で再検査する。Windows path/reparse/hardlink境界、strict CSP、危険DOM、外部request、Cookie/form、専用favorite key以外のstorage、secret 0、Critical/High 0を確認する。既存Playwright環境のF007必須caseはskip 0とし、exact commit/artifact/dist/catalog digest、画像200、local/hosted WAV Range 206、公開9 routeを検査する。公開準備はゲート①〜③、`published`記録はゲート④とworkflow/API/smoke/read-back証跡の再読込を必須とし、旧artifact availabilityを事前確認する。全経路でdeploy変数read-back falseまでdurable watchdogが回復し、失敗時はv0.6.0のexact 8 routeへrollbackする |
| REQ-F007-018 | 合計10作者(追加7人)の継続上限と順位を再現可能に管理する | 中 | baseline 3作者を含め`targetAdditionalAuthors=7`、F007は追加3人目、残4人、最終上限10作者と記録する。DOMAIN-F006.mdで確定済みの選定式・入力・結果digest（2026-08-21取得SHA-256`580164841c4ade8bc41862bc1ef295e92fba5b20f4b3907e04c95e972176b423`）をF007公開直前に再取得・再確認し、author identity重複を0とする |

### 3.1 書込み健全性の証明方式（F005 CHG-F005-072継承）

REQ-F007-012・REQ-F007-017が求める「不正な書込みがないこと」の証明は、F005で確立した事後検証方式（`beginPhase`でのworkspace baseline記録と`endPhase`での実測差分照合）をそのまま継続利用する。F007では新規の書込み健全性方式の設計変更を行わない。

## 4. 運用制約

- 手動・実機・目視・聴取・手動スクリーンリーダーを必須PASS証跡に含めない。
- 概算187候補・106,557,571 bytes、20%余裕後127,869,085 bytes、予測公開432,575,202 bytes（既存dist実測304,706,117 bytes＋追加安全側予測）はいずれも選定値であり、正式値は原典固定・全件review後の実測を正とする。
- ローカル開発機のディスク空き容量が2026-08-22時点で29 GiB（全体3%）まで逼迫している（DOMAIN-F007.md §4）。実装フェーズ着手前に`.cache/`(6.3 GiB、再取得可能)等の整理を推奨する。生成前forecastは実行時点の実測空き容量で改めて判定し、5 GiB未満に接近する場合はfail-closedで停止する。
- ProjectFactoryの承認ゲートは、本会話の包括承認を対象文書・commitへ明示的に結合して記録する。

## 5. 根拠

- `REQUEST.md` §13
- `docs/domain/DOMAIN-F007.md`
- `docs/qa/QA-F007.md`
- `docs/srs/SRS-F006.md`
- F006 v0.6.0 release evidence
