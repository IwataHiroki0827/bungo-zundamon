# T-038 太宰治画像・作品注意・権利表示 実装証跡

## 判定

- タスク: T-038（太宰治画像・未完/公式注意・権利表示を整備）
- 対象feature / batch: F003 / F003
- 実装判定: PASS
- 独立受け入れ判定: ACCEPT
- 最終指摘: High 0件 / Medium 0件 / Low 0件
- 判定日: 2026-07-26

## 実装範囲

- `FUN-F003-022`: 太宰治ずんだもんの独自生成PNGをF003の追跡対象正本として固定した。
- `FUN-F003-023`: 女生徒とグッド・バイの公式内容注意、グッド・バイの未完状態、全3作品の括弧発話抜粋scopeを固定registryへ記録した。
- `FUN-F003-024`: 入力画像0件、生成prompt・recipe、provider terms、ずんだもんガイドライン判断、machine review、画像実体を一つのhash chainへ結合した。
- Catalog V2へ任意の`completionStatus`と`notices`を追加し、作品一覧、作品詳細、クレジットの3配置へ固定文言をtext nodeで描画した。
- 作者route遷移・直アクセス・再読込時を含め、すべての収録作品パネルが閉じた状態で開始する回帰試験を追加した。

## 信頼境界

- 作品注意registryは`content/batches/F003/work-notices.json`のcanonical SHA-256とmodule-owned公式source factsへ固定し、callerがregistryとsource factsを同時に偽造する経路を除去した。
- 作品注意loaderは絶対workspace、workspace境界、reparse point、通常file、canonical JSON、固定SHA-256を検証する。
- 画像machine reviewはProjectFactory固定のmanifest identity、coordinator record path / SHA-256、record内部hash chainを検証してから、module-local `WeakSet`で信頼済みobjectを識別する。
- callerがtask / run / machine review / record hashを同時に作り直しても、固定bindingと信頼済みobjectを再現できない。
- ArtworkProvenanceV3でもprovider termsとずんだもんキャラクターガイドラインの判断・観測情報を共通検証する。

## 画像正本

- path: `content/batches/F003/public-files/artwork/dazai-zundamon.png`
- SHA-256: `c58b3233decc0b485f938c2d9f73dd16ade06d546ac72ad429fe86bbd22d31b6`
- bytes: 2,960,855
- 画像寸法: 1,254 × 1,254
- 生成方式: OpenAI built-in image_gen、入力・参照画像0件

## 検証結果

- T-038対象試験: 168 / 168 PASS
- 全Vitest suite: 43 files / 795 tests PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS（229 files / 81,725,249 bytes）
- `trace_check --feature F003`: 対応漏れなし
- `git diff --check`: PASS
- 独立T-038再受け入れ: ACCEPT（High 0 / Medium 0 / Low 0）
- 前回の作品注意共同偽造: `WORK_NOTICE_PROVENANCE_MISMATCH`で拒否
- 前回のmachine review共同偽造: `ARTWORK_REVIEW_MISSING`で拒否

## 次工程の容量ガード

- C:空き: 37.19 GB（4.0%）
- 判定: 10%未満のため逼迫。5 GB未満の危険域ではない。
- 対応: T-039以降は作品単位、同時生成1、生成前後の空き容量・forecast・実測容量照合を必須とし、無関係なファイル削除は行わない。
