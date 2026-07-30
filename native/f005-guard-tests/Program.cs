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

Console.WriteLine("System SetInfo correlation tests PASS (95 cases)");
return 0;

void Check(string name, bool condition)
{
    if (!condition) failures.Add(name);
}
