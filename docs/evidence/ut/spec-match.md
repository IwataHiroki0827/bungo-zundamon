# F001 単体試験仕様ID機械照合

## T-010影響再試験前照合（2026-07-19）

- 仕様書から抽出した仕様ID: `UT-F001-001`〜`UT-F001-042`の42件。
- 初回のテストコード直接照合: 26/42件、直接タグ不足16件。
- 不足していた仕様ID: `UT-F001-009`〜`UT-F001-018`、`UT-F001-031`、`UT-F001-032`、`UT-F001-035`、`UT-F001-037`、`UT-F001-039`、`UT-F001-042`。
- 対応: 既存の対応試験suite名へ仕様IDを追記した。試験ロジック、期待値、fixtureは変更していない。
- 補完後のテストコード直接照合: **42/42件対応、未対応0件**。
- 判定: UT実行前の仕様ID機械照合ゲートをPASSした。

## 判定概要

- 対象仕様: `docs/tests/ut/UT-F001.md`
- 対象テスト: `src/**/*.test.ts`、`scripts/*.test.mjs`
- 仕様ID: `UT-F001-001`〜`UT-F001-042`（42件）
- 対応: 42件
- 未対応: 0件
- 判定日: 2026-07-18

「対応」は、仕様IDが`src/**/*.test.ts`または`scripts/*.test.mjs`へ直接記載され、下表の試験suiteまたは試験名へ一意に追跡できることを示す。本資料は仕様IDの対応だけを判定し、PASS/FAILは`UT-F001-result.md`とattempt生ログで判定する。

## 対応表

| UT ID | 判定 | 対応するテスト（ファイル: テスト名） | 対象実装 |
|---|---|---|---|
| UT-F001-001 | 対応 | `src/ui/catalog-loader.test.ts`: 「固定hashだけをrouteとして受理する」; `src/main.test.ts`: 「未知routeを安全な404にしhash変更でトップへ戻れる」 | `src/ui/routes.ts`: `parseRoute` |
| UT-F001-002 | 対応 | `src/main.test.ts`: 「トップにサイト説明・作者・非公式表記を描画する」; 「未知routeを安全な404にしhash変更でトップへ戻れる」 | `src/ui/render.ts`: `renderRoute`; `src/main.ts`: `mountBungoZundamon` |
| UT-F001-003 | 対応 | `src/ui/catalog-loader.test.ts`: 「同一originのcatalogを読みUTF-8 byte数とschemaを検証する」 | `src/ui/catalog-loader.ts`: `loadCatalog` |
| UT-F001-004 | 対応 | `src/ui/catalog-loader.test.ts`: 「3作品・参照・候補集計が整合するcatalogだけを受理する」; 「depth 64超過・文字列上限超過・理由別集計不一致を拒否する」ほか | `src/ui/catalog-loader.ts`: `validateCatalog` |
| UT-F001-005 | 対応 | `src/content/source.test.ts`: 「適格な書誌行だけを安定順序で残し、不正行を診断する」; 「公式書誌の役割列から原著・翻訳・不明をfail-closedで分類する」 | `src/content/source.ts`: `selectEligibleWorks`, `parseAozoraBibliography` |
| UT-F001-006 | 対応 | `src/content/source.test.ts`: 「明示した作品ID規則で3作品の版を解決し、同名別作品や異常規則を拒否する」; 「杜子春No.43015をcanonical ID 043015と公式XHTML URLで取得する」 | `src/content/source.ts`: `resolveEdition` |
| UT-F001-007 | 対応 | `src/content/source.test.ts`: 「production transportがDNS pinとTLS hostname検証を維持し、要求を直列化する」; 「原典rawとSourceRecordをまとめて採用し、失敗時は既存artifactを保持する」ほか | `src/content/source.ts`: `ProductionAozoraTransport`, `fetchAozoraSources` |
| UT-F001-008 | 対応 | `src/content/source.test.ts`: 「由来の必須情報とhash一致、CC BY 4.0変更表示を検証する」; `src/content/pipeline.test.ts`: 「manifestと全3作品の書誌ZIP/CSV由来が一致しない場合は公開artifactを作らない」 | `src/content/source.ts`: `buildProvenance`; `src/content/pipeline.ts`: provenance検証 |
| UT-F001-009 | 対応 | `src/content/processing.test.ts`: 「改行跨ぎ・同一段落複数・内側二重括弧・rubyを本文順に抽出する」; 「括弧不足／本文なし／parser errorを理由コード付き失敗にする」 | `src/content/processing.ts`: `extractDialogueCandidates` |
| UT-F001-010 | 対応 | `src/content/processing.test.ts`: 「本文だけをtext/ruby/lineBreakへ変換し、危険・未知要素を除外する」; 「本文がなければfail-closedで拒否する」 | `src/content/processing.ts`: `tokenizeAozoraBody` |
| UT-F001-011 | 対応 | `src/content/processing.test.ts`: 「表示文はruby表示と改行を保ってNFCにする」; 「不正表示文字列を拒否する」 | `src/content/processing.ts`: `normalizeDisplayText` |
| UT-F001-012 | 対応 | `src/content/processing.test.ts`: 「ruby読み・外字・空白規則を決定的に適用する」; 「未知規則・未置換外字・空文字をNormalizationErrorにする」 | `src/content/processing.ts`: `normalizeSpeechText` |
| UT-F001-013 | 対応 | `src/content/processing.test.ts`: 「同一tupleは同一URL安全ID、境界変更は別IDになる」; 「不正tupleではランダムfallbackを作らず停止する」 | `src/content/processing.ts`: `createCandidateId` |
| UT-F001-014 | 対応 | `src/content/processing.test.ts`: 「最新revisionだけを採用してstatus・理由を集計する」; 「孤立・競合・pending・理由なし・重複をfail-closedにする」 | `src/content/processing.ts`: `applyEditorialReview` |
| UT-F001-015 | 対応 | `src/content/processing.test.ts`: 「approvedかつ音声成功だけを公開し、共有audioと3区分集計を維持する」; 「理由なし音声失敗・pending・孤立asset・絶対path・重複IDを拒否する」 | `src/content/processing.ts`: `buildPublicCatalog` |
| UT-F001-016 | 対応 | `src/voice/voice.test.ts`: 「全設定を決定的なSHA-256 keyへ含め、設定境界を受理する」; 「空文字・未固定・範囲外を拒否する」 | `src/voice/cache.ts`: `createVoiceCacheKey` |
| UT-F001-017 | 対応 | `src/voice/voice.test.ts`: 「loopback固定clientでgate後に直列・無retry生成する」; 「版・話者gate不一致では追加生成と公開先変更を行わない」ほか | `src/voice/generation.ts`: `generateVoiceAssets`; VOICEVOX client実装 |
| UT-F001-018 | 対応 | `src/voice/voice.test.ts`: 「合計…byteを…判定する」; 「単一上限・参照欠損・別path同一hashをfailし、共有参照は許可する」 | `src/voice/budget.ts`: `verifyAssetBudget` |
| UT-F001-019 | 対応 | `src/ui/audio-controller.test.ts`: 「明示操作まで音声を取得せず単一Audioで対象だけを再生する」; 「別台詞へ切り替える前に前音声を止めて位置を戻す」ほか | `src/ui/audio-controller.ts`: `AudioController.play` |
| UT-F001-020 | 対応 | `src/ui/audio-controller.test.ts`: 「pauseは位置を保持しresumeは同位置、stopだけが先頭へ戻す」; 「音声終了と未知IDを安全に処理する」ほか | `src/ui/audio-controller.ts`: `AudioController.control`, 状態遷移処理 |
| UT-F001-021 | 対応 | `src/ui/audio-controller.test.ts`: 「再生拒否を対象項目の固定日本語エラーへ隔離し内部情報を表示しない」 | `src/ui/audio-controller.ts`: `presentAudioError`, 再生失敗処理 |
| UT-F001-022 | 対応 | `src/main.test.ts`: 「トップにサイト説明・作者・非公式表記を描画する」; 「表示文字をHTMLとして解釈せず演出低減を反映する」 | `src/ui/render.ts`: `renderHome` |
| UT-F001-023 | 対応 | `src/main.test.ts`: 「作者routeに3作品と操作可能な台詞一覧を描画する」 | `src/ui/render.ts`: `renderAuthorPage` |
| UT-F001-024 | 対応 | `src/main.test.ts`: 「作者routeに3作品と操作可能な台詞一覧を描画する」 | `src/ui/render.ts`: `renderDialogueCard` |
| UT-F001-025 | 対応 | `src/ui/catalog-loader.test.ts`: 「OSまたはメモリ内設定のどちらかが低減なら演出を低減する」; `src/main.test.ts`: 「表示文字をHTMLとして解釈せず演出低減を反映する」 | `src/ui/routes.ts`: `resolveMotionPreference` |
| UT-F001-026 | 対応 | `src/notices/notices.test.ts`: 「検証済みmanifestだけから必須表示と安全なリンクを描画する」; 「brandを持たない未検証manifestは描画しない」; `src/notices/asset-integrity.test.ts`: 「実manifestから必須表示と正確なサムネイル由来を描画する」 | `src/notices/credits.ts`: `renderCredits` |
| UT-F001-027 | 対応 | `src/main.test.ts`: 「表示文字をHTMLとして解釈せず演出低減を反映する」 | `src/ui/render.ts`: `setSafeText` |
| UT-F001-028 | 対応 | `src/ui/catalog-loader.test.ts`: 「公開assetをPages base内の相対pathだけに限定する」 | `src/ui/catalog-loader.ts`: `resolvePublicAsset` |
| UT-F001-029 | 対応 | `src/ui/lazy-loading.test.ts`: 「IntersectionObserverは表示テキストだけを観測し、音声取得を開始しない」; 「Observer非対応や初期化例外ではテキストを即時表示し、音声へ触れない」 | `src/ui/lazy-loading.ts`: `observeAudioLazyLoading` |
| UT-F001-030 | 対応 | `src/ui/catalog-loader.test.ts`: 「固定Pages baseだけを現在originへ解決する」 | `src/ui/catalog-loader.ts`: `publicBaseUrl` |
| UT-F001-031 | 対応 | `scripts/release-checks.test.mjs`: 「Pages base配下の成果物を受理する」; 「欠損・base逸脱・危険CSPを拒否する」; 「CSS内の欠損参照とMIME偽装をfail-closedで拒否する」 | `scripts/release-checks.mjs`: `verifyBuiltReferences` |
| UT-F001-032 | 対応 | `scripts/release-checks.test.mjs`: 「実workflowの最小権限・SHA固定・承認switchを受理する」; 「tag参照／npm install／過剰権限等を拒否する」 | `scripts/release-checks.mjs`: `verifyWorkflowPermissions` |
| UT-F001-033 | 対応 | `src/content/pipeline.test.ts`: 「11 stageを固定順で実行しhashと件数を返す」; 「致命失敗後のstageを呼ばずworkspace外pathと未知stageを拒否する」; `src/content/content-cli.test.ts`: stage別exit code; `src/content/production.test.ts`: artifact差替え拒否; `scripts/network-deny.test.mjs`: offline遮断 | `src/content/pipeline.ts`: `runContentUpdate`; `scripts/content-cli.ts`; `src/content/production.ts`; `scripts/network-deny.mjs` |
| UT-F001-034 | 対応 | `src/content/pipeline.test.ts`: 「UTF-8・安定キー順で完全fileへ置換する」; 「mtime競合とrename失敗では元bytesを保持しtmpを残さない」; 「固定path逸脱とsymlinkを拒否する」; `src/content/artifacts.test.ts`: atomic writer試験 | `src/content/pipeline.ts`: `writeProvenanceAtomic`; `src/content/artifacts.ts`: atomic writer実装 |
| UT-F001-035 | 対応 | `scripts/release-checks.test.mjs`: 「全条件を満たすread-only証跡だけをreadyにする」; 「public repository／Pages有効／hash不一致等をblockedにする」; 「validUntilが判定instantと一致する境界を受理する」 | `scripts/release-checks.mjs`: `runReleaseChecks` |
| UT-F001-036 | 対応 | `src/content/pipeline.test.ts`: 「各stageでallowlist済み3項目だけを返す」; 「未知Errorは安全な非retry診断へ倒す」 | `src/content/pipeline.ts`: `mapPipelineError` |
| UT-F001-037 | 対応 | `src/notices/notices.test.ts`: 「用途別の固定origin/pathを許可する」; 「危険なURLを拒否する」; 「用途とpathの取り違えを拒否する」 | `src/notices/trusted-links.ts`: `resolveTrustedExternalLink` |
| UT-F001-038 | 対応 | `src/notices/notices.test.ts`: 「全権利表示・画像由来が揃い、期限instant以下なら検証済みmanifestを返す」; 「期限を1ms超過した場合は公開不可にする」ほか; `src/notices/asset-integrity.test.ts`: 実asset照合 | `src/notices/release-notices.ts`: `validateReleaseNotices` |
| UT-F001-039 | 対応 | `src/voice/voice.test.ts`: 「推定…byteを…判定する」; 「共有読みをunique計上し、不正profile・過大誤差で係数更新を要求する」 | `src/voice/budget.ts`: `estimateVoiceBudget` |
| UT-F001-040 | 対応 | `src/content/source.test.ts`: 「一致するHTTP→meta→書誌charsetを採用し、UTF-8とShift_JISをfatal decodeする」; 「hash、宣言欠落・不一致・非allowlist・decode異常を理由付きで拒否しrawを変えない」 | `src/content/source.ts`: `decodeAozoraSource` |
| UT-F001-041 | 対応 | `src/content/source.test.ts`: 「公式書誌ZIPと固定CSVを検証してatomic snapshot化し、異常時は既存snapshotを維持する」; 「store/deflateの固定entryとCRCを受理し、危険なZIP構造を理由付きで拒否する」ほか | `src/content/source.ts`: `fetchAozoraBibliography`, `extractVerifiedBibliographyCsv`, `ProductionAozoraTransport` |
| UT-F001-042 | 対応 | `scripts/release-checks.test.mjs`: 「完全なchainだけをreleasedにする」; 「未承認／順序不正／audit欠落／hash不一致等をblockedにする」 | `scripts/release-checks.mjs`: `validateReleaseVisibilityEvidence` |

## 照合・実行コマンド

仕様IDの抽出・重複除去:

```powershell
rg -o "UT-F001-[0-9]{3}" docs/tests/ut/UT-F001.md | Sort-Object -Unique
```

テスト側の仕様IDを抽出:

```powershell
rg -o --no-filename "UT-F001-[0-9]{3}" src scripts --glob "*.test.ts" --glob "*.test.mjs" | Sort-Object -Unique
```

仕様書との差分確認:

```powershell
$spec = rg -o --no-filename "UT-F001-[0-9]{3}" docs/tests/ut/UT-F001.md | Sort-Object -Unique
$code = rg -o --no-filename "UT-F001-[0-9]{3}" src scripts --glob "*.test.ts" --glob "*.test.mjs" | Sort-Object -Unique
Compare-Object $spec $code
```

後続のUT実行コマンド:

```powershell
npm test
```

## 未対応

未対応の仕様IDはない。
