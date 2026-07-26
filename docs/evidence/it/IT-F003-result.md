# IT-F003 実施結果

- 実施日: 2026-07-26
- 対象content候補: `5e0c171`
- 現在判定: **source・predeploy範囲PASS、IT-F003-012のexact hosted verificationはT-044で確定**
- 仕様ID照合: 14/14件対応、未対応0件、余剰0件
- 手動確認: 必須証跡に含めない

## 自動ブラウザ試験

| 環境 | 結果 | 時間 |
|---|---:|---:|
| Chromium | 21 PASS / 0 skip | 32.4秒 |
| Firefox | 20 PASS / 1 skip | 43.6秒 |
| WebKit | 20 PASS / 1 skip | 49.1秒 |
| Android相当（Pixel 7 / Chromium） | 20 PASS / 1 skip | 29.5秒 |
| 合計 | **81 PASS / 3 skip / 0 fail** | 154.5秒 |

Firefox・WebKit・Android相当で省略した1件は、164 MiBの全公開アセットを逐次HTTP照合する同一検査である。Chromiumで495ファイルすべてを検査し、他環境では画面・遷移・音声・セキュリティ・3 viewportを省略せず実行した。

| 生ログ | SHA-256 |
|---|---|
| `IT-F003-chromium-attempt-3.json` | `814480597881d2a653706054c87dfbcadd2cb71034d01bb44b05cb0edd088321` |
| `IT-F003-firefox-attempt-3.json` | `c0be0d21c39e69b0ee112662a156284cab9a11f8eaa6a1c10cb9b41e8af970df` |
| `IT-F003-webkit-attempt-3.json` | `6aa4ba86b0b3bdf28ab178ecfed42a7e69da16de1e57f5671fe7f2495008358f` |
| `IT-F003-android-attempt-3.json` | `97b0682854a46eaf2c1cf7eaf17fb36b3990625abfbaaa139ee23d660d1bc11e` |

## 確認内容

- 3作者・9作品・472台詞を作者ごとに分離した。
- 5 routeを直接表示・再読込・履歴移動できる。
- 全作者routeの初期`details.work-panel[open]`は0件で、pointerまたはkeyboard操作後だけ展開する。
- 390×844、844×390、1440×900でoverflow、keyboard操作、44px targetを確認した。
- reduced motion、音声切替、遅延event、404隔離を確認した。
- 外部通信、CSP違反、Cookie、storage、formは0件だった。

## 判定

IT-F003-001〜011・013〜014のsource・predeploy範囲をPASSとする。IT-F003-012は同じ実装で異常系を自動検証済みだが、正常系のhosted artifact・release commit・公開smokeはT-044の段階公開後にexact tupleへ結合して正式確定する。

## RuntimeAcceptance

attempt 8でclean commit `bb271bb`上の4環境を同一runner内で再実行し、生レポート4件、test source、public、distをRuntimeAcceptance schema 1.1へhash結合した。独立再受入はHigh/Medium/Low 0件でPASSした。詳細は`IT-F003-runtime-attempt-8-result.md`と`IT-F003-independent-acceptance.md`を参照する。
