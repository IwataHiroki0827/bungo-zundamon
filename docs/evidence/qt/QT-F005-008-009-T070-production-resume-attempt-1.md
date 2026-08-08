# QT-F005-008/009 T-070 production resume attempt 1

- commit: `2e98a280ffaf5c54b2ea76c60a46ebdd4be3b8a4`
- Program SHA-256: `831f9ff4075af1113ee2b7338966042d145a3ea963a2da99732edbedb76e7a6b`
- production: run `31244948483` FAILURE（安全停止）
- Pages: run `31244948486` build failure / deploy `skipped`
- failure code: `F005_ETW_WRITE_COMPLETION_DRAIN_ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_AMBIGUOUS`
- candidate branch: 不存在
- 判定: 候補保存前のfail-closed。CHG-F005-056/T-130で複数適格候補の全適格・混在を固定診断する

T-109/T-110/T-112/T-122の決定的hosted相関完了後、最新guardでT-070 production candidateを再開した。build、kernel ETW、VOICEVOX取得、production pipeline、固定診断公開まではPASSし、fail-closed stepだけが意図どおり失敗した。候補選択、candidate branch作成、Pages deploy、`public/`・`data/`更新は行っていない。
