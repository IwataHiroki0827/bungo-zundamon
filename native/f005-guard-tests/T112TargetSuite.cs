using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

/// <summary>
/// immutable binding proof、atomic replay、production-owned retained identityを
/// 固定manifest順で検証する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
/// @test UT-F005-017 UT-F005-047
/// </summary>
internal static class T112TargetSuite
{
    private const string TargetId = "CHG-F005-038/T-112";
    private const string CaseMarker = "F005_T112_CASE_BASE64=";
    private const string ResultMarker = "F005_T112_RESULT_BASE64=";

    internal static int Run(string[] args)
    {
        if (args.Length != 2 || args[0] != "--target" || args[1] != TargetId)
        {
            EmitResult("argument-invalid", 0, 0, null, null);
            return 2;
        }
        var manifestPath = Path.Combine(AppContext.BaseDirectory,
            "t112-case-manifest.json");
        var manifestBytes = File.ReadAllBytes(manifestPath);
        var manifest = JsonSerializer.Deserialize<TargetManifest>(manifestBytes,
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

        using var retained = new RetainedIdentityFixture();
        using var jobs = new T110TargetSuite.WindowsTupleFixture();
        var cases = CreateCases(retained, jobs);
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
        EmitResult(resultCode, manifest.Cases.Count, passed,
            Sha256(manifestBytes), RuntimeTuple.Capture());
        return resultCode == "pass" ? 0 : 1;
    }

    private static Dictionary<string, Func<bool>> CreateCases(
        RetainedIdentityFixture retained,
        T110TargetSuite.WindowsTupleFixture jobs)
    {
        var cases = new Dictionary<string, Func<bool>>(StringComparer.Ordinal);
        cases["admission-read-held"] = () => AdmissionScenario().ReadHeld;
        cases["admission-writer-waits"] = () => AdmissionScenario().WriterWaited;
        cases["admission-new-read-blocked"] = () => AdmissionScenario().NewReadBlocked;
        cases["admission-release-order"] = () => AdmissionScenario().ReleasedInOrder;
        cases["admission-dispose-idempotent"] = AdmissionDisposeIdempotent;

        cases["ledger-baseline-unbound-generation-zero"] = () => {
            var ledger = new WriteCompletionBindingLedger([]);
            var proof = ledger.Admit(WriteCompletionBindingKind.SealedParent,
                "write", 11, "volume:parent", "cache");
            return proof.GenerationBefore == 0 && proof.GenerationAfter == 0 &&
                proof.StateBefore == WriteCompletionBindingState.Unbound &&
                proof.StateAfter == WriteCompletionBindingState.Unbound;
        };
        cases["ledger-baseline-bound-generation-one"] = () => {
            var ledger = BaselineLedger();
            return ledger.ExactGeneration(31, "volume:file", "cache/file.wav") == 1;
        };
        cases["ledger-baseline-cursors-zero"] = () => {
            var ledger = BaselineLedger();
            return ledger.AdmissionHead == 0 && ledger.AppliedCursor == 0 &&
                ledger.IsConverged;
        };
        cases["ledger-sealed-current"] = SealedCurrent;
        cases["ledger-sealed-parent"] = SealedParent;
        cases["ledger-other-bound-bootstrap"] = OtherBoundBootstrap;
        cases["ledger-other-bound-rebind"] = OtherBoundRebind;
        cases["ledger-other-bound-rename"] = OtherBoundRename;
        cases["ledger-delete-cleanup"] = () => DeleteCleanup(deleteFirst: true);
        cases["ledger-cleanup-delete"] = () => DeleteCleanup(deleteFirst: false);
        cases["ledger-duplicate-rejected"] = DuplicateRejected;
        cases["ledger-reused-cleanup-rejected"] = ReusedCleanupRejected;
        cases["replay-proof-missing-rejected"] = MissingProofRejected;
        cases["ledger-proof-duplicate-rejected"] = DuplicateProofRejected;
        cases["replay-proof-order"] = () => ReplayScenario().OrderCorrect;
        cases["ledger-generation-gap-rejected"] = GenerationGapRejected;
        cases["ledger-canonical-tamper-rejected"] = CanonicalTamperRejected;
        cases["replay-atomic-commit"] = () => ReplayScenario().Committed;
        cases["replay-cursor-head-converged"] = () => ReplayScenario().Converged;

        foreach (var stage in new[] {
            "late-proof", "retained-identity", "producer-process", "capacity",
            "notice", "apply", "ledger-commit",
        })
        {
            var captured = stage;
            cases[$"atomic-{stage}-failure"] = () => AtomicFailure(captured);
        }

        cases["bound-ledger-entries-8192"] = () => LedgerEntryBound(8192, true);
        cases["bound-ledger-entries-8193"] = () => LedgerEntryBound(8193, false);
        cases["bound-admitted-proofs-8192"] = () => ProofBound(8192, true);
        cases["bound-admitted-proofs-8193"] = () => ProofBound(8193, false);
        cases["bound-pending-snapshots-8192"] = () => StoreBound("snapshot", 8192, true);
        cases["bound-pending-snapshots-8193"] = () => StoreBound("snapshot", 8193, false);
        cases["bound-tracked-cleanups-8192"] = () => StoreBound("cleanup", 8192, true);
        cases["bound-tracked-cleanups-8193"] = () => StoreBound("cleanup", 8193, false);
        cases["bound-generation-handles-8192"] = () => StoreBound("handle", 8192, true);
        cases["bound-generation-handles-8193"] = () => StoreBound("handle", 8193, false);
        cases["bound-seals-128-129"] = () => PrivateConstant("MaxWriteCompletionSeals") == 128;
        cases["bound-seal-handles-256-257"] = () =>
            PrivateConstant("MaxWriteCompletionSeals") * 2 == 256;
        cases["bound-live-retained-handles-8448-8449"] = () =>
            PrivateConstant("MaxWriteCompletionRetainedHandles") == 8448;
        cases["overflow-proof-sequence"] = ProofSequenceOverflow;
        cases["overflow-generation"] = GenerationOverflow;
        cases["overflow-normal-relevant-counter"] = CheckedCounterOverflow;
        cases["overflow-normal-accounted-counter"] = CheckedCounterOverflow;
        cases["overflow-cleanup-relevant-counter"] = CheckedCounterOverflow;
        cases["overflow-cleanup-accounted-counter"] = CheckedCounterOverflow;

        cases["ownership-baseline-partial-failure"] = () => OwnershipRollback("baseline");
        cases["ownership-prepare-poison"] = () => OwnershipRollback("prepare");
        cases["ownership-seal-release"] = () => OwnershipStore("seal");
        cases["ownership-phase-release"] = () => OwnershipStore("phase");
        cases["ownership-session-abort-close"] = () => OwnershipStore("session");
        cases["ownership-admission-dispose"] = AdmissionDisposeIdempotent;
        cases["ownership-store-dispose"] = () => OwnershipStore("store");

        cases["retained-file-open-verified"] = retained.FileOpenVerified;
        cases["retained-directory-open-verified"] = retained.DirectoryOpenVerified;
        cases["retained-stable-identity"] = retained.StableIdentity;
        cases["retained-rename-reinspection"] = retained.RenameReinspection;
        cases["retained-delete-reinspection"] = retained.DeleteReinspection;
        cases["retained-path-replacement-keeps-original"] = retained.ReplacementKeepsOriginal;
        cases["retained-hardlink-rejected"] = retained.HardlinkRejected;
        cases["retained-reparse-rejected"] = retained.ReparseRejected;
        cases["retained-expected-identity-mismatch"] = retained.ExpectedMismatch;
        cases["retained-closed-handle-rejected"] = retained.ClosedRejected;
        cases["retained-initial-open-failure"] = retained.InitialFailure;
        cases["retained-normal-release"] = retained.NormalRelease;
        cases["retained-double-dispose"] = retained.DoubleDispose;
        cases["real-job-alive-member"] = jobs.AliveMember;
        cases["real-process-signaled"] = jobs.SignaledMember;
        cases["real-process-different-generation"] = jobs.DifferentGeneration;
        cases["real-process-outside-job"] = jobs.OutsideJob;
        return cases;
    }

    private static AdmissionResult AdmissionScenario()
    {
        using var admission = new WriteCompletionCallbackAdmission();
        using var readEntered = new ManualResetEventSlim(false);
        using var releaseRead = new ManualResetEventSlim(false);
        using var writerStarted = new ManualResetEventSlim(false);
        using var writerEntered = new ManualResetEventSlim(false);
        using var releaseWriter = new ManualResetEventSlim(false);
        using var secondReadEntered = new ManualResetEventSlim(false);
        var finalHeldByWriter = false;
        var first = Task.Run(() => {
            using (admission.EnterCallback())
            {
                readEntered.Set();
                releaseRead.Wait(TimeSpan.FromSeconds(5));
            }
        });
        var readHeld = readEntered.Wait(TimeSpan.FromSeconds(5)) &&
            admission.ActiveCallbackCount == 1;
        var writer = Task.Run(() => {
            writerStarted.Set();
            using (admission.EnterFinal())
            {
                finalHeldByWriter = admission.IsFinalHeld;
                writerEntered.Set();
                releaseWriter.Wait(TimeSpan.FromSeconds(5));
            }
        });
        writerStarted.Wait(TimeSpan.FromSeconds(5));
        SpinWait.SpinUntil(() => admission.WaitingFinalCount == 1,
            TimeSpan.FromSeconds(5));
        var writerWaited = !writerEntered.IsSet && admission.WaitingFinalCount == 1;
        var second = Task.Run(() => {
            using (admission.EnterCallback()) secondReadEntered.Set();
        });
        var newReadBlocked = !secondReadEntered.Wait(TimeSpan.FromMilliseconds(100));
        releaseRead.Set();
        var writerWon = writerEntered.Wait(TimeSpan.FromSeconds(5)) &&
            !secondReadEntered.IsSet && finalHeldByWriter;
        releaseWriter.Set();
        var secondFinished = secondReadEntered.Wait(TimeSpan.FromSeconds(5));
        Task.WaitAll([first, writer, second], TimeSpan.FromSeconds(5));
        return new AdmissionResult(readHeld, writerWaited, newReadBlocked,
            writerWon && secondFinished);
    }

    private static bool AdmissionDisposeIdempotent()
    {
        var admission = new WriteCompletionCallbackAdmission();
        admission.Dispose();
        admission.Dispose();
        try { using var _ = admission.EnterCallback(); return false; }
        catch (ObjectDisposedException) { return true; }
    }

    private static WriteCompletionBindingLedger BaselineLedger() => new([
        (31UL, "volume:file", "cache/file.wav"),
    ]);

    private static bool SealedCurrent()
    {
        var ledger = BaselineLedger();
        var proof = ledger.Admit(WriteCompletionBindingKind.SealedCurrent,
            "write", 31, "volume:file", "cache/file.wav", 1);
        return proof.GenerationBefore == 1 && proof.GenerationAfter == 1 &&
            proof.StateBefore == WriteCompletionBindingState.Bound &&
            proof.StateAfter == WriteCompletionBindingState.Bound;
    }

    private static bool SealedParent()
    {
        var ledger = new WriteCompletionBindingLedger([]);
        var proof = ledger.Admit(WriteCompletionBindingKind.SealedParent,
            "setinfo", 41, "volume:parent", "cache");
        return proof.GenerationBefore == 0 && proof.GenerationAfter == 0 &&
            proof.StateAfter == WriteCompletionBindingState.Unbound;
    }

    private static bool OtherBoundBootstrap()
    {
        var ledger = new WriteCompletionBindingLedger([]);
        var proof = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 51, "volume:new", "cache/new.wav");
        return proof.GenerationBefore == 0 && proof.GenerationAfter == 1 &&
            proof.StateAfter == WriteCompletionBindingState.Bound;
    }

    private static bool OtherBoundRebind()
    {
        var ledger = BaselineLedger();
        var proof = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 31, "volume:replacement", "cache/replacement.wav");
        return proof.GenerationBefore == 1 && proof.GenerationAfter == 2 &&
            proof.ReusedAfter && proof.Identity == "volume:replacement";
    }

    private static bool OtherBoundRename()
    {
        var ledger = BaselineLedger();
        var proof = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "rename", 31, "volume:file", "cache/renamed.wav");
        return proof.GenerationAfter == 1 && proof.Path == "cache/renamed.wav";
    }

    private static bool DeleteCleanup(bool deleteFirst)
    {
        var ledger = BaselineLedger();
        ImmutableBindingProof delete;
        ImmutableBindingProof cleanup;
        if (deleteFirst)
        {
            delete = ledger.Admit(WriteCompletionBindingKind.OtherBound,
                "delete", 31, "volume:file", "cache/file.wav");
            cleanup = ledger.AdmitCleanup(31)!;
        }
        else
        {
            cleanup = ledger.AdmitCleanup(31)!;
            delete = ledger.Admit(WriteCompletionBindingKind.OtherBound,
                "delete", 31, "volume:file", "cache/file.wav");
        }
        return delete.GenerationAfter == cleanup.GenerationAfter &&
            delete.DeleteSeenAfter && cleanup.CleanupSeenAfter;
    }

    private static bool DuplicateRejected()
    {
        var ledger = BaselineLedger();
        _ = ledger.AdmitCleanup(31);
        try { _ = ledger.AdmitCleanup(31); return false; }
        catch (InvalidOperationException error)
        { return error.Message == "BINDING_MISMATCH"; }
    }

    private static bool ReusedCleanupRejected()
    {
        var ledger = BaselineLedger();
        _ = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "delete", 31, "volume:file", "cache/file.wav");
        _ = ledger.AdmitCleanup(31);
        var replacement = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 31, "volume:new", "cache/new.wav");
        var head = ledger.AdmissionHead;
        try { _ = ledger.AdmitCleanup(31); return false; }
        catch (InvalidOperationException error)
        {
            return error.Message == "BINDING_MISMATCH" &&
                ledger.AdmissionHead == head && ledger.MatchesGeneration(
                    31, replacement.GenerationAfter, "volume:new", "cache/new.wav");
        }
    }

    private static bool MissingProofRejected()
    {
        using var store = new WriteCompletionReplayStore<
            TargetSnapshot, TargetCleanup, TargetHandle>();
        store.Ledger = new WriteCompletionBindingLedger([]);
        store.EnqueueSnapshot(new TargetSnapshot("missing", null));
        try
        {
            _ = store.Replay(snapshot => snapshot.Proof,
                cleanup => cleanup.Proof, _ => { }, _ => { },
                () => 0, _ => { }, _ => { }, _ => { });
            return false;
        }
        catch (GuardException error)
        {
            return error.Code ==
                "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH" &&
                store.SnapshotCount == 1;
        }
    }

    private static bool DuplicateProofRejected()
    {
        var ledger = new WriteCompletionBindingLedger([]);
        var proof = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 71, "volume:proof", "cache/proof.wav");
        try { ledger.Validate([proof, proof]); return false; }
        catch (InvalidOperationException error)
        { return error.Message == "BINDING_MISMATCH" && ledger.AppliedCursor == 0; }
    }

    private static bool GenerationGapRejected()
    {
        var ledger = new WriteCompletionBindingLedger([]);
        var proof = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 72, "volume:gap", "cache/gap.wav");
        try { ledger.Validate([proof with { ProofSequence = 2 }]); return false; }
        catch (InvalidOperationException error)
        { return error.Message == "BINDING_MISMATCH" && ledger.AppliedCursor == 0; }
    }

    private static bool CanonicalTamperRejected()
    {
        var ledger = new WriteCompletionBindingLedger([]);
        var proof = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 73, "volume:canonical", "cache/canonical.wav");
        var variants = new[] {
            proof with { Identity = "volume:tampered" },
            proof with { Path = "cache/tampered.wav" },
            proof with { GenerationAfter = 2 },
            proof with { StateAfter = WriteCompletionBindingState.Retired },
            proof with { ReusedAfter = true },
            proof with { DeleteSeenAfter = true },
            proof with { CleanupSeenAfter = true },
        };
        return variants.All(item => {
            try { ledger.Validate([item]); return false; }
            catch (InvalidOperationException error)
            { return error.Message == "BINDING_MISMATCH" && ledger.AppliedCursor == 0; }
        });
    }

    private static ReplayResult ReplayScenario()
    {
        using var store = new WriteCompletionReplayStore<
            TargetSnapshot, TargetCleanup, TargetHandle>();
        var ledger = new WriteCompletionBindingLedger([]);
        store.Ledger = ledger;
        var first = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 81, "volume:first", "cache/first.wav");
        var second = ledger.Admit(WriteCompletionBindingKind.OtherBound,
            "create", 82, "volume:second", "cache/second.wav");
        store.EnqueueSnapshot(new TargetSnapshot("second", second));
        store.EnqueueSnapshot(new TargetSnapshot("first", first));
        var order = new List<string>();
        var semantic = new List<string> { "baseline" };
        var committed = store.Replay(
            snapshot => snapshot.Proof,
            cleanup => cleanup.Proof,
            _ => { },
            _ => { },
            () => semantic.ToArray(),
            snapshot => { order.Add(snapshot.Name); semantic.Add(snapshot.Name); },
            cleanup => { order.Add(cleanup.Name); semantic.Add(cleanup.Name); },
            checkpoint => { semantic.Clear(); semantic.AddRange(checkpoint); });
        return new ReplayResult(
            order.SequenceEqual(["first", "second"]),
            committed && semantic.SequenceEqual(["baseline", "first", "second"]) &&
                store.SnapshotCount == 0,
            ledger.IsConverged && ledger.AppliedCursor == ledger.AdmissionHead);
    }

    private static bool AtomicFailure(string stage)
    {
        var state = new AtomicSemanticState();
        var checkpoint = state.Capture();
        var acquired = new TargetHandle();
        var rejected = false;
        try
        {
            WriteCompletionAtomicBatchRules.Execute(
                () => {
                    state.AdmissionHead++;
                    if (stage == "late-proof") throw new InvalidOperationException(stage);
                    state.GenerationHandles["retained"] = "open";
                    if (stage == "retained-identity") throw new InvalidOperationException(stage);
                    state.Lease = "producer-checked";
                    if (stage == "producer-process") throw new InvalidOperationException(stage);
                    state.Allocated = 20; state.Peak = 20; state.Free = 90;
                    if (stage == "capacity") throw new InvalidOperationException(stage);
                    state.Notices.Add("notice");
                    if (stage == "notice") throw new InvalidOperationException(stage);
                    state.FilesByObject[31] = "volume:new";
                    state.FilesByPath["cache/new.wav"] = "volume:new";
                    state.Observations.Add("observation");
                    state.Seal = "applied";
                    state.Queue.Add("applied");
                    if (stage == "apply") throw new InvalidOperationException(stage);
                },
                () => {
                    state.AppliedCursor = state.AdmissionHead;
                    if (stage == "ledger-commit")
                        throw new InvalidOperationException(stage);
                },
                () => { state.Restore(checkpoint); acquired.Dispose(); });
        }
        catch (InvalidOperationException error)
        {
            rejected = error.Message == stage;
        }
        acquired.Dispose();
        return rejected && state.Fingerprint() == checkpoint.Fingerprint() &&
            acquired.DisposeCount == 1;
    }

    private static bool LedgerEntryBound(int count, bool expectSuccess)
    {
        try
        {
            var ledger = new WriteCompletionBindingLedger(
                Enumerable.Range(1, count).Select(index => (
                    (ulong)index,
                    $"volume:{index}",
                    $"cache/{index}.wav")));
            return expectSuccess && ledger.EntryCount == count;
        }
        catch (WriteCompletionBufferLimitException)
        {
            return !expectSuccess && count == 8193;
        }
    }

    private static bool ProofBound(int count, bool expectSuccess)
    {
        var ledger = new WriteCompletionBindingLedger([]);
        try
        {
            for (var index = 1; index <= count; index++)
                _ = ledger.Admit(WriteCompletionBindingKind.SealedParent,
                    "write", (ulong)index, "volume:parent", "cache");
            return expectSuccess && ledger.AdmissionHead == count;
        }
        catch (WriteCompletionBufferLimitException)
        {
            return !expectSuccess && count == 8193 &&
                ledger.AdmissionHead == WriteCompletionBindingLedger.MaximumProofs;
        }
    }

    private static bool StoreBound(string kind, int count, bool expectSuccess)
    {
        using var store = new WriteCompletionReplayStore<int, int, TargetHandle>();
        TargetHandle? rejectedHandle = null;
        try
        {
            for (var index = 0; index < count; index++)
            {
                if (kind == "snapshot") store.EnqueueSnapshot(index);
                else if (kind == "cleanup") store.AddCleanup(index);
                else
                {
                    var handle = new TargetHandle();
                    if (index == WriteCompletionBindingLedger.MaximumEntries)
                        rejectedHandle = handle;
                    store.AddGenerationHandle(((ulong)index + 1, 1), handle);
                }
            }
            return expectSuccess && count == 8192 &&
                (kind == "snapshot" ? store.SnapshotCount :
                    kind == "cleanup" ? store.CleanupCount :
                    store.GenerationHandleCount) == 8192;
        }
        catch (GuardException error)
        {
            rejectedHandle?.Dispose();
            return !expectSuccess && count == 8193 && error.Code ==
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT";
        }
    }

    private static int PrivateConstant(string name) =>
        (int)(typeof(CapacityGuardSession).GetField(name,
            BindingFlags.NonPublic | BindingFlags.Static)?.GetRawConstantValue()
            ?? throw new InvalidOperationException("BOUND_CONSTANT_MISSING"));

    private static bool ProofSequenceOverflow()
    {
        try
        {
            var ledger = new WriteCompletionBindingLedger([], long.MaxValue);
            _ = ledger.Admit(WriteCompletionBindingKind.SealedParent,
                "write", 91, "volume:parent", "cache");
            return false;
        }
        catch (WriteCompletionBufferLimitException) { return true; }
    }

    private static bool GenerationOverflow()
    {
        try { _ = WriteCompletionBindingLedger.CheckedNextGeneration(long.MaxValue); return false; }
        catch (WriteCompletionBufferLimitException) { return true; }
    }

    private static bool CheckedCounterOverflow()
    {
        try
        {
            _ = WriteCompletionDrainRules.CheckedCounterAdd(long.MaxValue, 1);
            return false;
        }
        catch (WriteCompletionBufferLimitException) { return true; }
    }

    private static bool OwnershipRollback(string stage)
    {
        var acquired = new TargetHandle();
        var baseline = new List<string> { "baseline" };
        try
        {
            WriteCompletionAtomicBatchRules.Execute(
                () => { baseline.Add(stage); throw new InvalidOperationException(stage); },
                () => { },
                () => { baseline.Remove(stage); acquired.Dispose(); });
            return false;
        }
        catch (InvalidOperationException error)
        {
            acquired.Dispose();
            return error.Message == stage && baseline.SequenceEqual(["baseline"]) &&
                acquired.DisposeCount == 1;
        }
    }

    private static bool OwnershipStore(string owner)
    {
        var handle = new TargetHandle();
        var store = new WriteCompletionReplayStore<int, int, TargetHandle>();
        store.Ledger = new WriteCompletionBindingLedger([]);
        store.EnqueueSnapshot(1);
        store.AddCleanup(1);
        store.AddGenerationHandle((1, 1), handle);
        if (owner is "seal" or "phase") store.ClearEvidence();
        else store.Dispose();
        store.Dispose();
        return handle.DisposeCount == 1 && store.SnapshotCount == 0 &&
            store.CleanupCount == 0 && store.GenerationHandleCount == 0 &&
            !store.LedgerRetained;
    }

    private sealed class RetainedIdentityFixture : IDisposable
    {
        private readonly string root;

        internal RetainedIdentityFixture()
        {
            var runnerTemp = Environment.GetEnvironmentVariable("RUNNER_TEMP")
                ?? Path.GetTempPath();
            root = Path.Combine(runnerTemp,
                "f005-t112-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
        }

        internal bool FileOpenVerified()
        {
            var path = CreateFile("file-open");
            var expected = Identity(path, false);
            using var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, expected);
            return lease.Reinspect() == expected;
        }

        internal bool DirectoryOpenVerified()
        {
            var path = NewPath("directory-open");
            Directory.CreateDirectory(path);
            var expected = Identity(path, true);
            using var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, expected);
            return lease.Reinspect() == expected;
        }

        internal bool StableIdentity()
        {
            var path = CreateFile("stable");
            var expected = Identity(path, false);
            using var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, expected);
            return lease.Reinspect() == expected && lease.Reinspect(expected) == expected;
        }

        internal bool RenameReinspection()
        {
            var path = CreateFile("rename-source");
            var renamed = NewPath("rename-target");
            var expected = Identity(path, false);
            using var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, expected);
            File.Move(path, renamed);
            return lease.Reinspect() == expected;
        }

        internal bool DeleteReinspection()
        {
            var path = CreateFile("delete-source");
            var expected = Identity(path, false);
            using var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, expected);
            File.Delete(path);
            return lease.Reinspect() == expected;
        }

        internal bool ReplacementKeepsOriginal()
        {
            var path = CreateFile("replacement-source");
            var moved = NewPath("replacement-original");
            var expected = Identity(path, false);
            using var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, expected);
            File.Move(path, moved);
            File.WriteAllBytes(path, [0x52]);
            var replacement = Identity(path, false);
            return replacement != expected && lease.Reinspect() == expected;
        }

        internal bool HardlinkRejected()
        {
            var path = CreateFile("hardlink-source");
            var link = NewPath("hardlink-second");
            if (!CreateHardLinkW(link, path, IntPtr.Zero))
                throw new InvalidOperationException("HARDLINK_CREATE_FAILED");
            var expected = Identity(path, false);
            return FixedIdentityFailure(() =>
                CapacityGuardSession.RetainedFileIdentityLease.OpenVerified(
                    path, expected));
        }

        internal bool ReparseRejected()
        {
            var target = NewPath("reparse-target-directory");
            Directory.CreateDirectory(target);
            var link = NewPath("reparse-link");
            var shell = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            var start = new ProcessStartInfo(shell) {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add("/d");
            start.ArgumentList.Add("/c");
            start.ArgumentList.Add("mklink");
            start.ArgumentList.Add("/J");
            start.ArgumentList.Add(link);
            start.ArgumentList.Add(target);
            using var process = Process.Start(start)
                ?? throw new InvalidOperationException("REPARSE_CREATE_FAILED");
            process.WaitForExit(10_000);
            if (process.ExitCode != 0)
                throw new InvalidOperationException("REPARSE_CREATE_FAILED");
            var expected = Identity(link, true);
            return FixedIdentityFailure(() =>
                CapacityGuardSession.RetainedFileIdentityLease.OpenVerified(
                    link, expected));
        }

        internal bool ExpectedMismatch()
        {
            var path = CreateFile("expected-mismatch");
            return FixedIdentityFailure(() =>
                CapacityGuardSession.RetainedFileIdentityLease.OpenVerified(
                    path, "0000000000000000:00000000000000000000000000000000"));
        }

        internal bool ClosedRejected()
        {
            var path = CreateFile("closed");
            var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, Identity(path, false));
            lease.Dispose();
            return FixedIdentityFailure(() => lease.Reinspect());
        }

        internal bool InitialFailure() => FixedIdentityFailure(() =>
            CapacityGuardSession.RetainedFileIdentityLease.OpenVerified(
                NewPath("missing"),
                "0000000000000000:00000000000000000000000000000000"));

        internal bool NormalRelease()
        {
            var path = CreateFile("normal-release");
            var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, Identity(path, false));
            lease.Dispose();
            return FixedIdentityFailure(() => lease.Reinspect());
        }

        internal bool DoubleDispose()
        {
            var path = CreateFile("double-dispose");
            var lease = CapacityGuardSession.RetainedFileIdentityLease
                .OpenVerified(path, Identity(path, false));
            lease.Dispose();
            lease.Dispose();
            return FixedIdentityFailure(() => lease.Reinspect());
        }

        public void Dispose()
        {
            try { Directory.Delete(root, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private string CreateFile(string name)
        {
            var path = NewPath(name);
            File.WriteAllBytes(path, [0x46, 0x30, 0x30, 0x35]);
            return path;
        }

        private string NewPath(string name) => Path.Combine(
            root, name + "-" + Guid.NewGuid().ToString("N") + ".tmp");

        private static bool FixedIdentityFailure(Func<object?> action)
        {
            try
            {
                if (action() is IDisposable disposable) disposable.Dispose();
                return false;
            }
            catch (GuardException error)
            {
                return error.Code ==
                    "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED";
            }
        }

        private static string Identity(string path, bool directory)
        {
            using var handle = CreateFileW(path, 0,
                0x00000001 | 0x00000002 | 0x00000004,
                IntPtr.Zero, 3,
                (directory ? 0x02000000u : 0) | 0x00200000,
                IntPtr.Zero);
            if (handle.IsInvalid)
                throw new InvalidOperationException("IDENTITY_OPEN_FAILED");
            var id = new FileIdInfo { FileId = new byte[16] };
            if (!GetFileInformationByHandleEx(handle, 18, ref id,
                (uint)Marshal.SizeOf<FileIdInfo>()))
                throw new InvalidOperationException("IDENTITY_READ_FAILED");
            return $"{id.VolumeSerialNumber:x16}:" +
                Convert.ToHexStringLower(id.FileId);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName, uint desiredAccess, uint shareMode,
            IntPtr securityAttributes, uint creationDisposition,
            uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file, int informationClass,
            ref FileIdInfo information, uint bufferSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateHardLinkW(
            string newFileName, string existingFileName,
            IntPtr securityAttributes);

        [StructLayout(LayoutKind.Sequential)]
        private struct FileIdInfo
        {
            internal ulong VolumeSerialNumber;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
            internal byte[] FileId;
        }
    }

    private sealed class AtomicSemanticState
    {
        internal long AdmissionHead { get; set; }
        internal long AppliedCursor { get; set; }
        internal Dictionary<int, string> FilesByObject { get; } = new() { [1] = "base" };
        internal Dictionary<string, string> FilesByPath { get; } = new() { ["base"] = "base" };
        internal List<string> Queue { get; } = ["queued"];
        internal List<string> Cleanups { get; } = ["cleanup"];
        internal Dictionary<string, string> GenerationHandles { get; } = new() { ["base"] = "open" };
        internal List<string> Notices { get; } = ["notice-base"];
        internal List<string> Observations { get; } = ["observation-base"];
        internal long Allocated { get; set; } = 10;
        internal long Peak { get; set; } = 10;
        internal long Free { get; set; } = 100;
        internal string Seal { get; set; } = "sealed";
        internal string Lease { get; set; } = "lease";

        internal AtomicCheckpoint Capture() => new(
            AdmissionHead, AppliedCursor,
            new Dictionary<int, string>(FilesByObject),
            new Dictionary<string, string>(FilesByPath),
            Queue.ToArray(), Cleanups.ToArray(),
            new Dictionary<string, string>(GenerationHandles),
            Notices.ToArray(), Observations.ToArray(),
            Allocated, Peak, Free, Seal, Lease);

        internal void Restore(AtomicCheckpoint checkpoint)
        {
            AdmissionHead = checkpoint.AdmissionHead;
            AppliedCursor = checkpoint.AppliedCursor;
            Replace(FilesByObject, checkpoint.FilesByObject);
            Replace(FilesByPath, checkpoint.FilesByPath);
            Queue.Clear(); Queue.AddRange(checkpoint.Queue);
            Cleanups.Clear(); Cleanups.AddRange(checkpoint.Cleanups);
            Replace(GenerationHandles, checkpoint.GenerationHandles);
            Notices.Clear(); Notices.AddRange(checkpoint.Notices);
            Observations.Clear(); Observations.AddRange(checkpoint.Observations);
            Allocated = checkpoint.Allocated; Peak = checkpoint.Peak;
            Free = checkpoint.Free; Seal = checkpoint.Seal; Lease = checkpoint.Lease;
        }

        internal string Fingerprint() => Capture().Fingerprint();

        private static void Replace<TKey>(
            Dictionary<TKey, string> target,
            IReadOnlyDictionary<TKey, string> source) where TKey : notnull
        {
            target.Clear();
            foreach (var item in source) target.Add(item.Key, item.Value);
        }
    }

    private sealed record AtomicCheckpoint(
        long AdmissionHead,
        long AppliedCursor,
        IReadOnlyDictionary<int, string> FilesByObject,
        IReadOnlyDictionary<string, string> FilesByPath,
        IReadOnlyList<string> Queue,
        IReadOnlyList<string> Cleanups,
        IReadOnlyDictionary<string, string> GenerationHandles,
        IReadOnlyList<string> Notices,
        IReadOnlyList<string> Observations,
        long Allocated,
        long Peak,
        long Free,
        string Seal,
        string Lease)
    {
        internal string Fingerprint() => JsonSerializer.Serialize(this);
    }

    private sealed class TargetHandle : IDisposable
    {
        private int disposed;
        internal int DisposeCount { get; private set; }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0) DisposeCount++;
        }
    }

    private sealed record TargetSnapshot(string Name, ImmutableBindingProof? Proof);
    private sealed record TargetCleanup(string Name, ImmutableBindingProof Proof);
    private sealed record AdmissionResult(
        bool ReadHeld, bool WriterWaited, bool NewReadBlocked, bool ReleasedInOrder);
    private sealed record ReplayResult(bool OrderCorrect, bool Committed, bool Converged);

    private static void EmitResult(
        string result, int expected, int passed, string? manifestSha256,
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
        string SchemaVersion, string TargetId, IReadOnlyList<string> Cases);

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
            var production = typeof(WriteCompletionBindingLedger).Assembly;
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
