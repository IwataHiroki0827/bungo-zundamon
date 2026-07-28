# QT-F004 実施結果

- 実施日: 2026-07-29
- 対象候補コミット: `8fe2538ffeb2c322b3519249b962cc7202546679`
- 判定: **QT-F004-001〜016 PASS**
- 仕様ID照合: 16/16件対応、未対応0件、余剰0件
- 手動確認: 必須証跡に含めない

## exact候補

| 項目 | 実測 |
|---|---|
| Catalog | 3作者 / 12作品 / 674台詞 / 662音声 |
| F004追記 | 宮沢賢治3作品 / 202台詞 / 199音声 |
| content | 694 files / `38fd2142b2c9da5a727d400b0858b0de4e426b05365f5e3bf877a6e764a5ec81` |
| dist | 697 files / `c542f435f0adb27cd253788680b58baf102f61fbec33a91d73087bb07d40b8b9` |
| Catalog | `857401c774ed8dabaaf0e67d8f3e5f710a83fa1fefcd9965498590aab629f6e5` |
| final integration report | PASS / `bc0d6912901f586fc41c89ccda02ddaaec800c26c41cd571a48ee41d29edaebd` |
| 公開領域 | tracked `public`変更0件 |

## 公開前ゲート

| ゲート | 結果 | 実測 |
|---|---|---|
| 権利predeploy | PASS | 対象3作品の著作権なし、役割=著者、翻訳者なし、公開中、新字新仮名、ID・URLが全件unchanged |
| 公式書誌 | PASS | 最新CSV SHA-256 `2f3962dd396e0375327e32501929ebe6be3dc9d347f74558c511b097120d7adb` |
| F004追加音声 | PASS | 199 files / 65,195,572 bytes、上限104,857,600 bytes |
| Pages候補 | PASS | 697 files / 229,935,951 bytes、停止上限786,432,000 bytes |
| Git repository | PASS | 264,141,895 bytes、停止上限1,000,000,000 bytes |
| 最大Git object | PASS | 17,156,699 bytes、上限104,857,600 bytes未満 |
| 作業drive | PASS | 空き67,183,439,872 bytes、必要461,277,213 bytes |
| 依存監査 | PASS | Critical/High/Moderate/Low 0 |
| 4ブラウザ | PASS | 93 pass / 3意図的skip / 0 fail / flaky 0 |
| 全回帰 | PASS | 169 suites / 935 tests、失敗0、skip 0 |

権利証跡は`QT-F004-rights-predeploy.json`、容量証跡は`QT-F004-capacity-actual.json`、セキュリティ集約は`QT-F004-security.json`に保存した。青空文庫の全作品CSVは選定時から更新されていたが、対象3作品の権利行は全項目一致した。全体CSVの更新だけで対象作品の変更と誤判定せず、新旧CSV hashを証跡に残す回帰試験を追加した。

F004固定baseline、編集、音声、atomic受入、FinalCatalog、画像再利用、初期全閉、お気に入り、音声隔離、4ブラウザ、権利、容量、セキュリティが同一dist候補へ結合しているため、QT-F004-001〜016をPASSと判定する。公開はT-061のリリース前総点検と段階公開で実施する。
