# QT-F005-008 CHG-F005-036 hosted follow-up attempt 2

- commit: `4212624b13cdf6875b5228f5e370dd36a44eb36d`
- Program SHA-256: `c3ac87d7f894f1723adee5f55555c03efb9b0a3c3c803c47fa682a50966231fc`
- production: run `31236169870` FAILURE（安全停止）
- Pages: run `31236169869` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: T-110対象未到達 / T-125後続PASS

attempt 2はcompletion drainのCHG-F005-051固定codeで安全停止し、T-110のbound-directory限定再結合を通過したことは証明できなかった。candidate保存・公開は行っていない。同一runをT-125の後続hosted到達証拠として採用し、T-110は同一pinの最終attempt 3へ継続する。
