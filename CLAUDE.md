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

### F002以降のコンテンツ拡充の検証

- 依存関係を固定して再現する場合は`npm ci`を使う。
- セキュリティ回帰は`npm audit --audit-level=high`を追加する。
- 現行パイプラインの段階検査は`npm run content:bibliography`、`content:select`、`content:sources`、`content:extract`、`content:normalize`、`content:review:check`、`content:voice:preflight`、`content:voice`、`content:build`の順で行う。
- `content:voice`は、VOICEVOX ENGINEを`127.0.0.1:50021`だけで起動し、ENGINE版、speaker UUID、style ID、style名を機械照合してから実行する。公開build・ブラウザ実行中はVOICEVOXへ接続しない。
- F003は`npm run content:batch -- --batch F003 --work <WorkID> --stage <stage|all>`を使用し、女生徒→走れメロス→グッド・バイの順に作品単位で処理する。
- F003の候補定義は`content/batch-candidates.json`に置き、作者・作品固有のapplication code分岐を追加しない。
- F003音声生成前にはdisk-guardを実行し、追加WAV・Pages artifact・Git object・source repository・作業ドライブを別々に検査する。
- F004は`npm run content:batch -- --batch F004 --work <WorkID> --stage <stage|all>`を使用し、オツベルと象（`000466`）→雪渡り（`045679`）→カイロ団長（`001918`）の順に作品単位で処理する。
- F004は公開済みv0.3.0を固定baselineにし、既存宮沢author identity・route・画像をexact再利用する。音声生成前はdisk-guardと既存の容量境界試験を実行する。
- F005は`npm run content:batch -- --batch F005 --work <WorkID> --stage <stage|all>`を使用し、夢十夜（`000799`）→倫敦塔（`001076`）→趣味の遺伝（`001104`）の順に作品単位で処理する。
- F005は公開済みv0.4.0を固定baselineにし、`proofreader: null`、趣味の遺伝の固定raw/entity正規化、規約`decision: allow`、容量6区分をfail-closedで検証する。音声生成前はdisk-guardを再実行し、5 GiB未満の見込みなら開始しない。
- F005のブラウザ受入は既存Playwright設定のChromium・Firefox・WebKit・Pixel 7相当Chromium・Chrome stable・Edge stableの6自動環境を使用し、手動確認を必須証跡にしない。
- F006は汎用`content:batch`ではなく、`node --experimental-transform-types scripts/f006-{prepare-editorial,prepare-voice,content-preview,capacity-actual}.ts <WorkID>`のCLI引数化script群を作品単位で順次実行する（`content:batch`はF002〜F004専用のまま、F005以降の新規作者拡充では未使用）。山月記（`000624`）→名人伝（`000621`）→弟子（`001738`）の順に処理する。F005固有のnative guard/ETW機構は使わず、F002〜F004が使う汎用の共有受理pipeline(`src/content/batch-runtime.ts`・`batch-acceptance.ts`・`batch.ts`)と、F003型の薄い受入ラッパー(`src/content/f006-acceptance.ts`)を最大限再利用する。
- F006は公開済みv0.5.0を固定baselineにし、中島敦を5人目の作者として新規追加する（authorId`000119`、slug`nakajima-atsushi`）。対象3作品はいずれも校正者欄記載ありのため`proofreader: null`分岐は対象外、作品固有注記UIも対象外（QA-F006.md No.3/No.4確定）。音声生成前はdisk-guardを実行し、5 GiB未満の見込みなら開始しない。
- F006のブラウザ受入は既存Playwright設定の6自動環境を使用し、公開route集合はexact 8件（home・既存4作者・中島敦作者route・favorites・credits）となる。
- F007は`npm run build`→ `npm run test:e2e`は既存6環境のまま、F006確立済みのCLI引数化script群パターンを`f007-*.ts`命名で踏襲する（`node --experimental-transform-types scripts/f007-{prepare-editorial,prepare-voice,content-preview,capacity-actual}.ts <WorkID>`、薄い受入ラッパーは`src/content/f007-acceptance.ts`）。舞姫（`058126`）→高瀬舟（`045245`）→山椒大夫（`000689`）の順に処理する。
- F007は公開済みv0.6.0を固定baselineにし、森鴎外を6人目の作者として新規追加する（authorId`000129`、slug候補`mori-ogai`、QA-F007.md No.1/No.2で確定）。対象3作品はいずれも校正者欄記載ありのため`proofreader: null`分岐は対象外。舞姫の図書カード備考欄に公式表現注意があるため、F005確立済みの作品固有注記UI（FUN-F005-014）を舞姫にのみデータ駆動で再適用する（QA-F007.md No.4確定）。音声生成前はdisk-guardを実行し、5 GiB未満の見込みなら開始しない（2026-08-22時点でローカル空き35 GiB、実装着手前に`.cache/`の再取得可能データを整理済み）。
- F007のブラウザ受入は既存Playwright設定の6自動環境を使用し、公開route集合はexact 9件（home・既存5作者・森鴎外作者route・favorites・credits）となる。

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
