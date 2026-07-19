# F002 環境整備証跡

## 判定

- フェーズ: setup
- 判定: PASS
- 実施日: 2026-07-20
- 入力: Approvedの`SRS-F002.md`、`QT-F002.md`
- 次フェーズ: design

## WBS

`tasks.yaml`へT-016〜T-030の15タスクを追加した。

| 範囲 | 内容 | 実行形態 |
|---|---|---|
| T-016〜T-017 | FD/DD作成 | advisor |
| T-018 | UT/IT仕様とQT網羅性 | orchestration |
| T-019〜T-023 | 複数作者基盤、UI、権利、容量・セキュリティ | orchestration 4件、advisor 1件 |
| T-024〜T-026 | 3作品を小さい順に全件レビュー・音声生成・作品単位受入 | orchestration |
| T-027 | F002最終統合とF001不変確認 | advisor |
| T-028〜T-029 | UT、IT/QT/実音声/ブラウザ/権利受入 | orchestration |
| T-030 | リリース総点検・承認・公開後スモーク | advisor |

全REQ-F002-001〜020を設計、試験仕様、試験、リリースへ割り当て、実装タスクにも各REQを1件以上割り当てた。作品タスクは「よだかの星」→「どんぐりと山猫」→「注文の多い料理店」の直列依存とした。

## 実行環境

| 項目 | 確認結果 |
|---|---|
| Node.js | `v24.11.0` |
| npm | `11.6.1` |
| 作業ドライブ | 空き116,553,502,720 bytes（11.67%）、setup時点GO |
| VOICEVOX | 本体・ENGINE導入済み。setup時点では未起動。音声生成時にloopback限定で非表示起動する |
| Playwright | npm依存・設定・既存E2Eあり。新規MCP不要 |
| Codex MCP | 登録0件。F002に追加必須MCPなし |

VOICEVOX生成前はENGINE `0.25.2`、speaker UUID `388f246b-8c41-4ac1-8e2d-5d79f3ff56d9`、style ID `3`、style名`ノーマル`を実API応答と照合する。値が異なる場合は生成前に停止し、設計・規約・生成証跡を再確認する。

## スキル・エージェント判断

- ProjectFactory標準の`pf-worker`、`pf-reviewer`、`pf-acceptor`で実行できるため、新規専用agentは作成しない。
- 既存content pipelineを汎用batch CLIへ拡張するため、子プロジェクト固有skillは新設しない。継続投入契約はCLI、schema、`CLAUDE.md`へ集約する。
- 宮沢賢治の作者画像作成時だけ共有`imagegen` skillを使用し、生成入力・出力hash・利用条件をT-023の証跡へ残す。

## 検証コマンド

現時点で利用できる基準検証は次のとおり。

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm audit --audit-level=high
```

F002実装では、既存の段階別`content:*`コマンドを、`--batch F002 --stage <stage>`で後続フィーチャーにも再利用できる契約へ統合する。容量コマンドは新規WAV、最終Pages artifact、Git object storeを別々に測定し、SRS-F002の境界値を返す。

## baseline検証

2026-07-20にF002コード変更前の基準を検証した。

- typecheck: PASS
- lint: PASS
- Vitest: 19 files / 337 tests PASS
- offline build: PASS
- build verification: 66 files / 30,403,023 bytes

## 実装前リスク

- 現行実装は人物ID、作者slug、3作品、59台詞、F001 cache・証跡・公開pathを複数箇所で固定している。
- active batchだけで公開treeを作り直すとF001 assetを欠損させる危険があるため、T-020/T-027で基準releaseとの項目・asset hash比較を必須にする。
- 現行容量検査は追加WAV、Pages artifact、Git履歴を分離していないためT-022で置換する。
- 約168候補は件数上限で省略せず、作品単位で`pending: 0`を確認してから次作品へ進める。
- 音声生成前に作業ドライブ、追加WAV見込、公開総量、Git object見込を再計測する。
