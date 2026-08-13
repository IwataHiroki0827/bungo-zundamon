---
feature: F005
title: 夏目漱石3作品追加
status: Approved
version: 1.1.0
updated: 2026-07-29
---

# 要求仕様書 F005（夏目漱石3作品追加）

## 1. 目的

公開済みv0.4.0を不変に保ち、4人目の作者として夏目漱石の3作品と対応音声を追加する。公開容量を段階管理しながら、既存の継続バッチ、お気に入り、初期全閉、セキュリティを同じ自動証跡契約で維持する。

## 2. 対象範囲

- 夏目漱石（人物ID`000148`、表示名`なつめそうせき`）
- `夢十夜`（`000799`）
- `倫敦塔`（`001076`）
- `趣味の遺伝`（`001104`）
- 新作者route、独自生成作者画像、台詞、同一origin WAV、書誌・権利・画像provenance

F005では「坊っちゃん」等の長編、作品全文朗読、音声圧縮方式変更、アカウント、外部同期、利用者追跡を行わない。

## 3. 要求一覧

| ID | 要求 | 優先度 | 受入基準 |
|---|---|---:|---|
| REQ-F005-001 | v0.4.0を固定baselineとして維持する | 高 | release commit`f0a2c91effd17d1fcf75a578dad2c562ba7949c2`の3作者・12作品・674台詞・662音声、content/media、初期全閉、お気に入り挙動がexact一致する |
| REQ-F005-002 | F005を重複なし1作者・3作品バッチで管理する | 高 | 承認候補から3作品`pending`、4ゲート参照付きmanifestを生成する。各状態遷移は承認済み制御commitへ結合した証跡を再読込し、CAS・journalで順序どおりに行い、自動公開しない |
| REQ-F005-003 | 夏目漱石を4人目の作者として追加する | 高 | authorId`000148`、原著者名`夏目漱石`、表示名`なつめそうせき`、slug`natsume-soseki`、identity hashが一意で、トップと固有routeから利用できる |
| REQ-F005-004 | 対象3作品を夏目漱石だけへ所属させる | 高 | 夢十夜`000799`→倫敦塔`001076`→趣味の遺伝`001104`の順序・所属が正しく、既存作者への混線と重複作品が0件である |
| REQ-F005-005 | 権利・利用規約の適格性を二重確認する | 高 | 選定時と公開直前の独立snapshotで人物・作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を確認する。公式originだけをSSRF耐性付きtransportで取得し、VOICEVOX・ずんだもん最新規約へ無料・広告なし・課金なし・スポンサーなし・非公式の用途と必須creditを適用する。全条件が許可された`decision: allow`だけを取得日時・URL・raw SHA・接続証跡付きでrelease commit/runへ結合し、差分・未判定・transport異常はfail-closedとする |
| REQ-F005-006 | 原典と書誌を再現可能に固定する | 高 | card/XHTMLごとにURL、取得時刻、raw byte列またはcanonical保存path、charset、本文selector、raw SHA-256、底本、入力者、校正者、更新日を同一snapshotへ保持する。公式cardに校正者欄がない夢十夜だけは`proofreader: null`をcanonical値とし、空文字・推測名を拒否して、source・provenance・Catalog・loader・UI・creditsの全層で後方互換に処理し「校正者: 記載なし」と表示する |
| REQ-F005-007 | 原典を安全かつ決定的に正規化して最外側全角かぎ括弧候補を抽出する | 高 | 趣味の遺伝raw 161,913 bytes、Shift_JIS、SHA-256 `91209534d37abf5fc66a4720eb167b0315aefbd5ea8842cccd731d4155e982ef`を不変保持し、`div.notation_notes`の`<td>&nbsp;&nbsp;</td>`に連続するexact 2件だけを`<td>&#160;&#160;</td>`へ1対1で写し、processed SHA-256 `c1e2f27fe6acc91bdb8b66115f21a3efd64fadbc9112e7365f574e94ff69696b`を記録する。固定原典のexact XHTML 1.1外部DOCTYPE宣言だけはnetwork/filesystem resolverなしで許し、internal subset、他DOCTYPE、ENTITY、XInclude、外部schema/stylesheetをアクセス前に拒否する。深さ・node・属性・text上限内だけを解析し、candidate ID・順序・表示文を決定的にする |
| REQ-F005-008 | 全候補を独立二重判定する | 高 | primary/secondaryを別principal・session・runとして、candidate set・prompt/template・policy・期限・audienceへ結合した一回限りのauthorizationで判定する。互いの結果を見せずsemantic fieldsと入力hashを全件保持し、不一致digestが確定するまで第三裁定tokenを発行せず、最終`pending: 0`とする |
| REQ-F005-009 | 原文表示と読み上げを分離する | 高 | 原文を保持し、旧語・固有名・外来語の読み補正をrevision/hash chainで再現する |
| REQ-F005-010 | 収録範囲と作品固有注意を明示する | 高 | 括弧発話の抜粋・原作由来を3配置で示す。「趣味の遺伝」だけは公式card raw由来の注意文、出典URL、raw SHA、text SHA、配置集合をデータとして作者画面・作品画面・creditsへ表示し、既存F003の注意文schemaと表示bytesを変更しない |
| REQ-F005-011 | 承認済み台詞だけを差分音声化する | 高 | 固定VOICEVOX tupleで未承認生成、失敗、欠損、孤立が0件となり、同一読み音声を決定的に再利用する |
| REQ-F005-012 | 単一候補と段階容量を生成前に検査する | 高 | 正規化後500 Unicode code point以下、120,000 ms以下、24 kHz・mono・16 bit PCMの予測`44 + ceil(durationMs × 48)`かつ5,760,044 bytes以下、追加WAV 104,857,600 bytes以下、Pages 500/750 MiB、repo 750 MB/1 GB、object 100 MiBを満たす。各停止上限は同値を許可し+1 byteで停止する。audio/public/repo/object/workspace peak/freeAfterPeakのforecastと、phase journal由来のactual peak・minimum freeをcandidate hashへ結合し、最大同時書込み後も5 GiB以上残す。phase実行中の書込み健全性は、カーネルイベントの逐次相関ではなくphase前後のワークスペース実測差分で証明する（CHG-F005-072）。`beginPhase`で追跡対象root配下のworkspace相対path・bytes・SHA-256・native identity・reparse有無・hardlink数と空き容量をbaselineとして記録し、`endPhase`で再列挙した実測差分が、宣言済みmutation列をsequence順に畳み込んだ期待状態とpath・最終SHA-256・bytesまでexact一致することを検証する。宣言外のpathの新規出現・変更・消失は0件とする |
| REQ-F005-013 | 作品単位で論理atomic受入する | 高 | 夢十夜→倫敦塔→趣味の遺伝の順に、`pending → extracted → reviewed → budget-approved → voiced → accepted`を証跡再計算とCASで遷移する。audio・artifact・manifestの複数pathはjournalへ旧/新SHA、phase、owner、参照を記録した論理transactionとして扱い、失敗時は旧publicを保持して実体から導いた回復へ収束する |
| REQ-F005-014 | Catalog・routeをデータ駆動で拡張する | 高 | application sourceへ作者・作品固有分岐を追加せず、4作者・15作品を参照整合付きで構築し、公開routeを`#/`・既存3作者・`#/authors/natsume-soseki`・`#/favorites`・`#/credits`のexact 7件とする |
| REQ-F005-015 | 初期全閉・音声・お気に入り契約を維持する | 高 | 全dialogueとの1対1 control、`aria-pressed`、自動再生0を維持する。保存IDはplain JSONのexact schema・件数・長さ・文字種を検証し、Catalog join後だけURL/selector/DOM/pathに使う。prototype/getter、CSS/path注入、重複・未知ID、破損・未知version・上限・quota失敗は除去またはmemory縮退する。既存/F005 ID保持、one-shot元作品移動と通常入口の初期open 0、同時再生1、route切替停止、個別404隔離を満たす |
| REQ-F005-016 | 独自作者画像と権利表示を保持する | 高 | F005用汎用`ArtworkProvenanceV4`へgenerator/version・規約snapshot・prompt・negative prompt・参照入力exact空配列・全入力由来・生成原本/最終SHA・credit・author identityをsealed化する。PNG decodeは形式・encoded/decoded bytes・幅・高さ・pixel・frame上限を固定し、既存画像とのbyte一致またはdHash64-v1（EXIF/alpha/BT.601/9×8 bilinear、bit順・hex表現固定）のHamming距離8以下を拒否し、3作品書誌とjoinする |
| REQ-F005-017 | セキュリティと自動リリース品質を維持する | 高 | phase差分対象の全pathをreparse point非該当・hardlink数1・`resolveSafeWorkspaceFile`解決結果とidentity一致で再検査する（CHG-F005-072）。Windows path/reparse/hardlink境界、strict CSP、危険DOM、外部request、Cookie/form、専用favorite key以外のstorage、secret 0、Critical/High 0を確認する。Playwright既存6自動環境のF005必須caseはskip 0とし、exact commit/artifact/dist/catalog digest、画像200、local/hosted WAV Range 206、公開7 routeを検査する。公開準備はゲート①〜③、`published`記録はゲート④とworkflow/API/smoke/read-back証跡の再読込を必須とし、旧artifact availabilityを事前確認する。全経路でdeploy変数read-back falseまでdurable watchdogが回復し、失敗時はv0.4.0のexact 6 routeへrollbackする |
| REQ-F005-018 | 追加作者10人の継続上限と順位を再現可能に管理する | 中 | baseline 3作者とは別に`targetAdditionalAuthors=10`、F005は追加1人目、残9人、最終上限13作者と記録する。2022年公式XHTML上位500行を拡充CSVの`著者`へ人物ID結合し、人物別閲覧数合計の降順・同点は人物ID数値昇順とする入力・式・結果digestを引き継ぎ、author identity重複を0とする |

### 3.1 書込み健全性の証明方式（CHG-F005-072）

REQ-F005-012・REQ-F005-017が求める「不正な書込みがないこと」は、当初
phase実行中の全カーネルファイルイベントをETWで逐次相関し、帰属不能なイベントを
fail-closedとする常時監視方式で実現していた。

この方式は共有hosted runner上で収束しないことが実測で確定した。停止要因は
いずれもPID 4（System）によるキャッシュマネージャの遅延書き戻しとdirectory
metadata更新であり、観測されうるカーネルイベントの集合が閉じていないため、
1つを固定分類すると次の変種が現れる。2026-07-29から16日間で71件の変更管理と
169 commitを費やし、外部診断codeは90から108へ増えたが、生成された成果物は0件だった。

そのため証明方式を事後検証へ置換する。保証する性質は同一で、判定は
phase完了後の最終状態に対して行うため、遅延書き戻しの影響を受けない。
ETWバッファ溢れによる検出漏れも起こらない。

事後検証は「phase中に一時的に書かれ、`endPhase`までに元へ戻された書込み」を
検出しないが、最終状態が宣言と一致する限り成果物には影響しないため許容する。

## 4. 運用制約

- 手動・実機・目視・聴取・手動スクリーンリーダーを必須PASS証跡に含めない。
- 概算229候補・72,589,906 bytes、最小公開予測302,525,857 bytesは選定値であり、正式値は原典固定・全件review後の実測を正とする。
- ProjectFactoryの承認ゲートは、本会話の包括承認を対象文書・commitへ明示的に結合して記録する。

## 5. 根拠

- `REQUEST.md` §13
- `docs/domain/DOMAIN-F005.md`
- `docs/qa/QA-F005.md`
- F004 v0.4.0 release evidence
