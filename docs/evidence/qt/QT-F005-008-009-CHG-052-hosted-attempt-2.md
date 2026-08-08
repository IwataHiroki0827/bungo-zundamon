# QT-F005-008/009 CHG-F005-052 hosted attempt 2

- source commit: `102dd1721fc59391c7999b39a466a9390447cc38`
- hosted native correlation: run `31239312228` SUCCESS
- Pages: run `31239312221` build failure / deploy skip
- kernel ETW preflight: PASS
- T-110 target suite: 57 / 57 PASS
- case manifest SHA-256: `9c4df18441cd64dac77c644473e0629ea4bbb554b1f15d40e3bd6ed04dc14999`
- native binary SHA-256: `d20ccb6983266098bf66c40a194668a2a5a42b89d74484076633ba3d96e9e5c9`
- candidate branch: 不存在
- 判定: PASS

同一source commitのread-only workflowでproduction build、kernel ETW preflight、実load production assemblyを参照する固定57 case、source/build/workflow/load assembly hash・MVID、runner tupleをcanonical evidenceへ結合した。Pages runはbuild failureだったが、feature branchのdeploy jobは設計どおり`skipped`であり、候補保存・candidate branch・公開は発生していない。decoded canonical evidenceは同名JSONへ保存した。
