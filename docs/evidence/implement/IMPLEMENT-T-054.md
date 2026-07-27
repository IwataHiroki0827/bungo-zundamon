# T-054 実装証跡

- 対象: F004候補manifest・固定v0.3.0 baseline・権利原典
- 実施日: 2026-07-27
- 判定: PASS

## 実装内容

1. `content/batch-candidates.json`へ宮沢賢治の既存作者identityを再利用するF004候補を追加した。
2. Q-022/Q-023、SRS-F004、QT-F004、CHG-F004-001を`docs/evidence/requirements/F004-approval-binding.json`へSHA-256結合した。
3. F003単一承認との互換性を維持しつつ、F004の複数承認・文書state・文書順をproduction側静的policyで検証するようにした。
4. 3作品が`draft`かつ全件`pending`の`content/batches/F004/batch.json`を、検証済み承認から生成した。
5. v0.3.0のrelease commitと公開後control commitを分離した固定descriptorとloaderを追加した。
6. 青空文庫の公式書誌snapshotと図書カードから、作品ID・新字新仮名・権利・著者役割・翻訳者なし・XHTML URLを3作品分固定した。
7. production transportで3 XHTMLを取得し、raw SHA-256・byte数・Shift_JIS fatal decode・`.main_text`本文selectorを再検証した。
8. canonical definitionへ3作品のID・題名・順序・カードURL・本文URLをexact tupleとしてSHA固定し、caller作成registryやclone済みcontextからの迂回を拒否した。
9. 公開v0.3.0 Catalog上の宮沢賢治identityへexact joinし、既存作者再利用を検証した。
10. selection時とpredeploy時の権利再検証、およびproduction transport取得結果のatomic固定を実施した。

## 固定原典

| 作品 | work ID | 図書カード | XHTML | raw SHA-256 | bytes |
|---|---|---|---|---|---:|
| オツベルと象 | `000466` | `https://www.aozora.gr.jp/cards/000081/card466.html` | `https://www.aozora.gr.jp/cards/000081/files/466_42316.html` | `efd6aff174b43bd1d8bb7b286cf0a123a38e09f74fec55a5b7cc6482866713f1` | 20,945 |
| 雪渡り | `045679` | `https://www.aozora.gr.jp/cards/000081/card45679.html` | `https://www.aozora.gr.jp/cards/000081/files/45679_22349.html` | `560e17f0b40cab7f4623634d0e01dcf183aa248b334dd0e0504b39421c379ad4` | 25,777 |
| カイロ団長 | `001918` | `https://www.aozora.gr.jp/cards/000081/card1918.html` | `https://www.aozora.gr.jp/cards/000081/files/1918_18512.html` | `b880ad3ea0a0ef4f2d183b2bc91e4c530939f8bf925f76180d96255537499ef4` | 28,511 |

## 固定v0.3.0

- release commit: `79d12825b83459b92da58e14a32f853bae6d92d9`
- tag: `v0.3.0`
- control commit: `5a1a06a0af729e725ce962826268fd4223b88669`
- F003 published manifest SHA-256: `b26a06c6cbab039a91e24a95150a29d92688256ef9923d1e3b0b7f4612b45a2e`
- catalog SHA-256: `591b127e62e4c7686f3a47dc1476426185fe0c825e9092af892cd00e62d97769`
- dist SHA-256: `c1656d8e5514ee151310109cbc6601af4515ce47ca8b214bf3a83a9aa5c3c5a6`
- production artifact: 495 files / 164,314,350 bytes
- production artifact digest: `aa103dfb5e323aa1d4f78fd42a7fd6d37b393077e05a0ed89bf2f5bd811a23e5`

## 自動検証

- `npm test`: 52 files / 880 tests PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `git diff --check`: PASS
- F004対象試験: candidate/approved-context/baseline/source 27件 PASS
- `pf-acceptor`再受入: PASS（旧API迂回、候補tuple改ざん、baseline、production transport、atomic固定を実物確認）

手動・物理実機・目視・聴取は、承認済み方針により判定へ含めない。
