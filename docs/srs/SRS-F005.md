---
feature: F005
title: 夏目漱石3作品追加
status: Approved
version: 1.0.0
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
| REQ-F005-002 | F005を重複なし1作者・3作品バッチで管理する | 高 | 承認候補から3作品`pending`、4ゲート参照付きmanifestを生成し、自動公開しない |
| REQ-F005-003 | 夏目漱石を4人目の作者として追加する | 高 | authorId`000148`、原著者名`夏目漱石`、表示名`なつめそうせき`、slug`natsume-soseki`、identity hashが一意で、トップと固有routeから利用できる |
| REQ-F005-004 | 対象3作品を夏目漱石だけへ所属させる | 高 | 夢十夜`000799`→倫敦塔`001076`→趣味の遺伝`001104`の順序・所属が正しく、既存作者への混線と重複作品が0件である |
| REQ-F005-005 | 権利・利用規約の適格性を二重確認する | 高 | 選定時と公開直前の独立snapshotで人物・作品著作権フラグ=`なし`、役割=`著者`、翻訳者0、`公開中`、`新字新仮名`を確認する。VOICEVOX・ずんだもん最新規約へ無料・広告なし・課金なし・スポンサーなし・非公式の用途と必須creditを適用し、全条件が許可された`decision: allow`だけを取得日時・URL・raw SHA付きでrelease commit/runへ結合する。差分・未判定はfail-closedとする |
| REQ-F005-006 | 原典と書誌を再現可能に固定する | 高 | card/XHTML URL、raw byte列、charset、本文selector、取得日時、raw SHA-256、底本、入力者、校正者、更新日を保持する。公式cardに校正者欄がない夢十夜は`proofreader: null`をcanonical値とし、空文字・推測名を拒否してUIでは「校正者: 記載なし」と表示する |
| REQ-F005-007 | 原典を決定的に正規化して最外側全角かぎ括弧候補を抽出する | 高 | 趣味の遺伝raw SHA-256 `91209534d37abf5fc66a4720eb167b0315aefbd5ea8842cccd731d4155e982ef`を不変保持し、`div.notation_notes`の`<td>&nbsp;&nbsp;</td>`に連続するexact 2件だけを`&#160;`へ写すversion付きallowlist正規化のprocessed SHAを記録する。件数・context差分と未知entityを拒否し、同一入力でcandidate ID・順序・表示文が一致して本文外、壊れた括弧、単独`『』`を混入させない |
| REQ-F005-008 | 全候補を独立二重判定する | 高 | semantic fieldsと入力hashを全件保持し、不一致は第三裁定まで生成停止、最終`pending: 0`とする |
| REQ-F005-009 | 原文表示と読み上げを分離する | 高 | 原文を保持し、旧語・固有名・外来語の読み補正をrevision/hash chainで再現する |
| REQ-F005-010 | 収録範囲と作品固有注意を明示する | 高 | 括弧発話の抜粋・原作由来を3配置で示し、「趣味の遺伝」の公式表現注意を出典URL・改変防止hash付きで作者画面・作品画面・creditsへ表示する |
| REQ-F005-011 | 承認済み台詞だけを差分音声化する | 高 | 固定VOICEVOX tupleで未承認生成、失敗、欠損、孤立が0件となり、同一読み音声を決定的に再利用する |
| REQ-F005-012 | 単一候補と段階容量を生成前に検査する | 高 | 正規化後500 Unicode code point以下、120,000 ms以下、24 kHz・mono・16 bit PCMの予測`44 + ceil(durationMs × 48)`かつ5,760,044 bytes以下、追加WAV 104,857,600 bytes以下、Pages 500/750 MiB、repo 750 MB/1 GB、object 100 MiBを満たし、audio/public/repo/object/workspace peak/freeAfterPeakのbyte forecastをcandidate hashへ結合して最大同時書込み後も5 GiB以上残す |
| REQ-F005-013 | 作品単位でatomic受入する | 高 | 夢十夜→倫敦塔→趣味の遺伝の順に完了作品だけを`accepted`へ遷移し、失敗時は旧publicを保持してjournalから回復する |
| REQ-F005-014 | Catalog・routeをデータ駆動で拡張する | 高 | application sourceへ作者・作品固有分岐を追加せず、4作者・15作品を参照整合付きで構築し、公開routeを`#/`・既存3作者・`#/authors/natsume-soseki`・`#/favorites`・`#/credits`のexact 7件とする |
| REQ-F005-015 | 初期全閉・音声・お気に入り契約を維持する | 高 | 全dialogueとの1対1 control、`aria-pressed`、自動再生0、重複・未知ID除去、破損・未知version・上限・quota失敗時memory縮退、既存/F005 ID保持、one-shot元作品移動と通常入口の初期open 0、同時再生1、route切替停止、個別404隔離を満たす |
| REQ-F005-016 | 独自作者画像と権利表示を保持する | 高 | generator/version・規約snapshot・prompt・negative prompt・未承認参照入力0・全入力由来・生成原本/最終SHA・creditをsealed化する。既存画像とのbyte一致またはdHash64-v1（EXIF/alpha/BT.601/9×8 bilinear固定）のHamming距離8以下を拒否し、3作品書誌とjoinする |
| REQ-F005-017 | セキュリティと自動リリース品質を維持する | 高 | CSP・危険DOM・外部request・Cookie/form・専用favorite key以外のstorage・secret 0、Critical/High 0、Playwright 6自動環境（Chromium desktop、Firefox desktop、WebKit desktop、Pixel 7相当Chromium、Chrome stable、Edge stable）、exact commit/artifact/dist/catalog digest、画像200、WAV Range 206、公開7 route、deploy変数read-back falseを確認し、失敗時は旧publicを維持してrollbackする |
| REQ-F005-018 | 追加作者10人の継続上限と順位を再現可能に管理する | 中 | baseline 3作者とは別に`targetAdditionalAuthors=10`、F005は追加1人目、残9人、最終上限13作者と記録する。2022年公式XHTML上位500行を拡充CSVの`著者`へ人物ID結合し、人物別閲覧数合計の降順・同点は人物ID数値昇順とする入力・式・結果digestを引き継ぎ、author identity重複を0とする |

## 4. 運用制約

- 手動・実機・目視・聴取・手動スクリーンリーダーを必須PASS証跡に含めない。
- 概算229候補・72,589,906 bytes、最小公開予測302,525,857 bytesは選定値であり、正式値は原典固定・全件review後の実測を正とする。
- ProjectFactoryの承認ゲートは、本会話の包括承認を対象文書・commitへ明示的に結合して記録する。

## 5. 根拠

- `REQUEST.md` §13
- `docs/domain/DOMAIN-F005.md`
- `docs/qa/QA-F005.md`
- F004 v0.4.0 release evidence
