using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// completion-drain event tupleのlookup/recheck全分岐をproduction assemblyへ
/// 直接入力し、固定manifest順で検証する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
/// @test UT-F005-017 UT-F005-047
/// </summary>
internal static class T122TargetSuite
{
    private const string TargetId = "CHG-F005-048/T-122";
    private const string CaseMarker = "F005_T122_CASE_BASE64=";
    private const string ResultMarker = "F005_T122_RESULT_BASE64=";

    internal static int Run(string[] args)
    {
        if (args.Length != 2 || args[0] != "--target" || args[1] != TargetId)
        {
            EmitResult("argument-invalid", 0, 0, null, null);
            return 2;
        }

        var manifestPath = Path.Combine(
            AppContext.BaseDirectory,
            "t122-case-manifest.json");
        var manifestBytes = File.ReadAllBytes(manifestPath);
        var manifest = JsonSerializer.Deserialize<TargetManifest>(
            manifestBytes,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("TARGET_MANIFEST_INVALID");
        if (manifest.SchemaVersion != "1.0.0" || manifest.TargetId != TargetId ||
            manifest.Cases.Count == 0 ||
            manifest.Cases.Distinct(StringComparer.Ordinal).Count() != manifest.Cases.Count)
        {
            EmitResult("manifest-invalid", manifest.Cases.Count, 0,
                Sha256(manifestBytes), null);
            return 3;
        }

        using var windows = new T110TargetSuite.WindowsTupleFixture();
        var cases = CreateCases(windows);
        if (!cases.Keys.SequenceEqual(manifest.Cases, StringComparer.Ordinal))
        {
            EmitResult("manifest-case-mismatch", manifest.Cases.Count, 0,
                Sha256(manifestBytes), null);
            return 4;
        }

        var passed = 0;
        foreach (var caseId in manifest.Cases)
        {
            var result = false;
            try { result = cases[caseId](); }
            catch (Exception) { result = false; }
            Emit(CaseMarker, new { caseId, result = result ? "pass" : "fail" });
            if (result) passed++;
        }

        var resultCode = passed == manifest.Cases.Count ? "pass" : "fail";
        EmitResult(
            resultCode,
            manifest.Cases.Count,
            passed,
            Sha256(manifestBytes),
            RuntimeTuple.Capture());
        return resultCode == "pass" ? 0 : 1;
    }

    private static Dictionary<string, Func<bool>> CreateCases(
        T110TargetSuite.WindowsTupleFixture windows)
    {
        var mismatch = WriteCompletionDrainRules.EventTupleMismatchFailureCode;
        var late = WriteCompletionDrainRules.GenericLateEventFailureCode;
        var cases = new Dictionary<string, Func<bool>>(StringComparer.Ordinal) {
            ["lookup-negative-broad"] = () => Lookup(-1, 0, 0, 0) == mismatch,
            ["lookup-negative-epoch"] = () => Lookup(0, -1, 0, 0) == mismatch,
            ["lookup-negative-exact"] = () => Lookup(0, 0, -1, 0) == mismatch,
            ["lookup-negative-late"] = () => Lookup(0, 0, 0, -1) == mismatch,
            ["lookup-epoch-exceeds-broad"] = () => Lookup(1, 2, 0, 0) == mismatch,
            ["lookup-exact-exceeds-epoch"] = () => Lookup(2, 1, 2, 0) == mismatch,
            ["lookup-late-exceeds-broad"] = () => Lookup(1, 0, 0, 2) == mismatch,
            ["lookup-epoch-and-late"] = () => Lookup(2, 1, 1, 1) == mismatch,
            ["lookup-zero-broad-epoch-contradiction"] = () =>
                Lookup(0, 1, 0, 0) == mismatch,
            ["lookup-zero-broad-exact-contradiction"] = () =>
                Lookup(0, 0, 1, 0) == mismatch,
            ["lookup-zero-broad-late-contradiction"] = () =>
                Lookup(0, 0, 0, 1) == mismatch,
            ["lookup-all-zero-pass"] = () => Lookup(0, 0, 0, 0) is null,
            ["lookup-epoch-empty-no-late"] = () =>
                Lookup(1, 0, 0, 0) ==
                WriteCompletionDrainRules.LookupEpochEmptyNoLateProofFailureCode,
            ["lookup-epoch-empty-late-one"] = () => Lookup(1, 0, 0, 1) == late,
            ["lookup-epoch-empty-late-many"] = () => Lookup(2, 0, 0, 2) == late,
            ["lookup-exact-zero"] = () =>
                Lookup(1, 1, 0, 0) ==
                WriteCompletionDrainRules.LookupExactMissingFailureCode,
            ["lookup-exact-one"] = () => Lookup(1, 1, 1, 0) is null,
            ["lookup-exact-many"] = () =>
                Lookup(2, 2, 2, 0) ==
                WriteCompletionDrainRules.LookupExactAmbiguousFailureCode,
            ["lookup-broad-superset-exact-one"] = () => Lookup(2, 1, 1, 0) is null,
            ["recheck-seal-zero"] = () =>
                Recheck(0, Enumerable.Repeat(true, 11).ToArray()) ==
                WriteCompletionDrainRules.RecheckSealMissingFailureCode,
            ["recheck-seal-one-all-true"] = () =>
                Recheck(1, Enumerable.Repeat(true, 11).ToArray()) is null,
            ["recheck-seal-multiple"] = () =>
                Recheck(2, Enumerable.Repeat(true, 11).ToArray()) ==
                WriteCompletionDrainRules.RecheckSealAmbiguousFailureCode,
            ["recheck-seal-invalid"] = () =>
                Recheck(-1, Enumerable.Repeat(true, 11).ToArray()) == mismatch,
            ["recheck-fields-empty"] = () =>
                Recheck(1, []) == WriteCompletionDrainRules.RecheckFieldsFailureCode,
        };

        for (var index = 0; index < 11; index++)
        {
            var captured = index;
            cases[$"recheck-field-false-{index:00}"] = () => {
                var fields = Enumerable.Repeat(true, 11).ToArray();
                fields[captured] = false;
                return Recheck(1, fields) ==
                    WriteCompletionDrainRules.RecheckFieldsFailureCode;
            };
        }
        cases["recheck-all-fields-false"] = () =>
            Recheck(1, Enumerable.Repeat(false, 11).ToArray()) ==
            WriteCompletionDrainRules.RecheckFieldsFailureCode;
        cases["fixed-outcomes-exclusive"] = () => new HashSet<string>([
            WriteCompletionDrainRules.EventTupleMismatchFailureCode,
            WriteCompletionDrainRules.LookupEpochEmptyNoLateProofFailureCode,
            WriteCompletionDrainRules.LookupExactMissingFailureCode,
            WriteCompletionDrainRules.LookupExactAmbiguousFailureCode,
            WriteCompletionDrainRules.RecheckSealMissingFailureCode,
            WriteCompletionDrainRules.RecheckSealAmbiguousFailureCode,
            WriteCompletionDrainRules.RecheckFieldsFailureCode,
            WriteCompletionDrainRules.GenericLateEventFailureCode,
        ], StringComparer.Ordinal).Count == 8;
        cases["real-directory-file-identity-stable"] = windows.IdentityStable;
        cases["real-file-identity-replacement"] = windows.IdentityReplacementDetected;
        cases["real-job-alive-member"] = windows.AliveMember;
        cases["real-process-signaled"] = windows.SignaledMember;
        cases["real-process-different-generation"] = windows.DifferentGeneration;
        cases["real-process-outside-job"] = windows.OutsideJob;
        return cases;
    }

    private static string? Lookup(
        int broad, int epoch, int exact, int late) =>
        WriteCompletionDrainRules.LookupFailure(broad, epoch, exact, late);

    private static string? Recheck(int seals, bool[] fields) =>
        WriteCompletionDrainRules.RecheckSealedFailure(seals, fields);

    private static void EmitResult(
        string result,
        int expected,
        int passed,
        string? manifestSha256,
        RuntimeTuple? runtime) => Emit(ResultMarker, new {
            targetId = TargetId,
            result,
            expectedCaseCount = expected,
            passedCaseCount = passed,
            caseManifestSha256 = manifestSha256,
            runtime,
        });

    private static void Emit(string prefix, object value)
    {
        var json = JsonSerializer.Serialize(value);
        Console.WriteLine(prefix + Convert.ToBase64String(Encoding.UTF8.GetBytes(json)));
    }

    private static string Sha256(byte[] value) =>
        Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private sealed record TargetManifest(
        string SchemaVersion,
        string TargetId,
        IReadOnlyList<string> Cases);

    private sealed record RuntimeTuple(
        string ProductionAssemblySha256,
        string ProductionAssemblyMvid,
        string TestAssemblySha256,
        string TestAssemblyMvid,
        string TestExecutableSha256,
        string DotnetRuntime)
    {
        internal static RuntimeTuple Capture()
        {
            var production = typeof(WriteCompletionDrainRules).Assembly;
            var test = Assembly.GetExecutingAssembly();
            var executable = Environment.ProcessPath
                ?? throw new InvalidOperationException("TEST_EXECUTABLE_MISSING");
            return new RuntimeTuple(
                FileSha(production.Location),
                production.ManifestModule.ModuleVersionId.ToString("D"),
                FileSha(test.Location),
                test.ManifestModule.ModuleVersionId.ToString("D"),
                FileSha(executable),
                Environment.Version.ToString());
        }

        private static string FileSha(string path) =>
            Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
                .ToLowerInvariant();
    }
}
