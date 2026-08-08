# IT-F005-005 CHG-F005-052 local影響試験結果

## 判定

PASS。T-110専用の決定的hosted相関検証を、production認可・容量actual・候補保存・公開条件を変更せず実装した。実hosted runとPages相関は実装commitのpush後に確認する。

## 実装結果

- production共有`BoundLeaseInitialInspection`と`EvaluateInitialTupleInspection`を追加し、directory/lease inspectを各exact 1回、delegateをexact 1回評価する。
- `GuardException`は`ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_INITIAL_TUPLE_INSPECTION_FAILED`へ固定し、cheap predicate→初回tuple→process→認可後再照合の順序を維持する。
- target `CHG-F005-036/T-110`へ固定57 case manifest、実directory/file identity、private Job childのalive/signaled/別generation/Job外を追加した。
- hosted native probe workflowは全体`actions: read`/`contents: read`、checkout credentialなし、push・artifact uploadなしとした。
- target stdout/stderrをRUNNER_TEMPへ隔離し、各65,536 bytes上限、固定marker以外の未知行、重複、順序・件数・SHA差を拒否する。
- 同一head SHAのPages runをbounded pollし、deploy job `skipped`とcandidate branch不存在を確認してからcanonical evidence markerを生成する。

## 試験結果

- native通常規則: 820 / 820 PASS
- T-110 target suite: 57 / 57 PASS、final marker 1件、exit 0
- 関連Vitest: 2 files / 26 tests PASS
- 3 files統合Vitest: 47 / 47 PASSを1回確認。再実行時に既存の高速native guard 16回起動ケースだけが環境依存5秒timeoutとなったが、今回追加2 filesは単独26 / 26 PASSであり機能assert失敗はない
- TypeScript typecheck: PASS
- 対象ESLint: PASS
- trace_check F005: 対応漏れなし
- 同一SHA再現build 2回: PASS
- `git diff --check`: PASS
- 独立受入: PASS（High 0 / Medium 0 / Low 0）

## 固定値

- Program SHA-256: `cd0b29ea69494287d1e34adf35c4b442bd7ef98d1eb8bb794aee975136d6e74e`
- production project SHA-256: `a2275dbb0f3db2f34f08f0b48eee7e4c459be01e8d23305f30f7ad131b88a867`
- native binary SHA-256: `d20ccb6983266098bf66c40a194668a2a5a42b89d74484076633ba3d96e9e5c9`
- native binary bytes: `75,188,060`
- test project SHA-256: `e0d451fa2a71ce7541197d6e4f7eda570648a055fefbfcba6bf0b0f77fd58c0b`
- target source SHA-256: `884b4f21048537bff524681cf5d74135ca293f31d73b934cb2574126aa5f0147`
- case manifest SHA-256: `9c4df18441cd64dac77c644473e0629ea4bbb554b1f15d40e3bd6ed04dc14999`
- workflow SHA-256: `93e8c0c8ce39e6c16e7d29debfd9bbafe19e6cd6ea60a119dbdb959a8533aa40`

## 非変更確認

production guardへtarget ID、環境変数、command line switch、追加IPC operationを導入していない。既存candidate workflow、Pages workflow、`public/`、`data/`、容量actual、候補受入・保存、公開判定は変更していない。
