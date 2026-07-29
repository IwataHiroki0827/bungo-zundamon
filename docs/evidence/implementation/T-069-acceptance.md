# T-069 実装受け入れ証跡

## 判定

- 対象: nullable書誌・夏目Catalog・独自画像・route・お気に入り統合
- 実装commit: `03691851b0593a8c7bed5e988b6302daf62f33e4`
- 判定: PASS
- 独立受け入れ: High 0 / Medium 0 / Low 0
- 判定日時: 2026-07-29T12:59:43+09:00

## 実装結果

- `CatalogSourceV2`、UI loader、作者・作品表示、creditsを`proofreader: string | null`へ対応させた。
- `null`はF005「夢十夜」`000799`だけで受理し、画面とcreditsでは「記載なし」と表示する。既存作品およびF005の他2作品は従来どおり非空文字列を必須とする。
- 夏目漱石を新作者として追加するwork-preview/final Catalog projector、既存3作者・12作品projection保護、exact 7 route導出を実装した。
- final Catalog、画像provenance、画像受入はWeakSetでmintされた実体だけをproductionで受理し、構造clone、getter、prototype、preview、空Catalog、自己申告hashを拒否する。
- 通常の作者ページ遷移では作品を全件閉じ、お気に入りからのone-shot移動時だけ対象作品を1件開く。お気に入り操作による自動再生は行わず、route変更時は単一AudioControllerを停止する。
- T-068後のregistry移行試験は、固定した移行前commitからfixtureを再構築するよう修正し、実registry統合後も15件すべて再現可能にした。

## 独自画像と来歴

- 生成手段: OpenAI built-in `image_gen`
- 入力・参照画像: 0件
- 加工: なし。生成原本とF005正本はbyte-for-byte同一
- 配置: `content/batches/F005/public-files/artwork/natsume-zundamon.png`
- サイズ: 1254 x 1254、2,921,223 bytes
- SHA-256: `79f5e9b49446a29bdd6793cdaf6eee22e57974a60e5b90e1fa126502bdc61e9b`
- dHash64-v1: `654b8f8adc692684`
- 既存画像とのHamming距離: 芥川37、宮沢33、太宰28。全て拒否閾値8を超える。
- 来歴正本: `content/batches/F005/artwork-provenance.json`
- 来歴seal SHA-256: `cc2cd3af9a05d1b650e5c136499cc9af90338b209710a598899cf2770e8d2fcb`
- OpenAI利用規約と東北ずん子・ずんだもんのキャラクター利用ガイドラインを、それぞれURL、取得時刻、本文SHA-256付きで固定した。
- 実際に使用した全文prompt、negative prompt、生成時刻、原本SHA、最終SHA、credit、author identity、approval bindingをcanonical JSONへ保存した。
- 画像を目視確認し、文字・署名・透かし・ロゴ・実在人物の写実的類似・第三者素材・不自然な手がないことを確認した。

## 検証結果

- 全回帰: 65 test files / 1,105 tests PASS（`--maxWorkers=1`）
- T-069重点回帰: 11 test files / 310 tests PASS
- registry移行fixture回帰: 15 / 15 PASS
- 独立受け入れ回帰: 196 tests PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS、697 files / 229,936,251 bytes
- `npm audit --audit-level=high`: 脆弱性0
- `trace_check.py --feature F005`: coverage 100%、対応漏れ0
- `git diff --check`: PASS

## 非変更範囲

- T-069では公開`public` tree、公開Catalog、公開画像、公開音声、公開routeを変更していない。
- 夏目漱石の画像とCatalogはF005 batch正本にあり、3作品の作品単位受入と最終統合が完了するまで公開しない。
- 完了時のC:空きは46,142,918,656 bytes（42.97 GiB）で、5 GiB停止基準を上回る。T-070の音声生成直前に再計測する。
