using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// event directory自身へBoundなFileObjectのledger状態診断をproduction assemblyへ
/// 直接入力し、固定manifest順で検証する。hosted ETW配送順に依存せず
/// CHG-F005-071の影響を確認する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047
/// </summary>
internal static class T143TargetSuite
{
    private const string TargetId = "CHG-F005-071/T-143";
    private const string CaseMarker = "F005_T143_CASE_BASE64=";
    private const string ResultMarker = "F005_T143_RESULT_BASE64=";

    private const string Dir = "cache/voice";
    private const string ActivePath = "cache/voice/active.wav";

    private static readonly (string Key, EventDirectoryBindingState State,
        string Expected)[] States = [
        ("reused", EventDirectoryBindingState.Reused,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventDirectoryReusedFailureCode),
        ("delete-seen", EventDirectoryBindingState.DeleteSeen,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventDirectoryDeleteSeenFailureCode),
        ("cleanup-seen", EventDirectoryBindingState.CleanupSeen,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventDirectoryCleanupSeenFailureCode),
        ("live", EventDirectoryBindingState.Live,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventDirectoryLiveFailureCode),
        ("state-invalid", EventDirectoryBindingState.Invalid,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventDirectoryStateInvalidFailureCode),
    ];

    private static readonly (string Key, EventFileObjectBoundPathRelation Relation,
        string Expected)[] OtherRelations = [
        ("candidate-current", EventFileObjectBoundPathRelation.CandidateCurrentPath,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventFileObjectOtherCandidateCurrentFailureCode),
        ("candidate-parent", EventFileObjectBoundPathRelation.CandidateParentPath,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventFileObjectOtherCandidateParentFailureCode),
        ("same-parent-file", EventFileObjectBoundPathRelation.SameParentFile,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventFileObjectOtherSameParentFileFailureCode),
        ("different-parent", EventFileObjectBoundPathRelation.DifferentParent,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventFileObjectOtherDifferentParentFailureCode),
        ("relation-invalid", EventFileObjectBoundPathRelation.Invalid,
            WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundEventFileObjectOtherRelationInvalidFailureCode),
    ];

    internal static int Run(string[] args)
    {
        if (args.Length != 2 || args[0] != "--target" || args[1] != TargetId)
        {
            EmitResult("argument-invalid", 0, 0, null, null);
            return 2;
        }

        var manifestPath = Path.Combine(
            AppContext.BaseDirectory,
            "t143-case-manifest.json");
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

        var cases = CreateCases();
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

    private static Dictionary<string, Func<bool>> CreateCases()
    {
        var stateChanged = WriteCompletionDrainRules.StateChangedFailureCode;
        var cases = new Dictionary<string, Func<bool>>(StringComparer.Ordinal);

        foreach (var (key, state, expected) in States)
            foreach (var eventName in new[] { "write", "setinfo" })
                foreach (var count in new[] { 1, 2, 128 })
                {
                    var capturedState = state;
                    var capturedName = eventName;
                    var capturedCount = count;
                    var capturedExpected = expected;
                    cases[$"rule-{key}-{eventName}-{count:000}"] = () =>
                        Rule(
                            count: capturedCount,
                            eventName: capturedName,
                            binding: capturedState) == capturedExpected;
                }

        foreach (var (key, state, expected) in States)
        {
            var capturedState = state;
            var capturedExpected = expected;
            cases[$"rule-terminal-{key}"] = () =>
                Rule(binding: capturedState, exactGeneration: false) == capturedExpected;
        }

        cases["rule-binding-null"] = () => Rule(binding: null) == stateChanged;
        cases["rule-binding-undefined"] = () =>
            Rule(binding: (EventDirectoryBindingState)97) == stateChanged;

        cases["rule-priority-context-missing"] = () =>
            Rule(lease: false) == WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundContextMissingFailureCode;
        cases["rule-priority-tuple-invalid"] = () =>
            Rule(leaseFileObject: 0) == WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundTupleInvalidFailureCode;
        cases["rule-priority-phase-mismatch"] = () =>
            Rule(phaseMatch: false) == WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundPhaseMismatchFailureCode;
        cases["rule-priority-parent-mismatch"] = () =>
            Rule(parent: false) == WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundParentMismatchFailureCode;
        cases["rule-priority-reservation-order"] = () =>
            Rule(afterReservation: false) == WriteCompletionDrainRules
                .LookupPostUpperProofParentBoundReservationOrderFailureCode;

        foreach (var (key, relation, expected) in OtherRelations)
        {
            var capturedRelation = relation;
            var capturedExpected = expected;
            cases[$"rule-ignores-binding-{key}"] = () =>
                Rule(relation: capturedRelation, binding: null) == capturedExpected &&
                Rule(relation: capturedRelation,
                    binding: EventDirectoryBindingState.Reused) == capturedExpected;
        }

        cases["ledger-live"] = () =>
            Bound().MatchEventDirectoryBinding(900, Dir) ==
            EventDirectoryBindingState.Live;
        cases["ledger-fo-zero"] = () =>
            Bound().MatchEventDirectoryBinding(0, Dir) ==
            EventDirectoryBindingState.Invalid;
        cases["ledger-entry-missing"] = () =>
            Bound().MatchEventDirectoryBinding(901, Dir) ==
            EventDirectoryBindingState.Invalid;
        cases["ledger-null-dir"] = () =>
            Bound().MatchEventDirectoryBinding(900, null) ==
            EventDirectoryBindingState.Invalid;
        cases["ledger-empty-dir"] = () =>
            Bound().MatchEventDirectoryBinding(900, "") ==
            EventDirectoryBindingState.Invalid;
        cases["ledger-path-mismatch"] = () =>
            Bound().MatchEventDirectoryBinding(900, "cache/other") ==
            EventDirectoryBindingState.Invalid;

        var bound = WriteCompletionBindingState.Bound;
        var forced = new (string Key, WriteCompletionBindingState State, bool Reused,
            bool DeleteSeen, bool CleanupSeen, EventDirectoryBindingState Expected)[] {
            ("reused-only", bound, true, false, false,
                EventDirectoryBindingState.Reused),
            ("reused-precedes-all", bound, true, true, true,
                EventDirectoryBindingState.Reused),
            ("delete-only", bound, false, true, false,
                EventDirectoryBindingState.DeleteSeen),
            ("delete-precedes-cleanup", bound, false, true, true,
                EventDirectoryBindingState.DeleteSeen),
            ("cleanup-only", bound, false, false, true,
                EventDirectoryBindingState.CleanupSeen),
            ("no-flags-live", bound, false, false, false,
                EventDirectoryBindingState.Live),
            ("retired-invalid", WriteCompletionBindingState.Retired, false, false, false,
                EventDirectoryBindingState.Invalid),
            ("unbound-invalid", WriteCompletionBindingState.Unbound, false, false, false,
                EventDirectoryBindingState.Invalid),
        };
        foreach (var item in forced)
        {
            var captured = item;
            cases[$"ledger-forced-{item.Key}"] = () =>
                ForcedRelation(
                    captured.State, captured.Reused, captured.DeleteSeen,
                    captured.CleanupSeen) == captured.Expected;
        }

        cases["code-set-distinct-108"] = () =>
            WriteCompletionDrainRules.ExternalFailureCodes.Count == 108 &&
            WriteCompletionDrainRules.ExternalFailureCodes
                .Distinct(StringComparer.Ordinal).Count() == 108;
        cases["code-set-length-limit"] = () =>
            WriteCompletionDrainRules.ExternalFailureCodes.All(
                code => code.Length <= 127);
        cases["code-set-dir-prefix"] = () => States.All(item =>
            item.Expected.StartsWith(
                "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_" +
                "POST_UPPER_PROOF_PARENT_BOUND_EVENT_FO_DIR_",
                StringComparison.Ordinal) &&
            WriteCompletionDrainRules.ExternalFailureCodes.Contains(item.Expected));

        return cases;
    }

    private static string Rule(
        int count = 1,
        string eventName = "write",
        bool lease = true,
        ulong leaseFileObject = 820,
        bool phaseMatch = true,
        bool parent = true,
        bool afterReservation = true,
        bool exactGeneration = true,
        EventFileObjectBoundPathRelation? relation =
            EventFileObjectBoundPathRelation.EventDirectory,
        EventDirectoryBindingState? binding = EventDirectoryBindingState.Live) =>
        WriteCompletionDrainRules.ParentBoundActiveLeaseFailureCode(
            count,
            eventName,
            821,
            lease,
            true,
            true,
            leaseFileObject,
            "volume:active",
            ActivePath,
            true,
            phaseMatch,
            parent,
            afterReservation,
            exactGeneration,
            EventFileObjectMatchResult.BoundOtherPath,
            relation,
            binding);

    private static WriteCompletionBindingLedger Bound() =>
        new([(900UL, "volume:dir", Dir)]);

    private static EventDirectoryBindingState ForcedRelation(
        WriteCompletionBindingState state,
        bool reused,
        bool deleteSeen,
        bool cleanupSeen)
    {
        var ledger = Bound();
        var field = typeof(WriteCompletionBindingLedger).GetField(
            "admitted", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var admitted = (System.Collections.IDictionary)field.GetValue(ledger)!;
        var valueType = admitted[900UL]!.GetType();
        admitted[900UL] = Activator.CreateInstance(
            valueType,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            null,
            new object?[] { 1L, state, "volume:dir", Dir, reused, deleteSeen, cleanupSeen },
            null)!;
        return ledger.MatchEventDirectoryBinding(900, Dir);
    }

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
