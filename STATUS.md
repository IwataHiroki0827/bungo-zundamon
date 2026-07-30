---
phase: implement
feature: F005
updated: 2026-07-30T16:23:00+09:00
next_actions:
  - "CHG-F005-027でbound active lease中directory writeを固定13 stageへ接続し、独立レビュー後にhosted productionを継続する"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0、F003はv0.3.0、F004はv0.4.0としてGitHub Pagesへ公開済み。公開サイトは3作者・12作品・674台詞・662音声で安定稼働中。
- F005は公開前の非公開候補生成を継続中で、公開サイト・`public/`・`data/`は変更していない。
- CHG-F005-009でnative executableをworkspace外のGUID付きRUNNER_TEMPへ隔離し、全起動経路のrealpath/reparse/hardlink/SHA/self hash検証を実装した。run 30508494379では外部binary使用を確認したが、write helper spawn後・予約前のworkspace System SetInfoで安全停止した。
- CHG-F005-010で全native tooling processのcwdもexternal executable parentへ隔離し、path非公開のhello booleanで実processのcwd一致を全client/buildへ必須化した。対象124件、native規則37件、型、ESLint、再現build、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30509193028でも同じunknown System SetInfoで安全停止したため、CHG-F005-011でraw pathを出さないtop-level/extension/実体/leaseの固定bucket診断を追加した。対象124件、native規則40件、型、ESLint、再現build、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30510118610は固定bucket判定を通過し、予約済みwrite path認識後の相関不一致で安全停止した。CHG-F005-012でraw値を出さない固定12段階の相関診断を追加し、対象124件、native規則40件、型、ESLint、再現build、trace、独立レビューHigh/Medium/Low 0をPASSした。認可・容量・候補保存条件は変更していない。
- run 30510939972は`wav-validated`後の`CACHE_WAV_FILE_NO_LEASE`で安全停止した。CHG-F005-013で同一voice phaseの完了済みwriteとのidentity関係を固定3状態へ細分化し、対象124件、native規則52件、型、ESLint、再現build、trace、独立レビューHigh/Medium/Low 0をPASSした。認可・容量・候補保存条件は変更していない。
- run 30511757503は`CACHE_WAV_FILE_DONE_ID`で安全停止し、完了済みWAVと同一native identityの遅延System SetInfoであることを確認した。CHG-F005-014でSystem PID/SetInfo/同一phase/path/identity/予約後からwrite完了までのQPC/互換FileObject bindingの完全一致時だけ元worker世代へ再結合し、対象124件、native規則64件、型、ESLint、再現build、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30513249202は`LEASE_CLOSED`で安全停止した。active leaseのclosed判定がpath/phase/QPC tupleより先行していたため、CHG-F005-015でtuple一致後だけclosedを評価し、別path遅延eventを完了write fallbackへ流す。対象124件、native規則66件、型、ESLint、再現build、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30513755494はclosed lease誤分類を除いた後も`CACHE_WAV_FILE_DONE_ID`で安全停止した。CHG-F005-016で完了write再結合の不一致条件をraw値なしの固定10 stageへ分類した。対象124件、native規則76件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSし、認可条件は変更していない。
- run 30514533508は`F005_ETW_COMPLETED_WRITE_REJOIN_AFTER_COMPLETION`で安全停止し、同一WAV・同一identityのSystem SetInfoがwrite完了QPC後であることを確認した。CHG-F005-016/T-090は目的を達成して`done`とした。CHG-F005-017で認可を変えず時間差を固定5 bucketへ細分化し、対象124件、native規則84件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30515251601は`F005_ETW_COMPLETED_WRITE_REJOIN_AFTER_COMPLETION_WITHIN_500MS`で安全停止し、完了後時間差が100ms超500ms以内と確認した。CHG-F005-017/T-091は目的を達成して`done`とした。CHG-F005-018で全完全tuple条件を維持した500ms上限だけを限定拡張し、対象124件、native規則90件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30516000235は500ms限定再結合後も`F005_ETW_COMPLETED_WRITE_REJOIN_AFTER_COMPLETION_WITHIN_2S`で安全停止し、hosted schedulingにより500ms超2秒以内となる場合を確認した。CHG-F005-018/T-092は`done`とした。CHG-F005-019で全完全tuple条件を維持した2秒上限へ限定拡張し、対象124件、native規則90件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30516456345は完了writeの2秒限定再結合を通過後、現在のactive leaseに一致するSystem SetInfoを`LEASE_CLOSED`で安全停止した。CHG-F005-019/T-093は`done`とした。CHG-F005-020でclosed leaseのsnapshot・binding・current identityを固定5 stageへ分類し、対象124件、native規則95件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30517281377は`F005_ETW_CLOSED_LEASE_REJOIN_CANDIDATE`で安全停止し、snapshot・binding・current identityの全安全候補条件一致を確認した。CHG-F005-020/T-094は`done`とした。CHG-F005-021で完全候補だけをidentity二重照合付きで元worker世代へ再結合し、対象124件、native規則95件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30517951376はclosed lease限定再結合を通過後、`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH`で安全停止した。CHG-F005-021/T-095は`done`とした。CHG-F005-022で認可を変えず、FileObject、active lease snapshot/current identity、open/closed、完了write関係を固定10 stageへ細分化した。native規則105件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30518908190は`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_OTHER_KNOWN_PATH`で安全停止した。CHG-F005-022/T-096は`done`とした。CHG-F005-023で認可を変えず、その他既知pathをtop-level・拡張子・実体種別・lease状態の固定bucketへ細分化した。native規則105件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30519553414は`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_CACHE_OTHER_DIRECTORY_NO_LEASE`で安全停止した。CHG-F005-023/T-097は`done`とした。CHG-F005-024で認可を変えず、snapshot/current identity・同一phase root owner・root activeを固定6 stageへ細分化した。native規則111件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30520302499は`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_WRITE_REJOIN_CANDIDATE`で安全停止し、cache directoryの同一identity・同一phase root owner・root activeを確認した。CHG-F005-024/T-098は`done`とした。CHG-F005-025で完全候補だけをroot世代へidentity二重照合付きで再結合し、native規則123件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30520947829はleaseなしdirectory write限定再結合を通過後、`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_CACHE_OTHER_DIRECTORY_UNBOUND_LEASE`で安全停止した。CHG-F005-025/T-099は`done`とした。CHG-F005-026で認可を変えず、directory候補を先行判定してactive leaseのphase・親path・binding・closed・Job escapeを固定13 stageへ細分化した。初回レビューのMedium 1件・Low 1件を段階returnと評価順試験で解消し、native規則136件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30522096558は同じdirectory writeがtiming差で`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_CACHE_OTHER_DIRECTORY_BOUND_LEASE`となり安全停止した。CHG-F005-026/T-100は`done`とした。CHG-F005-027で認可を変えず、exact bound bucketも既存の固定13 stage診断へ接続した。native規則136件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
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
- T-070は「夢十夜」65候補を独立二重レビューし、63採用・2除外・保留0、62音声、追加見積り12,521,800 bytesを確定した。保存selectionの再開検証、最新predeploy権利`allow`、planned audio込み容量予測、native ETW台帳、preview/受入証拠の意味結合に加え、production runnerを実装した。commit `7329f55`のclean HEADで実行し、Approved Context SHA照合を通過後、native ETW preflightが`F005_ETW_PRIVILEGE_REQUIRED`で音声生成前に安全停止した。
- CHG-F005-002で、closed容量actualを同一session内のaccept前に要求していた循環を、1作品1sessionのartifact stage→session close→actual→metadata finalizeへ分離した。native identity必須CAS、全transaction事前走査、phase別crash回復を実装し、重点180件・全1240件、型・lint・build・audit・公開tree不変、独立受入High/Medium/Low 0をPASSしてT-076と変更管理を完了した。
- CHG-F005-003/T-077でnative buildからcheckout絶対pathとGit commit SHAを排除し、固定binary SHA `1846897e...9813`へ統一した。local/source-only/hosted Windows build、全1241試験、独立再レビューをPASSし、Actions run `30445446783`で容量ABI v3とkernel FileIO ETW正常系を確認した。

## 直近の作業（最新5件）

- T-101/CHG-F005-027でbound active lease中directory writeを固定13 stageへ接続
- run 30522096558でCACHE_OTHER_DIRECTORY_BOUND_LEASEを安全停止し、候補・公開差分0
- T-100/CHG-F005-026でactive lease中System directory writeを固定13 stageへ細分化
- run 30520947829でCACHE_OTHER_DIRECTORY_UNBOUND_LEASEを安全停止し、候補・公開差分0
- T-099/CHG-F005-025でSystem directory write完全候補を限定再結合

## 次のアクション

- CHG-F005-027を検証・独立レビュー後にcommit/pushし、hosted Windowsのcommit固定・非公開候補workflowからproduction runnerを再実行する。
- bound active lease中directory writeが`LEASE_BOUND`固定stageで停止し、生値・候補・公開差分0を維持することをhosted証跡で確認する。

## 未解決事項

- C:空きは実preflight後28,600,225,792 bytes（26.64 GiB）で5 GiB停止基準を上回る。音声生成直前にもrunner内で再計測する。
- T-070 production runnerはkernel ETW preflight、VOICEVOX取得、完了writeの2秒再結合、closed lease完全候補再結合、leaseなしSystem directory write限定再結合までPASSしている。active lease中directory writeはunbound/boundのtiming variantがあり、CHG-F005-027で両方を固定stage診断へ接続してproductionを継続する必要がある。
