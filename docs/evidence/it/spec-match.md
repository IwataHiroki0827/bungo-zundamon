# F001 結合試験仕様と実装済みテストの機械照合

## 照合結果（2026-07-19 T-010影響試験）

- 対象仕様: `docs/tests/it/IT-F001.md` の `IT-F001-001`〜`IT-F001-020`
- 対象実装: `src/**/*.{test,integration.test}.ts`、`scripts/*.test.mjs`、`tests/e2e/*.spec.ts`
- 照合方法: 仕様書と対象実装から正規表現 `IT-F001-[0-9]{3}` を抽出し、一意なID集合を比較した。
- 照合結果: **20/20件対応、未対応0件**
- 補完前: 15/20件。`IT-F001-001/003/004/016/017`は試験実装が存在したが、テストコード内にIT仕様IDがなかった。
- 補完内容: 該当する既存テストへ追跡コメントを追加し、補完後の再照合で20/20件を確認した。

実行した機械照合の要点は次のとおり。

```text
SPEC=20 IMPLEMENTED=20 MISSING=0
```

## 仕様ID別対応表

| 仕様ID | 対応するテスト・試験手順 | 区分 | 判定 |
|---|---|---|---|
| IT-F001-001 | `src/content/source.test.ts`（書誌選定・固定原典取得・由来記録） | 自動 | 対応 |
| IT-F001-002 | `src/content/source.test.ts`、`src/content/processing.test.ts`、`src/content/production.test.ts`（decode・抽出・正規化・再読込） | 自動 | 対応 |
| IT-F001-003 | `src/content/processing.test.ts`、`src/content/production-final.test.ts`、`src/ui/catalog-loader.test.ts`（レビュー・catalog・参照整合） | 自動 | 対応 |
| IT-F001-004 | `src/voice/voice.test.ts`、`src/content/production-final.test.ts`、`src/content/pipeline.test.ts`（VOICEVOX境界・差分cache・manifest） | 自動 | 対応 |
| IT-F001-005 | `src/content/pipeline.integration.test.ts`（11 stage fault matrix・rollback・診断・秘密非露出） | 自動 | 対応 |
| IT-F001-006 | `src/content/offline-build.integration.test.ts`（通信禁止build 2回・全file hash・変更局在） | 自動 | 対応 |
| IT-F001-007 | `tests/e2e/navigation-and-delivery.spec.ts`（Pages subpath・route・再読込・履歴・keyboard） | 自動 | 対応 |
| IT-F001-008 | `tests/e2e/audio-and-isolation.spec.ts`（遅延取得・pause/resume/stop・切替・ended） | 自動 | 対応 |
| IT-F001-009 | `tests/e2e/audio-and-isolation.spec.ts`（音声404/play拒否の局所隔離・別音声・再試行） | 自動 | 対応 |
| IT-F001-010 | `tests/e2e/responsive-accessibility-security.spec.ts`（3 viewport・keyboard・44px・構造検査） | 自動＋QT読上げ補完 | 対応 |
| IT-F001-011 | `tests/e2e/responsive-accessibility-security.spec.ts`、`src/notices/asset-integrity.test.ts`（reduced motion・画像代替・素材由来） | 自動＋QT目視補完 | 対応 |
| IT-F001-012 | `tests/e2e/responsive-accessibility-security.spec.ts`、`src/notices/notices.test.ts`（footer・credits・安全な外部リンク） | 自動 | 対応 |
| IT-F001-013 | `tests/e2e/responsive-accessibility-security.spec.ts`、`scripts/release-checks.test.mjs`（CSP・外部通信・Storage・安全DOM） | 自動 | 対応 |
| IT-F001-014 | `tests/e2e/audio-and-isolation.spec.ts`、`src/voice/voice.test.ts`、`scripts/release-checks.test.mjs`（遅延取得・容量境界） | 自動 | 対応 |
| IT-F001-015 | `tests/e2e/navigation-and-delivery.spec.ts`、`scripts/release-checks.test.mjs`（base配下200・参照整合） | 自動 | 対応 |
| IT-F001-016 | `scripts/release-checks.test.mjs`、`.github/workflows/pages.yml`（最小権限・event matrix・承認SHA拘束・visibility/hash chain） | 自動＋QT hosted補完 | 対応 |
| IT-F001-017 | `scripts/release-checks.test.mjs`（手動3環境・自動4範囲・hosted build・権利証跡の集約とblocker matrix） | 自動＋QT外部証跡補完 | 対応 |
| IT-F001-018 | `src/content/data-integrity.integration.test.ts`（67候補・59公開・audio/provenance全件join・変異検出） | 自動＋内容レビュー参照 | 対応 |
| IT-F001-019 | `tests/e2e/audio-and-isolation.spec.ts`（音声・画像障害隔離と主要導線維持） | 自動 | 対応 |
| IT-F001-020 | `npm test` → `npm run typecheck` → `npm run lint` → `npm run build` → `npm run test:e2e`を同一attemptで実行 | 自動＋QT最終判断 | 対応 |

## IT-F001-016/017の外部試験分離

ITでは、workflow本体の静的契約、event/deploy条件、承認前後のrelease/visibility hash chain、およびhosted証跡を受け取った際の検証をfixtureで自動化する。次の実外部状態は、このローカルIT attemptのPASS条件には含めず、`QT-F001-019/020`および外部証跡として分離する。

- private `feature/F001`へpushした候補commitのGitHub hosted Actions実行
- run URL、repository/run ID、head SHA、workflow SHA、artifact ID/digest、catalog hashの実値
- hosted build前後でdeploymentがなくPages hashが変化していないこと
- リリース判定ゲート④承認後のprivate→public、Pages有効化、承認SHA限定deploy、変数無効化の実監査chain

したがって、`IT-F001-016/017`のローカル自動契約は対応済みであり、hosted・visibilityの実証跡取得状況はQT結果で別途判定する。
