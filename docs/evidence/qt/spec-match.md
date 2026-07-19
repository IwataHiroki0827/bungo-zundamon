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
