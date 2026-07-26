# F003 v0.3.0 リリース前総点検

- 判定: PASS
- 判定日時: 2026-07-26 22:15 JST
- リリース候補: `79d12825b83459b92da58e14a32f853bae6d92d9`
- バージョン: `0.3.0`
- 公開予定URL: https://iwatahiroki0827.github.io/bungo-zundamon/

## 候補内容

- 3作者・9作品・472台詞・音声463件
- F003追加: 太宰治「女生徒」「走れメロス」「グッド・バイ」259台詞・音声255件
- 収録作品は5 routeすべて初期open件数0
- 公開物: 495ファイル・164,314,350 bytes

## 自動検証

| 項目 | 結果 |
|---|---|
| lint / typecheck | PASS |
| Vitest | 49 files・855 tests PASS |
| Playwright | Chromium 21、Firefox 20+設計skip 1、WebKit 20+設計skip 1、Android相当 20+設計skip 1 |
| build / 全参照 / 容量 | PASS |
| 依存脆弱性 | High/Critical 0 |
| セキュリティ | CSP、外部request、危険DOM sink、storage/form、secret、workflow違反すべて0 |
| trace_check | 対応漏れ0 |
| 独立レビュー | High/Medium/Low 0 |

## exact証跡

- RuntimeAcceptance artifact SHA-256: `8d75d8891f09ee7ab9a2d884dc97e90776c03d64c6b3a3f15e63bd9afab492e6`
- RuntimeAcceptance evidence SHA-256: `eda9df8ab3990148da4d05fb1b7715690a7e38556bb9a5ac2aa5f7f2d2042e7f`
- content tree SHA-256: `cd92007ecdddaa0a4c2b3ec28fac07650cc42c17fa23a9ab77bc6ce5062410ea`
- dist SHA-256: `c1656d8e5514ee151310109cbc6601af4515ce47ca8b214bf3a83a9aa5c3c5a6`
- catalog SHA-256: `591b127e62e4c7686f3a47dc1476426185fe0c825e9092af892cd00e62d97769`
- hosted run: `30203430053`（success、feature deploy skip）
- hosted artifact: `8632356401`
- hosted artifact digest: `sha256:609b66553fb0ec444e1b4a4d5b27a516e5425bc638d44c206dc3110283800e6e`
- hosted artifact内catalog SHA-256: `591b127e62e4c7686f3a47dc1476426185fe0c825e9092af892cd00e62d97769`

## 公開方法とrollback

- `PAGES_DEPLOY_ENABLED=true`と`PAGES_DEPLOY_COMMIT=79d12825b83459b92da58e14a32f853bae6d92d9`を設定し、同じSHAだけをmainへfast-forwardする。
- deploy完了または失敗後は`PAGES_DEPLOY_ENABLED=false`へ戻し、`PAGES_DEPLOY_COMMIT`を削除する。
- 公開5 route、catalog、画像、音声Range、初期全閉を自動スモークする。
- 異常時は同じ承認SHA拘束を使って`v0.2.1`（`7adcf32c93a126b0703ba02d9ecd010e1ce508f5`）を再デプロイする。

手動・物理実機・目視・聴取は、承認済み仕様により必須判定に含めない。
