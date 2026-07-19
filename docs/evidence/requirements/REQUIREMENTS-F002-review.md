# F002 要求仕様・適格性試験仕様レビュー証跡

## 判定

- 最終判定: PASS
- High: 0件
- Medium: 0件
- Low: 0件
- 対象: `DOMAIN-F002.md`、`SRS-F002.md`、`QA-F002.md`、`QT-F002.md`
- レビュー担当: `pf-reviewer`（読み取り専用）
- レビュー日: 2026-07-20

## 初回レビュー

初回判定はREDOで、High 0件、Medium 2件、Low 2件だった。

| 重大度 | 指摘 | 対応 |
|---|---|---|
| Medium | 公開総量の算入範囲、1 GBのbyte定義、Git source repository容量が未定義 | 新規WAV、最終Pages artifact全体、Git object storeを別々に計測するようSRS/QTへ定義した。MiBは2進、GitHubの1 GBは安全側で10進1,000,000,000 bytesとし、source repositoryの警告・停止境界も追加した |
| Medium | 青空文庫、VOICEVOX、ずんだもん、画像規約の2時点確認が検証可能でない | canonical URL、取得日時、版またはsnapshot SHA-256を選定時とdeploy直前に保存・比較し、変更時の影響再レビューが未完了なら公開停止するREQ/QTへ修正した |
| Low | DOMAINの「750 MiB停止」が境界上曖昧 | 750 MiBちょうどは警告、750 MiB超で停止へ統一した |
| Low | F001不変比較の基準releaseが未固定 | `v0.1.0`、commit `2733b5fd368e847a01708724511f993f5e1b2484`、catalog SHA-256 `5125e1c788adf95d247eae6c072e2afe010937b9af78cb292effbdf31649f1c1`へ固定した |

## 再レビュー

修正後の再レビューで、次を確認してPASSと判定した。

- 新規WAV、最終Pages artifact全体、Git source object storeの算入範囲が分離されている。
- 100/500/750 MiB、1,000,000,000 bytes、source repositoryの750,000,000/1,000,000,000 bytes境界がSRSとQTで一致している。
- 規約4系統は選定時とdeploy直前に証跡化し、未判定変更時は公開を停止する。
- F001基準はtag、commit、catalog hashで固定されている。
- 20件のREQは14件のQTからすべて追跡でき、REQ→QT未追跡は0件である。
- 未回答QAは0件で、要求承認に追加のユーザー入力を要しない。

再レビュー時に残ったDOMAIN要約のLow 1件は、「750 MiB停止」という略記を削除し、公開物とsource repositoryを別々に機械検査する記述へ修正した。

## 参照した一次情報

- GitHub Pages利用制限: https://docs.github.com/pages/getting-started-with-github-pages/github-pages-limits
- GitHub大容量ファイル: https://docs.github.com/repositories/working-with-files/managing-large-files/about-large-files-on-github
- 青空文庫収録ファイルの取り扱い規準: https://www.aozora.gr.jp/guide/kijyunn.html
- VOICEVOXソフトウェア利用規約: https://voicevox.hiroshiba.jp/term/
- ずんだもん音源利用ガイドライン: https://zunko.jp/con_ongen_kiyaku.html
- ずんずんPJキャラクター利用ガイドライン: https://zunko.jp/guideline.html

## トレーサビリティ

`trace_check.py --feature F002 --no-impl`の結果、REQ→QT未追跡は0件である。REQ→DESの20件は設計前の予定差分であり、承認ゲート①後の`pf-design`で解消する。
