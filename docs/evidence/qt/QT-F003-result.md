# QT-F003 実施結果

- 実施日: 2026-07-26
- 現在判定: **QT-F003-001〜013・015 PASS、QT-F003-014は段階公開待ち**
- 仕様ID照合: 15/15件対応、未対応0件、余剰0件
- 手動・実機・目視・聴取: 必須証跡に含めない

## source候補の適格性

| 範囲 | 結果 |
|---|---|
| 固定F001/F002不変 | PASS |
| F003候補・権利・原典・抽出 | PASS |
| 独立編集判定・読み補正 | PASS |
| 差分音声・完全性・容量 | PASS |
| 3作品atomic受入・復旧 | PASS |
| Catalog・注意・credit・画像由来 | PASS |
| 初期全閉・音声状態遷移 | PASS |
| security・4環境・3 viewport | PASS |
| 仕様ID網羅 | UT 29/29、IT 14/14、QT 15/15 |

## 実測

- 統合: 3作者、9作品、472台詞、463音声、492公開ファイル
- F003: 282候補、259公開対象、23編集除外、255一意音声
- production build: 495ファイル、164,314,350 bytes
- ブラウザ: 81 PASS、3重複検査skip、unexpected 0、flaky 0
- 依存脆弱性・静的security・ビルド参照: T-044開始前にexact clean commitで再検証する

## 判定

QT-F003-001〜013・015はsource候補でPASSとする。QT-F003-014のうち4環境・3 viewport・keyboard・reduced motionはPASS済みであり、残るhosted artifact一致、GitHub Pages段階deploy、公開5 route・Catalog・画像・音声smoke、deploy変数無効化をT-044で実行して正式判定する。
