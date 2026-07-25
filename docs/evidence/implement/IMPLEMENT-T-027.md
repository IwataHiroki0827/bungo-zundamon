# T-027 最終CatalogV2統合・release-verify証跡

## 判定

- タスク: T-027（F002最終catalog統合・F001不変・全asset整合）
- 対象feature / batch: F002 / F002
- 実装判定: PASS
- 独立受け入れ判定: ACCEPT
- 指摘: High / Medium / Low すべて0件
- 判定日: 2026-07-25
- exact release-verify commit: `00fed9a8e3f63534bde2ce427a0593e4b99bb73a`

## 公開ツリー

公式`prepare-release`でF001とF002を統合し、`public/`を原子的に更新した。F002のaccepted音声ソース152件には同一WAV SHAが1組あったため、accepted証跡を維持したまま公開ツリーではaudio ID順に決定的統合し、台詞参照とcandidate IDsを正規化した。

| 項目 | 実測 |
|---|---:|
| public files | 224 |
| public bytes | 81,641,935 |
| public build SHA-256 | `94538fdca8195f376b5351408e23cf5c990eaa267e7fbbf26ec89f40f42b2350` |
| 作者 | 2 |
| 作品 | 6 |
| 公開台詞 | 213 |
| 公開音声 | 208 |
| F002公開台詞 | 154 |
| F002 accepted音声ソース | 152 |
| F002 unique/public WAV | 151 |

F002の3作品はすべてacceptedで、編集除外13件、音声失敗0件である。公開ツリーには宮沢賢治ずんだもん画像1件、作品provenance 3件、review 3件、speech revision 3件を含め、source/public間のpath・SHA-256・bytesと全dialogue/audio参照を照合した。

## 不具合検出と根本修正

最終結合で次の4件を検出し、回帰試験付きで修正した。

1. F001専用data-integrity試験がCatalogV2全体を旧CatalogV1として読んでいた。F001 projectionと本番`loadAndVerifyF001Baseline` / `verifyF001Invariant`を使用し、F002実体joinを追加した。
2. provenanceが参照するreview / speech revision実体を公開ツリーへコピーしていなかった。公開builderでpath・SHAを検証してコピーするよう修正した。
3. release Pages previewがcanonical `releaseCandidateBatchId`をwork-preview用`batchId`へ誤変換していた。releaseでは`batchId/workId`を返さず、active work-previewだけが返すよう生成元を修正した。
4. release容量でworkspace全体をGit repository容量へ誤計上していた。non-object計測rootを`.git`へ限定し、`.git/objects`のpack/looseと未object化candidateは既存のOID重複排除計測を維持した。

各修正は修正前FAILを再現し、修正後の対象試験、型、lint、全suiteで回帰がないことを確認した。debugの独立受け入れはいずれもACCEPTだった。

## clean release-verify

exact clean commit `00fed9a8e3f63534bde2ce427a0593e4b99bb73a`で、公式コマンドを独立に2回実行した。

```text
npm run content:batch -- --batch F002 --stage release-verify --commit 00fed9a8e3f63534bde2ce427a0593e4b99bb73a
```

両実行ともexit 0、`status=completed`、`actualCapacityResult=pass`だった。再生成contentはtracked publicと224 files・81,641,935 bytes・SHA-256が完全一致し、実行前後で`public/`、HEAD、git statusは不変だった。

| 成果物 | files | bytes | SHA-256 |
|---|---:|---:|---|
| content/public | 224 | 81,641,935 | `94538fdca8195f376b5351408e23cf5c990eaa267e7fbbf26ec89f40f42b2350` |
| offline Pages dist | 227 | 81,718,235 | `ed53891e85ca567bd849c0d0181601fe6571714d7d2d9eca334831990cf7717d` |
| deterministic Pages artifact | - | 64,324,065 | `371aa41f9a6e52fc2900689b26404e23213a99d6cedf636cb4d2ad73b3b6b18d` |

F001 content invariantとF001 dist invariantはいずれも`pass`で、baseline SHA-256は`722b88affbc84a3e1250bcc1e2e6d538957a02d94483b706bb55609483b9fbc9`である。

## release容量

| 区分 | 実測 | 上限・下限 | 判定 |
|---|---:|---:|---|
| 追加音声 | 47,741,940 bytes | 104,857,600 bytes以下 | PASS |
| Pages artifact | 81,718,235 bytes | 786,432,000 bytes以下 | PASS |
| source repository | 145,406,059 bytes | 1,000,000,000 bytes未満 | PASS |
| 単一Git object | 64,324,065 bytes | 104,857,600 bytes未満 | PASS |
| 作業ドライブ空き | 40,535,539,712 bytes | 294,793,099 bytes以上 | PASS |

総合判定は`pass`、reasonsは空である。過去の814,330,905 bytes警告はignored workspaceを誤算入した値であり、Git実体だけを再計測した最終値へ置き換えた。

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS（227 files / 81,718,235 bytes）
- `npm run verify:build`: PASS
- release checks: 80 / 80 PASS
- data integrity: 8 / 8 PASS
- 全suite（1 worker）: 36 files / 651 tests PASS
- 通常並列suite: release-runtimeの5秒境界1件のみtimeout。対象単独はPASSしており、機能不具合ではないことを切り分けた
- `git diff --check`: PASS
- 独立T-027受け入れ: ACCEPT（High / Medium / Low 0件）
