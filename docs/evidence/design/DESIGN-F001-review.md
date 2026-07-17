# F001 設計レビュー記録

## 結論

2026-07-18に`docs/design/FD-F001.md`と`docs/design/DD-F001.md`を3観点で再レビューし、すべてHigh 0件・Medium 0件でPASSした。設計はQ-003の承認ゲートへ進められる。

## レビュー結果

| 観点 | 最終判定 | 主な確認内容 |
|---|---|---|
| 整合性・網羅性 | PASS | REQ 30/30、REQ→DES表30/30、DES 19/19、DES→FUN表19/19、FUN 40、見出しタグと対応表の差分0件 |
| セキュリティ・法務 | PASS | 外部リンク境界、SSRF対策、Actions SHA固定、CSP、権利表示build gate、cache実体path検証 |
| 実現性 | PASS | 実機ブラウザ証跡、Shift_JIS decode、音声共有、CLI境界、pause/stop、更新順、Node固定、音声容量preflight |

## 反映した主要修正

- 青空文庫の実応答に合わせ、HTTP/meta/書誌charsetをnullableとし、存在値の全一致、採用優先順位、全欠落時の失敗を定義した。
- `RawCandidate`と`Candidate`、`content:extract`と`content:normalize`を分離した。
- `candidateId`を作品ID、raw source hash、token range、抽出器・正規化器版、正規化文hashから決定的に生成し、入力変更時の旧レビュー転用を拒否した。
- 公開資産pathと信頼済み外部リンクを型分離し、redirect・環境proxy・reparse pointを拒否する境界を定義した。
- GitHub Pagesのmeta CSPでは`frame-ancestors`を適用できない残余リスクと、実機ブラウザ証跡の担当・保存先を明記した。

## 検証

- `python tools/trace_check.py bungo-zundamon --feature F001`: REQ→DES、DES→FUNの欠落0件。DES→UT/ITの19件は次フェーズT-003で解消する。
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: 1ファイル、1テストPASS
- `npm run build`: PASS
- `npm audit --audit-level=high`: 脆弱性0件
