# QT-F005-008/009 CHG-F005-050 hosted attempt 2

- commit: `ab96442`
- implementation commit: `2d75f58d6595cfd0737ca4ceb470a40f733177c7`
- Program SHA-256: `20cbf87874aa0a2c93d0ce912aa0720f8a9c739940e379b7e1689b1886238b72`
- production: run `31233688210` FAILURE（期待した安全停止）
- Pages: run `31233688204` build failure / deploy skip
- failure progress: `audio-renamed`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: PASS

post-reservation write aggregateのlate candidateが2件以上となるhosted経路で、本変更の76文字固定codeへ到達した。候補内容や生値を公開せず、handoff、candidate保存、Pages公開へ進まないことを確認した。retry limit 3以内で対象へ到達したためT-124を完了する。
