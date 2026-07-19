# 変更履歴

このファイルは文豪ずんだもんの公開版における主な変更を記録する。

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

[0.1.0]: https://github.com/IwataHiroki0827/bungo-zundamon/releases/tag/v0.1.0
