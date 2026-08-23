---
feature: F009
title: 夢野久作3作品追加
status: Approved
version: 1.0.0
updated: 2026-08-23
---

# 要求仕様書 F009（夢野久作3作品追加）

## 1. 目的

公開済みbaseline（F009着手時点でF008公開後であればv0.8.0、未公開であればv0.7.0、pf-setup着手時に確定）を不変に保ち、8人目の作者として夢野久作の3作品と対応音声を追加する。公開容量を段階管理しながら、既存の継続バッチ、お気に入り、初期全閉、セキュリティを同じ自動証跡契約で維持する。

## 2. 対象範囲

- 夢野久作（人物ID`000096`、表示名は設計phaseで確定）
- `瓶詰地獄`（`2381`、新字新仮名）
- `きのこ会議`（`46694`、新字新仮名）
- `死後の恋`（`2380`、新字新仮名）
- 新作者route、独自生成作者画像、台詞、同一origin WAV、書誌・権利・画像provenance
- 瓶詰地獄・死後の恋の公式表現注意（DOMAIN-F009.md §5）への、F005確立済み作品固有注記UI（FUN-F005-014）の再適用（F008と同様、2作品同時適用）
- 死後の恋の長大候補（実測1,748文字）に対するローカル抽出層での句点分割（DOMAIN-F009.md §3.1、F007/F008で確立した600文字閾値手法の再利用）

F009では「ドグラ・マグラ」「少女地獄」「猟奇歌」等の見送り候補、作品全文朗読、音声圧縮方式変更、アカウント、外部同期、利用者追跡を行わない。

## 3. 要求一覧

| ID | 要求 | 優先度 | 受入基準 |
|---|---|---:|---|
| REQ-F009-001 | 公開済みbaseline（F008完了状況に応じてv0.7.0またはv0.8.0）を固定baselineとして維持する | 高 | 公開済みrelease commitの既存作者・作品・台詞・音声、content/media、初期全閉、お気に入り挙動がexact一致する。具体的な作者数・作品数・台詞数・音声数はpf-setup着手時点のF008公開状況で確定する |
| REQ-F009-002 | F009を重複なし1作者・3作品バッチで管理する | 高 | 承認候補から3作品`pending`、4ゲート参照付きmanifestを生成する。各状態遷移は承認済み制御commitへ結合した証跡を再読込し、CAS・journalで順序どおりに行い、自動公開しない |
| REQ-F009-003 | 夢野久作を8人目の作者として追加する | 高 | authorId`000096`、原著者名`夢野久作`、表示名候補`ゆめのきゅうさく`、slug候補`yumeno-kyusaku`（QA-F009.mdでオーナー確定）、identity hashが一意で、トップと固有routeから利用できる |
| REQ-F009-004 | 対象3作品を夢野久作だけへ所属させる | 高 | 瓶詰地獄`2381`→きのこ会議`46694`→死後の恋`2380`の順序・所属が正しく、既存作者への混線と重複作品が0件である |
| REQ-F009-005 | 権利・利用規約の適格性を二重確認する | 高 | 選定時と公開直前の独立snapshotで作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を確認する。公式originだけをSSRF耐性付きtransportで取得し、VOICEVOX・ずんだもん最新規約へ無料・広告なし・課金なし・スポンサーなし・非公式の用途と必須creditを適用する。全条件が許可された`decision: allow`だけを取得日時・URL・raw SHA・接続証跡付きでrelease commit/runへ結合し、差分・未判定・transport異常はfail-closedとする |
| REQ-F009-006 | 原典と書誌を再現可能に固定する | 高 | card/XHTMLごとにURL、取得時刻、raw byte列またはcanonical保存path、charset、本文selector、raw SHA-256、底本、入力者、校正者、更新日を同一snapshotへ保持する。対象3作品はいずれも公式card入力・校正欄が記載ありのためF005で導入した`proofreader: null`の適用対象はなく、通常の校正者名をcanonical値とする |
| REQ-F009-007 | 原典を安全かつ決定的に正規化して最外側全角かぎ括弧候補を抽出する | 高 | 対象3作品のXHTML（`2381_13352.html`／`46694_27682.html`／`2380_13349.html`）はraw取得時点でF005確立済みの未定義entity検出手順と外字（`gaiji_list`）検出手順を選定時と公開直前の独立snapshotで適用し、raw byte列とSHA-256を不変保持する。**DOMAIN-F009.md §5のとおり瓶詰地獄・死後の恋の地の文には`class="gaiji"`要素が実在するため（候補内には0件該当を選定時に確認済み）、F008と異なりF009では検出手順を無効化せず常時有効のまま適用する**。公開直前検査で未定義entityまたは候補内gaijiが1件でも検出された場合はfail-closedで当該作品を`pending`に留め、F005確立済みのversion付きexact allowlist正規化手順を再利用するまで候補から除外する。固定原典のexact XHTML 1.1外部DOCTYPE宣言だけはnetwork/filesystem resolverなしで許し、internal subset、他DOCTYPE、ENTITY、XInclude、外部schema/stylesheetをアクセス前に拒否する。深さ・node・属性・text上限内だけを解析し、candidate ID・順序・表示文を決定的にする |
| REQ-F009-008 | 全候補を独立二重判定する | 高 | primary/secondaryを別principal・session・runとして、candidate set・prompt/template・policy・期限・audienceへ結合した一回限りのauthorizationで判定する。互いの結果を見せずsemantic fieldsと入力hashを全件保持し、不一致digestが確定するまで第三裁定tokenを発行せず、最終`pending: 0`とする |
| REQ-F009-009 | 原文表示と読み上げを分離する | 高 | 原文を保持し、旧語・固有名・ロシア語由来の外来語（ペトログラード・ソヴィエト等）の読み補正をrevision/hash chainで再現する。VOICEVOX実測に基づき補正する |
| REQ-F009-010 | 収録範囲と作品固有注意を明示する | 高 | 括弧発話の抜粋・原作由来を3配置で示す。選定時点（DOMAIN-F009.md §5）で瓶詰地獄・死後の恋の図書カードに公式表現注意（不適切と受け取られる可能性のある表現に関する注記）を確認したため、両作品にはF005「趣味の遺伝」で確立済みの作品固有注記UI（FUN-F005-014）をそのまま再適用する。きのこ会議には該当注記がないため実装しない。公開直前に3作品の図書カード「作品について」欄を再確認し、注記の削除・新設・文言変更がないか照合する。差分が検出された場合はfail-closedで当該作品を`pending`に留める |
| REQ-F009-011 | 承認済み台詞だけを差分音声化する | 高 | 固定VOICEVOX tupleで未承認生成、失敗、欠損、孤立が0件となり、同一読み音声を決定的に再利用する |
| REQ-F009-012 | 単一候補と段階容量を生成前に検査する | 高 | 正規化後500 Unicode code point以下、120,000 ms以下、24 kHz・mono・16 bit PCMの予測`44 + ceil(durationMs × 48)`かつ5,760,044 bytes以下、追加WAV 104,857,600 bytes以下、Pages 500/750 MiB、repo 750 MB/1 GB、object 100 MiBを満たす。各停止上限は同値を許可し+1 byteで停止する。audio/public/repo/object/workspace peak/freeAfterPeakのforecastと、phase journal由来のactual peak・minimum freeをcandidate hashへ結合し、最大同時書込み後も5 GiB以上残す。書込み健全性の証明はF005確立済みの事後検証方式（`beginPhase`でのbaseline記録と`endPhase`での実測差分照合、CHG-F005-072）を継続利用する。宣言外のpathの新規出現・変更・消失は0件とする |
| REQ-F009-013 | 作品単位で論理atomic受入する | 高 | 瓶詰地獄→きのこ会議→死後の恋の順に、`pending → extracted → reviewed → budget-approved → voiced → accepted`を証跡再計算とCASで遷移する。audio・artifact・manifestの複数pathはjournalへ旧/新SHA、phase、owner、参照を記録した論理transactionとして扱い、失敗時は旧publicを保持して実体から導いた回復へ収束する |
| REQ-F009-014 | Catalog・routeをデータ駆動で拡張する | 高 | application sourceへ作者・作品固有分岐を追加せず（瓶詰地獄・死後の恋の注記UIはF005確立済みの作品固有注記機構をデータ駆動で再利用し、新規application source分岐を追加しない）、8作者・27作品を参照整合付きで構築し、公開routeを`#/`・既存作者route全件・夢野久作作者route（`#/authors/yumeno-kyusaku`）・`#/favorites`・`#/credits`のexact集合とする。exact件数はpf-setup着手時点のF008公開状況（作者数・作品数）で確定する |
| REQ-F009-015 | 初期全閉・音声・お気に入り契約を維持する | 高 | 全dialogueとの1対1 control、`aria-pressed`、自動再生0を維持する。保存IDはplain JSONのexact schema・件数・長さ・文字種を検証し、Catalog join後だけURL/selector/DOM/pathに使う。prototype/getter、CSS/path注入、重複・未知ID、破損・未知version・上限・quota失敗は除去またはmemory縮退する。既存/F009 ID保持、one-shot元作品移動と通常入口の初期open 0、同時再生1、route切替停止、個別404隔離を満たす |
| REQ-F009-016 | 独自作者画像と権利表示を保持する | 高 | F006確立済みのF00N用汎用artwork provenance schemaへgenerator/version・規約snapshot・prompt・negative prompt・参照入力exact空配列・全入力由来・生成原本/最終SHA・credit・author identityをsealed化する。PNG decodeは形式・encoded/decoded bytes・幅・高さ・pixel・frame上限を固定し、既存画像とのbyte一致またはdHash64-v1（EXIF/alpha/BT.601・9×8 bilinear、bit順・hex表現固定）のHamming距離8以下を拒否し、3作品書誌とjoinする |
| REQ-F009-017 | セキュリティと自動リリース品質を維持する | 高 | phase差分対象の全pathをreparse point非該当・hardlink数1・`resolveSafeWorkspaceFile`解決結果とidentity一致で再検査する。Windows path/reparse/hardlink境界、strict CSP、危険DOM、外部request、Cookie/form、専用favorite key以外のstorage、secret 0、Critical/High 0を確認する。既存Playwright環境のF009必須caseはskip 0とし、exact commit/artifact/dist/catalog digest、画像200、local/hosted WAV Range 206、公開routeを検査する。公開準備はゲート①〜③、`published`記録はゲート④とworkflow/API/smoke/read-back証跡の再読込を必須とし、旧artifact availabilityを事前確認する。全経路でdeploy変数read-back falseまでdurable watchdogが回復し、失敗時は直前baselineのexact routeへrollbackする |
| REQ-F009-018 | 合計10作者(追加7人)の継続上限と順位を再現可能に管理する | 中 | baseline 3作者を含め`targetAdditionalAuthors=7`、F009は追加5人目、残2人、最終上限10作者と記録する。DOMAIN-F006.mdで確定済みの選定式・入力・結果digest（2026-08-21取得SHA-256`580164841c4ade8bc41862bc1ef295e92fba5b20f4b3907e04c95e972176b423`）をF009公開直前に再取得・再確認し、author identity重複を0とする |
| REQ-F009-019 | 長大な単一発話候補への対応方式を明示する | 中 | F007実装で発見・F008で踏襲した実在の制約（VOICEVOX synthesisが単一発話約1,335文字を超える入力に対しHTTP 500を返す）に対し、DOMAIN-F009.md §3.1の実測で死後の恋の1候補（正規化前1,748文字）が既にこの境界を超過していることを確認済みであるため、F009ローカル抽出層（`f009-source.ts`）へF007/F008で確立した安全マージン付き句点分割（実測境界の2倍以上、閾値600文字）と同一手法を実装し、正式抽出時に実測で境界超過が確認された候補へ適用する。既存F001〜F008が依存する共有汎用音声モジュール（`src/voice/generation.ts`・`src/voice/client.ts`）は変更しない |

### 3.1 書込み健全性の証明方式（F005 CHG-F005-072継承）

REQ-F009-012・REQ-F009-017が求める「不正な書込みがないこと」の証明は、F005で確立した事後検証方式（`beginPhase`でのworkspace baseline記録と`endPhase`での実測差分照合）をそのまま継続利用する。F009では新規の書込み健全性方式の設計変更を行わない。

## 4. 運用制約

- 手動・実機・目視・聴取・手動スクリーンリーダーを必須PASS証跡に含めない。
- 概算51候補・30,650,156 bytes、20%余裕後36,780,188 bytes、暫定予測公開559,980,994 bytes（F008未公開のため既存dist実測405,423,000 bytes＋F008安全側予測117,777,806 bytes＋F009追加安全側予測36,780,188 bytesの連鎖見積り）はいずれも選定値であり、正式値は原典固定・全件review後の実測とF008実際の公開結果を正とする。
- ローカル開発機のディスク空き容量はDOMAIN-F008.md調査時点（2026-08-22）で85.2 GiB（全体9.2%）であった。F009実装フェーズでも重い処理（音声・画像生成、ビルド）の前には`Get-PSDrive C`による点検を継続する。生成前forecastは実行時点の実測空き容量で改めて判定し、5 GiB未満に接近する場合はfail-closedで停止する。
- ProjectFactoryの承認ゲートは、本会話の包括承認を対象文書・commitへ明示的に結合して記録する。
- **F008との並行進行に関する制約**: F009要求分析フェーズの実施時点でF008は実装フェーズが別セッションで並行進行中であり未公開である。F009はF008関連ファイル（`scripts/f008-*.ts`・`src/content/f008-*.ts`等、`content/`・`public/`・`src/`配下の実データ・コード全般）を一切変更しない。F009のpf-setup以降のフェーズはF008完了（`docs/features.yaml`のF008が`state: closed`）を待って着手する（`merge_after: [F008]`）。

## 5. 根拠

- `REQUEST.md`
- `docs/domain/DOMAIN-F009.md`
- `docs/qa/QA-F009.md`
- `docs/srs/SRS-F008.md`
- F008 v0.8.0（またはv0.7.0固定baseline）release evidence（F009着手時点で確定）
