# 変更履歴

このファイルは文豪ずんだもんの公開版における主な変更を記録する。

## [0.2.0] - 2026-07-26

### 追加

- 2人目の作者として「みやざわずんじ（原著者: 宮沢賢治）」を追加。
- 「よだかの星」「どんぐりと山猫」「注文の多い料理店」から、レビュー済み154台詞とVOICEVOX音声151件を追加。
- 複数作者の一覧・作者別route・作者切替時の音声停止・作者別クレジットと画像由来表示を追加。
- 後続の作者・3作品batchを同じschema、CLI、容量・権利・公開ゲートで増やせる継続拡充基盤を追加。

### 品質確認

- Vitest 734件、Playwright 4範囲84件、型検査、lint、production build、依存脆弱性検査を自動実行。
- F001の3作品・59台詞・全音声と由来情報が不変であることを、content treeとPages成果物で検証。
- 手動・物理実機・目視・聴取を必須証跡にせず、Chromium、Firefox、WebKit、Android相当とWindows filesystem回復試験で判定。

### 修正

- accepted音声・公開tree・published manifestのjournal回復、candidate tuple、容量計測、権利・規約・画像由来のfail-closed検査を強化。
- F002公開treeのreview・speech revision・作者画像provenance参照を完全に結合。

## [0.1.0] - 2026-07-19

### 追加

- 青空文庫の「羅生門」「蜘蛛の糸」「杜子春」から、レビュー済み59台詞を掲載した静的Webサイト。
- `VOICEVOX:ずんだもん`で生成した音声の再生、一時停止、再開、停止、先頭再生。
- 作者・作品・台詞の導線、出典・クレジット・非公式表示・プライバシー表示。
- GitHub Pages向けのオフラインbuild、CSP、同一origin、容量上限、承認SHA拘束deploy。

### 品質確認

- 型検査、lint、UT 337件、Playwright E2E 78件、production buildをPASS。
- Chromium、Firefox、WebKit、Android相当、Windows Chrome/Edgeを確認。
- iOS Safariとスクリーンリーダーの詳細証跡不足は、プロジェクトオーナーが当該リリース限りの残余リスクとして受容。公開後smokeと次期リリースで再確認する。

### 修正

- 初回公開smokeで検出した、モバイル幅のクレジット画面でSHA-256文字列が横スクロールを発生させる問題を修正。

[0.2.0]: https://github.com/IwataHiroki0827/bungo-zundamon/releases/tag/v0.2.0
[0.1.0]: https://github.com/IwataHiroki0827/bungo-zundamon/releases/tag/v0.1.0
