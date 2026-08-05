using static SystemSetInfoCorrelationRules;

var failures = new List<string>();

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

if (failures.Count != 0)
{
    Console.Error.WriteLine($"System SetInfo correlation tests failed: {string.Join(", ", failures)}");
    return 1;
}

Console.WriteLine("System SetInfo correlation tests PASS (316 cases)");
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

void Check(string name, bool condition)
{
    if (!condition) failures.Add(name);
}
