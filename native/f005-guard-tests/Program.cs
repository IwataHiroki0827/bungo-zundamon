using static SystemSetInfoCorrelationRules;

var failures = new List<string>();
var checks = 0;

Check("安全診断cache wav file no lease",
    SystemSetInfoDiagnosticRules.Classify(
        ".cache/voice/audio.wav", true, false, false, false, "NO_LEASE") ==
    "CACHE_WAV_FILE_NO_LEASE");
Check("安全診断content tmp absent unbound lease",
    SystemSetInfoDiagnosticRules.Classify(
        "content/batches/F005/audio.tmp", false, false, true, false, "DONE_ID") ==
    "CONTENT_TMP_ABSENT_UNBOUND_LEASE");
Check("安全診断unknown directory bound lease",
    SystemSetInfoDiagnosticRules.Classify(
        "vendor/private-name", false, true, true, true, "DONE_CHANGED") ==
    "OTHER_OTHER_DIRECTORY_BOUND_LEASE");
Check("安全診断completed write identity一致",
    SystemSetInfoDiagnosticRules.Classify(
        ".cache/voice/audio.wav", true, false, false, false, "DONE_ID") ==
    "CACHE_WAV_FILE_DONE_ID");
Check("安全診断completed write identity差替え",
    SystemSetInfoDiagnosticRules.Classify(
        ".cache/voice/audio.wav", true, false, false, false, "DONE_CHANGED") ==
    "CACHE_WAV_FILE_DONE_CHANGED");
Check("安全診断completed write実体欠落",
    SystemSetInfoDiagnosticRules.Classify(
        ".cache/voice/audio.wav", false, false, false, false, "DONE_MISSING") ==
    "CACHE_WAV_ABSENT_DONE_MISSING");
Check("安全診断未知completed stateを非公開化",
    SystemSetInfoDiagnosticRules.Classify(
        ".cache/voice/audio.wav", true, false, false, false, "PRIVATE_VALUE") ==
    "CACHE_WAV_FILE_NO_LEASE");
Check("完了台帳voice新規を追跡",
    CompletedWriteDiagnosticRules.ShouldTrack("voice", 127, false));
Check("完了台帳128件後の新規を未追跡",
    !CompletedWriteDiagnosticRules.ShouldTrack("voice", 128, false));
Check("完了台帳128件後の既存を更新",
    CompletedWriteDiagnosticRules.ShouldTrack("voice", 128, true));
Check("完了台帳non-voiceを未追跡",
    !CompletedWriteDiagnosticRules.ShouldTrack("build", 0, false));
Check("完了台帳clear相当をNO_LEASE",
    CompletedWriteDiagnosticRules.Classify("voice", false, false, false) ==
    "NO_LEASE");
Check("完了台帳identity一致を固定分類",
    CompletedWriteDiagnosticRules.Classify("voice", true, true, true) ==
    "DONE_ID");
Check("完了台帳identity差替えを固定分類",
    CompletedWriteDiagnosticRules.Classify("voice", true, true, false) ==
    "DONE_CHANGED");
Check("完了台帳実体欠落を固定分類",
    CompletedWriteDiagnosticRules.Classify("voice", true, false, false) ==
    "DONE_MISSING");
Check("完了write遅延System SetInfoを完全一致で認可",
    CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true, true, true));
Check("完了write PID 0遅延System SetInfoを完全一致で認可",
    CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 0, "setinfo", 31, true, true, true, true, true, true));
Check("完了write別authorization failureを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "EVENT_BEFORE_BIRTH", 4, "setinfo", 31, true, true, true, true, true, true));
Check("完了write別PIDを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 5, "setinfo", 31, true, true, true, true, true, true));
Check("完了write別operationを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true, true, true));
Check("完了write空FileObjectを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 0, true, true, true, true, true, true));
Check("完了write別phaseを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, false, true, true, true, true, true));
Check("完了write予約前eventを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, false, true, true, true, true));
Check("完了write完了後eventを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, false, true, true, true));
Check("完了write別FileObject bindingを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, false, true, true));
Check("完了write実体欠落を拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true, false, true));
Check("完了writeidentity差替えを拒否",
    !CompletedWriteDiagnosticRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true, true, false));
Check("完了write拒否stage authorization failure",
    CompletedWriteDiagnosticRules.Rejection(
        "EVENT_BEFORE_BIRTH", 4, "setinfo", 31, true, true, true, true, true, true) ==
    "AUTH_FAILURE");
Check("完了write拒否stage system PID",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 5, "setinfo", 31, true, true, true, true, true, true) ==
    "SYSTEM_PID");
Check("完了write拒否stage event",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true, true, true) ==
    "EVENT");
Check("完了write拒否stage file object zero",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 0, true, true, true, true, true, true) ==
    "FILE_OBJECT_ZERO");
Check("完了write拒否stage phase",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 31, false, true, true, true, true, true) ==
    "PHASE");
Check("完了write拒否stage before reservation",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 31, true, false, true, true, true, true) ==
    "BEFORE_RESERVATION");
Check("完了write拒否stage after completion",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, false, true, true, true) ==
    "AFTER_COMPLETION");
Check("完了後100ms以内を固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(1_000, 10_000) ==
    "WITHIN_100MS");
Check("完了後100ms超を次bucketへ固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(1_001, 10_000) ==
    "WITHIN_500MS");
Check("完了後500ms以内を固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(5_000, 10_000) ==
    "WITHIN_500MS");
Check("完了後500ms超を次bucketへ固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(5_001, 10_000) ==
    "WITHIN_2S");
Check("完了後2秒以内を固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(20_000, 10_000) ==
    "WITHIN_2S");
Check("完了後2秒超を次bucketへ固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(20_001, 10_000) ==
    "WITHIN_10S");
Check("完了後10秒以内を固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(100_000, 10_000) ==
    "WITHIN_10S");
Check("完了後10秒超を固定分類",
    CompletedWriteDiagnosticRules.AfterCompletionBucket(100_001, 10_000) ==
    "OVER_10S");
Check("完了QPC以前を再結合window内と判定",
    CompletedWriteDiagnosticRules.IsWithinCompletionWindow(10_000, 10_000, 10_000));
Check("完了QPCの1 tick前を再結合window内と判定",
    CompletedWriteDiagnosticRules.IsWithinCompletionWindow(9_999, 10_000, 10_000));
Check("完了後2秒上限を再結合window内と判定",
    CompletedWriteDiagnosticRules.IsWithinCompletionWindow(30_000, 10_000, 10_000));
Check("完了後2秒超を再結合window外と判定",
    !CompletedWriteDiagnosticRules.IsWithinCompletionWindow(30_001, 10_000, 10_000));
Check("極端QPC差をoverflowせず再結合window外と判定",
    !CompletedWriteDiagnosticRules.IsWithinCompletionWindow(
        long.MaxValue, long.MinValue, long.MaxValue));
Check("不正QPC frequencyを再結合window外と判定",
    !CompletedWriteDiagnosticRules.IsWithinCompletionWindow(10_000, 10_000, 0));
Check("完了write拒否stage file object binding",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, false, true, true) ==
    "FILE_OBJECT_BINDING");
Check("完了write拒否stage current missing",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true, false, true) ==
    "CURRENT_MISSING");
Check("完了write拒否stage identity mismatch",
    CompletedWriteDiagnosticRules.Rejection(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true, true, false) ==
    "IDENTITY_MISMATCH");
Check("closed lease snapshot欠落を固定分類",
    ClosedLeaseDiagnosticRules.Classify(false, true, true, true) ==
    "SNAPSHOT_MISSING");
Check("closed lease FileObject非互換を固定分類",
    ClosedLeaseDiagnosticRules.Classify(true, false, true, true) ==
    "FILE_OBJECT_BINDING");
Check("closed lease current欠落を固定分類",
    ClosedLeaseDiagnosticRules.Classify(true, true, false, false) ==
    "CURRENT_MISSING");
Check("closed lease identity差替えを固定分類",
    ClosedLeaseDiagnosticRules.Classify(true, true, true, false) ==
    "IDENTITY_MISMATCH");
Check("closed lease完全候補を固定分類",
    ClosedLeaseDiagnosticRules.Classify(true, true, true, true) ==
    "CANDIDATE");
Check("System未結合write空FileObjectを固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        false, true, true, true, true, true, "DONE_ID") ==
    "FILE_OBJECT_ZERO");
Check("System未結合write lease snapshot欠落を固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, true, false, false, true, false, "NO_LEASE") ==
    "LEASE_SNAPSHOT_MISSING");
Check("System未結合write lease current欠落を固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, true, false, true, false, false, "NO_LEASE") ==
    "LEASE_CURRENT_MISSING");
Check("System未結合write lease identity差替えを固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, true, false, true, true, false, "NO_LEASE") ==
    "LEASE_IDENTITY_MISMATCH");
Check("System未結合write open lease完全候補を固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, true, false, true, true, true, "NO_LEASE") ==
    "LEASE_OPEN_CANDIDATE");
Check("System未結合write closed lease完全候補を固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, true, true, true, true, true, "NO_LEASE") ==
    "LEASE_CLOSED_CANDIDATE");
Check("System未結合write completed identity一致を固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, false, false, false, true, false, "DONE_ID") ==
    "COMPLETED_ID");
Check("System未結合write completed identity差替えを固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, false, false, false, true, false, "DONE_CHANGED") ==
    "COMPLETED_CHANGED");
Check("System未結合write completed実体欠落を固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, false, false, false, false, false, "DONE_MISSING") ==
    "COMPLETED_MISSING");
Check("System未結合writeその他known pathを固定分類",
    SystemUnboundWriteDiagnosticRules.Classify(
        true, false, false, false, true, false, "NO_LEASE") ==
    "OTHER_KNOWN_PATH");
Check("System directory write snapshot欠落を固定分類",
    SystemDirectoryWriteRejoinDiagnosticRules.Classify(
        false, true, true, true, true) == "SNAPSHOT_MISSING");
Check("System directory write current欠落を固定分類",
    SystemDirectoryWriteRejoinDiagnosticRules.Classify(
        true, false, true, true, true) == "CURRENT_MISSING");
Check("System directory write identity差替えを固定分類",
    SystemDirectoryWriteRejoinDiagnosticRules.Classify(
        true, true, false, true, true) == "IDENTITY_MISMATCH");
Check("System directory write owner欠落を固定分類",
    SystemDirectoryWriteRejoinDiagnosticRules.Classify(
        true, true, true, false, true) == "OWNER_MISSING");
Check("System directory write root非activeを固定分類",
    SystemDirectoryWriteRejoinDiagnosticRules.Classify(
        true, true, true, true, false) == "ROOT_INACTIVE");
Check("System directory write完全候補を固定分類",
    SystemDirectoryWriteRejoinDiagnosticRules.Classify(
        true, true, true, true, true) == "CANDIDATE");
Check("System directory write完全候補だけを認可",
    SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, true, true));
Check("System directory write別auth failureを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "EVENT_BEFORE_BIRTH", 4, "write", 31, true, true, true, true,
        true, true, true, true));
Check("System directory write別PIDを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 5, "write", 31, true, true, true, true,
        true, true, true, true));
Check("System directory write別eventを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true,
        true, true, true, true));
Check("System directory write空FileObjectを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 0, true, true, true, true,
        true, true, true, true));
Check("System directory write別phaseを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, false, true, true, true,
        true, true, true, true));
Check("System directory writephase開始前を拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, false, true, true,
        true, true, true, true));
Check("System directory write既結合FileObjectを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, false, true,
        true, true, true, true));
Check("System directory writeactive lease中を拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, false,
        true, true, true, true));
Check("System directory write別bucketを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        false, true, true, true));
Check("System directory write非candidateを拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, false, true, true));
Check("System directory writeroot identity欠落を拒否",
    !SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, false, false));
Check("AFTER lease eventがlease予約QPC同値なら拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.IsCandidateTimestamp(100, 100, 110));
Check("AFTER lease eventがlease予約1tick後なら候補",
    AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.IsCandidateTimestamp(101, 100, 110));
Check("AFTER lease eventがrename予約QPC同値なら候補",
    AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.IsCandidateTimestamp(110, 100, 110));
Check("AFTER lease eventがrename予約1tick後なら拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.IsCandidateTimestamp(111, 100, 110));
Check("AFTER lease rename予約がlease予約以下なら拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.IsCandidateTimestamp(100, 100, 100));
Check("AFTER lease生存Job memberの完全tupleを許可",
    AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, true, false, true, true));
Check("AFTER lease終了済みprocessの完全な遅延tupleを許可",
    AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, true, true, false, true));
Check("AFTER lease別failureを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "PROCESS_UNKNOWN", 4, "write", 31, true, true, true, true,
        true, true, true, false, true, true));
Check("AFTER lease別pidを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 8, "write", 31, true, true, true, true,
        true, true, true, false, true, true));
Check("AFTER lease別eventを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 31, true, true, true, true,
        true, true, true, false, true, true));
Check("AFTER lease空FileObjectを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 0, true, true, true, true,
        true, true, true, false, true, true));
Check("AFTER lease結合済みevent FileObjectを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, false, true, true, true,
        true, true, true, false, true, true));
Check("AFTER lease非voice phaseを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, false, true, true,
        true, true, true, false, true, true));
Check("AFTER lease phase不一致を拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, false, true,
        true, true, true, false, true, true));
Check("AFTER lease別stageを拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, false,
        true, true, true, false, true, true));
Check("AFTER lease target tuple不一致を拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, false, true, false, true, true));
Check("AFTER lease process tuple不一致を拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, false, false, true, true));
Check("AFTER lease生存processのJob離脱を拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, true, false, false, true));
Check("AFTER lease終了済みprocessを遅延tupleなしで拒否",
    !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, true,
        true, true, true, true, false, false));
foreach (var (directoryStage, expected) in new[] {
    ("SNAPSHOT_MISSING", "DIRECTORY_SNAPSHOT_MISSING"),
    ("CURRENT_MISSING", "DIRECTORY_CURRENT_MISSING"),
    ("IDENTITY_MISMATCH", "DIRECTORY_IDENTITY_MISMATCH"),
    ("OWNER_MISSING", "DIRECTORY_OWNER_MISSING"),
    ("ROOT_INACTIVE", "DIRECTORY_ROOT_INACTIVE"),
    ("PRIVATE", "DIRECTORY_UNKNOWN"),
})
    Check($"active lease directory {expected}を固定分類",
        SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
            directoryStage, true, true, true, false, false, false) == expected);
Check("active lease directory lease欠落を固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", false, false, false, false, false, false) == "LEASE_MISSING");
Check("active lease directory phase不一致を固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", true, false, true, false, false, false) == "LEASE_PHASE");
Check("active lease directory親path不一致を固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", true, true, false, false, false, false) == "LEASE_PARENT");
Check("active lease directory結合済みを固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", true, true, true, true, false, false) == "LEASE_BOUND");
Check("active lease directoryclosedを固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", true, true, true, false, true, false) == "LEASE_CLOSED");
Check("active lease directoryescapeを固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", true, true, true, false, false, true) == "LEASE_ESCAPE");
Check("active lease directory完全候補を固定分類",
    SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
        "CANDIDATE", true, true, true, false, false, false) == "CANDIDATE");
foreach (var (inputs, expected) in new[] {
    (new[] { false, false, false, false, false, false, false, false, false },
        "SNAPSHOT_MISSING"),
    (new[] { true, false, false, false, false, false, false, false, false },
        "PATH_MISMATCH"),
    (new[] { true, true, false, false, false, false, false, false, false },
        "CURRENT_MISSING"),
    (new[] { true, true, true, false, false, false, false, false, false },
        "IDENTITY_MISMATCH"),
    (new[] { true, true, true, true, false, false, false, false, false },
        "LEASE_MISSING"),
    (new[] { true, true, true, true, true, false, false, false, false },
        "LEASE_PHASE"),
    (new[] { true, true, true, true, true, true, false, false, false },
        "LEASE_BINDING"),
    (new[] { true, true, true, true, true, true, true, true, false },
        "LEASE_CLOSED"),
    (new[] { true, true, true, true, true, true, true, false, true },
        "LEASE_ESCAPE"),
    (new[] { true, true, true, true, true, true, true, false, false },
        "CANDIDATE"),
})
    Check($"System bound FileObject {expected}を固定分類",
        SystemBoundFileObjectRejoinDiagnosticRules.Classify(
            inputs[0], inputs[1], inputs[2], inputs[3], inputs[4],
            inputs[5], inputs[6], inputs[7], inputs[8]) == expected);
Check("System bound FileObject rename lease予約QPC同値を前bucketへ固定分類",
    SystemBoundFileObjectRenameLeasePathDiagnosticRules.ClassifyTimeRelation(
        100, 100, 200) == "BEFORE_LEASE_RESERVATION");
Check("System bound FileObject rename lease予約1tick後を中間bucketへ固定分類",
    SystemBoundFileObjectRenameLeasePathDiagnosticRules.ClassifyTimeRelation(
        101, 100, 200) == "AFTER_LEASE_RESERVATION");
Check("System bound FileObject rename予約QPC同値を中間bucketへ固定分類",
    SystemBoundFileObjectRenameLeasePathDiagnosticRules.ClassifyTimeRelation(
        200, 100, 200) == "AFTER_LEASE_RESERVATION");
Check("System bound FileObject rename予約1tick後を後段へ通過",
    SystemBoundFileObjectRenameLeasePathDiagnosticRules.ClassifyTimeRelation(
        201, 100, 200) is null);
foreach (var (inputs, expected) in new[] {
    (new[] { false, false, false, false, false, false, false, false, false, false, false, false, false },
        "PATH_MISSING"),
    (new[] { true, false, false, false, false, false, false, false, false, false, false, false, false },
        "TARGET_MISMATCH"),
    (new[] { true, true, false, false, false, false, false, false, false, false, false, false, false },
        "RESERVATION_MISSING"),
    (new[] { true, true, true, false, false, false, false, false, false, false, false, false, false },
        "RESERVATION_ORDER"),
    (new[] { true, true, true, true, false, false, false, false, false, false, false, false, false },
        "BEFORE_LEASE_RESERVATION"),
    (new[] { true, true, true, true, true, false, false, false, false, false, false, false, false },
        "AFTER_LEASE_RESERVATION"),
    (new[] { true, true, true, true, true, true, true, false, false, false, false, false, false },
        "LEASE_CURRENT_EXISTS"),
    (new[] { true, true, true, true, true, true, false, false, false, false, false, false, false },
        "SNAPSHOT_MISSING"),
    (new[] { true, true, true, true, true, true, false, true, false, false, false, false, false },
        "SNAPSHOT_PATH"),
    (new[] { true, true, true, true, true, true, false, true, true, false, false, false, false },
        "IDENTITY_MISMATCH"),
    (new[] { true, true, true, true, true, true, false, true, true, true, false, false, false },
        "BINDING_MISMATCH"),
    (new[] { true, true, true, true, true, true, false, true, true, true, true, true, false },
        "LEASE_CLOSED"),
    (new[] { true, true, true, true, true, true, false, true, true, true, true, false, true },
        "LEASE_ESCAPE"),
    (new[] { true, true, true, true, true, true, false, true, true, true, true, false, false },
        "CANDIDATE"),
})
    Check($"System bound FileObject rename lease path {expected}を固定分類",
        SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
            inputs[0], inputs[1], inputs[2], inputs[3], inputs[4],
            inputs[5], inputs[6], inputs[7], inputs[8], inputs[9],
            inputs[10], inputs[11], inputs[12]) == expected);
Check("pendingなしbound FileObject fileを即時固定分類",
    NoPending(pathIsFile: true) == "NO_PENDING_FILE");
Check("pendingなしbound FileObject otherを即時固定分類",
    NoPending(pathIsDirectory: false) == "NO_PENDING_OTHER");
foreach (var (directoryStage, expected) in new[] {
    ("SNAPSHOT_MISSING", "NO_PENDING_DIR_SNAPSHOT_MISSING"),
    ("CURRENT_MISSING", "NO_PENDING_DIR_CURRENT_MISSING"),
    ("IDENTITY_MISMATCH", "NO_PENDING_DIR_ID_MISMATCH"),
    ("OWNER_MISSING", "NO_PENDING_DIR_OWNER_MISSING"),
    ("ROOT_INACTIVE", "NO_PENDING_DIR_ROOT_INACTIVE"),
    ("PRIVATE", "NO_PENDING_DIR_UNKNOWN"),
})
    Check($"pendingなしbound FileObject directory {expected}を固定分類",
        NoPending(directoryStage: directoryStage) == expected);
Check("pendingなしbound FileObject state driftを固定分類",
    NoPending(leaseStateStable: false) == "NO_PENDING_STATE_DRIFT");
Check("pendingなしbound FileObject lease親不一致を固定分類",
    NoPending(leaseParentMatches: false) == "NO_PENDING_LEASE_PARENT");
Check("pendingなしbound FileObject closed leaseを固定分類",
    NoPending(leaseClosed: true) == "NO_PENDING_LEASE_CLOSED");
Check("pendingなしbound FileObject unbound leaseを固定分類",
    NoPending(leaseBound: false) == "NO_PENDING_LEASE_UNBOUND");
Check("pendingなしbound FileObject lease snapshot欠落を固定分類",
    NoPending(leaseSnapshotAvailable: false) == "NO_PENDING_LEASE_SNAPSHOT_MISSING");
Check("pendingなしbound FileObject lease binding欠落を固定分類",
    NoPending(leaseBindingAvailable: false) == "NO_PENDING_LEASE_BINDING_MISSING");
Check("pendingなしbound FileObject lease binding不一致を固定分類",
    NoPending(leaseBindingMatches: false) == "NO_PENDING_LEASE_BINDING_MISMATCH");
Check("pendingなしbound FileObject lease current欠落を固定分類",
    NoPending(leaseCurrentExists: false) == "NO_PENDING_LEASE_CURRENT_MISSING");
Check("pendingなしbound FileObject lease identity不一致を固定分類",
    NoPending(leaseIdentityMatches: false) == "NO_PENDING_LEASE_ID_MISMATCH");
Check("pendingなしbound FileObject lease Job escapeを固定分類",
    NoPending(leaseOutsideJob: true) == "NO_PENDING_LEASE_ESCAPE");
Check("pendingなしbound FileObject完全tupleも診断候補へ固定分類",
    NoPending() == "NO_PENDING_CANDIDATE");
Check("unbound lease event予約QPC同値を拒否",
    !SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .IsEventAfterReservation(100, 100));
Check("unbound lease event予約1tick後を候補",
    SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .IsEventAfterReservation(101, 100));
Check("unbound lease deferred予約QPC同値を拒否",
    !SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .IsDeferredTimestampCandidate(100, 100, 110));
Check("unbound lease deferred予約1tick後を候補",
    SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .IsDeferredTimestampCandidate(101, 100, 110));
Check("unbound lease deferred event QPC同値を候補",
    SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .IsDeferredTimestampCandidate(110, 100, 110));
Check("unbound lease deferred event QPC1tick後を拒否",
    !SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .IsDeferredTimestampCandidate(111, 100, 110));
Check("unbound lease deferred完全tupleを一致判定", DeferredTuple());
Check("unbound lease deferred worker PID不一致を拒否",
    !DeferredTuple(deferredWorkerPid: 8));
Check("unbound lease deferred sequence不一致を拒否",
    !DeferredTuple(deferredSequence: 18));
Check("unbound lease deferred phase不一致を拒否",
    !DeferredTuple(deferredPhase: "preview"));
Check("unbound lease deferred work不一致を拒否",
    !DeferredTuple(deferredWorkId: "001076"));
Check("unbound lease deferred active phase instance不一致を拒否",
    !DeferredTuple(activePhaseInstanceId: "phase-b"));
Check("unbound lease deferred lease phase instance不一致を拒否",
    !DeferredTuple(leasePhaseInstanceId: "phase-b"));
Check("unbound lease deferred path不一致を拒否",
    !DeferredTuple(deferredRelativePath: ".cache/other.wav"));
Check("unbound lease deferred snapshot path不一致を拒否",
    !DeferredTuple(deferredSnapshotPath: ".cache/other.wav"));
Check("unbound lease deferred FileObject zeroを拒否",
    !DeferredTuple(deferredFileObject: 0));
Check("unbound lease deferred結合済みFileObjectを拒否",
    !DeferredTuple(deferredFileObjectUnbound: false));
Check("unbound lease snapshot存在を固定分類",
    Unbound(leaseSnapshotAbsent: false) == "UNBOUND_SNAPSHOT_PRESENT");
Check("unbound lease event予約前を固定分類",
    Unbound(eventAfterReservation: false) == "UNBOUND_BEFORE_RESERVATION");
Check("unbound lease current取得失敗を固定分類",
    Unbound(currentInspectionSucceeded: false) ==
        "UNBOUND_CURRENT_INSPECTION_FAILED");
Check("unbound lease current欠落を固定分類",
    Unbound(currentExists: false) == "UNBOUND_CURRENT_MISSING");
Check("unbound lease deferred欠落を固定分類",
    Unbound(deferredCount: 0) == "UNBOUND_DEFERRED_MISSING");
Check("unbound lease deferred複数を固定分類",
    Unbound(deferredCount: 2) == "UNBOUND_DEFERRED_TUPLE");
Check("unbound lease deferred tuple不一致を固定分類",
    Unbound(deferredTupleMatches: false) == "UNBOUND_DEFERRED_TUPLE");
Check("unbound lease current identity不一致を固定分類",
    Unbound(currentIdentityMatches: false) == "UNBOUND_CURRENT_ID_MISMATCH");
Check("unbound lease process wait失敗を固定分類",
    Unbound(processInspectionFailure: "WAIT") == "UNBOUND_PROCESS_WAIT_FAILED");
Check("unbound lease process identity失敗を固定分類",
    Unbound(processInspectionFailure: "IDENTITY") ==
        "UNBOUND_PROCESS_IDENTITY_FAILED");
Check("unbound lease Job照会失敗を固定分類",
    Unbound(processInspectionFailure: "JOB") == "UNBOUND_JOB_QUERY_FAILED");
Check("unbound lease process tuple不一致を固定分類",
    Unbound(processTupleMatches: false) == "UNBOUND_PROCESS_TUPLE");
Check("unbound lease signaled processを固定分類",
    Unbound(processSignaled: true, processJobMember: false) ==
        "UNBOUND_PROCESS_SIGNALED");
Check("unbound lease Job escapeを固定分類",
    Unbound(processJobMember: false) == "UNBOUND_LEASE_ESCAPE");
Check("unbound lease完全tupleも診断候補へ固定分類",
    Unbound() == "UNBOUND_CANDIDATE");
Check("bound lease directory完全cheap predicateを候補化", BoundLeaseCheap());
Check("bound lease directory別failureを拒否",
    !BoundLeaseCheap(authorizationFailure: "PROCESS_UNKNOWN"));
Check("bound lease directory別PIDを拒否", !BoundLeaseCheap(systemPid: 8));
Check("bound lease directory別eventを拒否", !BoundLeaseCheap(eventName: "setinfo"));
Check("bound lease directory空FileObjectを拒否", !BoundLeaseCheap(fileObject: 0));
Check("bound lease directory結合済みevent FileObjectを拒否",
    !BoundLeaseCheap(fileObjectUnbound: false));
Check("bound lease directory非voice phaseを拒否", !BoundLeaseCheap(voicePhase: false));
Check("bound lease directoryphase不一致を拒否", !BoundLeaseCheap(leasePhaseMatches: false));
Check("bound lease directory別exact stageを拒否", !BoundLeaseCheap(exactCandidate: false));
Check("bound lease directorypending pathありを拒否",
    !BoundLeaseCheap(pendingRenamePathNull: false));
Check("bound lease directoryrename予約ありを拒否",
    !BoundLeaseCheap(renameReservationNull: false));
var exactEvaluations = 0;
var pathEvaluations = 0;
var reservationEvaluations = 0;
Check("bound lease directorycheap失敗時に後段を未評価",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.EvaluateCheapPredicates(
        "PRIVATE", 4, "write", 31, true, true, true, 100, 101, 102,
        () => { exactEvaluations++; return true; },
        () => { pathEvaluations++; return true; },
        () => { reservationEvaluations++; return true; }) &&
    exactEvaluations == 0 && pathEvaluations == 0 && reservationEvaluations == 0);
exactEvaluations = pathEvaluations = reservationEvaluations = 0;
Check("bound lease directoryexact失敗時にpendingを未評価",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.EvaluateCheapPredicates(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, 100, 101, 102,
        () => { exactEvaluations++; return false; },
        () => { pathEvaluations++; return true; },
        () => { reservationEvaluations++; return true; }) &&
    exactEvaluations == 1 && pathEvaluations == 0 && reservationEvaluations == 0);
exactEvaluations = pathEvaluations = reservationEvaluations = 0;
Check("bound lease directorypending path失敗時にrename予約を未評価",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.EvaluateCheapPredicates(
        "BIRTH_MISSING", 4, "write", 31, true, true, true, 100, 101, 102,
        () => { exactEvaluations++; return true; },
        () => { pathEvaluations++; return false; },
        () => { reservationEvaluations++; return true; }) &&
    exactEvaluations == 1 && pathEvaluations == 1 && reservationEvaluations == 0);
Check("bound lease directory phase/lease QPC同値を拒否",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(100, 100, 102));
Check("bound lease directory phase/lease QPC +1を候補",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(100, 101, 102));
Check("bound lease directory lease/event QPC同値を拒否",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(100, 101, 101));
Check("bound lease directory lease/event QPC +1を候補",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(100, 101, 102));
Check("bound lease directory phase開始後でも予約逆転を拒否",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(101, 100, 102));
Check("bound lease directory eventがphase開始同値なら拒否",
    !SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(100, 101, 100));
var initialTuple = Enumerable.Repeat(true, 12).ToArray();
Check("bound lease directory初回tuple all-trueを候補化",
    BoundLeaseInitialTuple(initialTuple));
for (var index = 0; index < initialTuple.Length; index++)
{
    var oneFalse = initialTuple.ToArray();
    oneFalse[index] = false;
    Check($"bound lease directory初回tuple predicate {index} falseを拒否",
        !BoundLeaseInitialTuple(oneFalse));
}
var tupleRecheckCodes = new[] {
    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_ACTIVE_LEASE_CHANGED",
    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_EVENT_FILE_OBJECT_BOUND",
    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_RENAME_STATE_CHANGED",
    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_DIRECTORY_IDENTITY_MISMATCH",
    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_LEASE_CURRENT_IDENTITY_MISMATCH",
    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_BINDING_MISMATCH",
};
var tupleRecheck = Enumerable.Repeat(true, tupleRecheckCodes.Length).ToArray();
Check("bound lease directory再検査tuple all-trueを許可",
    BoundLeaseTupleRecheck(tupleRecheck) is null);
for (var index = 0; index < tupleRecheck.Length; index++)
{
    var oneFalse = tupleRecheck.ToArray();
    oneFalse[index] = false;
    Check($"bound lease directory再検査tuple {index} exact codeを固定",
        BoundLeaseTupleRecheck(oneFalse) == tupleRecheckCodes[index]);
}
Check("bound lease directory再検査tupleは先行falseを優先",
    BoundLeaseTupleRecheck(Enumerable.Repeat(false, 6).ToArray()) ==
        tupleRecheckCodes[0]);
Check("bound lease directory初回identity失敗codeを固定",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.InitialProcessFailureCode(
        "PROCESS_START_KEY_QUERY_FAILED") ==
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_IDENTITY_FAILED");
Check("bound lease directory初回wait失敗codeを固定",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.InitialProcessFailureCode(
        "PROCESS_WAIT_FAILED") ==
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_WAIT_FAILED");
Check("bound lease directory初回Job照会失敗codeを固定",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.InitialProcessFailureCode(
        "JOB_QUERY_FAILED") ==
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_JOB_QUERY_FAILED");
Check("bound lease directory再検査identity失敗codeを固定",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.RecheckProcessFailureCode(
        "PROCESS_START_KEY_QUERY_FAILED") ==
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_IDENTITY_FAILED");
Check("bound lease directory再検査wait失敗codeを固定",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.RecheckProcessFailureCode(
        "PROCESS_WAIT_FAILED") ==
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_WAIT_FAILED");
Check("bound lease directory再検査Job照会失敗codeを固定",
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.RecheckProcessFailureCode(
        "JOB_QUERY_FAILED") ==
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_JOB_QUERY_FAILED");
foreach (var (tuple, signaled, member, recheck, expected) in new[] {
    (false, false, true, false,
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_TUPLE_MISMATCH"),
    (true, true, false, false,
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_SIGNALED"),
    (true, false, false, false,
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_OUTSIDE_JOB"),
    (true, false, true, false, (string?)null),
    (false, false, true, true,
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_TUPLE_MISMATCH"),
    (true, true, false, true,
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_SIGNALED"),
    (true, false, false, true,
        "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_OUTSIDE_JOB"),
    (true, false, true, true, (string?)null),
})
    Check($"bound lease directory process rejection {recheck}/{expected}を固定",
        SystemDirectoryBoundLeaseRejoinAuthorizationRules.ProcessRejection(
            tuple, signaled, member, recheck) == expected);
foreach (var (directoryStage, inputs, expected) in new[] {
    ("SNAPSHOT_MISSING", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "DIRECTORY_SNAPSHOT_MISSING"),
    ("CURRENT_MISSING", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "DIRECTORY_CURRENT_MISSING"),
    ("IDENTITY_MISMATCH", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "DIRECTORY_IDENTITY_MISMATCH"),
    ("OWNER_MISSING", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "DIRECTORY_OWNER_MISSING"),
    ("ROOT_INACTIVE", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "DIRECTORY_ROOT_INACTIVE"),
    ("PRIVATE", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "DIRECTORY_UNKNOWN"),
    ("CANDIDATE", new[] { false, false, false, false, false, false, false, false, false, false, false },
        "LEASE_MISSING"),
    ("CANDIDATE", new[] { true, false, false, false, false, false, false, false, false, false, false },
        "LEASE_PHASE"),
    ("CANDIDATE", new[] { true, true, false, false, false, false, false, false, false, false, false },
        "LEASE_PARENT"),
    ("CANDIDATE", new[] { true, true, true, false, true, false, false, false, false, false, false },
        "LEASE_CLOSED"),
    ("CANDIDATE", new[] { true, true, true, false, false, false, false, false, false, false, false },
        "LEASE_UNBOUND"),
    ("CANDIDATE", new[] { true, true, true, true, false, false, false, false, false, false, false },
        "LEASE_SNAPSHOT_MISSING"),
    ("CANDIDATE", new[] { true, true, true, true, false, true, false, false, false, false, false },
        "LEASE_BINDING_MISSING"),
    ("CANDIDATE", new[] { true, true, true, true, false, true, true, false, false, false, false },
        "LEASE_BINDING_MISMATCH"),
    ("CANDIDATE", new[] { true, true, true, true, false, true, true, true, false, false, false },
        "LEASE_CURRENT_MISSING"),
    ("CANDIDATE", new[] { true, true, true, true, false, true, true, true, true, false, false },
        "LEASE_IDENTITY_MISMATCH"),
    ("CANDIDATE", new[] { true, true, true, true, false, true, true, true, true, true, true },
        "LEASE_ESCAPE"),
    ("CANDIDATE", new[] { true, true, true, true, false, true, true, true, true, true, false },
        "CANDIDATE"),
})
    Check($"System bound lease directory {expected}を固定分類",
        SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
            directoryStage, inputs[0], inputs[1], inputs[2], inputs[3],
            inputs[4], inputs[5], inputs[6], inputs[7], inputs[8],
            inputs[9], inputs[10]) == expected);
foreach (var (inputs, expected) in new[] {
    (new[] { false, false, false, false, false, false, false, false }, "PATH_MISSING"),
    (new[] { true, false, false, false, false, false, false, false }, "PARENT"),
    (new[] { true, true, false, false, false, false, false, false }, "RESERVATION_MISSING"),
    (new[] { true, true, true, false, false, false, false, false }, "BEFORE_LEASE_RESERVATION"),
    (new[] { true, true, true, true, false, false, false, false }, "AFTER_LEASE_RESERVATION"),
    (new[] { true, true, true, true, true, false, false, false }, "CURRENT_MISSING"),
    (new[] { true, true, true, true, true, true, false, false }, "IDENTITY_MISMATCH"),
    (new[] { true, true, true, true, true, true, true, true }, "LEASE_ESCAPE"),
    (new[] { true, true, true, true, true, true, true, false }, "CANDIDATE"),
})
    Check($"System bound lease rename {expected}を固定分類",
        SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
            inputs[0], inputs[1], inputs[2], inputs[3], inputs[4],
            inputs[5], inputs[6], inputs[7]) == expected);

Check("予約済みSystem SetInfo", CanAuthorize(
    "BIRTH_MISSING", 4, "setinfo", 17, true, true, false, false));
Check("未予約operation", !CanAuthorize(
    "BIRTH_MISSING", 4, "write", 17, true, true, false, false));
Check("予約前QPC", !CanAuthorize(
    "BIRTH_MISSING", 4, "setinfo", 17, true, false, false, false));
Check("process escape", !CanAuthorize(
    "BIRTH_MISSING", 4, "setinfo", 17, true, true, true, false));
Check("Cleanup後pointer再利用", !CanAuthorize(
    "BIRTH_MISSING", 4, "setinfo", 17, true, true, false, true));
Check("closed leaseでも別path tupleは対象外",
    !MatchesReservation(
        "BIRTH_MISSING", 4, "setinfo", 17, false, true, false));
Check("closed leaseの一致tupleは専用停止対象",
    MatchesReservation(
        "BIRTH_MISSING", 4, "setinfo", 17, true, true, false));
Check("予約済みrename target", TryGetReservationQpc(
    "audio.wav", "audio.tmp", 100, "audio.wav", 200, out var renameQpc) &&
    renameQpc == 200);
Check("未予約rename target", !TryGetReservationQpc(
    "other.wav", "audio.tmp", 100, "audio.wav", 200, out _));
Check("rename target予約前QPC", !CanAuthorize(
    "BIRTH_MISSING", 4, "setinfo", 17, true, 199 > renameQpc, false, false));
Check("current path予約QPC", TryGetReservationQpc(
    "audio.tmp", "audio.tmp", 100, "audio.wav", 200, out var currentQpc) &&
    currentQpc == 100);

Check("rename prepare正常", CanPrepareRename(
    true, true, true, false, true, false, false, false));
Check("rename prepare別phase", !CanPrepareRename(
    false, true, true, false, true, false, false, false));
Check("rename prepare未認証root", !CanPrepareRename(
    true, false, true, false, true, false, false, false));
Check("rename prepare別process世代", !CanPrepareRename(
    true, true, false, false, true, false, false, false));
Check("rename prepare二重予約", !CanPrepareRename(
    true, true, true, true, true, false, false, false));
Check("rename prepare未結合identity", !CanPrepareRename(
    true, true, true, false, false, false, false, false));
Check("rename prepare終了済みhelper", !CanPrepareRename(
    true, true, true, false, true, true, false, false));
Check("rename prepare Job escape", !CanPrepareRename(
    true, true, true, false, true, false, true, false));
Check("rename prepare target既存", !CanPrepareRename(
    true, true, true, false, true, false, false, true));

Check("rename notice予約消費", TryConsumeRename(
    "audio.tmp", "audio.wav", "audio.tmp", "audio.wav", 200, out var promotedQpc) &&
    promotedQpc == 200);
Check("rename notice別from", !TryConsumeRename(
    "other.tmp", "audio.wav", "audio.tmp", "audio.wav", 200, out _));
Check("rename notice別to", !TryConsumeRename(
    "audio.tmp", "other.wav", "audio.tmp", "audio.wav", 200, out _));
Check("rename notice二重消費", !TryConsumeRename(
    "audio.tmp", "audio.wav", "audio.tmp", null, null, out _));
Check("rename消費後もtarget予約前QPC拒否", TryGetReservationQpc(
    "audio.wav", "audio.wav", promotedQpc, null, null, out var afterRenameQpc) &&
    !CanAuthorize(
        "BIRTH_MISSING", 4, "setinfo", 17, true, 150 > afterRenameQpc, false, false));

Check("同一identity後方相関", CanBindDeferred(
    false, true, true, 17, 17, 100, 110, 120, "volume:file-a", "volume:file-a"));
Check("replacement identity拒否", !CanBindDeferred(
    false, true, true, 17, 17, 100, 110, 120, "volume:file-b", "volume:file-a"));
Check("Cleanup後FileObject再利用拒否", !CanBindDeferred(
    true, true, true, 17, 17, 100, 110, 120, "volume:file-a", "volume:file-a"));
Check("別FileObject拒否", !CanBindDeferred(
    false, true, true, 18, 17, 100, 110, 120, "volume:file-a", "volume:file-a"));
Check("別path/phase拒否", !CanBindDeferred(
    false, true, false, 17, 17, 100, 110, 120, "volume:file-a", "volume:file-a"));
Check("Create/SetInfo QPC逆転拒否", !CanBindDeferred(
    false, true, true, 17, 17, 100, 121, 120, "volume:file-a", "volume:file-a"));
Check("別process世代拒否", !CanBindDeferred(
    false, false, true, 17, 17, 100, 110, 120, "volume:file-a", "volume:file-a"));
Check("Cleanup失効判定", CleanupInvalidates(17, null, [17UL]));
Check("無関係Cleanup", !CleanupInvalidates(18, 17, [17UL]));

Check("helper生存中complete拒否", !CanComplete(false, true, true, false, false));
Check("未解決保留complete拒否", !CanComplete(true, true, true, true, false));
Check("未消費rename予約complete拒否", !CanComplete(true, true, true, false, true));
Check("正常complete", CanComplete(true, true, true, false, false));

var replayed = ReplayInEtwOrder(
    new[] { (Sequence: 9L, Value: "second"), (Sequence: 8L, Value: "first") },
    item => item.Sequence)
    .Select(item => item.Value)
    .ToArray();
Check("保留eventをETW順に再投入", replayed.SequenceEqual(["first", "second"]));

var prepareTuple = Enumerable.Repeat(true, 12).ToArray();
Check("completion drain prepare完全tuple", WriteCompletionDrainRules.PrepareTupleMatches(prepareTuple));
for (var index = 0; index < prepareTuple.Length; index++)
{
    var oneFalse = prepareTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain prepare tuple {index} false拒否",
        !WriteCompletionDrainRules.PrepareTupleMatches(oneFalse));
}
foreach (var (from, to) in new[] {
    ("prepared", "completion-requested"),
    ("completion-requested", "completed-retained"),
    ("completed-retained", "released"),
})
    Check($"completion drain正規遷移 {from}->{to}",
        WriteCompletionDrainRules.CanTransition(from, to));
foreach (var (from, to) in new[] {
    ("prepared", "prepared"),
    ("prepared", "completed-retained"),
    ("completion-requested", "released"),
    ("completed-retained", "completion-requested"),
    ("released", "prepared"),
})
    Check($"completion drain不正遷移 {from}->{to}拒否",
        !WriteCompletionDrainRules.CanTransition(from, to));
Check("completion drain lower同値拒否", !WriteCompletionDrainRules.IsWithinEpoch(100, 110, 100));
Check("completion drain lower+1許可", WriteCompletionDrainRules.IsWithinEpoch(100, 110, 101));
Check("completion drain upper同値許可", WriteCompletionDrainRules.IsWithinEpoch(100, 110, 110));
Check("completion drain upper+1拒否", !WriteCompletionDrainRules.IsWithinEpoch(100, 110, 111));
Check("completion drain deadline同値許可", WriteCompletionDrainRules.IsDeadlineValid(110, 110));
Check("completion drain deadline+1拒否", !WriteCompletionDrainRules.IsDeadlineValid(111, 110));
Check("completion drain全上限同値許可", WriteCompletionDrainRules.IsBufferWithinLimit(128, 64, 8192));
Check("completion drain seal 129拒否", !WriteCompletionDrainRules.IsBufferWithinLimit(129, 64, 8192));
Check("completion drain seal event 65拒否", !WriteCompletionDrainRules.IsBufferWithinLimit(128, 65, 8192));
Check("completion drain phase event 8193拒否", !WriteCompletionDrainRules.IsBufferWithinLimit(128, 64, 8193));
Check("completion drain counter stable", WriteCompletionDrainRules.CountersStable(10, 10, 10, 10));
Check("completion drain relevant/accounted差拒否", !WriteCompletionDrainRules.CountersStable(10, 9, 10, 9));
Check("completion drain relevant後発拒否", !WriteCompletionDrainRules.CountersStable(10, 10, 11, 10));
Check("completion drain accounted後発拒否", !WriteCompletionDrainRules.CountersStable(10, 10, 10, 11));
Check("completion drain broad 0は既存分類", WriteCompletionDrainRules.LookupFailure(0, 0, 0, 0) is null);
Check("completion drain epoch 0 late 0固定診断", WriteCompletionDrainRules.LookupFailure(1, 0, 0, 0) == WriteCompletionDrainRules.LookupEpochEmptyNoLateProofFailureCode);
Check("completion drain epoch 0 late 1は既存late", WriteCompletionDrainRules.LookupFailure(1, 0, 0, 1) == WriteCompletionDrainRules.GenericLateEventFailureCode);
Check("completion drain epoch 0 late 2も既存late", WriteCompletionDrainRules.LookupFailure(2, 0, 0, 2) == WriteCompletionDrainRules.GenericLateEventFailureCode);
var exactLateTuple = new[] { true, true, true, true, true, true };
LateEventDiagnosticCandidate LateCandidate(bool[] tuple) => new(
    tuple[0], tuple[1], tuple[2], tuple[3], tuple[4], tuple[5]);
var exactLateCandidate = LateCandidate(exactLateTuple);
var exactLateCodes = new Dictionary<string, string>(StringComparer.Ordinal) {
    ["write"] = WriteCompletionDrainRules.LateRetainedParentWriteFailureCode,
    ["setinfo"] = WriteCompletionDrainRules.LateRetainedParentSetInfoFailureCode,
};
var mismatchAxes = new[] {
    (Index: 0, Suffix: "SEAL_NOT_COMPLETED_RETAINED"),
    (Index: 1, Suffix: "CURRENT_PATH"),
    (Index: 2, Suffix: "ACTIVE_LEASE_MISSING"),
    (Index: 4, Suffix: "ACTIVE_PARENT_MISMATCH"),
    (Index: 5, Suffix: "AT_OR_BEFORE_ACTIVE_RESERVATION"),
};
foreach (var eventName in exactLateCodes.Keys)
{
    Check($"completion drain {eventName} retained parent全条件一致code",
        WriteCompletionDrainRules.LateEventFailureCode(
            eventName, true, true, true, true, true, true) ==
        exactLateCodes[eventName]);
    foreach (var axis in mismatchAxes)
    {
        var oneFalse = exactLateTuple.ToArray();
        oneFalse[axis.Index] = false;
        Check($"completion drain {eventName}最初不一致{axis.Suffix}",
            WriteCompletionDrainRules.LateEventFailureCode(
                eventName,
                oneFalse[0], oneFalse[1], oneFalse[2],
                oneFalse[3], oneFalse[4], oneFalse[5]) ==
            $"F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_{eventName.ToUpperInvariant()}_{axis.Suffix}");
    }
    var currentPathTuple = exactLateTuple.ToArray();
    currentPathTuple[1] = false;
    var activeMissingTuple = exactLateTuple.ToArray();
    activeMissingTuple[2] = false;
    var sameBucket = new[] { LateCandidate(currentPathTuple), LateCandidate(currentPathTuple) };
    var mixedBuckets = new[] { LateCandidate(currentPathTuple), LateCandidate(activeMissingTuple) };
    var mixedCode = eventName == "write"
        ? WriteCompletionDrainRules.LateDiagnosticWriteMixedCausesFailureCode
        : WriteCompletionDrainRules.LateDiagnosticSetInfoMixedCausesFailureCode;
    Check($"completion drain {eventName}同一bucket複数は同一code",
        WriteCompletionDrainRules.AggregateLateEventFailureCode(eventName, sameBucket) ==
        $"F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_{eventName.ToUpperInvariant()}_CURRENT_PATH");
    Check($"completion drain {eventName}異種bucket複数はmixed",
        WriteCompletionDrainRules.AggregateLateEventFailureCode(eventName, mixedBuckets) == mixedCode);
    Check($"completion drain {eventName}候補順反転は同一mixed",
        WriteCompletionDrainRules.AggregateLateEventFailureCode(
            eventName, mixedBuckets.Reverse()) == mixedCode);
    Check($"completion drain {eventName}完全一致とmismatch混在は完全一致優先",
        WriteCompletionDrainRules.AggregateLateEventFailureCode(
            eventName, [LateCandidate(currentPathTuple), exactLateCandidate]) ==
        exactLateCodes[eventName]);
    var sameLeaseTuple = exactLateTuple.ToArray();
    sameLeaseTuple[3] = false;
    Check($"completion drain {eventName}same lease不変条件違反はgeneric LATE",
        WriteCompletionDrainRules.LateEventFailureCode(
            eventName, true, true, true, false, true, true) ==
        WriteCompletionDrainRules.GenericLateEventFailureCode);
    Check($"completion drain {eventName}generic混在はfail-close",
        WriteCompletionDrainRules.AggregateLateEventFailureCode(
            eventName, [LateCandidate(currentPathTuple), LateCandidate(sameLeaseTuple)]) ==
        WriteCompletionDrainRules.GenericLateEventFailureCode);
    Check($"completion drain {eventName}完全一致はgeneric異常入力より優先",
        WriteCompletionDrainRules.AggregateLateEventFailureCode(
            eventName, [LateCandidate(sameLeaseTuple), exactLateCandidate]) ==
        exactLateCodes[eventName]);
}
Check("completion drain late候補0件集約はgeneric LATE",
    WriteCompletionDrainRules.AggregateLateEventFailureCode(
        "write", Array.Empty<LateEventDiagnosticCandidate>()) ==
    WriteCompletionDrainRules.GenericLateEventFailureCode);
Check("completion drain unknown event集約はgeneric LATE",
    WriteCompletionDrainRules.AggregateLateEventFailureCode(
        "delete", [exactLateCandidate]) ==
    WriteCompletionDrainRules.GenericLateEventFailureCode);
Check("completion drain retained parent 2 codeは100/102文字",
    WriteCompletionDrainRules.LateRetainedParentWriteFailureCode.Length == 100 &&
    WriteCompletionDrainRules.LateRetainedParentSetInfoFailureCode.Length == 102);
Check("completion drain retained parent想定外eventはgeneric LATE",
    WriteCompletionDrainRules.LateEventFailureCode(
        "delete", true, true, true, true, true, true) ==
    WriteCompletionDrainRules.GenericLateEventFailureCode);
var exactLateBefore = exactLateTuple.ToArray();
_ = WriteCompletionDrainRules.LateEventFailureCode(
    "write",
    exactLateTuple[0],
    exactLateTuple[1],
    exactLateTuple[2],
    exactLateTuple[3],
    exactLateTuple[4],
    exactLateTuple[5]);
Check("completion drain pure late ruleは入力state無変更",
    exactLateTuple.SequenceEqual(exactLateBefore));
var handoffTuple = Enumerable.Repeat(true, 6).ToArray();
bool CanHandoff(
    int candidateCount = 1,
    string? aggregateCode = null,
    bool[]? tuple = null)
{
    var values = tuple ?? handoffTuple;
    return WriteCompletionDrainRules.CanHandoffCompletedWrite(
        candidateCount,
        aggregateCode ??
            WriteCompletionDrainRules.LateDiagnosticSetInfoCurrentPathFailureCode,
        values[0], values[1], values[2], values[3], values[4], values[5]);
}
Check("completion drain completed-write handoff all true", CanHandoff());
Check("completion drain completed-write handoff候補0件を拒否",
    !CanHandoff(candidateCount: 0));
Check("completion drain completed-write handoff候補2件を拒否",
    !CanHandoff(candidateCount: 2));
Check("completion drain completed-write handoff write currentを拒否",
    !CanHandoff(aggregateCode: WriteCompletionDrainRules.LateEventFailureCode(
        "write", true, false, true, true, true, true)));
Check("completion drain completed-write handoff setinfo parentを拒否",
    !CanHandoff(aggregateCode:
        WriteCompletionDrainRules.LateRetainedParentSetInfoFailureCode));
foreach (var code in new[] {
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_SEAL_NOT_COMPLETED_RETAINED",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_ACTIVE_LEASE_MISSING",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_ACTIVE_PARENT_MISMATCH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_AT_OR_BEFORE_ACTIVE_RESERVATION",
    WriteCompletionDrainRules.LateDiagnosticSetInfoMixedCausesFailureCode,
    WriteCompletionDrainRules.GenericLateEventFailureCode,
})
    Check("completion drain completed-write handoff他bucket/mixed/genericを拒否",
        !CanHandoff(aggregateCode: code));
for (var index = 0; index < handoffTuple.Length; index++)
{
    var oneFalse = handoffTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain completed-write handoff record/seal軸 {index} falseを拒否",
        !CanHandoff(tuple: oneFalse));
}
var handoffTupleBefore = handoffTuple.ToArray();
_ = CanHandoff();
Check("completion drain completed-write handoff純粋規則は入力state無変更",
    handoffTuple.SequenceEqual(handoffTupleBefore));
var activeDirectoryTuple = Enumerable.Repeat(true, 10).ToArray();
bool CanActiveDirectoryHandoff(
    bool[]? tuple = null,
    int candidateCount = 1,
    string? aggregateCode = null,
    string authorizationFailure = "BIRTH_MISSING",
    int pid = 4,
    string eventName = "write",
    ulong fileObject = 31)
{
    var values = tuple ?? activeDirectoryTuple;
    return WriteCompletionDrainRules.CanHandoffActiveDirectory(
        candidateCount,
        aggregateCode ?? WriteCompletionDrainRules.LateRetainedParentWriteFailureCode,
        authorizationFailure,
        pid,
        eventName,
        fileObject,
        values[0], values[1], values[2], values[3], values[4],
        values[5], values[6], values[7], values[8], values[9]);
}
Check("completion drain active directory handoff all true", CanActiveDirectoryHandoff());
Check("completion drain active directory handoff PID 0を許可",
    CanActiveDirectoryHandoff(pid: 0));
Check("completion drain active directory handoff候補0件を拒否",
    !CanActiveDirectoryHandoff(candidateCount: 0));
Check("completion drain active directory handoff候補2件を拒否",
    !CanActiveDirectoryHandoff(candidateCount: 2));
Check("completion drain active directory handoff他bucketを拒否",
    !CanActiveDirectoryHandoff(aggregateCode:
        WriteCompletionDrainRules.LateDiagnosticWriteMixedCausesFailureCode));
Check("completion drain active directory handoff birth以外を拒否",
    !CanActiveDirectoryHandoff(authorizationFailure: "EVENT_BEFORE_BIRTH"));
Check("completion drain active directory handoff非System PIDを拒否",
    !CanActiveDirectoryHandoff(pid: 5));
Check("completion drain active directory handoff setinfoを拒否",
    !CanActiveDirectoryHandoff(eventName: "setinfo"));
Check("completion drain active directory handoff file object 0を拒否",
    !CanActiveDirectoryHandoff(fileObject: 0));
var activeDirectoryAxisNames = new[] {
    "unbound object", "completed retained", "voice phase", "seal phase",
    "seal parent", "active lease", "other lease", "phase instance",
    "active parent", "post reservation",
};
for (var index = 0; index < activeDirectoryTuple.Length; index++)
{
    var oneFalse = activeDirectoryTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain active directory {activeDirectoryAxisNames[index]} falseを拒否",
        !CanActiveDirectoryHandoff(tuple: oneFalse));
}
var activeDirectoryTupleBefore = activeDirectoryTuple.ToArray();
_ = CanActiveDirectoryHandoff();
Check("completion drain active directory純粋規則は入力state無変更",
    activeDirectoryTuple.SequenceEqual(activeDirectoryTupleBefore));
var completedNoLeaseTuple = Enumerable.Repeat(true, 8).ToArray();
bool CanCompletedNoLeaseDirectoryHandoff(
    bool[]? tuple = null,
    int candidateCount = 1,
    string? aggregateCode = null,
    string authorizationFailure = "BIRTH_MISSING",
    int pid = 4,
    string eventName = "write",
    ulong fileObject = 31)
{
    var values = tuple ?? completedNoLeaseTuple;
    return WriteCompletionDrainRules.CanHandoffCompletedNoLeaseDirectory(
        candidateCount,
        aggregateCode ?? WriteCompletionDrainRules
            .LateDiagnosticWriteActiveLeaseMissingFailureCode,
        authorizationFailure,
        pid,
        eventName,
        fileObject,
        values[0], values[1], values[2], values[3],
        values[4], values[5], values[6], values[7]);
}
Check("completion drain completed no-lease directory handoff all true",
    CanCompletedNoLeaseDirectoryHandoff());
Check("completion drain completed no-lease directory handoff PID 0を許可",
    CanCompletedNoLeaseDirectoryHandoff(pid: 0));
Check("completion drain completed no-lease directory候補0件を拒否",
    !CanCompletedNoLeaseDirectoryHandoff(candidateCount: 0));
Check("completion drain completed no-lease directory候補2件を拒否",
    !CanCompletedNoLeaseDirectoryHandoff(candidateCount: 2));
foreach (var code in new[] {
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_SEAL_NOT_COMPLETED_RETAINED",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_CURRENT_PATH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_ACTIVE_PARENT_MISMATCH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_AT_OR_BEFORE_ACTIVE_RESERVATION",
    WriteCompletionDrainRules.LateDiagnosticWriteMixedCausesFailureCode,
    WriteCompletionDrainRules.GenericLateEventFailureCode,
    WriteCompletionDrainRules.LateRetainedParentWriteFailureCode,
})
    Check("completion drain completed no-lease directory他bucketを拒否",
        !CanCompletedNoLeaseDirectoryHandoff(aggregateCode: code));
Check("completion drain completed no-lease directory birth以外を拒否",
    !CanCompletedNoLeaseDirectoryHandoff(
        authorizationFailure: "EVENT_BEFORE_BIRTH"));
Check("completion drain completed no-lease directory非System PIDを拒否",
    !CanCompletedNoLeaseDirectoryHandoff(pid: 5));
Check("completion drain completed no-lease directory setinfoを拒否",
    !CanCompletedNoLeaseDirectoryHandoff(eventName: "setinfo"));
Check("completion drain completed no-lease directory file object 0を拒否",
    !CanCompletedNoLeaseDirectoryHandoff(fileObject: 0));
var completedNoLeaseAxisNames = new[] {
    "unbound object", "completed retained", "voice phase", "seal phase",
    "seal parent", "no active lease", "completion upper", "post completion",
};
for (var index = 0; index < completedNoLeaseTuple.Length; index++)
{
    var oneFalse = completedNoLeaseTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain completed no-lease {completedNoLeaseAxisNames[index]} falseを拒否",
        !CanCompletedNoLeaseDirectoryHandoff(tuple: oneFalse));
}
var completedNoLeaseTupleBefore = completedNoLeaseTuple.ToArray();
_ = CanCompletedNoLeaseDirectoryHandoff();
Check("completion drain completed no-lease handoff純粋規則は入力state無変更",
    completedNoLeaseTuple.SequenceEqual(completedNoLeaseTupleBefore));
const string completedNoLeaseAmbiguousCode =
    "F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS";
Check("completion drain completed no-lease ambiguous codeはexact 88文字",
    WriteCompletionDrainRules
        .CompletedNoLeaseDirectoryHandoffCandidateAmbiguousFailureCode ==
            completedNoLeaseAmbiguousCode &&
    completedNoLeaseAmbiguousCode.Length == 88);
foreach (var count in new[] { -1, 0, 1 })
    Check($"completion drain completed no-lease候補{count}件はoverrideなし",
        WriteCompletionDrainRules
            .CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
                count,
                WriteCompletionDrainRules
                    .LateDiagnosticWriteActiveLeaseMissingFailureCode) is null);
foreach (var count in new[] { 2, int.MaxValue })
    Check($"completion drain completed no-lease候補{count}件は固定ambiguous",
        WriteCompletionDrainRules
            .CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
                count,
                WriteCompletionDrainRules
                    .LateDiagnosticWriteActiveLeaseMissingFailureCode) ==
            completedNoLeaseAmbiguousCode);
Check("completion drain completed no-lease別aggregateは複数候補でもoverrideなし",
    WriteCompletionDrainRules
        .CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
            2,
            WriteCompletionDrainRules.GenericLateEventFailureCode) is null);
var ambiguousCandidates = new[] { "seal-z", "seal-a" };
var ambiguousCandidatesBefore = ambiguousCandidates.ToArray();
var forwardAmbiguousCode = WriteCompletionDrainRules
    .CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
        ambiguousCandidates.Length,
        WriteCompletionDrainRules.LateDiagnosticWriteActiveLeaseMissingFailureCode);
Array.Reverse(ambiguousCandidates);
var reverseAmbiguousCode = WriteCompletionDrainRules
    .CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
        ambiguousCandidates.Length,
        WriteCompletionDrainRules.LateDiagnosticWriteActiveLeaseMissingFailureCode);
Check("completion drain completed no-lease同一cause 2候補は順序非依存",
    forwardAmbiguousCode == completedNoLeaseAmbiguousCode &&
    reverseAmbiguousCode == completedNoLeaseAmbiguousCode);
Array.Reverse(ambiguousCandidates);
Check("completion drain cardinality純粋規則は候補入力を変更しない",
    ambiguousCandidates.SequenceEqual(ambiguousCandidatesBefore));

var cardinalityGate = new object();
var cardinalitySnapshotReady = new ManualResetEventSlim(false);
var cardinalityDriftAttempting = new ManualResetEventSlim(false);
var cardinalityAllowDecision = new ManualResetEventSlim(false);
var cardinalityDriftEntered = new ManualResetEventSlim(false);
var cardinalitySourceCandidates = new[] { "seal-1", "seal-2" };
var cardinalitySemanticState = new[] {
    "files=1", "allocated=10", "deferred=1", "observations=1", "notices=1",
    "lease=null", "peak=10", "free=100", "ledger=2", "queue=0", "handles=2",
};
var cardinalitySemanticBefore = string.Join("|", cardinalitySemanticState);
string? cardinalityBarrierCode = null;
string? cardinalitySemanticAtDecision = null;
var cardinalityDecision = Task.Run(() => {
    lock (cardinalityGate)
    {
        var lateCandidateSnapshot = cardinalitySourceCandidates.ToArray();
        var aggregateFailure = WriteCompletionDrainRules
            .LateDiagnosticWriteActiveLeaseMissingFailureCode;
        cardinalitySnapshotReady.Set();
        if (!cardinalityAllowDecision.Wait(TimeSpan.FromSeconds(2)))
            throw new InvalidOperationException("CARDINALITY_DECISION_TIMEOUT");
        cardinalityBarrierCode = WriteCompletionDrainRules
            .CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
                lateCandidateSnapshot.Length,
                aggregateFailure);
        cardinalitySemanticAtDecision = string.Join("|", cardinalitySemanticState);
    }
});
var cardinalityDrift = Task.Run(() => {
    if (!cardinalitySnapshotReady.Wait(TimeSpan.FromSeconds(2)))
        throw new InvalidOperationException("CARDINALITY_SNAPSHOT_TIMEOUT");
    cardinalityDriftAttempting.Set();
    lock (cardinalityGate)
    {
        cardinalityDriftEntered.Set();
        cardinalitySourceCandidates = ["seal-drift"];
        cardinalitySemanticState[5] = "lease=drift";
    }
});
if (!cardinalitySnapshotReady.Wait(TimeSpan.FromSeconds(2)) ||
    !cardinalityDriftAttempting.Wait(TimeSpan.FromSeconds(2)))
    throw new InvalidOperationException("CARDINALITY_BARRIER_START_TIMEOUT");
var cardinalityDriftBlockedAtDecision =
    !cardinalityDriftEntered.Wait(TimeSpan.FromMilliseconds(100));
cardinalityAllowDecision.Set();
Task.WaitAll(cardinalityDecision, cardinalityDrift);
Check("completion drain cardinalityは同一gate snapshotでdrift前に固定拒否",
    cardinalityDriftBlockedAtDecision &&
    cardinalityBarrierCode == completedNoLeaseAmbiguousCode &&
    cardinalitySemanticAtDecision == cardinalitySemanticBefore &&
    cardinalityDriftEntered.IsSet);
foreach (var (authorized, poisoned, expected, expectedPoisonChecks) in new[] {
    (true, false, CompletedNoLeaseKnownAuthorizationDecision.Pass, 0),
    (false, true, CompletedNoLeaseKnownAuthorizationDecision.Poisoned, 1),
    (false, false, CompletedNoLeaseKnownAuthorizationDecision.StateChanged, 1),
})
{
    var authorizationCalls = 0;
    var poisonChecks = 0;
    var decision = WriteCompletionDrainRules
        .InvokeCompletedNoLeaseKnownAuthorization(
            () => {
                authorizationCalls++;
                return authorized;
            },
            () => {
                poisonChecks++;
                return poisoned;
            });
    Check($"completion drain completed no-lease known auth {expected} exactly once",
        decision == expected && authorizationCalls == 1 &&
        poisonChecks == expectedPoisonChecks);
}
Check("completion drain immutable context 0件を許可",
    WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(
        false, false, false));
Check("completion drain immutable context各1件を許可",
    WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(true, false, false) &&
    WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(false, true, false) &&
    WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(false, false, true));
Check("completion drain immutable context混在を全拒否",
    !WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(true, true, false) &&
    !WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(true, false, true) &&
    !WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(false, true, true) &&
    !WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(true, true, true));
var completedNoLeaseContextTuple = Enumerable.Repeat(true, 17).ToArray();
Check("completion drain completed no-lease context all true",
    WriteCompletionDrainRules.CompletedNoLeaseContextStateMatches(
        completedNoLeaseContextTuple));
for (var index = 0; index < completedNoLeaseContextTuple.Length; index++)
{
    var oneFalse = completedNoLeaseContextTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain completed no-lease context軸 {index} falseを拒否",
        !WriteCompletionDrainRules.CompletedNoLeaseContextStateMatches(oneFalse));
}
var completedNoLeaseSnapshotTuple = Enumerable.Repeat(true, 9).ToArray();
Check("completion drain completed no-lease snapshot all true",
    WriteCompletionDrainRules.CompletedNoLeaseSnapshotMatches(
        completedNoLeaseSnapshotTuple));
for (var index = 0; index < completedNoLeaseSnapshotTuple.Length; index++)
{
    var oneFalse = completedNoLeaseSnapshotTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain completed no-lease snapshot軸 {index} falseを拒否",
        !WriteCompletionDrainRules.CompletedNoLeaseSnapshotMatches(oneFalse));
}
var completedNoLeaseProofTuple = Enumerable.Repeat(true, 6).ToArray();
Check("completion drain completed no-lease proof all true",
    WriteCompletionDrainRules.CompletedNoLeaseProofMatches(
        completedNoLeaseProofTuple[0], completedNoLeaseProofTuple[1],
        completedNoLeaseProofTuple[2], completedNoLeaseProofTuple[3],
        completedNoLeaseProofTuple[4], completedNoLeaseProofTuple[5]));
for (var index = 0; index < completedNoLeaseProofTuple.Length; index++)
{
    var oneFalse = completedNoLeaseProofTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain completed no-lease proof軸 {index} falseを拒否",
        !WriteCompletionDrainRules.CompletedNoLeaseProofMatches(
            oneFalse[0], oneFalse[1], oneFalse[2],
            oneFalse[3], oneFalse[4], oneFalse[5]));
}
var completedNoLeaseRootTuple = Enumerable.Repeat(true, 5).ToArray();
Check("completion drain completed no-lease root all true",
    WriteCompletionDrainRules.CompletedNoLeaseRootProcessMatches(
        completedNoLeaseRootTuple[0], completedNoLeaseRootTuple[1],
        completedNoLeaseRootTuple[2], completedNoLeaseRootTuple[3],
        completedNoLeaseRootTuple[4]));
for (var index = 0; index < completedNoLeaseRootTuple.Length; index++)
{
    var oneFalse = completedNoLeaseRootTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain completed no-lease root軸 {index} falseを拒否",
        !WriteCompletionDrainRules.CompletedNoLeaseRootProcessMatches(
            oneFalse[0], oneFalse[1], oneFalse[2], oneFalse[3], oneFalse[4]));
}
var postRequestTuple = Enumerable.Repeat(true, 12).ToArray();
bool CanPostRequest(
    bool[]? tuple = null,
    int candidateCount = 1,
    string? aggregateCode = null,
    long completionQpc = 100,
    long deadlineQpc = 110,
    long eventQpc = 101)
{
    var values = tuple ?? postRequestTuple;
    return WriteCompletionDrainRules.CanAuthorizePostRequestSystemSetInfo(
        candidateCount,
        aggregateCode ?? WriteCompletionDrainRules
            .LateDiagnosticSetInfoSealNotCompletedRetainedFailureCode,
        values[0] ? "BIRTH_MISSING" : "EVENT_BEFORE_BIRTH",
        values[1] ? 4 : 5,
        values[2] ? "setinfo" : "write",
        values[3] ? 31UL : 0UL,
        values[4],
        values[5],
        values[6],
        values[7],
        values[8],
        values[9],
        completionQpc,
        values[10],
        deadlineQpc,
        eventQpc,
        values[11]);
}
Check("completion drain post-request SetInfo all true", CanPostRequest());
Check("completion drain post-request候補0件を拒否",
    !CanPostRequest(candidateCount: 0));
Check("completion drain post-request候補2件を拒否",
    !CanPostRequest(candidateCount: 2));
foreach (var code in new[] {
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_SEAL_NOT_COMPLETED_RETAINED",
    WriteCompletionDrainRules.LateDiagnosticSetInfoCurrentPathFailureCode,
    WriteCompletionDrainRules.LateRetainedParentSetInfoFailureCode,
    WriteCompletionDrainRules.LateDiagnosticSetInfoMixedCausesFailureCode,
    WriteCompletionDrainRules.GenericLateEventFailureCode,
})
    Check("completion drain post-request write/current/parent/other/mixedを拒否",
        !CanPostRequest(aggregateCode: code));
var postRequestAxisNames = new[] {
    "authorization", "system pid", "setinfo", "file object", "voice phase",
    "seal phase", "current path", "exact generation", "completion requested",
    "completion qpc", "drain deadline", "completed record absent",
};
for (var index = 0; index < postRequestTuple.Length; index++)
{
    var oneFalse = postRequestTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain post-request {postRequestAxisNames[index]} falseを拒否",
        !CanPostRequest(tuple: oneFalse));
}
Check("completion drain post-request completion同値を拒否",
    !CanPostRequest(eventQpc: 100));
Check("completion drain post-request completion+1を許可",
    CanPostRequest(eventQpc: 101));
Check("completion drain post-request deadline同値を許可",
    CanPostRequest(eventQpc: 110));
Check("completion drain post-request deadline+1を拒否",
    !CanPostRequest(eventQpc: 111));
var postRequestTupleBefore = postRequestTuple.ToArray();
_ = CanPostRequest();
Check("completion drain post-request純粋規則は入力state無変更",
    postRequestTuple.SequenceEqual(postRequestTupleBefore));
var postRequestReplayTuple = Enumerable.Repeat(true, 15).ToArray();
var postRequestReplayAxes = new[] {
    "event kind", "current path", "completion requested", "completion present",
    "deadline present", "event qpc", "completed record absent", "proof kind",
    "generation before", "generation after", "state before", "state after",
    "proof path", "producer pid", "producer sequence",
};
Check("completion drain post-request sealed再検査all true",
    WriteCompletionDrainRules.PostRequestReplayFieldsMatch(
        WriteCompletionReplayKind.PostRequestSystemSetInfo,
        postRequestReplayTuple));
for (var index = 0; index < postRequestReplayTuple.Length; index++)
{
    var oneFalse = postRequestReplayTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain post-request fields {postRequestReplayAxes[index]} falseを拒否",
        !WriteCompletionDrainRules.PostRequestReplayFieldsMatch(
            WriteCompletionReplayKind.PostRequestSystemSetInfo,
            oneFalse));
}
var postRequestReplayTupleBefore = postRequestReplayTuple.ToArray();
_ = WriteCompletionDrainRules.PostRequestReplayFieldsMatch(
    WriteCompletionReplayKind.PostRequestSystemSetInfo,
    postRequestReplayTuple);
Check("completion drain post-request sealed再検査純粋規則は入力state無変更",
    postRequestReplayTuple.SequenceEqual(postRequestReplayTupleBefore));
Check("completion drain flagなしlate sealed再検査を拒否",
    !WriteCompletionDrainRules.PostRequestReplayFieldsMatch(
        WriteCompletionReplayKind.NormalEpoch,
        postRequestReplayTuple));
var sealedRecheckFields = Enumerable.Repeat(true, 11).ToArray();
Check("completion drain sealed recheck seal 0固定診断",
    WriteCompletionDrainRules.RecheckSealedFailure(0, sealedRecheckFields) ==
        WriteCompletionDrainRules.RecheckSealMissingFailureCode);
Check("completion drain sealed recheck seal 1 all true許可",
    WriteCompletionDrainRules.RecheckSealedFailure(1, sealedRecheckFields) is null);
Check("completion drain sealed recheck seal 2固定診断",
    WriteCompletionDrainRules.RecheckSealedFailure(2, sealedRecheckFields) ==
        WriteCompletionDrainRules.RecheckSealAmbiguousFailureCode);
for (var index = 0; index < sealedRecheckFields.Length; index++)
{
    var oneFalse = sealedRecheckFields.ToArray();
    oneFalse[index] = false;
    Check($"completion drain sealed recheck fields軸 {index} false固定診断",
        WriteCompletionDrainRules.RecheckSealedFailure(1, oneFalse) ==
            WriteCompletionDrainRules.RecheckFieldsFailureCode);
}
var sealedRecheckFieldsBefore = sealedRecheckFields.ToArray();
_ = WriteCompletionDrainRules.RecheckSealedFailure(1, sealedRecheckFields);
Check("completion drain sealed recheck純粋規則は入力state無変更",
    sealedRecheckFields.SequenceEqual(sealedRecheckFieldsBefore));
Check("completion drain sealed recheck seal identity falseは既存code",
    WriteCompletionDrainRules.RecheckIdentityFailure(false, true) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
Check("completion drain sealed recheck proof identity falseは既存code",
    WriteCompletionDrainRules.RecheckIdentityFailure(true, false) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
Check("completion drain sealed recheck identity all true許可",
    WriteCompletionDrainRules.RecheckIdentityFailure(true, true) is null);
var activeProducerTuple = Enumerable.Repeat(true, 4).ToArray();
string ActiveProducerBirth(
    bool[]? tuple = null,
    bool recordPresent = true,
    string? aggregateCode = null,
    long phaseStartedAtQpc = 100,
    long producerStartedAtQpc = 101,
    long activeReservationQpc = 110,
    long eventQpc = 102)
{
    var values = tuple ?? activeProducerTuple;
    return WriteCompletionDrainRules.ActiveProducerBirthFailureCode(
        aggregateCode ?? WriteCompletionDrainRules
            .LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode,
        recordPresent,
        values[0],
        values[1],
        values[2],
        values[3],
        phaseStartedAtQpc,
        producerStartedAtQpc,
        activeReservationQpc,
        eventQpc);
}
Check("completion drain active producer他bucketは分類しない",
    ActiveProducerBirth(aggregateCode:
        WriteCompletionDrainRules.LateDiagnosticWriteMixedCausesFailureCode) ==
        WriteCompletionDrainRules.LateDiagnosticWriteMixedCausesFailureCode);
Check("completion drain active producer record欠落を固定分類",
    ActiveProducerBirth(recordPresent: false) == WriteCompletionDrainRules
        .LateDiagnosticWriteActiveProducerRecordMissingFailureCode);
Check("completion drain active producer all trueはbirth後分類",
    ActiveProducerBirth() == WriteCompletionDrainRules
        .LateDiagnosticWriteAfterActiveProducerBirthFailureCode);
for (var index = 0; index < activeProducerTuple.Length; index++)
{
    var oneFalse = activeProducerTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain active producer tuple軸 {index} falseを拒否",
        ActiveProducerBirth(tuple: oneFalse) == WriteCompletionDrainRules
            .LateDiagnosticWriteActiveProducerTupleMismatchFailureCode);
}
Check("completion drain active producer phase/birth同値を拒否",
    ActiveProducerBirth(producerStartedAtQpc: 100) == WriteCompletionDrainRules
        .LateDiagnosticWriteActiveProducerTupleMismatchFailureCode);
Check("completion drain active producer phase/birth+1を許可",
    ActiveProducerBirth(producerStartedAtQpc: 101) == WriteCompletionDrainRules
        .LateDiagnosticWriteAfterActiveProducerBirthFailureCode);
Check("completion drain active producer birth/reservation同値を許可",
    ActiveProducerBirth(producerStartedAtQpc: 110, eventQpc: 110) ==
        WriteCompletionDrainRules
            .LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode);
Check("completion drain active producer birth/reservation+1を拒否",
    ActiveProducerBirth(producerStartedAtQpc: 111) == WriteCompletionDrainRules
        .LateDiagnosticWriteActiveProducerTupleMismatchFailureCode);
Check("completion drain active producer event birth-1を同値以前分類",
    ActiveProducerBirth(eventQpc: 100) == WriteCompletionDrainRules
        .LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode);
Check("completion drain active producer event birth同値を同値以前分類",
    ActiveProducerBirth(eventQpc: 101) == WriteCompletionDrainRules
        .LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode);
Check("completion drain active producer event birth+1をbirth後分類",
    ActiveProducerBirth(eventQpc: 102) == WriteCompletionDrainRules
        .LateDiagnosticWriteAfterActiveProducerBirthFailureCode);
Check("completion drain active producer event reservation同値をbirth後分類",
    ActiveProducerBirth(eventQpc: 110) == WriteCompletionDrainRules
        .LateDiagnosticWriteAfterActiveProducerBirthFailureCode);
Check("completion drain active producer event reservation+1を拒否",
    ActiveProducerBirth(eventQpc: 111) == WriteCompletionDrainRules
        .LateDiagnosticWriteActiveProducerTupleMismatchFailureCode);
var activeProducerTupleBefore = activeProducerTuple.ToArray();
_ = ActiveProducerBirth();
Check("completion drain active producer純粋規則は入力state無変更",
    activeProducerTuple.SequenceEqual(activeProducerTupleBefore));
var reservationBirthTuple = Enumerable.Repeat(true, 13).ToArray();
string ReservationProducerBirth(
    bool[]? tuple = null,
    string? legacyCode = null,
    long phaseStartedAtQpc = 100,
    long birthStartedAtQpc = 101,
    long leaseReservedAtQpc = 110,
    long currentPathReservedAtQpc = 110,
    long eventQpc = 102)
{
    var values = tuple ?? reservationBirthTuple;
    return WriteCompletionDrainRules.ReservationProducerBirthFailureCode(
        legacyCode ?? WriteCompletionDrainRules
            .LateDiagnosticWriteActiveProducerRecordMissingFailureCode,
        values[0], values[1], values[2], values[3], values[4], values[5],
        values[6], values[7], values[8], values[9], values[10], values[11],
        values[12], phaseStartedAtQpc, birthStartedAtQpc,
        leaseReservedAtQpc, currentPathReservedAtQpc, eventQpc);
}
Check("completion drain reservation birth all trueはbirth後分類",
    ReservationProducerBirth() == WriteCompletionDrainRules
        .LateDiagnosticWriteAfterReservationBirthFailureCode);
var reservationContradictionAxes = new[] {
    "registered record absent", "active lease", "active phase", "event reservation",
};
for (var index = 0; index < reservationContradictionAxes.Length; index++)
{
    var oneFalse = reservationBirthTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain reservation birth {reservationContradictionAxes[index]} falseはstate changed",
        ReservationProducerBirth(tuple: oneFalse) ==
            "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
}
for (var index = 4; index <= 5; index++)
{
    var oneFalse = reservationBirthTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain reservation birth snapshot/record軸 {index} falseはmissing",
        ReservationProducerBirth(tuple: oneFalse) == WriteCompletionDrainRules
            .LateDiagnosticWriteReservationBirthRecordMissingFailureCode);
}
var reservationTupleAxisNames = new[] {
    "pid", "start key", "lease sequence", "record sequence", "phase instance",
    "phase start", "reservation",
};
for (var index = 6; index < reservationBirthTuple.Length; index++)
{
    var oneFalse = reservationBirthTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain reservation birth {reservationTupleAxisNames[index - 6]} falseはtuple mismatch",
        ReservationProducerBirth(tuple: oneFalse) == WriteCompletionDrainRules
            .LateDiagnosticWriteReservationBirthTupleMismatchFailureCode);
}
Check("completion drain reservation birth event birth-1は同値以前",
    ReservationProducerBirth(eventQpc: 100) == WriteCompletionDrainRules
        .LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode);
Check("completion drain reservation birth event birth同値は同値以前",
    ReservationProducerBirth(eventQpc: 101) == WriteCompletionDrainRules
        .LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode);
Check("completion drain reservation birth phase/birth同値はtuple mismatch",
    ReservationProducerBirth(birthStartedAtQpc: 100) == WriteCompletionDrainRules
        .LateDiagnosticWriteReservationBirthTupleMismatchFailureCode);
Check("completion drain reservation birth birth/reservation同値を許可",
    ReservationProducerBirth(birthStartedAtQpc: 110, eventQpc: 110) ==
        WriteCompletionDrainRules
            .LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode);
Check("completion drain reservation birth birth/reservation+1はtuple mismatch",
    ReservationProducerBirth(birthStartedAtQpc: 111) == WriteCompletionDrainRules
        .LateDiagnosticWriteReservationBirthTupleMismatchFailureCode);
Check("completion drain reservation birth event/reservation+1はstate changed",
    ReservationProducerBirth(eventQpc: 111) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
Check("completion drain reservation birth event initial同値はbirth後",
    ReservationProducerBirth(eventQpc: 110) == WriteCompletionDrainRules
        .LateDiagnosticWriteAfterReservationBirthFailureCode);
Check("completion drain reservation birth initial+1/current同値はbirth後",
    ReservationProducerBirth(currentPathReservedAtQpc: 111, eventQpc: 111) ==
        WriteCompletionDrainRules
            .LateDiagnosticWriteAfterReservationBirthFailureCode);
Check("completion drain reservation birth current+1はstate changed",
    ReservationProducerBirth(currentPathReservedAtQpc: 111, eventQpc: 112) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
Check("completion drain reservation birth current逆転はstate changed",
    ReservationProducerBirth(currentPathReservedAtQpc: 109) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
Check("completion drain reservation birth rename昇格後current同値はbirth後",
    ReservationProducerBirth(currentPathReservedAtQpc: 120, eventQpc: 120) ==
        WriteCompletionDrainRules
            .LateDiagnosticWriteAfterReservationBirthFailureCode);
foreach (var legacyCode in new[] {
    WriteCompletionDrainRules.LateDiagnosticWriteActiveProducerTupleMismatchFailureCode,
    WriteCompletionDrainRules.LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode,
    WriteCompletionDrainRules.LateDiagnosticWriteAfterActiveProducerBirthFailureCode,
})
    Check("completion drain reservation fallbackは既存3分類を不変返却",
        ReservationProducerBirth(legacyCode: legacyCode) == legacyCode);
var reservationBirthTupleBefore = reservationBirthTuple.ToArray();
_ = ReservationProducerBirth();
Check("completion drain reservation birth純粋規則は入力state無変更",
    reservationBirthTuple.SequenceEqual(reservationBirthTupleBefore));
Check("completion drain reservation birth 4 codeは96/96/94/87文字",
    WriteCompletionDrainRules
        .LateDiagnosticWriteReservationBirthRecordMissingFailureCode.Length == 96 &&
    WriteCompletionDrainRules
        .LateDiagnosticWriteReservationBirthTupleMismatchFailureCode.Length == 96 &&
    WriteCompletionDrainRules
        .LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode.Length == 94 &&
    WriteCompletionDrainRules
        .LateDiagnosticWriteAfterReservationBirthFailureCode.Length == 87);
Check("producer birth fence deadline checked生成",
    WriteLeaseProducerBirthFenceRules.TryCreateDeadline(100, 10, out var fenceDeadline) &&
    fenceDeadline == 200);
Check("producer birth fence start非正を拒否",
    !WriteLeaseProducerBirthFenceRules.TryCreateDeadline(0, 10, out _));
Check("producer birth fence frequency非正を拒否",
    !WriteLeaseProducerBirthFenceRules.TryCreateDeadline(100, 0, out _));
Check("producer birth fence duration overflowを拒否",
    !WriteLeaseProducerBirthFenceRules.TryCreateDeadline(1, long.MaxValue, out _));
Check("producer birth fence deadline overflowを拒否",
    !WriteLeaseProducerBirthFenceRules.TryCreateDeadline(long.MaxValue, 1, out _));
Check("producer birth fence deadline-1は継続",
    !WriteLeaseProducerBirthFenceRules.IsDeadlineReached(199, 200));
Check("producer birth fence deadline同値はtimeout",
    WriteLeaseProducerBirthFenceRules.IsDeadlineReached(200, 200));
Check("producer birth fence deadline+1はtimeout",
    WriteLeaseProducerBirthFenceRules.IsDeadlineReached(201, 200));
Check("producer birth fence 1ms未満はceiling 1ms",
    WriteLeaseProducerBirthFenceRules.CeilingWaitMilliseconds(1, 1001) == 1);
Check("producer birth fence exact 1秒は1000ms",
    WriteLeaseProducerBirthFenceRules.CeilingWaitMilliseconds(1000, 1000) == 1000);
Check("producer birth fence 1秒+1tickは1001ms",
    WriteLeaseProducerBirthFenceRules.CeilingWaitMilliseconds(1001, 1000) == 1001);
Check("producer birth fence int上限直前はexact変換",
    WriteLeaseProducerBirthFenceRules.CeilingWaitMilliseconds(2_147_483, 1) ==
        2_147_483_000);
Check("producer birth fence wait msはint上限へsaturate",
    WriteLeaseProducerBirthFenceRules.CeilingWaitMilliseconds(long.MaxValue, 1) ==
        int.MaxValue);
var absentBirthFingerprint = new ProducerBirthFingerprint(false, 0, 0);
var staleBirthFingerprint = new ProducerBirthFingerprint(true, 7, 80);
var matchingBirthFingerprint = new ProducerBirthFingerprint(true, 9, 90);
Check("producer birth fence absent unchangedはwait",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        absentBirthFingerprint, absentBirthFingerprint, 9) ==
        ProducerBirthFingerprintDecision.Wait);
Check("producer birth fence absentからmatchingはready",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        absentBirthFingerprint, matchingBirthFingerprint, 9) ==
        ProducerBirthFingerprintDecision.Ready);
Check("producer birth fence absentからdifferentはtuple mismatch",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        absentBirthFingerprint, staleBirthFingerprint, 9) ==
        ProducerBirthFingerprintDecision.TupleMismatch);
Check("producer birth fence stale unchanged/duplicateはwait",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        staleBirthFingerprint, staleBirthFingerprint, 9) ==
        ProducerBirthFingerprintDecision.Wait);
Check("producer birth fence staleからmatchingはready",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        staleBirthFingerprint, matchingBirthFingerprint, 9) ==
        ProducerBirthFingerprintDecision.Ready);
Check("producer birth fence staleからdifferent更新はtuple mismatch",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        staleBirthFingerprint, new ProducerBirthFingerprint(true, 8, 85), 9) ==
        ProducerBirthFingerprintDecision.TupleMismatch);
Check("producer birth fence matching entryはwait 0でready",
    WriteLeaseProducerBirthFenceRules.FingerprintDecision(
        matchingBirthFingerprint, matchingBirthFingerprint, 9) ==
        ProducerBirthFingerprintDecision.Ready);
var monitorGate = new object();
using var monitorWaiterReady = new ManualResetEventSlim(false);
using var monitorCallbackEntered = new ManualResetEventSlim(false);
using var monitorSpuriousObserved = new ManualResetEventSlim(false);
using var monitorDuplicateObserved = new ManualResetEventSlim(false);
var monitorCondition = false;
var monitorSpuriousWakeCount = 0;
var monitorGateRestored = false;
var monitorWaiter = Task.Run(() => {
    lock (monitorGate)
    {
        Monitor.Enter(monitorGate);
        try
        {
            monitorWaiterReady.Set();
            while (!monitorCondition)
            {
                _ = Monitor.Wait(monitorGate, 2_000);
                if (!monitorCondition)
                {
                    monitorSpuriousWakeCount++;
                    monitorSpuriousObserved.Set();
                    if (monitorSpuriousWakeCount >= 2)
                    {
                        monitorDuplicateObserved.Set();
                    }
                }
            }
            monitorGateRestored = Monitor.IsEntered(monitorGate);
        }
        finally
        {
            Monitor.Exit(monitorGate);
        }
    }
});
Check("producer birth fence waiterは短い上限内にwait開始",
    monitorWaiterReady.Wait(TimeSpan.FromSeconds(2)));
var monitorCallback = Task.Run(() => {
    lock (monitorGate)
    {
        monitorCallbackEntered.Set();
        Monitor.PulseAll(monitorGate);
    }
    _ = monitorSpuriousObserved.Wait(TimeSpan.FromSeconds(2));
    lock (monitorGate)
    {
        Monitor.PulseAll(monitorGate);
    }
    _ = monitorDuplicateObserved.Wait(TimeSpan.FromSeconds(2));
    lock (monitorGate)
    {
        monitorCondition = true;
        Monitor.PulseAll(monitorGate);
    }
});
Check("producer birth fence callbackはwait中にgate取得",
    monitorCallbackEntered.Wait(TimeSpan.FromSeconds(2)));
Check("producer birth fence waiter/callbackは短い上限内に完了",
    Task.WaitAll([monitorWaiter, monitorCallback], TimeSpan.FromSeconds(3)));
Check("producer birth fence spurious wake後もconditionを再検査",
    monitorSpuriousWakeCount >= 1 && monitorCondition);
Check("producer birth fence duplicate Pulse後もconditionを再検査",
    monitorSpuriousWakeCount >= 2 && monitorCondition);
Check("producer birth fence wake後は再帰gate countを復元",
    monitorGateRestored);
var preWaitGate = new object();
var preWaitCondition = false;
var preWaitCount = 0;
lock (preWaitGate)
{
    preWaitCondition = true;
    Monitor.PulseAll(preWaitGate);
}
var preWaitWaiter = Task.Run(() => {
    lock (preWaitGate)
    {
        while (!preWaitCondition)
        {
            preWaitCount++;
            _ = Monitor.Wait(preWaitGate, 100);
        }
    }
});
Check("producer birth fence pre-wait Pulse後は条件検査だけで完了",
    preWaitWaiter.Wait(TimeSpan.FromSeconds(2)) && preWaitCount == 0);
Check("producer birth fence raw code集合はexact 4",
    WriteLeaseProducerBirthFenceRules.RawFailureCodes.Count == 4 &&
    WriteLeaseProducerBirthFenceRules.RawFailureCodes.Distinct().Count() == 4 &&
    WriteLeaseProducerBirthFenceRules.RawFailureCodes.All(code =>
        code.Length <= 127));
Check("producer birth fence identity取得GuardExceptionを固定codeへ正規化",
    WriteLeaseProducerBirthFenceRules.NormalizeProcessIdentityGuardFailureCode(
        "PROCESS_START_KEY_QUERY_FAILED") ==
        WriteLeaseProducerBirthFenceRules.ProcessIdentityFailureCode);
Check("producer birth fence identity取得の別GuardExceptionも固定codeへ正規化",
    WriteLeaseProducerBirthFenceRules.NormalizeProcessIdentityGuardFailureCode(
        "PROCESS_WAIT_FAILED") ==
        WriteLeaseProducerBirthFenceRules.ProcessIdentityFailureCode);
var successfulReservationTransaction = new WriteLeaseReservationTransaction();
string? publishedReservationLease = null;
successfulReservationTransaction.Publish(
    () => "snapshot",
    snapshot => $"lease:{snapshot}",
    lease => publishedReservationLease = lease);
Check("producer birth fence transactionは成功時だけsnapshot/leaseを公開",
    successfulReservationTransaction.SnapshotCreated &&
    successfulReservationTransaction.LeaseCreated &&
    successfulReservationTransaction.Published &&
    publishedReservationLease == "lease:snapshot");
foreach (var rawFenceFailureCode in
    WriteLeaseProducerBirthFenceRules.RawFailureCodes)
{
    var failedReservationTransaction = new WriteLeaseReservationTransaction();
    var observedFailureCode = "";
    try
    {
        throw failedReservationTransaction.FenceFailure(rawFenceFailureCode);
    }
    catch (Exception error)
    {
        observedFailureCode = error.Message;
    }
    Check($"producer birth fence {rawFenceFailureCode}は予約state未作成",
        observedFailureCode == rawFenceFailureCode &&
        !failedReservationTransaction.SnapshotCreated &&
        !failedReservationTransaction.LeaseCreated &&
        !failedReservationTransaction.Published);
}
var abortLifecycle = RunCapacityGuardLifecycleFixture(null);
Check("capacity lifecycleはgate内disposed→first failure→Pulseを開始",
    abortLifecycle.BeganDispose && abortLifecycle.Disposed &&
    abortLifecycle.StoredFailureCode ==
        CapacityGuardLifecycleRules.SessionAbortFailureCode);
Check("capacity lifecycleはgate解放前にcancelする",
    abortLifecycle.CancellationBeforeGateRelease);
Check("capacity lifecycleはpipe完了前にresourceを破棄しない",
    abortLifecycle.PipeIncompleteBeforeGateRelease &&
    abortLifecycle.ResourceIntactBeforeGateRelease);
Check("capacity lifecycle waiterはPulseで即時起床してabortを観測",
    abortLifecycle.WaiterWokePromptly &&
    abortLifecycle.ObservedFailureCode ==
        CapacityGuardLifecycleRules.SessionAbortFailureCode);
Check("capacity lifecycleはpipe完了後だけresourceを破棄",
    abortLifecycle.DrainCompleted &&
    abortLifecycle.ResourceDisposedAfterPipe);
const string existingLifecycleFailure = "ETW_BUFFER_LOSS";
var existingFailureLifecycle =
    RunCapacityGuardLifecycleFixture(existingLifecycleFailure);
Check("capacity lifecycle Disposeは既存first failureを不変保持",
    existingFailureLifecycle.BeganDispose &&
    existingFailureLifecycle.Disposed &&
    existingFailureLifecycle.StoredFailureCode == existingLifecycleFailure);
Check("capacity lifecycle waiterは既存first failureを優先観測",
    existingFailureLifecycle.WaiterWokePromptly &&
    existingFailureLifecycle.ObservedFailureCode == existingLifecycleFailure);
Check("capacity lifecycle既存failure時もpipe後resource破棄",
    existingFailureLifecycle.CancellationBeforeGateRelease &&
    existingFailureLifecycle.DrainCompleted &&
    existingFailureLifecycle.ResourceDisposedAfterPipe);
Check("completion drain external code集合はexact 50",
    WriteCompletionDrainRules.ExternalFailureCodes.Count == 50 &&
    WriteCompletionDrainRules.ExternalFailureCodes.Distinct().Count() == 50 &&
    WriteCompletionDrainRules.ExternalFailureCodes.All(code =>
        code.Length <= 127));
Check("completion drain追加code最長は96文字",
    WriteCompletionDrainRules.ExternalFailureCodes
        .Where(code => code.Contains("_LATE_DIAG_", StringComparison.Ordinal))
        .Max(code => code.Length) == 96);
Check("completion drain external exact 50 codeはnative replyで不変",
    WriteCompletionDrainRules.ExternalFailureCodes.All(code =>
        WriteCompletionDrainRules.NormalizeExternalFailureCode(code) == code));
var privateAmbiguitySentinels = new[] {
    "2147483647", "C:/sentinel/private.wav", "9223372036854775000",
    "pid=424242", "fileObject=0xDEADBEEF", "identity=volume:private",
    "sequence=18446744073709551614", "handle=0xFEEDFACE",
};
var externalAmbiguityCode = WriteCompletionDrainRules.NormalizeExternalFailureCode(
    WriteCompletionDrainRules
        .CompletedNoLeaseDirectoryHandoffCandidateAmbiguousFailureCode);
Check("completion drain ambiguous fixed diagnosticはsentinel非包含",
    externalAmbiguityCode == completedNoLeaseAmbiguousCode &&
    privateAmbiguitySentinels.All(sentinel =>
        !externalAmbiguityCode.Contains(sentinel, StringComparison.Ordinal)));
foreach (var code in new[] {
    "F005_ETW_WRITE_COMPLETION_DRAIN_PRIVATE",
    "F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT_EXTRA",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_WRITE_SAME_LEASE",
    "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_SETINFO_SAME_LEASE",
    "F005_ETW_WRITE_COMPLETION_DRAIN_COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS_EXTRA",
    "F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT".PadRight(128, 'X'),
})
    Check("completion drain unknown/extra/exact128はnative generic化",
        WriteCompletionDrainRules.NormalizeExternalFailureCode(code) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
Check("completion drain exact 0固定診断", WriteCompletionDrainRules.LookupFailure(1, 1, 0, 0) == WriteCompletionDrainRules.LookupExactMissingFailureCode);
Check("completion drain exact 1許可", WriteCompletionDrainRules.LookupFailure(1, 1, 1, 0) is null);
Check("completion drain exact 2固定診断", WriteCompletionDrainRules.LookupFailure(2, 2, 2, 0) == WriteCompletionDrainRules.LookupExactAmbiguousFailureCode);
Check("completion drain同一parent 2 sealからepoch 1を一意選択",
    WriteCompletionDrainRules.LookupFailure(2, 1, 1, 0) is null);
Check("completion drain同一parent 2 sealでepoch 0 late 0固定診断",
    WriteCompletionDrainRules.LookupFailure(2, 0, 0, 0) ==
        WriteCompletionDrainRules.LookupEpochEmptyNoLateProofFailureCode);
var contradictoryLookups = new[] {
    (-1, 0, 0, 0), (1, -1, 0, 0), (1, 0, -1, 0), (1, 0, 0, -1),
    (1, 2, 0, 0), (1, 1, 2, 0), (1, 1, 1, 1), (0, 0, 0, 1),
};
foreach (var (broad, epoch, exact, late) in contradictoryLookups)
    Check("completion drain lookup矛盾は旧genericへfail-close",
        WriteCompletionDrainRules.LookupFailure(broad, epoch, exact, late) ==
            WriteCompletionDrainRules.EventTupleMismatchFailureCode);
Check("completion drain初回identity code", WriteCompletionDrainRules.ProcessFailureCode("IDENTITY", false) == "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_IDENTITY_FAILED");
Check("completion drain初回wait code", WriteCompletionDrainRules.ProcessFailureCode("PROCESS_WAIT_FAILED", false) == "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_WAIT_FAILED");
Check("completion drain初回job code", WriteCompletionDrainRules.ProcessFailureCode("JOB_QUERY_FAILED", false) == "F005_ETW_WRITE_COMPLETION_DRAIN_JOB_QUERY_FAILED");
Check("completion drain初回tuple code", WriteCompletionDrainRules.ProcessRejection(false, false, true, false) == "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_TUPLE_MISMATCH");
Check("completion drain初回signaled code", WriteCompletionDrainRules.ProcessRejection(true, true, true, false) == "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_SIGNALED");
Check("completion drain初回outside code", WriteCompletionDrainRules.ProcessRejection(true, false, false, false) == "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_OUTSIDE_JOB");
Check("completion drain再検査identity code", WriteCompletionDrainRules.ProcessFailureCode("IDENTITY", true) == "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_IDENTITY_FAILED");
Check("completion drain再検査wait code", WriteCompletionDrainRules.ProcessFailureCode("PROCESS_WAIT_FAILED", true) == "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_WAIT_FAILED");
Check("completion drain再検査tuple code", WriteCompletionDrainRules.ProcessRejection(false, true, true, true) == "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH");
Check("completion drain再検査not-signaled code", WriteCompletionDrainRules.ProcessRejection(true, false, true, true) == "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED");
var recheckTuple = Enumerable.Repeat(true, 8).ToArray();
Check("completion drain再照合all true", DrainRecheck(recheckTuple) is null);
var recheckCodes = new[] {
    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED",
    "F005_ETW_WRITE_COMPLETION_DRAIN_DIRECTORY_IDENTITY_MISMATCH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_CURRENT_IDENTITY_MISMATCH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_IDENTITY_FAILED",
    "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_WAIT_FAILED",
    "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH",
    "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED",
};
for (var index = 0; index < recheckTuple.Length; index++)
{
    var oneFalse = recheckTuple.ToArray();
    oneFalse[index] = false;
    Check($"completion drain再照合 {index} exact code",
        DrainRecheck(oneFalse) == recheckCodes[index]);
}
Check("completion drain parent owner missing拒否",
    !WriteCompletionDrainRules.PrepareTupleMatches(true, false, true));
Check("completion drain parent owner identity mismatch拒否",
    !WriteCompletionDrainRules.PrepareTupleMatches(true, true, false, true));
Check("completion drain root inactive拒否",
    !WriteCompletionDrainRules.PrepareTupleMatches(true, true, false));
Check("completion drain直列2 seal許可",
    WriteCompletionDrainRules.IsBufferWithinLimit(2, 64, 128));
Check("completion drain lease FileObject互換",
    WriteCompletionDrainRules.FileObjectCompatible(false, 31, 31, true));
Check("completion drain parent未結合FileObject互換",
    WriteCompletionDrainRules.FileObjectCompatible(true, 41, 31, false));
Check("completion drain parent zero FileObject拒否",
    !WriteCompletionDrainRules.FileObjectCompatible(true, 0, 31, false));
Check("completion drain parent結合済み別FileObject拒否",
    !WriteCompletionDrainRules.FileObjectCompatible(true, 41, 31, true));
Check("completion drain別path別FileObject拒否",
    !WriteCompletionDrainRules.FileObjectCompatible(false, 41, 31, false));
Check("completion drain inactive通常eventを即時適用",
    WriteCompletionDrainRules.QueueDecision(false, false, 0, 8192) == "APPLY");
Check("completion drain retained単独lateを即時適用",
    WriteCompletionDrainRules.QueueDecision(false, false, 0, 8192) == "APPLY");
Check("completion drain sealed eventをqueue",
    WriteCompletionDrainRules.QueueDecision(false, true, 0, 8192) == "QUEUE");
Check("completion drain active後通常eventをqueue",
    WriteCompletionDrainRules.QueueDecision(true, false, 1, 8192) == "QUEUE");
Check("completion drain queue上限拒否",
    WriteCompletionDrainRules.QueueDecision(true, false, 8192, 8192) == "BUFFER_LIMIT");
Check("completion drain排他admission後だけfinal mutation許可",
    WriteCompletionDrainRules.CanMutateFinalState(true, 0, true, true));
Check("completion drain active callback中final mutation拒否",
    !WriteCompletionDrainRules.CanMutateFinalState(true, 1, true, true));
Check("completion drain callback entry競合中final mutation拒否",
    !WriteCompletionDrainRules.CanMutateFinalState(false, 0, true, true));
Check("completion drain queue残存final mutation拒否",
    !WriteCompletionDrainRules.CanMutateFinalState(true, 0, false, true));
Check("completion drain counter不安定final mutation拒否",
    !WriteCompletionDrainRules.CanMutateFinalState(true, 0, true, false));
var unstableFinalState = "completion-requested";
if (WriteCompletionDrainRules.CanMutateFinalState(true, 0, true, false))
    unstableFinalState = "completed-retained";
Check("completion drain counter不安定時state mutationなし",
    unstableFinalState == "completion-requested");
foreach (var terminal in new[] {
    "NORMAL",
    "DEFER_OR_REORDER",
    "FIXED_REFUSAL",
    "PROCESS_IDENTITY_PROBE",
    "CLOSED_OR_POISONED",
})
    Check($"completion drain {terminal} terminal exactly once",
        WriteCompletionDrainRules.AccountedDelta(terminal) == 1);
Check("completion drain unknown terminal未accounted",
    WriteCompletionDrainRules.AccountedDelta("PRIVATE") == 0);
Check("completion drain replay identity failure",
    WriteCompletionDrainRules.ApplicationFailure(false, true, true) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
Check("completion drain replay capacity failure",
    WriteCompletionDrainRules.ApplicationFailure(true, false, true) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
Check("completion drain replay retained handle failure",
    WriteCompletionDrainRules.ApplicationFailure(true, true, false) ==
        "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_IDENTITY_FAILED");
Check("completion drain replay apply all true",
    WriteCompletionDrainRules.ApplicationFailure(true, true, true) is null);
var replayBaseline = WriteCompletionDrainRules.ReplayFixture(new[] {
    (Sequence: 1L, AllocatedBytes: 10L),
    (Sequence: 2L, AllocatedBytes: 30L),
    (Sequence: 3L, AllocatedBytes: 20L),
});
Check("completion drain replay capacity/Observation baseline",
    replayBaseline.ObservationOrder.SequenceEqual([1L, 2L, 3L]) &&
    replayBaseline.FinalAllocatedBytes == 20 &&
    replayBaseline.PeakAllocatedBytes == 30);
foreach (var (name, fixture) in new[] {
    ("prepare前", new[] { (3L, 20L), (1L, 10L), (2L, 30L) }),
    ("prepare直後", new[] { (2L, 30L), (3L, 20L), (1L, 10L) }),
    ("commit中", new[] { (2L, 30L), (1L, 10L), (3L, 20L) }),
    ("helper exit直後", new[] { (3L, 20L), (2L, 30L), (1L, 10L) }),
    ("complete drain中", new[] { (1L, 10L), (3L, 20L), (2L, 30L) }),
    ("complete後", new[] { (3L, 20L), (1L, 10L), (2L, 30L) }),
    ("phase end直前", new[] { (1L, 10L), (2L, 30L), (3L, 20L) }),
})
{
    var replay = WriteCompletionDrainRules.ReplayFixture(
        fixture.Select(item => (
            Sequence: item.Item1,
            AllocatedBytes: item.Item2)));
    Check($"completion drain callback順 {name}を同一replay",
        replay == replayBaseline ||
        replay.ObservationOrder.SequenceEqual(replayBaseline.ObservationOrder) &&
        replay.FinalAllocatedBytes == replayBaseline.FinalAllocatedBytes &&
        replay.PeakAllocatedBytes == replayBaseline.PeakAllocatedBytes);
}

var immutableLedger = new WriteCompletionBindingLedger([
    (11UL, "volume:file-a", "cache/a.wav"),
]);
Check("completion ledger baseline head/cursor同値",
    immutableLedger.AdmissionHead == 0 &&
    immutableLedger.AppliedCursor == 0 &&
    immutableLedger.EntryCount == 1);
var sealedCurrentProof = immutableLedger.Admit(
    WriteCompletionBindingKind.SealedCurrent,
    "setinfo",
    11,
    "volume:file-a",
    "cache/a.wav",
    1);
var sealedParentProof = immutableLedger.Admit(
    WriteCompletionBindingKind.SealedParent,
    "write",
    12,
    "volume:directory",
    "cache",
    null);
var otherBoundProof = immutableLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "create",
    21,
    "volume:file-b",
    "cache/b.wav");
Check("completion ledger sealed-current exact generation不変",
    sealedCurrentProof.GenerationBefore == 1 &&
    sealedCurrentProof.GenerationAfter == 1 &&
    sealedCurrentProof.StateBefore == sealedCurrentProof.StateAfter);
Check("completion ledger sealed-parent unbound不変",
    sealedParentProof.GenerationBefore == 0 &&
    sealedParentProof.GenerationAfter == 0 &&
    sealedParentProof.StateBefore == WriteCompletionBindingState.Unbound &&
    sealedParentProof.StateAfter == WriteCompletionBindingState.Unbound);
Check("completion ledger other-bound bootstrap",
    otherBoundProof.GenerationBefore == 0 &&
    otherBoundProof.GenerationAfter == 1 &&
    otherBoundProof.StateAfter == WriteCompletionBindingState.Bound);
immutableLedger.Validate([
    sealedCurrentProof,
    sealedParentProof,
    otherBoundProof,
]);
Check("completion ledger dry-runはcursor無変更",
    immutableLedger.AppliedCursor == 0);
immutableLedger.ValidateAndCommit([
    sealedCurrentProof,
    sealedParentProof,
    otherBoundProof,
]);
Check("completion ledger batch commit後だけcursor進行",
    immutableLedger.AppliedCursor == immutableLedger.AdmissionHead &&
    immutableLedger.IsConverged);

var deleteFirstLedger = new WriteCompletionBindingLedger([
    (31UL, "volume:file-c", "cache/c.wav"),
]);
var deleteFirst = deleteFirstLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "delete",
    31,
    "volume:file-c",
    "cache/c.wav");
var cleanupSecond = deleteFirstLedger.AdmitCleanup(31);
Check("completion ledger delete→Cleanup同generation terminal",
    cleanupSecond is not null &&
    deleteFirst.GenerationAfter == cleanupSecond.GenerationAfter &&
    cleanupSecond.DeleteSeenAfter && cleanupSecond.CleanupSeenAfter);

var cleanupFirstLedger = new WriteCompletionBindingLedger([
    (41UL, "volume:file-d", "cache/d.wav"),
]);
var cleanupFirst = cleanupFirstLedger.AdmitCleanup(41)!;
var deleteSecond = cleanupFirstLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "delete",
    41,
    "volume:file-d",
    "cache/d.wav");
Check("completion ledger Cleanup→delete同generation terminal",
    cleanupFirst.GenerationAfter == deleteSecond.GenerationAfter &&
    deleteSecond.DeleteSeenAfter && deleteSecond.CleanupSeenAfter);
Check("completion ledger unknown Cleanup ignore",
    cleanupFirstLedger.AdmitCleanup(999) is null);
var duplicateCleanupRejected = false;
try { _ = cleanupFirstLedger.AdmitCleanup(41); }
catch (InvalidOperationException error)
{
    duplicateCleanupRejected = error.Message == "BINDING_MISMATCH";
}
Check("completion ledger同種Cleanup duplicate拒否", duplicateCleanupRejected);
var rebindProof = deleteFirstLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "create",
    31,
    "volume:file-new",
    "cache/new.wav");
Check("completion ledger pointer再利用は次generation",
    rebindProof.GenerationBefore == 1 && rebindProof.GenerationAfter == 2 &&
    rebindProof.Identity == "volume:file-new");
var proofGapRejected = false;
try { immutableLedger.ValidateAndCommit([rebindProof]); }
catch (InvalidOperationException error)
{
    proofGapRejected = error.Message == "BINDING_MISMATCH";
}
Check("completion ledger proof gapをcommit前拒否", proofGapRejected);
Check("completion ledger proof gap時cursor不変",
    immutableLedger.IsConverged);
Check("completion ledger型別上限固定",
    WriteCompletionBindingLedger.MaximumEntries == 8192 &&
    WriteCompletionBindingLedger.MaximumProofs == 8192);
var maximumBaseline = new WriteCompletionBindingLedger(
    Enumerable.Range(1, 8192).Select(index => (
        (ulong)index,
        $"volume:file-{index}",
        $"cache/{index}.wav")));
Check("completion ledger dictionary 8192同値許可",
    maximumBaseline.EntryCount == 8192);
var maximumBaselineHead = maximumBaseline.AdmissionHead;
var entryOverflowRejected = false;
try
{
    _ = maximumBaseline.Admit(
        WriteCompletionBindingKind.OtherBound,
        "create",
        9001,
        "volume:overflow",
        "cache/overflow.wav");
}
catch (WriteCompletionBufferLimitException)
{
    entryOverflowRejected = true;
}
Check("completion ledger entry上限拒否はhead不変",
    entryOverflowRejected &&
    maximumBaseline.AdmissionHead == maximumBaselineHead);
var baseline8193Rejected = false;
try
{
    _ = new WriteCompletionBindingLedger(
        Enumerable.Range(1, 8193).Select(index => (
            (ulong)index,
            $"volume:file-{index}",
            $"cache/{index}.wav")));
}
catch (InvalidOperationException error)
{
    baseline8193Rejected = error is WriteCompletionBufferLimitException;
}
Check("completion ledger dictionary 8193拒否", baseline8193Rejected);
var proofLimitLedger = new WriteCompletionBindingLedger([]);
for (var index = 1; index <= 8192; index++)
    _ = proofLimitLedger.Admit(
        WriteCompletionBindingKind.SealedParent,
        "write",
        (ulong)index,
        "volume:directory",
        "cache");
Check("completion ledger proof 8192同値許可",
    proofLimitLedger.AdmissionHead == 8192);
var proof8193Rejected = false;
try
{
    _ = proofLimitLedger.Admit(
        WriteCompletionBindingKind.SealedParent,
        "write",
        8193,
        "volume:directory",
        "cache");
}
catch (InvalidOperationException error)
{
    proof8193Rejected = error is WriteCompletionBufferLimitException;
}
Check("completion ledger proof 8193拒否", proof8193Rejected);

var reusedCleanupLedger = new WriteCompletionBindingLedger([
    (51UL, "volume:file-old", "cache/old.wav"),
]);
var retiredOld = reusedCleanupLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "delete",
    51,
    "volume:file-old",
    "cache/old.wav");
_ = reusedCleanupLedger.AdmitCleanup(51);
var reusedNew = reusedCleanupLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "create",
    51,
    "volume:file-new",
    "cache/new.wav");
Check("completion ledger FileObject再利用をgeneration flagへ保持",
    retiredOld.GenerationAfter == 1 &&
    reusedNew.GenerationAfter == 2 &&
    reusedNew.ReusedAfter);
var reusedCleanupRejected = false;
var reusedHeadBeforeCleanup = reusedCleanupLedger.AdmissionHead;
try { _ = reusedCleanupLedger.AdmitCleanup(51); }
catch (InvalidOperationException error)
{
    reusedCleanupRejected = error.Message == "BINDING_MISMATCH";
}
Check("completion ledger 再利用後pathless Cleanupを恒久拒否",
    reusedCleanupRejected &&
    reusedCleanupLedger.AdmissionHead == reusedHeadBeforeCleanup &&
    reusedCleanupLedger.MatchesGeneration(
        51,
        reusedNew.GenerationAfter,
        "volume:file-new",
        "cache/new.wav"));

var retiredParentLedger = new WriteCompletionBindingLedger([
    (61UL, "volume:file-retired", "cache/retired.wav"),
]);
_ = retiredParentLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "delete",
    61,
    "volume:file-retired",
    "cache/retired.wav");
var retiredParentHead = retiredParentLedger.AdmissionHead;
var retiredParentRejected = false;
try
{
    _ = retiredParentLedger.Admit(
        WriteCompletionBindingKind.SealedParent,
        "write",
        61,
        "volume:directory",
        "cache");
}
catch (InvalidOperationException error)
{
    retiredParentRejected = error.Message == "BINDING_MISMATCH";
}
Check("completion ledger retiredはsealed-parent unboundでない",
    retiredParentRejected &&
    retiredParentLedger.AdmissionHead == retiredParentHead &&
    !retiredParentLedger.IsUnbound(61));

var tamperLedger = new WriteCompletionBindingLedger([]);
var canonicalProof = tamperLedger.Admit(
    WriteCompletionBindingKind.OtherBound,
    "create",
    71,
    "volume:canonical",
    "cache/canonical.wav");
foreach (var (name, tampered) in new[] {
    ("identity", canonicalProof with { Identity = "volume:tampered" }),
    ("path", canonicalProof with { Path = "cache/tampered.wav" }),
    ("generation-after", canonicalProof with { GenerationAfter = 2 }),
    ("state-after", canonicalProof with {
        StateAfter = WriteCompletionBindingState.Retired,
    }),
    ("reused-flag", canonicalProof with { ReusedAfter = true }),
    ("delete-flag", canonicalProof with { DeleteSeenAfter = true }),
    ("cleanup-flag", canonicalProof with { CleanupSeenAfter = true }),
})
{
    var rejected = false;
    try { tamperLedger.ValidateAndCommit([tampered]); }
    catch (InvalidOperationException error)
    {
        rejected = error.Message == "BINDING_MISMATCH";
    }
    Check($"completion ledger canonical proof {name}改竄拒否",
        rejected && tamperLedger.AppliedCursor == 0);
}

var proofSequenceOverflowRejected = false;
try
{
    var overflowLedger = new WriteCompletionBindingLedger(
        [],
        long.MaxValue);
    _ = overflowLedger.Admit(
        WriteCompletionBindingKind.SealedParent,
        "write",
        81,
        "volume:directory",
        "cache");
}
catch (WriteCompletionBufferLimitException)
{
    proofSequenceOverflowRejected = true;
}
Check("completion ledger proofSequence overflowはBUFFER_LIMIT",
    proofSequenceOverflowRejected);
var generationOverflowRejected = false;
try { _ = WriteCompletionBindingLedger.CheckedNextGeneration(long.MaxValue); }
catch (WriteCompletionBufferLimitException)
{
    generationOverflowRejected = true;
}
Check("completion ledger generation overflowはBUFFER_LIMIT",
    generationOverflowRejected);

var atomicValues = new List<int> { 1 };
var atomicCheckpoint = atomicValues.ToArray();
var lateApplyRejected = false;
try
{
    WriteCompletionAtomicBatchRules.Execute(
        () => {
            atomicValues.Add(2);
            atomicValues.Add(3);
            throw new InvalidOperationException("late apply");
        },
        () => atomicValues.Add(4),
        () => {
            atomicValues.Clear();
            atomicValues.AddRange(atomicCheckpoint);
        });
}
catch (InvalidOperationException error)
{
    lateApplyRejected = error.Message == "late apply";
}
Check("completion atomic batch 後段apply失敗を全rollback",
    lateApplyRejected && atomicValues.SequenceEqual([1]));
var commitFailureRejected = false;
try
{
    WriteCompletionAtomicBatchRules.Execute(
        () => atomicValues.Add(2),
        () => throw new InvalidOperationException("commit"),
        () => {
            atomicValues.Clear();
            atomicValues.AddRange(atomicCheckpoint);
        });
}
catch (InvalidOperationException error)
{
    commitFailureRejected = error.Message == "commit";
}
Check("completion atomic batch commit失敗もsemantic rollback",
    commitFailureRejected && atomicValues.SequenceEqual([1]));
foreach (var drift in new[] {
    "new lease", "root exit", "seal release", "directory replacement", "proof drift",
})
{
    var fixture = RunCompletedNoLeaseQueueFixture(drift);
    Check($"completion completed no-lease queued {drift}はcapacity前停止/保持/cleanup",
        fixture.Poisoned &&
        fixture.SemanticUnchanged &&
        fixture.CapacityApplyCount == 0 &&
        fixture.NoticeApplyCount == 0 &&
        fixture.ObservationApplyCount == 0 &&
        fixture.InternalEvidenceRetainedWhilePoisoned &&
        fixture.ReapplyCount == 0 &&
        fixture.Disposed &&
        fixture.QueueClearedAfterDispose);
}
var completedNoLeaseApplyFailure =
    RunCompletedNoLeaseQueueFixture("apply failure");
Check("completion completed no-lease apply失敗はsemantic rollback/証拠保持/cleanup",
    completedNoLeaseApplyFailure.Poisoned &&
    completedNoLeaseApplyFailure.SemanticUnchanged &&
    completedNoLeaseApplyFailure.CapacityApplyCount == 1 &&
    completedNoLeaseApplyFailure.NoticeApplyCount == 0 &&
    completedNoLeaseApplyFailure.ObservationApplyCount == 0 &&
    completedNoLeaseApplyFailure.InternalEvidenceRetainedWhilePoisoned &&
    completedNoLeaseApplyFailure.ReapplyCount == 0 &&
    completedNoLeaseApplyFailure.Disposed &&
    completedNoLeaseApplyFailure.QueueClearedAfterDispose);
var completedNoLeaseQueuePass = RunCompletedNoLeaseQueueFixture(null);
Check("completion completed no-lease queued PASSは1回だけatomic適用",
    !completedNoLeaseQueuePass.Poisoned &&
    !completedNoLeaseQueuePass.SemanticUnchanged &&
    completedNoLeaseQueuePass.CapacityApplyCount == 1 &&
    completedNoLeaseQueuePass.NoticeApplyCount == 1 &&
    completedNoLeaseQueuePass.ObservationApplyCount == 1 &&
    completedNoLeaseQueuePass.ReapplyCount == 0 &&
    completedNoLeaseQueuePass.Disposed &&
    completedNoLeaseQueuePass.QueueClearedAfterDispose);
using (var boundedReplayStore = new WriteCompletionReplayStore<
    CompletedNoLeaseReplayFixtureSnapshot,
    CompletedNoLeaseReplayFixtureCleanup,
    CompletedNoLeaseReplayFixtureHandle>(1, 1, 1))
{
    var boundedLedger = new WriteCompletionBindingLedger([]);
    boundedReplayStore.Ledger = boundedLedger;
    var boundedProof = boundedLedger.Admit(
        WriteCompletionBindingKind.OtherBound,
        "write",
        91,
        "volume:bounded",
        "cache/bounded");
    boundedReplayStore.EnqueueSnapshot(
        new CompletedNoLeaseReplayFixtureSnapshot(boundedProof));
    boundedReplayStore.AddCleanup(
        new CompletedNoLeaseReplayFixtureCleanup(boundedProof));
    boundedReplayStore.AddGenerationHandle(
        (boundedProof.FileObject, boundedProof.GenerationAfter),
        new CompletedNoLeaseReplayFixtureHandle());
    Check("completion replay store snapshot上限超過を拒否",
        RejectsReplayBufferLimit(() => boundedReplayStore.EnqueueSnapshot(
            new CompletedNoLeaseReplayFixtureSnapshot(boundedProof))));
    Check("completion replay store cleanup上限超過を拒否",
        RejectsReplayBufferLimit(() => boundedReplayStore.AddCleanup(
            new CompletedNoLeaseReplayFixtureCleanup(boundedProof))));
    using var extraHandle = new CompletedNoLeaseReplayFixtureHandle();
    Check("completion replay store generation handle上限超過を拒否",
        RejectsReplayBufferLimit(() => boundedReplayStore.AddGenerationHandle(
            (92, 1),
            extraHandle)));
}

using (var admission = new WriteCompletionCallbackAdmission())
using (var firstCallbackEntered = new ManualResetEventSlim(false))
using (var releaseFirstCallback = new ManualResetEventSlim(false))
using (var finalAttempted = new ManualResetEventSlim(false))
using (var finalEntered = new ManualResetEventSlim(false))
using (var releaseFinal = new ManualResetEventSlim(false))
using (var secondCallbackAttempted = new ManualResetEventSlim(false))
using (var secondCallbackEntered = new ManualResetEventSlim(false))
{
    var accounted = 0;
    var finalMutationAllowed = false;
    var firstCallback = Task.Run(() => {
        using (admission.EnterCallback())
        {
            firstCallbackEntered.Set();
            releaseFirstCallback.Wait(TimeSpan.FromSeconds(5));
            Interlocked.Increment(ref accounted);
        }
    });
    Check("completion admission active callback fixture開始",
        firstCallbackEntered.Wait(TimeSpan.FromSeconds(5)));
    var final = Task.Run(() => {
        finalAttempted.Set();
        using (admission.EnterFinal())
        {
            finalMutationAllowed = WriteCompletionDrainRules.CanMutateFinalState(
                admission.IsFinalHeld,
                admission.ActiveCallbackCount,
                queueEmpty: true,
                countersStable: Volatile.Read(ref accounted) == 1);
            finalEntered.Set();
            releaseFinal.Wait(TimeSpan.FromSeconds(5));
        }
    });
    finalAttempted.Wait(TimeSpan.FromSeconds(5));
    SpinWait.SpinUntil(
        () => admission.WaitingFinalCount == 1,
        TimeSpan.FromSeconds(5));
    Check("completion admission active callback中final取得不可",
        !finalEntered.IsSet && admission.WaitingFinalCount == 1);
    var secondCallback = Task.Run(() => {
        secondCallbackAttempted.Set();
        using (admission.EnterCallback())
        {
            secondCallbackEntered.Set();
            Interlocked.Increment(ref accounted);
        }
    });
    secondCallbackAttempted.Wait(TimeSpan.FromSeconds(5));
    Check("completion admission writer待機後new callback取得不可",
        !secondCallbackEntered.Wait(TimeSpan.FromMilliseconds(100)));
    releaseFirstCallback.Set();
    var finalAcquired = finalEntered.Wait(TimeSpan.FromSeconds(5));
    Check("completion admission callback解放後final mutation許可",
        finalAcquired && finalMutationAllowed &&
        Volatile.Read(ref accounted) == 1 &&
        !secondCallbackEntered.IsSet);
    releaseFinal.Set();
    var secondAcquired = secondCallbackEntered.Wait(TimeSpan.FromSeconds(5));
    Task.WaitAll([firstCallback, final, secondCallback], TimeSpan.FromSeconds(5));
    Check("completion admission final解放後callback/accounted進行",
        secondAcquired && Volatile.Read(ref accounted) == 2);
}

if (failures.Count != 0)
{
    Console.Error.WriteLine($"System SetInfo correlation tests failed: {string.Join(", ", failures)}");
    return 1;
}

Console.WriteLine($"System SetInfo correlation tests PASS ({checks} cases)");
return 0;

bool BoundLeaseCheap(
    string authorizationFailure = "BIRTH_MISSING",
    int systemPid = 4,
    string eventName = "write",
    ulong fileObject = 31,
    bool fileObjectUnbound = true,
    bool voicePhase = true,
    bool leasePhaseMatches = true,
    bool exactCandidate = true,
    bool pendingRenamePathNull = true,
    bool renameReservationNull = true) =>
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.EvaluateCheapPredicates(
        authorizationFailure,
        systemPid,
        eventName,
        fileObject,
        fileObjectUnbound,
        voicePhase,
        leasePhaseMatches,
        100,
        101,
        102,
        () => exactCandidate,
        () => pendingRenamePathNull,
        () => renameReservationNull);

bool BoundLeaseInitialTuple(bool[] inputs) =>
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.InitialTupleMatches(
        inputs[0], inputs[1], inputs[2], inputs[3], inputs[4], inputs[5],
        inputs[6], inputs[7], inputs[8], inputs[9], inputs[10], inputs[11]);

string? BoundLeaseTupleRecheck(bool[] inputs) =>
    SystemDirectoryBoundLeaseRejoinAuthorizationRules.TupleRecheckFailure(
        inputs[0], inputs[1], inputs[2], inputs[3], inputs[4], inputs[5]);

string? DrainRecheck(bool[] inputs) => WriteCompletionDrainRules.RecheckFailure(
    inputs[0], inputs[1], inputs[2], inputs[3], inputs[4], inputs[5],
    inputs[6], inputs[7]);

bool DeferredTuple(
    int deferredWorkerPid = 4,
    ulong deferredSequence = 17,
    string deferredPhase = "voice",
    string? deferredWorkId = "001104",
    string activePhaseInstanceId = "phase-a",
    string leasePhaseInstanceId = "phase-a",
    string deferredRelativePath = ".cache/voice.wav",
    string deferredSnapshotPath = ".cache/voice.wav",
    ulong deferredFileObject = 31,
    bool deferredFileObjectUnbound = true) =>
    SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
        .DeferredTupleMatches(
            deferredWorkerPid,
            4,
            deferredSequence,
            17,
            deferredPhase,
            "voice",
            deferredWorkId,
            "001104",
            "phase-a",
            activePhaseInstanceId,
            leasePhaseInstanceId,
            deferredRelativePath,
            deferredSnapshotPath,
            ".cache/voice.wav",
            deferredFileObject,
            deferredFileObjectUnbound,
            101,
            100,
            110);

string Unbound(
    bool leaseSnapshotAbsent = true,
    bool eventAfterReservation = true,
    bool currentInspectionSucceeded = true,
    bool currentExists = true,
    int deferredCount = 1,
    bool deferredTupleMatches = true,
    bool currentIdentityMatches = true,
    string? processInspectionFailure = null,
    bool processTupleMatches = true,
    bool processSignaled = false,
    bool processJobMember = true) =>
    SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules.Classify(
        leaseSnapshotAbsent,
        eventAfterReservation,
        currentInspectionSucceeded,
        currentExists,
        deferredCount,
        deferredTupleMatches,
        currentIdentityMatches,
        processInspectionFailure,
        processTupleMatches,
        processSignaled,
        processJobMember);

string NoPending(
    bool pathIsFile = false,
    bool pathIsDirectory = true,
    string directoryStage = "CANDIDATE",
    bool leaseStateStable = true,
    bool leaseParentMatches = true,
    bool leaseClosed = false,
    bool leaseBound = true,
    bool leaseSnapshotAvailable = true,
    bool leaseBindingAvailable = true,
    bool leaseBindingMatches = true,
    bool leaseCurrentExists = true,
    bool leaseIdentityMatches = true,
    bool leaseOutsideJob = false) =>
    SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticRules.Classify(
        pathIsFile,
        pathIsDirectory,
        directoryStage,
        leaseStateStable,
        leaseParentMatches,
        leaseClosed,
        leaseBound,
        leaseSnapshotAvailable,
        leaseBindingAvailable,
        leaseBindingMatches,
        leaseCurrentExists,
        leaseIdentityMatches,
        leaseOutsideJob);

(
    bool BeganDispose,
    bool Disposed,
    string? StoredFailureCode,
    bool CancellationBeforeGateRelease,
    bool PipeIncompleteBeforeGateRelease,
    bool ResourceIntactBeforeGateRelease,
    bool WaiterWokePromptly,
    string? ObservedFailureCode,
    bool DrainCompleted,
    bool ResourceDisposedAfterPipe
) RunCapacityGuardLifecycleFixture(string? preexistingFailureCode)
{
    var lifecycleGate = new object();
    using var lifecycleCancellation = new CancellationTokenSource();
    using var waiterReady = new ManualResetEventSlim(false);
    using var waiterWoke = new ManualResetEventSlim(false);
    var lifecycleDisposed = false;
    string? lifecycleFailureCode = null;
    string? observedFailureCode = null;
    var resourceDisposed = 0;
    var resourceDisposedAfterPipe = 0;
    var pipeTask = Task.Run(() => {
        lock (lifecycleGate)
        {
            waiterReady.Set();
            while (true)
            {
                var failure = CapacityGuardLifecycleRules.WaitAbortFailureCode(
                    lifecycleFailureCode,
                    lifecycleDisposed,
                    lifecycleCancellation.IsCancellationRequested,
                    journalClosed: false,
                    WriteLeaseProducerBirthFenceRules.StateChangedFailureCode);
                if (failure is not null)
                {
                    observedFailureCode = failure;
                    waiterWoke.Set();
                    return;
                }
                _ = Monitor.Wait(lifecycleGate, 2_000);
            }
        }
    });
    if (!waiterReady.Wait(TimeSpan.FromSeconds(2)))
        throw new InvalidOperationException("LIFECYCLE_WAITER_START_TIMEOUT");

    Task drainTask;
    bool beganDispose;
    bool cancellationBeforeGateRelease;
    bool pipeIncompleteBeforeGateRelease;
    bool resourceIntactBeforeGateRelease;
    var wakeTimer = new System.Diagnostics.Stopwatch();
    lock (lifecycleGate)
    {
        lifecycleFailureCode = preexistingFailureCode;
        beganDispose = CapacityGuardLifecycleRules.BeginDisposeLocked(
            lifecycleGate,
            ref lifecycleDisposed,
            ref lifecycleFailureCode);
        drainTask = Task.Run(() =>
            CapacityGuardLifecycleRules.CancelDrainPipeAndDispose(
                lifecycleCancellation,
                pipeTask,
                TimeSpan.FromSeconds(2),
                () => {
                    Interlocked.Exchange(
                        ref resourceDisposedAfterPipe,
                        pipeTask.IsCompleted ? 1 : -1);
                    Interlocked.Exchange(ref resourceDisposed, 1);
                }));
        cancellationBeforeGateRelease = SpinWait.SpinUntil(
            () => lifecycleCancellation.IsCancellationRequested,
            TimeSpan.FromSeconds(1));
        pipeIncompleteBeforeGateRelease = !pipeTask.IsCompleted;
        resourceIntactBeforeGateRelease =
            Volatile.Read(ref resourceDisposed) == 0;
        wakeTimer.Start();
    }
    var waiterWokePromptly =
        waiterWoke.Wait(TimeSpan.FromSeconds(1)) &&
        wakeTimer.Elapsed < TimeSpan.FromSeconds(1);
    var drainCompleted = drainTask.Wait(TimeSpan.FromSeconds(3));
    return (
        beganDispose,
        lifecycleDisposed,
        lifecycleFailureCode,
        cancellationBeforeGateRelease,
        pipeIncompleteBeforeGateRelease,
        resourceIntactBeforeGateRelease,
        waiterWokePromptly,
        observedFailureCode,
        drainCompleted,
        Volatile.Read(ref resourceDisposedAfterPipe) == 1 &&
            Volatile.Read(ref resourceDisposed) == 1);
}

(
    bool Poisoned,
    bool SemanticUnchanged,
    int CapacityApplyCount,
    int NoticeApplyCount,
    int ObservationApplyCount,
    bool InternalEvidenceRetainedWhilePoisoned,
    int ReapplyCount,
    bool Disposed,
    bool QueueClearedAfterDispose
) RunCompletedNoLeaseQueueFixture(string? drift)
{
    using var replayReady = new ManualResetEventSlim(false);
    using var allowReplay = new ManualResetEventSlim(false);
    var store = new WriteCompletionReplayStore<
        CompletedNoLeaseReplayFixtureSnapshot,
        CompletedNoLeaseReplayFixtureCleanup,
        CompletedNoLeaseReplayFixtureHandle>();
    var ledger = new WriteCompletionBindingLedger([]);
    store.Ledger = ledger;
    var proof = ledger.Admit(
        WriteCompletionBindingKind.OtherBound,
        "write",
        31,
        "volume:directory",
        "cache/voice");
    var generationHandle = new CompletedNoLeaseReplayFixtureHandle();
    store.AddGenerationHandle(
        (proof.FileObject, proof.GenerationAfter),
        generationHandle);
    store.EnqueueSnapshot(new CompletedNoLeaseReplayFixtureSnapshot(proof));
    var semantic = new CompletedNoLeaseReplayFixtureSemantic();
    var rootAlive = true;
    var sealRetained = true;
    var directoryIdentityStable = true;
    var proofStable = true;
    var applyCount = 0;
    var reapplyCount = 0;
    var poisoned = false;
    var semanticUnchanged = false;
    var internalEvidenceRetained = false;
    var replay = Task.Run(() => {
        replayReady.Set();
        if (!allowReplay.Wait(TimeSpan.FromSeconds(2)))
            throw new InvalidOperationException("REPLAY_BARRIER_TIMEOUT");
        var baseline = semantic.Fingerprint();
        try
        {
            var contextStable = WriteCompletionDrainRules
                .CompletedNoLeaseContextStateMatches(
                    semantic.PendingLease is null,
                    rootAlive,
                    sealRetained,
                    directoryIdentityStable);
            _ = store.Replay(
                snapshot => snapshot.BindingProof,
                cleanup => cleanup.BindingProof,
                snapshot => {
                    var key = (
                        snapshot.BindingProof.FileObject,
                        snapshot.BindingProof.GenerationAfter);
                    var hasGenerationHandle =
                        store.GenerationHandles.TryGetValue(key, out var retained) &&
                        !retained.Disposed;
                    if (!contextStable || !WriteCompletionDrainRules
                        .CompletedNoLeaseProofMatches(
                            proofStable,
                            true,
                            snapshot.BindingProof.FileObject == 31,
                            snapshot.BindingProof.Path == "cache/voice",
                            snapshot.BindingProof.Identity == "volume:directory",
                            snapshot.BindingProof.StateAfter ==
                                WriteCompletionBindingState.Bound) ||
                        !hasGenerationHandle)
                        throw new GuardException(
                            "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                },
                _ => semantic.CapacityPreflightCount++,
                semantic.Capture,
                _ => {
                    applyCount++;
                    semantic.ApplyAll();
                    if (drift == "apply failure")
                        throw new GuardException(
                            "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                },
                _ => semantic.ApplyAll(),
                semantic.Restore);
        }
        catch (GuardException)
        {
            poisoned = true;
        }
        semanticUnchanged = semantic.Fingerprint() == baseline;
        internalEvidenceRetained = poisoned &&
            store.SnapshotCount == 1 &&
            store.LedgerRetained &&
            store.GenerationHandleCount == 1 &&
            ledger.AdmissionHead == proof.ProofSequence &&
            ledger.AppliedCursor < proof.ProofSequence &&
            !generationHandle.Disposed;
        // production callback入口と同じくpoison後はqueue replayへ再進入しない。
        for (var callbackAttempt = 0; callbackAttempt < 2; callbackAttempt++)
            if (!poisoned)
                reapplyCount += store.Replay(
                    snapshot => snapshot.BindingProof,
                    cleanup => cleanup.BindingProof,
                    _ => { },
                    _ => { },
                    semantic.Capture,
                    _ => semantic.ApplyAll(),
                    _ => semantic.ApplyAll(),
                    semantic.Restore) ? 1 : 0;
    });
    if (!replayReady.Wait(TimeSpan.FromSeconds(2)))
        throw new InvalidOperationException("REPLAY_TASK_START_TIMEOUT");
    switch (drift)
    {
        case "new lease":
            semantic.PendingLease = "new-lease";
            break;
        case "root exit":
            rootAlive = false;
            break;
        case "seal release":
            sealRetained = false;
            break;
        case "directory replacement":
            directoryIdentityStable = false;
            semantic.Files["directory"] = "volume:replacement";
            break;
        case "proof drift":
            proofStable = false;
            break;
    }
    allowReplay.Set();
    replay.GetAwaiter().GetResult();
    var capacityApplyCount = applyCount;
    var noticeApplyCount = semantic.NoticeApplyCount;
    var observationApplyCount = semantic.ObservationApplyCount;
    store.Dispose();
    return (
        poisoned,
        semanticUnchanged,
        capacityApplyCount,
        noticeApplyCount,
        observationApplyCount,
        internalEvidenceRetained,
        reapplyCount,
        store.IsDisposed && generationHandle.Disposed,
        store.SnapshotCount == 0 &&
            store.CleanupCount == 0 &&
            store.GenerationHandleCount == 0 &&
            !store.LedgerRetained);
}

bool RejectsReplayBufferLimit(Action action)
{
    try
    {
        action();
        return false;
    }
    catch (GuardException error)
    {
        return error.Code ==
            "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT";
    }
}

void Check(string name, bool condition)
{
    checks++;
    if (!condition) failures.Add(name);
}

internal sealed record CompletedNoLeaseReplayFixtureSnapshot(
    ImmutableBindingProof BindingProof);

internal sealed record CompletedNoLeaseReplayFixtureCleanup(
    ImmutableBindingProof BindingProof);

internal sealed class CompletedNoLeaseReplayFixtureHandle : IDisposable
{
    internal bool Disposed { get; private set; }
    public void Dispose() => Disposed = true;
}

internal sealed class CompletedNoLeaseReplayFixtureSemantic
{
    internal Dictionary<string, string> Files { get; } = new() {
        ["directory"] = "volume:directory",
    };
    internal Dictionary<string, long> Allocated { get; } = new() {
        ["volume:directory"] = 10,
    };
    internal List<string> Deferred { get; } = ["deferred-baseline"];
    internal List<string> Observations { get; } = ["observation-baseline"];
    internal List<string> Notices { get; } = ["notice-baseline"];
    internal string? PendingLease { get; set; }
    internal long Peak { get; private set; } = 10;
    internal long Free { get; private set; } = 100;
    internal int CapacityPreflightCount { get; set; }
    internal int NoticeApplyCount { get; private set; }
    internal int ObservationApplyCount { get; private set; }

    internal string Fingerprint() => string.Join("|", [
        string.Join(",", Files.OrderBy(item => item.Key)
            .Select(item => $"{item.Key}={item.Value}")),
        string.Join(",", Allocated.OrderBy(item => item.Key)
            .Select(item => $"{item.Key}={item.Value}")),
        string.Join(",", Deferred),
        string.Join(",", Observations),
        string.Join(",", Notices),
        PendingLease ?? "null",
        Peak.ToString(),
        Free.ToString(),
        NoticeApplyCount.ToString(),
        ObservationApplyCount.ToString(),
    ]);

    internal void ApplyAll()
    {
        Files["applied"] = "volume:applied";
        Allocated["volume:directory"] = 20;
        Deferred.Add("deferred-applied");
        Observations.Add("observation-applied");
        Notices.Add("notice-applied");
        PendingLease = "applied-lease";
        Peak = 20;
        Free = 90;
        NoticeApplyCount++;
        ObservationApplyCount++;
    }

    internal CompletedNoLeaseReplayFixtureSemanticCheckpoint Capture() => new(
        new Dictionary<string, string>(Files, StringComparer.Ordinal),
        new Dictionary<string, long>(Allocated, StringComparer.Ordinal),
        Deferred.ToArray(),
        Observations.ToArray(),
        Notices.ToArray(),
        PendingLease,
        Peak,
        Free,
        NoticeApplyCount,
        ObservationApplyCount);

    internal void Restore(CompletedNoLeaseReplayFixtureSemanticCheckpoint checkpoint)
    {
        Files.Clear();
        foreach (var item in checkpoint.Files) Files.Add(item.Key, item.Value);
        Allocated.Clear();
        foreach (var item in checkpoint.Allocated) Allocated.Add(item.Key, item.Value);
        Deferred.Clear();
        Deferred.AddRange(checkpoint.Deferred);
        Observations.Clear();
        Observations.AddRange(checkpoint.Observations);
        Notices.Clear();
        Notices.AddRange(checkpoint.Notices);
        PendingLease = checkpoint.PendingLease;
        Peak = checkpoint.Peak;
        Free = checkpoint.Free;
        NoticeApplyCount = checkpoint.NoticeApplyCount;
        ObservationApplyCount = checkpoint.ObservationApplyCount;
    }
}

internal sealed record CompletedNoLeaseReplayFixtureSemanticCheckpoint(
    IReadOnlyDictionary<string, string> Files,
    IReadOnlyDictionary<string, long> Allocated,
    IReadOnlyList<string> Deferred,
    IReadOnlyList<string> Observations,
    IReadOnlyList<string> Notices,
    string? PendingLease,
    long Peak,
    long Free,
    int NoticeApplyCount,
    int ObservationApplyCount);
