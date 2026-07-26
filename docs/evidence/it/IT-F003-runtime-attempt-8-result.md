# IT-F003 RuntimeAcceptance attempt 8

- 実施日: 2026-07-26
- 対象commit: `bb271bb37432d19e1d55de14576a3687e73a4290`
- 結果: **PASS**
- 独立再受入: **PASS（High 0 / Medium 0 / Low 0）**

## 4環境

| 環境 | PASS | skip | unexpected | flaky | 生レポートSHA-256 |
|---|---:|---:|---:|---:|---|
| Chromium | 21 | 0 | 0 | 0 | `22d460738e191a568c48cb31244bd73991665b8b04c6784ff1c2aef672379873` |
| Firefox | 20 | 1 | 0 | 0 | `efef1d6672eda64291cb78260cd6ac8a022b3846bdc1a1458f137c8c325732d4` |
| WebKit | 20 | 1 | 0 | 0 | `681b5fe79cdc5febf629857d127eec71869db922c1706326903149edd010a295` |
| Android相当 | 20 | 1 | 0 | 0 | `13e3c803b5116fa5f4c4b978f525e3cdcad6e4a628a2e03f402f924ca0af1c00` |

3件のskipはChromiumで一度実施した495公開アセット全件HTTP照合の重複省略である。画面、音声状態、初期全閉、3 viewport、keyboard、reduced motion、securityは4環境すべてで実行した。

## exact tuple

| 項目 | SHA-256 |
|---|---|
| content build | `cd92007ecdddaa0a4c2b3ec28fac07650cc42c17fa23a9ab77bc6ce5062410ea` |
| dist | `c1656d8e5514ee151310109cbc6601af4515ce47ca8b214bf3a83a9aa5c3c5a6` |
| test source | `09396201ac0720ed8f5d5943cfc8ad00e027d57f7bbe0752be15878e64c45cc5` |
| RuntimeAcceptance内部evidence | `59430a93ff8f3bab8e4dfc9f3f6a4dc202d1f8c9e685c50106d984d7ec642e78` |
| RuntimeAcceptance artifact | `a061abdfe49d3a41823bf3f6fb4a17133a60c282aa05c5bb20904538de49eefe` |

## fail-closed結合

`npm run test:f003-runtime`がbuild、静的検証、依存監査、4環境Playwrightを同じclean HEAD上で直列実行した。各環境の前後にHEAD、worktree、public tree SHAを再確認し、test sourceと4生レポートSHAをRuntimeAcceptance schema 1.1の内部hashへ結合した。release loaderによるpath実体、artifact SHA、schema exact、内部evidence hash、candidate tupleの独立再検証もPASSした。
