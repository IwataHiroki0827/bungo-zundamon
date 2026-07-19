# QT-F001 Q-009 ブラウザ・規約確認証跡

## 判定

候補commit `5337d2752e5a288b8d3078c2d1d133ebdef6ed21`に対するWindows Chrome／Edgeと規約・クレジットはPASSした。iOS Safariは端末・OS/browser版、縦横画像、操作別結果、通信結果が未記録である。2026-07-19にプロジェクトオーナーが不足を理解した上で「今回はすべてokにして次に進めてください」と明示したため、当該リリース限りの残余リスク受容としてQ-009全体を`READY_FOR_APPROVAL_WITH_ACCEPTED_RISK`と判定する。

| 対象 | 判定 | 根拠 |
|---|---|---|
| Windows Chrome stable | PASS | 150.0.7871.127、ネイティブHTML Audio、3画面幅、CSP・外部通信0件、既存E2E 13/13 |
| Windows Edge stable | PASS | 150.0.4078.83、ネイティブHTML Audio、3画面幅、CSP・外部通信0件、既存E2E 13/13 |
| iOS Safari実機 | PASS（例外受容） | 詳細証跡は未取得。プロジェクトオーナーが当該リリース限りの残余リスクとして明示受容 |
| WebKit自動 | PASS | Playwright WebKit 13/13。iOS Safari実機の代替ではない |
| Pixel 7相当自動 | PASS | Chromium + Pixel 7相当viewport 13/13。mobile実機の代替ではない |
| 規約・クレジット | PASS | 必須6表示、外部リンク属性、manifest有効期限、公式URL到達を照合 |

## 候補同一性

- 実行時HEAD: `5337d2752e5a288b8d3078c2d1d133ebdef6ed21`（`feature/F001`）
- 指定候補SHAとの一致: PASS
- `dist/content/catalog.json` SHA-256: `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`
- `public/content/catalog.json` SHA-256: 同上
- preview: `http://127.0.0.1:4173/bungo-zundamon/`（HTTP 200）
- OS: Microsoft Windows 11 Home `10.0.26200`（build 26200）

## Chrome／Edge stableの自動実機チャンネル確認

2026-07-19T19:51:30.749+09:00から2026-07-19T19:51:57.876+09:00に、Playwrightがinstalled stableの`chrome`／`msedge` channelを起動した。test doubleを注入せず、製品のネイティブ`HTMLAudioElement`で次を各チャンネル・各画面幅に対して実行した。

1. トップの「作品と台詞を聴く」から作者「あくたがわずんのすけ」へ遷移する。
2. 3作品を検出し、先頭作品「羅生門」の8台詞を検出する。
3. 先頭台詞で再生、一時停止、再開、停止、先頭から再生を行う。
4. 状態列`idle → playing → paused → playing → stopped → playing`を確認する。
5. 390×844、844×390、1440×900で横overflowがないことを確認する。
6. CSP violation、外部origin request、request failure、HTTP 4xx/5xx、console error、page errorがいずれも0件であることを確認する。

既存E2Eも同じport 4173で再実行し、Chrome/Edgeは26/26、WebKit/Pixel 7相当は26/26 PASSした。既存E2Eの音声検査は決定的adapterを用いるが、上記の追加確認はネイティブ音声を用いたため、両方の根拠を分離している。

初回runnerは存在しない`.dialogue-text` selectorを参照し、両チャンネルとも操作前にtimeoutした。これは製品FAILではないため`INVALID`とし、証跡runnerだけを`blockquote p`へ修正して再実行した。既存実装・既存testは変更していない。

## 画面証拠

画面証拠は[Q-009 screenshots](screenshots/q009/)に保存した。ファイルごとのbytesとSHA-256は[JSON証跡](QT-F001-q009-browser-evidence.json)に記録した。

- Chrome: `390x844`、`844x390`、`1440x900`、credits `1440x900`
- Edge: `390x844`、`844x390`、`1440x900`、credits `1440x900`

ChromeとEdgeの本体画面PNGが同一hashなのは、同じBlink描画結果を同じheadless viewportで取得したためである。credits画像は取得タイミング差によりhashが異なる。

## iOS Safari回答と例外受容の評価

Q-009には`result: PASS`、`note: OK`が入力された。この回答から証明できるのは、ユーザーが当該項目を確認し、明白な異常なしと自己申告したことまでである。以下は証明できない。

- 端末名、iOS版、Safari版
- 候補SHA/catalog hashと実機セッションの結合
- 縦向き・横向きの表示、横scroll・重なりの不在
- 再生、一時停止、再開、停止、先頭から再生の操作別結果
- 外部通信の不在
- 画面または動画と、そのSHA-256

WebKit 13/13 PASSはSafari系エンジンの回帰根拠、Pixel 7相当13/13 PASSはmobile viewportの回帰根拠になるが、installed iOS Safari実機の版・音声・タップ・回転を証明しない。この限界を保ったまま、2026-07-19のプロジェクトオーナー直接指示を当該リリース限りの例外受容として記録する。実機試験済みとは扱わず、リリース承認ゲート④へ未実施環境として開示する。

## 規約・クレジット確認

2026-07-19T19:54:45.7146488+09:00に、ローカルcredits表示と公式URLを照合した。

| 項目 | ローカル表示 | 公式確認先 | 判定 |
|---|---|---|---|
| VOICEVOX | `VOICEVOX:ずんだもん`、公式トップリンク | `https://voicevox.hiroshiba.jp/term/`、`https://voicevox.hiroshiba.jp/product/zundamon/` | PASS |
| 立ち絵 | `立ち絵：坂本アヒル`、素材ページリンク、素材README版/hash | `https://seiga.nicovideo.jp/seiga/im11206626` | PASS |
| 青空文庫 | 3作品の図書カード・底本・入力/校正・取得/加工、公式トップリンク | `https://www.aozora.gr.jp/guide/kijyunn.html`、`https://www.aozora.gr.jp/guide/roudoku.html` | PASS |
| 書誌ライセンス | 書誌だけを対象とする`CC BY 4.0`と変更表示 | `https://creativecommons.org/licenses/by/4.0/` | PASS |
| 非公式・無料 | 非公式ファンサイト、無料、広告・課金なし | ローカルmanifest必須値 | PASS |
| 国外免責 | 日本法基準、日本国外の権利状態を一律に保証しない | ローカルmanifest必須値 | PASS |
| キャラクター規約 | 「確認した利用規約」が公式URLと一致 | `https://zunko.jp/guideline.html` | PASS |

manifestの規約確認日は`2026-07-18T07:25:00Z`、有効期限は`2026-08-18T07:25:00Z`であり、確認時点で期限内だった。青空文庫とVOICEVOXのローカルリンクは公式トップで、取扱規準・朗読・VOICEVOX規約・製品ページへの直接リンクではない。ただし承認済み`REQ-F001-017`／`DES-F001-012`の必須リンク条件には適合しており、High残余リスクとは判定しない。

## 残余と次の処置

iOS Safari実機の詳細証跡不足はプロジェクトオーナーが当該リリース限りで受容した。Q-009はcloseし、`ready_for_approval_with_accepted_risk`としてゲート④へ進める。公開後smokeを実施し、iOS未実施環境は次期リリースで再確認する条件として承認本文へ明記する。
