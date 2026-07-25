# T-023 実装・受け入れ証跡

## 判定

- タスク: T-023（宮沢賢治画像・規約snapshot・権利証跡）
- 対象feature: F002
- 実装判定: PASS
- 独立受け入れ判定: PASS
- 判定日: 2026-07-25

## 規約観測

選定時点の公式規約5件を`policy-https-pinned-v1`で取得し、追跡対象にはURL、取得時刻、HTTP状態、媒体型、本文byte数、SHA-256、判断要約のみを保存した。規約本文は`.cache/rights/F002/`だけへatomic保存し、`content/`および`public/`内のraw snapshotは0件とした。

| 規約 | URL | byte数 | SHA-256 |
|---|---|---:|---|
| 青空文庫 収録ファイルの取り扱い規準 | `https://www.aozora.gr.jp/guide/kijyunn.html` | 10,563 | `1cc5417bf036b96a8fdb7201cd9ab9c262f849e27926867e4d26cc6072c81da6` |
| VOICEVOX 利用規約 | `https://voicevox.hiroshiba.jp/term/` | 28,598 | `10dbc1bafcbe612378b998e96882809970f1591194ab2851669e11805feff40b` |
| ずんだもん音源利用規約 | `https://zunko.jp/con_ongen_kiyaku.html` | 8,169 | `d249b088ad9562edd123397422864d32765f183d7e4f60c857a100f4228572ec` |
| キャラクター利用ガイドライン | `https://zunko.jp/guideline.html` | 47,088 | `d1c146255cac9e3d9432b73787c22b6faf33df4454fc314720ceb9c1c0bf115d` |
| OpenAI Terms of Use | `https://openai.com/policies/terms-of-use/` | 374,982 | `043449f1a2b1c49d3fd644449e895ce8971469b45eefbca38771195854288496` |

取得時刻は2026-07-25T10:50:10Z台、全件HTTP 200である。

## 安全transport・変更ゲート

- 取得URLを上記5件へ完全allowlistし、HTTPS、port、userinfo、query、fragment、最終URLを固定した。
- DNS全回答と接続先IPをpublic addressへ制限し、Host/SNI/TLS/hostname照合と接続先pinを必須にした。
- redirect、proxy、retryを禁止し、8 MiB以下、15,000 ms未満、許可media type、status 200へ固定した。
- capture時にも型を信用せず、安全証跡、本文byte数、SHA、取得時刻、transport版、reviewer、判断要約をruntime再検証する。
- raw書込み直前にtrusted project rootとworkspaceのlexical path、`lstat`、`realpath`完全一致を確認し、reparse pointおよび`public`/`content`配下workspaceを拒否する。
- selectionとpredeployの両時点で5規約の完全性、F002 batch、40桁commit SHA、run IDを再検証する。hash変更時は影響範囲レビューがなければfail-closedで公開を停止する。

## 画像生成由来

- 正本: `content/batches/F002/public-files/artwork/miyazawa-zundamon.png`
- 公開先: `artwork/miyazawa-zundamon.png`
- 形式: PNG / RGB / 8 bit / 1,254 × 1,254 px
- byte数: 3,118,359
- SHA-256: `6c059a93f09608bdba9a4dbe8b5b0af0b0b901b7dd7e4b2184cca4093110e087`
- provider/tool: OpenAI / built-in `image_gen`
- model/modelVersion: built-in toolから非公開
- 入力画像: 0件
- prompt SHA-256: `192126ca1d846cc2268109b1e4b0949b0dfa070a973af79ca55244eb33ad7a05`
- recipe SHA-256: `02740b2118c90829320f844d701e09453349653ddeeff03b12e8f1d1993462f8`

完全な生成prompt、入力allowlist、生成手順、出力metadata、キャラクター規約とprovider規約の観測hashを`artwork-provenance.json`へ固定した。画像はプロジェクトオーナーの包括承認とCodexの実物目視を記録し、架空のchibi 1人、豆さや状の髪、紺色のコート、帽子、本、和紙・星・草花を確認した。文字、署名、watermark、logo、写真風の実在人物顔、第三者素材由来の識別要素は確認されなかった。個別の人手確認はT-029/QTで再確認する。

## 結合・回帰試験

- provenanceの画像正本を`BatchCatalogFragment.publicFiles`へ結合し、`buildIntegratedPublicTree`の公開treeへ同一hashで昇格できることを実fixtureで確認した。
- 偽造したprivate DNS、時刻、transport版、media type、timeout、TLS/hostname/redirect/retry証跡をcaptureで拒否した。
- attacker URL、status 500、負byte数、不正hash、空reviewer/判断要約、不正commit SHAの5観測をcompareで`blocked`にした。
- `public/nested`と`content/nested`に偽markerを置いたworkspaceを拒否し、`.cache`書込み0件を確認した。
- 実selection JSONからexact predeployを構成した比較は`unchanged`かつreason codeなしで通過した。

## 依存関係・検証結果

- `brace-expansion`を5.0.8へ更新し、高重大度アドバイザリを解消した。
- `npm ci`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: 36 files / 639 tests PASS
- `npm run verify:build`: PASS（66 files / 30,423,361 bytes）
- `npm run build`: PASS（66 files / 30,423,361 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- secret pattern scan: 実認証情報0件
- `content/`・`public/`内raw snapshot: 0件

## 受け入れ経緯

初回受け入れでは、型を偽装した取得responseと比較観測がruntime検証を迂回できたため差し戻した。完全schema、5 URL、F002 batch、security proof、40桁commit SHA、run IDのfail-closed検証と悪性fixtureを追加した。再受け入れでは`public/nested`をworkspaceにしたraw書込み経路を検出したため、trusted project rootとの実体完全一致と公開・追跡領域拒否を追加した。両攻撃を実再現して拒否・書込み0件を確認し、残るHigh/Medium不適合なしでPASSとした。
