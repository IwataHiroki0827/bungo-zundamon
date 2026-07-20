# T-020 実装・受け入れ証跡

## 判定

- タスク: T-020（CatalogV2・音声差分生成・accepted/public統合）
- 対象feature: F002
- 実装判定: PASS
- 独立受け入れ判定: PASS
- 判定日: 2026-07-20

## 実装内容

- CatalogV2とUI向け型、厳密schema・参照・件数・path検証を実装した。
- 音声設定のcanonical化、cache key、差分計画、容量承認、VOICEVOX生成、完全性検証を実装した。
- 音声artifactをpre-voice manifest、voiced manifest、stage record、生成・完全性digestへ結合した。
- accepted-audioのjournal付きatomic昇格と、共有音声参照、orphan隔離、実process停止からの回復を実装した。
- 複数batchの公開tree統合、累積work preview、F001不変照合、publicのjournal付きatomic昇格を実装した。
- 未知のpublic audio ownerをallowlist照合し、digest検査前にquarantineするfail-closed処理を実装した。
- production `content:batch` のvoice、accept、prepare-release、release-verifyを実処理へ接続した。
- release-verifyをcandidate tuple、実artifact SHA-256、再生成build SHA、tracked public byte一致へ結合し、read-onlyで検証するようにした。

## 重点回帰試験

- 正規CLIの `voice → voiced manifest保存 → accept` 成功連結
- 音声artifact、manifest、stage record、generation/completeness digestの混線拒否
- 共有音声の重複コピー防止とtree digest整合
- active workまでの累積preview prefix検証
- public/accepted transactionの実SIGKILL、stale lock、journal回復
- orphanおよび未知owner directoryのquarantine
- F003等の後続batchでも固定F002 pathを使わないこと
- release candidate artifact改変、別build SHA、別tupleの拒否
- release-verifyでpublic昇格を行わないこと

## 検証結果

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: 27 files / 482 tests PASS
- `npm run build`: PASS（66 files / 30,409,987 bytes）
- `npm audit --audit-level=high`: 0 vulnerabilities
- `git diff --check`: PASS（改行コード警告のみ）
- 独立受け入れ再試験: 関連9 files / 128 tests PASS

## セキュリティ確認

- workspace境界、canonical JSON、regular file、reparse point、最大サイズをartifact読込時に検証する。
- release候補artifactは実体をstream SHA-256で再計算し、candidate tupleと照合する。
- secret pattern scanの検出は、userinfo URLを拒否するための負例fixture 3件のみで、実認証情報は含まれない。
- Git認証情報をremote URL、文書、コミットへ含めていない。

## 受け入れ結論

受け入れ担当は、初回指摘6件、再指摘2件、未知owner隔離を実物で再確認し、最終判定をPASSとした。
