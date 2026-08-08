# QT-F005-008/009 CHG-F005-052 hosted attempt 1

- source commit: `9a2ca7caae5e7cb890f368cd297a852f415e3978`
- hosted native correlation: run `31239134299` FAILURE（evidence相関stepの構文エラー）
- Pages: run `31239134301` build failure / deploy skip
- production build: PASS
- kernel ETW preflight: PASS
- T-110 target suite: 57 / 57 PASS、final marker 1件
- failure code: PowerShell parser `The ordered attribute can be specified only on a hash literal node.`
- candidate branch: 不存在
- 判定: hosted canonical evidence未確定

production共有規則、実load assembly target、kernel ETWはすべてPASSした。最後のread-only Pages相関stepで`[ordered]@{...}.GetEnumerator()`の括弧が不足し、script parse時に停止した。認可・target・Pages・candidate保存条件は変更せず、`([ordered]@{...}).GetEnumerator()`へ構文修正してattempt 2を実行する。
