# F001 QT仕様ID 機械照合結果

## 2026-07-19 T-010影響試験前照合

- 仕様書: `docs/tests/qt/QT-F001.md`
- 抽出方法: `QT-F001-[0-9]{3}`を抽出・昇順化し、`src/`、`scripts/`、`tests/`、`.github/`、`docs/evidence/`の自動試験・手動手順・外部証跡へ照合した。
- 仕様ID: `QT-F001-001`〜`QT-F001-020`の連番20件。
- 対応結果: **20/20件対応、未対応0件**。
- attempt前補完: `QT-F001-020`のAndroid相当を独立して実行・識別できるよう、`playwright.config.ts`へ`android-equivalent-pages-preview`（Pixel 7相当）を追加した。
- 自動化不可部分は、`docs/evidence/qt/QT-F001-browser-manual.md`の手動3環境、BrowserRiskDecision、HostedBuildEvidence、VisibilityPlanEvidenceへ分離した。

## QT ID別対応表

| QT ID | 自動試験・既存証跡 | 手動・外部手順 | 対応 |
|---|---|---|---|
| QT-F001-001 | `tests/e2e/navigation-and-delivery.spec.ts`、`src/main.test.ts` | 手動3環境のトップ→作者導線・画面証拠 | 対応 |
| QT-F001-002 | `src/content/processing.test.ts`、`src/main.test.ts`、`docs/evidence/content-review/` | 67候補の全件レビュー証跡 | 対応 |
| QT-F001-003 | `src/content/source.test.ts`、`docs/evidence/content/CONTENT-F001-production-extraction.md` | 自動・既存証跡で完結 | 対応 |
| QT-F001-004 | `src/content/processing.test.ts`、取得済み3作品の抽出証跡 | 自動・既存証跡で完結 | 対応 |
| QT-F001-005 | `src/content/processing.test.ts`、`docs/evidence/content-review/` | revision 2の全67候補レビュー | 対応 |
| QT-F001-006 | `src/content/processing.test.ts`、`src/content/pipeline.test.ts`、`src/main.test.ts` | 自動・既存証跡で完結 | 対応 |
| QT-F001-007 | `src/content/source.test.ts`、`src/voice/voice.test.ts`、`scripts/network-deny.test.mjs` | provenance・音声生成・公開build証跡 | 対応 |
| QT-F001-008 | `tests/e2e/audio-and-isolation.spec.ts`、`src/ui/audio-controller.test.ts` | 手動3環境の明示再生・通信確認 | 対応 |
| QT-F001-009 | `tests/e2e/audio-and-isolation.spec.ts`、`src/ui/audio-controller.test.ts` | 手動3環境のpause/resume/stop・状態表示 | 対応 |
| QT-F001-010 | `tests/e2e/audio-and-isolation.spec.ts`、`src/ui/audio-controller.test.ts` | 自動で404・再生拒否・再試行・隔離を確認 | 対応 |
| QT-F001-011 | `tests/e2e/responsive-accessibility-security.spec.ts`、`src/notices/notices.test.ts` | 手動3環境の表示証拠 | 対応 |
| QT-F001-012 | `src/notices/asset-integrity.test.ts`、`content/artwork-provenance.json` | provenance・reviewer/date証跡 | 対応 |
| QT-F001-013 | `tests/e2e/responsive-accessibility-security.spec.ts` | 手動3環境の縦横表示・画面証拠 | 対応 |
| QT-F001-014 | `tests/e2e/responsive-accessibility-security.spec.ts` | スクリーンリーダーは既存Q-005監査証跡、手動3環境はkeyboard操作を確認 | 対応 |
| QT-F001-015 | `tests/e2e/responsive-accessibility-security.spec.ts` | Q-008 `motion_clarity`目視PASS | 対応 |
| QT-F001-016 | `scripts/release-checks.test.mjs`、`tests/e2e/audio-and-isolation.spec.ts` | 自動・既存容量証跡で完結 | 対応 |
| QT-F001-017 | `tests/e2e/responsive-accessibility-security.spec.ts`、`scripts/release-checks.test.mjs` | 手動3環境・公開後確認 | 対応 |
| QT-F001-018 | `tests/e2e/navigation-and-delivery.spec.ts`、`scripts/release-checks.test.mjs` | Pages相当local preview、公開後smokeはゲート④後 | 対応 |
| QT-F001-019 | `scripts/release-checks.test.mjs`、`.github/workflows/pages.yml` | private feature branch hosted run、artifact、visibility/hash chain | 対応 |
| QT-F001-020 | `playwright.config.ts`の自動4project、`tests/e2e/*.spec.ts` | 手動3環境、BrowserRiskDecision 3件、hosted/visibility、最終判定 | 対応 |

## 今回の自動4範囲

| 範囲 | Playwright project | ケース数 | attempt 4 |
|---|---|---:|---|
| Chromium | `chromium-pages-preview` | 13 | PASS |
| Firefox | `firefox-pages-preview` | 13 | PASS |
| WebKit | `webkit-pages-preview` | 13 | PASS |
| Android相当 | `android-equivalent-pages-preview`（Pixel 7 / Chromium） | 13 | PASS |

合計は **52/52 PASS**、FAIL 0、retry 0、hang 0。生ログは`docs/evidence/qt/QT-F001-automated-attempt-4.log`、SHA-256は`72ee3c8adfedb97a7299aa8286fbad936e4ffb65f84f424034f4eff11cf40c15`。

## 外部状態の分離

次は対応手順を持つが、実証跡がないためPASSとして扱わない。

- private `feature/F001`へ確定候補commitをpushしたGitHub hosted Actions
- run URL、artifact ID/name/digest、artifact内catalog hash、deployment不在、Pages hash不変
- repository visibility、Pages無効、deploy変数の承認前read-only観測
- Windows Chrome、Windows Edge、iOS Safariの候補commit一致手動3環境

リリース候補は`5337d2752e5a288b8d3078c2d1d133ebdef6ed21`としてprivate `feature/F001`へpush済みである。GitHub CLIは未認証で、hosted/visibility・手動3環境の実証跡は未取得のため、候補SHA拘束を含む`QT-F001-019/020`全体はPARTIALとする。
# F002 適格性試験仕様ID機械照合

## T-029 実行前照合（2026-07-26）

- 対象仕様: `docs/tests/qt/QT-F002.md`
- 対象テスト: `src/**/*.test.ts`、`scripts/*.test.mjs`、`tests/e2e/*.spec.ts`
- 仕様ID: `QT-F002-001`〜`QT-F002-014`（14件）
- 初回直接照合: 5/14件、直接タグ不足9件
- 初回不足: `003`、`004`、`005`、`006`、`007`、`009`、`010`、`011`、`013`
- 対応: 既存の対応試験suiteへ直接トレースタグを追加した。さらに正規表現によるID存在確認だけでなく、各仕様の手順・期待結果と実oracleを照合した。試験ロジック、fixture、期待値は変更していない。
- 補完後の直接照合: **14/14件対応、未対応0件、余剰0件**
- 判定: QT実行前の仕様ID機械照合ゲートをPASSした。

| QT ID | 対応する主な自動試験 |
|---|---|
| QT-F002-001 | `src/content/f002-clean-release.integration.test.ts` |
| QT-F002-002 | `tests/e2e/f002-multi-author.spec.ts` |
| QT-F002-003 | `src/content/batch-production.test.ts` |
| QT-F002-004 | `src/content/processing.test.ts` |
| QT-F002-005 | `src/content/processing.test.ts` |
| QT-F002-006 | `src/content/batch-public.test.ts` |
| QT-F002-007 | `src/voice/voice-v2.test.ts` |
| QT-F002-008 | `tests/e2e/f002-multi-author.spec.ts` |
| QT-F002-009 | `src/notices/policy-snapshots.test.ts` |
| QT-F002-010 | `src/notices/artwork-provenance.test.ts` |
| QT-F002-011 | `scripts/f002-security.test.mjs` |
| QT-F002-012 | `src/content/batch-public.test.ts`、`src/content/f002-clean-release.integration.test.ts` |
| QT-F002-013 | `src/content/batch-command.test.ts` |
| QT-F002-014 | `tests/e2e/f002-multi-author.spec.ts`（4 browser・3 viewport・keyboard・semantic/ARIA・reduced motion）、`src/content/batch.test.ts`（FUN-003/037 journal回復）、`src/content/batch-public.test.ts`（FUN-019別process回復・`EBUSY/EPERM` 0/100/250/500 ms retry・超過rollback）、`src/content/batch-acceptance.test.ts`（FUN-033別process回復）、`src/content/batch-production.test.ts`と`src/content/batch-runtime.test.ts`（共通filesystem境界のWindows実junction/path安全性） |

仕様側とテスト側のID集合を`rg`で抽出し、`Compare-Object`の差分が0件であることを確認した。その後、IDごとに仕様の主要手順と期待結果を上表の実oracleへ意味的に照合した。正式PASS/FAILは`QT-F002-result.md`とexact candidate固定後のattempt生ログで判定する。

---

## F003 QT仕様ID機械照合

- 対象仕様: `docs/tests/qt/QT-F003.md`
- 対応表の実行コード: `src/content/f003-spec-coverage.test.ts`
- 対象ID: `QT-F003-001`〜`QT-F003-015`
- 対応済み: **15 / 15**
- 未対応・余剰・自動化不可: **0**

全項目をVitest、security checker、Playwrightの自動範囲へ対応付けた。手動・実機・目視・聴取・手動スクリーンリーダーは正式PASSの前提に含めない。

---

## F004 QT仕様ID機械照合

- 対象仕様: `docs/tests/qt/QT-F004.md`
- 対応表の実行コード: `src/content/f004-spec-coverage.test.ts` の `QT_MAP`
- 対象ID: `QT-F004-001`〜`QT-F004-016`
- 対応済み: **16 / 16**
- 未対応・余剰・自動化不可: **0**

| QT ID | 対応する主な自動試験 |
|---|---|
| 001〜003 | 固定baseline・承認文脈・権利証跡 |
| 004〜006 | 編集・候補集計・Catalog素材 |
| 007〜009 | 音声・容量・atomic受入 |
| 010〜012 | FinalCatalog・初期全閉・画像再利用 |
| 013 | セキュリティ・保存領域の異常系 |
| 014〜016 | 4ブラウザ範囲・お気に入り・音声分離 |

全項目を自動試験へ対応付けた。F004では手動確認を正式PASSの前提に含めず、exact候補へのVitest、security checker、Playwright 4範囲で判定する。
