# 権利条件 再確認記録 2026-08-13

`content/licenses.json` の `terms.validUntil` が **2026-08-18T07:25:00Z** で失効するため、
失効前に規約本体を再取得して、manifestの主張が現在も成立するかを確認した。

## 確認者・方法

- 実施日: 2026-08-13
- 実施者: Claude Code（自動取得）。人によるレビュー承認は未取得。
- 方法: 規約ページ本文を実際に取得し、manifestの各主張と突き合わせた。推測は行わず、
  記載のない項目は「記載なし」として扱った。

## 確認結果

### 1. 東北ずん子・ずんだもん利用ガイドライン（`https://zunko.jp/guideline.html`）

| manifestの主張 | 規約側の記述 | 判定 |
| --- | --- | --- |
| 非営利ファンサイトとしての利用 | 二次創作（非営利）は事前申請不要、特別な禁止事項を除き制限なし | 成立 |
| `commercial.free: true` / `advertising: false` / `payments: false` | 個人のBlog・動画への広告程度は非商用の範囲。企業スポンサー案件は有償利用で要問合せ | 成立（本サイトは広告・課金なしで、より厳しい側） |
| `jurisdictionBasis: "JP"` | 「本規約の解釈及び適用は、日本法に準拠する」 | 成立 |
| `notices.unofficial`（非公式である旨の明示） | 明示要求の記載なし（ロゴ使用は推奨） | 成立（自主的な上乗せ表示） |

規約ページに改定日・バージョン表記は見当たらなかった。

### 2. VOICEVOX 利用規約（`https://voicevox.hiroshiba.jp/term/`）

| manifestの主張 | 規約側の記述 | 判定 |
| --- | --- | --- |
| `notices.voicevox: "VOICEVOX:ずんだもん"` | 「VOICEVOXを利用したことがわかるクレジット表記が必要」。正確な表記形式の指定は記載なし | 成立（慣行的表記で要件を満たす） |
| 商用・非商用の別 | 「商用・非商用問わず利用することができます」。条件差の記載なし | 成立 |
| キャラクター個別規約への従属 | 「各音声ライブラリの規約に従ってください」 | 上記1で確認済み |

規約ページに改定日・バージョン表記は見当たらなかった。

## 結論

manifestが主張する権利条件は、2026-08-13時点の両規約と矛盾しない。
`checkedAt` を 2026-08-13、`validUntil` を 2026-09-13（従来と同じ1か月周期）へ
更新する根拠が揃った。

## 反映が未実施である理由

日付2値の更新であっても、`content/licenses.json` は次の全てとハッシュ整合が取られている。

- `public/content/licenses.json`（公開成果物）
- `content/asset-manifest.json`
- `content/baselines/F001-v0.1.0.json`、`content/baselines/F002-v0.2.0.json`
- `content/batches/F003/work-artifacts/*/baseline-{content,dist}.json`

このうち `content/baselines/F00x-v*.json` は各リリース時点の公開内容を固定した
**履歴記録**であり、書き換えるとリリース履歴を改竄することになる。したがって
公開物の変更は既存baselineの書き換えではなく、**新しいパッチリリース（v0.4.1相当）**
として新規baselineを作る経路でのみ正当に反映できる。

手編集で `content/` と `public/` を直接書き換えた場合、`asset-integrity`・
`verify-project` baseline preflight・`published-baseline` ほかが失敗することを実測で確認した。

## 必要な対応（オーナー判断）

1. v0.4.1パッチリリースとして最終統合を実行し、`public/` と新規baselineを再生成する。
2. リリース判定（承認ゲート④）を経て、`PAGES_DEPLOY_ENABLED` / `PAGES_DEPLOY_COMMIT`
   を設定してデプロイする。この2変数はオーナーのみが設定できるため自動実行していない。
3. 期限は **2026-08-18**。超過すると `renderCreditsV2` が `CREDITS_POLICY_STALE` で
   fail-closedになる。

なお本記録の内容は人によるレビュー承認を経ていない。リリース時に
`terms.reviewer` の意味づけ（自動確認か人手確認か）を確定すること。
