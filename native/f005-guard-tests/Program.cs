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

Check("helper生存中complete拒否", !CanComplete(false, true, true, false));
Check("未解決保留complete拒否", !CanComplete(true, true, true, true));
Check("正常complete", CanComplete(true, true, true, false));

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

Console.WriteLine("System SetInfo correlation tests PASS (18 cases)");
return 0;

void Check(string name, bool condition)
{
    if (!condition) failures.Add(name);
}
