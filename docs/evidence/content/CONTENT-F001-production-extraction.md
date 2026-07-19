# F001 公式原典取得・候補抽出エビデンス

- 実行日時: 2026-07-18T10:48:04.758Z
- 実行コマンド: `npm run content:update`
- 結果: 成功（書誌1件、選定3作品、原典3件、抽出・正規化67候補）
- 編集判断: 未実施。67件すべてを`pending`下書きとして保存した。
- 正規化候補集合SHA-256: `6b94e34718be96f336dc1045aaf4ce6f3d770f3fd492c902fa80b2ff7fa67698`

## 公式書誌snapshot

- URL: `https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip`
- ZIP: 2,092,030 byte / SHA-256 `069280a4aa17ac2d382605dc4d189d1bde8762973324cd832e4ddf391dc82af0`
- CSV: 17,153,006 byte / SHA-256 `28d37d3d5f94e4d3c8f7838944b076ff854c47f8cb29c533fd69ada7cd2920a0`
- 固定entry: `list_person_all_extended_utf8.csv`
- schema version: `e2eee6da997acefd`

## 作品別結果

| 作品ID | 作品 | 固定XHTML | raw SHA-256 | 候補数 | pending数 |
|---|---|---|---|---:|---:|
| `000127` | 羅生門 | `127_15260.html` | `96aa53761067394c36b615f964dd7f8af563f09aebcc6ee0c2b3c46b6038d832` | 15 | 15 |
| `000092` | 蜘蛛の糸 | `92_14545.html` | `47cdc4b16202cc9556107e0b7bf86fc7c831e140dd8894ce93fa7425eadce419` | 3 | 3 |
| `043015` | 杜子春 | `43015_17432.html` | `0821579c417019050305c6c80753b2ccdac5cb3a9ef9c0228aff903c0af52b16` | 49 | 49 |

## 再現契約

- 正規化文hash: `sha256(UTF8(JSON.stringify([displayText,speechText])))`
- candidateId: 作品ID、raw source hash、token range、抽出器版、正規化器版、正規化文hashのcanonical tupleから生成する。
- 詳細な由来metadata、件数、artifact一覧は`CONTENT-F001-production-extraction.json`と`content/provenance.json`に保存した。
