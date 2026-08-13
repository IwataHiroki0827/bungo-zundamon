---
phase: change
feature: F005
updated: 2026-08-13T17:10:00+09:00
next_actions:
  - "CHG-F005-071の決定的hosted相関suite（T-143相当）を追加し、directory binding状態の影響確認を配送順に依存せず行う"
  - "binding状態がLIVEなら、file leaseのFileObject一致でdirectory scope eventを評価している現在の評価順を是正する認可変更へ進む（オーナーの事前承認済み）"
  - "F005をmainへマージする前に、ubuntuで実行不能なnative guard依存テストのOS gateを決める"
  - "公開中のcontent/licenses.jsonはvalidUntil 2026-08-18で失効する。規約再確認はdocs/evidence/rights/rights-recheck-2026-08-13.mdで完了済みで、反映にはv0.4.1パッチリリースが必要"
  - "F005をmainへマージする前に、ubuntuで実行不能なnative guard依存テストのOS gateを決める（現状Pages workflowがfeature/F005で失敗し続ける）"
  - "公開中のcontent/licenses.jsonはvalidUntil 2026-08-18で失効する。権利条件を再確認して更新する（法的判断が必要）"
blocked_by: []
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0、F002はv0.2.0、F003はv0.3.0、F004はv0.4.0としてGitHub Pagesへ公開済み。公開サイトは3作者・12作品・674台詞・662音声で安定稼働中。
- F005は公開前の非公開候補生成を継続中で、公開サイト・`public/`・`data/`は変更していない。
- Q-042回答を3点セットで処理し、T-110を`todo`へ戻した。CHG-F005-052/T-126でproduction共有規則を使う決定的hosted相関検証を設計し、独立再レビューHigh/Medium/Low 0でPASSした。認可・容量actual・候補保存・公開条件は変更していない。
- CHG-F005-052/T-126のread-only hosted相関検証を実装した。native通常820件、target 57件、関連Vitest26件、型、ESLint、trace、同一SHA再現build2回、独立受入High/Medium/Low 0をPASSした。run `31239312228`でtarget 57/57、kernel ETW、実load assembly SHA・MVID、同一SHA Pages deploy `skipped`を確認し、T-110/T-126/CHG-F005-036/052を完了した。
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
- run 30522848642はbound directory固定診断を通過後、`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT`で安全停止した。CHG-F005-027/T-101は`done`とした。CHG-F005-028で認可を変えず、snapshot/path/current identityとactive leaseのphase/path/FileObject binding/closed/Job escapeを固定11 stageへ細分化した。初回レビューLow 1件をgate内配置の構造試験追加で解消し、native規則147件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30523793166は`audio-renamed`まで進み、`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_ACTIVE_LEASE_WRITE_REJOIN_LEASE_BOUND`で安全停止した。CHG-F005-028/T-102は`done`とした。CHG-F005-029で認可を変えず、directory候補とlease snapshot・FileObject binding・current identity・Job状態を固定18 stageへ細分化した。native規則165件、対象124件、型、ESLint、同一SHA再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30524741788は`audio-renamed`後に`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_LEASE_CURRENT_MISSING`で安全停止した。CHG-F005-029/T-103は`done`とした。CHG-F005-030でrename予約path・親directory・QPC・target identity・Job状態を固定8 stageへ細分化した。初回レビューLow 2件を試験補強で解消し、native規則173件、対象124件、型、ESLint、再現build 2回、trace、独立レビューHigh/Medium/Low 0をPASSした。
- run 30525787305は`audio-renamed`後、固定stage `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_BEFORE_RESERVATION`で安全停止した。CHG-F005-030/T-104は`done`とし、CHG-F005-031/T-105でevent QPCをlease予約前・lease予約後〜rename予約前へ分離する。候補・公開差分は0件である。
- CHG-F005-031/T-105で`BEFORE_RESERVATION`を`BEFORE_LEASE_RESERVATION`と`AFTER_LEASE_RESERVATION`へ固定分離した。native規則174件、関連Vitest 121件、型、ESLint、同一SHA再現build 2回、独立受入High/Medium/Low 0をPASSし、認可・容量actual・候補保存・公開条件と`public/`・`data/`は変更していない。
- run 31025643577はCHG-F005-031のlease時間分類を通過し、`audio-renamed`後に`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_LEASE_PATH`で安全停止した。native probeはPASS、isolated candidate branchは未作成、Pages deployはskipであり、T-105/CHG-F005-031は`done`とした。CHG-F005-032/T-106でpending renameとlease pathの関係を固定分類する。
- CHG-F005-032/T-106で`BOUND_FILE_OBJECT_REJOIN_LEASE_PATH`をpending rename target、予約順序、QPC三境界、旧path、snapshot、binding、closed、Jobの専用固定14 stageへ分離した。native規則191件、関連Vitest 121件、型、ESLint、同一SHA再現build 2回、独立受入High/Medium/Low 0をPASSし、認可・容量actual・候補保存・公開条件と`public/`・`data/`は変更していない。
- commit `f56ca6f`のrun `31028376915`はattempt 1/3で`audio-renamed`後の`AFTER_LEASE_RESERVATION`、attempt 2で`wav-validated`後の既知`LEASE_MISSING`へ安全停止し、T-106のhosted対象経路へ未到達だった。retry_limit 3に達したためT-106をQ-034で`blocked`とし、CHG-F005-033/T-107で前段の完全tuple限定再結合を進める。native probeはPASS、candidate branchは未作成、Pages deployはskipである。
- CHG-F005-033/T-107で`AFTER_LEASE_RESERVATION`の完全tupleだけを元active lease worker世代へ限定再結合した。保持process handleのPID/start key/sequence、alive時Job、signaled遅延event、QPC 5境界、認可後4点再照合を固定し、native 210件、関連Vitest 122件、型、ESLint、同一SHA再現build 2回、独立受入High/Medium/Low 0、`public/`・`data/`差分0をPASSした。hosted影響試験待ちである。
- commit `12cc0b9`のrun `31032629020`はCHG-F005-033の限定再結合を通過し、`audio-renamed`後にT-106専用`F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_RENAME_LEASE_PATH_PATH_MISSING`へ安全停止した。T-106/T-107とCHG-F005-032/033を`done`、Q-034を`closed`とし、CHG-F005-034/T-108でpending renameなしのpath関係を認可せず固定分類する。native probeはPASS、candidate branchは未作成、Pages deployはskipである。
- CHG-F005-034/T-108で旧`PATH_MISSING`だけをexact 19 stageへ細分化した。FILE/OTHER即時停止、directory/root/lease評価順、`STATE_DRIFT`、lease current欠落、`CANDIDATE`を固定し、native 229件、関連Vitest 122件、型、ESLint、同一SHA再現build 2回、独立受入High/Medium/Low 0、`public/`・`data/`差分0をPASSした。認可・容量actual・候補保存・公開条件は変更せず、hosted影響試験待ちである。
- commit `e3f85b3`のrun `31035627381`はattempt 1で既知`LEASE_BINDING_MISMATCH`へ安全停止し、attempt 2でT-108新stage `F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_NO_PENDING_LEASE_UNBOUND`へ到達した。T-108/CHG-F005-034を`done`とし、CHG-F005-035/T-109でactive unbound leaseの予約・current・deferred・process状態を認可せず固定分類する。native probeはPASS、candidate branchは未作成、Pages deployはskipである。
- CHG-F005-035/T-109で旧`NO_PENDING_LEASE_UNBOUND`だけをexact 14 stageへ細分化した。event/deferred QPC境界、lease current、deferred完全tuple/current identity、保持process identity/wait/Job/世代を固定し、native 261件、関連Vitest 122件、型、ESLint、同一SHA再現build 2回、独立受入High/Medium/Low 0、`public/`・`data/`差分0をPASSした。認可・lease binding・容量actual・候補保存・公開条件は変更せず、hosted影響試験待ちである。
- commit `ded3117`のrun `31038467173`はattempt 1で既知`LEASE_BINDING_MISMATCH`、attempt 2で既知`LEASE_MISSING`、attempt 3で既知`SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_CANDIDATE`へ安全停止し、T-109のhosted対象経路へ未到達だった。retry_limit 3に達したためT-109をQ-035で`blocked`とし、CHG-F005-036/T-110で前段の完全候補限定再結合を進める。native probeはPASS、candidate branchは未作成、Pages deployはskipである。
- CHG-F005-036/T-110は初回計画レビューHigh 0 / Medium 3 / Low 0を受け、process直前再inspection、exact 19 code、QPC三者境界、rename二値null、false-one-by-oneを追記した。再レビューHigh/Medium/Low 0でPASSし、commit `bbec929`へ再開点を固定して実装を開始した。
- CHG-F005-036/T-110で既存bound lease directory `CANDIDATE`だけを完全tupleで限定再結合した。初回独立受入High 0 / Medium 2 / Low 0のTOCTOU実行試験・CHG証跡不足を是正し、native 316件、関連Vitest 123件、型、ESLint、同一SHA再現build 2回、独立再受入High/Medium/Low 0、`public/`・`data/`差分0をPASSした。Program SHAは`db8e06e9...b3d0c`、binary SHAは`4cb77da0...c791d7`、75,056,988 bytesである。
- commit `e4fb086`のrun `31042915405`はattempt 1で既知`LEASE_CLOSED`、attempt 2で既知`LEASE_MISSING`、attempt 3で既知`LEASE_BINDING_MISMATCH`へ安全停止し、T-110対象へ未到達だった。retry_limit 3に達したためT-110をQ-036で`blocked`とした。native probeはPASS、全attemptでcandidate保存なし、Pages deployはskipである。
- Q-036は「CHG-F005-037でhosted raceの決定的再現方法を設計」で回答済みとして閉じた。T-110をunblockし、callback到着時のmutable lease状態ではなくwrite completion準備時のsealed tupleとevent QPCで遅延eventを決定的に分類・drainするCHG-F005-037/T-111を開始した。
- CHG-F005-037計画レビューのMedium 3+3を反映し、最大128非重複seal、phase-wide ETW順replay、exactly-once accounted、QPC deadline状態機械、3段seal lookup、private IPC exact keysを確定した。最終再レビューHigh/Medium/Low 0、trace_check、YAML、diff checkをPASSし実装へ移行する。
- CHG-F005-037/T-111を実装し、未適用snapshot queue、replay時identity/capacity適用、root owner native identity、retained tuple、callback admission read/write fenceを固定した。独立受入はH2/M4、再受入はH1/M1を検出して是正し、最終H0/M0/L1でコードPASS。native421件、関連Vitest124件、型・ESLint、trace、同一SHA再現build2回、public/data差分0をPASSした。Programは`30dea0c2...b9a3f4`、binaryは`3a977c28...12b08`、75,089,756 bytesである。
- commit `7e3388d`のhosted production run `31124038599`はGitHub Actions major outage中にjob step未生成のまま基盤cancelとなった。rerun要求は受理されたが約13時間job未生成で、APIもcancelを`Cannot cancel a workflow re-run that has not yet queued`として409拒否した。workflow自己pathだけを更新したcommit `9c6fd375`をpushして新run生成を再要求し、実装・認可条件・`public/`・`data/`は変更していない。
- CHG-F005-056〜068（T-130〜T-140）でactive-directory候補多重性、no-lease seal集合、post-upper binding proof、parent ledger stateを順次固定診断へ分離した。hosted run `31623037336` attempt 2でCHG-F005-068の目標軸`...POST_UPPER_PROOF_PARENT_BOUND_EVENT_FO_MISMATCH`へ到達し、T-140の影響確認を完了した。
- CHG-F005-069/T-141で、parentがledger Boundかつphase・親path・予約順を満たすlate eventのFileObjectがactive lease FileObjectと異なる場合を、ledger関係の固定7 code（entry missing/unbound、bound same/other path、retired same/other path、other state、lookup invalid）へ分離した。native 1203件、固定target 57/43/74/52、外部code 90→97同期、typecheck、ESLint、同一SHA再現build 2回をPASSし、認可・容量actual・候補保存・公開条件と`public/`・`data/`は変更していない。
- CHG-F005-070/T-142で、bind先pathとevent directory・候補seal集合の関係を固定6 code（event directory、候補CurrentPath、候補ParentPath、同一親配下file、別親配下、関係invalid）へ分離した。自然経路のproduction run `31668142202`は3 attemptとも既知経路で安全停止し本軸へ未到達だったため、CHG-F005-052〜055の型に従いread-only固定76 case suite（T-142）を追加してhosted native probeのselectorを切り替えた。run `31669520975`が76/76、kernel ETW pass、native binary SHA一致、Pages deploy `skipped`、candidate branch不存在をPASSし、決定的な影響確認を完了した。続くproduction run `31669864841` attempt 3が本軸 `...PARENT_BOUND_EVENT_FO_OTHER_EVENT_DIR` へ到達し、late eventのFileObjectが**event directory自身へbindされたdirectory handle**であることを確定した。これによりFILE_OBJECTアドレス再利用の仮説は否定され、停止の実体は「directory scopeのSystem eventをfile leaseのFileObject一致で評価している」評価順の問題であると判明した。
- テスト健全性を是正した。notices fixtureの`validUntil`が2026-08-01で失効し`CREDITS_POLICY_STALE`で6件失敗していたため未来日付へ移した（失効経路は明示値で検証継続）。rehydrate改変検知テストの5秒既定タイムアウトを同ファイル他重量テストと同じ30秒へ揃えた。フルスイートの残存失敗は並列実行時のリソース競合によるflakyで、`--maxWorkers=2`では1289/1290 PASSを確認した。
- CHG-F005-071/T-143で、event directory自身へBoundなFileObjectのledger状態を固定5 code（Reused / DeleteSeen / CleanupSeen / Live / StateInvalid）へ分離した。`SealedParent`登録はUnboundを維持する契約のため、State Boundでpathがdirectoryのentryは`OtherBound`として登録されたものであり、`Reused`はFileObjectアドレス再利用の記録である。native 1286件、Vitest 1290件、108 code同期、同一SHA再現build 2回をPASSした。自然経路のrun `31672315764`は3 attemptとも既知の`CONTEXT_MISSING`で未到達のため、決定的hosted相関suiteの追加を次サイクルとする。
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

- CHG-F005-071/T-143でdirectory binding状態の固定5 codeを実装（hosted影響確認は次サイクル）
- 2026-08-13に権利条件を実規約から再確認し証跡化。反映はv0.4.1パッチリリース待ち
- CHG-F005-070/T-142でbind先path関係の固定6 codeと決定的hosted相関検証（76/76）を完了
- notices fixtureの期限切れとborderline timeoutを是正しテスト健全性を回復
- CHG-F005-069/T-141でevent FO ledger関係の固定7 codeとMatchEventFileObjectを実装
- CHG-F005-068/T-140のhosted影響確認をrun 31623037336 attempt 2で完了しdoneへ確定
- T-130〜T-140（CHG-F005-056〜068）の候補多重性・binding proof・parent state診断を順次完了
- T-126〜T-129で決定的hosted相関検証を確立しT-110/T-122/T-112/T-109の影響確認を完了
- Q-042〜Q-044を3点セットで処理しblockedを解消

## 次のアクション

- `native/f005-guard/Program.cs`ほかでCHG-F005-054/T-128のproduction-owned retained identity lease、T-112固定target/manifest、selectorを完了する。
- T-128完了後、`docs/changes/CHG-F005-055.md`に従いT-129のproduction共有evaluator、T-109 target source/manifestを実装する。
- T-110/T-122/T-112 target無縮退、raw非公開、同一SHA Pages deploy `skipped`をlocal/hosted evidenceで検証する。

## 未解決事項

- C:空きは実preflight後85.4 GiB（9.2%）で注意域だが5 GiB停止基準を十分上回る。削除は行わず、音声生成直前にもrunner内で再計測する。
- GitHub Actionsの先行障害後もcommit `4dc7d2b`のnative/production runは正常生成された。現在はT-113の新commit生成後の再試験待ちである。
- T-109はQ-044回答を反映して`todo`へ戻した。local受入PASS済みで、CHG-F005-055/T-129のproduction共有evaluatorを使う決定的hosted影響確認を待つ。
- T-110は自然なhosted対象へfollow-up 3 attemptで未到達だったが、CHG-F005-052/T-126の決定的hosted相関run `31239312228`で影響確認をPASSし完了した。
- T-111はQ-037回答を反映して`todo`へ戻した。CHG-F005-038/T-112で不変replay proofへ置換後にhosted影響試験を再実施する。
- T-122は自然なhosted follow-up 3 attemptで未到達だったが、CHG-F005-053/T-127の決定的hosted correlation run `31241090301`で43/43と非公開条件をPASSし完了した。
- CHG-F005-052/T-126はtrace_check `対応漏れなし: OK`とhosted canonical evidenceを確認済みである。
- CHG-F005-055は独立最終再レビューHigh/Medium/Low 0でPASSし、T-129実装・local/hosted再試験完了まで`in-review`を維持する。
