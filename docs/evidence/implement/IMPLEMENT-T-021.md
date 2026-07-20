# T-021 実装・受け入れ証跡

## 判定

- タスク: T-021（作者一覧・route・再生UI・クレジットの複数作者化）
- 対象feature: F002
- 実装判定: PASS
- 独立受け入れ判定: PASS
- 判定日: 2026-07-20

## 実装内容

- `parseRouteV2`と`resolveRoute`を実装し、固定作者slug unionを廃止した。
- 空hashはapplication境界でcanonical home routeへ正規化し、未知・重複・decode不能・追加segmentは安全なnot-foundへ変換した。
- CatalogV2からsemanticな作者一覧と作者別作品・台詞ページを描画し、作者・作品・台詞・音声・batch参照の混線をfail-closedにした。
- route変更時に描画より先に音声を停止し、`pause → currentTime=0 → removeAttribute('src') → stopped → 旧listener解除`の順序を実装した。
- 音声停止例外を`AUDIO_ROUTE_STOP_FAILED`へ内部隔離し、navigationを継続するようにした。
- `renderCreditsV2`で全作者・全作品の図書カード、底本、入力者、校正者、加工、provenance、規約、必須表示、画像hashを検証・表示した。
- `resolvePublicAssetV2`で公開root相対POSIX pathと同一origin/base配下URLを厳密検証した。
- F001の既存route・描画・クレジット経路は互換分岐で維持した。

## 重点回帰試験

- 256文字境界、decode不能、control、unsafe scalar、空・追加segment、scheme/protocol-relative route
- CatalogV2の一意slug解決、未知slug、重複slug
- 描画前音声停止のcall order、停止例外時のnavigation継続、古いmedia event通知抑止
- 2作者以上のsemantic list、表示文字列のtextContent化、encoded slug
- 作者別work/dialogue/audioの隔離、別作者参照・欠落・0作品の拒否
- 操作前の音声request 0件と44 CSS px以上の操作target
- 公開assetの先頭slash、空segment、dot、backslash、scheme、query、fragment、control、percent separator拒否
- 全作者・全作品credits、HTTPS安全link、規約期限、画像provenance/hash照合
- base URL直開きの空hash home表示とF001 UI互換

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: 29 files / 552 tests PASS
- `npm run build`: PASS（66 files / 30,423,361 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- 独立受け入れ再試験: 6 files / 173 tests PASS

## セキュリティ・依存事項

- DOM値は`textContent`、外部linkはcanonical HTTPSと`noopener noreferrer`、画像・音声は`resolvePublicAssetV2`だけを経由する。
- secret pattern scanの検出は、userinfo URLを拒否するための負例fixture 4件のみで、実認証情報は含まれない。
- 現在の公開実体はF001のまま。宮沢賢治の画像notice/provenance実体は依存先T-023で追加し、T-021の複数artwork消費側は欠落時fail-closedとする。

## 受け入れ結論

受け入れ担当はFUN-F002-020〜026の実装接続、F001互換、安全性、アクセシビリティ、操作前通信0件、credits完全性を実物で確認し、High/Medium不適合なしでPASSとした。
