# IMPLEMENT-T-059 F004最終Catalog統合

## 結果

- 対象source commit: `00a684666683b344b0f4c9c295a83bcfe63c4ab7`
- 結果: `pass`
- 最終content build SHA-256: `38fd2142b2c9da5a727d400b0858b0de4e426b05365f5e3bf877a6e764a5ec81`
- 最終Catalog SHA-256: `857401c774ed8dabaaf0e67d8f3e5f710a83fa1fefcd9965498590aab629f6e5`
- 最終dist SHA-256: `c542f435f0adb27cd253788680b58baf102f61fbec33a91d73087bb07d40b8b9`
- 統合report SHA-256: `781f5b97d68ff1837057c088e62406b25c1839d9fa766dd837258eab0cb2f704`

## 統合内容

- `FinalCatalogFragment → FinalCatalog`だけを使用し、preview brandを最終統合へ流用しなかった。
- 固定F001、固定v0.3.0のF002/F003、accepted F004をbatch定義と永続artifactから再構築した。
- 3作者、12作品、674台詞、662音声、694 contentファイル、697 distファイルを参照と実体で逆joinした。
- F004は212候補のうち202件を公開対象、10件を編集除外、音声除外0件とした。
- F004の202台詞を199個の一意音声へ対応した。
- 宮沢賢治の作品順は既存3作品の直後に「オツベルと象」「雪渡り」「カイロ団長」を追記した。

## 既存公開不変

- 固定v0.3.0 content tree SHA-256: `cd92007ecdddaa0a4c2b3ec28fac07650cc42c17fa23a9ab77bc6ce5062410ea`
- 固定v0.3.0 descriptor SHA-256: `9f8b7b4511e295f83e0d5870fadac9985b78d3ca50ea86e163e546ffdbcbdf81`
- F001 baseline SHA-256: `722b88affbc84a3e1250bcc1e2e6d538957a02d94483b706bb55609483b9fbc9`
- 既存作者・作品・音声・batch projection不一致: 0件
- 宮沢賢治画像はF002の実体・SHA・creditをexact再利用し、新規画像entryは0件
- 既存`public/`差分: 0件

## 検証

- 最終統合production script: PASS
- Vitest: 57 files / 931 tests PASS
- TypeScript: `tsc --noEmit` PASS
- ESLint: warning 0 / error 0
- 現公開版production build: 495 files / 164,323,640 bytes PASS
- C:空き容量: 約66.29 GiB

## 独立受け入れ

- 判定: PASS
- 重大度: High 0 / Medium 0 / Low 0
- 指定commitから別の一時領域へFinalCatalog、content、distを再構築し、全報告hashの差分0を確認した。
- 全作者画像、全作品provenance、全dialogue音声参照、全662音声fileのSHA・bytesを独立照合し、欠落0を確認した。
- 対象4 test files / 43 tests、typecheck、対象lintを独立実行してPASSした。
