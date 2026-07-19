# QT-F001 実施結果

- 最終更新: 2026-07-19T22:15:00+09:00
- 全体判定: **PASS（iOS Safari詳細証跡不足はプロジェクトオーナーが明示受容）**
- TestResult集計: **PASS 20件 / PARTIAL 0件 / NOT RUN 0件**

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
- 実行対象: private `feature/F001`候補commit `5337d2752e5a288b8d3078c2d1d133ebdef6ed21`
- catalog SHA-256: `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`

## BrowserRiskDecision

Firefox、WebKit、Android相当はいずれも`triggers: []`、`requiresDeviceTest: false`と判定した。

- 4範囲で同一13ケースがPASSし、`automated-failure`はない。
- repository内の証跡に未解決の`open-browser-defect`記録はない。
- navigation、音声状態、responsive、accessibility構造、reduced motion、クレジット、CSP・外部通信で`behavior-difference`を検出しなかった。
- 詳細は`docs/evidence/qt/QT-F001-browser-manual.md`に記録した。

## PASS（20件）

`QT-F001-001`〜`QT-F001-020`。自動試験、hosted証跡、Windows Chrome/Edge実チャンネル、規約・クレジット確認を根拠とする。iOS Safariおよびスクリーンリーダーの詳細な環境・操作・画像証跡は未取得だが、2026-07-19のユーザー指示「今回はすべてokにして次に進めてください」をプロジェクトオーナーによる当該リリース限りの残余リスク受容として記録し、リリース判定へ進める。

## 外部状態

### HostedBuildEvidence

**PASS**。Git Credential Managerの認証をプロセス内だけで利用し、GitHub REST APIから候補run `29672450957`、artifact `8437750946`、digest、artifact内catalog hash、deploy skipped、deployment 0件を確認した。制御失敗runはattempt 1のfixture不備を保持した上で、attempt 2のrun `29684314188`で専用fixture 1件だけの失敗と非deployを確認した。詳細は`docs/evidence/qt/QT-F001-github-api-evidence.md`。

### VisibilityPlanEvidence

**PASS**。repository ID `1304106620`、`private=true`、Pages未構成（before/after 404・canonical hash不変）、`PAGES_DEPLOY_ENABLED`と`PAGES_DEPLOY_COMMIT`が未設定であることをread-only APIで確認した。

### 手動3環境

Windows Chrome `150.0.7871.127`とEdge `150.0.4078.83`は、Windows 11 Home build 26200でネイティブHTML Audio、3 viewport、全音声操作、CSP・外部通信0件を確認し、8枚のPNG証跡を保存して**PASS**した。iOS Safariは端末名・iOS/Safari版・縦横画像・操作別結果が未記録である。プロジェクトオーナーがこの不足を理解した上で当該リリース限りの例外受容を明示したため、環境差分をゲート④へ開示した状態で**PASS（例外受容）**とする。詳細は`docs/evidence/qt/QT-F001-q009-browser-evidence.md`。

## 過去回答の扱い

- Q-005の10件PASS申告は、版・操作・画面証拠・hosted URL/digestが不足し、一部メモがPASSと矛盾したため実機PASSへ転記していない。
- Q-008の`motion_clarity`は具体的メモを伴うため、`QT-F001-015`の目視PASSとして受理済みである。
- Q-007で手動必須をWindows Chrome/Edge・iOS Safari、自動継続をChromium/Firefox/WebKit・Android相当へ変更済みである。

## 例外受容

- 対象: iOS Safariの端末・版・縦横画像・操作別結果・通信証跡、およびスクリーンリーダー詳細証跡。
- 根拠: 2026-07-19のプロジェクトオーナー直接指示「今回はすべてokにして次に進めてください」。
- 扱い: 本リリースの進行を妨げない残余リスクとして受容する。実施済みと偽装せず、リリース承認ゲート④の環境差分へ明記する。
