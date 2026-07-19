---
phase: design
feature: F002
updated: 2026-07-20T07:28:00+09:00
next_actions:
  - "ProjectFactory画面でQ-013の設計承認を1回押す"
  - "承認後、T-018でUT-F002・IT-F002を作成してDES→UT/ITの16 gapを閉じる"
  - "テスト仕様レビューとゲート③を経てF002実装へ進む"
blocked_by:
  - Q-013
---

# 文豪ずんだもん 状況把握ドキュメント

## 現在の状況

- F001はv0.1.0として公開・クローズ済み。
- F002の要求仕様・QTは承認済み、環境整備も完了している。
- FD-F002はREQ 20件をDES 16件へ、DD-F002はFUN 40件へ展開した。
- 整合性・実現可能性・セキュリティの3観点レビューは最終High 0 / Medium 0 / Low 0でPASSした。
- T-016とT-017はdone。T-018は設計承認Q-013待ちでblocked。

## 設計で確定した要点

- 3作品をwork単位で直列受入し、後続作品のpendingが先行作品を止めない。
- 検証済みWAVはwork別accepted-audioを正本にし、cacheなしのclean checkoutから再現する。
- 音声受入はbatch lock、pre/post digest、journal、expected manifest SHAでatomic・冪等にする。
- releaseはsource commit、public commit、exact SHA clean release-verifyの三段階にする。
- F001はcontent treeと最終Pages distの双方で不変検査する。
- 公開対象は既published batch全件と今回のaccepted候補1件だけに限定する。

## 検証結果

- 文書構造: REQ 20 / DES 16 / FUN 40 / QT 14、欠番・重複なし。
- REQ→QT、REQ→DES、DES→FUNの未追跡0件。
- trace_checkの残りはDES→UT/IT 16件のみで、次工程T-018の計画済みgap。
- 設計レビュー証跡: docs/evidence/design/DESIGN-F002-review.md。

## 次のアクション

- ProjectFactoryのQ-013で「承認」を1回押す。
- 承認を取り込んだらFD/DDをApprovedへ更新し、pf-testspecでUT-F002・IT-F002を作成する。

## 未解決事項

- DES→UT/ITの16件はT-018で解消する。
- VOICEVOX ENGINEは未起動。作品音声生成開始前にloopback限定で起動し、版・speaker UUID・styleを再照合する。
- F001で未取得だったiOS Safari物理端末とスクリーンリーダーの詳細証跡はF002リリース条件として継続する。
