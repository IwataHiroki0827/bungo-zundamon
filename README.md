# 文豪ずんだもん

青空文庫の著作権保護期間満了作品から台詞を抽出し、ずんだもん音声で楽しむ静的Webアプリです。

## 操作について

このプロジェクトへの操作は **コントロールセンター(`ProjectFactoryMain`)から** `$pf-*` スキル経由で行います。詳細は `CLAUDE.md` を参照してください。

## 検証コマンド

```
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

`$pf-setup` フェーズで実際のフレームワーク・ビルドツールに応じてコマンドを更新します。
