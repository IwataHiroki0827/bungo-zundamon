# CHG-F001-003 検証結果

実施日: 2026-07-19

## 結果

- 原典抽出: 羅生門15件、蜘蛛の糸3件、杜子春49件、合計67件。
- 編集レビュー: revision 2で67件を全件判定し、59件承認、8件除外、pending 0件。
- 除外内訳: `QUOTED_MATERIAL` 5件、`EXPRESSION_EXAMPLE` 3件。
- 公開catalog: 羅生門8件、蜘蛛の糸3件、杜子春48件、合計59件。
- 音声: 57の一意な音声資産を生成し、成功57件、失敗0件。重複する同文音声は共有参照する。
- 『蜘蛛の糸』: 指定された内心、`「しめた。しめた。」`、罪人への発話の3件を公開catalogで確認した。
- 表示: `displayText`をそのままDOMへ描画し、`「「…」」`を生成しないことを完全一致試験で確認した。

## 実行した検証

- `npm test`: 19ファイル、301/301件PASS。
- `npm run typecheck`: PASS。
- `npm run lint`: PASS。
- `npm run build`: PASS（production 66ファイル、30,402,118 bytes）。
- Playwright: Chromium、Firefox、WebKit、Chrome stable、Edge stableで各13件、合計65/65件PASS。
- `trace_check.py --feature F001`: 対応漏れなし。
- 設計・試験仕様の独立再レビュー: High 0、Medium 0、PASS。Low 2件はDDの除外理由列挙とITの件数期待値明記として反映済み。
- 実物ベース独立受け入れ: High 0、Medium 0、Low 0、PASS。原典から公開DOMまでの件数・ID・hash・参照と5ブラウザ65件を再検証した。

## リトライ

初回E2Eで、レビュー追加台詞の`order=0`をブラウザ側validatorが拒否する不整合を検出した。validatorを0以上の整数へ修正し境界値試験を追加後、5ブラウザ65件を再実行して全件PASSした。

## 配信確認

- `http://localhost:4173/bungo-zundamon/`: HTTP 200。
- `http://192.168.11.61:4173/bungo-zundamon/`: HTTP 200。
