# QT-F001 実施結果

- 最終更新: 2026-07-19T12:45:05+09:00
- 全体判定: **BLOCKED（手動3環境・hosted・visibility実証跡待ち）**
- TestResult集計: **PASS 11件 / PARTIAL 9件 / NOT RUN 0件**

## T-010影響試験（attempt 4）

`QT-F001-020`で承認された自動4範囲を独立したPlaywright projectとして実行した。Android相当はattempt前にPixel 7相当projectを補完した。

| 範囲 | 結果 |
|---|---:|
| Chromium | 13/13 PASS |
| Firefox | 13/13 PASS |
| WebKit | 13/13 PASS |
| Android相当（Pixel 7 / Chromium） | 13/13 PASS |
| 合計 | **52/52 PASS** |

- FAIL: 0件
- retry: 0件
- hang: 0件
- 生ログ: `docs/evidence/qt/QT-F001-automated-attempt-4.log`
- ログSHA-256: `72ee3c8adfedb97a7299aa8286fbad936e4ffb65f84f424034f4eff11cf40c15`
- 実行対象: working tree base HEAD `cdaecbad5b6ecf9c0fb2b78fd671547fa4f55c61`（未コミット変更を含む）
- catalog SHA-256: `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`

## BrowserRiskDecision

Firefox、WebKit、Android相当はいずれも`triggers: []`、`requiresDeviceTest: false`と判定した。

- 4範囲で同一13ケースがPASSし、`automated-failure`はない。
- repository内の証跡に未解決の`open-browser-defect`記録はない。
- navigation、音声状態、responsive、accessibility構造、reduced motion、クレジット、CSP・外部通信で`behavior-difference`を検出しなかった。
- 詳細は`docs/evidence/qt/QT-F001-browser-manual.md`に記録した。

## PASS（11件）

`QT-F001-002`〜`QT-F001-007`、`QT-F001-010`、`QT-F001-012`、`QT-F001-015`、`QT-F001-016`、`QT-F001-018`。

## PARTIAL（9件）

- `QT-F001-001`: 自動導線PASS、手動3環境の画面証拠待ち
- `QT-F001-008`: 遅延取得の自動PASS、手動3環境待ち
- `QT-F001-009`: 音声操作の自動PASS、手動3環境待ち
- `QT-F001-011`: 全route・クレジット表示の自動PASS、手動画面証拠待ち
- `QT-F001-013`: 3 viewport・Android相当自動PASS、手動3環境待ち
- `QT-F001-014`: 構造・keyboard・44px自動PASS、手動確認待ち
- `QT-F001-017`: local CSP・通信・Cookie・Storage・表示PASS、本番確認待ち
- `QT-F001-019`: workflow静的契約PASS、候補push後のhosted run・visibility/hash chain待ち
- `QT-F001-020`: 自動4範囲52/52 PASS、BrowserRiskDecision 3件完了。候補SHA一致の手動3環境、hosted、visibility実証跡待ち

## 外部状態（未完了）

### HostedBuildEvidence

**NOT RUN**。working treeが未コミットで候補SHAが確定しておらず、GitHub CLIも未認証である。run URL、artifact ID/name/digest、artifact内catalog hash、deployment不在、Pages hash before/afterを取得していない。

### VisibilityPlanEvidence

**NOT RUN**。repository ID/URL、private、Pages無効、`PAGES_DEPLOY_ENABLED=false`、`PAGES_DEPLOY_COMMIT=null`をread-only実観測していない。承認前状態を推測でPASSにはしない。

### 手動3環境

**NOT RUN**。Windows Chrome、Windows Edge、iOS Safariについて、候補commit/catalog hash一致、OS/browser版、操作結果、CSP・通信、画面または動画証拠、判定者が未取得である。

## 過去回答の扱い

- Q-005の10件PASS申告は、版・操作・画面証拠・hosted URL/digestが不足し、一部メモがPASSと矛盾したため実機PASSへ転記していない。
- Q-008の`motion_clarity`は具体的メモを伴うため、`QT-F001-015`の目視PASSとして受理済みである。
- Q-007で手動必須をWindows Chrome/Edge・iOS Safari、自動継続をChromium/Firefox/WebKit・Android相当へ変更済みである。

## 完了条件

1. リリース候補をprivate `feature/F001`へcommit/pushし、同じ候補SHAでhosted Actionsを成功させる。
2. HostedBuildEvidenceとVisibilityPlanEvidenceをrepository/SHA/catalog/Pages hashで結合する。
3. Windows Chrome、Windows Edge、iOS Safariの手動3環境を候補SHA一致で実施する。
4. 外部証跡取得後に自動4範囲を候補commitへ再拘束し、`QT-F001-019/020`を最終判定する。
