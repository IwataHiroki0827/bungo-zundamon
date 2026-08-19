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

## 追記 2026-08-20（`fix/v0.4.1-license-recheck` ブランチでの実測）

`content/licenses.json` の `terms.checkedAt`/`terms.validUntil` のみを本記録の結論通りに更新し、
`npm run lint` / `npm run typecheck` / `npm run build` / `npm run verify:build` / `npm test`
はすべてPASSすることを確認した（`src/notices/asset-integrity.test.ts` は `checkedAt` 更新に伴い
テスト内の固定基準時刻を合わせて更新した。`src/notices/notices.test.ts` の5件失敗は本変更と無関係の
既存不具合で、後述）。

一方で `public/content/licenses.json`（実際にサイトへ配信される版）は `npm run build`
（Vite）では再生成されない。`public/` 配下のファイルはVite buildが素通しでdistへコピーするだけで、
`content/licenses.json` から `public/content/licenses.json` へ変換するステップは
`scripts/content-cli.ts`（F001初期制作パイプライン専用）にも存在しない。

`public/content/licenses.json` と `content/asset-manifest.json` のhashを実際に手で同期させて
再ビルドしたところ、`F001_ASSET_HASH_MISMATCH` で `verify:build` が失敗することを実測した。
原因は `content/baselines/F001-v0.1.0.json`（F001リリース時点のhash固定記録）が
`content/licenses.json` のhashを**独立して**pinしているため。つまり `content/licenses.json` の
hashは最低でも次の2箇所に別々にpinされている:

- `content/asset-manifest.json`（現行buildの参照台帳）
- `content/baselines/F001-v0.1.0.json`（F001リリース時点の履歴記録、書き換え禁止）

したがって本記録が既に結論づけていた通り、`public/` への反映は既存baselineの書き換えでは正当化
できず、新しいパッチリリース（v0.4.1）としてリリース手順に沿った新規baseline生成が必要。
ただしそのリリース手順（新規baseline記述子の生成スクリプト）はリポジトリ内に汎用ツールとして
存在しない。`content/baselines/F00x-*.json` や `src/content/published-baseline.ts` /
`src/content/f004-baseline.ts` 内の pinned commit hash・catalog件数などの定数は、各機能の
`f00X-final-integration.ts`（F002/F003/F004それぞれのバッチ統合専用スクリプト、新規作品追加を
前提とした強い不変条件チェック付き）を実行して得られたリリースコミットのハッシュ値を、
実装者が後からソースコードへ手で書き込む形で成立している（記述子は自分自身を含むcommitを
参照するため、コミットが存在してから定数を確定させる、という手順がこれまでの実績）。
「作品追加を伴わない、ライセンス条項のみの軽量パッチリリース」向けの同種ツールは存在しないため、
自動生成は行わず、オーナー判断を仰ぐこととした。
