---
feature: F006
title: 中島敦3作品追加
status: Draft
version: 1.0.0
updated: 2026-08-21
---

# 要求仕様書 F006（中島敦3作品追加）

## 1. 目的

公開済みv0.5.0を不変に保ち、5人目の作者として中島敦の3作品と対応音声を追加する。公開容量を段階管理しながら、既存の継続バッチ、お気に入り、初期全閉、セキュリティを同じ自動証跡契約で維持する。

## 2. 対象範囲

- 中島敦（人物ID`000119`、表示名は設計phaseで確定）
- `山月記`（`000624`）
- `名人伝`（`000621`）
- `弟子`（`001738`）
- 新作者route、独自生成作者画像、台詞、同一origin WAV、書誌・権利・画像provenance

F006では「文字禍」「李陵」「悟浄歎異」「光と風と夢」「悟浄出世」等の見送り候補、`gaiji_list`未定義entity対応、作品全文朗読、音声圧縮方式変更、アカウント、外部同期、利用者追跡を行わない。

## 3. 要求一覧

| ID | 要求 | 優先度 | 受入基準 |
|---|---|---:|---|
| REQ-F006-001 | v0.5.0を固定baselineとして維持する | 高 | 公開済みrelease commitの4作者・15作品・877台詞・861音声、content/media、初期全閉、お気に入り挙動がexact一致する |
| REQ-F006-002 | F006を重複なし1作者・3作品バッチで管理する | 高 | 承認候補から3作品`pending`、4ゲート参照付きmanifestを生成する。各状態遷移は承認済み制御commitへ結合した証跡を再読込し、CAS・journalで順序どおりに行い、自動公開しない |
| REQ-F006-003 | 中島敦を5人目の作者として追加する | 高 | authorId`000119`、原著者名`中島敦`、表示名・slug（設計phase確定、候補`nakajima-atsushi`）、identity hashが一意で、トップと固有routeから利用できる |
| REQ-F006-004 | 対象3作品を中島敦だけへ所属させる | 高 | 山月記`000624`→名人伝`000621`→弟子`001738`の順序・所属が正しく、既存作者への混線と重複作品が0件である |
| REQ-F006-005 | 権利・利用規約の適格性を二重確認する | 高 | 選定時と公開直前の独立snapshotで人物・作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を確認する。公式originだけをSSRF耐性付きtransportで取得し、VOICEVOX・ずんだもん最新規約へ無料・広告なし・課金なし・スポンサーなし・非公式の用途と必須creditを適用する。全条件が許可された`decision: allow`だけを取得日時・URL・raw SHA・接続証跡付きでrelease commit/runへ結合し、差分・未判定・transport異常はfail-closedとする |
| REQ-F006-006 | 原典と書誌を再現可能に固定する | 高 | card/XHTMLごとにURL、取得時刻、raw byte列またはcanonical保存path、charset、本文selector、raw SHA-256、底本、入力者、校正者、更新日を同一snapshotへ保持する。対象3作品はいずれも公式card入力・校正欄が記載ありのためF005で導入した`proofreader: null`の適用対象はなく、通常の校正者名をcanonical値とする |
| REQ-F006-007 | 原典を安全かつ決定的に正規化して最外側全角かぎ括弧候補を抽出する | 高 | 対象3作品のXHTML（`624_14544.html`／`621_14498.html`／`1738_16623.html`）はraw取得時点でF005確立済みの未定義entity検出手順により未定義entity・`gaiji_list`問題が0件であることを選定時と公開直前の独立snapshotで確認し、raw byte列とSHA-256を不変保持する。allowlist正規化（F005 REQ-F005-007相当）は対象外のため適用しないが、公開直前検査で未定義entityが1件でも検出された場合はfail-closedで当該作品を`pending`に留め、F005確立済みのversion付きexact allowlist正規化手順を再利用するまで候補から除外する。固定原典のexact XHTML 1.1外部DOCTYPE宣言だけはnetwork/filesystem resolverなしで許し、internal subset、他DOCTYPE、ENTITY、XInclude、外部schema/stylesheetをアクセス前に拒否する。深さ・node・属性・text上限内だけを解析し、candidate ID・順序・表示文を決定的にする |
| REQ-F006-008 | 全候補を独立二重判定する | 高 | primary/secondaryを別principal・session・runとして、candidate set・prompt/template・policy・期限・audienceへ結合した一回限りのauthorizationで判定する。互いの結果を見せずsemantic fieldsと入力hashを全件保持し、不一致digestが確定するまで第三裁定tokenを発行せず、最終`pending: 0`とする |
| REQ-F006-009 | 原文表示と読み上げを分離する | 高 | 原文を保持し、旧語・固有名・外来語の読み補正をrevision/hash chainで再現する |
| REQ-F006-010 | 収録範囲と作品固有注意を明示する | 高 | 括弧発話の抜粋・原作由来を3配置で示す。公開直前に3作品の図書カード「作品について」欄を再確認し、F005「趣味の遺伝」相当の公式注記が新設されていないか照合する。選定時点（DOMAIN-F006.md §5）ではいずれの図書カードにも表現上の注意書きは確認されておらず、REQ-F005-010相当の作品固有注記表示は対象外と暫定判断する。この判断は`docs/qa/QA-F006.md`で確認する |
| REQ-F006-011 | 承認済み台詞だけを差分音声化する | 高 | 固定VOICEVOX tupleで未承認生成、失敗、欠損、孤立が0件となり、同一読み音声を決定的に再利用する |
| REQ-F006-012 | 単一候補と段階容量を生成前に検査する | 高 | 正規化後500 Unicode code point以下、120,000 ms以下、24 kHz・mono・16 bit PCMの予測`44 + ceil(durationMs × 48)`かつ5,760,044 bytes以下、追加WAV 104,857,600 bytes以下、Pages 500/750 MiB、repo 750 MB/1 GB、object 100 MiBを満たす。各停止上限は同値を許可し+1 byteで停止する。audio/public/repo/object/workspace peak/freeAfterPeakのforecastと、phase journal由来のactual peak・minimum freeをcandidate hashへ結合し、最大同時書込み後も5 GiB以上残す。書込み健全性の証明はF005確立済みの事後検証方式（`beginPhase`でのbaseline記録と`endPhase`での実測差分照合、CHG-F005-072）を継続利用する。宣言外のpathの新規出現・変更・消失は0件とする |
| REQ-F006-013 | 作品単位で論理atomic受入する | 高 | 山月記→名人伝→弟子の順に、`pending → extracted → reviewed → budget-approved → voiced → accepted`を証跡再計算とCASで遷移する。audio・artifact・manifestの複数pathはjournalへ旧/新SHA、phase、owner、参照を記録した論理transactionとして扱い、失敗時は旧publicを保持して実体から導いた回復へ収束する |
| REQ-F006-014 | Catalog・routeをデータ駆動で拡張する | 高 | application sourceへ作者・作品固有分岐を追加せず、5作者・18作品を参照整合付きで構築し、公開routeを`#/`・既存4作者（`natsume-soseki`を含む）・中島敦作者route（設計phase確定slug）・`#/favorites`・`#/credits`のexact 8件とする |
| REQ-F006-015 | 初期全閉・音声・お気に入り契約を維持する | 高 | 全dialogueとの1対1 control、`aria-pressed`、自動再生0を維持する。保存IDはplain JSONのexact schema・件数・長さ・文字種を検証し、Catalog join後だけURL/selector/DOM/pathに使う。prototype/getter、CSS/path注入、重複・未知ID、破損・未知version・上限・quota失敗は除去またはmemory縮退する。既存/F006 ID保持、one-shot元作品移動と通常入口の初期open 0、同時再生1、route切替停止、個別404隔離を満たす |
| REQ-F006-016 | 独自作者画像と権利表示を保持する | 高 | F006用汎用artwork provenance schemaへgenerator/version・規約snapshot・prompt・negative prompt・参照入力exact空配列・全入力由来・生成原本/最終SHA・credit・author identityをsealed化する。PNG decodeは形式・encoded/decoded bytes・幅・高さ・pixel・frame上限を固定し、既存画像とのbyte一致またはdHash64-v1（EXIF/alpha/BT.601・9×8 bilinear、bit順・hex表現固定）のHamming距離8以下を拒否し、3作品書誌とjoinする |
| REQ-F006-017 | セキュリティと自動リリース品質を維持する | 高 | phase差分対象の全pathをreparse point非該当・hardlink数1・`resolveSafeWorkspaceFile`解決結果とidentity一致で再検査する。Windows path/reparse/hardlink境界、strict CSP、危険DOM、外部request、Cookie/form、専用favorite key以外のstorage、secret 0、Critical/High 0を確認する。Playwright既存Playwright環境のF006必須caseはskip 0とし、exact commit/artifact/dist/catalog digest、画像200、local/hosted WAV Range 206、公開8 routeを検査する。公開準備はゲート①〜③、`published`記録はゲート④とworkflow/API/smoke/read-back証跡の再読込を必須とし、旧artifact availabilityを事前確認する。全経路でdeploy変数read-back falseまでdurable watchdogが回復し、失敗時はv0.5.0のexact 7 routeへrollbackする |
| REQ-F006-018 | 合計10作者(追加7人)の継続上限と順位を再現可能に管理する | 中 | baseline 3作者を含め`targetAdditionalAuthors=7`、F006は追加2人目、残5人、最終上限10作者と記録する。2022年公式XHTML上位500行を拡充CSVの`著者`へ人物ID結合し、人物別閲覧数合計の降順・同点は人物ID数値昇順とする入力・式・結果digest（2026-08-21再取得SHA-256`580164841c4ade8bc41862bc1ef295e92fba5b20f4b3907e04c95e972176b423`）を引き継ぎ、author identity重複を0とする |

### 3.1 書込み健全性の証明方式（F005 CHG-F005-072継承）

REQ-F006-012・REQ-F006-017が求める「不正な書込みがないこと」の証明は、F005で確立した事後検証方式（`beginPhase`でのworkspace baseline記録と`endPhase`での実測差分照合）をそのまま継続利用する。F006では新規の書込み健全性方式の設計変更を行わない。

## 4. 運用制約

- 手動・実機・目視・聴取・手動スクリーンリーダーを必須PASS証跡に含めない。
- 概算64候補・19,905,281 bytes、20%余裕後23,886,337 bytes、予測公開308,068,300 bytes（既存dist実測284,181,963 bytes＋追加安全側予測）はいずれも選定値であり、正式値は原典固定・全件review後の実測を正とする。
- ProjectFactoryの承認ゲートは、本会話の包括承認を対象文書・commitへ明示的に結合して記録する。

## 5. 根拠

- `REQUEST.md` §13
- `docs/domain/DOMAIN-F006.md`
- `docs/qa/QA-F006.md`
- `docs/srs/SRS-F005.md`
- F005 v0.5.0 release evidence
