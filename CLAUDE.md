# CLAUDE.md - bungo-zundamon(webapp)

## 重要: 操作はコントロールセンターから行う

このプロジェクトは **ProjectFactory** が管理する子プロジェクトです。
新しいセッションでの作業は、このディレクトリで直接始めず、常に **`C:\Users\owner\Desktop\ProjectFactory\ProjectFactoryMain`(コントロールセンター)** を起点として `/pf-*` スキル(`/pf-status`・`/pf-resume`・`/pf-requirements` 等)経由で行ってください。

- スキル・エージェント・ツールは `ProjectFactoryMain` に一元配置されており、本プロジェクトにはコピーしません
- 状態(フェーズ・タスク・キュー)は本プロジェクト配下の `factory.yaml` / `STATUS.md` / `tasks.yaml` / `queue.yaml` / `docs/features.yaml` に記録されます。直接編集する場合もこれらのスキーマに従ってください

## プロジェクト概要

- 種別: Webアプリ(Node.js)
- 技術スタック: Vite + TypeScriptのビルドレスに近いVanilla UI、Vitest、Playwright、ESLint
- 配信方式: GitHub Pagesの`/bungo-zundamon/`配下へ完全静的配信。通常閲覧時は同一オリジン資産のみ使用
- コンテンツ更新: Node.js/TypeScriptスクリプトで取得・抽出・レビュー・音声生成を通常buildから分離

## 検証コマンド

```
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

通常のコミット前検証は`npm run typecheck && npm run lint && npm test && npm run build`。ブラウザ資産が利用可能な環境では`npm run test:e2e`も実行する。

### F002コンテンツ拡充の検証

- 依存関係を固定して再現する場合は`npm ci`を使う。
- セキュリティ回帰は`npm audit --audit-level=high`を追加する。
- 現行パイプラインの段階検査は`npm run content:bibliography`、`content:select`、`content:sources`、`content:extract`、`content:normalize`、`content:review:check`、`content:voice:preflight`、`content:voice`、`content:build`の順で行う。
- `content:voice`は、VOICEVOX ENGINEを`127.0.0.1:50021`だけで起動し、ENGINE版、speaker UUID、style ID、style名を機械照合してから実行する。公開build・ブラウザ実行中はVOICEVOXへ接続しない。
- T-019/T-022では、後続作者にも使える`--batch <FeatureID> --stage <stage>`形式と、追加WAV・Pages artifact・Git objectを分けた容量preflightを正式なnpm scriptとして実装する。実装完了までは未提供コマンドとして扱う。

## プロジェクト規約

- ファイル読み書きは `encoding="utf-8"` を明示する(Windows対応、DES-040)
- 実装コードのコメントには `@des DES-… @fun FUN-…` タグを付与する(DES-007)
- `.env` の値(`PASS_WORD` 等)をログ・コミットメッセージ・ドキュメントに転記しない(DES-039)
- 1フィーチャー = 1ブランチ(`feature/{id}`)で開発する(DES-012)

## ディレクトリ構成(主要なもの)

```
docs/
├── qa/                  # QAシート
├── srs/                 # 要求仕様書
├── design/              # 機能設計書(FD)・関数設計書(DD)
├── tests/{ut,it,qt}/    # テスト仕様書
├── evidence/{ut,it,qt}/ # 試験エビデンス
├── traceability/        # トレーサビリティマトリクス
├── changes/             # 変更管理台帳
├── features.yaml
├── id_counter.yaml
└── cost.yaml
```
