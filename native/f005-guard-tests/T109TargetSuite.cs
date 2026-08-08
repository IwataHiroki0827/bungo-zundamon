using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// pendingなしunbound lease診断をproduction evaluatorへ実Windows fixtureで結合する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-047
/// @test UT-F005-047
/// </summary>
internal static class T109TargetSuite
{
    private const string TargetId = "CHG-F005-035/T-109";
    private const string CaseMarker = "F005_T109_CASE_BASE64=";
    private const string ResultMarker = "F005_T109_RESULT_BASE64=";

    internal static int Run(string[] args)
    {
        if (args.Length != 2 || args[0] != "--target" || args[1] != TargetId)
        {
            EmitResult("argument-invalid", 0, 0, null, null);
            return 2;
        }
        var manifestPath = Path.Combine(AppContext.BaseDirectory,
            "t109-case-manifest.json");
        var manifestBytes = File.ReadAllBytes(manifestPath);
        var manifest = JsonSerializer.Deserialize<TargetManifest>(manifestBytes,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("TARGET_MANIFEST_INVALID");
        if (manifest.SchemaVersion != "1.0.0" || manifest.TargetId != TargetId ||
            manifest.Cases.Count == 0 ||
            manifest.Cases.Distinct(StringComparer.Ordinal).Count() !=
                manifest.Cases.Count)
        {
            EmitResult("manifest-invalid", manifest.Cases.Count, 0,
                Sha256(manifestBytes), null);
            return 3;
        }

        using var windows = new T110TargetSuite.WindowsTupleFixture();
        var fixture = new EvaluatorFixture(windows);
        var cases = CreateCases(fixture);
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
            fixture.ResetActual();
            try { result = cases[caseId](); }
            catch (Exception) { result = false; }
            Emit(CaseMarker, new {
                caseId,
                result = result ? "pass" : "fail",
                actual = fixture.LastActual,
            });
            if (result) passed++;
        }
        var final = passed == manifest.Cases.Count ? "pass" : "fail";
        EmitResult(final, manifest.Cases.Count, passed,
            Sha256(manifestBytes), RuntimeTuple.Capture());
        return final == "pass" ? 0 : 1;
    }

    private static Dictionary<string, Func<bool>> CreateCases(EvaluatorFixture value)
    {
        var cases = new Dictionary<string, Func<bool>>(StringComparer.Ordinal);
        cases["qpc-event-reservation-equal"] = () => value.Expect(
            "UNBOUND_BEFORE_RESERVATION", eventQpc: value.ReservationQpc);
        cases["qpc-event-reservation-plus-one"] = () => value.Expect(
            "UNBOUND_CANDIDATE", eventQpc: value.ReservationQpc + 1,
            deferred: [value.BaselineDeferred with {
                TimestampQpc = value.ReservationQpc + 1,
            }]);
        cases["qpc-deferred-reservation-equal"] = () => value.Expect(
            "UNBOUND_DEFERRED_TUPLE", deferred: [value.BaselineDeferred with {
                TimestampQpc = value.ReservationQpc,
            }]);
        cases["qpc-deferred-reservation-plus-one"] = () => value.Expect(
            "UNBOUND_CANDIDATE", deferred: [value.BaselineDeferred with {
                TimestampQpc = value.ReservationQpc + 1,
            }]);
        cases["qpc-deferred-event-equal"] = () => value.Expect(
            "UNBOUND_CANDIDATE", deferred: [value.BaselineDeferred with {
                TimestampQpc = value.EventQpc,
            }]);
        cases["qpc-deferred-event-plus-one"] = () => value.Expect(
            "UNBOUND_DEFERRED_TUPLE", deferred: [value.BaselineDeferred with {
                TimestampQpc = value.EventQpc + 1,
            }]);
        cases["deferred-cardinality-zero"] = () => value.Expect(
            "UNBOUND_DEFERRED_MISSING", deferred: []);
        cases["deferred-cardinality-one"] = () => value.Expect(
            "UNBOUND_CANDIDATE", deferred: [value.BaselineDeferred]);
        cases["deferred-cardinality-multiple"] = () => value.Expect(
            "UNBOUND_DEFERRED_TUPLE",
            deferred: [value.BaselineDeferred, value.BaselineDeferred]);

        cases["tuple-worker-pid-mismatch"] = () => value.TupleMismatch(
            item => item with { WorkerPid = checked(item.WorkerPid + 1) });
        cases["tuple-producer-sequence-mismatch"] = () => value.TupleMismatch(
            item => item with {
                ProducerSequenceNumber = checked(item.ProducerSequenceNumber + 1),
            });
        cases["tuple-phase-mismatch"] = () => value.TupleMismatch(
            item => item with { Phase = "build" });
        cases["tuple-work-id-mismatch"] = () => value.TupleMismatch(
            item => item with { WorkId = "001076" });
        cases["tuple-phase-instance-active-mismatch"] = () => value.Expect(
            "UNBOUND_DEFERRED_TUPLE", phase: value.BaselinePhase with {
                PhaseInstanceId = DifferentSha,
            });
        cases["tuple-phase-instance-lease-mismatch"] = () => value.Expect(
            "UNBOUND_DEFERRED_TUPLE", lease: value.BaselineLease with {
                PhaseInstanceId = DifferentSha,
            });
        cases["tuple-relative-path-mismatch"] = () => value.TupleMismatch(
            item => item with { RelativePath = "cache/other.tmp" });
        cases["tuple-snapshot-relative-path-mismatch"] = () => value.TupleMismatch(
            item => item with { SnapshotRelativePath = "cache/other.tmp" });
        cases["tuple-file-object-zero"] = () => value.TupleMismatch(
            item => item with { FileObject = 0 });
        cases["tuple-file-object-bound"] = () => value.TupleMismatch(
            item => item with { FileObjectUnbound = false });

        cases["stage-unbound-snapshot-present"] = () => value.Expect(
            "UNBOUND_SNAPSHOT_PRESENT", lease: value.BaselineLease with {
                SnapshotPresent = true,
            });
        cases["stage-unbound-before-reservation"] = () => value.Expect(
            "UNBOUND_BEFORE_RESERVATION", eventQpc: value.ReservationQpc);
        cases["stage-unbound-current-inspection-failed"] = () => value.Expect(
            "UNBOUND_CURRENT_INSPECTION_FAILED",
            adapter: value.MemberAdapter.WithCurrentInspectionFailure());
        cases["stage-unbound-current-missing"] = () => value.Expect(
            "UNBOUND_CURRENT_MISSING", adapter: value.MissingCurrentAdapter);
        cases["stage-unbound-deferred-missing"] = () => value.Expect(
            "UNBOUND_DEFERRED_MISSING", deferred: []);
        cases["stage-unbound-deferred-tuple"] = () => value.TupleMismatch(
            item => item with { FileObject = 0 });
        cases["stage-unbound-current-id-mismatch"] = value.RealIdentityReplacement;
        cases["stage-unbound-process-wait-failed"] = () => value.Expect(
            "UNBOUND_PROCESS_WAIT_FAILED",
            adapter: value.MemberAdapter.WithProcessInspectionFailure(
                "PROCESS_WAIT_FAILED"));
        cases["stage-unbound-job-query-failed"] = () => value.Expect(
            "UNBOUND_JOB_QUERY_FAILED",
            adapter: value.MemberAdapter.WithProcessInspectionFailure(
                "JOB_QUERY_FAILED"));
        cases["stage-unbound-process-identity-failed"] = () => value.Expect(
            "UNBOUND_PROCESS_IDENTITY_FAILED",
            adapter: value.MemberAdapter.WithProcessInspectionFailure(
                "PROCESS_START_KEY_QUERY_FAILED"));
        cases["stage-unbound-process-tuple"] = value.RealDifferentGeneration;
        cases["stage-unbound-process-signaled"] = value.RealSignaled;
        cases["stage-unbound-lease-escape"] = value.RealOutsideJob;
        cases["stage-unbound-candidate"] = value.RealAliveMember;

        cases["precedence-snapshot-before-reservation"] = () => value.Expect(
            "UNBOUND_SNAPSHOT_PRESENT",
            lease: value.BaselineLease with { SnapshotPresent = true },
            eventQpc: value.ReservationQpc);
        cases["precedence-before-reservation-current-failure"] = () => value.Expect(
            "UNBOUND_BEFORE_RESERVATION",
            eventQpc: value.ReservationQpc,
            adapter: value.MemberAdapter.WithCurrentInspectionFailure());
        cases["precedence-current-failure-current-missing"] = () => value.Expect(
            "UNBOUND_CURRENT_INSPECTION_FAILED",
            adapter: value.MissingCurrentAdapter.WithCurrentInspectionFailure());
        cases["precedence-current-missing-deferred-missing"] = () => value.Expect(
            "UNBOUND_CURRENT_MISSING",
            deferred: [], adapter: value.MissingCurrentAdapter);
        cases["precedence-deferred-missing-deferred-tuple"] = () => value.Expect(
            "UNBOUND_DEFERRED_MISSING", deferred: []);
        cases["precedence-deferred-tuple-current-identity"] = () => value.Expect(
            "UNBOUND_DEFERRED_TUPLE", deferred: [value.BaselineDeferred with {
                FileObject = 0,
                SnapshotIdentity = value.InitialIdentity,
            }]);
        cases["precedence-current-identity-process-wait"] = () => value.Expect(
            "UNBOUND_CURRENT_ID_MISMATCH",
            deferred: [value.BaselineDeferred with {
                SnapshotIdentity = value.InitialIdentity,
            }],
            adapter: value.MemberAdapter.WithProcessInspectionFailure(
                "PROCESS_WAIT_FAILED"));
        cases["precedence-process-wait-process-tuple"] = () => value.Expect(
            "UNBOUND_PROCESS_WAIT_FAILED",
            adapter: value.OutsideAdapter.WithProcessInspectionFailure(
                "PROCESS_WAIT_FAILED"));
        cases["precedence-process-job-process-tuple"] = () => value.Expect(
            "UNBOUND_JOB_QUERY_FAILED",
            adapter: value.OutsideAdapter.WithProcessInspectionFailure(
                "JOB_QUERY_FAILED"));
        cases["precedence-process-identity-process-tuple"] = () => value.Expect(
            "UNBOUND_PROCESS_IDENTITY_FAILED",
            adapter: value.OutsideAdapter.WithProcessInspectionFailure(
                "PROCESS_START_KEY_QUERY_FAILED"));
        cases["precedence-process-tuple-process-signaled"] =
            value.RealDifferentGeneration;
        cases["precedence-process-signaled-lease-escape"] = value.RealSignaled;
        cases["precedence-lease-escape-candidate"] = value.RealOutsideJob;

        cases["real-current-identity-stable"] = value.RealIdentityStable;
        cases["real-process-alive-member"] = value.RealAliveMember;
        cases["real-process-signaled"] = value.RealSignaled;
        cases["real-process-different-generation"] = value.RealDifferentGeneration;
        cases["real-process-outside-job"] = value.RealOutsideJob;
        cases["real-current-identity-replaced"] = value.RealIdentityReplacement;
        return cases;
    }

    private const string DifferentSha =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    private sealed class EvaluatorFixture
    {
        private const string RelativePath = "cache/lease.tmp";
        private const string PhaseInstance =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        private readonly T110TargetSuite.WindowsTupleFixture windows;

        internal EvaluatorFixture(T110TargetSuite.WindowsTupleFixture windows)
        {
            this.windows = windows;
            MemberAdapter = Adapter(windows.CurrentFilePath, windows.MemberProcess);
            MissingCurrentAdapter = Adapter(
                windows.MissingFilePath, windows.MemberProcess);
            OutsideAdapter = Adapter(windows.CurrentFilePath, windows.OutsideProcess);
            CurrentIdentity = MemberAdapter.InspectCurrent(RelativePath)?.Identity
                ?? throw new InvalidOperationException("CURRENT_IDENTITY_MISSING");
            InitialIdentity = Adapter(
                windows.InitialFilePath,
                windows.MemberProcess).InspectCurrent(RelativePath)?.Identity
                ?? throw new InvalidOperationException("INITIAL_IDENTITY_MISSING");
        }

        internal long ReservationQpc => 100;
        internal long EventQpc => 102;
        internal string CurrentIdentity { get; }
        internal string InitialIdentity { get; }
        internal string? LastActual { get; private set; }
        internal SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
            MemberAdapter { get; }
        internal SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
            MissingCurrentAdapter { get; }
        internal SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
            OutsideAdapter { get; }

        internal SystemBoundFileObjectNoPendingUnboundLeaseState BaselineLease =>
            Lease(windows.MemberIdentity);

        internal SystemBoundFileObjectNoPendingUnboundLeasePhase BaselinePhase =>
            new("voice", "000799", PhaseInstance);

        internal SystemBoundFileObjectNoPendingUnboundLeaseDeferred BaselineDeferred =>
            Deferred(windows.MemberIdentity);

        private SystemBoundFileObjectNoPendingUnboundLeaseDeferred Deferred(
            JobObject.ProcessIdentityRecord identity) =>
            new(
                identity.ProcessId,
                identity.ProcessSequenceNumber,
                "voice",
                "000799",
                PhaseInstance,
                RelativePath,
                RelativePath,
                CurrentIdentity,
                0x109,
                true,
                101);

        internal bool TupleMismatch(
            Func<SystemBoundFileObjectNoPendingUnboundLeaseDeferred,
                SystemBoundFileObjectNoPendingUnboundLeaseDeferred> mutate) =>
            Expect("UNBOUND_DEFERRED_TUPLE", deferred: [mutate(BaselineDeferred)]);

        internal bool Expect(
            string expected,
            SystemBoundFileObjectNoPendingUnboundLeaseState? lease = null,
            SystemBoundFileObjectNoPendingUnboundLeasePhase? phase = null,
            IReadOnlyList<SystemBoundFileObjectNoPendingUnboundLeaseDeferred>?
                deferred = null,
            long? eventQpc = null,
            SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter? adapter = null)
        {
            LastActual =
                SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticEvaluator.Evaluate(
                lease ?? BaselineLease,
                phase ?? BaselinePhase,
                deferred ?? [BaselineDeferred],
                eventQpc ?? EventQpc,
                adapter ?? MemberAdapter);
            return LastActual == expected;
        }

        internal void ResetActual() => LastActual = null;

        internal bool RealIdentityStable() => Expect("UNBOUND_CANDIDATE");

        internal bool RealAliveMember() =>
            windows.AliveMember() && Expect("UNBOUND_CANDIDATE");

        internal bool RealSignaled()
        {
            var adapter = Adapter(windows.CurrentFilePath, windows.SignaledProcess);
            return windows.SignaledMember() && Expect(
                "UNBOUND_PROCESS_SIGNALED",
                lease: Lease(windows.SignaledIdentity),
                deferred: [Deferred(windows.SignaledIdentity)],
                adapter: adapter);
        }

        internal bool RealDifferentGeneration() =>
            windows.DifferentGeneration() && Expect(
                "UNBOUND_PROCESS_TUPLE",
                adapter: OutsideAdapter);

        internal bool RealOutsideJob() =>
            windows.OutsideJob() && Expect(
                "UNBOUND_LEASE_ESCAPE",
                lease: Lease(windows.OutsideIdentity),
                deferred: [Deferred(windows.OutsideIdentity)],
                adapter: OutsideAdapter);

        internal bool RealIdentityReplacement() =>
            InitialIdentity != CurrentIdentity && Expect(
                "UNBOUND_CURRENT_ID_MISMATCH",
                deferred: [BaselineDeferred with {
                    SnapshotIdentity = InitialIdentity,
                }]);

        private SystemBoundFileObjectNoPendingUnboundLeaseState Lease(
            JobObject.ProcessIdentityRecord identity) => new(
                RelativePath,
                false,
                identity.ProcessId,
                identity.ProcessStartKey,
                identity.ProcessSequenceNumber,
                PhaseInstance,
                ReservationQpc);

        private SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter Adapter(
            string path,
            System.Diagnostics.Process process) =>
            SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
                .CreateWindows(path, windows.Job, process);
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
        Console.WriteLine(prefix +
            Convert.ToBase64String(Encoding.UTF8.GetBytes(json)));
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
            var production = typeof(
                SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticEvaluator)
                .Assembly;
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
