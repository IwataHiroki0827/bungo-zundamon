using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

/// <summary>
/// production共有規則と実Windows identity/Jobを固定manifest順で検証する。
/// @des DES-F005-006 @fun FUN-F005-047 @test UT-F005-047
/// </summary>
internal static class T110TargetSuite
{
    private const string TargetId = "CHG-F005-036/T-110";
    private const string CaseMarker = "F005_T110_CASE_BASE64=";
    private const string ResultMarker = "F005_T110_RESULT_BASE64=";

    internal static int Run(string[] args)
    {
        if (args.Length != 2 || args[0] != "--target" || args[1] != TargetId)
        {
            EmitResult("argument-invalid", 0, 0, null, null);
            return 2;
        }

        var manifestPath = Path.Combine(
            AppContext.BaseDirectory,
            "t110-case-manifest.json");
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

        using var windows = new WindowsTupleFixture();
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
        WindowsTupleFixture windows)
    {
        var cases = new Dictionary<string, Func<bool>>(StringComparer.Ordinal) {
            ["all-true-candidate"] = () => Cheap(),
            ["cheap-authorization-false"] = () => !Cheap(authorizationFailure: "PRIVATE"),
            ["cheap-system-pid-false"] = () => !Cheap(systemPid: 8),
            ["cheap-event-name-false"] = () => !Cheap(eventName: "setinfo"),
            ["cheap-file-object-false"] = () => !Cheap(fileObject: 0),
            ["cheap-file-object-unbound-false"] = () => !Cheap(fileObjectUnbound: false),
            ["cheap-voice-phase-false"] = () => !Cheap(voicePhase: false),
            ["cheap-lease-phase-false"] = () => !Cheap(leasePhaseMatches: false),
            ["cheap-qpc-order-false"] = () => !Cheap(leaseQpc: 100),
            ["cheap-exact-candidate-false"] = () => !Cheap(exactCandidate: false),
            ["cheap-pending-path-false"] = () => !Cheap(pendingPathNull: false),
            ["cheap-rename-reservation-false"] = () => !Cheap(renameReservationNull: false),
            ["qpc-phase-lease-equal"] = () => !Rules.IsQpcOrderValid(100, 100, 102),
            ["qpc-strict-plus-one"] = () => Rules.IsQpcOrderValid(100, 101, 102),
            ["qpc-lease-event-equal"] = () => !Rules.IsQpcOrderValid(100, 101, 101),
        };

        for (var index = 0; index < 12; index++)
        {
            var captured = index;
            cases[$"initial-tuple-false-{index:00}"] = () => {
                var tuple = Enumerable.Repeat(true, 12).ToArray();
                tuple[captured] = false;
                return !InitialTuple(tuple);
            };
        }

        cases["initial-inspection-success-once"] = () => {
            var calls = 0;
            var accepted = Rules.EvaluateInitialTupleInspection(
                () => {
                    calls++;
                    return new BoundLeaseInitialInspection(true, true, true, true);
                }, true, true, true, true, true, true, true, true);
            return accepted && calls == 1;
        };
        cases["initial-inspection-throw-fixed"] = () => {
            var calls = 0;
            try
            {
                Rules.EvaluateInitialTupleInspection(
                    () => {
                        calls++;
                        throw new GuardException("PRIVATE_RAW_FAILURE");
                    }, true, true, true, true, true, true, true, true);
                return false;
            }
            catch (GuardException error)
            {
                return calls == 1 && error.Code ==
                    "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_INITIAL_TUPLE_INSPECTION_FAILED";
            }
        };

        cases["initial-process-identity-failure"] = () =>
            Rules.InitialProcessFailureCode("PROCESS_START_KEY_QUERY_FAILED") ==
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_IDENTITY_FAILED";
        cases["initial-process-wait-failure"] = () =>
            Rules.InitialProcessFailureCode("PROCESS_WAIT_FAILED") ==
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_WAIT_FAILED";
        cases["initial-process-job-query-failure"] = () =>
            Rules.InitialProcessFailureCode("JOB_QUERY_FAILED") ==
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_JOB_QUERY_FAILED";
        cases["recheck-process-identity-failure"] = () =>
            Rules.RecheckProcessFailureCode("PROCESS_START_KEY_QUERY_FAILED") ==
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_IDENTITY_FAILED";
        cases["recheck-process-wait-failure"] = () =>
            Rules.RecheckProcessFailureCode("PROCESS_WAIT_FAILED") ==
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_WAIT_FAILED";
        cases["recheck-process-job-query-failure"] = () =>
            Rules.RecheckProcessFailureCode("JOB_QUERY_FAILED") ==
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_JOB_QUERY_FAILED";

        AddProcessCases(cases, recheck: false, "initial");
        AddProcessCases(cases, recheck: true, "recheck");

        var recheckCodes = new[] {
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_ACTIVE_LEASE_CHANGED",
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_EVENT_FILE_OBJECT_BOUND",
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_RENAME_STATE_CHANGED",
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_DIRECTORY_IDENTITY_MISMATCH",
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_LEASE_CURRENT_IDENTITY_MISMATCH",
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_BINDING_MISMATCH",
        };
        var recheckIds = new[] {
            "post-auth-active-lease-false",
            "post-auth-event-object-false",
            "post-auth-rename-state-false",
            "post-auth-directory-identity-false",
            "post-auth-lease-identity-false",
            "post-auth-binding-false",
        };
        for (var index = 0; index < recheckCodes.Length; index++)
        {
            var captured = index;
            cases[recheckIds[index]] = () => {
                var tuple = Enumerable.Repeat(true, 6).ToArray();
                tuple[captured] = false;
                return Recheck(tuple) == recheckCodes[captured];
            };
        }
        cases["post-auth-earliest-code-wins"] = () =>
            Recheck(Enumerable.Repeat(false, 6).ToArray()) == recheckCodes[0];
        cases["post-auth-all-true"] = () =>
            Recheck(Enumerable.Repeat(true, 6).ToArray()) is null;

        cases["real-directory-file-identity-stable"] = windows.IdentityStable;
        cases["real-file-identity-replacement"] = windows.IdentityReplacementDetected;
        cases["real-job-alive-member"] = windows.AliveMember;
        cases["real-process-signaled"] = windows.SignaledMember;
        cases["real-process-different-generation"] = windows.DifferentGeneration;
        cases["real-process-outside-job"] = windows.OutsideJob;
        return cases;
    }

    private static void AddProcessCases(
        Dictionary<string, Func<bool>> cases,
        bool recheck,
        string prefix)
    {
        var marker = recheck ? "PROCESS_RECHECK" : "PROCESS";
        cases[$"{prefix}-process-tuple-mismatch"] = () =>
            Rules.ProcessRejection(false, false, true, recheck) ==
            $"ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_{marker}_TUPLE_MISMATCH";
        cases[$"{prefix}-process-signaled"] = () =>
            Rules.ProcessRejection(true, true, false, recheck) ==
            $"ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_{marker}_SIGNALED";
        cases[$"{prefix}-process-outside-job"] = () =>
            Rules.ProcessRejection(true, false, false, recheck) ==
            $"ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_{marker}_OUTSIDE_JOB";
        cases[$"{prefix}-process-authorized"] = () =>
            Rules.ProcessRejection(true, false, true, recheck) is null;
    }

    private static bool Cheap(
        string authorizationFailure = "BIRTH_MISSING",
        int systemPid = 4,
        string eventName = "write",
        ulong fileObject = 31,
        bool fileObjectUnbound = true,
        bool voicePhase = true,
        bool leasePhaseMatches = true,
        long leaseQpc = 101,
        bool exactCandidate = true,
        bool pendingPathNull = true,
        bool renameReservationNull = true) =>
        Rules.EvaluateCheapPredicates(
            authorizationFailure, systemPid, eventName, fileObject,
            fileObjectUnbound, voicePhase, leasePhaseMatches,
            100, leaseQpc, 102,
            () => exactCandidate,
            () => pendingPathNull,
            () => renameReservationNull);

    private static bool InitialTuple(bool[] value) => Rules.InitialTupleMatches(
        value[0], value[1], value[2], value[3], value[4], value[5],
        value[6], value[7], value[8], value[9], value[10], value[11]);

    private static string? Recheck(bool[] value) => Rules.TupleRecheckFailure(
        value[0], value[1], value[2], value[3], value[4], value[5]);

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
            var production =
                typeof(SystemDirectoryBoundLeaseRejoinAuthorizationRules).Assembly;
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

    internal sealed class WindowsTupleFixture : IDisposable
    {
        private readonly string root;
        private readonly FileIdentity directoryIdentity;
        private readonly FileIdentity initialFileIdentity;
        private readonly FileIdentity replacementFileIdentity;
        private readonly JobObject job;
        private readonly Process member;
        private readonly Process signaled;
        private readonly Process outside;
        private readonly JobObject.ProcessIdentityRecord memberIdentity;
        private readonly JobObject.ProcessIdentityRecord outsideIdentity;

        internal WindowsTupleFixture()
        {
            if (!OperatingSystem.IsWindows())
                throw new PlatformNotSupportedException("WINDOWS_REQUIRED");
            var runnerTemp = Environment.GetEnvironmentVariable("RUNNER_TEMP")
                ?? Path.GetTempPath();
            root = Path.Combine(runnerTemp, "f005-t110-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            directoryIdentity = InspectIdentity(root, directory: true);
            var file = Path.Combine(root, "lease.tmp");
            File.WriteAllBytes(file, [0x46, 0x30, 0x30, 0x35]);
            initialFileIdentity = InspectIdentity(file, directory: false);
            File.Move(file, Path.Combine(root, "lease-old.tmp"));
            File.WriteAllBytes(file, [0x54, 0x31, 0x31, 0x30]);
            replacementFileIdentity = InspectIdentity(file, directory: false);

            job = JobObject.Create();
            member = StartSleeper();
            using (var started = member)
                member = job.Assign(started.Id);
            memberIdentity = job.ProcessIdentity(member);

            signaled = StartSleeper();
            using (var started = signaled)
                signaled = job.Assign(started.Id);
            signaled.Kill(entireProcessTree: true);
            signaled.WaitForExit(10_000);

            outside = StartSleeper();
            outsideIdentity = job.ProcessIdentity(outside);
        }

        internal bool IdentityStable() =>
            directoryIdentity == InspectIdentity(root, directory: true) &&
            replacementFileIdentity == InspectIdentity(
                Path.Combine(root, "lease.tmp"), directory: false);

        internal bool IdentityReplacementDetected() =>
            initialFileIdentity != replacementFileIdentity;

        internal bool AliveMember()
        {
            var inspection = job.InspectRetainedProcess(member);
            return inspection.ProcessId == memberIdentity.ProcessId &&
                inspection.ProcessStartKey == memberIdentity.ProcessStartKey &&
                inspection.ProcessSequenceNumber == memberIdentity.ProcessSequenceNumber &&
                !inspection.Signaled && inspection.JobMember;
        }

        internal bool SignaledMember() => job.IsSignaled(signaled);

        internal bool DifferentGeneration() =>
            memberIdentity.ProcessStartKey != outsideIdentity.ProcessStartKey &&
            memberIdentity.ProcessSequenceNumber != outsideIdentity.ProcessSequenceNumber;

        internal bool OutsideJob() => !job.Contains(outside);

        public void Dispose()
        {
            try
            {
                if (!outside.HasExited) outside.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException) { }
            outside.Dispose();
            signaled.Dispose();
            member.Dispose();
            job.Dispose();
            try { Directory.Delete(root, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private static Process StartSleeper()
        {
            var shell = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            return Process.Start(new ProcessStartInfo(
                shell,
                "/d /c ping -n 30 127.0.0.1 >nul") {
                UseShellExecute = false,
                CreateNoWindow = true,
            }) ?? throw new InvalidOperationException("PROCESS_START_FAILED");
        }

        private static FileIdentity InspectIdentity(string path, bool directory)
        {
            const uint genericRead = 0x80000000;
            const uint shareAll = 0x00000001 | 0x00000002 | 0x00000004;
            const uint openExisting = 3;
            const uint backupSemantics = 0x02000000;
            using var handle = CreateFileW(
                path,
                genericRead,
                shareAll,
                IntPtr.Zero,
                openExisting,
                directory ? backupSemantics : 0,
                IntPtr.Zero);
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info))
                throw new InvalidOperationException("IDENTITY_INSPECTION_FAILED");
            return new FileIdentity(
                info.VolumeSerialNumber,
                ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out ByHandleFileInformation information);

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            internal uint FileAttributes;
            internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            internal uint VolumeSerialNumber;
            internal uint FileSizeHigh;
            internal uint FileSizeLow;
            internal uint NumberOfLinks;
            internal uint FileIndexHigh;
            internal uint FileIndexLow;
        }

        private readonly record struct FileIdentity(
            uint VolumeSerialNumber,
            ulong FileIndex);
    }

    private static class Rules
    {
        internal static bool EvaluateCheapPredicates(
            string authorizationFailure,
            int systemPid,
            string eventName,
            ulong fileObject,
            bool fileObjectUnbound,
            bool voicePhase,
            bool leasePhaseMatches,
            long phaseStartedAtQpc,
            long leaseReservedAtQpc,
            long eventQpc,
            Func<bool> exactCandidate,
            Func<bool> pendingRenamePathNull,
            Func<bool> renameReservationNull) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.EvaluateCheapPredicates(
                authorizationFailure, systemPid, eventName, fileObject,
                fileObjectUnbound, voicePhase, leasePhaseMatches,
                phaseStartedAtQpc, leaseReservedAtQpc, eventQpc,
                exactCandidate, pendingRenamePathNull, renameReservationNull);

        internal static bool IsQpcOrderValid(long phase, long lease, long eventQpc) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(
                phase, lease, eventQpc);

        internal static bool InitialTupleMatches(params bool[] values) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.InitialTupleMatches(
                values[0], values[1], values[2], values[3], values[4], values[5],
                values[6], values[7], values[8], values[9], values[10], values[11]);

        internal static bool EvaluateInitialTupleInspection(
            Func<BoundLeaseInitialInspection> inspect,
            bool directorySnapshotAvailable,
            bool leaseParentMatches,
            bool leaseOpen,
            bool leaseSnapshotAvailable,
            bool leaseFileObjectAvailable,
            bool leaseBindingAvailable,
            bool leaseBindingPathMatches,
            bool leaseBindingIdentityMatches) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .EvaluateInitialTupleInspection(
                    inspect, directorySnapshotAvailable, leaseParentMatches,
                    leaseOpen, leaseSnapshotAvailable, leaseFileObjectAvailable,
                    leaseBindingAvailable, leaseBindingPathMatches,
                    leaseBindingIdentityMatches);

        internal static string InitialProcessFailureCode(string code) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .InitialProcessFailureCode(code);

        internal static string RecheckProcessFailureCode(string code) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .RecheckProcessFailureCode(code);

        internal static string? ProcessRejection(
            bool tuple, bool signaled, bool member, bool recheck) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.ProcessRejection(
                tuple, signaled, member, recheck);

        internal static string? TupleRecheckFailure(params bool[] values) =>
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.TupleRecheckFailure(
                values[0], values[1], values[2], values[3], values[4], values[5]);
    }
}
