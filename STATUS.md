---
phase: implement
feature: F005
updated: 2026-07-29T12:59:43+09:00
next_actions:
  - "T-070で夢十夜の全候補レビュー・差分音声・作品単位atomic受入を実施する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0、F003はv0.3.0、F004はv0.4.0としてGitHub Pagesへ公開済み。公開サイトは3作者・12作品・674台詞・662音声で安定稼働中。
- 収録作品は作者ページを描画するたびに全件閉じた状態から開始し、ページ遷移後に戻った場合も閉じる回帰試験がPASSしている。
- F003は太宰治「女生徒」「走れメロス」「グッド・バイ」を小さい作業単位から順に追加する。
- SRS/FD/DD/QTに加えてUT-F003・IT-F003もApproved。ゲート①〜③を通過した。
- T-037で候補・原典・独立二重レビュー契約、T-038で太宰治画像・作品注意・provenance chainを実装済み。
- T-039で「女生徒」47候補を31承認・16除外・保留0へ確定し、31候補を30 WAV（6,204,200 bytes）へ対応して作品単位で`accepted`へ昇格した。
- T-040で「走れメロス」62候補を全件承認し、61 WAV（24,692,348 bytes）へ対応して作品単位で`accepted`へ昇格した。
- T-041で「グッド・バイ」173候補を166承認・7除外・保留0へ確定し、165音声参照（新規164 WAV、先行作品共有1）へ対応して作品単位で`accepted`へ昇格した。
- CHG-F003-002で固定v0.2.0 published baselineを作品受入・最終統合・dist・release verificationへ結合し、既存作者entryをcanonical exactで保護した。
- 永続証跡のpathはworkspace相対POSIXへ固定し、filesystem API直前だけ絶対解決する。危険path、secret、reparse point、既存`public`差分はいずれも0件。
- T-042で固定F001・固定v0.2.0 F002・accepted F003を最終統合し、3作者・9作品・472台詞・463音声・492ファイルを確認した。
- T-043でVitest 853件、typecheck、lint、495ファイルのbuild、依存監査、4環境81件をPASSした。3件のskipはChromiumで実施した全asset照合の重複省略である。
- RuntimeAcceptance schema 1.1へclean commit、test source、4ブラウザ生レポート、public、distをhash結合し、独立再受入High/Medium/Low 0件でPASSした。
- v0.3.0はActions run 30203760729で段階公開し、公開5 route、初期全閉、画像、音声Range、CSP・外部通信を自動スモークしてPASSした。
- F003 manifestは実公開3証跡のexact tupleで`published`へ遷移し、公開後状態の全857試験・lint・typecheck・build・trace_checkをPASSした。
- F004は宮沢賢治へ「オツベルと象」「雪渡り」「カイロ団長」を追加し、台詞を端末内へ保存して作者横断で見返せるお気に入りを提供する。CHG-F004-001でREQ 21件・QT 16件へ更新し、直接要望と包括承認をQ-023へ記録した。
- T-050でT-051〜T-062へWBS分解し、既存CLI・Playwright・VOICEVOXを再利用、追加MCP不要と判定した。
- T-051/T-052でFD-F004のDES 13件、DD-F004のFUN 37件を作成した。固定v0.3.0二重baseline、同一作者reuse、端末内お気に入り、generic batch、preview/final型分離、公開後rollbackを定義し、3観点の最終独立レビューHigh/Medium/Low 0、ゲート②承認を完了した。
- T-053でUT-F004 37件、IT-F004 15件を作成し、QT-F004 16件と合わせて全REQ/DES/FUNを網羅した。網羅性・試験設計・CHG-F004-002のセキュリティ再レビューは最終High/Medium/Low 0、trace_check 100%である。
- Q-025へ包括承認を記録してテストファーストゲート③を通過した。F004はimplementへ移行した。
- T-054でcanonical definition/policy・ApprovedBatchContext・固定v0.3.0二重baselineを実装した。宮沢賢治3作品のexact tuple、公開Catalog identity、selection/predeploy権利再検証、production transport取得、3 XHTML atomic固定を全880試験と独立受入でPASSし、T-055を開始した。
- T-055でF003新規作者/F004既存作者追記の共通Catalog projector、preview/final brand、canonical manifest/source/audio join、既存宮沢画像のexact再利用、実public/dist非破壊previewを実装した。全893試験と独立受入をPASSし、T-062のお気に入り実装を開始した。
- T-062で全公開台詞のお気に入り切替、固定key/version/上限付き端末内保存、storage障害時のmemory縮退、共有FavoriteController、`#/favorites`、元作品へのone-shot移動を実装した。全918試験、495ファイルbuild、独立受入High/Medium/Low 0をPASSした。
- T-056で「オツベルと象」46候補を独立二重レビューと第三裁定により44採用・2除外・保留0へ確定した。43 WAV・9,322,340 bytesを生成し、journal付きatomic受入で`000466=accepted`へ昇格した。全930試験と独立受入をPASSし、public差分0を確認した。
- T-057で「雪渡り」64候補を独立二重レビューと第三裁定により59採用・5除外・保留0へ確定した。59 WAV・23,448,100 bytesを生成し、先行`000466=accepted`を含むpreviewとjournal付きatomic受入で`045679=accepted`へ昇格した。全930試験、型、lint、495ファイルbuild、独立受入をPASSし、public差分0を確認した。
- T-058で「カイロ団長」102候補を独立二重レビューと第三裁定により99採用・3除外・保留0へ確定した。99台詞を97 WAV・32,425,132 bytesへ結合し、全3作品を含む694ファイルpreviewとjournal付きatomic受入で`001918=accepted`へ昇格した。全930試験と独立受入をPASSし、public差分0を確認した。
- T-059で全3作品をFinalCatalogへ統合し、3作者・12作品・674台詞・662音声、694 contentファイル、697 distファイルを再現した。宮沢作品順、固定v0.3.0既存projection、全asset、既存画像reuse新規0、public差分0を確認し、全931試験と独立受入High/Medium/Low 0をPASSした。
- T-060でUT 169 suites/935 tests、F004結合47 suites/252 tests、4環境93 pass・意図的skip 3・fail 0を完了した。最新公式書誌で対象3作品の権利unchanged、追加音声65,195,572 bytes、Pages候補229,935,951 bytes、Git 264,141,895 bytes、依存脆弱性0を同一exact候補へ結合し、trace漏れ0・public差分0・独立受入High/Medium/Low 0をPASSした。
- CHG-F004-001/002は要求承認、設計・試験仕様再レビュー、実装、T-060影響試験がすべて完了したため`done`へ閉じた。
- T-061でcommit `f0a2c91`をActions run `30390224028`により段階公開した。公開6 route、初期open 0、お気に入り、Catalog、画像、音声Range、CSP・外部通信を自動スモークしてPASSし、デプロイ変数無効化、F004 manifestの`published`遷移、`v0.4.0` tagを完了した。公開後管理回帰を含む全936試験もPASSした。
- T-063で知名度順の次作者を夏目漱石（人物ID`000148`）とし、「夢十夜」「倫敦塔」「趣味の遺伝」を確定した。REQ 18件・QT 15件はQA未回答0、独立レビューHigh/Medium/Low 0、REQ→QT欠落0である。校正者欄なしの`null`、XHTML entity正規化、公式表現注意、規約fail-closed、容量6区分、追加作者10人の順位式まで固定し、Q-027の包括承認でゲート①を通過した。
- T-064でF005をT-065〜T-075の11タスクへ分解し、REQ 18/18のWBS coverageと依存循環0を確認した。既存CLI、VOICEVOX 0.25.2、Playwright 6環境を再利用し追加MCPは不要である。typecheck・lint・Vitest 936件・697ファイルbuild・audit 0件をPASSした。C:空き56.58 GiBは空き率6.1%の警告域だが、F005の5 GiB停止基準と安全側69.23 MiB追加予測には十分であり、音声生成前に再確認する。
- T-065/T-066でFD-F005のDES 13件、DD-F005のFUN 48件を作成した。requirement approval snapshot、ETW正本容量監視、registry三段階migration、nullable書誌、原典・画像・path防御を固定し、独立3観点レビューHigh/Medium/Low 0、Q-032の包括承認でゲート②を通過した。traceの残り13件はT-067で作るUT/ITだけである。
- T-067でUT-F005 48件、IT-F005 15件を作成した。セキュリティ境界subcaseと15件の有限fault matrixを追加し、REQ 18・DES 13・FUN 48・QT 20をcoverage 100%で網羅した。独立3観点レビューHigh/Medium/Low 0、Q-033の包括承認でテストファーストゲート③を通過した。
- T-068でF005候補、固定v0.4.0 baseline、Git全object容量inventory、3規約原文のfail-closed評価、XHTML entity正規化、固定SHAのWindows native handle guardを実装した。共有registryは実装`ffdb47f`、移行証跡`3a5620f`、loader受入`0c4c5ba`の3段階で固定し、production controlのGit object再計算、全62 files・1053 tests、修正後重点5 files・131 tests、型・lint・697 files build、独立受入High/Medium/Low 0をPASSした。
- T-069で`proofreader: null`をF005「夢十夜」だけに限定してCatalog/UI/creditsへ「記載なし」で統合した。mint済みfinal Catalog、独自生成した夏目漱石画像とcanonical provenance、exact 7 route、通常入口全閉・お気に入りone-shot展開・自動再生0を実装した。全65 files・1105 tests、重点310 tests、型・lint・697 files build、audit 0、独立受入High/Medium/Low 0をPASSし、public差分0を確認した。

## 直近の作業（最新5件）

- T-069でnullable書誌・夏目Catalog・独自画像・7 route・お気に入り統合を実装し、全1105試験・独立受入を完了
- T-068でF005基盤とnative path guardを実装し、registry三段階migration・全1053試験・独立受入を完了
- T-067でUT 48件・IT 15件と境界subcase/fault matrixを確定し、coverage 100%・ゲート③承認を完了
- T-065/T-066でF005設計をDES 13件・FUN 48件へ展開し、独立3観点レビューPASS・ゲート②承認を完了
- T-064でF005を11タスクへ分解し、REQ 18/18、既存環境、936試験、build、依存監査を確認

## 次のアクション

- T-070で「夢十夜」の全候補レビュー、差分音声生成、作品単位atomic受入を実施する。

## 未解決事項

- C:の空きはT-069完了時実測で46,142,918,656 bytes（42.97 GiB）。安全側追加音声予測72,589,906 bytesと5 GiB停止基準に十分な余裕があり、T-070の音声生成直前に再計測する。
