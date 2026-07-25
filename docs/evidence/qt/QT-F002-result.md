# QT-F002 実施結果

- 更新日時: 2026-07-26 03:01 JST
- 現在判定: **QT-F002-001〜014 正式PASS**
- 仕様ID照合: `QT-F002-001`〜`QT-F002-014`の14/14件を自動試験へ直接対応、未対応0件、余剰0件
- 手動・実機・目視・聴取・スクリーンリーダー入力: F002必須証跡には含めない

## source段階の自動試験

| 範囲 | 結果 |
|---|---:|
| Chromium Pages preview | 21/21 PASS |
| Firefox Pages preview | 21/21 PASS |
| WebKit Pages preview | 21/21 PASS |
| Android相当（Pixel 7 / Chromium） | 21/21 PASS |
| 合計 | **84/84 PASS** |

- unexpected: 0件
- skipped: 0件
- flaky: 0件
- exact candidate再実行時間: 137.3秒
- JSON生ログ: `docs/evidence/qt/QT-F002-browser-attempt-1.json`
- 生ログSHA-256: `b86840c799ceaec6289967798aab379dc61405f0a459b1ac424e0bb291290833`
- 仕様対応表: `docs/evidence/qt/spec-match.md`
- 付帯回帰: Vitest 737/737、typecheck、lint、production build、依存脆弱性検査をすべてPASS
- 付帯検証生ログ: `docs/evidence/qt/QT-F002-auxiliary-attempt-1.json`
- 付帯検証SHA-256: `076567b40e7f12f802fbf28df093fd4871f5446ab4250319cc301d41083cb88c`
- 実行環境: Windows `10.0.26200` x64、Node.js `v24.11.0`、npm `11.6.1`

## exact candidateと公開後判定

- release commit: `84c985f382910216e381a96901f6fd569165a27e`
- content build SHA-256: `09652af7de82eb32569d280566897c8fcf0c7e033b94d607becb42172f2b02d4`
- dist SHA-256: `c60431bd4da3b1ba43ac71e299089f4dc8cbad563a58f3df3d2424fd952d9fde`
- hosted artifact SHA-256: `08a5beed15eae8c4de2f5eb72601fa1628893799f8f55791a6075811d1ace6fc`
- feature build: Actions run `30168446371`、build成功・deployスキップ
- production deploy: Actions run `30168689551`、build/deploy成功
- 公開スモーク: 全4 route、2作者・6作品・213台詞、宮沢154台詞、クレジット、WAV Range取得をPASS
- デプロイ変数: 公開直後に無効化済み

権利・規約・画像判断、security、容量、84件のブラウザ結果を同一candidate tupleへ結合し、公開サイトでもエラー0件を確認した。よってQT-F002-001〜014を正式PASSと判定する。
