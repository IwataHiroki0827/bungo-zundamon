# F004 v0.4.0 リリース前総点検

- 判定: PASS
- 判定日時: 2026-07-29 04:00 JST
- リリース候補: `f0a2c91effd17d1fcf75a578dad2c562ba7949c2`
- バージョン: `0.4.0`
- 公開予定URL: https://iwatahiroki0827.github.io/bungo-zundamon/

## 候補内容

- 3作者・12作品・674台詞・音声662件
- F004追加: 宮沢賢治「オツベルと象」「雪渡り」「カイロ団長」202台詞・音声199件
- 全公開台詞を対象とする端末内お気に入りと作者横断のお気に入りroute
- 公開6 routeの収録作品は初期open件数0
- 公開物: 697ファイル・229,935,951 bytes

## 自動検証

| 項目 | 結果 |
|---|---|
| lint / typecheck | PASS |
| Vitest | 58 files・935 tests PASS |
| Playwright | Chromium 24、Firefox 23+設計skip 1、WebKit 23+設計skip 1、Android相当 23+設計skip 1 |
| build / 全参照 / 容量 | PASS |
| 依存脆弱性 | 全重大度0 |
| セキュリティ | CSP、外部request、危険DOM sink、storage/form、secret、workflow違反すべて0 |
| trace_check | 対応漏れ0 |
| 独立受入 | High/Medium/Low 0 |
| 権利再確認 | 青空文庫の対象3作品に変更なし |

## exact証跡

- content tree SHA-256: `38fd2142b2c9da5a727d400b0858b0de4e426b05365f5e3bf877a6e764a5ec81`
- dist SHA-256: `c542f435f0adb27cd253788680b58baf102f61fbec33a91d73087bb07d40b8b9`
- catalog SHA-256: `857401c774ed8dabaaf0e67d8f3e5f710a83fa1fefcd9965498590aab629f6e5`
- 最終統合report SHA-256: `c9d9322530b8f87f32eef568a9c89107510776648b381665700c7917bcbc0c99`
- 権利証跡SHA-256: `bf0bc6cab0e768bdea2beb8959526d4ee70241987d916495f927e2ae581ac06e`
- 容量証跡SHA-256: `b38adf285625fbcae41ac9b9161b6be41efd5db2181423d51c9f62a175710d65`
- hosted run: `30389830098`（success、feature deploy skip）
- hosted artifact: `8700513876`
- hosted artifact digest: `sha256:6c226095f2f2a8649ca3c796c749e0e9bc3fd11b687ec048296f737ad2854743`

## リトライ記録

- run `30389402605`: 公開tree拡大後、既存baseline試験が固定5秒を超えてtimeout。検査内容は変えず上限を30秒へ調整し、ローカル3連続とhosted run `30389830098`でPASSした。
- run `30388296946`: 旧publicのままの候補をdeployしたため公開smokeで未反映を検出。旧v0.3.0は正常維持され、F004 treeをatomic昇格した本候補へ差し替えた。

## 公開方法とrollback

- `PAGES_DEPLOY_ENABLED=true`と`PAGES_DEPLOY_COMMIT=f0a2c91effd17d1fcf75a578dad2c562ba7949c2`を設定し、同じSHAだけをmainへfast-forwardする。
- deploy完了または失敗後は`PAGES_DEPLOY_ENABLED=false`へ戻し、`PAGES_DEPLOY_COMMIT`を削除する。
- 公開6 route、Catalog、画像、音声Range、初期全閉、お気に入りの登録・再読込・解除、CSP・外部通信を隔離browser contextで自動スモークする。
- 異常時は固定済みv0.3.0 release commit `79d12825b83459b92da58e14a32f853bae6d92d9`へ戻す。

手動・物理実機・目視・聴取は、承認済み仕様により必須判定に含めない。
