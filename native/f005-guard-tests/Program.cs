using static SystemSetInfoCorrelationRules;

var failures = new List<string>();

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

Console.WriteLine("System SetInfo correlation tests PASS (37 cases)");
return 0;

void Check(string name, bool condition)
{
    if (!condition) failures.Add(name);
}
