using System.Buffers;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;
using Microsoft.Win32.SafeHandles;

const string Abi = "f005-guard-jsonl-v1";
const string CapacityAbi = "f005-capacity-pipe-v3";
const int DefaultMaxRequestChars = 65_536;
const int WriteThroughMaxRequestChars = 8_000_000;
var writeThroughOnly = args.Length == 1 &&
    string.Equals(args[0], "--write-through-once", StringComparison.Ordinal);
if (args.Length != 0 && !writeThroughOnly)
{
    ReplyError("MODE_INVALID");
    return;
}
var maxRequestChars = writeThroughOnly ? WriteThroughMaxRequestChars : DefaultMaxRequestChars;
var writeHelloAccepted = false;
var writeCommandAccepted = false;
HeldCapability.PendingWrittenArtifact? pendingWrittenArtifact = null;
var capabilities = new Dictionary<string, HeldCapability>(StringComparer.Ordinal);
CapacityGuardSession? capacitySession = null;

Console.InputEncoding = new UTF8Encoding(false, true);
Console.OutputEncoding = new UTF8Encoding(false, true);
var selfExecutable = Environment.ProcessPath ??
    throw new GuardException("GUARD_BINARY_UNAVAILABLE");
var selfBinarySha256 = Convert.ToHexString(
    SHA256.HashData(File.ReadAllBytes(selfExecutable))).ToLowerInvariant();
var selfDirectory = Path.GetDirectoryName(selfExecutable) ??
    throw new GuardException("GUARD_BINARY_UNAVAILABLE");
var workingDirectoryIsExecutableDirectory = string.Equals(
    Path.GetFullPath(Environment.CurrentDirectory).TrimEnd(Path.DirectorySeparatorChar),
    Path.GetFullPath(selfDirectory).TrimEnd(Path.DirectorySeparatorChar),
    StringComparison.OrdinalIgnoreCase);

while (Console.ReadLine() is { } line)
{
    if (line.Length == 0 || line.Length > maxRequestChars)
    {
        ReplyError("REQUEST_INVALID");
        continue;
    }
    try
    {
        using var document = JsonDocument.Parse(line, new JsonDocumentOptions {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 8,
        });
        var root = document.RootElement;
        var operation = RequiredString(root, "op");
        if (writeThroughOnly &&
            operation is not ("hello" or "write-through" or "write-rename" or "write-commit" or "write-abort"))
            throw new GuardException("OPERATION_INVALID");
        if (!writeThroughOnly &&
            operation is "write-through" or "write-rename" or "write-commit" or "write-abort")
            throw new GuardException("OPERATION_INVALID");
        switch (operation)
        {
            case "hello":
                RequireExactKeys(root, "op");
                if (writeThroughOnly)
                {
                    if (writeHelloAccepted || writeCommandAccepted)
                        throw new GuardException("WRITE_THROUGH_HELLO_INVALID");
                    writeHelloAccepted = true;
                }
                Reply(new {
                    ok = true,
                    abi = Abi,
                    capacityAbi = CapacityAbi,
                    rid = RuntimeInformation.RuntimeIdentifier,
                    runtimeVersion = Environment.Version.ToString(),
                    processId = Environment.ProcessId,
                    binarySha256 = selfBinarySha256,
                    workingDirectoryIsExecutableDirectory,
                });
                break;
            case "capacity-preflight":
                RequireExactKeys(root, "op");
                if (!OperatingSystem.IsWindows()) throw new GuardException("PLATFORM_UNSUPPORTED");
                if (TraceEventSession.IsElevated() != true) throw new GuardException("ETW_PRIVILEGE_REQUIRED");
                Reply(new {
                    ok = true,
                    capacityAbi = CapacityAbi,
                    etw = "system-io-process-start-key",
                    job = "kill-on-close-no-breakaway",
                    ipc = "current-user-named-pipe",
                });
                break;
            case "capacity-start":
            {
                RequireExactKeys(
                    root,
                    "candidateSha256",
                    "journalRelativePath",
                    "op",
                    "owner",
                    "root",
                    "sessionNonce",
                    "workId");
                if (capacitySession is not null) throw new GuardException("CAPACITY_SESSION_ACTIVE");
                capacitySession = CapacityGuardSession.Start(
                    RequiredString(root, "root"),
                    RequiredString(root, "journalRelativePath"),
                    RequiredString(root, "owner"),
                    RequiredSha256(root, "sessionNonce"),
                    RequiredWorkId(root, "workId"),
                    RequiredSha256(root, "candidateSha256"));
                Reply(new {
                    ok = true,
                    capacityAbi = CapacityAbi,
                    pipeName = capacitySession.PipeName,
                    authToken = capacitySession.AuthToken,
                    sessionNonce = capacitySession.SessionNonce,
                    jobIdentity = capacitySession.JobIdentity,
                    etwSessionIdentity = capacitySession.EtwSessionIdentity,
                });
                break;
            }
            case "sync-directory":
            {
                RequireExactKeys(root, "op", "relativePath", "root");
                DirectoryDurability.Flush(
                    RequiredString(root, "root"),
                    RequiredString(root, "relativePath"));
                Reply(new { ok = true, durability = "directory-flush-file-buffers" });
                break;
            }
            case "write-through":
            {
                if (!writeHelloAccepted)
                    throw new GuardException("WRITE_THROUGH_HELLO_REQUIRED");
                if (writeCommandAccepted || pendingWrittenArtifact is not null)
                    throw new GuardException("WRITE_THROUGH_ALREADY_USED");
                writeCommandAccepted = true;
                RequireExactKeys(root, "bodyBase64", "expectedSha256", "op", "relativePath", "root");
                byte[] body;
                try
                {
                    body = Convert.FromBase64String(RequiredString(root, "bodyBase64"));
                }
                catch (FormatException)
                {
                    throw new GuardException("WRITE_THROUGH_BODY_INVALID");
                }
                if (body.Length is 0 or > 5_760_044)
                    throw new GuardException("WRITE_THROUGH_BODY_INVALID");
                var expectedSha256 = RequiredSha256(root, "expectedSha256");
                if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(expectedSha256),
                    Encoding.ASCII.GetBytes(Convert.ToHexStringLower(SHA256.HashData(body)))))
                {
                    throw new GuardException("WRITE_THROUGH_HASH_MISMATCH");
                }
                pendingWrittenArtifact = HeldCapability.CreateWriteThrough(
                    RequiredString(root, "root"),
                    RequiredString(root, "relativePath"),
                    body,
                    expectedSha256);
                Reply(new {
                    ok = true,
                    bytes = pendingWrittenArtifact.Bytes,
                    nativeIdentity = pendingWrittenArtifact.NativeIdentity,
                    relativePath = pendingWrittenArtifact.RelativePath,
                    sha256 = pendingWrittenArtifact.Sha256,
                    durability = "file-flag-write-through-flush-file-buffers-delete-on-close",
                });
                break;
            }
            case "write-rename":
            {
                RequireExactKeys(root, "expectedSha256", "op", "relativePath", "relativeTarget");
                if (pendingWrittenArtifact is null)
                    throw new GuardException("WRITE_THROUGH_PENDING_MISSING");
                pendingWrittenArtifact.Rename(
                    RequiredString(root, "relativePath"),
                    RequiredString(root, "relativeTarget"),
                    RequiredSha256(root, "expectedSha256"));
                Reply(new {
                    ok = true,
                    nativeIdentity = pendingWrittenArtifact.NativeIdentity,
                    relativePath = pendingWrittenArtifact.RelativePath,
                    sha256 = pendingWrittenArtifact.Sha256,
                    state = "renamed",
                });
                break;
            }
            case "write-commit":
            {
                RequireExactKeys(root, "expectedSha256", "op", "relativePath");
                if (pendingWrittenArtifact is null)
                    throw new GuardException("WRITE_THROUGH_PENDING_MISSING");
                pendingWrittenArtifact.Commit(
                    RequiredString(root, "relativePath"),
                    RequiredSha256(root, "expectedSha256"));
                pendingWrittenArtifact = null;
                Reply(new { ok = true, state = "committed" });
                break;
            }
            case "write-abort":
            {
                RequireExactKeys(root, "op");
                if (pendingWrittenArtifact is null)
                    throw new GuardException("WRITE_THROUGH_PENDING_MISSING");
                pendingWrittenArtifact.Abort();
                pendingWrittenArtifact = null;
                Reply(new { ok = true, state = "aborted" });
                break;
            }
            case "open":
            {
                var id = RequiredId(root, "capabilityId");
                if (capabilities.ContainsKey(id)) throw new GuardException("CAPABILITY_DUPLICATE");
                var capability = HeldCapability.Open(
                    RequiredString(root, "root"),
                    RequiredString(root, "relativePath"));
                capabilities.Add(id, capability);
                Reply(new {
                    ok = true,
                    capabilityId = id,
                    bytes = capability.Length,
                    nativeIdentity = capability.NativeIdentity,
                    sha256 = capability.ReadSha256(),
                });
                break;
            }
            case "read":
            {
                var id = RequiredId(root, "capabilityId");
                var capability = RequireCapability(capabilities, id);
                var bytes = capability.ReadAll();
                Reply(new {
                    ok = true,
                    capabilityId = id,
                    bytes = bytes.Length,
                    sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
                    bodyBase64 = Convert.ToBase64String(bytes),
                });
                break;
            }
            case "rename":
            {
                var id = RequiredId(root, "capabilityId");
                var capability = RequireCapability(capabilities, id);
                capability.Rename(RequiredString(root, "relativeTarget"));
                Reply(new {
                    ok = true,
                    capabilityId = id,
                    relativePath = capability.RelativePath,
                    sha256 = capability.ReadSha256(),
                });
                break;
            }
            case "delete":
            {
                RequireExactKeys(root, "capabilityId", "op");
                var id = RequiredId(root, "capabilityId");
                if (!capabilities.Remove(id, out var capability))
                    throw new GuardException("CAPABILITY_UNKNOWN");
                try
                {
                    var deleted = capability.Delete();
                    capability.Dispose();
                    Reply(new {
                        ok = true,
                        capabilityId = id,
                        relativePath = deleted.RelativePath,
                        sha256 = deleted.Sha256,
                    });
                }
                catch
                {
                    capability.Dispose();
                    throw;
                }
                break;
            }
            case "close":
            {
                var id = RequiredId(root, "capabilityId");
                if (!capabilities.Remove(id, out var capability)) throw new GuardException("CAPABILITY_UNKNOWN");
                capability.Dispose();
                Reply(new { ok = true, capabilityId = id });
                break;
            }
            default:
                throw new GuardException("OPERATION_INVALID");
        }
    }
    catch (GuardException error)
    {
        ReplyError(error.Code);
    }
    catch (JsonException)
    {
        ReplyError("REQUEST_INVALID");
    }
    catch (Exception)
    {
        ReplyError("GUARD_FAILURE");
    }
}

foreach (var capability in capabilities.Values) capability.Dispose();
pendingWrittenArtifact?.Abort();
capacitySession?.Dispose();

static HeldCapability RequireCapability(Dictionary<string, HeldCapability> values, string id)
{
    if (!values.TryGetValue(id, out var capability)) throw new GuardException("CAPABILITY_UNKNOWN");
    return capability;
}

static string RequiredId(JsonElement value, string property)
{
    var result = RequiredString(value, property);
    if (result.Length > 128 || result.Any(character =>
        !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
    {
        throw new GuardException("REQUEST_INVALID");
    }
    return result;
}

static string RequiredSha256(JsonElement value, string property)
{
    var result = RequiredString(value, property);
    if (result.Length != 64 || result.Any(character =>
        !(character is >= '0' and <= '9' or >= 'a' and <= 'f')))
    {
        throw new GuardException("REQUEST_INVALID");
    }
    return result;
}

static string RequiredWorkId(JsonElement value, string property)
{
    var result = RequiredString(value, property);
    if (result is not ("000799" or "001076" or "001104"))
    {
        throw new GuardException("REQUEST_INVALID");
    }
    return result;
}

static string RequiredString(JsonElement value, string property)
{
    if (value.ValueKind != JsonValueKind.Object ||
        !value.TryGetProperty(property, out var child) ||
        child.ValueKind != JsonValueKind.String)
    {
        throw new GuardException("REQUEST_INVALID");
    }
    return child.GetString() ?? throw new GuardException("REQUEST_INVALID");
}

static void RequireExactKeys(JsonElement value, params string[] expected)
{
    if (value.ValueKind != JsonValueKind.Object) throw new GuardException("REQUEST_INVALID");
    var actual = value.EnumerateObject()
        .Select(property => property.Name)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToArray();
    var sortedExpected = expected.OrderBy(name => name, StringComparer.Ordinal).ToArray();
    if (!actual.SequenceEqual(sortedExpected, StringComparer.Ordinal))
        throw new GuardException("REQUEST_INVALID");
}

static void Reply(object value)
{
    Console.WriteLine(JsonSerializer.Serialize(value));
    Console.Out.Flush();
}

static void ReplyError(string code) => Reply(new { ok = false, error = code });

sealed class GuardException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

/// <summary>
/// accepted manifestから参照されるartifactのrenameを永続化するため、
/// workspace配下の実directory handleだけをFlushFileBuffersする。
/// @des DES-F005-006 @fun FUN-F005-022
/// </summary>
static class DirectoryDurability
{
    private const uint GenericWrite = 0x40000000;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;

    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase) {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    public static void Flush(string requestedRoot, string relativePath)
    {
        if (!OperatingSystem.IsWindows()) throw new GuardException("PLATFORM_UNSUPPORTED");
        var root = CanonicalRoot(requestedRoot);
        var segments = SafeSegments(relativePath);
        var target = Path.Combine(root, Path.Combine(segments));
        EnsureWithinRoot(root, target);

        var heldDirectories = new List<SafeFileHandle>();
        try
        {
            var cursor = root;
            heldDirectories.Add(OpenDirectory(cursor, write: false));
            for (var index = 0; index < segments.Length; index++)
            {
                cursor = Path.Combine(cursor, segments[index]);
                heldDirectories.Add(OpenDirectory(
                    cursor,
                    write: index == segments.Length - 1));
            }
            if (!FlushFileBuffers(heldDirectories[^1]))
                throw Win32("DIRECTORY_SYNC_FAILED");
        }
        finally
        {
            foreach (var handle in heldDirectories) handle.Dispose();
        }
    }

    private static string CanonicalRoot(string requestedRoot)
    {
        if (string.IsNullOrWhiteSpace(requestedRoot) ||
            !Path.IsPathFullyQualified(requestedRoot) ||
            requestedRoot.Contains('\0'))
        {
            throw new GuardException("ROOT_INVALID");
        }
        string canonical;
        try
        {
            canonical = Path.GetFullPath(requestedRoot);
        }
        catch
        {
            throw new GuardException("ROOT_INVALID");
        }
        if (!string.Equals(canonical, requestedRoot, StringComparison.Ordinal) ||
            !Directory.Exists(canonical))
        {
            throw new GuardException("ROOT_INVALID");
        }
        return canonical;
    }

    private static string[] SafeSegments(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) ||
            Path.IsPathFullyQualified(relativePath) ||
            relativePath.Contains('\\') ||
            relativePath.Contains(':') ||
            relativePath.Contains('\0') ||
            relativePath.Contains("%2f", StringComparison.OrdinalIgnoreCase) ||
            relativePath.Contains("%5c", StringComparison.OrdinalIgnoreCase))
        {
            throw new GuardException("PATH_INVALID");
        }
        var segments = relativePath.Split('/');
        foreach (var segment in segments)
        {
            var stem = segment.Split('.')[0];
            if (segment.Length == 0 || segment is "." or ".." ||
                segment.EndsWith('.') || segment.EndsWith(' ') ||
                Reserved.Contains(stem) ||
                segment.Any(char.IsControl) ||
                !segment.IsNormalized(NormalizationForm.FormC))
            {
                throw new GuardException("PATH_INVALID");
            }
        }
        return segments;
    }

    private static SafeFileHandle OpenDirectory(string path, bool write)
    {
        var handle = CreateFileW(
            path,
            write ? GenericWrite : 0,
            ShareRead | ShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid) throw Win32("DIRECTORY_OPEN_FAILED");
        if (!GetFileInformationByHandle(handle, out var information))
        {
            handle.Dispose();
            throw Win32("DIRECTORY_IDENTITY_FAILED");
        }
        if ((information.FileAttributes & FileAttributeReparsePoint) != 0)
        {
            handle.Dispose();
            throw new GuardException("REPARSE_REJECTED");
        }
        if ((information.FileAttributes & FileAttributeDirectory) == 0)
        {
            handle.Dispose();
            throw new GuardException("DIRECTORY_REQUIRED");
        }
        var finalPath = FinalPath(handle);
        if (!string.Equals(finalPath, path, StringComparison.Ordinal))
        {
            handle.Dispose();
            throw new GuardException("DIRECTORY_IDENTITY_MISMATCH");
        }
        return handle;
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32_768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0) throw Win32("DIRECTORY_FINAL_PATH_FAILED");
        if (length >= buffer.Capacity) throw new GuardException("DIRECTORY_FINAL_PATH_TOO_LONG");
        var value = buffer.ToString();
        if (value.StartsWith(@"\\?\UNC\", StringComparison.Ordinal))
            value = $@"\\{value[8..]}";
        else if (value.StartsWith(@"\\?\", StringComparison.Ordinal))
            value = value[4..];
        try
        {
            return Path.GetFullPath(value);
        }
        catch
        {
            throw new GuardException("DIRECTORY_FINAL_PATH_INVALID");
        }
    }

    private static void EnsureWithinRoot(string root, string target)
    {
        var relation = Path.GetRelativePath(root, target);
        if (relation == "." || relation == ".." ||
            relation.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            Path.IsPathFullyQualified(relation))
        {
            throw new GuardException("PATH_INVALID");
        }
    }

    private static GuardException Win32(string code) =>
        new($"{code}_{Marshal.GetLastWin32Error()}");

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle file,
        StringBuilder filePath,
        uint filePathLength,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle file);
}

sealed class HeldCapability : IDisposable
{
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint CreateNew = 1;
    private const uint FileFlagWriteThrough = 0x80000000;
    private const uint FileFlagDeleteOnClose = 0x04000000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const int FileRenameInfo = 3;
    private const int FileDispositionInfo = 4;
    private const int FileDispositionInfoEx = 21;
    private const uint FileDispositionOnClose = 0x00000008;

    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase) {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    private readonly string root;
    private readonly SafeFileHandle rootHandle;
    private readonly List<SafeFileHandle> directoryHandles;
    private SafeFileHandle fileHandle;
    private FileIdentity identity;
    private string openedSha256 = "";

    private HeldCapability(
        string root,
        string relativePath,
        SafeFileHandle rootHandle,
        List<SafeFileHandle> directoryHandles,
        SafeFileHandle fileHandle,
        FileIdentity identity)
    {
        this.root = root;
        RelativePath = relativePath;
        this.rootHandle = rootHandle;
        this.directoryHandles = directoryHandles;
        this.fileHandle = fileHandle;
        this.identity = identity;
    }

    public string RelativePath { get; private set; }
    public long Length => RandomAccess.GetLength(fileHandle);
    public string NativeIdentity =>
        $"{identity.VolumeSerial:x8}:{identity.FileIndex:x16}";

    public static HeldCapability Open(string requestedRoot, string relativePath)
    {
        if (!OperatingSystem.IsWindows()) throw new GuardException("PLATFORM_UNSUPPORTED");
        var root = Path.GetFullPath(requestedRoot);
        if (!Path.IsPathFullyQualified(requestedRoot) ||
            !string.Equals(root, requestedRoot, StringComparison.Ordinal))
        {
            throw new GuardException("ROOT_INVALID");
        }
        var segments = SafeSegments(relativePath);
        var rootHandle = OpenDirectory(root);
        var directoryHandles = new List<SafeFileHandle>();
        try
        {
            var cursor = root;
            for (var index = 0; index < segments.Length - 1; index++)
            {
                cursor = Path.Combine(cursor, segments[index]);
                directoryHandles.Add(OpenDirectory(cursor));
            }
            var target = Path.Combine(root, Path.Combine(segments));
            EnsureWithinRoot(root, target);
            var fileHandle = CreateFileW(
                target,
                GenericRead | DeleteAccess,
                ShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (fileHandle.IsInvalid) throw Win32("FILE_OPEN_FAILED");
            var identity = Inspect(fileHandle);
            if ((identity.Attributes & FileAttributeReparsePoint) != 0) {
                fileHandle.Dispose();
                throw new GuardException("REPARSE_REJECTED");
            }
            if (identity.Links != 1) {
                fileHandle.Dispose();
                throw new GuardException("HARDLINK_REJECTED");
            }
            var capability = new HeldCapability(
                root,
                relativePath,
                rootHandle,
                directoryHandles,
                fileHandle,
                identity);
            capability.openedSha256 = capability.ReadSha256();
            return capability;
        }
        catch
        {
            foreach (var handle in directoryHandles) handle.Dispose();
            rootHandle.Dispose();
            throw;
        }
    }

    public static PendingWrittenArtifact CreateWriteThrough(
        string requestedRoot,
        string relativePath,
        byte[] body,
        string expectedSha256)
    {
        if (!OperatingSystem.IsWindows()) throw new GuardException("PLATFORM_UNSUPPORTED");
        var root = Path.GetFullPath(requestedRoot);
        if (!Path.IsPathFullyQualified(requestedRoot) ||
            !string.Equals(root, requestedRoot, StringComparison.Ordinal))
            throw new GuardException("ROOT_INVALID");
        var segments = SafeSegments(relativePath);
        SafeFileHandle? rootHandle = null;
        var directoryHandles = new List<SafeFileHandle>();
        SafeFileHandle? fileHandle = null;
        try
        {
            rootHandle = OpenDirectory(root);
            var cursor = root;
            for (var index = 0; index < segments.Length - 1; index++)
            {
                cursor = Path.Combine(cursor, segments[index]);
                directoryHandles.Add(OpenDirectory(cursor));
            }
            var target = Path.Combine(root, Path.Combine(segments));
            EnsureWithinRoot(root, target);
            fileHandle = CreateFileW(
                target,
                GenericRead | GenericWrite | DeleteAccess,
                ShareRead,
                IntPtr.Zero,
                CreateNew,
                FileFlagWriteThrough | FileFlagDeleteOnClose | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (fileHandle.IsInvalid) throw Win32("WRITE_THROUGH_OPEN_FAILED");
            var identity = Inspect(fileHandle);
            if ((identity.Attributes & FileAttributeReparsePoint) != 0 ||
                identity.Links != 1)
                throw new GuardException("WRITE_THROUGH_IDENTITY_UNSAFE");
            RandomAccess.Write(fileHandle, body, 0);
            if (!FlushFileBuffers(fileHandle)) throw Win32("WRITE_THROUGH_FLUSH_FAILED");
            if (RandomAccess.GetLength(fileHandle) != body.LongLength)
                throw new GuardException("WRITE_THROUGH_LENGTH_MISMATCH");
            var readBack = new byte[body.Length];
            var offset = 0;
            while (offset < readBack.Length)
            {
                var read = RandomAccess.Read(fileHandle, readBack.AsSpan(offset), offset);
                if (read == 0) throw new GuardException("WRITE_THROUGH_PARTIAL_READ");
                offset += read;
            }
            var sha256 = Convert.ToHexStringLower(SHA256.HashData(readBack));
            if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expectedSha256),
                Encoding.ASCII.GetBytes(sha256)))
                throw new GuardException("WRITE_THROUGH_READBACK_MISMATCH");
            var written = new PendingWrittenArtifact(
                root,
                relativePath,
                body.LongLength,
                sha256,
                rootHandle,
                directoryHandles.ToArray(),
                fileHandle);
            rootHandle = null;
            directoryHandles.Clear();
            fileHandle = null;
            return written;
        }
        catch
        {
            throw;
        }
        finally
        {
            fileHandle?.Dispose();
            foreach (var handle in directoryHandles) handle.Dispose();
            rootHandle?.Dispose();
        }
    }

    private static void ClearDeleteOnClose(SafeFileHandle fileHandle)
    {
        var disposition = new FileDispositionInformationEx {
            Flags = FileDispositionOnClose,
        };
        var length = Marshal.SizeOf<FileDispositionInformationEx>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(disposition, pointer, false);
            if (!SetFileInformationByHandle(
                fileHandle,
                FileDispositionInfoEx,
                pointer,
                (uint)length))
                throw Win32("WRITE_THROUGH_DELETE_ON_CLOSE_CLEAR_FAILED");
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static void MarkDelete(SafeFileHandle fileHandle)
    {
        try
        {
            var disposition = new FileDispositionInformation { DeleteFile = 1 };
            var length = Marshal.SizeOf<FileDispositionInformation>();
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(disposition, pointer, false);
                if (!SetFileInformationByHandle(
                    fileHandle,
                    FileDispositionInfo,
                    pointer,
                    (uint)length))
                    throw new GuardException("WRITE_THROUGH_CLEANUP_FAILED");
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }
        catch (GuardException) { throw; }
        catch { throw new GuardException("WRITE_THROUGH_CLEANUP_FAILED"); }
    }

    public sealed class PendingWrittenArtifact
    {
        private readonly string root;
        private readonly SafeFileHandle rootHandle;
        private readonly SafeFileHandle[] directoryHandles;
        private readonly SafeFileHandle fileHandle;
        private bool renamed;
        private bool settled;

        internal PendingWrittenArtifact(
            string root,
            string relativePath,
            long bytes,
            string sha256,
            SafeFileHandle rootHandle,
            SafeFileHandle[] directoryHandles,
            SafeFileHandle fileHandle)
        {
            this.root = root;
            RelativePath = relativePath;
            Bytes = bytes;
            Sha256 = sha256;
            this.rootHandle = rootHandle;
            this.directoryHandles = directoryHandles;
            this.fileHandle = fileHandle;
        }

        public string RelativePath { get; private set; }
        public long Bytes { get; }
        public string Sha256 { get; }
        public string NativeIdentity
        {
            get
            {
                var current = Inspect(fileHandle);
                return $"{current.VolumeSerial:x8}:{current.FileIndex:x16}";
            }
        }

        public void Rename(string relativePath, string relativeTarget, string sha256)
        {
            AssertTuple(relativePath, sha256, "WRITE_THROUGH_RENAME_MISMATCH");
            if (renamed) throw new GuardException("WRITE_THROUGH_RENAME_ALREADY_USED");
            var targetSegments = SafeSegments(relativeTarget);
            var sourceSegments = SafeSegments(relativePath);
            if (targetSegments.Length != sourceSegments.Length ||
                !targetSegments[..^1].SequenceEqual(sourceSegments[..^1], StringComparer.Ordinal))
                throw new GuardException("WRITE_THROUGH_RENAME_TARGET_INVALID");
            var target = Path.Combine(root, Path.Combine(targetSegments));
            EnsureWithinRoot(root, target);
            RenameByHandle(fileHandle, target);
            RelativePath = relativeTarget;
            renamed = true;
        }

        public void Commit(string relativePath, string sha256)
        {
            AssertTuple(relativePath, sha256, "WRITE_THROUGH_COMMIT_MISMATCH");
            if (!renamed) throw new GuardException("WRITE_THROUGH_RENAME_REQUIRED");
            ClearDeleteOnClose(fileHandle);
            settled = true;
            DisposeHandles();
        }

        public void Abort()
        {
            if (settled) return;
            try
            {
                settled = true;
            }
            finally
            {
                DisposeHandles();
            }
        }

        private void AssertTuple(string relativePath, string sha256, string code)
        {
            if (settled ||
                !string.Equals(RelativePath, relativePath, StringComparison.Ordinal) ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(Sha256),
                    Encoding.ASCII.GetBytes(sha256)))
                throw new GuardException(code);
        }

        private void DisposeHandles()
        {
            fileHandle.Dispose();
            foreach (var handle in directoryHandles) handle.Dispose();
            rootHandle.Dispose();
        }
    }

    public byte[] ReadAll()
    {
        AssertIdentity();
        var length = Length;
        if (length < 0 || length > 67_108_864) throw new GuardException("FILE_TOO_LARGE");
        var bytes = new byte[length];
        var offset = 0;
        while (offset < bytes.Length)
        {
            var read = RandomAccess.Read(fileHandle, bytes.AsSpan(offset), offset);
            if (read == 0) throw new GuardException("PARTIAL_READ");
            offset += read;
        }
        AssertIdentity();
        return bytes;
    }

    public string ReadSha256() => Convert.ToHexStringLower(SHA256.HashData(ReadAll()));

    public DeletedArtifact Delete()
    {
        AssertIdentity();
        var currentSha256 = ReadSha256();
        if (!string.Equals(currentSha256, openedSha256, StringComparison.Ordinal))
            throw new GuardException("CONTENT_CHANGED");
        AssertIdentity();
        var disposition = new FileDispositionInformation { DeleteFile = 1 };
        var length = Marshal.SizeOf<FileDispositionInformation>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(disposition, pointer, false);
            if (!SetFileInformationByHandle(
                fileHandle,
                FileDispositionInfo,
                pointer,
                (uint)length))
            {
                throw Win32("DELETE_FAILED");
            }
            return new DeletedArtifact(RelativePath, currentSha256);
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public void Rename(string relativeTarget)
    {
        AssertIdentity();
        var segments = SafeSegments(relativeTarget);
        var target = Path.Combine(root, Path.Combine(segments));
        EnsureWithinRoot(root, target);
        if (File.Exists(target) || Directory.Exists(target)) throw new GuardException("RENAME_TARGET_EXISTS");
        var targetDirectory = root;
        var newHandles = new List<SafeFileHandle>();
        try
        {
            for (var index = 0; index < segments.Length - 1; index++)
            {
                targetDirectory = Path.Combine(targetDirectory, segments[index]);
                newHandles.Add(OpenDirectory(targetDirectory));
            }
            RenameByHandle(fileHandle, target);
            AssertIdentity();
            foreach (var handle in directoryHandles) handle.Dispose();
            directoryHandles.Clear();
            directoryHandles.AddRange(newHandles);
            newHandles.Clear();
            RelativePath = relativeTarget;
        }
        finally
        {
            foreach (var handle in newHandles) handle.Dispose();
        }
    }

    private void AssertIdentity()
    {
        var current = Inspect(fileHandle);
        if (current.VolumeSerial != identity.VolumeSerial ||
            current.FileIndex != identity.FileIndex ||
            current.Links != 1 ||
            (current.Attributes & FileAttributeReparsePoint) != 0)
        {
            throw new GuardException("IDENTITY_CHANGED");
        }
    }

    public void Dispose()
    {
        fileHandle.Dispose();
        foreach (var handle in directoryHandles) handle.Dispose();
        rootHandle.Dispose();
    }

    private static string[] SafeSegments(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) ||
            Path.IsPathFullyQualified(relativePath) ||
            relativePath.Contains('\\') ||
            relativePath.Contains(':') ||
            relativePath.Contains('\0') ||
            relativePath.Contains("%2f", StringComparison.OrdinalIgnoreCase) ||
            relativePath.Contains("%5c", StringComparison.OrdinalIgnoreCase))
        {
            throw new GuardException("PATH_INVALID");
        }
        var segments = relativePath.Split('/');
        foreach (var segment in segments)
        {
            var stem = segment.Split('.')[0];
            if (segment.Length == 0 || segment is "." or ".." ||
                segment.EndsWith('.') || segment.EndsWith(' ') ||
                Reserved.Contains(stem) ||
                segment.Any(character => char.IsControl(character)) ||
                !segment.IsNormalized(NormalizationForm.FormC))
            {
                throw new GuardException("PATH_INVALID");
            }
        }
        return segments;
    }

    private static SafeFileHandle OpenDirectory(string path)
    {
        var handle = CreateFileW(
            path,
            0,
            ShareRead | ShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid) throw Win32("DIRECTORY_OPEN_FAILED");
        var information = Inspect(handle);
        if ((information.Attributes & FileAttributeReparsePoint) != 0)
        {
            handle.Dispose();
            throw new GuardException("REPARSE_REJECTED");
        }
        return handle;
    }

    private static void EnsureWithinRoot(string root, string target)
    {
        var relation = Path.GetRelativePath(root, target);
        if (relation == "." || relation == ".." ||
            relation.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            Path.IsPathFullyQualified(relation))
        {
            throw new GuardException("PATH_INVALID");
        }
    }

    private static FileIdentity Inspect(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var information)) throw Win32("IDENTITY_READ_FAILED");
        return new FileIdentity(
            information.VolumeSerialNumber,
            ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
            information.NumberOfLinks,
            information.FileAttributes);
    }

    private static void RenameByHandle(SafeFileHandle handle, string target)
    {
        var name = Encoding.Unicode.GetBytes(target);
        var offset = IntPtr.Size == 8 ? 20 : 12;
        var buffer = Marshal.AllocHGlobal(offset + name.Length + sizeof(char));
        try
        {
            Span<byte> zero = stackalloc byte[offset];
            Marshal.Copy(zero.ToArray(), 0, buffer, offset);
            Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, offset), name.Length);
            Marshal.WriteInt16(buffer, offset + name.Length, 0);
            if (!SetFileInformationByHandle(handle, FileRenameInfo, buffer, (uint)(offset + name.Length + sizeof(char))))
            {
                throw Win32("RENAME_FAILED");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static GuardException Win32(string code) =>
        new($"{code}_{Marshal.GetLastWin32Error()}");

    private sealed record FileIdentity(uint VolumeSerial, ulong FileIndex, uint Links, uint Attributes);
    public sealed record DeletedArtifact(string RelativePath, string Sha256);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInformation
    {
        public byte DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInformationEx
    {
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        IntPtr fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle file);
}

/// <summary>
/// ETWを正本とするF005容量観測session。path guardのJSONL ABIとは別に、
/// current-user named pipe + nonce/tokenで認証した制御面だけを公開する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-047
/// </summary>
sealed class CapacityGuardSession : IDisposable
{
    private const int MaxPipeRequestChars = 65_536;
    private const int MaxWriteCompletionSeals = 128;
    private const int MaxWriteCompletionEventsPerSeal = 64;
    private const int MaxWriteCompletionEventsPerPhase = 8_192;
    private const int MaxWriteCompletionLedgerEntries = 8_192;
    private const int MaxWriteCompletionRetainedHandles = 8_448;
    private static readonly TimeSpan ObservationMatchWindow = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ProcessIdentityProbeTimeout = TimeSpan.FromSeconds(10);
    private static readonly JsonSerializerOptions JournalJson = new() {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
    private static readonly HashSet<string> Phases = new(StringComparer.Ordinal) {
        "voice", "preview", "accept", "build",
    };
    private static readonly HashSet<string> WorkIds = new(StringComparer.Ordinal) {
        "000799", "001076", "001104",
    };

    private readonly object gate = new();
    private readonly WriteCompletionCallbackAdmission callbackAdmission = new();
    private readonly string root;
    private readonly string journalPath;
    private readonly string journalDirectory;
    private readonly string processIdentityProbePath;
    private readonly string producerBinarySha256;
    private readonly CancellationTokenSource cancellation = new();
    private readonly ManualResetEventSlim processIdentityProbeObserved = new(false);
    private readonly JobObject job;
    private readonly TraceEventSession etwSession;
    private readonly ETWTraceEventSource etwSource;
    private readonly Thread etwThread;
    private readonly Task pipeTask;
    private readonly HashSet<int> registeredPids = [];
    private readonly Dictionary<ulong, RegisteredWorkerProcess> registeredWorkerProcesses = [];
    private readonly Dictionary<int, ProcessBirthRecord> processBirthByPid = [];
    private readonly Dictionary<ulong, FileSnapshot> filesByObject = [];
    private readonly Dictionary<string, FileSnapshot> filesByPath = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> allocatedByIdentity = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CompletedWriteRecord> completedWrites =
        new(StringComparer.Ordinal);
    private readonly List<PhaseRecord> phaseRecords = [];
    private readonly List<NoticeRecord> notices = [];
    private readonly List<ObservationRecord> observations = [];
    private readonly List<DeferredRenameRecord> deferredRenames = [];
    private readonly List<DeferredSystemSetInfoRecord> deferredSystemSetInfos = [];
    private readonly List<WriteCompletionDrainSeal> writeCompletionSeals = [];
    private readonly WriteCompletionReplayStore<
        PendingCallbackSnapshot,
        PendingCleanupSnapshot,
        RetainedFileIdentityLease> writeCompletionReplayStore = new();
    private List<PendingCallbackSnapshot> writeCompletionReorderQueue =>
        writeCompletionReplayStore.Snapshots;
    private List<PendingCleanupSnapshot> writeCompletionCleanupProofs =>
        writeCompletionReplayStore.Cleanups;
    private Dictionary<(ulong FileObject, long Generation), RetainedFileIdentityLease>
        writeCompletionGenerationHandles => writeCompletionReplayStore.GenerationHandles;
    private WriteCompletionBindingLedger? writeCompletionBindingLedger
    {
        get => writeCompletionReplayStore.Ledger;
        set => writeCompletionReplayStore.Ledger = value;
    }
    private PendingWriteLease? pendingWriteLease;
    private long etwSequence;
    private long etwRelevantEventCount;
    private long etwAccountedEventCount;
    private long writeCompletionSealSequence;
    private int writeCompletionPhaseEventCount;
    private long writeCompletionCleanupRelevantCount;
    private long writeCompletionCleanupAccountedCount;
    private bool writeCompletionReorderActive;
    private long noticeSequence;
    private long peakLiveBytes;
    private long minimumObservedFreeBytes;
    private int? rootWorkerPid;
    private Process? rootWorkerProcess;
    private ulong? rootWorkerStartKey;
    private ulong? rootWorkerSequenceNumber;
    private string? failureCode;
    private string? lastEtwDiagnostic;
    private ActivePhase? activePhase;
    private bool etwStopped;
    private bool processIdentityProbeArmed;
    private bool processIdentityProbed;
    private bool journalClosed;
    private bool disposed;

    private CapacityGuardSession(
        string root,
        string journalPath,
        string owner,
        string sessionNonce,
        string workId,
        string candidateSha256,
        JobObject job,
        TraceEventSession etwSession)
    {
        this.root = root;
        this.journalPath = journalPath;
        journalDirectory = Path.GetDirectoryName(journalPath)
            ?? throw new GuardException("JOURNAL_PATH_INVALID");
        processIdentityProbePath = Path.ChangeExtension(
            Path.GetRelativePath(root, journalPath)
                .Replace(Path.DirectorySeparatorChar, '/'),
            ".probe");
        Owner = owner;
        SessionNonce = sessionNonce;
        WorkId = workId;
        CandidateSha256 = candidateSha256;
        JobIdentity = $"f005-job-{Guid.NewGuid():N}";
        EtwSessionIdentity = etwSession.SessionName;
        PipeName = $"f005-capacity-{Guid.NewGuid():N}";
        AuthToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        this.job = job;
        this.etwSession = etwSession;
        etwSource = etwSession.Source;
        var executable = Environment.ProcessPath ?? throw new GuardException("GUARD_BINARY_UNAVAILABLE");
        producerBinarySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(executable)));
        InitialFreeBytes = ReadFreeBytes(root);
        minimumObservedFreeBytes = InitialFreeBytes;

        ConfigureEtwCallbacks();
        PersistJournal(closed: false);
        // Named pipe instanceを同期生成してからcapacity-startへ応答できる状態にする。
        // Task schedulerよりclient接続が先行するreadiness raceを許さない。
        var initialPipe = CreatePipeServer();
        etwThread = new Thread(ProcessEtw) {
            IsBackground = true,
            Name = "f005-capacity-etw",
        };
        try
        {
            etwThread.Start();
            pipeTask = Task.Run(() => PipeLoopAsync(initialPipe));
        }
        catch
        {
            initialPipe.Dispose();
            throw;
        }
    }

    public string Owner { get; }
    public string SessionNonce { get; }
    public string WorkId { get; }
    public string CandidateSha256 { get; }
    public string JobIdentity { get; }
    public string EtwSessionIdentity { get; }
    public string PipeName { get; }
    public string AuthToken { get; }
    public long InitialFreeBytes { get; }

    public static CapacityGuardSession Start(
        string requestedRoot,
        string journalRelativePath,
        string owner,
        string sessionNonce,
        string workId,
        string candidateSha256)
    {
        if (!OperatingSystem.IsWindows()) throw new GuardException("PLATFORM_UNSUPPORTED");
        if (TraceEventSession.IsElevated() != true) throw new GuardException("ETW_PRIVILEGE_REQUIRED");
        if (string.IsNullOrWhiteSpace(owner) || owner.Length > 256 || owner.Any(char.IsControl))
        {
            throw new GuardException("OWNER_INVALID");
        }
        var root = Path.GetFullPath(requestedRoot);
        if (!Path.IsPathFullyQualified(requestedRoot) ||
            !string.Equals(root, requestedRoot, StringComparison.Ordinal) ||
            !Directory.Exists(root))
        {
            throw new GuardException("ROOT_INVALID");
        }
        var relative = ValidateRelativePath(journalRelativePath);
        if (!relative.StartsWith(".cache/f005-capacity/", StringComparison.Ordinal) ||
            !relative.EndsWith(".json", StringComparison.Ordinal))
        {
            throw new GuardException("JOURNAL_PATH_INVALID");
        }
        var journalPath = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        EnsureWithinRoot(root, journalPath);
        var journalDirectory = Path.GetDirectoryName(journalPath)
            ?? throw new GuardException("JOURNAL_PATH_INVALID");
        Directory.CreateDirectory(journalDirectory);
        if (File.Exists(journalPath)) throw new GuardException("JOURNAL_CONFLICT");

        JobObject? job = null;
        TraceEventSession? session = null;
        try
        {
            job = JobObject.Create();
            var identity = $"F005Capacity-{Guid.NewGuid():N}";
            session = new TraceEventSession(identity) {
                StopOnDispose = true,
                BufferSizeMB = 64,
            };
            TraceEventProcessIdentity.ValidateAbi();
            session.EnableKernelProvider(KernelTraceEventParser.Keywords.None);
            TraceEventSystemController.EnableSystemIoProcessStartKey(session);
            // TraceEventの戻り値は「既存sessionを再起動したか」であり成否ではない。
            // provider有効化失敗は例外として扱われるため、timeoutを明示して呼び出す。
            session.EnableProviderTimeoutMSec = 10_000;
            session.EnableProvider(
                TraceEventProcessIdentity.KernelProcessProvider,
                TraceEventLevel.Informational,
                TraceEventProcessIdentity.KernelProcessKeyword);
            return new CapacityGuardSession(
                root,
                journalPath,
                owner,
                sessionNonce,
                workId,
                candidateSha256,
                job,
                session);
        }
        catch (UnauthorizedAccessException error)
        {
            session?.Dispose();
            job?.Dispose();
            throw new GuardException($"ETW_PRIVILEGE_REQUIRED_{error.HResult:x8}");
        }
        catch (GuardException)
        {
            session?.Dispose();
            job?.Dispose();
            throw;
        }
        catch (Exception error) when (error is not GuardException)
        {
            session?.Dispose();
            job?.Dispose();
            throw new GuardException($"ETW_SESSION_START_FAILED_{error.HResult:x8}");
        }
    }

#pragma warning disable CS0618 // phase境界は同一QPC clockで比較するためTimeStampQPCを意図的に使う。
    private void ConfigureEtwCallbacks()
    {
        var kernel = etwSource.Kernel;
        etwSource.Registered.All += ObserveProcessBirth;
        kernel.FileIOCreate += data => {
            if (data.CreateDisposition != CreateDisposition.OPEN_EXISTING)
            {
                ObserveEtw(
                    "create",
                    data.ProcessID,
                    TraceEventProcessIdentity.ProcessStartKey(data),
                    data.FileName,
                    data.FileObject,
                    data.TimeStamp,
                    data.TimeStampQPC);
            }
        };
        kernel.FileIOWrite += data =>
            ObserveEtw(
                "write",
                data.ProcessID,
                TraceEventProcessIdentity.ProcessStartKey(data),
                data.FileName,
                data.FileObject,
                data.TimeStamp,
                data.TimeStampQPC);
        kernel.FileIOSetInfo += data =>
            ObserveEtw(
                "setinfo",
                data.ProcessID,
                TraceEventProcessIdentity.ProcessStartKey(data),
                data.FileName,
                data.FileObject,
                data.TimeStamp,
                data.TimeStampQPC);
        kernel.FileIORename += data =>
            ObserveEtw(
                "rename",
                data.ProcessID,
                TraceEventProcessIdentity.ProcessStartKey(data),
                data.FileName,
                data.FileObject,
                data.TimeStamp,
                data.TimeStampQPC);
        kernel.FileIODelete += data =>
            ObserveEtw(
                "delete",
                data.ProcessID,
                TraceEventProcessIdentity.ProcessStartKey(data),
                data.FileName,
                data.FileObject,
                data.TimeStamp,
                data.TimeStampQPC);
        kernel.FileIOCleanup += data => ForgetFileObject(data.FileObject);
        kernel.LostEvent += _ => Poison("ETW_BUFFER_LOSS");
        kernel.All += ObserveUnknownEtw;
    }
#pragma warning restore CS0618

    private void ForgetFileObject(ulong fileObject)
    {
        using var admissionLease = callbackAdmission.EnterCallback();
        var tracked = false;
        try
        {
            lock (gate)
            {
                ImmutableBindingProof? cleanupProof = null;
                if (writeCompletionBindingLedger is not null)
                {
                    try
                    {
                        cleanupProof = writeCompletionBindingLedger
                            .AdmitCleanup(fileObject);
                    }
                    catch (Exception error) when (
                        error is OverflowException or InvalidOperationException)
                    {
                        throw new GuardException(error.Message == "BUFFER_LIMIT"
                            ? "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT"
                            : "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
                    }
                    if (cleanupProof is not null)
                    {
                        tracked = true;
                        try
                        {
                            writeCompletionCleanupRelevantCount =
                                WriteCompletionDrainRules.CheckedCounterAdd(
                                    writeCompletionCleanupRelevantCount,
                                    1);
                        }
                        catch (WriteCompletionBufferLimitException)
                        {
                            throw new GuardException(
                                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
                        }
                        if (writeCompletionReorderActive)
                        {
                            writeCompletionReplayStore.AddCleanup(
                                new PendingCleanupSnapshot(cleanupProof, fileObject));
                            return;
                        }
                        else
                        {
                            writeCompletionBindingLedger.Validate([cleanupProof]);
                            var checkpoint = CaptureCompletionSemanticCheckpointLocked();
                            WriteCompletionAtomicBatchRules.Execute(
                                () => ApplyCleanupSemanticLocked(
                                    fileObject,
                                    transactional: true),
                                () => writeCompletionBindingLedger.ValidateAndCommit(
                                    [cleanupProof]),
                                () => RestoreCompletionSemanticCheckpointLocked(
                                    checkpoint));
                            return;
                        }
                    }
                    return;
                }
                ApplyCleanupSemanticLocked(fileObject);
            }
        }
        catch (Exception error)
        {
            Poison(error is GuardException guard
                ? guard.Code
                : "F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
        }
        finally
        {
            if (tracked)
            {
                try
                {
                    lock (gate)
                        writeCompletionCleanupAccountedCount =
                            WriteCompletionDrainRules.CheckedCounterAdd(
                                writeCompletionCleanupAccountedCount,
                                1);
                }
                catch (WriteCompletionBufferLimitException)
                {
                    Poison("F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
                }
            }
        }
    }

    private void ApplyCleanupSemanticLocked(
        ulong fileObject,
        bool transactional = false)
    {
        filesByObject.Remove(fileObject);
        var lease = pendingWriteLease;
        var deferredMatches = deferredSystemSetInfos.Any(
            item => item.FileObject == fileObject);
        if (!SystemSetInfoCorrelationRules.CleanupInvalidates(
            fileObject,
            lease?.FileObject,
            deferredSystemSetInfos.Select(item => item.FileObject)))
            return;
        if (deferredMatches)
        {
            if (transactional)
                throw new GuardException(
                    "ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_CLEANUP");
            PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_CLEANUP");
            deferredSystemSetInfos.Clear();
        }
        if (lease is { FileObject: { } leasedFileObject } &&
            leasedFileObject == fileObject)
        {
            lease.FileObject = null;
            lease.FileObjectClosed = true;
        }
    }

    private void ObserveUnknownEtw(TraceEvent data)
    {
        if (!string.Equals(data.TaskName, "FileIO", StringComparison.Ordinal)) return;
        var operation = data.EventName;
        if (operation is
            "FileIO/Create" or "FileIO/Write" or "FileIO/SetInfo" or
            "FileIO/Rename" or "FileIO/Delete" or
            "FileIO/Cleanup" or "FileIO/Close" or "FileIO/DirEnum" or
            "FileIO/DirNotify" or "FileIO/FileCreate" or "FileIO/FileDelete" or
            "FileIO/FileRundown" or "FileIO/Flush" or "FileIO/FSControl" or
            "FileIO/MapFile" or "FileIO/MapFileDCStart" or "FileIO/MapFileDCStop" or
            "FileIO/Name" or "FileIO/OperationEnd" or "FileIO/QueryInfo" or
            "FileIO/Read" or "FileIO/UnmapFile")
        {
            return;
        }
        lock (gate)
        {
            var processStartKey = TraceEventProcessIdentity.ProcessStartKey(data);
#pragma warning disable CS0618 // process generation境界は同一QPC clockで照合する。
            if (AuthorizeJobMemberLocked(
                data.ProcessID,
                processStartKey,
                data.TimeStampQPC,
                out _,
                out _))
                PoisonLocked("ETW_UNKNOWN_EVENT");
#pragma warning restore CS0618
        }
    }

    private void ObserveProcessBirth(TraceEvent data)
    {
        if (data.ProviderGuid != TraceEventProcessIdentity.KernelProcessProvider ||
            (int)data.ID != TraceEventProcessIdentity.KernelProcessStartEventId)
        {
            return;
        }
        try
        {
            var pid = checked(Convert.ToInt32(data.PayloadByName("ProcessID")));
            var sequenceNumber = checked(Convert.ToUInt64(
                data.PayloadByName("ProcessSequenceNumber")));
#pragma warning disable CS0618 // process世代境界は同一QPC clockで照合する。
            var timestampQpc = data.TimeStampQPC;
#pragma warning restore CS0618
            if (pid <= 0 || sequenceNumber == 0 || timestampQpc <= 0)
                throw new GuardException("ETW_PROCESS_START_PAYLOAD_INVALID");
            lock (gate)
            {
                if (journalClosed || failureCode is not null) return;
                if (!processBirthByPid.TryGetValue(pid, out var prior) ||
                    timestampQpc > prior.StartedAtQpc)
                {
                    // ProcessSequenceNumberはboot内で再利用されない。PID再利用時も
                    // FileIO eventと現在handleを同じ世代へ完全結合できる。
                    processBirthByPid[pid] =
                        new ProcessBirthRecord(sequenceNumber, timestampQpc);
                    Monitor.PulseAll(gate);
                }
            }
        }
        catch
        {
            Poison("ETW_PROCESS_START_PAYLOAD_INVALID");
        }
    }

    private void ProcessEtw()
    {
        try
        {
            etwSource.Process();
        }
        catch (Exception error)
        {
            lock (gate)
            {
                if (!etwStopped) PoisonLocked($"ETW_CONSUMER_FAILED_{error.HResult:x8}");
            }
        }
    }

    private NamedPipeServerStream CreatePipeServer() =>
        new(
            PipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

    private async Task PipeLoopAsync(NamedPipeServerStream initialPipe)
    {
        var nextPipe = initialPipe;
        // while条件でcancelを判定すると、次instance生成直後のcancel時に未使用pipeを
        // disposeせず抜け得る。取得済みinstanceは必ずawait usingへ入れて破棄する。
        while (true)
        {
            await using (var pipe = nextPipe)
            {
                try
                {
                    await pipe.WaitForConnectionAsync(cancellation.Token).ConfigureAwait(false);
                    if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var clientPid) ||
                        clientPid is 0 or > int.MaxValue)
                    {
                        Poison("IPC_PEER_IDENTITY_UNAVAILABLE");
                        return;
                    }
                    using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, leaveOpen: true);
                    await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) {
                        AutoFlush = true,
                        NewLine = "\n",
                    };
                    while (!cancellation.IsCancellationRequested &&
                        await reader.ReadLineAsync(cancellation.Token).ConfigureAwait(false) is { } line)
                    {
                        object reply;
                        if (line.Length is 0 or > MaxPipeRequestChars)
                        {
                            reply = Error("REQUEST_INVALID");
                        }
                        else
                        {
                            try
                            {
                                using var document = JsonDocument.Parse(line, new JsonDocumentOptions {
                                    AllowTrailingCommas = false,
                                    CommentHandling = JsonCommentHandling.Disallow,
                                    MaxDepth = 8,
                                });
                                reply = DispatchPipe(document.RootElement, checked((int)clientPid));
                            }
                            catch (GuardException error)
                            {
                                Poison(error.Code);
                                reply = Error(error.Code);
                            }
                            catch (JsonException)
                            {
                                Poison("REQUEST_INVALID");
                                reply = Error("REQUEST_INVALID");
                            }
                            catch (Exception error)
                            {
                                Poison($"CAPACITY_GUARD_FAILURE_{error.HResult:x8}");
                                reply = Error("CAPACITY_GUARD_FAILURE");
                            }
                        }
                        await writer.WriteLineAsync(JsonSerializer.Serialize(reply)).ConfigureAwait(false);
                    }
                    if (!cancellation.IsCancellationRequested)
                    {
                        lock (gate)
                        {
                            if (!journalClosed) PoisonLocked("IPC_PEER_DISCONNECTED");
                        }
                    }
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                {
                    break;
                }
                catch (IOException error)
                {
                    if (!cancellation.IsCancellationRequested)
                        Poison($"IPC_FAILURE_{error.HResult:x8}");
                }
            }
            if (cancellation.IsCancellationRequested) break;
            nextPipe = CreatePipeServer();
        }
    }

    private object DispatchPipe(JsonElement rootElement, int clientPid)
    {
        Authenticate(rootElement);
        var operation = PipeString(rootElement, "op");
        switch (operation)
        {
            case "registerSelf":
                RequireExactPipeKeys(rootElement, "authToken", "op", "sessionNonce");
                break;
            case "armProcessIdentityProbe":
            case "verifyProcessIdentityProbe":
                RequireExactPipeKeys(rootElement, "authToken", "op", "path", "sessionNonce");
                break;
            case "beginPhase":
                RequireExactPipeKeys(rootElement, "authToken", "op", "phase", "phaseInstanceId", "sessionNonce", "workId");
                break;
            case "reserveWrite":
            case "completeWrite":
            case "prepareWriteCompletion":
                RequireExactPipeKeys(rootElement, "authToken", "op", "path", "phase", "phaseInstanceId", "producerPid", "sessionNonce", "workId");
                break;
            case "prepareWriteRename":
                RequireExactPipeKeys(rootElement, "authToken", "from", "op", "phase", "phaseInstanceId", "producerPid", "sessionNonce", "to", "workId");
                break;
            case "notice":
            {
                var eventName = PipeString(rootElement, "event");
                RequireExactPipeKeys(rootElement, eventName == "rename"
                    ? ["authToken", "event", "from", "noticeId", "op", "phase", "phaseInstanceId", "producerPid", "sessionNonce", "to", "workId"]
                    : ["authToken", "event", "noticeId", "op", "path", "phase", "phaseInstanceId", "producerPid", "sessionNonce", "workId"]);
                break;
            }
            case "endPhase":
                RequireExactPipeKeys(rootElement, "authToken", "op", "phase", "phaseInstanceId", "sessionNonce");
                break;
            case "close":
            case "status":
                RequireExactPipeKeys(rootElement, "authToken", "op", "sessionNonce");
                break;
            default:
                throw new GuardException("OPERATION_INVALID");
        }
        if (operation == "close") return CloseJournal();
        if (operation == "endPhase")
        {
            return EndPhaseAfterEtwDrain(
                PipeString(rootElement, "phase"),
                PipeSha256(rootElement, "phaseInstanceId"));
        }
        if (operation == "completeWrite")
        {
            return CompleteWriteAfterEtwDrain(
                PipeString(rootElement, "phase"),
                PipeNullableWorkId(rootElement, "workId"),
                PipeSha256(rootElement, "phaseInstanceId"),
                PipePositiveInt(rootElement, "producerPid"),
                ValidateRelativePath(PipeString(rootElement, "path")),
                clientPid);
        }
        if (operation == "verifyProcessIdentityProbe")
        {
            return VerifyProcessIdentityProbe(
                PipeString(rootElement, "path"),
                clientPid);
        }
        if (operation == "prepareWriteCompletion")
        {
            using (callbackAdmission.EnterFinal())
            {
                lock (gate)
                {
                    ThrowIfClosed();
                    return PrepareWriteCompletion(
                        PipeString(rootElement, "phase"),
                        PipeNullableWorkId(rootElement, "workId"),
                        PipeSha256(rootElement, "phaseInstanceId"),
                        PipePositiveInt(rootElement, "producerPid"),
                        ValidateRelativePath(PipeString(rootElement, "path")),
                        clientPid);
                }
            }
        }
        lock (gate)
        {
            ThrowIfClosed();
            return operation switch {
                "registerSelf" => RegisterSelf(clientPid),
                "armProcessIdentityProbe" => ArmProcessIdentityProbe(
                    PipeString(rootElement, "path"),
                    clientPid),
                "beginPhase" => BeginPhase(
                    PipeString(rootElement, "phase"),
                    PipeNullableWorkId(rootElement, "workId"),
                    PipeSha256(rootElement, "phaseInstanceId")),
                "reserveWrite" => ReserveWrite(
                    PipeString(rootElement, "phase"),
                    PipeNullableWorkId(rootElement, "workId"),
                    PipeSha256(rootElement, "phaseInstanceId"),
                    PipePositiveInt(rootElement, "producerPid"),
                    ValidateRelativePath(PipeString(rootElement, "path")),
                    clientPid),
                "prepareWriteRename" => PrepareWriteRename(
                    PipeString(rootElement, "phase"),
                    PipeNullableWorkId(rootElement, "workId"),
                    PipeSha256(rootElement, "phaseInstanceId"),
                    PipePositiveInt(rootElement, "producerPid"),
                    ValidateRelativePath(PipeString(rootElement, "from")),
                    ValidateRelativePath(PipeString(rootElement, "to")),
                    clientPid),
                "notice" => ReceiveNotice(rootElement, clientPid),
                "status" => new {
                    ok = true,
                    state = journalClosed ? "closed" : "open",
                    failureCode,
                    observations = observations.Count,
                    notices = notices.Count,
                },
                _ => throw new GuardException("OPERATION_INVALID"),
            };
        }
    }

    private void Authenticate(JsonElement rootElement)
    {
        var nonce = PipeString(rootElement, "sessionNonce");
        var token = PipeString(rootElement, "authToken");
        if (!FixedEquals(nonce, SessionNonce) || !FixedEquals(token, AuthToken))
            throw new GuardException("IPC_AUTHENTICATION_FAILED");
    }

    private object RegisterSelf(int pid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (registeredPids.Count != 0 || registeredPids.Contains(pid))
            throw new GuardException("ROOT_PID_REPLAY");
        var process = job.Assign(pid);
        if (!job.Contains(process))
        {
            process.Dispose();
            throw new GuardException("JOB_ASSIGNMENT_FAILED");
        }
        rootWorkerPid = pid;
        rootWorkerProcess = process;
        var processIdentity = job.ProcessIdentity(process);
        rootWorkerStartKey = processIdentity.ProcessStartKey;
        rootWorkerSequenceNumber = processIdentity.ProcessSequenceNumber;
        registeredPids.Add(pid);
        PersistJournal(closed: false);
        return new {
            ok = true,
            pid,
            jobIdentity = JobIdentity,
            processIdentityProbePath,
        };
    }

    private object ArmProcessIdentityProbe(string relativePath, int clientPid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (!RootWorkerAliveLocked(clientPid))
            throw new GuardException("NOTICE_PID_NOT_REGISTERED");
        if (activePhase is not null || processIdentityProbeArmed || processIdentityProbed)
            throw new GuardException("ETW_PROCESS_START_KEY_PROBE_STATE_INVALID");
        if (!string.Equals(relativePath, processIdentityProbePath, StringComparison.Ordinal))
            throw new GuardException("ETW_PROCESS_START_KEY_PROBE_PATH_INVALID");
        processIdentityProbeArmed = true;
        return new { ok = true, state = "armed", path = processIdentityProbePath };
    }

    private object VerifyProcessIdentityProbe(string relativePath, int clientPid)
    {
        lock (gate)
        {
            ThrowIfClosed();
            if (failureCode is not null) throw new GuardException(failureCode);
            if (!RootWorkerAliveLocked(clientPid) ||
                !processIdentityProbeArmed ||
                !string.Equals(relativePath, processIdentityProbePath, StringComparison.Ordinal))
            {
                throw new GuardException("ETW_PROCESS_START_KEY_PROBE_STATE_INVALID");
            }
        }
        if (!processIdentityProbeObserved.Wait(ProcessIdentityProbeTimeout))
            throw new GuardException("ETW_PROCESS_START_KEY_PROBE_TIMEOUT");
        lock (gate)
        {
            if (failureCode is not null) throw new GuardException(failureCode);
            if (!processIdentityProbed)
                throw new GuardException("ETW_PROCESS_START_KEY_PROBE_FAILED");
            return new { ok = true, state = "verified", path = processIdentityProbePath };
        }
    }

    private object BeginPhase(string phase, string? workId, string phaseInstanceId)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (!processIdentityProbed)
            throw new GuardException("ETW_PROCESS_START_KEY_PROBE_REQUIRED");
        ValidatePhase(phase, workId);
        if (!string.Equals(workId, WorkId, StringComparison.Ordinal))
            throw new GuardException("PHASE_WORK_MISMATCH");
        if (activePhase is not null) throw new GuardException("PHASE_ALREADY_ACTIVE");
        completedWrites.Clear();
        writeCompletionSeals.Clear();
        writeCompletionReorderQueue.Clear();
        writeCompletionPhaseEventCount = 0;
        writeCompletionReorderActive = false;
        var startedAtUtc = DateTime.UtcNow;
        activePhase = new ActivePhase(
            phase,
            workId,
            phaseInstanceId,
            startedAtUtc,
            Stopwatch.GetTimestamp());
        var free = ReadFreeBytes(root);
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
        phaseRecords.Add(new PhaseRecord(phase, workId, phaseInstanceId, "started",
            new DateTimeOffset(startedAtUtc).ToString("O"), CurrentLiveBytes(), free));
        PersistJournal(closed: false);
        return new { ok = true, phase, workId, phaseInstanceId };
    }

    private object ReserveWrite(
        string phase,
        string? workId,
        string phaseInstanceId,
        int producerPid,
        string path,
        int clientPid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (activePhase is null ||
            activePhase.Phase != "voice" ||
            activePhase.Phase != phase ||
            activePhase.WorkId != workId ||
            activePhase.PhaseInstanceId != phaseInstanceId)
            throw new GuardException("PHASE_MISMATCH");
        if (!RootWorkerAliveLocked(clientPid) || !registeredPids.Contains(clientPid))
            throw new GuardException("NOTICE_PID_NOT_REGISTERED");
        if (pendingWriteLease is not null) throw new GuardException("WRITE_LEASE_ALREADY_ACTIVE");
        var previousSeal = writeCompletionSeals.LastOrDefault();
        if (previousSeal is not null &&
            (previousSeal.State != WriteCompletionDrainState.CompletedRetained ||
             previousSeal.CompletionRequestedAtQpc is null))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        if (TryInspect(path) is not null) throw new GuardException("WRITE_LEASE_PATH_CONFLICT");
        var process = job.OpenContainedProcess(producerPid)
            ?? throw new GuardException("WRITE_LEASE_PRODUCER_NOT_JOB_MEMBER");
        var reservationTransaction = new WriteLeaseReservationTransaction();
        try
        {
            JobObject.ProcessIdentityRecord identity;
            try
            {
                identity = job.ProcessIdentity(process);
            }
            catch (GuardException error)
            {
                throw new GuardException(
                    WriteLeaseProducerBirthFenceRules
                        .NormalizeProcessIdentityGuardFailureCode(error.Code));
            }
            if (identity.ProcessId != producerPid ||
                identity.ProcessStartKey == 0 ||
                identity.ProcessSequenceNumber == 0)
                throw new GuardException(
                    WriteLeaseProducerBirthFenceRules.ProcessIdentityFailureCode);
            var initialPhase = activePhase;
            var birth = WaitForProducerBirthLocked(
                initialPhase,
                phase,
                workId,
                phaseInstanceId,
                path,
                clientPid,
                process,
                identity,
                previousSeal);
            var reservedAtQpc = Stopwatch.GetTimestamp();
            if (initialPhase.StartedAtQpc >= birth.StartedAtQpc ||
                birth.StartedAtQpc > reservedAtQpc)
                throw new GuardException(
                    WriteLeaseProducerBirthFenceRules.TupleMismatchFailureCode);
            reservationTransaction.Publish(
                () => new ObservedProducerBirthSnapshot(
                    true,
                    birth.ProcessSequenceNumber,
                    birth.StartedAtQpc,
                    producerPid,
                    identity.ProcessStartKey,
                    identity.ProcessSequenceNumber,
                    activePhase.PhaseInstanceId,
                    activePhase.StartedAtQpc,
                    reservedAtQpc),
                producerBirthSnapshot => new PendingWriteLease(
                    producerPid,
                    identity.ProcessStartKey,
                    identity.ProcessSequenceNumber,
                    phaseInstanceId,
                    path,
                    reservedAtQpc,
                    process,
                    producerBirthSnapshot),
                lease => pendingWriteLease = lease);
            process = null!;
            return new { ok = true, state = "reserved", path, producerPid };
        }
        catch (GuardException error) when (
            WriteLeaseProducerBirthFenceRules.IsRawFailureCode(error.Code))
        {
            throw reservationTransaction.FenceFailure(error.Code);
        }
        finally
        {
            process?.Dispose();
        }
    }

    private ProcessBirthRecord WaitForProducerBirthLocked(
        ActivePhase initialPhase,
        string phase,
        string? workId,
        string phaseInstanceId,
        string path,
        int clientPid,
        Process process,
        JobObject.ProcessIdentityRecord identity,
        WriteCompletionDrainSeal? previousSeal)
    {
        if (!WriteLeaseProducerBirthFenceRules.TryCreateDeadline(
            Stopwatch.GetTimestamp(),
            Stopwatch.Frequency,
            out var deadlineQpc))
            throw new GuardException(
                WriteLeaseProducerBirthFenceRules.StateChangedFailureCode);
        var entry = ProducerBirthFingerprintLocked(identity.ProcessId);
        while (true)
        {
            ThrowIfProducerBirthWaitAbortedLocked();
            var nowQpc = Stopwatch.GetTimestamp();
            if (WriteLeaseProducerBirthFenceRules.IsDeadlineReached(
                nowQpc,
                deadlineQpc))
                throw new GuardException(
                    WriteLeaseProducerBirthFenceRules.TimeoutFailureCode);
            var current = ProducerBirthFingerprintLocked(identity.ProcessId);
            var decision = WriteLeaseProducerBirthFenceRules.FingerprintDecision(
                entry,
                current,
                identity.ProcessSequenceNumber);
            if (decision == ProducerBirthFingerprintDecision.TupleMismatch)
                throw new GuardException(
                    WriteLeaseProducerBirthFenceRules.TupleMismatchFailureCode);
            RecheckProducerBirthReservationStateLocked(
                initialPhase,
                phase,
                workId,
                phaseInstanceId,
                path,
                clientPid,
                previousSeal);
            RecheckProducerBirthProcessLocked(process, identity);
            if (decision == ProducerBirthFingerprintDecision.Ready)
                return new ProcessBirthRecord(
                    current.ProcessSequenceNumber,
                    current.StartedAtQpc);
            var remainingQpc = checked(deadlineQpc - nowQpc);
            var waitMilliseconds =
                WriteLeaseProducerBirthFenceRules.CeilingWaitMilliseconds(
                    remainingQpc,
                    Stopwatch.Frequency);
            _ = Monitor.Wait(gate, waitMilliseconds);
        }
    }

    private ProducerBirthFingerprint ProducerBirthFingerprintLocked(int pid) =>
        processBirthByPid.TryGetValue(pid, out var birth)
            ? new ProducerBirthFingerprint(
                true,
                birth.ProcessSequenceNumber,
                birth.StartedAtQpc)
            : new ProducerBirthFingerprint(false, 0, 0);

    private void ThrowIfProducerBirthWaitAbortedLocked()
    {
        var abortFailureCode = CapacityGuardLifecycleRules.WaitAbortFailureCode(
            failureCode,
            disposed,
            cancellation.IsCancellationRequested,
            journalClosed,
            WriteLeaseProducerBirthFenceRules.StateChangedFailureCode);
        if (abortFailureCode is not null)
            throw new GuardException(abortFailureCode);
    }

    private void RecheckProducerBirthReservationStateLocked(
        ActivePhase initialPhase,
        string phase,
        string? workId,
        string phaseInstanceId,
        string path,
        int clientPid,
        WriteCompletionDrainSeal? previousSeal)
    {
        if (!ReferenceEquals(activePhase, initialPhase) ||
            initialPhase.Phase != "voice" ||
            initialPhase.Phase != phase ||
            initialPhase.WorkId != workId ||
            initialPhase.PhaseInstanceId != phaseInstanceId ||
            pendingWriteLease is not null ||
            !RootWorkerAliveLocked(clientPid) ||
            !registeredPids.Contains(clientPid) ||
            !ReferenceEquals(writeCompletionSeals.LastOrDefault(), previousSeal) ||
            previousSeal is not null &&
                (previousSeal.State != WriteCompletionDrainState.CompletedRetained ||
                 previousSeal.CompletionRequestedAtQpc is null))
            throw new GuardException(
                WriteLeaseProducerBirthFenceRules.StateChangedFailureCode);
        try
        {
            if (TryInspect(path) is not null)
                throw new GuardException(
                    WriteLeaseProducerBirthFenceRules.StateChangedFailureCode);
        }
        catch (GuardException error) when (
            error.Code != WriteLeaseProducerBirthFenceRules.StateChangedFailureCode)
        {
            throw new GuardException(
                WriteLeaseProducerBirthFenceRules.StateChangedFailureCode);
        }
    }

    private void RecheckProducerBirthProcessLocked(
        Process process,
        JobObject.ProcessIdentityRecord identity)
    {
        JobObject.RetainedProcessInspection inspection;
        try
        {
            inspection = job.InspectRetainedProcess(process);
        }
        catch (GuardException)
        {
            throw new GuardException(
                WriteLeaseProducerBirthFenceRules.ProcessIdentityFailureCode);
        }
        if (inspection.ProcessId != identity.ProcessId ||
            inspection.ProcessStartKey != identity.ProcessStartKey ||
            inspection.ProcessSequenceNumber != identity.ProcessSequenceNumber ||
            inspection.Signaled || !inspection.JobMember)
            throw new GuardException(
                WriteLeaseProducerBirthFenceRules.ProcessIdentityFailureCode);
    }

    private object PrepareWriteRename(
        string phase,
        string? workId,
        string phaseInstanceId,
        int producerPid,
        string from,
        string to,
        int clientPid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        var phaseMatches = activePhase is not null &&
            activePhase.Phase == "voice" &&
            activePhase.Phase == phase &&
            activePhase.WorkId == workId &&
            activePhase.PhaseInstanceId == phaseInstanceId;
        var rootAuthenticated =
            RootWorkerAliveLocked(clientPid) && registeredPids.Contains(clientPid);
        var lease = pendingWriteLease;
        var tupleMatches = lease is not null &&
            lease.WorkerPid == producerPid &&
            lease.PhaseInstanceId == phaseInstanceId &&
            lease.RelativePath == from;
        // CHG-F005-072: ETW由来のFileObject/Snapshotは相関を待たない契約では埋まらない。
        // rename可否の判定入力から外す（最終状態はphase後の実測で検証する）。
        var correlationReady = lease is not null && !lease.FileObjectClosed;
        var processSignaled = lease is null || job.IsSignaled(lease.Process);
        var processAliveOutsideJob =
            lease is not null && !processSignaled && job.IsAliveOutsideJob(lease.Process);
        var targetExists = TryInspect(to) is not null;
        if (!SystemSetInfoCorrelationRules.CanPrepareRename(
            phaseMatches,
            rootAuthenticated,
            tupleMatches,
            lease?.PendingRenamePath is not null,
            correlationReady,
            processSignaled,
            processAliveOutsideJob,
            targetExists))
        {
            if (!phaseMatches)
            throw new GuardException("PHASE_MISMATCH");
            if (!rootAuthenticated)
            throw new GuardException("NOTICE_PID_NOT_REGISTERED");
            // CHG-F005-072: tuple不一致の内訳を一度だけ固定分割し、
            // lease解放時刻の変化かpath不一致かを確定する。
            if (lease is null)
                throw new GuardException("WRITE_LEASE_TUPLE_LEASE_ABSENT");
            if (lease.WorkerPid != producerPid)
                throw new GuardException("WRITE_LEASE_TUPLE_PID_MISMATCH");
            if (lease.PhaseInstanceId != phaseInstanceId)
                throw new GuardException("WRITE_LEASE_TUPLE_PHASE_MISMATCH");
            if (lease.RelativePath != from)
                throw new GuardException("WRITE_LEASE_TUPLE_PATH_MISMATCH");
            if (!tupleMatches)
                throw new GuardException("WRITE_LEASE_TUPLE_MISMATCH");
            if (lease.PendingRenamePath is not null)
            throw new GuardException("WRITE_LEASE_RENAME_ALREADY_PREPARED");
            // CHG-F005-072: ETW相関の完了は要求しない。最終状態はphase後の実測で検証する。
            if (processSignaled || processAliveOutsideJob)
            throw new GuardException("WRITE_LEASE_PRODUCER_NOT_JOB_MEMBER");
            if (targetExists)
            throw new GuardException("WRITE_LEASE_PATH_CONFLICT");
            throw new GuardException("WRITE_LEASE_TUPLE_MISMATCH");
        }
        lease = pendingWriteLease!;
        lease.PendingRenamePath = to;
        lease.RenameReservedAtQpc = Stopwatch.GetTimestamp();
        return new { ok = true, state = "rename-prepared", from, to, producerPid };
    }

    private object CompleteWriteAfterEtwDrain(
        string phase,
        string? workId,
        string phaseInstanceId,
        int producerPid,
        string path,
        int clientPid)
    {
        lock (gate)
        {
            ThrowIfClosed();
            if (failureCode is not null) throw new GuardException(failureCode);
            if (activePhase is null ||
                activePhase.Phase != phase ||
                activePhase.WorkId != workId ||
                activePhase.PhaseInstanceId != phaseInstanceId)
                throw new GuardException("PHASE_MISMATCH");
            if (!RootWorkerAliveLocked(clientPid) || !registeredPids.Contains(clientPid))
                throw new GuardException("NOTICE_PID_NOT_REGISTERED");
            RequestWriteCompletionLocked(
                producerPid, phaseInstanceId, path, Stopwatch.GetTimestamp());
        }
        try
        {
            while (true)
            {
                WriteCompletionDrainSeal seal;
                lock (gate)
                {
                    seal = FindCompletionSealLocked(
                        producerPid, phaseInstanceId, path);
                    EnsureWriteCompletionDeadlineLocked(seal, Stopwatch.GetTimestamp());
                }
                etwSession.Flush();
                var before = Interlocked.Read(ref etwRelevantEventCount);
                var accountedBefore = Interlocked.Read(ref etwAccountedEventCount);
                Thread.Sleep(50);
                if (Interlocked.Read(ref etwRelevantEventCount) != before ||
                    Interlocked.Read(ref etwAccountedEventCount) != accountedBefore) continue;
                etwSession.Flush();
                Thread.Sleep(50);
                if (WriteCompletionDrainRules.CountersStable(
                    before,
                    accountedBefore,
                    Interlocked.Read(ref etwRelevantEventCount),
                    Interlocked.Read(ref etwAccountedEventCount)))
                {
                    using (callbackAdmission.EnterFinal())
                    {
                        lock (gate)
                        {
                            var completed = CompleteWrite(
                                producerPid,
                                phaseInstanceId,
                                path,
                                before,
                                accountedBefore);
                            if (completed is not null) return completed;
                        }
                    }
                }
            }
        }
        catch (GuardException)
        {
            throw;
        }
        catch
        {
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
        }
    }

    // @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    private object PrepareWriteCompletion(
        string phase,
        string? workId,
        string phaseInstanceId,
        int producerPid,
        string path,
        int clientPid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (writeCompletionSeals.Count >= MaxWriteCompletionSeals)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        if (writeCompletionSeals.Any(item => item.State is
            WriteCompletionDrainState.Prepared or
            WriteCompletionDrainState.CompletionRequested))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        var lease = pendingWriteLease;
        var active = activePhase;
        if (!WriteCompletionDrainRules.PrepareTupleMatches(
            active is not null,
            lease is not null,
            active?.Phase == "voice",
            active?.Phase == phase,
            active?.WorkId == workId,
            active?.PhaseInstanceId == phaseInstanceId,
            lease?.PhaseInstanceId == phaseInstanceId,
            lease?.WorkerPid == producerPid,
            lease?.RelativePath == path,
            lease?.FileObjectClosed == false,
            lease?.PendingRenamePath is null &&
                lease?.RenameReservedAtQpc is null,
            RootWorkerAliveLocked(clientPid) && registeredPids.Contains(clientPid)))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        // CHG-F005-072: 以降のseal/drainはETW由来のSnapshot・FileObject・
        // filesByObject binding・observationsを前提とする。相関を待たない契約では
        // これらが埋まらないため、非ETWのtuple検証だけでleaseを解放して完了する。
        // 最終状態の健全性はphase後の実測差分で証明する。
        {
            var declaredLease = pendingWriteLease!;
            if (CompletedWriteDiagnosticRules.ShouldTrack(
                activePhase?.Phase,
                completedWrites.Count,
                completedWrites.ContainsKey(path)))
                completedWrites[path] = new CompletedWriteRecord(
                    declaredLease.WorkerPid,
                    declaredLease.ProcessSequenceNumber,
                    declaredLease.PhaseInstanceId,
                    declaredLease.CurrentPathReservedAtQpc,
                    Stopwatch.GetTimestamp(),
                    declaredLease.Snapshot?.Identity ?? "");
            pendingWriteLease = null;
            writeCompletionReorderActive = false;
            PersistJournal(closed: false);
            return new { ok = true, state = "completed", path, producerPid };
        }
#pragma warning disable CS0162
        lease = pendingWriteLease!;
        active = activePhase!;
        var slash = path.LastIndexOf('/');
        if (slash <= 0 || lease.Snapshot is null || lease.FileObject is null)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        var parent = path[..slash];
        FileSnapshot? current;
        FileSnapshot? directoryCurrent;
        try
        {
            current = TryInspect(path);
            directoryCurrent = TryInspect(parent);
        }
        catch (GuardException)
        {
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        }
        var directorySnapshot = filesByPath.GetValueOrDefault(parent);
        var binding = filesByObject.GetValueOrDefault(lease.FileObject.Value);
        var directoryOwner = observations.LastOrDefault(item =>
            item.EventName == "create" &&
            item.Path == parent &&
            item.Phase == active.Phase &&
            item.WorkId == active.WorkId &&
            item.PhaseInstanceId == active.PhaseInstanceId &&
            item.WorkerPid == rootWorkerPid &&
            item.ProducerSequenceNumber == rootWorkerSequenceNumber &&
            item.VolumeId == directorySnapshot?.VolumeId &&
            item.FileId128 == directorySnapshot?.FileId128);
        if (current?.Identity != lease.Snapshot.Identity ||
            directorySnapshot is null ||
            directoryCurrent?.Identity != directorySnapshot.Identity ||
            binding?.RelativePath != path ||
            binding.Identity != lease.Snapshot.Identity ||
            directoryOwner is null)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        if (rootWorkerProcess is null || rootWorkerPid is null ||
            rootWorkerStartKey is null || rootWorkerSequenceNumber is null)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        JobObject.RetainedProcessInspection rootInspection;
        try { rootInspection = job.InspectRetainedProcess(rootWorkerProcess); }
        catch (GuardException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        }
        if (!WriteCompletionDrainRules.PrepareTupleMatches(
            rootInspection.ProcessId == rootWorkerPid.Value,
            rootInspection.ProcessStartKey == rootWorkerStartKey.Value,
            rootInspection.ProcessSequenceNumber == rootWorkerSequenceNumber.Value,
            !rootInspection.Signaled,
            rootInspection.JobMember))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_PREPARE_TUPLE_MISMATCH");
        JobObject.RetainedProcessInspection inspection;
        try { inspection = job.InspectRetainedProcess(lease.Process); }
        catch (GuardException error)
        {
            throw new GuardException(
                WriteCompletionDrainRules.ProcessFailureCode(error.Code, false));
        }
        var processFailure = WriteCompletionDrainRules.ProcessRejection(
            inspection.ProcessId == lease.WorkerPid &&
            inspection.ProcessStartKey == lease.ProcessStartKey &&
            inspection.ProcessSequenceNumber == lease.ProcessSequenceNumber,
            inspection.Signaled,
            inspection.JobMember,
            false);
        if (processFailure is not null) throw new GuardException(processFailure);
        var preparedAtQpc = Stopwatch.GetTimestamp();
        long deadline;
        try { deadline = checked(preparedAtQpc + Stopwatch.Frequency * 10L); }
        catch (OverflowException)
        {
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT");
        }
        var previous = writeCompletionSeals.LastOrDefault();
        if (previous?.CompletionRequestedAtQpc is long previousUpper &&
            lease.CurrentPathReservedAtQpc <= previousUpper)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        EnsureWriteCompletionLedgerLocked();
        var exactGeneration = writeCompletionBindingLedger!.ExactGeneration(
            lease.FileObject.Value,
            lease.Snapshot.Identity,
            path) ?? throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        RetainedFileIdentityLease? retainedCurrent = null;
        RetainedFileIdentityLease? retainedParent = null;
        WriteCompletionDrainSeal seal;
        try
        {
            retainedCurrent = RetainIdentity(path, lease.Snapshot.Identity);
            retainedParent = RetainIdentity(parent, directorySnapshot.Identity);
            seal = new WriteCompletionDrainSeal(
                checked(++writeCompletionSealSequence), active, lease, path, parent,
                lease.Snapshot.Identity, directorySnapshot.Identity,
                lease.FileObject.Value, exactGeneration,
                lease.WorkerPid, lease.ProcessStartKey,
                lease.ProcessSequenceNumber, lease.CurrentPathReservedAtQpc,
                preparedAtQpc, deadline,
                Interlocked.Read(ref etwRelevantEventCount),
                retainedCurrent,
                retainedParent);
            retainedCurrent = null;
            retainedParent = null;
        }
        finally
        {
            retainedCurrent?.Dispose();
            retainedParent?.Dispose();
        }
        writeCompletionSeals.Add(seal);
        return new {
            ok = true,
            state = "completion-drain-prepared",
            sealSequence = seal.SealSequence,
        };
    }

    private WriteCompletionDrainSeal RequestWriteCompletionLocked(
        int producerPid, string phaseInstanceId, string path, long now)
    {
        var seal = FindCompletionSealLocked(producerPid, phaseInstanceId, path);
        if (seal.State != WriteCompletionDrainState.Prepared)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        EnsureWriteCompletionDeadlineLocked(seal, now);
        long deadline;
        try { deadline = checked(now + Stopwatch.Frequency * 10L); }
        catch (OverflowException)
        {
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT");
        }
        seal.CompletionRequestedAtQpc = now;
        seal.DrainDeadlineQpc = deadline;
        TransitionWriteCompletionSealLocked(
            seal,
            WriteCompletionDrainState.Prepared,
            WriteCompletionDrainState.CompletionRequested);
        return seal;
    }

    private WriteCompletionDrainSeal FindCompletionSealLocked(
        int producerPid, string phaseInstanceId, string path) =>
        writeCompletionSeals.LastOrDefault(item =>
            item.ProducerPid == producerPid &&
            item.Phase.PhaseInstanceId == phaseInstanceId &&
            item.CurrentPath == path)
        ?? throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");

    private static void EnsureWriteCompletionDeadlineLocked(
        WriteCompletionDrainSeal seal, long now)
    {
        var deadline = seal.State switch {
            WriteCompletionDrainState.Prepared => seal.PreparedDeadlineQpc,
            WriteCompletionDrainState.CompletionRequested =>
                seal.DrainDeadlineQpc ?? long.MinValue,
            _ => long.MaxValue,
        };
        if (!WriteCompletionDrainRules.IsDeadlineValid(now, deadline))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT");
    }

    private void EnsureActiveWriteCompletionDeadlineLocked(long now)
    {
        foreach (var seal in writeCompletionSeals.Where(item => item.State is
            WriteCompletionDrainState.Prepared or
            WriteCompletionDrainState.CompletionRequested))
            EnsureWriteCompletionDeadlineLocked(seal, now);
    }

    private static void TransitionWriteCompletionSealLocked(
        WriteCompletionDrainSeal seal,
        WriteCompletionDrainState expected,
        WriteCompletionDrainState next)
    {
        static string Name(WriteCompletionDrainState state) => state switch {
            WriteCompletionDrainState.Prepared => "prepared",
            WriteCompletionDrainState.CompletionRequested => "completion-requested",
            WriteCompletionDrainState.CompletedRetained => "completed-retained",
            WriteCompletionDrainState.Released => "released",
            _ => "invalid",
        };
        if (seal.State != expected ||
            !WriteCompletionDrainRules.CanTransition(Name(expected), Name(next)))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        seal.State = next;
    }

    private object? CompleteWrite(
        int producerPid,
        string phaseInstanceId,
        string path,
        long expectedRelevant,
        long expectedAccounted)
    {
        var seal = FindCompletionSealLocked(producerPid, phaseInstanceId, path);
        if (seal.State != WriteCompletionDrainState.CompletionRequested ||
            !ReferenceEquals(seal.Phase, activePhase) ||
            !ReferenceEquals(seal.Lease, pendingWriteLease))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        var lease = seal.Lease;
        if (lease.WorkerPid != producerPid ||
            lease.PhaseInstanceId != phaseInstanceId ||
            lease.RelativePath != path)
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        if (!WriteCompletionDrainRules.CountersStable(
            expectedRelevant,
            expectedAccounted,
            Interlocked.Read(ref etwRelevantEventCount),
            Interlocked.Read(ref etwAccountedEventCount)))
            return null;
        if (Interlocked.Read(ref writeCompletionCleanupRelevantCount) !=
            Interlocked.Read(ref writeCompletionCleanupAccountedCount))
            return null;
        EnsureWriteCompletionDeadlineLocked(seal, Stopwatch.GetTimestamp());
        if (ReplayWriteCompletionQueueLocked()) return null;
        if (writeCompletionBindingLedger is null ||
            !writeCompletionBindingLedger.IsConverged ||
            !writeCompletionBindingLedger.MatchesGeneration(
                seal.LeaseFileObject,
                seal.LeaseFileObjectGeneration,
                seal.CurrentIdentity,
                seal.CurrentPath))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        try { seal.RetainedParent.Reinspect(seal.DirectoryIdentity); }
        catch (GuardException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_DIRECTORY_IDENTITY_MISMATCH");
        }
        try { seal.RetainedCurrent.Reinspect(seal.CurrentIdentity); }
        catch (GuardException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_CURRENT_IDENTITY_MISMATCH");
        }
        JobObject.RetainedProcessInspection inspection;
        try { inspection = job.InspectRetainedProcess(lease.Process); }
        catch (GuardException error)
        {
            throw new GuardException(
                WriteCompletionDrainRules.ProcessFailureCode(error.Code, true));
        }
        if (inspection.ProcessId != seal.ProducerPid ||
            inspection.ProcessStartKey != seal.ProcessStartKey ||
            inspection.ProcessSequenceNumber != seal.ProcessSequenceNumber)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH");
        if (!inspection.Signaled)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED");
        if (!WriteCompletionDrainRules.CanMutateFinalState(
            callbackAdmission.IsFinalHeld,
            callbackAdmission.ActiveCallbackCount,
            writeCompletionReorderQueue.Count == 0,
            WriteCompletionDrainRules.CountersStable(
                expectedRelevant,
                expectedAccounted,
                Interlocked.Read(ref etwRelevantEventCount),
                Interlocked.Read(ref etwAccountedEventCount))))
            return null;
        if (CompletedWriteDiagnosticRules.ShouldTrack(
            activePhase?.Phase,
            completedWrites.Count,
            completedWrites.ContainsKey(path)))
            completedWrites[path] = new CompletedWriteRecord(
                lease.WorkerPid,
                lease.ProcessSequenceNumber,
                lease.PhaseInstanceId,
                lease.CurrentPathReservedAtQpc,
                Stopwatch.GetTimestamp(),
                seal.CurrentIdentity);
        TransitionWriteCompletionSealLocked(
            seal,
            WriteCompletionDrainState.CompletionRequested,
            WriteCompletionDrainState.CompletedRetained);
        pendingWriteLease = null;
        writeCompletionReorderActive = false;
        return new { ok = true, state = "completed", path, producerPid };
#pragma warning restore CS0162
    }

    private bool ReplayWriteCompletionQueueLocked()
    {
        return writeCompletionReplayStore.Replay(
            snapshot => snapshot.BindingProof,
            cleanup => cleanup.BindingProof,
            PreflightCallbackSnapshotLocked,
            PreflightCapacityBatchLocked,
            CaptureCompletionSemanticCheckpointLocked,
            ApplyPreflightedCallbackSnapshotLocked,
            cleanup => ApplyCleanupSemanticLocked(
                cleanup.FileObject,
                transactional: true),
            RestoreCompletionSemanticCheckpointLocked);
    }

    private void PreflightCallbackSnapshotLocked(PendingCallbackSnapshot snapshot)
    {
        if (!ReferenceEquals(activePhase, snapshot.Phase) ||
            snapshot.BindingProof is null)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        if (snapshot.SealSequence is not null)
            RecheckSealedCallbackLocked(snapshot);
        else
        {
            var key = (snapshot.BindingProof.FileObject,
                snapshot.BindingProof.GenerationAfter);
            if (!writeCompletionGenerationHandles.TryGetValue(key, out var retained))
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
            retained.Reinspect(snapshot.Effective.Identity);
        }
        PreflightImmutableRejoinLocked(snapshot);
        if (snapshot.DeferredRename is not null)
            PreflightRenameSnapshotLocked(snapshot);
        try
        {
            var oldAllocated = allocatedByIdentity.GetValueOrDefault(
                snapshot.Effective.Identity);
            var newAllocated = snapshot.EventName == "delete"
                ? 0
                : snapshot.Effective.AllocatedLengthBytes;
            _ = checked(newAllocated - oldAllocated);
            _ = checked(CurrentLiveBytes() - oldAllocated + newAllocated);
        }
        catch (OverflowException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
        }
    }

    private void PreflightImmutableRejoinLocked(PendingCallbackSnapshot snapshot)
    {
        if (!WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(
            snapshot.AfterLeaseDirectoryRejoin is not null,
            snapshot.BoundLeaseDirectoryRejoin is not null,
            snapshot.CompletedNoLeaseDirectoryRejoin is not null))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        var proof = snapshot.BindingProof!;
        if (snapshot.AfterLeaseDirectoryRejoin is { } afterLease)
        {
            if (!ReferenceEquals(afterLease.Phase, snapshot.Phase) ||
                afterLease.EventFileObject != snapshot.FileObject ||
                afterLease.DirectoryPath != snapshot.NormalizedPath ||
                afterLease.DirectoryIdentity != snapshot.Effective.Identity ||
                proof.Kind != WriteCompletionBindingKind.OtherBound ||
                proof.FileObject != afterLease.EventFileObject ||
                proof.Identity != afterLease.DirectoryIdentity ||
                proof.Path != afterLease.DirectoryPath ||
                proof.StateAfter != WriteCompletionBindingState.Bound ||
                snapshot.ProducerPid != afterLease.ProducerPid ||
                snapshot.ProducerSequenceNumber !=
                    afterLease.ProducerSequenceNumber ||
                !AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules
                    .IsCandidateTimestamp(
                        snapshot.TimestampQpc,
                        afterLease.LeaseReservedAtQpc,
                        afterLease.RenameReservedAtQpc))
                throw new GuardException(
                    "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_BINDING_MISMATCH");
            var processFailure =
                RecheckAfterLeaseDirectoryProcessLocked(afterLease);
            if (processFailure is not null)
                throw new GuardException(processFailure);
        }
        if (snapshot.BoundLeaseDirectoryRejoin is { } boundLease)
        {
            var immutableTupleMatches =
                ReferenceEquals(boundLease.Phase, snapshot.Phase) &&
                boundLease.EventFileObject == snapshot.FileObject &&
                boundLease.DirectoryPath == snapshot.NormalizedPath &&
                boundLease.DirectoryIdentity == snapshot.Effective.Identity &&
                proof.Kind == WriteCompletionBindingKind.OtherBound &&
                proof.FileObject == boundLease.EventFileObject &&
                proof.Identity == boundLease.DirectoryIdentity &&
                proof.Path == boundLease.DirectoryPath &&
                proof.StateAfter == WriteCompletionBindingState.Bound &&
                snapshot.ProducerPid == boundLease.ProducerPid &&
                snapshot.ProducerSequenceNumber ==
                    boundLease.ProducerSequenceNumber &&
                SystemDirectoryBoundLeaseRejoinAuthorizationRules
                    .IsQpcOrderValid(
                        boundLease.PhaseStartedAtQpc,
                        boundLease.LeaseReservedAtQpc,
                        snapshot.TimestampQpc);
            var tupleFailure = SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .TupleRecheckFailure(
                    immutableTupleMatches,
                    immutableTupleMatches,
                    immutableTupleMatches,
                    immutableTupleMatches,
                    immutableTupleMatches,
                    immutableTupleMatches);
            if (tupleFailure is not null) throw new GuardException(tupleFailure);
            var processFailure = RecheckBoundLeaseDirectoryProcessLocked(boundLease);
            if (processFailure is not null) throw new GuardException(processFailure);
        }
        if (snapshot.CompletedNoLeaseDirectoryRejoin is { } completedNoLease)
            RecheckCompletedNoLeaseDirectoryProofLocked(
                snapshot,
                completedNoLease);
    }

    private void PreflightRenameSnapshotLocked(
        PendingCallbackSnapshot snapshot)
    {
        var deferred = snapshot.DeferredRename!;
        if (snapshot.Current is not null &&
            snapshot.Current.Identity != deferred.Source.Identity)
            throw new GuardException("ETW_RENAME_IDENTITY_MISMATCH");
        var pendingRename = notices.FirstOrDefault(item =>
            item.State == "pending" &&
            item.WorkerPid == deferred.WorkerPid &&
            item.ProducerSequenceNumber == deferred.ProducerSequenceNumber &&
            item.PhaseInstanceId == deferred.PhaseInstanceId &&
            item.EventName == "rename" &&
            item.From == deferred.Source.RelativePath &&
            (deferred.ObservedTarget is null ||
                item.To == deferred.ObservedTarget));
        if (pendingRename is not null &&
            (snapshot.Current is null ||
                snapshot.Current.RelativePath != pendingRename.To ||
                snapshot.Current.Identity != deferred.Source.Identity))
            throw new GuardException("ETW_RENAME_IDENTITY_MISMATCH");
        _ = checked(snapshot.Effective.AllocatedLengthBytes -
            deferred.Source.AllocatedLengthBytes);
    }

    private void PreflightCapacityBatchLocked(
        IReadOnlyList<PendingCallbackSnapshot> snapshots)
    {
        var shadow = new Dictionary<string, long>(
            allocatedByIdentity,
            StringComparer.Ordinal);
        try
        {
            long live = 0;
            foreach (var value in shadow.Values) live = checked(live + value);
            foreach (var snapshot in snapshots)
            {
                var oldAllocated = shadow.GetValueOrDefault(
                    snapshot.Effective.Identity);
                var newAllocated = snapshot.EventName == "delete"
                    ? 0
                    : snapshot.Effective.AllocatedLengthBytes;
                _ = checked(newAllocated - oldAllocated);
                live = checked(live - oldAllocated + newAllocated);
                if (newAllocated == 0)
                    shadow.Remove(snapshot.Effective.Identity);
                else
                    shadow[snapshot.Effective.Identity] = newAllocated;
            }
        }
        catch (OverflowException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
        }
    }

    private PendingWriteLease ValidateWriteLeaseTuple(
        int producerPid,
        string phaseInstanceId,
        string path)
    {
        var lease = pendingWriteLease;
        // CHG-F005-072: 内訳を固定分割して原因を一意にする。
        if (lease is null)
            throw new GuardException("WRITE_LEASE_VALIDATE_LEASE_ABSENT");
        if (lease.WorkerPid != producerPid)
            throw new GuardException("WRITE_LEASE_VALIDATE_PID_MISMATCH");
        if (lease.PhaseInstanceId != phaseInstanceId)
            throw new GuardException("WRITE_LEASE_VALIDATE_PHASE_MISMATCH");
        if (lease.RelativePath != path)
            throw new GuardException("WRITE_LEASE_VALIDATE_PATH_MISMATCH");
        return lease;
    }

    private object ReceiveNotice(JsonElement rootElement, int clientPid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (activePhase is null) throw new GuardException("PHASE_NOT_ACTIVE");
        if (!RootWorkerAliveLocked(clientPid) || !registeredPids.Contains(clientPid))
            throw new GuardException("NOTICE_PID_NOT_REGISTERED");
        var producerPid = PipePositiveInt(rootElement, "producerPid");
        ulong producerSequenceNumber;
        if (producerPid != clientPid)
        {
            using var producerProcess = job.OpenContainedProcess(producerPid);
            if (producerProcess is null)
                throw new GuardException("NOTICE_PRODUCER_NOT_JOB_MEMBER");
            try
            {
                producerSequenceNumber = job.ProcessIdentity(producerProcess).ProcessSequenceNumber;
            }
            catch
            {
                throw new GuardException("NOTICE_PRODUCER_IDENTITY_UNAVAILABLE");
            }
        }
        else
        {
            producerSequenceNumber = rootWorkerSequenceNumber
                ?? throw new GuardException("NOTICE_PRODUCER_IDENTITY_UNAVAILABLE");
        }
        var noticeId = PipeSha256(rootElement, "noticeId");
        if (notices.Any(item => item.NoticeId == noticeId)) throw new GuardException("NOTICE_REPLAY");
        var phase = PipeString(rootElement, "phase");
        var workId = PipeNullableWorkId(rootElement, "workId");
        var phaseInstanceId = PipeSha256(rootElement, "phaseInstanceId");
        if (phase != activePhase.Phase || workId != activePhase.WorkId ||
            phaseInstanceId != activePhase.PhaseInstanceId)
        {
            throw new GuardException("NOTICE_PHASE_MISMATCH");
        }
        var eventName = PipeString(rootElement, "event");
        if (eventName is not ("create" or "write" or "setinfo" or "rename" or "delete"))
            throw new GuardException("NOTICE_EVENT_INVALID");
        string? path = null;
        string? from = null;
        string? to = null;
        if (eventName == "rename")
        {
            from = ValidateRelativePath(PipeString(rootElement, "from"));
            to = ValidateRelativePath(PipeString(rootElement, "to"));
        }
        else
        {
            path = ValidateRelativePath(PipeString(rootElement, "path"));
        }
        var record = new NoticeRecord(
            SessionNonce,
            checked(++noticeSequence),
            producerPid,
            producerSequenceNumber,
            phase,
            workId,
            phaseInstanceId,
            noticeId,
            eventName,
            path,
            from,
            to);
        var floor = DateTimeOffset.UtcNow - ObservationMatchWindow;
        if (eventName == "rename")
        {
            var deferred = deferredRenames.LastOrDefault(item =>
                item.WorkerPid == producerPid &&
                item.ProducerSequenceNumber == producerSequenceNumber &&
                item.Phase == phase &&
                item.PhaseInstanceId == phaseInstanceId &&
                item.ObservedAtValue >= floor &&
                item.Source.RelativePath == from &&
                (item.ObservedTarget is null || item.ObservedTarget == to));
            if (deferred is not null)
                CompleteDeferredRename(deferred, record);
        }
        if (record.State != "matched")
        {
            var match = observations.LastOrDefault(item =>
                item.NoticeSequence is null &&
                item.WorkerPid == producerPid &&
                item.ProducerSequenceNumber == producerSequenceNumber &&
                item.Phase == phase &&
                item.PhaseInstanceId == phaseInstanceId &&
                item.ObservedAtValue >= floor &&
                item.Matches(eventName, path, from, to));
            if (match is not null)
            {
                record.Match(match.EtwSequence);
                match.NoticeSequence = record.NoticeSequence;
            }
        }
        notices.Add(record);
        PersistJournal(closed: false);
        // CHG-F005-072: 共有hosted runnerではSystem(PID 4)の遅延書き戻しなど
        // 帰属不能なカーネルeventが尽きず、全event帰属を要求する常時監視は収束しない。
        // 宣言はここで受理し、書込み健全性はphase前後の実測差分で証明する。
        if (record.State != "matched") record.Declare();
        if (pendingWriteLease is { } writeLease &&
            writeLease.WorkerPid == record.WorkerPid &&
            writeLease.ProcessSequenceNumber == record.ProducerSequenceNumber &&
            writeLease.PhaseInstanceId == record.PhaseInstanceId)
        {
            // CHG-F005-072: create宣言時点でETW由来のFileObject/Snapshotを要求しない。
            if (record.EventName == "rename")
            {
                if (!SystemSetInfoCorrelationRules.TryConsumeRename(
                    record.From ?? "",
                    record.To ?? "",
                    writeLease.RelativePath,
                    writeLease.PendingRenamePath,
                    writeLease.RenameReservedAtQpc,
                    out var promotedReservationQpc))
                    throw new GuardException("ETW_SYSTEM_SETINFO_CORRELATION_RENAME_CONSUME");
                writeLease.RelativePath = record.To!;
                writeLease.CurrentPathReservedAtQpc = promotedReservationQpc;
                writeLease.PendingRenamePath = null;
                writeLease.RenameReservedAtQpc = null;
            }
        }
        return new {
            ok = true,
            noticeSequence = record.NoticeSequence,
            state = record.State,
            observationSequences = record.ObservationSequences,
        };
    }

    private object? EndPhase(
        string phase,
        string phaseInstanceId,
        long expectedRelevant,
        long expectedAccounted)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (activePhase is null ||
            activePhase.Phase != phase ||
            activePhase.PhaseInstanceId != phaseInstanceId)
        {
            throw new GuardException("PHASE_MISMATCH");
        }
        if (!WriteCompletionDrainRules.CountersStable(
            expectedRelevant,
            expectedAccounted,
            Interlocked.Read(ref etwRelevantEventCount),
            Interlocked.Read(ref etwAccountedEventCount)))
            return null;
        if (Interlocked.Read(ref etwRelevantEventCount) !=
            Interlocked.Read(ref etwAccountedEventCount))
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
        if (Interlocked.Read(ref writeCompletionCleanupRelevantCount) !=
            Interlocked.Read(ref writeCompletionCleanupAccountedCount))
            return null;
        EnsureActiveWriteCompletionDeadlineLocked(Stopwatch.GetTimestamp());
        if (ReplayWriteCompletionQueueLocked()) return null;
        if (!WriteCompletionDrainRules.CanMutateFinalState(
            callbackAdmission.IsFinalHeld,
            callbackAdmission.ActiveCallbackCount,
            writeCompletionReorderQueue.Count == 0,
            WriteCompletionDrainRules.CountersStable(
                expectedRelevant,
                expectedAccounted,
                Interlocked.Read(ref etwRelevantEventCount),
                Interlocked.Read(ref etwAccountedEventCount))))
            return null;
        // CHG-F005-072: noticeはdeclaredで受理される。ETW相関の完了は要求しない。
        if (notices.Any(item =>
            item.PhaseInstanceId == phaseInstanceId &&
            item.State != "matched" && item.State != "declared"))
        {
            throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
        }
        foreach (var seal in writeCompletionSeals)
        {
            if (seal.State != WriteCompletionDrainState.CompletedRetained)
                continue;
            if (writeCompletionBindingLedger is null ||
                !writeCompletionBindingLedger.IsConverged ||
                !writeCompletionBindingLedger.MatchesGeneration(
                    seal.LeaseFileObject,
                    seal.LeaseFileObjectGeneration,
                    seal.CurrentIdentity,
                    seal.CurrentPath))
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
            try { seal.RetainedParent.Reinspect(seal.DirectoryIdentity); }
            catch (GuardException)
            {
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_DIRECTORY_IDENTITY_MISMATCH");
            }
            try { seal.RetainedCurrent.Reinspect(seal.CurrentIdentity); }
            catch (GuardException)
            {
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_CURRENT_IDENTITY_MISMATCH");
            }
            JobObject.RetainedProcessInspection inspection;
            try { inspection = job.InspectRetainedProcess(seal.Lease.Process); }
            catch (GuardException error)
            {
                throw new GuardException(
                    WriteCompletionDrainRules.ProcessFailureCode(error.Code, true));
            }
            if (inspection.ProcessId != seal.ProducerPid ||
                inspection.ProcessStartKey != seal.ProcessStartKey ||
                inspection.ProcessSequenceNumber != seal.ProcessSequenceNumber)
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH");
            if (!inspection.Signaled)
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED");
        }
        // CHG-F005-072: 未解決write leaseは維持し、帰属不能なdeferred System eventは外す。
        if (pendingWriteLease?.PhaseInstanceId == phaseInstanceId)
            throw new GuardException("WRITE_LEASE_CORRELATION_MISSING");
        AssertRegisteredProcessesContained();
        var free = ReadFreeBytes(root);
        var live = CurrentLiveBytes();
        foreach (var seal in writeCompletionSeals)
        {
            TransitionWriteCompletionSealLocked(
                seal,
                WriteCompletionDrainState.CompletedRetained,
                WriteCompletionDrainState.Released);
            seal.Lease.Process.Dispose();
            seal.Dispose();
        }
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
        phaseRecords.Add(new PhaseRecord(phase, activePhase.WorkId, phaseInstanceId, "finished",
            DateTimeOffset.UtcNow.ToString("O"), live, free));
        activePhase = null;
        completedWrites.Clear();
        writeCompletionSeals.Clear();
        writeCompletionReplayStore.ClearEvidence();
        writeCompletionCleanupRelevantCount = 0;
        writeCompletionCleanupAccountedCount = 0;
        writeCompletionReorderActive = false;
        PersistJournal(closed: false);
        return new { ok = true, phase, phaseInstanceId };
    }

    private object EndPhaseAfterEtwDrain(string phase, string phaseInstanceId)
    {
        lock (gate)
        {
            ThrowIfClosed();
            if (failureCode is not null) throw new GuardException(failureCode);
            if (activePhase is null ||
                activePhase.Phase != phase ||
                activePhase.PhaseInstanceId != phaseInstanceId)
            {
                throw new GuardException("PHASE_MISMATCH");
            }
            EnsureActiveWriteCompletionDeadlineLocked(
                Stopwatch.GetTimestamp());
        }
        try
        {
            var drain = Stopwatch.StartNew();
            while (drain.Elapsed < TimeSpan.FromSeconds(2))
            {
                lock (gate)
                    EnsureActiveWriteCompletionDeadlineLocked(
                        Stopwatch.GetTimestamp());
                etwSession.Flush();
                var before = Interlocked.Read(ref etwRelevantEventCount);
                var accountedBefore = Interlocked.Read(ref etwAccountedEventCount);
                Thread.Sleep(100);
                if (Interlocked.Read(ref etwRelevantEventCount) != before ||
                    Interlocked.Read(ref etwAccountedEventCount) != accountedBefore)
                    continue;
                etwSession.Flush();
                Thread.Sleep(100);
                if (WriteCompletionDrainRules.CountersStable(
                    before,
                    accountedBefore,
                    Interlocked.Read(ref etwRelevantEventCount),
                    Interlocked.Read(ref etwAccountedEventCount)))
                {
                    using (callbackAdmission.EnterFinal())
                    {
                        lock (gate)
                        {
                            EnsureActiveWriteCompletionDeadlineLocked(
                                Stopwatch.GetTimestamp());
                            var ended = EndPhase(
                                phase,
                                phaseInstanceId,
                                before,
                                accountedBefore);
                            if (ended is not null) return ended;
                        }
                    }
                }
            }
        }
        catch (GuardException)
        {
            throw;
        }
        catch
        {
            throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_FAILED");
        }
        throw new GuardException("F005_ETW_WRITE_COMPLETION_DRAIN_TIMEOUT");
    }

    private object CloseJournal()
    {
        lock (gate)
        {
            ThrowIfClosed();
            if (failureCode is not null) throw new GuardException(failureCode);
            if (activePhase is not null) throw new GuardException("PHASE_STILL_ACTIVE");
            // CHG-F005-072: declaredを正常終了として受理する。
            // 未解決のwrite leaseはpipelineが完走していない証拠なので維持し、
            // 帰属不能なdeferred System eventだけを致命扱いから外す。
            if (notices.Any(item => item.State != "matched" && item.State != "declared"))
                throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
            if (pendingWriteLease is not null)
                throw new GuardException("WRITE_LEASE_CORRELATION_MISSING");
            if (!RootWorkerAliveLocked(rootWorkerPid ?? -1))
                throw new GuardException("ROOT_PID_NOT_RUNNING");
            AssertRegisteredProcessesContained();
        }
        StopEtw();
        lock (gate)
        {
            if (!RootWorkerAliveLocked(rootWorkerPid ?? -1))
                throw new GuardException("ROOT_PID_NOT_RUNNING");
            if (etwSession.EventsLost != 0) throw new GuardException("ETW_BUFFER_LOSS");
            if (failureCode is not null) throw new GuardException(failureCode);
            if (observations.Count == 0) throw new GuardException("ETW_OBSERVATION_MISSING");
            var expected = 1L;
            foreach (var observation in observations)
            {
                if (observation.EtwSequence != expected++) throw new GuardException("ETW_SEQUENCE_GAP");
            }
            PersistJournal(closed: true);
            journalClosed = true;
            job.DisarmAfterSuccessfulClose();
            return new {
                ok = true,
                state = "closed",
                journalSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(journalPath))),
                firstEtwSequence = observations[0].EtwSequence,
                lastEtwSequence = observations[^1].EtwSequence,
            };
        }
    }

    private void ObserveEtw(
        string eventName,
        int pid,
        ulong processStartKey,
        string eventPath,
        ulong fileObject,
        DateTime timestamp,
        long timestampQpc)
    {
        var callbackStage = "NORMALIZE";
        var relevantCallback = false;
        var processIdentityProbeCallback = false;
        var closedOrPoisonedAtEntry = false;
        IDisposable? callbackAdmissionLease = null;
        string? callbackTerminal = null;
        try
        {
            callbackAdmissionLease = callbackAdmission.EnterCallback();
            var normalized = NormalizeObservedPath(eventPath);
            if (normalized is null) return;
            var isProcessIdentityProbe =
                string.Equals(normalized, processIdentityProbePath, StringComparison.Ordinal);
            processIdentityProbeCallback = isProcessIdentityProbe;
            if (!isProcessIdentityProbe && IsJournalPath(normalized)) return;
            WriteCompletionDrainRules.InterlockedAddChecked(
                ref etwRelevantEventCount,
                1);
            relevantCallback = true;
            lock (gate)
            {
                callbackStage = "STATE";
                closedOrPoisonedAtEntry = journalClosed || failureCode is not null;
                if (closedOrPoisonedAtEntry) return;
                EnsureActiveWriteCompletionDeadlineLocked(
                    Stopwatch.GetTimestamp());
                if (isProcessIdentityProbe)
                {
                    ObserveProcessIdentityProbeLocked(pid, processStartKey);
                    return;
                }
                callbackStage = "AUTHORIZATION";
                string? systemSetInfoExpectedIdentity = null;
                string? identityRecheckFailureCode = null;
                AfterLeaseDirectoryRejoinContext? afterLeaseDirectoryRejoin = null;
                BoundLeaseDirectoryRejoinContext? boundLeaseDirectoryRejoin = null;
                CompletedNoLeaseDirectoryRejoinContext?
                    completedNoLeaseDirectoryRejoin = null;
                WriteCompletionDrainSeal? completionDrainSeal = null;
                WriteCompletionDrainSeal? completedWriteHandoff = null;
                PendingWriteLease? activeDirectoryHandoff = null;
                ImmutableArray<CompletedNoLeaseDirectorySealMember>
                    completedNoLeaseDirectoryHandoff = default;
                var completionReplayKind = WriteCompletionReplayKind.NormalEpoch;
                if (!AuthorizeJobMemberLocked(
                    pid,
                    processStartKey,
                    timestampQpc,
                    out var producerSequenceNumber,
                    out var authorizationFailure))
                {
                    if (TryAuthorizeWriteCompletionDrainEventLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestampQpc,
                        authorizationFailure,
                        out var drainPid,
                        out var drainSequence,
                        out completionDrainSeal,
                        out completedWriteHandoff,
                        out activeDirectoryHandoff,
                        out completedNoLeaseDirectoryHandoff,
                        out completionReplayKind))
                    {
                        if (!completedNoLeaseDirectoryHandoff.IsDefaultOrEmpty)
                        {
                            if (completionDrainSeal is not null ||
                                completedWriteHandoff is not null ||
                                activeDirectoryHandoff is not null ||
                                completionReplayKind !=
                                    WriteCompletionReplayKind.NormalEpoch)
                            {
                                PoisonLocked(
                                    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                return;
                            }
                            var directoryPid = 0;
                            ulong directorySequenceNumber = 0;
                            var knownAuthorization = WriteCompletionDrainRules
                                .InvokeCompletedNoLeaseKnownAuthorization(
                                    () => TryAuthorizeKnownSystemDirectoryWriteLocked(
                                        eventName,
                                        pid,
                                        normalized,
                                        fileObject,
                                        timestampQpc,
                                        authorizationFailure,
                                        out directoryPid,
                                        out directorySequenceNumber,
                                        out systemSetInfoExpectedIdentity),
                                    () => failureCode is not null);
                            if (knownAuthorization !=
                                CompletedNoLeaseKnownAuthorizationDecision.Pass)
                            {
                                if (knownAuthorization ==
                                    CompletedNoLeaseKnownAuthorizationDecision.StateChanged)
                                    PoisonLocked(
                                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                return;
                            }
                            if (activePhase is null || rootWorkerStartKey is null ||
                                systemSetInfoExpectedIdentity is null)
                            {
                                PoisonLocked(
                                    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                return;
                            }
                            var handoffMembers = completedNoLeaseDirectoryHandoff;
                            var handoffSeal = handoffMembers[0].Seal;
                            if (!WriteCompletionDrainRules
                                .CompletedNoLeaseAuthorizedIdentityMatches(
                                    systemSetInfoExpectedIdentity,
                                    handoffSeal.DirectoryIdentity))
                            {
                                PoisonLocked(
                                    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                return;
                            }
                            completedNoLeaseDirectoryRejoin =
                                new CompletedNoLeaseDirectoryRejoinContext(
                                    handoffMembers,
                                    activePhase,
                                    activePhase.PhaseInstanceId,
                                    activePhase.StartedAtQpc,
                                    normalized,
                                    systemSetInfoExpectedIdentity,
                                    fileObject,
                                    timestampQpc,
                                    directoryPid,
                                    rootWorkerStartKey.Value,
                                    directorySequenceNumber);
                            RecheckCompletedNoLeaseDirectoryProofIndependentLocked(
                                completedNoLeaseDirectoryRejoin);
                            pid = directoryPid;
                            producerSequenceNumber = directorySequenceNumber;
                            identityRecheckFailureCode =
                                "ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH";
                        }
                        else if (activeDirectoryHandoff is not null)
                        {
                            if (completionDrainSeal is not null ||
                                completedWriteHandoff is not null ||
                                completionReplayKind !=
                                    WriteCompletionReplayKind.NormalEpoch)
                            {
                                PoisonLocked(
                                    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                return;
                            }
                            if (TryAuthorizeBoundLeaseDirectoryWriteLocked(
                                eventName,
                                pid,
                                normalized,
                                fileObject,
                                timestampQpc,
                                authorizationFailure,
                                out var boundLeaseDirectoryPid,
                                out var boundLeaseDirectorySequenceNumber,
                                out boundLeaseDirectoryRejoin))
                            {
                                pid = boundLeaseDirectoryPid;
                                producerSequenceNumber =
                                    boundLeaseDirectorySequenceNumber;
                            }
                            else
                            {
                                if (failureCode is not null) return;
                                if (TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(
                                    eventName,
                                    pid,
                                    normalized,
                                    fileObject,
                                    timestampQpc,
                                    authorizationFailure,
                                    out var leaseDirectoryPid,
                                    out var leaseDirectorySequenceNumber,
                                    out afterLeaseDirectoryRejoin))
                                {
                                    pid = leaseDirectoryPid;
                                    producerSequenceNumber =
                                        leaseDirectorySequenceNumber;
                                }
                                else
                                {
                                    if (failureCode is not null) return;
                                    PoisonLocked(
                                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                    return;
                                }
                            }
                        }
                        else if (completedWriteHandoff is not null)
                        {
                            if (!TryAuthorizeCompletedSystemSetInfoLocked(
                                eventName,
                                pid,
                                normalized,
                                fileObject,
                                timestampQpc,
                                authorizationFailure,
                                out var completedPid,
                                out var completedSequenceNumber,
                                out systemSetInfoExpectedIdentity))
                            {
                                if (failureCode is null)
                                    PoisonLocked(
                                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                                return;
                            }
                            pid = completedPid;
                            producerSequenceNumber = completedSequenceNumber;
                            identityRecheckFailureCode =
                                "ETW_COMPLETED_WRITE_REJOIN_IDENTITY_MISMATCH";
                        }
                        else
                        {
                            pid = drainPid;
                            producerSequenceNumber = drainSequence;
                        }
                    }
                    else if (TryAuthorizeReservedSystemSetInfoLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestamp,
                        timestampQpc,
                        authorizationFailure,
                        out var reservedPid,
                        out var reservedSequenceNumber,
                        out var deferred,
                        out var reservedExpectedIdentity))
                    {
                        if (deferred) return;
                        pid = reservedPid;
                        producerSequenceNumber = reservedSequenceNumber;
                        systemSetInfoExpectedIdentity = reservedExpectedIdentity;
                        if (reservedExpectedIdentity is not null)
                            identityRecheckFailureCode =
                                "ETW_CLOSED_LEASE_REJOIN_IDENTITY_MISMATCH";
                    }
                    else if (TryAuthorizeCompletedSystemSetInfoLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestampQpc,
                        authorizationFailure,
                        out var completedPid,
                        out var completedSequenceNumber,
                        out systemSetInfoExpectedIdentity))
                    {
                        pid = completedPid;
                        producerSequenceNumber = completedSequenceNumber;
                        identityRecheckFailureCode =
                            "ETW_COMPLETED_WRITE_REJOIN_IDENTITY_MISMATCH";
                    }
                    else if (TryAuthorizeBoundLeaseDirectoryWriteLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestampQpc,
                        authorizationFailure,
                        out var boundLeaseDirectoryPid,
                        out var boundLeaseDirectorySequenceNumber,
                        out boundLeaseDirectoryRejoin))
                    {
                        pid = boundLeaseDirectoryPid;
                        producerSequenceNumber = boundLeaseDirectorySequenceNumber;
                    }
                    else if (TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestampQpc,
                        authorizationFailure,
                        out var leaseDirectoryPid,
                        out var leaseDirectorySequenceNumber,
                        out afterLeaseDirectoryRejoin))
                    {
                        pid = leaseDirectoryPid;
                        producerSequenceNumber = leaseDirectorySequenceNumber;
                    }
                    else if (TryAuthorizeKnownSystemDirectoryWriteLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestampQpc,
                        authorizationFailure,
                        out var directoryPid,
                        out var directorySequenceNumber,
                        out systemSetInfoExpectedIdentity))
                    {
                        pid = directoryPid;
                        producerSequenceNumber = directorySequenceNumber;
                        identityRecheckFailureCode =
                            "ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH";
                    }
                    else
                    {
                    if (authorizationFailure == "BIRTH_MISSING")
                    {
                        var boundFileObject = filesByObject.ContainsKey(fileObject);
                        var knownPath = filesByPath.ContainsKey(normalized);
                        var operationClass = eventName switch {
                            "create" => "CREATE",
                            "write" => "WRITE",
                            "setinfo" => "SETINFO",
                            "rename" => "RENAME",
                            "delete" => "DELETE",
                            _ => "UNKNOWN",
                        };
                        authorizationFailure = pid is 0 or 4
                            ? boundFileObject
                                ? "SYSTEM_PROCESS_BOUND_FILE_OBJECT_REJOIN_" +
                                    SystemBoundFileObjectRejoinStage(
                                        normalized,
                                        fileObject,
                                        timestampQpc)
                                : operationClass == "WRITE" && knownPath
                                    ? SystemUnboundWriteKnownPathFailure(
                                        normalized,
                                        fileObject,
                                        timestampQpc)
                                    : $"SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_{operationClass}_" +
                                        (knownPath
                                            ? "KNOWN_PATH"
                                            : operationClass == "SETINFO"
                                                ? "UNKNOWN_PATH_" +
                                                    SystemSetInfoDiagnosticRules.Classify(
                                                        normalized,
                                                        File.Exists(Path.Combine(
                                                            root,
                                                            normalized.Replace(
                                                                '/',
                                                                Path.DirectorySeparatorChar))),
                                                        Directory.Exists(Path.Combine(
                                                            root,
                                                            normalized.Replace(
                                                                '/',
                                                                Path.DirectorySeparatorChar))),
                                                        pendingWriteLease is not null,
                                                        pendingWriteLease?.FileObject is not null,
                                                        CompletedWriteDiagnosticState(normalized))
                                                : "UNKNOWN_PATH")
                            : boundFileObject
                                ? "BIRTH_MISSING_BOUND_FILE_OBJECT"
                                : authorizationFailure;
                    }
                    PoisonLocked($"ETW_PID_NOT_JOB_MEMBER_{authorizationFailure}");
                    return;
                    }
                }
                callbackStage = "PHASE";
                if (activePhase is null)
                {
                    PoisonLocked("ETW_EVENT_OUTSIDE_PHASE");
                    return;
                }
                if (timestampQpc <= activePhase.StartedAtQpc)
                {
                    PoisonLocked("ETW_EVENT_PHASE_TIMESTAMP_MISMATCH");
                    return;
                }
                if (deferredSystemSetInfos.Count != 0)
                {
                    callbackStage = "IDENTITY";
                    var binding = eventName == "create" ? TryInspect(normalized) : null;
                    callbackStage = "CORRELATION";
                    if (binding is null)
                    {
                        PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_CREATE_SNAPSHOT_MISSING");
                        return;
                    }
                    if (!BindReservedSystemSetInfoLocked(
                            pid,
                            producerSequenceNumber,
                            normalized,
                            fileObject,
                            timestampQpc,
                            binding))
                    {
                        PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_BIND_MISMATCH");
                        return;
                    }
                }
                if (deferredRenames.Count != 0)
                {
                    PoisonLocked("ETW_RENAME_IDENTITY_MISMATCH");
                    return;
                }
                callbackStage = "CORRELATION";
                var prior = filesByObject.GetValueOrDefault(fileObject);
                FileSnapshot? current = null;
                PendingWriteLease? createLeaseToBind = null;
                callbackStage = "IDENTITY";
                if (eventName != "delete")
                    current = TryInspect(normalized);
                callbackStage = "CORRELATION";
                if (systemSetInfoExpectedIdentity is not null &&
                    current?.Identity != systemSetInfoExpectedIdentity)
                {
                    PoisonLocked(identityRecheckFailureCode ??
                        "ETW_SYSTEM_SETINFO_REJOIN_IDENTITY_MISMATCH");
                    return;
                }
                if (eventName == "create" &&
                    pendingWriteLease is { } writeLease &&
                    writeLease.WorkerPid == pid &&
                    writeLease.ProcessSequenceNumber == producerSequenceNumber &&
                    writeLease.PhaseInstanceId == activePhase.PhaseInstanceId &&
                    writeLease.RelativePath == normalized)
                {
                    if (writeLease.FileObjectClosed || fileObject == 0 || current is null)
                    {
                        PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_CREATE_BIND_MISMATCH");
                        return;
                    }
                    createLeaseToBind = writeLease;
                }
                if (eventName == "rename")
                {
                    var source = filesByPath.GetValueOrDefault(normalized) ?? prior;
                    string? observedTarget = null;
                    if (current is not null)
                    {
                        var identityMatches = filesByPath.Values
                            .Where(item =>
                                item.Identity == current.Identity &&
                                item.RelativePath != normalized)
                            .GroupBy(item => item.RelativePath, StringComparer.Ordinal)
                            .Select(group => group.First())
                            .ToArray();
                        if ((source is null || source.RelativePath == normalized) &&
                            identityMatches.Length == 1)
                        {
                            source = identityMatches[0];
                            observedTarget = normalized;
                        }
                        else if (source is not null &&
                            source.Identity == current.Identity &&
                            source.RelativePath != normalized)
                        {
                            observedTarget = normalized;
                        }
                    }
                    if (source is null)
                    {
                        PoisonLocked(ClassifyEtwGuardFailure(
                            "ETW_FILE_IDENTITY_MISSING",
                            eventName,
                            callbackStage));
                        return;
                    }
                    if (current is not null && source.Identity != current.Identity)
                    {
                        PoisonLocked("ETW_RENAME_IDENTITY_MISMATCH");
                        return;
                    }
                    var pendingRenameNotice = notices.FirstOrDefault(item =>
                        item.State == "pending" &&
                        item.WorkerPid == pid &&
                        item.ProducerSequenceNumber == producerSequenceNumber &&
                        item.PhaseInstanceId == activePhase.PhaseInstanceId &&
                        item.EventName == "rename" &&
                        item.From == source.RelativePath &&
                        (observedTarget is null || item.To == observedTarget));
                    if (pendingRenameNotice?.To is { } pendingTarget)
                    {
                        callbackStage = "IDENTITY";
                        var admittedTarget = TryInspect(pendingTarget);
                        callbackStage = "CORRELATION";
                        if (admittedTarget is null ||
                            admittedTarget.Identity != source.Identity)
                        {
                            PoisonLocked("ETW_RENAME_IDENTITY_MISMATCH");
                            return;
                        }
                        current = admittedTarget;
                        observedTarget = pendingTarget;
                    }
                    var deferred = new DeferredRenameRecord(
                        pid,
                        producerSequenceNumber,
                        checked(++etwSequence),
                        activePhase.Phase,
                        activePhase.WorkId,
                        activePhase.PhaseInstanceId,
                        new DateTimeOffset(timestamp.ToUniversalTime()).ToString("O"),
                        source,
                        observedTarget);
                    var renameProof = AdmitCallbackProofLocked(
                        completionDrainSeal,
                        eventName,
                        fileObject,
                        source,
                        observedTarget ?? source.RelativePath);
                    var renameSnapshot = new PendingCallbackSnapshot(
                        eventName,
                        normalized,
                        fileObject,
                        timestampQpc,
                        deferred.EtwSequence,
                        deferred.ObservedAt,
                        pid,
                        producerSequenceNumber,
                        activePhase,
                        current,
                        source,
                        ReadFreeBytes(root),
                        new DriveInfo(Path.GetPathRoot(root)!).TotalFreeSpace,
                        null,
                        afterLeaseDirectoryRejoin,
                        boundLeaseDirectoryRejoin,
                        completedNoLeaseDirectoryRejoin,
                        completionDrainSeal?.SealSequence,
                        renameProof,
                        WriteCompletionReplayKind.NormalEpoch,
                        deferred);
                    callbackTerminal = QueueOrApplyCallbackLocked(
                        renameSnapshot,
                        completionDrainSeal);
                    return;
                }
                // CleanupはFileObjectを先に破棄し得る。deleteは再open不能なので、
                // 同じ正規化pathで直前に検証したidentityをpointerより優先して使う。
                var effective = current ?? filesByPath.GetValueOrDefault(normalized) ?? prior;
                if (effective is null)
                {
                    PoisonLocked(ClassifyEtwGuardFailure(
                        "ETW_FILE_IDENTITY_MISSING",
                        eventName,
                        callbackStage));
                    return;
                }
                var sequence = checked(++etwSequence);
                var bindingProof = AdmitCallbackProofLocked(
                    completionDrainSeal,
                    eventName,
                    fileObject,
                    effective,
                    normalized);
                var callbackSnapshot = new PendingCallbackSnapshot(
                    eventName,
                    normalized,
                    fileObject,
                    timestampQpc,
                    sequence,
                    new DateTimeOffset(timestamp.ToUniversalTime()).ToString("O"),
                    pid,
                    producerSequenceNumber,
                    activePhase,
                    current,
                    effective,
                    ReadFreeBytes(root),
                    new DriveInfo(Path.GetPathRoot(root)!).TotalFreeSpace,
                    createLeaseToBind,
                    afterLeaseDirectoryRejoin,
                    boundLeaseDirectoryRejoin,
                    completedNoLeaseDirectoryRejoin,
                    completionDrainSeal?.SealSequence,
                    bindingProof,
                    completionReplayKind,
                    null);
                callbackTerminal = QueueOrApplyCallbackLocked(
                    callbackSnapshot,
                    completionDrainSeal);
            }
        }
        catch (Exception error)
        {
            Poison(error switch {
                GuardException guard =>
                    ClassifyEtwGuardFailure(guard.Code, eventName, callbackStage),
                WriteCompletionBufferLimitException =>
                    "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT",
                _ => ClassifyEtwCallbackFailure(error, callbackStage),
            });
        }
        finally
        {
            if (relevantCallback)
            {
                var terminal = callbackTerminal ??
                    (processIdentityProbeCallback
                        ? "PROCESS_IDENTITY_PROBE"
                        : closedOrPoisonedAtEntry
                            ? "CLOSED_OR_POISONED"
                            : "FIXED_REFUSAL");
                try
                {
                    WriteCompletionDrainRules.InterlockedAddChecked(
                        ref etwAccountedEventCount,
                        WriteCompletionDrainRules.AccountedDelta(terminal));
                }
                catch (WriteCompletionBufferLimitException)
                {
                    Poison("F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
                }
            }
            callbackAdmissionLease?.Dispose();
        }
    }

    private string QueueOrApplyCallbackLocked(
        PendingCallbackSnapshot snapshot,
        WriteCompletionDrainSeal? completionDrainSeal)
    {
        var activeSealedCandidate = completionDrainSeal?.State is
            WriteCompletionDrainState.Prepared or
            WriteCompletionDrainState.CompletionRequested;
        var queueDecision = WriteCompletionDrainRules.QueueDecision(
            writeCompletionReorderActive,
            activeSealedCandidate,
            writeCompletionReorderQueue.Count,
            MaxWriteCompletionEventsPerPhase);
        if (completionDrainSeal is not null)
        {
            if (completionDrainSeal.EventCount >=
                    MaxWriteCompletionEventsPerSeal ||
                writeCompletionPhaseEventCount >=
                    MaxWriteCompletionEventsPerPhase)
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
            completionDrainSeal.EventCount++;
            writeCompletionPhaseEventCount++;
            if (activeSealedCandidate)
                writeCompletionReorderActive = true;
        }
        if (queueDecision == "BUFFER_LIMIT")
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        if (queueDecision == "QUEUE")
        {
            writeCompletionReplayStore.EnqueueSnapshot(snapshot);
            return "DEFER_OR_REORDER";
        }
        if (snapshot.BindingProof is not null)
        {
            try
            {
                writeCompletionBindingLedger!.Validate([snapshot.BindingProof]);
                PreflightCallbackSnapshotLocked(snapshot);
                var checkpoint = CaptureCompletionSemanticCheckpointLocked();
                WriteCompletionAtomicBatchRules.Execute(
                    () => ApplyPreflightedCallbackSnapshotLocked(snapshot),
                    () => writeCompletionBindingLedger.ValidateAndCommit(
                        [snapshot.BindingProof]),
                    () => RestoreCompletionSemanticCheckpointLocked(checkpoint));
            }
            catch (Exception error) when (
                error is OverflowException or InvalidOperationException)
            {
                throw new GuardException(error is WriteCompletionBufferLimitException
                    ? "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT"
                    : "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
            }
            return "NORMAL";
        }
        ApplyCallbackSnapshotLocked(snapshot);
        return "NORMAL";
    }

    private ImmutableBindingProof? AdmitCallbackProofLocked(
        WriteCompletionDrainSeal? seal,
        string eventName,
        ulong fileObject,
        FileSnapshot effective,
        string proofPath)
    {
        var ledger = writeCompletionBindingLedger;
        if (ledger is null) return null;
        try
        {
            WriteCompletionBindingKind kind;
            long? exactGeneration = null;
            if (seal is not null && proofPath == seal.CurrentPath)
            {
                kind = WriteCompletionBindingKind.SealedCurrent;
                exactGeneration = seal.LeaseFileObjectGeneration;
            }
            else if (seal is not null && proofPath == seal.ParentPath)
            {
                kind = WriteCompletionBindingKind.SealedParent;
            }
            else if (seal is null)
            {
                kind = WriteCompletionBindingKind.OtherBound;
            }
            else
            {
                throw new InvalidOperationException("BINDING_MISMATCH");
            }
            var proof = ledger.Admit(
                kind,
                eventName,
                fileObject,
                effective.Identity,
                proofPath,
                exactGeneration);
            if (kind is WriteCompletionBindingKind.OtherBound &&
                eventName != "delete")
                EnsureGenerationHandleLocked(proof, proofPath, effective.Identity);
            return proof;
        }
        catch (Exception error) when (
            error is OverflowException or InvalidOperationException)
        {
            throw new GuardException(error.Message == "BUFFER_LIMIT"
                ? "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT"
                : "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        }
    }

    private void ApplyCallbackSnapshotLocked(PendingCallbackSnapshot snapshot)
    {
        if (!ReferenceEquals(activePhase, snapshot.Phase))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        if (snapshot.SealSequence is not null)
            RecheckSealedCallbackLocked(snapshot);
        ApplyCallbackSnapshotCoreLocked(snapshot, preflighted: false);
    }

    private void ApplyPreflightedCallbackSnapshotLocked(
        PendingCallbackSnapshot snapshot)
    {
        if (!ReferenceEquals(activePhase, snapshot.Phase))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        ApplyCallbackSnapshotCoreLocked(snapshot, preflighted: true);
    }

    private void ApplyCallbackSnapshotCoreLocked(
        PendingCallbackSnapshot snapshot,
        bool preflighted)
    {
        if (snapshot.DeferredRename is not null)
        {
            if (preflighted)
                ApplyPreflightedRenameSnapshotLocked(snapshot);
            else
                ApplyRenameSnapshotLocked(snapshot);
            return;
        }
        if (!preflighted && snapshot.BindingProof is not null &&
            snapshot.SealSequence is null)
        {
            var key = (snapshot.BindingProof.FileObject,
                snapshot.BindingProof.GenerationAfter);
            if (!writeCompletionGenerationHandles.TryGetValue(key, out var retained))
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
            retained.Reinspect(snapshot.Effective.Identity);
        }
        else if (snapshot.BindingProof is null && snapshot.EventName != "delete")
        {
            ReinspectImmediateSnapshot(snapshot);
        }
        if (!WriteCompletionDrainRules.HasAtMostOneImmutableRejoinContext(
            snapshot.AfterLeaseDirectoryRejoin is not null,
            snapshot.BoundLeaseDirectoryRejoin is not null,
            snapshot.CompletedNoLeaseDirectoryRejoin is not null))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        if (snapshot.AfterLeaseDirectoryRejoin is not null)
        {
            var failure = RecheckAfterLeaseDirectoryRejoinLocked(
                snapshot.AfterLeaseDirectoryRejoin);
            if (failure is not null) throw new GuardException(failure);
            var processFailure = RecheckAfterLeaseDirectoryProcessLocked(
                snapshot.AfterLeaseDirectoryRejoin);
            if (processFailure is not null)
                throw new GuardException(processFailure);
        }
        if (snapshot.BoundLeaseDirectoryRejoin is not null)
        {
            var tupleFailure = RecheckBoundLeaseDirectoryTupleLocked(
                snapshot.BoundLeaseDirectoryRejoin,
                snapshot.TimestampQpc,
                snapshot.FileObject);
            if (tupleFailure is not null) throw new GuardException(tupleFailure);
            var processFailure = RecheckBoundLeaseDirectoryProcessLocked(
                snapshot.BoundLeaseDirectoryRejoin);
            if (processFailure is not null) throw new GuardException(processFailure);
        }
        if (snapshot.CompletedNoLeaseDirectoryRejoin is { } completedNoLease)
            RecheckCompletedNoLeaseDirectoryProofLocked(
                snapshot,
                completedNoLease);
        long oldAllocated;
        long newAllocated;
        long delta;
        long live;
        try
        {
            oldAllocated = allocatedByIdentity.GetValueOrDefault(
                snapshot.Effective.Identity);
            newAllocated = snapshot.EventName == "delete"
                ? 0
                : snapshot.Effective.AllocatedLengthBytes;
            delta = checked(newAllocated - oldAllocated);
            live = checked(CurrentLiveBytes() - oldAllocated + newAllocated);
        }
        catch (OverflowException)
        {
            throw new GuardException(
                WriteCompletionDrainRules.ApplicationFailure(
                    true, false, true)!);
        }
        if (snapshot.CreateLeaseToBind is not null)
        {
            if (!ReferenceEquals(pendingWriteLease, snapshot.CreateLeaseToBind) ||
                snapshot.Current is null)
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
            snapshot.CreateLeaseToBind.FileObject = snapshot.FileObject;
            snapshot.CreateLeaseToBind.Snapshot = snapshot.Current;
        }
        if (snapshot.Current is not null)
        {
            filesByObject[snapshot.FileObject] = snapshot.Current;
            filesByPath[snapshot.Current.RelativePath] = snapshot.Current;
        }
        if (snapshot.EventName == "delete")
        {
            filesByObject.Remove(snapshot.FileObject);
            filesByPath.Remove(snapshot.Effective.RelativePath);
        }
        allocatedByIdentity[snapshot.Effective.Identity] = newAllocated;
        if (newAllocated == 0)
            allocatedByIdentity.Remove(snapshot.Effective.Identity);
        peakLiveBytes = Math.Max(peakLiveBytes, live);
        minimumObservedFreeBytes = Math.Min(
            minimumObservedFreeBytes,
            snapshot.FreeBytesAvailable);
        var observation = new ObservationRecord(
            snapshot.EventName,
            snapshot.NormalizedPath,
            null,
            null,
            snapshot.Phase.Phase,
            snapshot.Phase.WorkId,
            snapshot.Phase.PhaseInstanceId,
            snapshot.EtwSequence,
            snapshot.ObservedAt,
            snapshot.ProducerPid,
            snapshot.ProducerSequenceNumber,
            snapshot.Effective.VolumeId,
            snapshot.Effective.FileId128,
            snapshot.EventName == "delete" ? 0 : snapshot.Effective.LogicalLengthBytes,
            snapshot.EventName == "delete" ? 0 : snapshot.Effective.AllocatedLengthBytes,
            delta,
            live,
            snapshot.FreeBytesAvailable,
            snapshot.FreeBytesTotal,
            producerBinarySha256);
        var pending = notices.FirstOrDefault(item =>
            item.State == "pending" &&
            item.WorkerPid == snapshot.ProducerPid &&
            item.ProducerSequenceNumber == snapshot.ProducerSequenceNumber &&
            item.PhaseInstanceId == snapshot.Phase.PhaseInstanceId &&
            item.Matches(observation));
        if (pending is not null)
        {
            pending.Match(snapshot.EtwSequence);
            observation.NoticeSequence = pending.NoticeSequence;
            Monitor.PulseAll(gate);
        }
        observations.Add(observation);
    }

    private void ReinspectImmediateSnapshot(PendingCallbackSnapshot snapshot)
    {
        var identityRecheck = TryInspect(snapshot.NormalizedPath);
        if (identityRecheck?.Identity != snapshot.Effective.Identity)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
    }

    private void RecheckSealedCallbackLocked(PendingCallbackSnapshot snapshot)
    {
        var matching = writeCompletionSeals.Where(item =>
            item.SealSequence == snapshot.SealSequence).ToArray();
        var seal = matching.Length == 1 ? matching[0] : null;
        var proof = snapshot.BindingProof;
        WriteCompletionBindingKind? expectedKind = seal is null
            ? null
            : snapshot.NormalizedPath == seal.CurrentPath
                ? WriteCompletionBindingKind.SealedCurrent
                : snapshot.NormalizedPath == seal.ParentPath
                    ? WriteCompletionBindingKind.SealedParent
                    : null;
        var normalEpoch = seal is not null &&
            snapshot.ReplayKind == WriteCompletionReplayKind.NormalEpoch &&
            seal.CompletionRequestedAtQpc is long normalUpper &&
            WriteCompletionDrainRules.IsWithinEpoch(
                seal.CurrentPathReservedAtQpc, normalUpper, snapshot.TimestampQpc);
        var postRequestSystemSetInfo = seal is not null &&
            snapshot.ReplayKind == WriteCompletionReplayKind.PostRequestSystemSetInfo &&
            WriteCompletionDrainRules.PostRequestReplayFieldsMatch(
                snapshot.ReplayKind,
                snapshot.EventName == "setinfo",
                snapshot.NormalizedPath == seal.CurrentPath,
                seal.State == WriteCompletionDrainState.CompletionRequested,
                seal.CompletionRequestedAtQpc is long,
                seal.DrainDeadlineQpc is long,
                seal.CompletionRequestedAtQpc is long completionQpc &&
                    seal.DrainDeadlineQpc is long deadlineQpc &&
                    WriteCompletionDrainRules.IsWithinPostRequestEpoch(
                        completionQpc, deadlineQpc, snapshot.TimestampQpc),
                !completedWrites.ContainsKey(snapshot.NormalizedPath),
                proof?.Kind == WriteCompletionBindingKind.SealedCurrent,
                proof?.GenerationBefore == seal.LeaseFileObjectGeneration,
                proof?.GenerationAfter == seal.LeaseFileObjectGeneration,
                proof?.StateBefore is WriteCompletionBindingState.Bound or
                    WriteCompletionBindingState.Retired,
                proof?.StateAfter == proof?.StateBefore,
                proof?.Path == seal.CurrentPath,
                snapshot.ProducerPid == seal.ProducerPid,
                snapshot.ProducerSequenceNumber == seal.ProcessSequenceNumber);
        var tupleFailure = WriteCompletionDrainRules.RecheckSealedFailure(
            matching.Length,
            seal is not null && ReferenceEquals(snapshot.Phase, seal.Phase),
            seal?.State is WriteCompletionDrainState.CompletionRequested or
                WriteCompletionDrainState.CompletedRetained,
            normalEpoch != postRequestSystemSetInfo,
            proof is not null,
            expectedKind is WriteCompletionBindingKind kind && proof?.Kind == kind,
            proof?.FileObject == snapshot.FileObject,
            expectedKind != WriteCompletionBindingKind.SealedCurrent ||
                proof?.GenerationBefore == seal?.LeaseFileObjectGeneration &&
                proof?.GenerationAfter == seal?.LeaseFileObjectGeneration,
            proof?.StateBefore == proof?.StateAfter,
            proof?.Path == snapshot.NormalizedPath,
            snapshot.ProducerPid == seal?.ProducerPid,
            snapshot.ProducerSequenceNumber == seal?.ProcessSequenceNumber);
        if (tupleFailure is not null) throw new GuardException(tupleFailure);
        var checkedSeal = seal!;
        var checkedProof = proof!;
        var checkedKind = expectedKind!.Value;
        var identity = checkedKind == WriteCompletionBindingKind.SealedCurrent
            ? checkedSeal.CurrentIdentity
            : checkedSeal.DirectoryIdentity;
        var identityFailure = WriteCompletionDrainRules.RecheckIdentityFailure(
            identity == snapshot.Effective.Identity,
            checkedProof.Identity == snapshot.Effective.Identity);
        if (identityFailure is not null) throw new GuardException(identityFailure);
        try
        {
            if (checkedKind == WriteCompletionBindingKind.SealedCurrent)
                checkedSeal.RetainedCurrent.Reinspect(snapshot.Effective.Identity);
            else
                checkedSeal.RetainedParent.Reinspect(snapshot.Effective.Identity);
        }
        catch (GuardException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
        }
        JobObject.RetainedProcessInspection inspection;
        try { inspection = job.InspectRetainedProcess(checkedSeal.Lease.Process); }
        catch (GuardException error)
        {
            throw new GuardException(
                error.Code == "PROCESS_WAIT_FAILED"
                    ? WriteCompletionDrainRules.ProcessFailureCode(error.Code, true)
                    : WriteCompletionDrainRules.ApplicationFailure(
                        true, true, false)!);
        }
        if (inspection.ProcessId != checkedSeal.ProducerPid ||
            inspection.ProcessStartKey != checkedSeal.ProcessStartKey ||
            inspection.ProcessSequenceNumber != checkedSeal.ProcessSequenceNumber)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH");
        if (!inspection.Signaled)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED");
    }

    private void ApplyRenameSnapshotLocked(PendingCallbackSnapshot snapshot)
    {
        var deferred = snapshot.DeferredRename!;
        var pendingRename = notices.FirstOrDefault(item =>
            item.State == "pending" &&
            item.WorkerPid == deferred.WorkerPid &&
            item.ProducerSequenceNumber == deferred.ProducerSequenceNumber &&
            item.PhaseInstanceId == deferred.PhaseInstanceId &&
            item.EventName == "rename" &&
            item.From == deferred.Source.RelativePath &&
            (deferred.ObservedTarget is null || item.To == deferred.ObservedTarget));
        if (pendingRename is null)
        {
            deferredRenames.Add(deferred);
            return;
        }
        CompleteDeferredRename(
            deferred,
            pendingRename,
            snapshot.FreeBytesAvailable);
    }

    private void ApplyPreflightedRenameSnapshotLocked(
        PendingCallbackSnapshot snapshot)
    {
        var deferred = snapshot.DeferredRename!;
        var pendingRename = notices.FirstOrDefault(item =>
            item.State == "pending" &&
            item.WorkerPid == deferred.WorkerPid &&
            item.ProducerSequenceNumber == deferred.ProducerSequenceNumber &&
            item.PhaseInstanceId == deferred.PhaseInstanceId &&
            item.EventName == "rename" &&
            item.From == deferred.Source.RelativePath &&
            (deferred.ObservedTarget is null ||
                item.To == deferred.ObservedTarget));
        if (pendingRename is null)
        {
            deferredRenames.Add(deferred);
            return;
        }
        CompleteDeferredRenameFromSnapshot(
            deferred,
            pendingRename,
            snapshot.Current,
            snapshot.FreeBytesAvailable,
            snapshot.FreeBytesTotal);
    }

    private bool TryAuthorizeWriteCompletionDrainEventLocked(
        string eventName,
        int pid,
        string normalized,
        ulong fileObject,
        long eventQpc,
        string authorizationFailure,
        out int producerPid,
        out ulong producerSequenceNumber,
        out WriteCompletionDrainSeal? selectedSeal,
        out WriteCompletionDrainSeal? completedWriteHandoff,
        out PendingWriteLease? activeDirectoryHandoff,
        out ImmutableArray<CompletedNoLeaseDirectorySealMember>
            completedNoLeaseDirectoryHandoff,
        out WriteCompletionReplayKind replayKind)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        selectedSeal = null;
        completedWriteHandoff = null;
        activeDirectoryHandoff = null;
        completedNoLeaseDirectoryHandoff = default;
        replayKind = WriteCompletionReplayKind.NormalEpoch;
        var broad = writeCompletionSeals.Where(seal =>
            authorizationFailure == "BIRTH_MISSING" &&
            pid is 0 or 4 &&
            eventName is "write" or "setinfo" &&
            fileObject != 0 &&
            activePhase?.Phase == "voice" &&
            ReferenceEquals(activePhase, seal.Phase) &&
            (normalized == seal.CurrentPath || normalized == seal.ParentPath))
            .ToArray();
        if (broad.Length == 0) return false;
        foreach (var seal in broad.Where(item => item.State is
            WriteCompletionDrainState.Prepared or
            WriteCompletionDrainState.CompletionRequested))
            EnsureWriteCompletionDeadlineLocked(seal, Stopwatch.GetTimestamp());
        var ledger = writeCompletionBindingLedger;
        LateProofEvaluation EvaluateProof(WriteCompletionDrainSeal seal) =>
            WriteCompletionDrainRules.EvaluateLateProofDetail(
                normalized == seal.CurrentPath,
                normalized == seal.ParentPath,
                fileObject,
                seal.LeaseFileObject,
                seal.LeaseFileObjectGeneration,
                seal.CurrentIdentity,
                seal.CurrentPath,
                ledger is not null,
                () => ledger!.MatchGeneration(
                    fileObject,
                    seal.LeaseFileObjectGeneration,
                    seal.CurrentIdentity,
                    seal.CurrentPath),
                () => ledger!.MatchUnbound(fileObject));
        var classification = WriteCompletionDrainRules.ClassifyEpochCandidates(
            broad,
            eventQpc,
            seal => seal.CurrentPathReservedAtQpc,
            seal => seal.CompletionRequestedAtQpc,
            EvaluateProof);
        if (classification.TemporalInvalidCount > 0 ||
            classification.ProofInvalidCount > 0)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        var epoch = classification.Epoch.ToArray();
        if (epoch.Length == 0)
        {
            var activeLease = pendingWriteLease;
            var lateCandidates = classification.Late.ToArray();
            var failure = lateCandidates.Length == 0
                ? classification.PostUpperProofMissingCount == broad.Length
                    ? WriteCompletionDrainRules
                        .EpochEmptyPostUpperProofFailureCode(
                            classification.ProofResults,
                            classification.GenerationMatchResults,
                            classification.UnboundMatchResults)
                    : WriteCompletionDrainRules.EpochEmptyNoLateFailureCode(
                        broad.Length,
                        classification.AtOrBeforeReservationCount,
                        classification.PostUpperProofMissingCount,
                        classification.TemporalInvalidCount)
                : WriteCompletionDrainRules.LookupFailure(
                    broad.Length, epoch.Length, 0, lateCandidates.Length)!;
            if (failure == WriteCompletionDrainRules
                    .LookupPostUpperProofParentBoundAllFailureCode)
            {
                var leaseFileObject = activeLease?.FileObject ?? 0;
                var leaseIdentity = activeLease?.Snapshot?.Identity;
                var leasePath = activeLease?.RelativePath;
                var slash = leasePath?.LastIndexOf('/') ?? -1;
                var exactGenerationPresent = activeLease is not null &&
                    ledger is not null && leaseFileObject != 0 &&
                    !string.IsNullOrEmpty(leaseIdentity) &&
                    !string.IsNullOrEmpty(leasePath) &&
                    ledger.ExactGeneration(
                        leaseFileObject, leaseIdentity, leasePath) is not null;
                EventFileObjectMatchResult? eventFileObjectMatch = null;
                EventFileObjectBoundPathRelation? eventBoundPathRelation = null;
                EventDirectoryBindingState? eventDirectoryBinding = null;
                if (ledger is not null && fileObject != leaseFileObject)
                {
                    eventFileObjectMatch = ledger.MatchEventFileObject(
                        fileObject,
                        leasePath,
                        normalized,
                        broad.Select(seal => seal.CurrentPath).ToArray(),
                        broad.Select(seal => seal.ParentPath).ToArray(),
                        out var observedRelation);
                    eventBoundPathRelation = observedRelation;
                    if (observedRelation ==
                        EventFileObjectBoundPathRelation.EventDirectory)
                        eventDirectoryBinding = ledger.MatchEventDirectoryBinding(
                            fileObject, normalized);
                }
                failure = WriteCompletionDrainRules
                    .ParentBoundActiveLeaseFailureCode(
                        broad.Length,
                        eventName,
                        fileObject,
                        activeLease is not null,
                        activePhase is not null,
                        activeLease?.Snapshot is not null,
                        leaseFileObject,
                        leaseIdentity,
                        leasePath,
                        activePhase?.Phase == "voice",
                        activeLease is not null && activePhase is not null &&
                            activeLease.PhaseInstanceId == activePhase.PhaseInstanceId,
                        slash > 0 && leasePath![..slash] == normalized,
                        activeLease is not null &&
                            eventQpc > activeLease.CurrentPathReservedAtQpc,
                        exactGenerationPresent,
                        eventFileObjectMatch,
                        eventBoundPathRelation,
                        eventDirectoryBinding);
                throw new GuardException(failure);
            }
            if (lateCandidates.Length != 0)
            {
                var slash = activeLease?.RelativePath.LastIndexOf('/') ?? -1;
                var sameParent = slash > 0 &&
                    activeLease!.RelativePath[..slash] == normalized;
                failure = WriteCompletionDrainRules.AggregateLateEventFailureCode(
                    eventName,
                    lateCandidates.Select(seal => new LateEventDiagnosticCandidate(
                        seal.State == WriteCompletionDrainState.CompletedRetained,
                        normalized == seal.ParentPath,
                        activeLease is not null,
                        activeLease is not null &&
                            !ReferenceEquals(activeLease, seal.Lease),
                        sameParent,
                        activeLease is not null &&
                            eventQpc > activeLease.CurrentPathReservedAtQpc)));
            }
            if (lateCandidates.Length >= 2 &&
                failure == WriteCompletionDrainRules
                    .LateDiagnosticWriteActiveLeaseMissingFailureCode)
            {
                // path tableは同じgate内で1回だけ読み、immutable seal identityとの
                // exact集合に縮約する。候補順、QPC、sequence、indexでは選ばない。
                var currentDirectory = filesByPath.GetValueOrDefault(normalized);
                var identitySelection = WriteCompletionDrainRules
                    .SelectCompletedNoLeaseDirectoryHandoffIdentity(
                        lateCandidates,
                        currentDirectory?.Identity,
                        seal => seal.DirectoryIdentity,
                        seal => seal.SealSequence);
                if (identitySelection.FailureCode is not null)
                    throw new GuardException(identitySelection.FailureCode);
                var selected = identitySelection.Selected;
                if (selected is null)
                {
                    var commonIdentity = currentDirectory?.Identity ??
                        throw new GuardException(
                            "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                    completedNoLeaseDirectoryHandoff = identitySelection.Matches
                        .Select(CreateCompletedNoLeaseDirectorySealMember)
                        .ToImmutableArray();
                    ValidateCompletedNoLeaseDirectorySealMembers(
                        completedNoLeaseDirectoryHandoff,
                        normalized,
                        commonIdentity,
                        eventQpc);
                    return true;
                }
                var seal = selected;
                if (WriteCompletionDrainRules
                    .CanHandoffCompletedNoLeaseDirectory(
                        1, failure, authorizationFailure, pid, eventName,
                        fileObject, true,
                        seal.State == WriteCompletionDrainState.CompletedRetained,
                        activePhase?.Phase == "voice",
                        ReferenceEquals(activePhase, seal.Phase),
                        normalized == seal.ParentPath,
                        pendingWriteLease is null,
                        seal.CompletionRequestedAtQpc is long,
                        seal.CompletionRequestedAtQpc is long completionUpper &&
                            eventQpc > completionUpper))
                {
                    completedNoLeaseDirectoryHandoff = [
                        CreateCompletedNoLeaseDirectorySealMember(seal),
                    ];
                    return true;
                }
            }
            if (lateCandidates.Length >= 2 &&
                failure == WriteCompletionDrainRules
                    .LateRetainedParentWriteFailureCode)
            {
                var activeSlash = activeLease?.RelativePath.LastIndexOf('/') ?? -1;
                var activeParentMatches = activeSlash > 0 &&
                    activeLease!.RelativePath[..activeSlash] == normalized;
                const bool fileObjectUnbound = true;
                var activeVoicePhase = activePhase?.Phase == "voice";
                var activeLeasePresent = activeLease is not null;
                var phaseInstanceMatches = activeLease is not null &&
                    activePhase is not null &&
                    activeLease.PhaseInstanceId == activePhase.PhaseInstanceId;
                var eventAfterActiveReservation = activeLease is not null &&
                    eventQpc > activeLease.CurrentPathReservedAtQpc;
                var eligibleCount = 0;
                foreach (var seal in lateCandidates)
                {
                    if (WriteCompletionDrainRules
                        .ActiveDirectoryHandoffCandidateMatches(
                            failure,
                            authorizationFailure,
                            pid,
                            eventName,
                            fileObject,
                            fileObjectUnbound,
                            seal.State == WriteCompletionDrainState.CompletedRetained,
                            activeVoicePhase,
                            ReferenceEquals(activePhase, seal.Phase),
                            normalized == seal.ParentPath,
                            activeLeasePresent,
                            activeLease is not null &&
                                !ReferenceEquals(activeLease, seal.Lease),
                            phaseInstanceMatches,
                            activeParentMatches,
                            eventAfterActiveReservation))
                    {
                        eligibleCount = checked(eligibleCount + 1);
                    }
                }
                if (WriteCompletionDrainRules
                    .CanHandoffActiveDirectoryCandidateSet(
                        lateCandidates.Length,
                        eligibleCount,
                        failure))
                {
                    if (activeLease is null)
                        throw new GuardException(
                            "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                    activeDirectoryHandoff = activeLease;
                    return true;
                }
                var eligibilityFailure = WriteCompletionDrainRules
                    .ActiveDirectoryHandoffEligibilityFailureCode(
                        lateCandidates.Length,
                        eligibleCount,
                        failure);
                if (eligibilityFailure is not null)
                    throw new GuardException(eligibilityFailure);
            }
            var activeDirectoryCardinalityFailure = WriteCompletionDrainRules
                .ActiveDirectoryHandoffCardinalityFailureCode(
                    lateCandidates.Length,
                    failure);
            if (activeDirectoryCardinalityFailure is not null)
                throw new GuardException(activeDirectoryCardinalityFailure);
            if (WriteCompletionDrainRules.IsCompletedWriteHandoffCandidate(
                    lateCandidates.Length,
                    failure))
            {
                var seal = lateCandidates[0];
                var completedPresent = completedWrites.TryGetValue(
                    normalized,
                    out var completed);
                if (!WriteCompletionDrainRules.CanHandoffCompletedWrite(
                    lateCandidates.Length,
                    failure,
                    completedPresent,
                    completedPresent && completed!.WorkerPid == seal.ProducerPid,
                    completedPresent && completed!.ProcessSequenceNumber ==
                        seal.ProcessSequenceNumber,
                    completedPresent && completed!.PhaseInstanceId ==
                        seal.Phase.PhaseInstanceId,
                    completedPresent && completed!.ReservedAtQpc ==
                        seal.CurrentPathReservedAtQpc,
                    completedPresent && completed!.Identity ==
                        seal.CurrentIdentity))
                {
                    throw new GuardException(
                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                }
                completedWriteHandoff = seal;
                return true;
            }
            if (lateCandidates.Length == 1)
            {
                var seal = lateCandidates[0];
                if (WriteCompletionDrainRules
                    .CanHandoffCompletedNoLeaseDirectory(
                        lateCandidates.Length,
                        failure,
                        authorizationFailure,
                        pid,
                        eventName,
                        fileObject,
                        true,
                        seal.State == WriteCompletionDrainState.CompletedRetained,
                        activePhase?.Phase == "voice",
                        ReferenceEquals(activePhase, seal.Phase),
                        normalized == seal.ParentPath,
                        pendingWriteLease is null,
                        seal.CompletionRequestedAtQpc is long,
                        seal.CompletionRequestedAtQpc is long completionUpper &&
                            eventQpc > completionUpper))
                {
                    completedNoLeaseDirectoryHandoff = [
                        CreateCompletedNoLeaseDirectorySealMember(seal),
                    ];
                    return true;
                }
            }
            if (lateCandidates.Length == 1 &&
                failure == WriteCompletionDrainRules
                    .LateDiagnosticSetInfoSealNotCompletedRetainedFailureCode)
            {
                var seal = lateCandidates[0];
                var completedRecordAbsent = !completedWrites.ContainsKey(normalized);
                if (!completedRecordAbsent)
                    throw new GuardException(
                        "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
                if (WriteCompletionDrainRules.CanAuthorizePostRequestSystemSetInfo(
                    lateCandidates.Length,
                    failure,
                    authorizationFailure,
                    pid,
                    eventName,
                    fileObject,
                    activePhase?.Phase == "voice",
                    ReferenceEquals(activePhase, seal.Phase),
                    normalized == seal.CurrentPath,
                    true,
                    seal.State == WriteCompletionDrainState.CompletionRequested,
                    seal.CompletionRequestedAtQpc is long,
                    seal.CompletionRequestedAtQpc ?? 0,
                    seal.DrainDeadlineQpc is long,
                    seal.DrainDeadlineQpc ?? 0,
                    eventQpc,
                    completedRecordAbsent))
                {
                    selectedSeal = seal;
                    producerPid = seal.ProducerPid;
                    producerSequenceNumber = seal.ProcessSequenceNumber;
                    replayKind = WriteCompletionReplayKind.PostRequestSystemSetInfo;
                    return true;
                }
            }
            if (lateCandidates.Length == 1)
            {
                var seal = lateCandidates[0];
                var activeSlash = activeLease?.RelativePath.LastIndexOf('/') ?? -1;
                if (WriteCompletionDrainRules.CanHandoffActiveDirectory(
                    lateCandidates.Length,
                    failure,
                    authorizationFailure,
                    pid,
                    eventName,
                    fileObject,
                    true,
                    seal.State == WriteCompletionDrainState.CompletedRetained,
                    activePhase?.Phase == "voice",
                    ReferenceEquals(activePhase, seal.Phase),
                    normalized == seal.ParentPath,
                    activeLease is not null,
                    activeLease is not null &&
                        !ReferenceEquals(activeLease, seal.Lease),
                    activeLease is not null && activePhase is not null &&
                        activeLease.PhaseInstanceId == activePhase.PhaseInstanceId,
                    activeSlash > 0 && activeLease!.RelativePath[..activeSlash] ==
                        normalized,
                    activeLease is not null &&
                        eventQpc > activeLease.CurrentPathReservedAtQpc))
                {
                    activeDirectoryHandoff = activeLease;
                    return true;
                }
            }
            if (failure == WriteCompletionDrainRules
                    .LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode)
            {
                if (activeLease is null || activePhase is null ||
                    eventQpc > activeLease.CurrentPathReservedAtQpc)
                {
                    failure = "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED";
                }
                else
                {
                    var recordPresent = registeredWorkerProcesses.TryGetValue(
                        activeLease.ProcessStartKey,
                        out var activeProducer);
                    failure = WriteCompletionDrainRules
                        .ActiveProducerBirthFailureCode(
                            failure,
                            recordPresent,
                            recordPresent &&
                                activeProducer!.Pid == activeLease.WorkerPid,
                            recordPresent && activeProducer!.ProcessStartKey ==
                                activeLease.ProcessStartKey,
                            recordPresent && activeProducer!.ProcessSequenceNumber ==
                                activeLease.ProcessSequenceNumber,
                            activeLease.PhaseInstanceId ==
                                activePhase.PhaseInstanceId,
                            activePhase.StartedAtQpc,
                            recordPresent ? activeProducer!.StartedAtQpc : 0,
                            activeLease.CurrentPathReservedAtQpc,
                            eventQpc);
                    if (failure == WriteCompletionDrainRules
                            .LateDiagnosticWriteActiveProducerRecordMissingFailureCode)
                    {
                        var snapshot = activeLease.ProducerBirthSnapshot;
                        failure = WriteCompletionDrainRules
                            .ProductionReservationProducerBirthFailureCode(
                                failure,
                                recordPresent,
                                ReferenceEquals(activeLease, pendingWriteLease),
                                activeLease.PhaseInstanceId,
                                activePhase.PhaseInstanceId,
                                snapshot is not null,
                                snapshot?.RecordObserved == true,
                                snapshot?.ProducerPid == activeLease.WorkerPid,
                                snapshot?.ProducerProcessStartKey ==
                                    activeLease.ProcessStartKey,
                                snapshot?.LeaseProcessSequenceNumber ==
                                    activeLease.ProcessSequenceNumber,
                                snapshot?.RecordProcessSequenceNumber ==
                                    activeLease.ProcessSequenceNumber,
                                snapshot?.PhaseInstanceId ==
                                    activeLease.PhaseInstanceId &&
                                    snapshot?.PhaseInstanceId ==
                                    activePhase.PhaseInstanceId,
                                snapshot?.PhaseStartedAtQpc ==
                                    activePhase.StartedAtQpc,
                                snapshot?.LeaseReservedAtQpc ==
                                    activeLease.ReservedAtQpc,
                                snapshot?.PhaseStartedAtQpc ?? 0,
                                snapshot?.RecordStartedAtQpc ?? 0,
                                snapshot?.LeaseReservedAtQpc ?? 0,
                                activeLease.CurrentPathReservedAtQpc,
                                eventQpc);
                    }
                }
            }
            throw new GuardException(failure);
        }
        var exact = epoch.Where(seal =>
                EvaluateProof(seal).Outer == LateProofResult.Success)
            .ToArray();
        var lookupFailure = WriteCompletionDrainRules.LookupFailure(
            broad.Length, epoch.Length, exact.Length, 0);
        if (lookupFailure is not null) throw new GuardException(lookupFailure);
        selectedSeal = exact[0];
        producerPid = selectedSeal.ProducerPid;
        producerSequenceNumber = selectedSeal.ProcessSequenceNumber;
        return true;
    }

    private void ObserveProcessIdentityProbeLocked(int pid, ulong processStartKey)
    {
        if (!processIdentityProbeArmed || processIdentityProbed) return;
        if (pid != rootWorkerPid ||
            !RootWorkerAliveLocked(pid) ||
            rootWorkerSequenceNumber is null or 0 ||
            (processStartKey != 0 && rootWorkerStartKey != processStartKey))
        {
            PoisonLocked("ETW_PROCESS_START_KEY_PROBE_IDENTITY_MISMATCH");
            processIdentityProbeObserved.Set();
            return;
        }
        processIdentityProbed = true;
        processIdentityProbeObserved.Set();
    }

    private bool TryAuthorizeReservedSystemSetInfoLocked(
        string eventName,
        int pid,
        string normalized,
        ulong fileObject,
        DateTime timestamp,
        long timestampQpc,
        string authorizationFailure,
        out int producerPid,
        out ulong producerSequenceNumber,
        out bool deferred,
        out string? expectedIdentity)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        deferred = false;
        expectedIdentity = null;
        var lease = pendingWriteLease;
        if (activePhase is null || lease is null)
            return false;
        producerPid = lease.WorkerPid;
        producerSequenceNumber = lease.ProcessSequenceNumber;
        var pathMatches = SystemSetInfoCorrelationRules.TryGetReservationQpc(
            normalized,
            lease.RelativePath,
            lease.CurrentPathReservedAtQpc,
            lease.PendingRenamePath,
            lease.RenameReservedAtQpc,
            out var pathReservationQpc);
        if (!SystemSetInfoCorrelationRules.MatchesReservation(
            authorizationFailure,
            pid,
            eventName,
            fileObject,
            lease.PhaseInstanceId == activePhase.PhaseInstanceId &&
                pathMatches,
            timestampQpc > pathReservationQpc,
            job.IsAliveOutsideJob(lease.Process)))
            return false;
        if (lease.FileObjectClosed)
        {
            string stage;
            if (lease.Snapshot is null)
            {
                stage = ClosedLeaseDiagnosticRules.Classify(
                    false, true, false, false);
            }
            else
            {
                var prior = filesByObject.GetValueOrDefault(fileObject);
                var fileObjectCompatible = prior is null ||
                    (prior.RelativePath == normalized &&
                        prior.Identity == lease.Snapshot.Identity);
                if (!fileObjectCompatible)
                {
                    stage = ClosedLeaseDiagnosticRules.Classify(
                        true, false, false, false);
                }
                else
                {
                    var closedCurrent = TryInspect(normalized);
                    stage = ClosedLeaseDiagnosticRules.Classify(
                        true,
                        true,
                        closedCurrent is not null,
                        closedCurrent?.Identity == lease.Snapshot.Identity);
                }
            }
            if (stage == "CANDIDATE")
            {
                expectedIdentity = lease.Snapshot!.Identity;
                return true;
            }
            PoisonLocked($"ETW_CLOSED_LEASE_REJOIN_{stage}");
            deferred = true;
            return true;
        }
        if (lease.FileObject is null)
        {
            if (deferredSystemSetInfos.Any(item =>
                item.PhaseInstanceId != lease.PhaseInstanceId ||
                item.RelativePath != normalized ||
                item.FileObject != fileObject))
            {
                PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_TUPLE_MISMATCH");
                deferred = true;
                return true;
            }
            var snapshot = TryInspect(normalized);
            if (snapshot is null)
            {
                PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_SNAPSHOT_MISSING");
                deferred = true;
                return true;
            }
            var free = ReadFreeBytes(root);
            deferredSystemSetInfos.Add(new DeferredSystemSetInfoRecord(
                lease.WorkerPid,
                lease.ProcessSequenceNumber,
                checked(++etwSequence),
                activePhase.Phase,
                activePhase.WorkId,
                lease.PhaseInstanceId,
                new DateTimeOffset(timestamp.ToUniversalTime()).ToString("O"),
                normalized,
                fileObject,
                timestampQpc,
                snapshot,
                free,
                new DriveInfo(Path.GetPathRoot(root)!).TotalFreeSpace));
            deferred = true;
            return true;
        }
        if (lease.FileObject != fileObject)
        {
            PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_FILE_OBJECT_MISMATCH");
            deferred = true;
            return true;
        }
        if (lease.Snapshot is null)
        {
            PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_LEASE_SNAPSHOT_MISSING");
            deferred = true;
            return true;
        }
        var current = TryInspect(normalized);
        if (current is null)
        {
            PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_CURRENT_MISSING");
            deferred = true;
            return true;
        }
        if (current.Identity != lease.Snapshot.Identity)
        {
            PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_IDENTITY_MISMATCH");
            deferred = true;
            return true;
        }
        lease.Snapshot = current;
        return true;
    }

    private bool TryAuthorizeCompletedSystemSetInfoLocked(
        string eventName,
        int pid,
        string normalized,
        ulong fileObject,
        long timestampQpc,
        string authorizationFailure,
        out int producerPid,
        out ulong producerSequenceNumber,
        out string? expectedIdentity)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        expectedIdentity = null;
        if (activePhase is null ||
            !completedWrites.TryGetValue(normalized, out var completed))
            return false;
        var current = TryInspect(normalized);
        var prior = filesByObject.GetValueOrDefault(fileObject);
        var rejection = CompletedWriteDiagnosticRules.Rejection(
            authorizationFailure,
            pid,
            eventName,
            fileObject,
            completed.PhaseInstanceId == activePhase.PhaseInstanceId,
            timestampQpc > completed.ReservedAtQpc,
            CompletedWriteDiagnosticRules.IsWithinCompletionWindow(
                timestampQpc,
                completed.CompletedAtQpc,
                Stopwatch.Frequency),
            prior is null ||
                (prior.RelativePath == normalized &&
                    prior.Identity == completed.Identity),
            current is not null,
            current?.Identity == completed.Identity);
        if (rejection == "AFTER_COMPLETION")
        {
            var bucket = CompletedWriteDiagnosticRules.AfterCompletionBucket(
                timestampQpc - completed.CompletedAtQpc,
                Stopwatch.Frequency);
            rejection = $"AFTER_COMPLETION_{bucket}";
        }
        if (rejection is not null)
        {
            PoisonLocked($"ETW_COMPLETED_WRITE_REJOIN_{rejection}");
            return false;
        }
        producerPid = completed.WorkerPid;
        producerSequenceNumber = completed.ProcessSequenceNumber;
        expectedIdentity = completed.Identity;
        return true;
    }

    private bool TryAuthorizeKnownSystemDirectoryWriteLocked(
        string eventName,
        int pid,
        string normalized,
        ulong fileObject,
        long timestampQpc,
        string authorizationFailure,
        out int producerPid,
        out ulong producerSequenceNumber,
        out string? expectedIdentity)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        expectedIdentity = null;
        var phase = activePhase;
        var rootPid = rootWorkerPid;
        var rootSequence = rootWorkerSequenceNumber;
        if (authorizationFailure != "BIRTH_MISSING" ||
            pid is not (0 or 4) ||
            eventName != "write" ||
            fileObject == 0 ||
            phase?.Phase != "voice" ||
            timestampQpc <= phase.StartedAtQpc ||
            filesByObject.ContainsKey(fileObject) ||
            pendingWriteLease is not null ||
            rootPid is null ||
            rootSequence is null or 0)
            return false;
        var absolute = Path.Combine(
            root,
            normalized.Replace('/', Path.DirectorySeparatorChar));
        var bucket = SystemSetInfoDiagnosticRules.Classify(
            normalized,
            File.Exists(absolute),
            Directory.Exists(absolute),
            pendingWriteLease is not null,
            pendingWriteLease?.FileObject is not null,
            "NO_LEASE");
        var stage = bucket == "CACHE_OTHER_DIRECTORY_NO_LEASE"
            ? SystemDirectoryWriteRejoinStage(normalized)
            : null;
        if (!SystemDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
            authorizationFailure,
            pid,
            eventName,
            fileObject,
            true,
            true,
            !filesByObject.ContainsKey(fileObject),
            true,
            bucket == "CACHE_OTHER_DIRECTORY_NO_LEASE",
            stage == "CANDIDATE",
            true,
            true))
            return false;
        producerPid = rootPid!.Value;
        producerSequenceNumber = rootSequence!.Value;
        expectedIdentity = filesByPath[normalized].Identity;
        return true;
    }

    private void RecheckCompletedNoLeaseDirectoryProofIndependentLocked(
        CompletedNoLeaseDirectoryRejoinContext context)
    {
        var phase = activePhase;
        if (!WriteCompletionDrainRules.CompletedNoLeaseContextStateMatches(
            ReferenceEquals(phase, context.Phase),
            phase?.Phase == "voice",
            phase?.PhaseInstanceId == context.PhaseInstanceId,
            phase?.StartedAtQpc == context.PhaseStartedAtQpc,
            pendingWriteLease is null,
            context.Members.Length is >= 1 and <= 128,
            rootWorkerPid == context.RootPid,
            rootWorkerStartKey == context.RootProcessStartKey,
            rootWorkerSequenceNumber == context.RootProcessSequenceNumber,
            rootWorkerProcess is not null))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");

        ValidateCompletedNoLeaseDirectorySealMembers(
            context.Members,
            context.DirectoryPath,
            context.DirectoryIdentity,
            context.EventQpc);

        string directoryStage;
        try { directoryStage = SystemDirectoryWriteRejoinStage(
            context.DirectoryPath); }
        catch (GuardException)
        {
            throw new GuardException(
                "ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH");
        }
        if (directoryStage != "CANDIDATE" ||
            filesByPath.GetValueOrDefault(context.DirectoryPath)?.Identity !=
                context.DirectoryIdentity)
            throw new GuardException(
                "ETW_SYSTEM_DIRECTORY_WRITE_REJOIN_IDENTITY_MISMATCH");
        if (!WriteCompletionDrainRules.ValidateCompletedNoLeaseMemberSet(
            context.Members,
            _ => true,
            member => member.Seal.RetainedParent.Reinspect(
                context.DirectoryIdentity)))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");

        JobObject.RetainedProcessInspection rootInspection;
        try { rootInspection = job.InspectRetainedProcess(rootWorkerProcess!); }
        catch (GuardException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        }
        if (!WriteCompletionDrainRules.CompletedNoLeaseRootProcessMatches(
            rootInspection.ProcessId == context.RootPid,
            rootInspection.ProcessStartKey == context.RootProcessStartKey,
            rootInspection.ProcessSequenceNumber ==
                context.RootProcessSequenceNumber,
            !rootInspection.Signaled,
            rootInspection.JobMember))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
    }

    private static CompletedNoLeaseDirectorySealMember
        CreateCompletedNoLeaseDirectorySealMember(WriteCompletionDrainSeal seal) =>
            new(seal, seal.SealSequence,
                seal.CompletionRequestedAtQpc ?? throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED"));

    private void ValidateCompletedNoLeaseDirectorySealMembers(
        ImmutableArray<CompletedNoLeaseDirectorySealMember> members,
        string directoryPath,
        string directoryIdentity,
        long eventQpc)
    {
        if (!WriteCompletionDrainRules.ValidateCompletedNoLeaseMemberSet(
            members,
            member => {
            var matching = writeCompletionSeals.Where(item =>
                item.SealSequence == member.SealSequence).ToArray();
            var seal = member.Seal;
            return matching.Length == 1 && ReferenceEquals(matching[0], seal) &&
                seal.State == WriteCompletionDrainState.CompletedRetained &&
                ReferenceEquals(seal.Phase, activePhase) &&
                seal.ParentPath == directoryPath &&
                seal.DirectoryIdentity == directoryIdentity &&
                seal.CompletionRequestedAtQpc == member.CompletionUpperQpc &&
                eventQpc > member.CompletionUpperQpc;
            },
            _ => { }))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
    }

    private void RecheckCompletedNoLeaseDirectoryProofLocked(
        PendingCallbackSnapshot snapshot,
        CompletedNoLeaseDirectoryRejoinContext context)
    {
        RecheckCompletedNoLeaseDirectoryProofIndependentLocked(context);
        if (!WriteCompletionDrainRules.CompletedNoLeaseSnapshotMatches(
            ReferenceEquals(snapshot.Phase, context.Phase),
            snapshot.NormalizedPath == context.DirectoryPath,
            snapshot.Effective.Identity == context.DirectoryIdentity,
            snapshot.FileObject == context.EventFileObject,
            snapshot.TimestampQpc == context.EventQpc,
            snapshot.ProducerPid == context.RootPid,
            snapshot.ProducerSequenceNumber ==
                context.RootProcessSequenceNumber,
            snapshot.SealSequence is null,
            snapshot.ReplayKind == WriteCompletionReplayKind.NormalEpoch))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED");
        var proof = snapshot.BindingProof;
        if (proof is null ||
            !WriteCompletionDrainRules.CompletedNoLeaseProofMatches(
                proof.Kind == WriteCompletionBindingKind.OtherBound,
                proof.EventName == "write",
                proof.FileObject == context.EventFileObject,
                proof.Path == context.DirectoryPath,
                proof.Identity == context.DirectoryIdentity,
                proof.StateAfter == WriteCompletionBindingState.Bound))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        var key = (proof.FileObject, proof.GenerationAfter);
        if (!writeCompletionGenerationHandles.TryGetValue(key, out var retained))
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
        try { retained.Reinspect(context.DirectoryIdentity); }
        catch (GuardException)
        {
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
        }
    }

    private bool TryAuthorizeBoundLeaseDirectoryWriteLocked(
        string eventName,
        int pid,
        string normalized,
        ulong fileObject,
        long eventQpc,
        string authorizationFailure,
        out int producerPid,
        out ulong producerSequenceNumber,
        out BoundLeaseDirectoryRejoinContext? rejoinContext)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        rejoinContext = null;
        var phase = activePhase;
        var lease = pendingWriteLease;
        if (phase is null || lease is null) return false;

        bool cheapPredicatesPass;
        try
        {
            cheapPredicatesPass =
                SystemDirectoryBoundLeaseRejoinAuthorizationRules
                    .EvaluateCheapPredicates(
                        authorizationFailure,
                        pid,
                        eventName,
                        fileObject,
                        !filesByObject.ContainsKey(fileObject),
                        phase.Phase == "voice",
                        lease.PhaseInstanceId == phase.PhaseInstanceId,
                        phase.StartedAtQpc,
                        lease.CurrentPathReservedAtQpc,
                        eventQpc,
                        () => SystemDirectoryBoundLeaseWriteRejoinStage(
                            normalized,
                            eventQpc) == "CANDIDATE",
                        () => lease.PendingRenamePath is null,
                        () => lease.RenameReservedAtQpc is null);
        }
        catch (GuardException)
        {
            PoisonLocked(
                "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_INITIAL_TUPLE_INSPECTION_FAILED");
            return false;
        }
        if (!cheapPredicatesPass) return false;

        FileSnapshot? directoryCurrent = null;
        FileSnapshot? leaseCurrent = null;
        var directorySnapshot = filesByPath.GetValueOrDefault(normalized);
        var leaseSnapshot = lease.Snapshot;
        var leaseFileObject = lease.FileObject;
        var binding = leaseFileObject is null
            ? null
            : filesByObject.GetValueOrDefault(leaseFileObject.Value);
        var slash = lease.RelativePath.LastIndexOf('/');
        bool initialTupleMatches;
        try
        {
            initialTupleMatches =
                SystemDirectoryBoundLeaseRejoinAuthorizationRules
                    .EvaluateInitialTupleInspection(
                        () => {
                            directoryCurrent = TryInspect(normalized);
                            leaseCurrent = TryInspect(lease.RelativePath);
                            return new BoundLeaseInitialInspection(
                                directoryCurrent is not null,
                                directoryCurrent?.Identity == directorySnapshot?.Identity,
                                leaseCurrent is not null,
                                leaseCurrent?.Identity == leaseSnapshot?.Identity);
                        },
                        directorySnapshot is not null,
                        slash > 0 && lease.RelativePath[..slash] == normalized,
                        !lease.FileObjectClosed,
                        leaseSnapshot is not null,
                        leaseFileObject is not null,
                        binding is not null,
                        binding?.RelativePath == lease.RelativePath,
                        binding?.Identity == leaseSnapshot?.Identity);
        }
        catch (GuardException error)
        {
            PoisonLocked(error.Code);
            return false;
        }
        if (!initialTupleMatches || directorySnapshot is null ||
            leaseSnapshot is null || leaseFileObject is null)
            return false;

        JobObject.RetainedProcessInspection processInspection;
        try
        {
            processInspection = job.InspectRetainedProcess(lease.Process);
        }
        catch (GuardException error)
        {
            PoisonLocked(
                SystemDirectoryBoundLeaseRejoinAuthorizationRules
                    .InitialProcessFailureCode(error.Code));
            return false;
        }
        var processTupleMatches =
            processInspection.ProcessId == lease.WorkerPid &&
            processInspection.ProcessStartKey == lease.ProcessStartKey &&
            processInspection.ProcessSequenceNumber == lease.ProcessSequenceNumber;
        var processFailure =
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.ProcessRejection(
                processTupleMatches,
                processInspection.Signaled,
                processInspection.JobMember,
                recheck: false);
        if (processFailure is not null)
        {
            PoisonLocked(processFailure);
            return false;
        }

        producerPid = lease.WorkerPid;
        producerSequenceNumber = lease.ProcessSequenceNumber;
        rejoinContext = new BoundLeaseDirectoryRejoinContext(
            phase,
            lease,
            normalized,
            directorySnapshot.Identity,
            lease.RelativePath,
            leaseSnapshot.Identity,
            leaseFileObject.Value,
            fileObject,
            phase.StartedAtQpc,
            lease.CurrentPathReservedAtQpc,
            lease.WorkerPid,
            lease.ProcessStartKey,
            lease.ProcessSequenceNumber);
        return true;
    }

    private string? RecheckBoundLeaseDirectoryTupleLocked(
        BoundLeaseDirectoryRejoinContext context,
        long eventQpc,
        ulong eventFileObject)
    {
        var phase = activePhase;
        var lease = pendingWriteLease;
        var activeLeaseMatches =
            ReferenceEquals(phase, context.Phase) &&
            ReferenceEquals(lease, context.Lease) &&
            phase is not null && lease is not null &&
            phase.Phase == "voice" &&
            phase.PhaseInstanceId == lease.PhaseInstanceId &&
            phase.StartedAtQpc == context.PhaseStartedAtQpc &&
            lease.CurrentPathReservedAtQpc == context.LeaseReservedAtQpc &&
            lease.RelativePath == context.LeasePath &&
            lease.FileObject == context.LeaseFileObject &&
            !lease.FileObjectClosed &&
            lease.Snapshot?.Identity == context.LeaseIdentity &&
            lease.WorkerPid == context.ProducerPid &&
            lease.ProcessStartKey == context.ProcessStartKey &&
            lease.ProcessSequenceNumber == context.ProducerSequenceNumber &&
            SystemDirectoryBoundLeaseRejoinAuthorizationRules.IsQpcOrderValid(
                phase.StartedAtQpc,
                lease.CurrentPathReservedAtQpc,
                eventQpc);
        var tupleFailure =
            SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .TupleRecheckFailure(
                    activeLeaseMatches, true, true, true, true, true);
        if (tupleFailure is not null) return tupleFailure;

        var eventFileObjectUnbound =
            eventFileObject == context.EventFileObject &&
            eventFileObject != 0 &&
            !filesByObject.ContainsKey(eventFileObject);
        tupleFailure = SystemDirectoryBoundLeaseRejoinAuthorizationRules
            .TupleRecheckFailure(
                true, eventFileObjectUnbound, true, true, true, true);
        if (tupleFailure is not null) return tupleFailure;

        var renameStateUnchanged =
            lease!.PendingRenamePath is null &&
            lease.RenameReservedAtQpc is null;
        tupleFailure = SystemDirectoryBoundLeaseRejoinAuthorizationRules
            .TupleRecheckFailure(
                true, true, renameStateUnchanged, true, true, true);
        if (tupleFailure is not null) return tupleFailure;

        FileSnapshot? directoryCurrent;
        try
        {
            directoryCurrent = TryInspect(context.DirectoryPath);
        }
        catch (GuardException)
        {
            return SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .TupleRecheckFailure(true, true, true, false, true, true);
        }
        var directoryIdentityMatches =
            filesByPath.GetValueOrDefault(context.DirectoryPath)?.Identity ==
                context.DirectoryIdentity &&
            directoryCurrent?.Identity == context.DirectoryIdentity;
        tupleFailure = SystemDirectoryBoundLeaseRejoinAuthorizationRules
            .TupleRecheckFailure(
                true, true, true, directoryIdentityMatches, true, true);
        if (tupleFailure is not null) return tupleFailure;

        FileSnapshot? leaseCurrent;
        try
        {
            leaseCurrent = TryInspect(context.LeasePath);
        }
        catch (GuardException)
        {
            return SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .TupleRecheckFailure(true, true, true, true, false, true);
        }
        var leaseCurrentIdentityMatches =
            leaseCurrent?.Identity == context.LeaseIdentity;
        tupleFailure = SystemDirectoryBoundLeaseRejoinAuthorizationRules
            .TupleRecheckFailure(
                true, true, true, true, leaseCurrentIdentityMatches, true);
        if (tupleFailure is not null) return tupleFailure;

        var binding = filesByObject.GetValueOrDefault(context.LeaseFileObject);
        var bindingMatches =
            binding is not null &&
            binding.RelativePath == context.LeasePath &&
            binding.Identity == context.LeaseIdentity;
        return SystemDirectoryBoundLeaseRejoinAuthorizationRules
            .TupleRecheckFailure(
                true, true, true, true, true, bindingMatches);
    }

    private string? RecheckBoundLeaseDirectoryProcessLocked(
        BoundLeaseDirectoryRejoinContext context)
    {
        JobObject.RetainedProcessInspection processInspection;
        try
        {
            processInspection = job.InspectRetainedProcess(context.Lease.Process);
        }
        catch (GuardException error)
        {
            return SystemDirectoryBoundLeaseRejoinAuthorizationRules
                .RecheckProcessFailureCode(error.Code);
        }
        var processTupleMatches =
            processInspection.ProcessId == context.ProducerPid &&
            processInspection.ProcessStartKey == context.ProcessStartKey &&
            processInspection.ProcessSequenceNumber ==
                context.ProducerSequenceNumber;
        return SystemDirectoryBoundLeaseRejoinAuthorizationRules.ProcessRejection(
            processTupleMatches,
            processInspection.Signaled,
            processInspection.JobMember,
            recheck: true);
    }

    private bool TryAuthorizeAfterLeaseReservationDirectoryWriteLocked(
        string eventName,
        int pid,
        string normalized,
        ulong fileObject,
        long timestampQpc,
        string authorizationFailure,
        out int producerPid,
        out ulong producerSequenceNumber,
        out AfterLeaseDirectoryRejoinContext? rejoinContext)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        rejoinContext = null;
        var phase = activePhase;
        var lease = pendingWriteLease;
        if (phase is null || lease is null) return false;
        string stage;
        try
        {
            stage = SystemDirectoryBoundLeaseWriteRejoinStage(
                normalized,
                timestampQpc);
        }
        catch (GuardException)
        {
            PoisonLocked("ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_TUPLE_INSPECTION_FAILED");
            return false;
        }
        if (stage != "RENAME_AFTER_LEASE_RESERVATION") return false;

        FileSnapshot? directoryCurrent;
        FileSnapshot? targetCurrent;
        try
        {
            directoryCurrent = TryInspect(normalized);
            targetCurrent = lease.PendingRenamePath is null
                ? null
                : TryInspect(lease.PendingRenamePath);
        }
        catch (GuardException)
        {
            PoisonLocked("ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_TUPLE_INSPECTION_FAILED");
            return false;
        }
        var leaseSnapshot = lease.Snapshot;
        var leaseFileObject = lease.FileObject;
        var binding = leaseFileObject is null
            ? null
            : filesByObject.GetValueOrDefault(leaseFileObject.Value);
        var targetTupleMatches =
            directoryCurrent is not null &&
            filesByPath.GetValueOrDefault(normalized)?.Identity == directoryCurrent.Identity &&
            lease.PendingRenamePath is not null &&
            targetCurrent is not null &&
            leaseSnapshot is not null &&
            targetCurrent.Identity == leaseSnapshot.Identity &&
            leaseFileObject is not null &&
            binding is not null &&
            binding.RelativePath == lease.RelativePath &&
            binding.Identity == leaseSnapshot.Identity;

        JobObject.RetainedProcessInspection processInspection;
        try
        {
            processInspection = job.InspectRetainedProcess(lease.Process);
        }
        catch (GuardException error)
        {
            var suffix = error.Code switch {
                "PROCESS_WAIT_FAILED" => "PROCESS_WAIT_FAILED",
                "JOB_QUERY_FAILED" => "JOB_QUERY_FAILED",
                _ => "PROCESS_IDENTITY_FAILED",
            };
            PoisonLocked($"ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_{suffix}");
            return false;
        }
        if (!processInspection.Signaled && !processInspection.JobMember)
        {
            PoisonLocked("ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_PROCESS_OUTSIDE_JOB");
            return false;
        }
        var processTupleMatches =
            processInspection.ProcessId == lease.WorkerPid &&
            processInspection.ProcessStartKey == lease.ProcessStartKey &&
            processInspection.ProcessSequenceNumber == lease.ProcessSequenceNumber;
        var canAuthorize =
            AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules.CanAuthorize(
                authorizationFailure,
                pid,
                eventName,
                fileObject,
                !filesByObject.ContainsKey(fileObject),
                phase.Phase == "voice",
                lease.PhaseInstanceId == phase.PhaseInstanceId,
                stage == "RENAME_AFTER_LEASE_RESERVATION",
                AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules
                    .IsCandidateTimestamp(
                        timestampQpc,
                        lease.CurrentPathReservedAtQpc,
                        lease.RenameReservedAtQpc ?? 0),
                targetTupleMatches,
                processTupleMatches,
                processInspection.Signaled,
                processInspection.JobMember,
                targetTupleMatches);
        if (!canAuthorize || leaseSnapshot is null || leaseFileObject is null ||
            lease.PendingRenamePath is null || directoryCurrent is null)
            return false;

        producerPid = lease.WorkerPid;
        producerSequenceNumber = lease.ProcessSequenceNumber;
        rejoinContext = new AfterLeaseDirectoryRejoinContext(
            phase,
            lease.Process,
            normalized,
            directoryCurrent.Identity,
            lease.RelativePath,
            lease.PendingRenamePath,
            leaseSnapshot.Identity,
            leaseFileObject.Value,
            fileObject,
            lease.CurrentPathReservedAtQpc,
            lease.RenameReservedAtQpc ?? throw new GuardException(
                "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_BINDING_MISMATCH"),
            lease.WorkerPid,
            lease.ProcessStartKey,
            lease.ProcessSequenceNumber);
        return true;
    }

    private string? RecheckAfterLeaseDirectoryRejoinLocked(
        AfterLeaseDirectoryRejoinContext context)
    {
        FileSnapshot? directoryCurrent;
        try
        {
            directoryCurrent = TryInspect(context.DirectoryPath);
        }
        catch (GuardException)
        {
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_DIRECTORY_IDENTITY_MISMATCH";
        }
        if (directoryCurrent?.Identity != context.DirectoryIdentity)
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_DIRECTORY_IDENTITY_MISMATCH";
        try
        {
            if (TryInspect(context.LeasePath) is not null)
                return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_LEASE_CURRENT_EXISTS";
        }
        catch (GuardException)
        {
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_LEASE_CURRENT_EXISTS";
        }
        FileSnapshot? targetCurrent;
        try
        {
            targetCurrent = TryInspect(context.PendingTargetPath);
        }
        catch (GuardException)
        {
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_TARGET_IDENTITY_MISMATCH";
        }
        if (targetCurrent?.Identity != context.LeaseIdentity)
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_TARGET_IDENTITY_MISMATCH";
        var binding = filesByObject.GetValueOrDefault(context.LeaseFileObject);
        if (binding is null ||
            binding.RelativePath != context.LeasePath ||
            binding.Identity != context.LeaseIdentity)
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_BINDING_MISMATCH";
        return null;
    }

    private string? RecheckAfterLeaseDirectoryProcessLocked(
        AfterLeaseDirectoryRejoinContext context)
    {
        JobObject.RetainedProcessInspection inspection;
        try
        {
            inspection = job.InspectRetainedProcess(context.Process);
        }
        catch (GuardException error)
        {
            var suffix = error.Code switch {
                "PROCESS_WAIT_FAILED" => "PROCESS_WAIT_FAILED",
                "JOB_QUERY_FAILED" => "JOB_QUERY_FAILED",
                _ => "PROCESS_IDENTITY_FAILED",
            };
            return $"ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_{suffix}";
        }
        if (inspection.ProcessId != context.ProducerPid ||
            inspection.ProcessStartKey != context.ProcessStartKey ||
            inspection.ProcessSequenceNumber != context.ProducerSequenceNumber)
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_PROCESS_IDENTITY_FAILED";
        if (!inspection.Signaled && !inspection.JobMember)
            return "ETW_SYSTEM_DIRECTORY_AFTER_LEASE_REJOIN_PROCESS_OUTSIDE_JOB";
        return null;
    }

    private bool BindReservedSystemSetInfoLocked(
        int pid,
        ulong producerSequenceNumber,
        string normalized,
        ulong fileObject,
        long timestampQpc,
        FileSnapshot snapshot)
    {
        var lease = pendingWriteLease;
        if (lease is null ||
            deferredSystemSetInfos.Count == 0 ||
            deferredSystemSetInfos.Any(item =>
                !SystemSetInfoCorrelationRules.CanBindDeferred(
                    lease.FileObjectClosed,
                    lease.WorkerPid == pid &&
                        lease.ProcessSequenceNumber == producerSequenceNumber,
                    item.PhaseInstanceId == lease.PhaseInstanceId &&
                        item.RelativePath == normalized &&
                        lease.RelativePath == normalized,
                    fileObject,
                    item.FileObject,
                    lease.ReservedAtQpc,
                    timestampQpc,
                    item.TimestampQpc,
                    snapshot.Identity,
                    item.Snapshot.Identity)))
            return false;
        lease.FileObject = fileObject;
        lease.Snapshot = snapshot;
        foreach (var deferred in SystemSetInfoCorrelationRules.ReplayInEtwOrder(
            deferredSystemSetInfos,
            item => item.EtwSequence))
            ReplayDeferredSystemSetInfoLocked(deferred);
        deferredSystemSetInfos.Clear();
        return true;
    }

    private void ReplayDeferredSystemSetInfoLocked(DeferredSystemSetInfoRecord deferred)
    {
        filesByObject[deferred.FileObject] = deferred.Snapshot;
        filesByPath[deferred.RelativePath] = deferred.Snapshot;
        var oldAllocated = allocatedByIdentity.GetValueOrDefault(deferred.Snapshot.Identity);
        allocatedByIdentity[deferred.Snapshot.Identity] = deferred.Snapshot.AllocatedLengthBytes;
        if (deferred.Snapshot.AllocatedLengthBytes == 0)
            allocatedByIdentity.Remove(deferred.Snapshot.Identity);
        var delta = checked(deferred.Snapshot.AllocatedLengthBytes - oldAllocated);
        var live = CurrentLiveBytes();
        peakLiveBytes = Math.Max(peakLiveBytes, live);
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, deferred.FreeBytes);
        observations.Add(new ObservationRecord(
            "setinfo",
            deferred.RelativePath,
            null,
            null,
            deferred.Phase,
            deferred.WorkId,
            deferred.PhaseInstanceId,
            deferred.EtwSequence,
            deferred.ObservedAt,
            deferred.WorkerPid,
            deferred.ProducerSequenceNumber,
            deferred.Snapshot.VolumeId,
            deferred.Snapshot.FileId128,
            deferred.Snapshot.LogicalLengthBytes,
            deferred.Snapshot.AllocatedLengthBytes,
            delta,
            live,
            deferred.FreeBytes,
            deferred.TotalFreeBytes,
            producerBinarySha256));
    }

    private static string ClassifyEtwGuardFailure(
        string code,
        string eventName,
        string stage)
    {
        if (code != "ETW_FILE_IDENTITY_MISSING") return code;
        var safeEvent = eventName switch {
            "create" => "CREATE",
            "write" => "WRITE",
            "setinfo" => "SETINFO",
            "rename" => "RENAME",
            "delete" => "DELETE",
            _ => "UNKNOWN",
        };
        var safeStage = stage switch {
            "IDENTITY" => "IDENTITY",
            "CORRELATION" => "CORRELATION",
            _ => "UNKNOWN",
        };
        return $"ETW_FILE_IDENTITY_MISSING_{safeEvent}_{safeStage}";
    }

    private static string ClassifyEtwCallbackFailure(Exception error, string stage) =>
        error switch {
            UnauthorizedAccessException => "ETW_CALLBACK_ACCESS_FAILED",
            IOException => "ETW_CALLBACK_IO_FAILED",
            OverflowException => "ETW_CALLBACK_OVERFLOW",
            ObjectDisposedException => "ETW_CALLBACK_DISPOSED",
            InvalidOperationException => "ETW_CALLBACK_STATE_FAILED",
            ArgumentException => "ETW_CALLBACK_ARGUMENT_FAILED",
            _ => stage switch {
                "IDENTITY" => "ETW_CALLBACK_IDENTITY_FAILED",
                "STATE" => "ETW_CALLBACK_LOCK_STATE_FAILED",
                "AUTHORIZATION" => "ETW_CALLBACK_AUTHORIZATION_FAILED",
                "PHASE" => "ETW_CALLBACK_PHASE_FAILED",
                "CORRELATION" => "ETW_CALLBACK_CORRELATION_FAILED",
                "CAPACITY" => "ETW_CALLBACK_CAPACITY_FAILED",
                "RECORD" => "ETW_CALLBACK_RECORD_FAILED",
                "JOURNAL" => "ETW_CALLBACK_JOURNAL_FAILED",
                _ => "ETW_CALLBACK_NORMALIZE_FAILED",
            },
        };

    private void CompleteDeferredRename(
        DeferredRenameRecord deferred,
        NoticeRecord notice,
        long? observedFreeBytes = null)
    {
        if (notice.EventName != "rename" ||
            notice.From != deferred.Source.RelativePath ||
            notice.To is null ||
            (deferred.ObservedTarget is not null && deferred.ObservedTarget != notice.To))
        {
            throw new GuardException("ETW_RENAME_IDENTITY_MISMATCH");
        }
        var target = InspectDeferredRenameTarget(notice.To);
        if (target.Identity != deferred.Source.Identity)
            throw new GuardException("ETW_RENAME_IDENTITY_MISMATCH");

        var oldAllocated = allocatedByIdentity.GetValueOrDefault(deferred.Source.Identity);
        var delta = checked(target.AllocatedLengthBytes - oldAllocated);
        var live = checked(CurrentLiveBytes() - oldAllocated + target.AllocatedLengthBytes);
        var free = observedFreeBytes ?? ReadFreeBytes(root);
        allocatedByIdentity[target.Identity] = target.AllocatedLengthBytes;
        peakLiveBytes = Math.Max(peakLiveBytes, live);
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
        foreach (var objectId in filesByObject
            .Where(pair => pair.Value.Identity == deferred.Source.Identity)
            .Select(pair => pair.Key)
            .ToArray())
        {
            filesByObject[objectId] = target;
        }
        filesByPath.Remove(deferred.Source.RelativePath);
        filesByPath[target.RelativePath] = target;

        var sequence = deferred.EtwSequence;
        var observation = new ObservationRecord(
            "rename",
            null,
            notice.From,
            notice.To,
            deferred.Phase,
            deferred.WorkId,
            deferred.PhaseInstanceId,
            sequence,
            deferred.ObservedAt,
            deferred.WorkerPid,
            deferred.ProducerSequenceNumber,
            target.VolumeId,
            target.FileId128,
            target.LogicalLengthBytes,
            target.AllocatedLengthBytes,
            delta,
            live,
            free,
            new DriveInfo(Path.GetPathRoot(root)!).TotalFreeSpace,
            producerBinarySha256);
        notice.Match(sequence);
        observation.NoticeSequence = notice.NoticeSequence;
        observations.Add(observation);
        deferredRenames.Remove(deferred);
        Monitor.PulseAll(gate);
    }

    private void CompleteDeferredRenameFromSnapshot(
        DeferredRenameRecord deferred,
        NoticeRecord notice,
        FileSnapshot? observedTarget,
        long observedFreeBytes,
        long totalFreeBytes)
    {
        if (notice.EventName != "rename" ||
            notice.From != deferred.Source.RelativePath ||
            notice.To is null ||
            deferred.ObservedTarget is not null &&
                deferred.ObservedTarget != notice.To)
            throw new GuardException("ETW_RENAME_IDENTITY_MISMATCH");
        if (observedTarget is null ||
            observedTarget.RelativePath != notice.To ||
            observedTarget.Identity != deferred.Source.Identity)
            throw new GuardException("ETW_RENAME_IDENTITY_MISMATCH");
        var target = observedTarget;
        var oldAllocated = allocatedByIdentity.GetValueOrDefault(
            deferred.Source.Identity);
        var delta = checked(target.AllocatedLengthBytes - oldAllocated);
        var live = checked(
            CurrentLiveBytes() - oldAllocated + target.AllocatedLengthBytes);
        allocatedByIdentity[target.Identity] = target.AllocatedLengthBytes;
        if (target.AllocatedLengthBytes == 0)
            allocatedByIdentity.Remove(target.Identity);
        peakLiveBytes = Math.Max(peakLiveBytes, live);
        minimumObservedFreeBytes = Math.Min(
            minimumObservedFreeBytes,
            observedFreeBytes);
        foreach (var objectId in filesByObject
            .Where(pair => pair.Value.Identity == deferred.Source.Identity)
            .Select(pair => pair.Key)
            .ToArray())
            filesByObject[objectId] = target;
        filesByPath.Remove(deferred.Source.RelativePath);
        filesByPath[target.RelativePath] = target;
        var observation = new ObservationRecord(
            "rename",
            null,
            notice.From,
            notice.To,
            deferred.Phase,
            deferred.WorkId,
            deferred.PhaseInstanceId,
            deferred.EtwSequence,
            deferred.ObservedAt,
            deferred.WorkerPid,
            deferred.ProducerSequenceNumber,
            target.VolumeId,
            target.FileId128,
            target.LogicalLengthBytes,
            target.AllocatedLengthBytes,
            delta,
            live,
            observedFreeBytes,
            totalFreeBytes,
            producerBinarySha256);
        notice.Match(deferred.EtwSequence);
        observation.NoticeSequence = notice.NoticeSequence;
        observations.Add(observation);
        deferredRenames.Remove(deferred);
        Monitor.PulseAll(gate);
    }

    private FileSnapshot InspectDeferredRenameTarget(string path)
    {
        try
        {
            return TryInspect(path)
                ?? throw new GuardException("ETW_FILE_IDENTITY_MISSING");
        }
        catch (GuardException error) when (error.Code == "ETW_FILE_IDENTITY_MISSING")
        {
            throw new GuardException(ClassifyEtwGuardFailure(
                error.Code,
                "rename",
                "CORRELATION"));
        }
    }

    private FileSnapshot? TryInspect(string relativePath)
    {
        var absolute = Path.GetFullPath(Path.Combine(root,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        EnsureWithinRoot(root, absolute);
        using var handle = CreateFileW(
            absolute,
            0,
            0x00000001 | 0x00000002 | 0x00000004,
            IntPtr.Zero,
            3,
            0x02000000 | 0x00200000,
            IntPtr.Zero);
        if (handle.IsInvalid) return null;
        if (!GetFileInformationByHandle(handle, out var basic))
            throw new GuardException("ETW_FILE_IDENTITY_MISSING");
        if ((basic.FileAttributes & 0x00000400) != 0 || basic.NumberOfLinks != 1)
            throw new GuardException("ETW_FILE_IDENTITY_UNSAFE");
        var id = new FileIdInfo { FileId = new byte[16] };
        if (!GetFileInformationByHandleEx(handle, 18, ref id, (uint)Marshal.SizeOf<FileIdInfo>()))
            throw new GuardException("ETW_FILE_IDENTITY_MISSING");
        var logical = checked(((long)basic.FileSizeHigh << 32) | basic.FileSizeLow);
        var low = GetCompressedFileSizeW(absolute, out var high);
        if (low == uint.MaxValue && Marshal.GetLastWin32Error() != 0)
            throw new GuardException("ETW_ALLOCATED_LENGTH_MISSING");
        var allocated = checked(((long)high << 32) | low);
        var fileId = Convert.ToHexStringLower(id.FileId);
        return new FileSnapshot(
            relativePath,
            $"{id.VolumeSerialNumber:x16}:{fileId}",
            id.VolumeSerialNumber.ToString("x16"),
            fileId,
            logical,
            allocated);
    }

    private RetainedFileIdentityLease RetainIdentity(
        string relativePath,
        string expectedIdentity)
    {
        if (writeCompletionGenerationHandles.Count +
                writeCompletionSeals.Count * 2 >= MaxWriteCompletionRetainedHandles)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        var absolute = Path.GetFullPath(Path.Combine(root,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        EnsureWithinRoot(root, absolute);
        return RetainedFileIdentityLease.OpenVerified(
            absolute,
            expectedIdentity);
    }

    private void EnsureWriteCompletionLedgerLocked()
    {
        if (writeCompletionBindingLedger is not null) return;
        if (filesByObject.Count > MaxWriteCompletionLedgerEntries)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        var baseline = filesByObject
            .OrderBy(item => item.Key)
            .Select(item => (
                item.Key,
                item.Value.Identity,
                item.Value.RelativePath))
            .ToArray();
        var acquired = new List<((ulong FileObject, long Generation) Key,
            RetainedFileIdentityLease Handle)>();
        try
        {
            foreach (var item in baseline)
            {
                var retained = RetainIdentity(item.RelativePath, item.Identity);
                acquired.Add(((item.Key, 1), retained));
            }
            writeCompletionBindingLedger = new WriteCompletionBindingLedger(baseline);
            foreach (var item in acquired)
                writeCompletionReplayStore.AddGenerationHandle(
                    item.Key,
                    item.Handle);
        }
        catch (OverflowException)
        {
            foreach (var item in acquired) item.Handle.Dispose();
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        }
        catch
        {
            foreach (var item in acquired) item.Handle.Dispose();
            throw;
        }
    }

    private RetainedFileIdentityLease EnsureGenerationHandleLocked(
        ImmutableBindingProof proof,
        string relativePath,
        string expectedIdentity)
    {
        var key = (proof.FileObject, proof.GenerationAfter);
        if (writeCompletionGenerationHandles.TryGetValue(key, out var existing))
        {
            existing.Reinspect(expectedIdentity);
            return existing;
        }
        if (writeCompletionGenerationHandles.Count >=
            MaxWriteCompletionLedgerEntries)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        var retained = RetainIdentity(relativePath, expectedIdentity);
        writeCompletionReplayStore.AddGenerationHandle(key, retained);
        return retained;
    }

    internal sealed class RetainedFileIdentityLease : IDisposable
    {
        private const uint ShareRead = 0x00000001;
        private const uint ShareWrite = 0x00000002;
        private const uint ShareDelete = 0x00000004;
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private SafeFileHandle? handle;
        private readonly string expectedIdentity;

        private RetainedFileIdentityLease(
            SafeFileHandle handle,
            string expectedIdentity)
        {
            this.handle = handle;
            this.expectedIdentity = expectedIdentity;
        }

        // @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
        // actual handleのopen、初回identity検査、ownership移譲を単一factoryに固定する。
        internal static RetainedFileIdentityLease OpenVerified(
            string absolutePath,
            string expectedIdentity)
        {
            SafeFileHandle? acquired = CreateFileW(
                absolutePath,
                0,
                ShareRead | ShareWrite | ShareDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            try
            {
                if (acquired.IsInvalid)
                    throw IdentityFailure();
                var retained = new RetainedFileIdentityLease(
                    acquired,
                    expectedIdentity);
                acquired = null;
                try
                {
                    retained.ReinspectInitial();
                    return retained;
                }
                catch
                {
                    retained.Dispose();
                    throw;
                }
            }
            finally
            {
                acquired?.Dispose();
            }
        }

        public string Reinspect(string? additionallyExpected = null) =>
            ReinspectCore(additionallyExpected, requireSingleLink: false);

        private string ReinspectInitial() =>
            ReinspectCore(null, requireSingleLink: true);

        private string ReinspectCore(
            string? additionallyExpected,
            bool requireSingleLink)
        {
            var current = handle;
            if (current is null || current.IsInvalid || current.IsClosed ||
                !GetFileInformationByHandle(current, out var basic) ||
                (basic.FileAttributes & FileAttributeReparsePoint) != 0 ||
                requireSingleLink && basic.NumberOfLinks != 1 ||
                !requireSingleLink && basic.NumberOfLinks > 1)
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
            var id = new FileIdInfo { FileId = new byte[16] };
            if (!GetFileInformationByHandleEx(
                current,
                18,
                ref id,
                (uint)Marshal.SizeOf<FileIdInfo>()))
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
            var identity = $"{id.VolumeSerialNumber:x16}:" +
                Convert.ToHexStringLower(id.FileId);
            if (identity != expectedIdentity ||
                additionallyExpected is not null && identity != additionallyExpected)
                throw new GuardException(
                    "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
            return identity;
        }

        public void Dispose() => Interlocked.Exchange(ref handle, null)?.Dispose();

        private static GuardException IdentityFailure() => new(
            "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED");
    }

    private string CompletedWriteDiagnosticState(string relativePath)
    {
        if (!completedWrites.TryGetValue(relativePath, out var completed))
            return CompletedWriteDiagnosticRules.Classify(
                activePhase?.Phase,
                tracked: false,
                currentExists: false,
                identityMatches: false);
        var current = TryInspect(relativePath);
        return CompletedWriteDiagnosticRules.Classify(
            activePhase?.Phase,
            tracked: true,
            currentExists: current is not null,
            identityMatches: current?.Identity == completed.Identity);
    }

    private string SystemUnboundWriteKnownPathFailure(
        string normalized,
        ulong fileObject,
        long timestampQpc)
    {
        if (fileObject == 0)
            return "SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_" +
                SystemUnboundWriteDiagnosticRules.Classify(
                    false, false, false, false, false, false, "NO_LEASE");
        var lease = pendingWriteLease;
        var leaseMatches = activePhase is not null &&
            lease is not null &&
            lease.PhaseInstanceId == activePhase.PhaseInstanceId &&
            lease.RelativePath == normalized;
        if (leaseMatches)
        {
            if (lease!.Snapshot is null)
                return "SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_" +
                    SystemUnboundWriteDiagnosticRules.Classify(
                        true, true, lease.FileObjectClosed, false, false, false, "NO_LEASE");
            var current = TryInspect(normalized);
            return "SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_" +
                SystemUnboundWriteDiagnosticRules.Classify(
                    true,
                    true,
                    lease.FileObjectClosed,
                    true,
                    current is not null,
                    current?.Identity == lease.Snapshot.Identity,
                    "NO_LEASE");
        }
        var completedStage = SystemUnboundWriteDiagnosticRules.Classify(
            true,
            false,
            false,
            false,
            false,
            false,
            CompletedWriteDiagnosticState(normalized));
        if (completedStage != "OTHER_KNOWN_PATH")
            return "SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_" +
                completedStage;
        var absolute = Path.Combine(
            root,
            normalized.Replace('/', Path.DirectorySeparatorChar));
        var bucket = SystemSetInfoDiagnosticRules.Classify(
                normalized,
                File.Exists(absolute),
                Directory.Exists(absolute),
                pendingWriteLease is not null,
                pendingWriteLease?.FileObject is not null,
                "NO_LEASE");
        if (bucket == "CACHE_OTHER_DIRECTORY_NO_LEASE")
            return "SYSTEM_DIRECTORY_WRITE_REJOIN_" +
                SystemDirectoryWriteRejoinStage(normalized);
        if (bucket == "CACHE_OTHER_DIRECTORY_UNBOUND_LEASE")
            return "SYSTEM_DIRECTORY_ACTIVE_LEASE_WRITE_REJOIN_" +
                SystemDirectoryActiveLeaseWriteRejoinStage(normalized);
        if (bucket == "CACHE_OTHER_DIRECTORY_BOUND_LEASE")
        {
            var stage = SystemDirectoryBoundLeaseWriteRejoinStage(
                normalized,
                timestampQpc);
            if (stage.StartsWith("RENAME_", StringComparison.Ordinal))
                return "SYSTEM_DIRECTORY_BOUND_LEASE_RENAME_WRITE_REJOIN_" +
                    stage["RENAME_".Length..];
            return "SYSTEM_DIRECTORY_BOUND_LEASE_WRITE_REJOIN_" + stage;
        }
        return "SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_" + bucket;
    }

    private string SystemBoundFileObjectRejoinStage(
        string normalized,
        ulong fileObject,
        long timestampQpc)
    {
        if (!filesByObject.TryGetValue(fileObject, out var snapshot))
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                false, false, false, false, false, false, false, false, false);
        if (snapshot.RelativePath != normalized)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, false, false, false, false, false, false, false, false);
        var current = TryInspect(normalized);
        if (current is null)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, true, false, false, false, false, false, false, false);
        if (current.Identity != snapshot.Identity)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, true, true, false, false, false, false, false, false);
        var lease = pendingWriteLease;
        if (lease is null)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, true, true, true, false, false, false, false, false);
        var phaseMatches = activePhase is not null &&
            lease.PhaseInstanceId == activePhase.PhaseInstanceId;
        if (!phaseMatches)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, true, true, true, true, false, false, false, false);
        if (lease.RelativePath != normalized)
        {
            var leasePathStage =
                SystemBoundFileObjectRenameLeasePathDiagnosticStage(
                    normalized,
                    fileObject,
                    timestampQpc,
                    snapshot,
                    lease);
            return leasePathStage.StartsWith("NO_PENDING_", StringComparison.Ordinal)
                ? leasePathStage
                : "RENAME_LEASE_PATH_" + leasePathStage;
        }
        if (lease.FileObject != fileObject)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, true, true, true, true, true, false, false, false);
        if (lease.FileObjectClosed)
            return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
                true, true, true, true, true, true, true, true, false);
        var leaseOutsideJob = job.IsAliveOutsideJob(lease.Process);
        return SystemBoundFileObjectRejoinDiagnosticRules.Classify(
            true, true, true, true, true, true, true, false, leaseOutsideJob);
    }

    private string SystemBoundFileObjectRenameLeasePathDiagnosticStage(
        string normalized,
        ulong fileObject,
        long timestampQpc,
        FileSnapshot observedSnapshot,
        PendingWriteLease lease)
    {
        var target = lease.PendingRenamePath;
        if (target is null)
            return SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticStage(
                normalized,
                lease,
                timestampQpc);
        if (!string.Equals(normalized, target, StringComparison.Ordinal))
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, false, false, false, false, false, false,
                false, false, false, false, false, false);
        var renameReservationQpc = lease.RenameReservedAtQpc;
        if (renameReservationQpc is null or <= 0)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, false, false, false, false, false,
                false, false, false, false, false, false);
        var reservationOrderValid =
            renameReservationQpc.Value > lease.CurrentPathReservedAtQpc;
        if (!reservationOrderValid)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, false, false, false, false,
                false, false, false, false, false, false);
        var timeStage =
            SystemBoundFileObjectRenameLeasePathDiagnosticRules.ClassifyTimeRelation(
                timestampQpc,
                lease.CurrentPathReservedAtQpc,
                renameReservationQpc.Value);
        if (timeStage == "BEFORE_LEASE_RESERVATION")
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, false, false, false,
                false, false, false, false, false, false);
        if (timeStage == "AFTER_LEASE_RESERVATION")
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, false, false,
                false, false, false, false, false, false);
        var leaseCurrent = TryInspect(lease.RelativePath);
        if (leaseCurrent is not null)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, true, true,
                false, false, false, false, false, false);
        if (lease.Snapshot is null)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, true, false,
                false, false, false, false, false, false);
        if (lease.Snapshot.RelativePath != lease.RelativePath)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, true, false,
                true, false, false, false, false, false);
        if (lease.Snapshot.Identity != observedSnapshot.Identity)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, true, false,
                true, true, false, false, false, false);
        if (lease.FileObject != fileObject)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, true, false,
                true, true, true, false, false, false);
        if (lease.FileObjectClosed)
            return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
                true, true, true, true, true, true, false,
                true, true, true, true, true, false);
        var leaseOutsideJob = job.IsAliveOutsideJob(lease.Process);
        return SystemBoundFileObjectRenameLeasePathDiagnosticRules.Classify(
            true, true, true, true, true, true, false,
            true, true, true, true, false, leaseOutsideJob);
    }

    private string SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticStage(
        string normalized,
        PendingWriteLease lease,
        long eventQpc)
    {
        static string Classify(
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

        var absolute = Path.Combine(
            root,
            normalized.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(absolute)) return Classify(pathIsFile: true);
        if (!Directory.Exists(absolute))
            return Classify(pathIsDirectory: false);

        var directoryStage = SystemDirectoryWriteRejoinStage(normalized);
        if (directoryStage != "CANDIDATE")
            return Classify(directoryStage: directoryStage);

        if (!ReferenceEquals(pendingWriteLease, lease) ||
            activePhase is null ||
            lease.PhaseInstanceId != activePhase.PhaseInstanceId)
            return Classify(leaseStateStable: false);
        var slash = lease.RelativePath.LastIndexOf('/');
        if (slash <= 0 || lease.RelativePath[..slash] != normalized)
            return Classify(leaseParentMatches: false);
        if (lease.FileObjectClosed) return Classify(leaseClosed: true);
        if (lease.FileObject is null)
            return "NO_PENDING_" +
                SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticStage(
                    lease,
                    eventQpc);
        if (lease.Snapshot is null)
            return Classify(leaseSnapshotAvailable: false);
        var binding = filesByObject.GetValueOrDefault(lease.FileObject.Value);
        if (binding is null) return Classify(leaseBindingAvailable: false);
        if (lease.Snapshot.RelativePath != lease.RelativePath ||
            binding.RelativePath != lease.RelativePath ||
            binding.Identity != lease.Snapshot.Identity)
            return Classify(leaseBindingMatches: false);
        var current = TryInspect(lease.RelativePath);
        if (current is null) return Classify(leaseCurrentExists: false);
        if (current.Identity != lease.Snapshot.Identity)
            return Classify(leaseIdentityMatches: false);
        if (job.IsAliveOutsideJob(lease.Process))
            return Classify(leaseOutsideJob: true);
        return Classify();
    }

    private string SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticStage(
        PendingWriteLease lease,
        long eventQpc)
    {
        var phase = activePhase!;
        var deferred = deferredSystemSetInfos.Select(item =>
            new SystemBoundFileObjectNoPendingUnboundLeaseDeferred(
                item.WorkerPid,
                item.ProducerSequenceNumber,
                item.Phase,
                item.WorkId,
                item.PhaseInstanceId,
                item.RelativePath,
                item.Snapshot.RelativePath,
                item.Snapshot.Identity,
                item.FileObject,
                !filesByObject.ContainsKey(item.FileObject),
                item.TimestampQpc));
        var inspection =
            SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
                .CreateProduction(
                    relativePath => TryInspect(relativePath) is { } current
                        ? new SystemBoundFileObjectNoPendingUnboundLeaseCurrent(
                            current.Identity)
                        : null,
                    () => {
                        var current = job.InspectRetainedProcess(lease.Process);
                        return new SystemBoundFileObjectNoPendingUnboundLeaseProcess(
                            current.ProcessId,
                            current.ProcessStartKey,
                            current.ProcessSequenceNumber,
                            current.Signaled,
                            current.JobMember);
                    });
        return SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticEvaluator.Evaluate(
            new SystemBoundFileObjectNoPendingUnboundLeaseState(
                lease.RelativePath,
                lease.Snapshot is not null,
                lease.WorkerPid,
                lease.ProcessStartKey,
                lease.ProcessSequenceNumber,
                lease.PhaseInstanceId,
                lease.CurrentPathReservedAtQpc),
            new SystemBoundFileObjectNoPendingUnboundLeasePhase(
                phase.Phase,
                phase.WorkId,
                phase.PhaseInstanceId),
            deferred,
            eventQpc,
            inspection);
    }

    private string SystemDirectoryWriteRejoinStage(string normalized)
    {
        var snapshot = filesByPath.GetValueOrDefault(normalized);
        if (snapshot is null)
            return SystemDirectoryWriteRejoinDiagnosticRules.Classify(
                false, false, false, false, false);
        var current = TryInspect(normalized);
        if (current is null)
            return SystemDirectoryWriteRejoinDiagnosticRules.Classify(
                true, false, false, false, false);
        if (current.Identity != snapshot.Identity)
            return SystemDirectoryWriteRejoinDiagnosticRules.Classify(
                true, true, false, false, false);
        var rootPid = rootWorkerPid;
        var rootSequence = rootWorkerSequenceNumber;
        var ownerMatches = activePhase is not null &&
            rootPid is not null &&
            rootSequence is not null and not 0 &&
            observations.Any(item =>
                item.EventName == "create" &&
                item.Path == normalized &&
                item.PhaseInstanceId == activePhase.PhaseInstanceId &&
                item.WorkerPid == rootPid &&
                item.ProducerSequenceNumber == rootSequence &&
                $"{item.VolumeId}:{item.FileId128}" == snapshot.Identity);
        if (!ownerMatches)
            return SystemDirectoryWriteRejoinDiagnosticRules.Classify(
                true, true, true, false, false);
        return SystemDirectoryWriteRejoinDiagnosticRules.Classify(
            true,
            true,
            true,
            true,
            RootWorkerAliveLocked(rootPid ?? -1));
    }

    private string SystemDirectoryActiveLeaseWriteRejoinStage(
        string normalized)
    {
        var directoryStage = SystemDirectoryWriteRejoinStage(normalized);
        if (directoryStage != "CANDIDATE")
            return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, false, false, false, false, false, false);
        var lease = pendingWriteLease;
        if (lease is null)
            return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, false, false, false, false, false, false);
        var phaseMatches = activePhase is not null &&
            lease.PhaseInstanceId == activePhase.PhaseInstanceId;
        if (!phaseMatches)
            return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, false, false, false, false, false);
        var slash = lease.RelativePath.LastIndexOf('/');
        var parentMatches = slash > 0 &&
            lease.RelativePath[..slash] == normalized;
        if (!parentMatches)
            return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, false, false, false, false);
        if (lease.FileObject is not null)
            return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, true, false, false);
        if (lease.FileObjectClosed)
            return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, false, true, false);
        var leaseOutsideJob = job.IsAliveOutsideJob(lease.Process);
        return SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules.Classify(
            directoryStage,
            true,
            true,
            true,
            false,
            false,
            leaseOutsideJob);
    }

    private string SystemDirectoryBoundLeaseWriteRejoinStage(
        string normalized,
        long timestampQpc)
    {
        var directoryStage = SystemDirectoryWriteRejoinStage(normalized);
        if (directoryStage != "CANDIDATE")
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, false, false, false, false, false,
                false, false, false, false, false, false);
        var lease = pendingWriteLease;
        if (lease is null)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, false, false, false, false, false,
                false, false, false, false, false, false);
        var phaseMatches = activePhase is not null &&
            lease.PhaseInstanceId == activePhase.PhaseInstanceId;
        if (!phaseMatches)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, false, false, false, false,
                false, false, false, false, false, false);
        var slash = lease.RelativePath.LastIndexOf('/');
        var parentMatches = slash > 0 &&
            lease.RelativePath[..slash] == normalized;
        if (!parentMatches)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, false, false, false,
                false, false, false, false, false, false);
        if (lease.FileObjectClosed)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, false, true,
                false, false, false, false, false, false);
        if (lease.FileObject is null)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, false, false,
                false, false, false, false, false, false);
        if (lease.Snapshot is null)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, true, false,
                false, false, false, false, false, false);
        var binding = filesByObject.GetValueOrDefault(lease.FileObject.Value);
        if (binding is null)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, true, false,
                true, false, false, false, false, false);
        var bindingMatches = lease.Snapshot.RelativePath == lease.RelativePath &&
            binding.RelativePath == lease.RelativePath &&
            binding.Identity == lease.Snapshot.Identity;
        if (!bindingMatches)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, true, false,
                true, true, false, false, false, false);
        var current = TryInspect(lease.RelativePath);
        if (current is null)
            return "RENAME_" + SystemDirectoryBoundLeaseRenameDiagnosticStage(
                normalized,
                lease,
                timestampQpc);
        if (current.Identity != lease.Snapshot.Identity)
            return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
                directoryStage, true, true, true, true, false,
                true, true, true, true, false, false);
        var leaseOutsideJob = job.IsAliveOutsideJob(lease.Process);
        return SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules.Classify(
            directoryStage, true, true, true, true, false,
            true, true, true, true, true, leaseOutsideJob);
    }

    private string SystemDirectoryBoundLeaseRenameDiagnosticStage(
        string normalized,
        PendingWriteLease lease,
        long timestampQpc)
    {
        var target = lease.PendingRenamePath;
        if (target is null)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                false, false, false, false, false, false, false, false);
        var slash = target.LastIndexOf('/');
        var parentMatches = slash > 0 && target[..slash] == normalized;
        if (!parentMatches)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                true, false, false, false, false, false, false, false);
        var reservation = lease.RenameReservedAtQpc;
        if (reservation is null or <= 0)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                true, true, false, false, false, false, false, false);
        var afterLeaseReservation = timestampQpc > lease.CurrentPathReservedAtQpc;
        if (!afterLeaseReservation)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                true, true, true, false, false, false, false, false);
        var afterRenameReservation = timestampQpc > reservation.Value;
        if (!afterRenameReservation)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                true, true, true, true, false, false, false, false);
        var current = TryInspect(target);
        if (current is null)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                true, true, true, true, true, false, false, false);
        if (current.Identity != lease.Snapshot!.Identity)
            return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
                true, true, true, true, true, true, false, false);
        var leaseOutsideJob = job.IsAliveOutsideJob(lease.Process);
        return SystemDirectoryBoundLeaseRenameDiagnosticRules.Classify(
            true, true, true, true, true, true, true, leaseOutsideJob);
    }

    private string? NormalizeObservedPath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value)) return null;
        string full;
        try
        {
            full = Path.GetFullPath(value);
        }
        catch
        {
            return null;
        }
        var relative = Path.GetRelativePath(root, full);
        if (relative == "." || relative == ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            Path.IsPathFullyQualified(relative))
        {
            return null;
        }
        return ValidateRelativePath(relative.Replace(Path.DirectorySeparatorChar, '/'));
    }

    private bool IsJournalPath(string relative) =>
        relative.StartsWith(".cache/f005-capacity/", StringComparison.Ordinal);

    private bool AuthorizeJobMemberLocked(
        int pid,
        ulong eventProcessStartKey,
        long eventTimestampQpc,
        out ulong processSequenceNumber,
        out string rejection)
    {
        processSequenceNumber = 0;
        if (rootWorkerPid == pid)
        {
            // session開始時点ですでに生存するrootは保持handleがPID再利用を防ぐ。
            // System Providerが拡張keyを付ける環境では追加で完全一致を要求する。
            if (!RootWorkerAliveLocked(pid))
            {
                rejection = "ROOT_INACTIVE";
                return false;
            }
            if (eventProcessStartKey != 0 &&
                rootWorkerStartKey != eventProcessStartKey)
            {
                rejection = "EVENT_KEY_MISMATCH";
                return false;
            }
            processSequenceNumber = rootWorkerSequenceNumber
                ?? throw new GuardException("ETW_PROCESS_IDENTITY_UNAVAILABLE");
            rejection = "NONE";
            return true;
        }
        if (!processBirthByPid.TryGetValue(pid, out var birth))
        {
            rejection = "BIRTH_MISSING";
            return false;
        }
        if (eventTimestampQpc <= birth.StartedAtQpc)
        {
            rejection = "EVENT_BEFORE_BIRTH";
            return false;
        }
        var retained = registeredWorkerProcesses.Values
            .FirstOrDefault(item =>
                item.Pid == pid &&
                item.ProcessSequenceNumber == birth.ProcessSequenceNumber);
        if (retained is not null)
        {
            // @des DES-F005-006 @fun FUN-F005-043 保持handleがsignaledなら、
            // Job内で認証済みだった同一process世代の
            // 正常終了後に遅延到着したETWである。生存中だけJob外escapeを拒否する。
            if (job.IsAliveOutsideJob(retained.Process))
            {
                rejection = "RETAINED_OUTSIDE_JOB";
                return false;
            }
            if (eventProcessStartKey != 0 &&
                retained.ProcessStartKey != eventProcessStartKey)
            {
                rejection = "EVENT_KEY_MISMATCH";
                return false;
            }
            processSequenceNumber = retained.ProcessSequenceNumber;
            rejection = "NONE";
            return true;
        }
        var process = job.OpenContainedProcess(pid);
        if (process is null)
        {
            rejection = "PROCESS_UNAVAILABLE";
            return false;
        }
        ulong actualStartKey;
        ulong actualSequenceNumber;
        try
        {
            var actualIdentity = job.ProcessIdentity(process);
            actualStartKey = actualIdentity.ProcessStartKey;
            actualSequenceNumber = actualIdentity.ProcessSequenceNumber;
            if (actualIdentity.ProcessSequenceNumber != birth.ProcessSequenceNumber)
            {
                process.Dispose();
                rejection = "SEQUENCE_MISMATCH";
                return false;
            }
        }
        catch
        {
            process.Dispose();
            rejection = "PROCESS_IDENTITY_UNAVAILABLE";
            return false;
        }
        if (eventProcessStartKey != 0 && actualStartKey != eventProcessStartKey)
        {
            process.Dispose();
            rejection = "EVENT_KEY_MISMATCH";
            return false;
        }
        // Job handleはguardだけが保持し、breakawayを許可しない。root workerの子孫は
        // CreateProcess時点から同じJobへ自動加入するため、最初のETW eventで認可する。
        registeredWorkerProcesses.Add(
            actualStartKey,
            new RegisteredWorkerProcess(
                pid,
                process,
                actualStartKey,
                birth.ProcessSequenceNumber,
                birth.StartedAtQpc));
        registeredPids.Add(pid);
        processSequenceNumber = actualSequenceNumber;
        rejection = "NONE";
        return true;
    }

    private bool RootWorkerAliveLocked(int pid) =>
        rootWorkerPid == pid &&
        rootWorkerProcess is not null &&
        job.Contains(rootWorkerProcess);

    private void AssertRegisteredProcessesContained()
    {
        foreach (var pid in job.MemberPids())
        {
            registeredPids.Add(pid);
            if (pid == rootWorkerPid) continue;
            var process = job.OpenContainedProcess(pid)
                ?? throw new GuardException("JOB_PROCESS_IDENTITY_UNAVAILABLE");
            JobObject.ProcessIdentityRecord identity;
            try
            {
                identity = job.ProcessIdentity(process);
            }
            catch
            {
                process.Dispose();
                throw new GuardException("JOB_PROCESS_IDENTITY_UNAVAILABLE");
            }
            var processStartKey = identity.ProcessStartKey;
            if (registeredWorkerProcesses.ContainsKey(processStartKey))
            {
                process.Dispose();
                continue;
            }
            if (!processBirthByPid.TryGetValue(pid, out var birth) ||
                birth.StartedAtQpc <= 0)
            {
                process.Dispose();
                throw new GuardException("JOB_PROCESS_IDENTITY_UNAVAILABLE");
            }
            if (identity.ProcessSequenceNumber != birth.ProcessSequenceNumber)
            {
                process.Dispose();
                throw new GuardException("JOB_PROCESS_IDENTITY_UNAVAILABLE");
            }
            registeredWorkerProcesses.Add(
                processStartKey,
                new RegisteredWorkerProcess(
                    pid,
                    process,
                    processStartKey,
                    birth.ProcessSequenceNumber,
                    birth.StartedAtQpc));
        }
        foreach (var worker in registeredWorkerProcesses.Values)
        {
            if (job.IsAliveOutsideJob(worker.Process))
                throw new GuardException("JOB_PROCESS_ESCAPE");
        }
    }

    private void StopEtw()
    {
        if (etwStopped) return;
        try
        {
            etwSession.Flush();
            Thread.Sleep(750);
            etwSession.Stop();
            etwSource.StopProcessing();
            if (!etwThread.Join(TimeSpan.FromSeconds(10)))
                throw new GuardException("ETW_CONSUMER_STOP_TIMEOUT");
            etwStopped = true;
        }
        catch (GuardException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new GuardException($"ETW_SESSION_STOP_FAILED_{error.HResult:x8}");
        }
    }

    private void PersistJournal(bool closed)
    {
        var body = JournalBody();
        var journalBodySha256 = Convert.ToHexStringLower(SHA256.HashData(
            Encoding.UTF8.GetBytes(CanonicalJson(body))));
        var document = new SortedDictionary<string, object?>(body, StringComparer.Ordinal) {
            ["closedSeal"] = closed ? new SortedDictionary<string, object?>(StringComparer.Ordinal) {
                ["etwSequenceGapCount"] = 0,
                ["firstEtwSequence"] = observations.Count == 0 ? 0 : observations[0].EtwSequence,
                ["journalBodySha256"] = journalBodySha256,
                ["lastEtwSequence"] = observations.Count == 0 ? 0 : observations[^1].EtwSequence,
                ["producerBinarySha256"] = producerBinarySha256,
            } : null,
            ["state"] = closed ? "closed" : "open",
        };
        AtomicDurableWrite(journalPath, CanonicalJson(document));
    }

    private SortedDictionary<string, object?> JournalBody() =>
        new(StringComparer.Ordinal) {
            ["candidateSha256"] = CandidateSha256,
            ["etwSessionIdentity"] = EtwSessionIdentity,
            ["initialFreeBytes"] = InitialFreeBytes,
            ["jobIdentity"] = JobIdentity,
            ["minimumObservedFreeBytes"] = minimumObservedFreeBytes,
            ["notices"] = notices.Select(item => item.ToJournal()).ToArray(),
            ["observations"] = observations.Select(item => item.ToJournal()).ToArray(),
            ["owner"] = Owner,
            ["peakLiveBytes"] = peakLiveBytes,
            ["phases"] = phaseRecords.Select(item => item.ToJournal()).ToArray(),
            ["registeredWorkerPids"] = registeredPids.Order().ToArray(),
            ["schemaVersion"] = 3,
            ["sessionNonce"] = SessionNonce,
            ["workId"] = WorkId,
        };

    private void Poison(string code)
    {
        lock (gate) PoisonLocked(code);
    }

    private void PoisonLocked(string code)
    {
        // CHG-F005-072: ETW由来のevent分類失敗はsessionを停止させない。
        // 共有hosted runnerでは帰属不能なカーネルeventが尽きず、これを致命扱いすると
        // 収束しない。書込み健全性はphase前後の実測差分が証明するため、
        // ETW codeは診断として保持するだけにする。
        if (code.StartsWith("ETW_", StringComparison.Ordinal) ||
            code.StartsWith("F005_ETW_", StringComparison.Ordinal))
        {
            lastEtwDiagnostic ??= code;
            Monitor.PulseAll(gate);
            return;
        }
        failureCode ??= code;
        Monitor.PulseAll(gate);
        if (!journalClosed)
        {
            try { PersistJournal(closed: false); } catch { }
        }
    }

    private void ThrowIfClosed()
    {
        if (journalClosed) throw new GuardException("CAPACITY_SESSION_CLOSED");
    }

    private long CurrentLiveBytes()
    {
        long total = 0;
        foreach (var value in allocatedByIdentity.Values) total = checked(total + value);
        return total;
    }

    private CompletionSemanticCheckpoint CaptureCompletionSemanticCheckpointLocked()
    {
        var leases = new Dictionary<PendingWriteLease, PendingWriteLeaseState>(
            ReferenceEqualityComparer.Instance);
        foreach (PendingWriteLease lease in writeCompletionReorderQueue
            .SelectMany(snapshot => new[] {
                snapshot.CreateLeaseToBind,
                snapshot.BoundLeaseDirectoryRejoin?.Lease,
            })
            .Append(pendingWriteLease)
            .Where(item => item is not null)
            .Cast<PendingWriteLease>())
            leases.TryAdd(lease, lease.Capture());
        var noticeStates = new Dictionary<NoticeRecord, NoticeState>(
            ReferenceEqualityComparer.Instance);
        foreach (var notice in notices)
            noticeStates.Add(notice, notice.Capture());
        return new CompletionSemanticCheckpoint(
            new Dictionary<ulong, FileSnapshot>(filesByObject),
            new Dictionary<string, FileSnapshot>(filesByPath, StringComparer.Ordinal),
            new Dictionary<string, long>(allocatedByIdentity, StringComparer.Ordinal),
            deferredRenames.ToArray(),
            deferredSystemSetInfos.ToArray(),
            observations.ToArray(),
            noticeStates,
            leases,
            peakLiveBytes,
            minimumObservedFreeBytes);
    }

    private void RestoreCompletionSemanticCheckpointLocked(
        CompletionSemanticCheckpoint checkpoint)
    {
        RestoreDictionary(filesByObject, checkpoint.FilesByObject);
        RestoreDictionary(filesByPath, checkpoint.FilesByPath);
        RestoreDictionary(allocatedByIdentity, checkpoint.AllocatedByIdentity);
        deferredRenames.Clear();
        deferredRenames.AddRange(checkpoint.DeferredRenames);
        deferredSystemSetInfos.Clear();
        deferredSystemSetInfos.AddRange(checkpoint.DeferredSystemSetInfos);
        observations.Clear();
        observations.AddRange(checkpoint.Observations);
        foreach (var item in checkpoint.Notices) item.Key.Restore(item.Value);
        foreach (var item in checkpoint.Leases) item.Key.Restore(item.Value);
        peakLiveBytes = checkpoint.PeakLiveBytes;
        minimumObservedFreeBytes = checkpoint.MinimumObservedFreeBytes;
    }

    private static void RestoreDictionary<TKey, TValue>(
        Dictionary<TKey, TValue> target,
        Dictionary<TKey, TValue> source) where TKey : notnull
    {
        target.Clear();
        foreach (var item in source) target.Add(item.Key, item.Value);
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (!CapacityGuardLifecycleRules.BeginDisposeLocked(
                gate,
                ref disposed,
                ref failureCode)) return;
            if (!journalClosed)
            {
                try { PersistJournal(closed: false); } catch { }
            }
        }
        processIdentityProbeObserved.Set();
        CapacityGuardLifecycleRules.CancelDrainPipeAndDispose(
            cancellation,
            pipeTask,
            TimeSpan.FromSeconds(5),
            DisposeResourcesAfterPipeCompletion);
    }

    private void DisposeResourcesAfterPipeCompletion()
    {
        try { StopEtw(); } catch { }
        etwSource.Dispose();
        etwSession.Dispose();
        callbackAdmission.Dispose();
        var retainedProcesses = new List<Process>();
        foreach (var seal in writeCompletionSeals)
        {
            seal.Dispose();
            if (!retainedProcesses.Any(item =>
                ReferenceEquals(item, seal.Lease.Process)))
                retainedProcesses.Add(seal.Lease.Process);
        }
        writeCompletionReplayStore.Dispose();
        foreach (var retained in retainedProcesses) retained.Dispose();
        if (pendingWriteLease is { } pending &&
            !retainedProcesses.Any(item => ReferenceEquals(item, pending.Process)))
            pending.Process.Dispose();
        foreach (var worker in registeredWorkerProcesses.Values) worker.Process.Dispose();
        rootWorkerProcess?.Dispose();
        job.Dispose();
        processIdentityProbeObserved.Dispose();
        cancellation.Dispose();
    }

    private static object Error(string code) => new {
        ok = false,
        error = WriteCompletionDrainRules.NormalizeExternalFailureCode(code),
    };

    private static string PipeString(JsonElement value, string property)
    {
        if (value.ValueKind != JsonValueKind.Object ||
            !value.TryGetProperty(property, out var child) ||
            child.ValueKind != JsonValueKind.String)
            throw new GuardException("REQUEST_INVALID");
        return child.GetString() ?? throw new GuardException("REQUEST_INVALID");
    }

    private static int PipePositiveInt(JsonElement value, string property)
    {
        if (value.ValueKind != JsonValueKind.Object ||
            !value.TryGetProperty(property, out var child) ||
            child.ValueKind != JsonValueKind.Number ||
            !child.TryGetInt32(out var result) ||
            result <= 0)
            throw new GuardException("REQUEST_INVALID");
        return result;
    }

    private static void RequireExactPipeKeys(JsonElement value, params string[] expected)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new GuardException("REQUEST_INVALID");
        var actual = value.EnumerateObject()
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        var sortedExpected = expected.OrderBy(name => name, StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(sortedExpected, StringComparer.Ordinal))
            throw new GuardException("REQUEST_INVALID");
    }

    private static string PipeSha256(JsonElement value, string property)
    {
        var result = PipeString(value, property);
        if (result.Length != 64 || result.Any(character =>
            !(character is >= '0' and <= '9' or >= 'a' and <= 'f')))
            throw new GuardException("REQUEST_INVALID");
        return result;
    }

    private static string? PipeNullableWorkId(JsonElement value, string property)
    {
        if (!value.TryGetProperty(property, out var child))
            throw new GuardException("REQUEST_INVALID");
        if (child.ValueKind == JsonValueKind.Null) return null;
        if (child.ValueKind != JsonValueKind.String)
            throw new GuardException("REQUEST_INVALID");
        var workId = child.GetString();
        if (workId is null || !WorkIds.Contains(workId))
            throw new GuardException("REQUEST_INVALID");
        return workId;
    }

    private static void ValidatePhase(string phase, string? workId)
    {
        if (!Phases.Contains(phase) || (workId is not null && !WorkIds.Contains(workId)))
            throw new GuardException("PHASE_INVALID");
    }

    private static bool FixedEquals(string left, string right)
    {
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length &&
            CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static string ValidateRelativePath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) ||
            Path.IsPathFullyQualified(relativePath) ||
            relativePath.Contains('\\') ||
            relativePath.Contains(':') ||
            relativePath.Contains('\0') ||
            relativePath.Contains("%2f", StringComparison.OrdinalIgnoreCase) ||
            relativePath.Contains("%5c", StringComparison.OrdinalIgnoreCase))
            throw new GuardException("PATH_INVALID");
        foreach (var segment in relativePath.Split('/'))
        {
            if (segment.Length == 0 || segment is "." or ".." ||
                segment.EndsWith('.') || segment.EndsWith(' ') ||
                segment.Any(char.IsControl) ||
                !segment.IsNormalized(NormalizationForm.FormC))
                throw new GuardException("PATH_INVALID");
        }
        return relativePath;
    }

    private static void EnsureWithinRoot(string root, string target)
    {
        var relation = Path.GetRelativePath(root, target);
        if (relation == "." || relation == ".." ||
            relation.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            Path.IsPathFullyQualified(relation))
            throw new GuardException("PATH_INVALID");
    }

    private static long ReadFreeBytes(string root) =>
        new DriveInfo(Path.GetPathRoot(root) ?? throw new GuardException("ROOT_INVALID"))
            .AvailableFreeSpace;

    private static string CanonicalJson(object value)
    {
        var node = JsonSerializer.SerializeToNode(value, JournalJson)
            ?? throw new GuardException("JOURNAL_SERIALIZATION_FAILED");
        return SortNode(node).ToJsonString(JournalJson) + "\n";
    }

    private static JsonNode SortNode(JsonNode node)
    {
        if (node is JsonArray array)
        {
            var result = new JsonArray();
            foreach (var child in array)
                result.Add(child is null ? null : SortNode(child));
            return result;
        }
        if (node is JsonObject obj)
        {
            var result = new JsonObject();
            foreach (var pair in obj.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                result[pair.Key] = pair.Value is null ? null : SortNode(pair.Value);
            return result;
        }
        return node.DeepClone();
    }

    private static void AtomicDurableWrite(string path, string text)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new GuardException("JOURNAL_PATH_INVALID");
        var temporary = Path.Combine(directory, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough))
            {
                var bytes = Encoding.UTF8.GetBytes(text);
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            if (!MoveFileExW(temporary, path, 0x00000001 | 0x00000008))
                throw new GuardException($"JOURNAL_RENAME_FAILED_{Marshal.GetLastWin32Error()}");
        }
        finally
        {
            try { File.Delete(temporary); } catch { }
        }
    }

    private sealed record ActivePhase(
        string Phase,
        string? WorkId,
        string PhaseInstanceId,
        DateTime StartedAtUtc,
        long StartedAtQpc);

    private sealed record ProcessBirthRecord(
        ulong ProcessSequenceNumber,
        long StartedAtQpc);

    private sealed class ObservedProducerBirthSnapshot(
        bool recordObserved,
        ulong recordProcessSequenceNumber,
        long recordStartedAtQpc,
        int producerPid,
        ulong producerProcessStartKey,
        ulong leaseProcessSequenceNumber,
        string phaseInstanceId,
        long phaseStartedAtQpc,
        long leaseReservedAtQpc)
    {
        public bool RecordObserved { get; } = recordObserved;
        public ulong RecordProcessSequenceNumber { get; } =
            recordProcessSequenceNumber;
        public long RecordStartedAtQpc { get; } = recordStartedAtQpc;
        public int ProducerPid { get; } = producerPid;
        public ulong ProducerProcessStartKey { get; } = producerProcessStartKey;
        public ulong LeaseProcessSequenceNumber { get; } =
            leaseProcessSequenceNumber;
        public string PhaseInstanceId { get; } = phaseInstanceId;
        public long PhaseStartedAtQpc { get; } = phaseStartedAtQpc;
        public long LeaseReservedAtQpc { get; } = leaseReservedAtQpc;
    }

    private sealed record DeferredSystemSetInfoRecord(
        int WorkerPid,
        ulong ProducerSequenceNumber,
        long EtwSequence,
        string Phase,
        string? WorkId,
        string PhaseInstanceId,
        string ObservedAt,
        string RelativePath,
        ulong FileObject,
        long TimestampQpc,
        FileSnapshot Snapshot,
        long FreeBytes,
        long TotalFreeBytes);

    private sealed record CompletedWriteRecord(
        int WorkerPid,
        ulong ProcessSequenceNumber,
        string PhaseInstanceId,
        long ReservedAtQpc,
        long CompletedAtQpc,
        string Identity);

    private sealed record AfterLeaseDirectoryRejoinContext(
        ActivePhase Phase,
        Process Process,
        string DirectoryPath,
        string DirectoryIdentity,
        string LeasePath,
        string PendingTargetPath,
        string LeaseIdentity,
        ulong LeaseFileObject,
        ulong EventFileObject,
        long LeaseReservedAtQpc,
        long RenameReservedAtQpc,
        int ProducerPid,
        ulong ProcessStartKey,
        ulong ProducerSequenceNumber);

    private sealed record BoundLeaseDirectoryRejoinContext(
        ActivePhase Phase,
        PendingWriteLease Lease,
        string DirectoryPath,
        string DirectoryIdentity,
        string LeasePath,
        string LeaseIdentity,
        ulong LeaseFileObject,
        ulong EventFileObject,
        long PhaseStartedAtQpc,
        long LeaseReservedAtQpc,
        int ProducerPid,
        ulong ProcessStartKey,
        ulong ProducerSequenceNumber);

    private sealed record CompletedNoLeaseDirectorySealMember(
        WriteCompletionDrainSeal Seal,
        long SealSequence,
        long CompletionUpperQpc);

    private sealed record CompletedNoLeaseDirectoryRejoinContext(
        ImmutableArray<CompletedNoLeaseDirectorySealMember> Members,
        ActivePhase Phase,
        string PhaseInstanceId,
        long PhaseStartedAtQpc,
        string DirectoryPath,
        string DirectoryIdentity,
        ulong EventFileObject,
        long EventQpc,
        int RootPid,
        ulong RootProcessStartKey,
        ulong RootProcessSequenceNumber);

    private enum WriteCompletionDrainState
    {
        Prepared,
        CompletionRequested,
        CompletedRetained,
        Released,
    }

    private sealed class WriteCompletionDrainSeal(
        long sealSequence,
        ActivePhase phase,
        PendingWriteLease lease,
        string currentPath,
        string parentPath,
        string currentIdentity,
        string directoryIdentity,
        ulong leaseFileObject,
        long leaseFileObjectGeneration,
        int producerPid,
        ulong processStartKey,
        ulong processSequenceNumber,
        long currentPathReservedAtQpc,
        long preparedAtQpc,
        long preparedDeadlineQpc,
        long relevantEventCountAtPrepare,
        RetainedFileIdentityLease retainedCurrent,
        RetainedFileIdentityLease retainedParent) : IDisposable
    {
        public long SealSequence { get; } = sealSequence;
        public ActivePhase Phase { get; } = phase;
        public PendingWriteLease Lease { get; } = lease;
        public string CurrentPath { get; } = currentPath;
        public string ParentPath { get; } = parentPath;
        public string CurrentIdentity { get; } = currentIdentity;
        public string DirectoryIdentity { get; } = directoryIdentity;
        public ulong LeaseFileObject { get; } = leaseFileObject;
        public long LeaseFileObjectGeneration { get; } = leaseFileObjectGeneration;
        public int ProducerPid { get; } = producerPid;
        public ulong ProcessStartKey { get; } = processStartKey;
        public ulong ProcessSequenceNumber { get; } = processSequenceNumber;
        public long CurrentPathReservedAtQpc { get; } = currentPathReservedAtQpc;
        public long PreparedAtQpc { get; } = preparedAtQpc;
        public long PreparedDeadlineQpc { get; } = preparedDeadlineQpc;
        public long RelevantEventCountAtPrepare { get; } = relevantEventCountAtPrepare;
        public WriteCompletionDrainState State { get; set; } =
            WriteCompletionDrainState.Prepared;
        public long? CompletionRequestedAtQpc { get; set; }
        public long? DrainDeadlineQpc { get; set; }
        public int EventCount { get; set; }
        public RetainedFileIdentityLease RetainedCurrent { get; } = retainedCurrent;
        public RetainedFileIdentityLease RetainedParent { get; } = retainedParent;

        public void Dispose()
        {
            RetainedCurrent.Dispose();
            RetainedParent.Dispose();
        }
    }

    private sealed record PendingCallbackSnapshot(
        string EventName,
        string NormalizedPath,
        ulong FileObject,
        long TimestampQpc,
        long EtwSequence,
        string ObservedAt,
        int ProducerPid,
        ulong ProducerSequenceNumber,
        ActivePhase Phase,
        FileSnapshot? Current,
        FileSnapshot Effective,
        long FreeBytesAvailable,
        long FreeBytesTotal,
        PendingWriteLease? CreateLeaseToBind,
        AfterLeaseDirectoryRejoinContext? AfterLeaseDirectoryRejoin,
        BoundLeaseDirectoryRejoinContext? BoundLeaseDirectoryRejoin,
        CompletedNoLeaseDirectoryRejoinContext?
            CompletedNoLeaseDirectoryRejoin,
        long? SealSequence,
        ImmutableBindingProof? BindingProof,
        WriteCompletionReplayKind ReplayKind,
        DeferredRenameRecord? DeferredRename);

    private sealed record PendingCleanupSnapshot(
        ImmutableBindingProof BindingProof,
        ulong FileObject);

    private sealed record PendingWriteLeaseState(
        string RelativePath,
        long CurrentPathReservedAtQpc,
        ulong? FileObject,
        bool FileObjectClosed,
        FileSnapshot? Snapshot,
        string? PendingRenamePath,
        long? RenameReservedAtQpc);

    private sealed record NoticeState(
        string State,
        long[] ObservationSequences);

    private sealed record CompletionSemanticCheckpoint(
        Dictionary<ulong, FileSnapshot> FilesByObject,
        Dictionary<string, FileSnapshot> FilesByPath,
        Dictionary<string, long> AllocatedByIdentity,
        DeferredRenameRecord[] DeferredRenames,
        DeferredSystemSetInfoRecord[] DeferredSystemSetInfos,
        ObservationRecord[] Observations,
        Dictionary<NoticeRecord, NoticeState> Notices,
        Dictionary<PendingWriteLease, PendingWriteLeaseState> Leases,
        long PeakLiveBytes,
        long MinimumObservedFreeBytes);

    private sealed class PendingWriteLease(
        int workerPid,
        ulong processStartKey,
        ulong processSequenceNumber,
        string phaseInstanceId,
        string relativePath,
        long reservedAtQpc,
        Process process,
        ObservedProducerBirthSnapshot producerBirthSnapshot)
    {
        public int WorkerPid { get; } = workerPid;
        public ulong ProcessStartKey { get; } = processStartKey;
        public ulong ProcessSequenceNumber { get; } = processSequenceNumber;
        public string PhaseInstanceId { get; } = phaseInstanceId;
        public string RelativePath { get; set; } = relativePath;
        public long ReservedAtQpc { get; } = reservedAtQpc;
        public long CurrentPathReservedAtQpc { get; set; } = reservedAtQpc;
        public Process Process { get; } = process;
        public ObservedProducerBirthSnapshot ProducerBirthSnapshot { get; } =
            producerBirthSnapshot;
        public ulong? FileObject { get; set; }
        public bool FileObjectClosed { get; set; }
        public FileSnapshot? Snapshot { get; set; }
        public string? PendingRenamePath { get; set; }
        public long? RenameReservedAtQpc { get; set; }

        public PendingWriteLeaseState Capture() => new(
            RelativePath,
            CurrentPathReservedAtQpc,
            FileObject,
            FileObjectClosed,
            Snapshot,
            PendingRenamePath,
            RenameReservedAtQpc);

        public void Restore(PendingWriteLeaseState state)
        {
            RelativePath = state.RelativePath;
            CurrentPathReservedAtQpc = state.CurrentPathReservedAtQpc;
            FileObject = state.FileObject;
            FileObjectClosed = state.FileObjectClosed;
            Snapshot = state.Snapshot;
            PendingRenamePath = state.PendingRenamePath;
            RenameReservedAtQpc = state.RenameReservedAtQpc;
        }
    }

    private sealed record RegisteredWorkerProcess(
        int Pid,
        Process Process,
        ulong ProcessStartKey,
        ulong ProcessSequenceNumber,
        long StartedAtQpc);

    private sealed record DeferredRenameRecord(
        int WorkerPid,
        ulong ProducerSequenceNumber,
        long EtwSequence,
        string Phase,
        string? WorkId,
        string PhaseInstanceId,
        string ObservedAt,
        FileSnapshot Source,
        string? ObservedTarget)
    {
        public DateTimeOffset ObservedAtValue { get; } = DateTimeOffset.Parse(ObservedAt);
    }

    private sealed record PhaseRecord(
        string Phase,
        string? WorkId,
        string PhaseInstanceId,
        string State,
        string ObservedAt,
        long LiveBytes,
        long FreeBytes)
    {
        public SortedDictionary<string, object?> ToJournal() => new(StringComparer.Ordinal) {
            ["freeBytes"] = FreeBytes,
            ["liveBytes"] = LiveBytes,
            ["observedAt"] = ObservedAt,
            ["phase"] = Phase,
            ["phaseInstanceId"] = PhaseInstanceId,
            ["state"] = State,
            ["workId"] = WorkId,
        };
    }

    private sealed class NoticeRecord(
        string sessionNonce,
        long noticeSequence,
        int workerPid,
        ulong producerSequenceNumber,
        string phase,
        string? workId,
        string phaseInstanceId,
        string noticeId,
        string eventName,
        string? path,
        string? from,
        string? to)
    {
        public string SessionNonce { get; } = sessionNonce;
        public long NoticeSequence { get; } = noticeSequence;
        public int WorkerPid { get; } = workerPid;
        public ulong ProducerSequenceNumber { get; } = producerSequenceNumber;
        public string Phase { get; } = phase;
        public string? WorkId { get; } = workId;
        public string PhaseInstanceId { get; } = phaseInstanceId;
        public string NoticeId { get; } = noticeId;
        public string EventName { get; } = eventName;
        public string? Path { get; } = path;
        public string? From { get; } = from;
        public string? To { get; } = to;
        public string State { get; private set; } = "pending";
        public List<long> ObservationSequences { get; } = [];

        public void Match(long sequence)
        {
            if (State == "matched") throw new GuardException("NOTICE_REPLAY");
            State = "matched";
            ObservationSequences.Add(sequence);
        }

        /// <summary>
        /// CHG-F005-072: ETW相関を待たず宣言を受理する。
        /// 書込み健全性はphase前後の実測差分で証明するため、
        /// 帰属不能なカーネルeventでphaseを停止しない。
        /// </summary>
        public void Declare()
        {
            if (State == "matched") throw new GuardException("NOTICE_REPLAY");
            State = "declared";
        }

        public NoticeState Capture() => new(
            State,
            ObservationSequences.ToArray());

        public void Restore(NoticeState state)
        {
            State = state.State;
            ObservationSequences.Clear();
            ObservationSequences.AddRange(state.ObservationSequences);
        }

        public bool Matches(ObservationRecord observation) =>
            ProducerSequenceNumber == observation.ProducerSequenceNumber &&
            Matches(observation.EventName, observation.Path, observation.From, observation.To);

        public bool Matches(string eventName, string? path, string? from, string? to) =>
            EventName == eventName &&
            (eventName == "rename"
                ? From == from && To == to
                : Path == path);

        public SortedDictionary<string, object?> ToJournal()
        {
            var notice = new SortedDictionary<string, object?>(StringComparer.Ordinal) {
                ["event"] = EventName,
                ["noticeId"] = NoticeId,
                ["phase"] = Phase,
                ["phaseInstanceId"] = PhaseInstanceId,
                ["workId"] = WorkId,
            };
            if (EventName == "rename")
            {
                notice["from"] = From;
                notice["to"] = To;
            }
            else
            {
                notice["path"] = Path;
            }
            return new SortedDictionary<string, object?>(StringComparer.Ordinal) {
                ["notice"] = notice,
                ["noticeSequence"] = NoticeSequence,
                ["observationSequences"] = ObservationSequences.ToArray(),
                ["sessionNonce"] = SessionNonce,
                ["state"] = State,
                ["workerPid"] = WorkerPid,
            };
        }
    }

    private sealed class ObservationRecord(
        string eventName,
        string? path,
        string? from,
        string? to,
        string phase,
        string? workId,
        string phaseInstanceId,
        long etwSequence,
        string observedAt,
        int workerPid,
        ulong producerSequenceNumber,
        string volumeId,
        string fileId128,
        long logicalLengthBytes,
        long allocatedLengthBytes,
        long allocatedDeltaBytes,
        long liveBytes,
        long freeBytesAvailable,
        long freeBytesTotal,
        string producerBinarySha256)
    {
        public string EventName { get; } = eventName;
        public string? Path { get; } = path;
        public string? From { get; } = from;
        public string? To { get; } = to;
        public string Phase { get; } = phase;
        public string? WorkId { get; } = workId;
        public string PhaseInstanceId { get; } = phaseInstanceId;
        public long? NoticeSequence { get; set; }
        public long EtwSequence { get; } = etwSequence;
        public string ObservedAt { get; } = observedAt;
        public DateTimeOffset ObservedAtValue { get; } = DateTimeOffset.Parse(observedAt);
        public int WorkerPid { get; } = workerPid;
        public ulong ProducerSequenceNumber { get; } = producerSequenceNumber;
        public string VolumeId { get; } = volumeId;
        public string FileId128 { get; } = fileId128;
        public long LogicalLengthBytes { get; } = logicalLengthBytes;
        public long AllocatedLengthBytes { get; } = allocatedLengthBytes;
        public long AllocatedDeltaBytes { get; } = allocatedDeltaBytes;
        public long LiveBytes { get; } = liveBytes;
        public long FreeBytesAvailable { get; } = freeBytesAvailable;
        public long FreeBytesTotal { get; } = freeBytesTotal;
        public string ProducerBinarySha256 { get; } = producerBinarySha256;

        public bool Matches(string eventName, string? path, string? from, string? to) =>
            EventName == eventName &&
            (eventName == "rename"
                ? From == from && To == to
                : Path == path);

        public SortedDictionary<string, object?> ToJournal()
        {
            var value = new SortedDictionary<string, object?>(StringComparer.Ordinal) {
                ["allocatedDeltaBytes"] = AllocatedDeltaBytes,
                ["allocatedLengthBytes"] = AllocatedLengthBytes,
                ["etwSequence"] = EtwSequence,
                ["event"] = EventName,
                ["fileId128"] = FileId128,
                ["freeBytesAvailable"] = FreeBytesAvailable,
                ["freeBytesTotal"] = FreeBytesTotal,
                ["liveBytes"] = LiveBytes,
                ["logicalLengthBytes"] = LogicalLengthBytes,
                ["noticeSequence"] = NoticeSequence,
                ["observedAt"] = ObservedAt,
                ["phase"] = Phase,
                ["phaseInstanceId"] = PhaseInstanceId,
                ["producer"] = "f005-native-guard",
                ["producerBinarySha256"] = ProducerBinarySha256,
                ["sha256"] = null,
                ["volumeId"] = VolumeId,
                ["workId"] = WorkId,
                ["workerPid"] = WorkerPid,
            };
            if (EventName == "rename")
            {
                value["from"] = From;
                value["to"] = To;
            }
            else
            {
                value["path"] = Path;
            }
            return value;
        }
    }

    private sealed record FileSnapshot(
        string RelativePath,
        string Identity,
        string VolumeId,
        string FileId128,
        long LogicalLengthBytes,
        long AllocatedLengthBytes);

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    {
        public ulong VolumeSerialNumber;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] FileId;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileIdInfo information,
        uint bufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetCompressedFileSizeW(string fileName, out uint fileSizeHigh);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle file);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(
        string existingFileName,
        string newFileName,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(
        SafePipeHandle pipe,
        out uint clientProcessId);
}

/// <summary>
/// TraceEvent 3.2.5が公開していないEVENT_RECORDのprocess start keyを、
/// pin済みwin-x64 ABIから固定長で読み取る。値がない場合は0へ閉じる。
/// </summary>
static class TraceEventProcessIdentity
{
    public static readonly Guid KernelProcessProvider =
        new("22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716");
    public const ulong KernelProcessKeyword = 0x0000000000000010;
    public const int KernelProcessStartEventId = 1;
    private const ushort ProcessStartKeyExtendedType = 0x000d;
    private const int EventRecordExtendedDataCountOffset = 84;
    private const int EventRecordExtendedDataOffset = 88;
    private const int ExtendedItemSize = 16;
    private const int ExtendedItemTypeOffset = 2;
    private const int ExtendedItemDataSizeOffset = 6;
    private const int ExtendedItemDataPointerOffset = 8;
    private static readonly System.Reflection.FieldInfo? EventRecordField =
        typeof(TraceEvent).GetField(
            "eventRecord",
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic);

    public static void ValidateAbi()
    {
        if (RuntimeInformation.ProcessArchitecture != Architecture.X64 ||
            IntPtr.Size != sizeof(ulong) ||
            EventRecordField is null ||
            !EventRecordField.FieldType.IsPointer)
        {
            throw new GuardException("ETW_PROCESS_START_KEY_ABI_INVALID");
        }
    }

    public static unsafe ulong ProcessStartKey(TraceEvent data)
    {
        try
        {
            var boxedPointer = EventRecordField?.GetValue(data);
            if (boxedPointer is null) return 0;
            var eventRecord = (IntPtr)System.Reflection.Pointer.Unbox(boxedPointer);
            if (eventRecord == IntPtr.Zero) return 0;
            var count = unchecked((ushort)Marshal.ReadInt16(
                eventRecord,
                EventRecordExtendedDataCountOffset));
            var extendedData = Marshal.ReadIntPtr(
                eventRecord,
                EventRecordExtendedDataOffset);
            if (count == 0 || extendedData == IntPtr.Zero) return 0;
            for (var index = 0; index < count; index++)
            {
                var item = IntPtr.Add(extendedData, checked(index * ExtendedItemSize));
                var type = unchecked((ushort)Marshal.ReadInt16(item, ExtendedItemTypeOffset));
                if (type != ProcessStartKeyExtendedType) continue;
                var size = unchecked((ushort)Marshal.ReadInt16(item, ExtendedItemDataSizeOffset));
                var pointer = Marshal.ReadInt64(item, ExtendedItemDataPointerOffset);
                if (size != sizeof(ulong) || pointer == 0) return 0;
                return unchecked((ulong)Marshal.ReadInt64(new IntPtr(pointer)));
            }
        }
        catch
        {
            return 0;
        }
        return 0;
    }
}

/// <summary>
/// TraceEvent 3.2.5でsystem loggerを開始した後、Windows SDK 10.0.26100.0の
/// System IO ProviderをProcessStartKey拡張付きで有効化する。
/// </summary>
static class TraceEventSystemController
{
    private const uint EnableProvider = 1;
    private const uint EnableProviderTimeoutMilliseconds = 10_000;
    private const byte VerboseLevel = 5;
    private const ulong SystemIoFileKeywords = 0x0000000000000414;
    private const uint EventEnablePropertyProcessStartKey = 0x00000080;
    private static readonly Guid SystemIoProvider =
        new("3d5c43e3-0f1c-4202-b817-174c0070dc79");
    private static readonly System.Reflection.FieldInfo? SessionHandleField =
        typeof(TraceEventSession).GetField(
            "m_SessionHandle",
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic);
    private static readonly System.Reflection.MethodInfo? DangerousGetHandleMethod =
        SessionHandleField?.FieldType.GetMethod(
            "DangerousGetHandle",
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.Public,
            Type.EmptyTypes);
    private static readonly System.Reflection.PropertyInfo? IsValidProperty =
        SessionHandleField?.FieldType.GetProperty(
            "IsValid",
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.Public);

    public static void EnableSystemIoProcessStartKey(TraceEventSession session)
    {
        lock (session)
        {
            var sessionHandle = SessionHandleField?.GetValue(session);
            if (sessionHandle is null ||
                SessionHandleField?.FieldType.FullName !=
                    "Microsoft.Diagnostics.Tracing.TraceEventNativeMethods+SafeTraceHandle" ||
                DangerousGetHandleMethod?.ReturnType != typeof(ulong) ||
                IsValidProperty?.PropertyType != typeof(bool) ||
                IsValidProperty.GetValue(sessionHandle) is not true ||
                DangerousGetHandleMethod.Invoke(sessionHandle, null) is not ulong traceHandle ||
                traceHandle == 0)
            {
                throw new GuardException("ETW_SYSTEM_IO_CONTROLLER_ABI_INVALID");
            }
            var parameters = new EnableTraceParameters {
                Version = 2,
                EnableProperty = EventEnablePropertyProcessStartKey,
            };
            var status = EnableTraceEx2(
                traceHandle,
                in SystemIoProvider,
                EnableProvider,
                VerboseLevel,
                SystemIoFileKeywords,
                0,
                EnableProviderTimeoutMilliseconds,
                in parameters);
            if (status != 0)
                throw new GuardException($"ETW_SYSTEM_IO_ENABLE_FAILED_{status}");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EnableTraceParameters
    {
        public uint Version;
        public uint EnableProperty;
        public uint ControlFlags;
        public Guid SourceId;
        public IntPtr EnableFilterDesc;
        public uint FilterDescCount;
    }

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint EnableTraceEx2(
        ulong traceHandle,
        in Guid providerId,
        uint controlCode,
        byte level,
        ulong matchAnyKeyword,
        ulong matchAllKeyword,
        uint timeout,
        in EnableTraceParameters enableParameters);
}

/// <summary>
/// breakawayを許可せず、最後のhandle closeで全workerを停止するJob Object。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-036 FUN-F005-047
/// </summary>
sealed class JobObject : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint WaitTimeout = 0x00000102;
    private const int JobObjectBasicProcessIdListClass = 3;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int ErrorMoreData = 234;
    private const int ProcessTelemetryIdInformation = 64;
    private const int StatusInfoLengthMismatch = unchecked((int)0xc0000004);
    private readonly SafeJobHandle handle;

    private JobObject(SafeJobHandle handle) => this.handle = handle;

    public static JobObject Create()
    {
        var handle = CreateJobObjectW(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new GuardException("JOB_CREATE_FAILED");
        var information = new JobObjectExtendedLimitInformation {
            BasicLimitInformation = new JobObjectBasicLimitInformation {
                LimitFlags = JobObjectLimitKillOnJobClose,
            },
        };
        var length = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformationClass,
                pointer,
                (uint)length))
            {
                handle.Dispose();
                throw new GuardException($"JOB_LIMITS_FAILED_{Marshal.GetLastWin32Error()}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return new JobObject(handle);
    }

    public Process Assign(int pid)
    {
        var process = Process.GetProcessById(pid);
        try
        {
            if (!IsAlive(process)) throw new GuardException("PID_NOT_RUNNING");
            if (!AssignProcessToJobObject(handle, process.Handle))
                throw new GuardException($"JOB_ASSIGNMENT_FAILED_{Marshal.GetLastWin32Error()}");
            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    public bool Contains(Process process) =>
        IsAlive(process) &&
        IsProcessInJob(process.Handle, handle, out var result) &&
        result;

    public Process? OpenContainedProcess(int pid)
    {
        Process? process = null;
        try
        {
            process = Process.GetProcessById(pid);
            if (Contains(process)) return process;
            process.Dispose();
            return null;
        }
        catch (Exception error) when (error is
            ArgumentException or InvalidOperationException or Win32Exception)
        {
            process?.Dispose();
            return null;
        }
    }

    public bool IsAliveOutsideJob(Process process)
    {
        var processHandle = process.Handle;
        var waitResult = WaitForSingleObject(processHandle, 0);
        if (waitResult == 0) return false;
        if (waitResult != WaitTimeout) return true;
        return !IsProcessInJob(processHandle, handle, out var result) || !result;
    }

    public bool IsSignaled(Process process) =>
        WaitForSingleObject(process.Handle, 0) == 0;

    public RetainedProcessInspection InspectRetainedProcess(Process process)
    {
        var identity = ProcessIdentity(process);
        var waitResult = WaitForSingleObject(process.Handle, 0);
        if (waitResult == 0)
            return new RetainedProcessInspection(
                identity.ProcessId,
                identity.ProcessStartKey,
                identity.ProcessSequenceNumber,
                true,
                false);
        if (waitResult != WaitTimeout)
            throw new GuardException("PROCESS_WAIT_FAILED");
        if (!IsProcessInJob(process.Handle, handle, out var jobMember))
            throw new GuardException("JOB_QUERY_FAILED");
        return new RetainedProcessInspection(
            identity.ProcessId,
            identity.ProcessStartKey,
            identity.ProcessSequenceNumber,
            false,
            jobMember);
    }

    public ProcessIdentityRecord ProcessIdentity(Process process)
    {
        var size = 4096;
        while (size <= 65_536)
        {
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                var status = NtQueryInformationProcess(
                    process.Handle,
                    ProcessTelemetryIdInformation,
                    buffer,
                    size,
                    out var required);
                if (status == StatusInfoLengthMismatch)
                {
                    size = Math.Max(checked(size * 2), checked(required + 4096));
                    continue;
                }
                if (status < 0 || required < 48 || required > size)
                    throw new GuardException("PROCESS_START_KEY_QUERY_FAILED");
                var headerSize = unchecked((uint)Marshal.ReadInt32(buffer, 0));
                if (headerSize < 48 || headerSize > required)
                    throw new GuardException("PROCESS_START_KEY_QUERY_FAILED");
                var processId = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                var processStartKey = unchecked((ulong)Marshal.ReadInt64(buffer, 8));
                var processSequenceNumber =
                    unchecked((ulong)Marshal.ReadInt64(buffer, 40));
                if (processId != process.Id ||
                    processStartKey == 0 ||
                    processSequenceNumber == 0)
                    throw new GuardException("PROCESS_START_KEY_QUERY_FAILED");
                return new ProcessIdentityRecord(
                    checked((int)processId),
                    processStartKey,
                    processSequenceNumber);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new GuardException("PROCESS_START_KEY_QUERY_FAILED");
    }

    public readonly record struct ProcessIdentityRecord(
        int ProcessId,
        ulong ProcessStartKey,
        ulong ProcessSequenceNumber);

    public readonly record struct RetainedProcessInspection(
        int ProcessId,
        ulong ProcessStartKey,
        ulong ProcessSequenceNumber,
        bool Signaled,
        bool JobMember);

    public IReadOnlyList<int> MemberPids()
    {
        var capacity = 16;
        while (capacity <= 65_536)
        {
            var bytes = checked(8 + capacity * IntPtr.Size);
            var pointer = Marshal.AllocHGlobal(bytes);
            try
            {
                if (!QueryInformationJobObject(
                    handle,
                    JobObjectBasicProcessIdListClass,
                    pointer,
                    (uint)bytes,
                    out _))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error == ErrorMoreData)
                    {
                        capacity = checked(capacity * 2);
                        continue;
                    }
                    throw new GuardException($"JOB_ENUMERATION_FAILED_{error}");
                }
                var count = Marshal.ReadInt32(pointer, 4);
                if (count < 0 || count > capacity) throw new GuardException("JOB_ENUMERATION_INVALID");
                var result = new List<int>(count);
                for (var index = 0; index < count; index++)
                {
                    var raw = Marshal.ReadIntPtr(pointer, 8 + index * IntPtr.Size).ToInt64();
                    if (raw is <= 0 or > int.MaxValue) throw new GuardException("JOB_ENUMERATION_INVALID");
                    result.Add((int)raw);
                }
                return result;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }
        throw new GuardException("JOB_ENUMERATION_LIMIT");
    }

    public void DisarmAfterSuccessfulClose()
    {
        SetLimits(0);
    }

    public void Dispose() => handle.Dispose();

    private static bool IsAlive(Process process) =>
        WaitForSingleObject(process.Handle, 0) == WaitTimeout;

    private void SetLimits(uint limitFlags)
    {
        var information = new JobObjectExtendedLimitInformation {
            BasicLimitInformation = new JobObjectBasicLimitInformation {
                LimitFlags = limitFlags,
            },
        };
        var length = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformationClass,
                pointer,
                (uint)length))
            {
                throw new GuardException($"JOB_LIMITS_FAILED_{Marshal.GetLastWin32Error()}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeJobHandle CreateJobObjectW(
        IntPtr jobAttributes,
        string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeJobHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(
        SafeJobHandle job,
        IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        IntPtr process,
        SafeJobHandle job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        IntPtr processInformation,
        int processInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        SafeJobHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);
}

sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeJobHandle() : base(ownsHandle: true) { }

    protected override bool ReleaseHandle() => CloseHandle(handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}

public static class SystemSetInfoDiagnosticRules
{
    public static string Classify(
        string normalized,
        bool fileExists,
        bool directoryExists,
        bool hasWriteLease,
        bool hasBoundFileObject,
        string completedWriteState)
    {
        var slash = normalized.IndexOf('/');
        var first = slash < 0 ? normalized : normalized[..slash];
        var bucket = first switch {
            ".cache" => "CACHE",
            "content" => "CONTENT",
            "data" => "DATA",
            "dist" => "DIST",
            "native" => "NATIVE",
            "node_modules" => "NODE_MODULES",
            "public" => "PUBLIC",
            "scripts" => "SCRIPTS",
            "src" => "SRC",
            _ => "OTHER",
        };
        var extension = Path.GetExtension(normalized).ToLowerInvariant() switch {
            ".exe" => "EXE",
            ".js" or ".mjs" or ".cjs" => "JS",
            ".json" => "JSON",
            ".log" => "LOG",
            ".tmp" => "TMP",
            ".ts" or ".tsx" => "TS",
            ".wav" => "WAV",
            _ => "OTHER",
        };
        var state = fileExists
            ? "FILE"
            : directoryExists
                ? "DIRECTORY"
                : "ABSENT";
        var lease = hasWriteLease
            ? hasBoundFileObject
                ? "BOUND_LEASE"
                : "UNBOUND_LEASE"
            : completedWriteState is "DONE_ID" or "DONE_CHANGED" or "DONE_MISSING"
                ? completedWriteState
                : "NO_LEASE";
        return $"{bucket}_{extension}_{state}_{lease}";
    }
}

public static class CompletedWriteDiagnosticRules
{
    public static bool IsWithinCompletionWindow(
        long eventTimestampQpc,
        long completedAtQpc,
        long frequency)
    {
        if (frequency <= 0) return false;
        if (eventTimestampQpc <= completedAtQpc) return true;
        return (decimal)eventTimestampQpc - completedAtQpc <= (decimal)frequency * 2;
    }

    public static string AfterCompletionBucket(long deltaQpc, long frequency)
    {
        if (deltaQpc <= 0 || frequency <= 0)
            throw new ArgumentOutOfRangeException(nameof(deltaQpc));
        if ((decimal)deltaQpc * 10 <= frequency) return "WITHIN_100MS";
        if ((decimal)deltaQpc * 2 <= frequency) return "WITHIN_500MS";
        if ((decimal)deltaQpc <= (decimal)frequency * 2) return "WITHIN_2S";
        if ((decimal)deltaQpc <= (decimal)frequency * 10) return "WITHIN_10S";
        return "OVER_10S";
    }

    public static bool ShouldTrack(
        string? phase,
        int trackedCount,
        bool alreadyTracked) =>
        phase == "voice" &&
        trackedCount is >= 0 and <= 128 &&
        (trackedCount < 128 || alreadyTracked);

    public static string Classify(
        string? phase,
        bool tracked,
        bool currentExists,
        bool identityMatches) =>
        phase != "voice" || !tracked
            ? "NO_LEASE"
            : !currentExists
                ? "DONE_MISSING"
                : identityMatches
                    ? "DONE_ID"
                    : "DONE_CHANGED";

    public static bool CanAuthorize(
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool phaseMatches,
        bool eventAfterReservation,
        bool eventWithinCompletionWindow,
        bool fileObjectCompatible,
        bool currentExists,
        bool identityMatches) =>
        Rejection(
            authorizationFailure,
            systemPid,
            eventName,
            fileObject,
            phaseMatches,
            eventAfterReservation,
            eventWithinCompletionWindow,
            fileObjectCompatible,
            currentExists,
            identityMatches) is null;

    public static string? Rejection(
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool phaseMatches,
        bool eventAfterReservation,
        bool eventWithinCompletionWindow,
        bool fileObjectCompatible,
        bool currentExists,
        bool identityMatches)
    {
        if (authorizationFailure != "BIRTH_MISSING") return "AUTH_FAILURE";
        if (systemPid is not (0 or 4)) return "SYSTEM_PID";
        if (eventName != "setinfo") return "EVENT";
        if (fileObject == 0) return "FILE_OBJECT_ZERO";
        if (!phaseMatches) return "PHASE";
        if (!eventAfterReservation) return "BEFORE_RESERVATION";
        if (!eventWithinCompletionWindow) return "AFTER_COMPLETION";
        if (!fileObjectCompatible) return "FILE_OBJECT_BINDING";
        if (!currentExists) return "CURRENT_MISSING";
        if (!identityMatches) return "IDENTITY_MISMATCH";
        return null;
    }
}

public static class ClosedLeaseDiagnosticRules
{
    public static string Classify(
        bool hasSnapshot,
        bool fileObjectCompatible,
        bool currentExists,
        bool identityMatches)
    {
        if (!hasSnapshot) return "SNAPSHOT_MISSING";
        if (!fileObjectCompatible) return "FILE_OBJECT_BINDING";
        if (!currentExists) return "CURRENT_MISSING";
        if (!identityMatches) return "IDENTITY_MISMATCH";
        return "CANDIDATE";
    }
}

public static class SystemUnboundWriteDiagnosticRules
{
    public static string Classify(
        bool hasFileObject,
        bool leaseMatches,
        bool leaseClosed,
        bool hasSnapshot,
        bool currentExists,
        bool identityMatches,
        string completedWriteState)
    {
        if (!hasFileObject) return "FILE_OBJECT_ZERO";
        if (leaseMatches)
        {
            if (!hasSnapshot) return "LEASE_SNAPSHOT_MISSING";
            if (!currentExists) return "LEASE_CURRENT_MISSING";
            if (!identityMatches) return "LEASE_IDENTITY_MISMATCH";
            return leaseClosed
                ? "LEASE_CLOSED_CANDIDATE"
                : "LEASE_OPEN_CANDIDATE";
        }
        return completedWriteState switch {
            "DONE_ID" => "COMPLETED_ID",
            "DONE_CHANGED" => "COMPLETED_CHANGED",
            "DONE_MISSING" => "COMPLETED_MISSING",
            _ => "OTHER_KNOWN_PATH",
        };
    }
}

public sealed class WriteCompletionCallbackAdmission : IDisposable
{
    private readonly ReaderWriterLockSlim admission =
        new(LockRecursionPolicy.NoRecursion);
    private int disposed;

    public int ActiveCallbackCount => admission.CurrentReadCount;
    public int WaitingFinalCount => admission.WaitingWriteCount;
    public bool IsFinalHeld => admission.IsWriteLockHeld;

    public IDisposable EnterCallback() => Enter(
        admission.EnterReadLock,
        admission.ExitReadLock);

    public IDisposable EnterFinal() => Enter(
        admission.EnterWriteLock,
        admission.ExitWriteLock);

    private IDisposable Enter(Action enter, Action exit)
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref disposed) != 0,
            this);
        enter();
        if (Volatile.Read(ref disposed) == 0)
            return new AdmissionLease(exit);
        exit();
        throw new ObjectDisposedException(nameof(WriteCompletionCallbackAdmission));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        admission.EnterWriteLock();
        admission.ExitWriteLock();
        admission.Dispose();
    }

    private sealed class AdmissionLease(Action exit) : IDisposable
    {
        private Action? release = exit;

        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
}

public enum WriteCompletionBindingKind
{
    SealedCurrent,
    SealedParent,
    OtherBound,
    Cleanup,
}

public enum WriteCompletionBindingState
{
    Unbound,
    Bound,
    Retired,
}

public sealed record ImmutableBindingProof(
    long ProofSequence,
    WriteCompletionBindingKind Kind,
    string EventName,
    ulong FileObject,
    long GenerationBefore,
    long GenerationAfter,
    WriteCompletionBindingState StateBefore,
    WriteCompletionBindingState StateAfter,
    string? Identity,
    string? Path,
    bool ReusedBefore,
    bool ReusedAfter,
    bool DeleteSeenBefore,
    bool DeleteSeenAfter,
    bool CleanupSeenBefore,
    bool CleanupSeenAfter);

public sealed class WriteCompletionBufferLimitException : InvalidOperationException
{
    public WriteCompletionBufferLimitException() : base("BUFFER_LIMIT") { }
}

public static class WriteCompletionAtomicBatchRules
{
    public static void Execute(Action apply, Action commit, Action rollback)
    {
        try
        {
            apply();
            commit();
        }
        catch
        {
            rollback();
            throw;
        }
    }
}

/// <summary>
/// completion replayのqueue、proof ledger、generation handleを同じbounded ownerで保持する。
/// productionのqueue/replay/disposeとnative実Task fixtureが同じtransactionを使用する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
/// </summary>
internal sealed class WriteCompletionReplayStore<TSnapshot, TCleanup, THandle> :
    IDisposable where THandle : IDisposable
{
    private readonly int maximumSnapshots;
    private readonly int maximumCleanups;
    private readonly int maximumGenerationHandles;
    internal List<TSnapshot> Snapshots { get; } = [];
    internal List<TCleanup> Cleanups { get; } = [];
    internal Dictionary<(ulong FileObject, long Generation), THandle>
        GenerationHandles { get; } = [];
    internal WriteCompletionBindingLedger? Ledger { get; set; }
    internal bool IsDisposed { get; private set; }
    internal int SnapshotCount => Snapshots.Count;
    internal int CleanupCount => Cleanups.Count;
    internal int GenerationHandleCount => GenerationHandles.Count;
    internal bool LedgerRetained => Ledger is not null;

    internal WriteCompletionReplayStore(
        int maximumSnapshots = WriteCompletionBindingLedger.MaximumProofs,
        int maximumCleanups = WriteCompletionBindingLedger.MaximumProofs,
        int maximumGenerationHandles = WriteCompletionBindingLedger.MaximumEntries)
    {
        if (maximumSnapshots <= 0 || maximumCleanups <= 0 ||
            maximumGenerationHandles <= 0)
            throw new ArgumentOutOfRangeException(nameof(maximumSnapshots));
        this.maximumSnapshots = maximumSnapshots;
        this.maximumCleanups = maximumCleanups;
        this.maximumGenerationHandles = maximumGenerationHandles;
    }

    internal void EnqueueSnapshot(TSnapshot snapshot)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        if (Snapshots.Count >= maximumSnapshots)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        Snapshots.Add(snapshot);
    }

    internal void AddCleanup(TCleanup cleanup)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        if (Cleanups.Count >= maximumCleanups)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        Cleanups.Add(cleanup);
    }

    internal void AddGenerationHandle(
        (ulong FileObject, long Generation) key,
        THandle handle)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        if (GenerationHandles.Count >= maximumGenerationHandles)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT");
        GenerationHandles.Add(key, handle);
    }

    internal bool Replay<TCheckpoint>(
        Func<TSnapshot, ImmutableBindingProof?> snapshotProof,
        Func<TCleanup, ImmutableBindingProof> cleanupProof,
        Action<TSnapshot> preflightSnapshot,
        Action<IReadOnlyList<TSnapshot>> preflightCapacity,
        Func<TCheckpoint> captureCheckpoint,
        Action<TSnapshot> applySnapshot,
        Action<TCleanup> applyCleanup,
        Action<TCheckpoint> rollback)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        if (Snapshots.Count == 0 && Cleanups.Count == 0) return false;
        var pending = Snapshots
            .OrderBy(item => snapshotProof(item)?.ProofSequence ?? long.MaxValue)
            .ToArray();
        var proofs = pending.Select(snapshotProof)
            .Where(item => item is not null)
            .Cast<ImmutableBindingProof>()
            .Concat(Cleanups.Select(cleanupProof))
            .OrderBy(item => item.ProofSequence)
            .ToArray();
        var ledger = Ledger;
        if (pending.Any(item => snapshotProof(item) is null) || ledger is null)
            throw new GuardException(
                "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        try { ledger.Validate(proofs); }
        catch (Exception error) when (
            error is OverflowException or InvalidOperationException)
        {
            throw new GuardException(error is WriteCompletionBufferLimitException
                ? "F005_ETW_WRITE_COMPLETION_DRAIN_BUFFER_LIMIT"
                : "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
        }
        foreach (var snapshot in pending) preflightSnapshot(snapshot);
        preflightCapacity(pending);
        var checkpoint = captureCheckpoint();
        WriteCompletionAtomicBatchRules.Execute(
            () => {
                var normalByProof = pending.ToDictionary(
                    item => snapshotProof(item)!.ProofSequence);
                var cleanupByProof = Cleanups.ToDictionary(
                    item => cleanupProof(item).ProofSequence);
                foreach (var proof in proofs)
                {
                    if (normalByProof.TryGetValue(
                        proof.ProofSequence,
                        out var snapshot))
                        applySnapshot(snapshot);
                    else if (cleanupByProof.TryGetValue(
                        proof.ProofSequence,
                        out var cleanup))
                        applyCleanup(cleanup);
                    else
                        throw new GuardException(
                            "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH");
                }
            },
            () => {
                ledger.ValidateAndCommit(proofs);
                Snapshots.Clear();
                Cleanups.Clear();
            },
            () => rollback(checkpoint));
        return true;
    }

    internal void ClearEvidence()
    {
        foreach (var handle in GenerationHandles.Values) handle.Dispose();
        GenerationHandles.Clear();
        Snapshots.Clear();
        Cleanups.Clear();
        Ledger = null;
    }

    public void Dispose()
    {
        if (IsDisposed) return;
        IsDisposed = true;
        ClearEvidence();
    }
}

/// <summary>
/// completion drain専用の配送順ledger。semantic mapとは独立し、callback admission時の
/// before/afterを不変proofへ変換してbatch commitまで保持する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
/// </summary>
public sealed class WriteCompletionBindingLedger
{
    public const int MaximumEntries = 8_192;
    public const int MaximumProofs = 8_192;
    private readonly Dictionary<ulong, BindingGeneration> admitted;
    private Dictionary<ulong, BindingGeneration> applied;
    private readonly Dictionary<long, ImmutableBindingProof> admittedProofs = [];
    private long proofSequence;

    public WriteCompletionBindingLedger(
        IEnumerable<(ulong FileObject, string Identity, string Path)> baseline,
        long initialCursor = 0)
    {
        admitted = [];
        foreach (var item in baseline)
        {
            if (item.FileObject == 0 || admitted.Count >= MaximumEntries ||
                !admitted.TryAdd(item.FileObject, new BindingGeneration(
                    1,
                    WriteCompletionBindingState.Bound,
                    item.Identity,
                    item.Path,
                    false,
                    false,
                    false)))
                throw new WriteCompletionBufferLimitException();
        }
        applied = Clone(admitted);
        AdmissionHead = initialCursor;
        AppliedCursor = initialCursor;
        proofSequence = initialCursor;
    }

    public long AdmissionHead { get; private set; }
    public long AppliedCursor { get; private set; }
    public int EntryCount => admitted.Count;

    public long? ExactGeneration(ulong fileObject, string identity, string path)
    {
        return admitted.TryGetValue(fileObject, out var value) &&
            value.State == WriteCompletionBindingState.Bound &&
            value.Identity == identity && value.Path == path
            ? value.Generation
            : null;
    }

    public bool MatchesGeneration(
        ulong fileObject,
        long generation,
        string identity,
        string path,
        bool allowRetired = true) =>
        admitted.TryGetValue(fileObject, out var value) &&
        value.Generation == generation &&
        value.Identity == identity && value.Path == path &&
        (value.State == WriteCompletionBindingState.Bound ||
            allowRetired && value.State == WriteCompletionBindingState.Retired);

    public GenerationMatchResult MatchGeneration(
        ulong fileObject,
        long generation,
        string? identity,
        string? path,
        bool allowRetired = true)
    {
        if (fileObject == 0 || generation <= 0 ||
            string.IsNullOrEmpty(identity) || string.IsNullOrEmpty(path))
            return GenerationMatchResult.Invalid;
        if (!admitted.TryGetValue(fileObject, out var value))
            return GenerationMatchResult.EntryMissing;
        if (value.Generation != generation)
            return GenerationMatchResult.GenerationMismatch;
        if (!string.Equals(value.Identity, identity, StringComparison.Ordinal))
            return GenerationMatchResult.IdentityMismatch;
        if (!string.Equals(value.Path, path, StringComparison.Ordinal))
            return GenerationMatchResult.PathMismatch;
        if (value.State != WriteCompletionBindingState.Bound &&
            !(allowRetired && value.State == WriteCompletionBindingState.Retired))
            return GenerationMatchResult.StateNotBoundOrRetired;
        return GenerationMatchResult.Success;
    }

    public bool IsUnbound(ulong fileObject) =>
        fileObject != 0 && (!admitted.TryGetValue(fileObject, out var value) ||
            value.State == WriteCompletionBindingState.Unbound);

    public UnboundMatchResult MatchUnbound(ulong fileObject)
    {
        if (fileObject == 0) return UnboundMatchResult.Invalid;
        if (!admitted.TryGetValue(fileObject, out var value))
            return UnboundMatchResult.Success;
        return value.State switch {
            WriteCompletionBindingState.Unbound => UnboundMatchResult.Success,
            WriteCompletionBindingState.Bound => UnboundMatchResult.Bound,
            WriteCompletionBindingState.Retired => UnboundMatchResult.Retired,
            _ => UnboundMatchResult.OtherState,
        };
    }

    public EventFileObjectMatchResult MatchEventFileObject(
        ulong fileObject,
        string? comparePath) =>
        MatchEventFileObject(fileObject, comparePath, null, null, null, out _);

    public EventFileObjectMatchResult MatchEventFileObject(
        ulong fileObject,
        string? comparePath,
        string? eventDirectory,
        IReadOnlyCollection<string>? candidateCurrentPaths,
        IReadOnlyCollection<string>? candidateParentPaths,
        out EventFileObjectBoundPathRelation relation)
    {
        relation = EventFileObjectBoundPathRelation.Invalid;
        if (fileObject == 0) return EventFileObjectMatchResult.Invalid;
        if (!admitted.TryGetValue(fileObject, out var value))
            return EventFileObjectMatchResult.EntryMissingOrUnbound;
        var samePath = !string.IsNullOrEmpty(comparePath) &&
            string.Equals(value.Path, comparePath, StringComparison.Ordinal);
        if (value.State == WriteCompletionBindingState.Bound && !samePath)
            relation = ClassifyBoundPathRelation(
                value.Path,
                comparePath,
                eventDirectory,
                candidateCurrentPaths,
                candidateParentPaths);
        return value.State switch {
            WriteCompletionBindingState.Unbound =>
                EventFileObjectMatchResult.EntryMissingOrUnbound,
            WriteCompletionBindingState.Bound => samePath
                ? EventFileObjectMatchResult.BoundSamePath
                : EventFileObjectMatchResult.BoundOtherPath,
            WriteCompletionBindingState.Retired => samePath
                ? EventFileObjectMatchResult.RetiredSamePath
                : EventFileObjectMatchResult.RetiredOtherPath,
            _ => EventFileObjectMatchResult.OtherState,
        };
    }

    public EventDirectoryBindingState MatchEventDirectoryBinding(
        ulong fileObject,
        string? eventDirectory)
    {
        if (fileObject == 0 || string.IsNullOrEmpty(eventDirectory))
            return EventDirectoryBindingState.Invalid;
        if (!admitted.TryGetValue(fileObject, out var value) ||
            value.State != WriteCompletionBindingState.Bound ||
            !string.Equals(value.Path, eventDirectory, StringComparison.Ordinal))
            return EventDirectoryBindingState.Invalid;
        if (value.Reused) return EventDirectoryBindingState.Reused;
        if (value.DeleteSeen) return EventDirectoryBindingState.DeleteSeen;
        if (value.CleanupSeen) return EventDirectoryBindingState.CleanupSeen;
        return EventDirectoryBindingState.Live;
    }

    private static EventFileObjectBoundPathRelation ClassifyBoundPathRelation(
        string? boundPath,
        string? activeLeasePath,
        string? eventDirectory,
        IReadOnlyCollection<string>? candidateCurrentPaths,
        IReadOnlyCollection<string>? candidateParentPaths)
    {
        if (string.IsNullOrEmpty(boundPath) ||
            string.IsNullOrEmpty(activeLeasePath) ||
            string.IsNullOrEmpty(eventDirectory) ||
            candidateCurrentPaths is null || candidateParentPaths is null ||
            string.Equals(boundPath, activeLeasePath, StringComparison.Ordinal))
            return EventFileObjectBoundPathRelation.Invalid;
        if (string.Equals(boundPath, eventDirectory, StringComparison.Ordinal))
            return EventFileObjectBoundPathRelation.EventDirectory;
        if (candidateCurrentPaths.Any(item =>
                string.Equals(item, boundPath, StringComparison.Ordinal)))
            return EventFileObjectBoundPathRelation.CandidateCurrentPath;
        if (candidateParentPaths.Any(item =>
                string.Equals(item, boundPath, StringComparison.Ordinal)))
            return EventFileObjectBoundPathRelation.CandidateParentPath;
        var slash = boundPath.LastIndexOf('/');
        return slash > 0 && string.Equals(
            boundPath[..slash], eventDirectory, StringComparison.Ordinal)
            ? EventFileObjectBoundPathRelation.SameParentFile
            : EventFileObjectBoundPathRelation.DifferentParent;
    }

    public ImmutableBindingProof Admit(
        WriteCompletionBindingKind kind,
        string eventName,
        ulong fileObject,
        string? identity,
        string? path,
        long? sealedGeneration = null)
    {
        if (fileObject == 0) throw new InvalidOperationException("BINDING_MISMATCH");
        long next;
        try { next = checked(AdmissionHead + 1); }
        catch (OverflowException) { throw new WriteCompletionBufferLimitException(); }
        if (next > MaximumProofs)
            throw new WriteCompletionBufferLimitException();
        var before = admitted.GetValueOrDefault(fileObject) ??
            BindingGeneration.Unbound;
        var after = before;
        switch (kind)
        {
            case WriteCompletionBindingKind.SealedCurrent:
                if (eventName is not ("write" or "setinfo") ||
                    sealedGeneration is null ||
                    before.Generation != sealedGeneration ||
                    before.State is not (WriteCompletionBindingState.Bound or
                        WriteCompletionBindingState.Retired) ||
                    before.Identity != identity)
                    throw new InvalidOperationException("BINDING_MISMATCH");
                break;
            case WriteCompletionBindingKind.SealedParent:
                if (eventName is not ("write" or "setinfo") ||
                    before.State != WriteCompletionBindingState.Unbound)
                    throw new InvalidOperationException("BINDING_MISMATCH");
                break;
            case WriteCompletionBindingKind.OtherBound:
                after = AdmitOther(eventName, before, identity, path);
                break;
            case WriteCompletionBindingKind.Cleanup:
                after = AdmitCleanup(before);
                break;
            default:
                throw new InvalidOperationException("BINDING_MISMATCH");
        }
        var storesGeneration =
            after.State != WriteCompletionBindingState.Unbound ||
            before.State != WriteCompletionBindingState.Unbound;
        if (storesGeneration && !admitted.ContainsKey(fileObject) &&
            admitted.Count >= MaximumEntries)
            throw new WriteCompletionBufferLimitException();
        try { proofSequence = checked(proofSequence + 1); }
        catch (OverflowException) { throw new WriteCompletionBufferLimitException(); }
        next = proofSequence;
        AdmissionHead = next;
        if (storesGeneration)
            admitted[fileObject] = after;
        var proof = new ImmutableBindingProof(
            next,
            kind,
            eventName,
            fileObject,
            before.Generation,
            after.Generation,
            before.State,
            after.State,
            after.Identity ?? identity,
            after.Path ?? path,
            before.Reused,
            after.Reused,
            before.DeleteSeen,
            after.DeleteSeen,
            before.CleanupSeen,
            after.CleanupSeen);
        admittedProofs.Add(next, proof);
        return proof;
    }

    public ImmutableBindingProof? AdmitCleanup(ulong fileObject)
    {
        if (fileObject == 0 || !admitted.TryGetValue(fileObject, out var before) ||
            before.State == WriteCompletionBindingState.Unbound)
            return null;
        return Admit(
            WriteCompletionBindingKind.Cleanup,
            "cleanup",
            fileObject,
            before.Identity,
            before.Path);
    }

    public void Validate(IReadOnlyList<ImmutableBindingProof> proofs) =>
        _ = BuildShadow(proofs);

    public void ValidateAndCommit(IReadOnlyList<ImmutableBindingProof> proofs)
    {
        var (shadow, cursor) = BuildShadow(proofs);
        applied = shadow;
        AppliedCursor = cursor;
    }

    private (Dictionary<ulong, BindingGeneration> State, long Cursor) BuildShadow(
        IReadOnlyList<ImmutableBindingProof> proofs)
    {
        var shadow = Clone(applied);
        var cursor = AppliedCursor;
        foreach (var proof in proofs.OrderBy(item => item.ProofSequence))
        {
            long expectedSequence;
            try { expectedSequence = checked(cursor + 1); }
            catch (OverflowException)
            {
                throw new WriteCompletionBufferLimitException();
            }
            if (proof.ProofSequence != expectedSequence)
                throw new InvalidOperationException("BINDING_MISMATCH");
            if (!admittedProofs.TryGetValue(proof.ProofSequence, out var canonical) ||
                canonical != proof)
                throw new InvalidOperationException("BINDING_MISMATCH");
            var before = shadow.GetValueOrDefault(proof.FileObject) ??
                BindingGeneration.Unbound;
            if (!ProofMatches(before, proof))
                throw new InvalidOperationException("BINDING_MISMATCH");
            shadow[proof.FileObject] = new BindingGeneration(
                proof.GenerationAfter,
                proof.StateAfter,
                proof.Identity,
                proof.Path,
                proof.ReusedAfter,
                proof.DeleteSeenAfter,
                proof.CleanupSeenAfter);
            cursor = proof.ProofSequence;
        }
        if (cursor > AdmissionHead)
            throw new InvalidOperationException("BINDING_MISMATCH");
        return (shadow, cursor);
    }

    public bool IsConverged => AdmissionHead == AppliedCursor;

    private static BindingGeneration AdmitOther(
        string eventName,
        BindingGeneration before,
        string? identity,
        string? path)
    {
        if (identity is null || path is null)
            throw new InvalidOperationException("BINDING_MISMATCH");
        if (eventName == "delete" &&
            before.State == WriteCompletionBindingState.Retired &&
            before.CleanupSeen && !before.DeleteSeen)
        {
            if (before.Identity != identity || before.Path != path)
                throw new InvalidOperationException("BINDING_MISMATCH");
            return before with { DeleteSeen = true };
        }
        if (eventName == "delete" &&
            before.State != WriteCompletionBindingState.Bound)
            throw new InvalidOperationException("BINDING_MISMATCH");
        var value = before;
        if (before.State != WriteCompletionBindingState.Bound)
        {
            value = new BindingGeneration(
                CheckedNextGeneration(before.Generation),
                WriteCompletionBindingState.Bound,
                identity,
                path,
                before.Generation != 0 || before.Reused,
                false,
                false);
        }
        else if (before.Identity != identity)
        {
            value = new BindingGeneration(
                CheckedNextGeneration(before.Generation),
                WriteCompletionBindingState.Bound,
                identity,
                path,
                true,
                false,
                false);
        }
        else if (eventName == "rename")
        {
            value = value with { Path = path };
        }
        else if (before.Path != path)
        {
            throw new InvalidOperationException("BINDING_MISMATCH");
        }
        if (eventName == "delete")
        {
            if (value.DeleteSeen)
                throw new InvalidOperationException("BINDING_MISMATCH");
            value = value with {
                State = WriteCompletionBindingState.Retired,
                DeleteSeen = true,
            };
        }
        return value;
    }

    public static long CheckedNextGeneration(long generation)
    {
        try { return checked(generation + 1); }
        catch (OverflowException) { throw new WriteCompletionBufferLimitException(); }
    }

    private static BindingGeneration AdmitCleanup(BindingGeneration before)
    {
        if (before.CleanupSeen || before.Reused)
            throw new InvalidOperationException("BINDING_MISMATCH");
        return before with {
            State = WriteCompletionBindingState.Retired,
            CleanupSeen = true,
        };
    }

    private static bool ProofMatches(
        BindingGeneration before,
        ImmutableBindingProof proof) =>
        before.Generation == proof.GenerationBefore &&
        before.State == proof.StateBefore &&
        before.Reused == proof.ReusedBefore &&
        before.DeleteSeen == proof.DeleteSeenBefore &&
        before.CleanupSeen == proof.CleanupSeenBefore;

    private static Dictionary<ulong, BindingGeneration> Clone(
        Dictionary<ulong, BindingGeneration> source) =>
        source.ToDictionary(item => item.Key, item => item.Value);

    private sealed record BindingGeneration(
        long Generation,
        WriteCompletionBindingState State,
        string? Identity,
        string? Path,
        bool Reused,
        bool DeleteSeen,
        bool CleanupSeen)
    {
        public static readonly BindingGeneration Unbound = new(
            0,
            WriteCompletionBindingState.Unbound,
            null,
            null,
            false,
            false,
            false);
    }
}

public readonly record struct LateEventDiagnosticCandidate(
    bool CompletedRetained,
    bool ParentPath,
    bool ActiveLeasePresent,
    bool OtherActiveLease,
    bool SameParent,
    bool PostReservation);

public enum WriteCompletionReplayKind
{
    NormalEpoch,
    PostRequestSystemSetInfo,
}

public enum CompletedNoLeaseKnownAuthorizationDecision
{
    Pass,
    Poisoned,
    StateChanged,
}

public readonly record struct ProducerBirthFingerprint(
    bool Present,
    ulong ProcessSequenceNumber,
    long StartedAtQpc);

public enum ProducerBirthFingerprintDecision
{
    Wait,
    Ready,
    TupleMismatch,
}

public static class CapacityGuardLifecycleRules
{
    public const string SessionAbortFailureCode = "CAPACITY_SESSION_ABORTED";
    public const string SessionAbortTimeoutFailureCode =
        "CAPACITY_SESSION_ABORT_TIMEOUT";

    public static bool BeginDisposeLocked(
        object gate,
        ref bool disposed,
        ref string? failureCode)
    {
        if (!Monitor.IsEntered(gate))
            throw new InvalidOperationException("CAPACITY_GATE_NOT_HELD");
        if (disposed) return false;
        disposed = true;
        failureCode ??= SessionAbortFailureCode;
        Monitor.PulseAll(gate);
        return true;
    }

    public static string? WaitAbortFailureCode(
        string? failureCode,
        bool disposed,
        bool cancellationRequested,
        bool journalClosed,
        string stateChangedFailureCode)
    {
        if (failureCode is not null) return failureCode;
        return disposed || cancellationRequested || journalClosed
            ? stateChangedFailureCode
            : null;
    }

    public static void CancelDrainPipeAndDispose(
        CancellationTokenSource cancellation,
        Task pipeTask,
        TimeSpan timeout,
        Action disposeResources)
    {
        cancellation.Cancel();
        bool pipeCompleted;
        try
        {
            pipeCompleted = pipeTask.Wait(timeout);
        }
        catch
        {
            pipeCompleted = pipeTask.IsCompleted;
        }
        if (!pipeCompleted)
            throw new GuardException(SessionAbortTimeoutFailureCode);
        disposeResources();
    }
}

public static class WriteLeaseProducerBirthFenceRules
{
    public const string TimeoutFailureCode =
        "WRITE_LEASE_PRODUCER_BIRTH_TIMEOUT";
    public const string TupleMismatchFailureCode =
        "WRITE_LEASE_PRODUCER_BIRTH_TUPLE_MISMATCH";
    public const string ProcessIdentityFailureCode =
        "WRITE_LEASE_PRODUCER_BIRTH_PROCESS_IDENTITY_FAILED";
    public const string StateChangedFailureCode =
        "WRITE_LEASE_PRODUCER_BIRTH_STATE_CHANGED";
    private static readonly string[] rawFailureCodes = [
        TimeoutFailureCode,
        TupleMismatchFailureCode,
        ProcessIdentityFailureCode,
        StateChangedFailureCode,
    ];
    public static IReadOnlyList<string> RawFailureCodes { get; } =
        Array.AsReadOnly(rawFailureCodes);

    public static bool IsRawFailureCode(string code) =>
        rawFailureCodes.Contains(code, StringComparer.Ordinal);

    public static string NormalizeProcessIdentityGuardFailureCode(
        string guardFailureCode)
    {
        _ = guardFailureCode;
        return ProcessIdentityFailureCode;
    }

    public static bool TryCreateDeadline(
        long startQpc,
        long frequency,
        out long deadlineQpc)
    {
        deadlineQpc = 0;
        if (startQpc <= 0 || frequency <= 0) return false;
        try
        {
            var durationQpc = checked(frequency * 10);
            deadlineQpc = checked(startQpc + durationQpc);
            return deadlineQpc > startQpc;
        }
        catch (OverflowException)
        {
            return false;
        }
    }

    public static bool IsDeadlineReached(long nowQpc, long deadlineQpc) =>
        nowQpc >= deadlineQpc;

    public static int CeilingWaitMilliseconds(
        long remainingQpc,
        long frequency)
    {
        if (remainingQpc <= 0 || frequency <= 0) return 1;
        var wholeSeconds = remainingQpc / frequency;
        if (wholeSeconds > int.MaxValue / 1000L) return int.MaxValue;
        var remainderQpc = remainingQpc % frequency;
        var milliseconds = checked(wholeSeconds * 1000L);
        if (remainderQpc != 0)
            milliseconds = checked(milliseconds + (long)Math.Ceiling(
                (decimal)remainderQpc * 1000m / frequency));
        if (milliseconds <= 0) return 1;
        return milliseconds >= int.MaxValue
            ? int.MaxValue
            : checked((int)milliseconds);
    }

    public static ProducerBirthFingerprintDecision FingerprintDecision(
        ProducerBirthFingerprint entry,
        ProducerBirthFingerprint current,
        ulong expectedProcessSequenceNumber)
    {
        if (current.Present &&
            current.ProcessSequenceNumber == expectedProcessSequenceNumber)
            return ProducerBirthFingerprintDecision.Ready;
        if (current == entry)
            return ProducerBirthFingerprintDecision.Wait;
        if (!entry.Present && !current.Present)
            return ProducerBirthFingerprintDecision.Wait;
        return ProducerBirthFingerprintDecision.TupleMismatch;
    }
}

public sealed class WriteLeaseReservationTransaction
{
    public bool SnapshotCreated { get; private set; }
    public bool LeaseCreated { get; private set; }
    public bool Published { get; private set; }

    public void Publish<TSnapshot, TLease>(
        Func<TSnapshot> createSnapshot,
        Func<TSnapshot, TLease> createLease,
        Action<TLease> publishLease)
    {
        if (SnapshotCreated || LeaseCreated || Published)
            throw new InvalidOperationException(
                "WRITE_LEASE_RESERVATION_TRANSACTION_REUSED");
        var snapshot = createSnapshot();
        SnapshotCreated = true;
        var lease = createLease(snapshot);
        LeaseCreated = true;
        publishLease(lease);
        Published = true;
    }

    public Exception FenceFailure(string failureCode)
    {
        if (!WriteLeaseProducerBirthFenceRules.IsRawFailureCode(failureCode))
            return new InvalidOperationException(
                "WRITE_LEASE_RESERVATION_FAILURE_CODE_INVALID");
        if (SnapshotCreated || LeaseCreated || Published)
            return new InvalidOperationException(
                "WRITE_LEASE_RESERVATION_FAILURE_AFTER_PUBLICATION");
        return new GuardException(failureCode);
    }
}

public static class WriteCompletionDrainRules
{
    private const string FailurePrefix = "F005_ETW_WRITE_COMPLETION_DRAIN_";
    public const string EventTupleMismatchFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_MISMATCH";
    public const string LookupEpochEmptyNoLateProofFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_NO_LATE_PROOF";
    public const string LookupEpochEmptyAtOrBeforeReservationAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_AT_OR_BEFORE_RESERVATION_ALL";
    public const string LookupEpochEmptyPostUpperProofMissingAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_MISSING_ALL";
    public const string LookupEpochEmptyTimeProofMixedFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_TIME_PROOF_MIXED";
    public const string LookupPostUpperProofLedgerUnavailableAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_LEDGER_UNAVAILABLE_ALL";
    public const string LookupPostUpperProofCurrentFileObjectMismatchAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_FILE_OBJECT_MISMATCH_ALL";
    public const string LookupPostUpperProofCurrentBindingMismatchAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_MISMATCH_ALL";
    public const string LookupPostUpperProofCurrentBindingEntryMissingAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_ENTRY_MISSING_ALL";
    public const string LookupPostUpperProofCurrentBindingGenerationMismatchAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_GENERATION_MISMATCH_ALL";
    public const string LookupPostUpperProofCurrentBindingIdentityMismatchAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_IDENTITY_MISMATCH_ALL";
    public const string LookupPostUpperProofCurrentBindingPathMismatchAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_PATH_MISMATCH_ALL";
    public const string LookupPostUpperProofCurrentBindingStateNotBoundAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_STATE_NOT_BOUND_ALL";
    public const string LookupPostUpperProofCurrentBindingStateNotBoundOrRetiredAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_STATE_NOT_BOUND_OR_RETIRED_ALL";
    public const string LookupPostUpperProofCurrentBindingMixedFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_CURRENT_BINDING_MIXED";
    public const string LookupPostUpperProofParentNotUnboundAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_NOT_UNBOUND_ALL";
    public const string LookupPostUpperProofParentBoundAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_ALL";
    public const string LookupPostUpperProofParentRetiredAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_RETIRED_ALL";
    public const string LookupPostUpperProofParentOtherStateAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_OTHER_STATE_ALL";
    public const string LookupPostUpperProofParentStateMixedFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_STATE_MIXED";
    public const string LookupPostUpperProofParentBoundActiveLeaseWriteAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_ACTIVE_LEASE_WRITE_ALL";
    public const string LookupPostUpperProofParentBoundActiveLeaseSetInfoAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_ACTIVE_LEASE_SETINFO_ALL";
    public const string LookupPostUpperProofParentBoundActiveLeaseBindingMismatchAllFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_ACTIVE_LEASE_BINDING_MISMATCH_ALL";
    public const string LookupPostUpperProofParentBoundContextMissingFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_CONTEXT_MISSING";
    public const string LookupPostUpperProofParentBoundTupleInvalidFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_TUPLE_INVALID";
    public const string LookupPostUpperProofParentBoundPhaseMismatchFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_PHASE_MISMATCH";
    public const string LookupPostUpperProofParentBoundParentMismatchFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_PARENT_MISMATCH";
    public const string LookupPostUpperProofParentBoundReservationOrderFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_RESERVATION_ORDER";
    public const string LookupPostUpperProofParentBoundEventFileObjectMismatchFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_EVENT_FO_MISMATCH";
    public const string LookupPostUpperProofParentBoundLedgerMissingFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_LEDGER_MISSING";
    private const string ParentBoundEventFileObjectPrefix =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_PARENT_BOUND_EVENT_FO_";
    public const string LookupPostUpperProofParentBoundEventFileObjectEntryMissingOrUnboundFailureCode =
        $"{ParentBoundEventFileObjectPrefix}ENTRY_MISSING_OR_UNBOUND";
    public const string LookupPostUpperProofParentBoundEventFileObjectBoundSamePathFailureCode =
        $"{ParentBoundEventFileObjectPrefix}BOUND_SAME_PATH";
    public const string LookupPostUpperProofParentBoundEventFileObjectBoundOtherPathFailureCode =
        $"{ParentBoundEventFileObjectPrefix}BOUND_OTHER_PATH";
    public const string LookupPostUpperProofParentBoundEventFileObjectRetiredSamePathFailureCode =
        $"{ParentBoundEventFileObjectPrefix}RETIRED_SAME_PATH";
    public const string LookupPostUpperProofParentBoundEventFileObjectRetiredOtherPathFailureCode =
        $"{ParentBoundEventFileObjectPrefix}RETIRED_OTHER_PATH";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherStateFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_STATE";
    public const string LookupPostUpperProofParentBoundEventFileObjectLookupInvalidFailureCode =
        $"{ParentBoundEventFileObjectPrefix}LOOKUP_INVALID";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherEventDirectoryFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_EVENT_DIR";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherCandidateCurrentFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_CANDIDATE_CURRENT";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherCandidateParentFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_CANDIDATE_PARENT";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherSameParentFileFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_SAME_PARENT_FILE";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherDifferentParentFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_DIFFERENT_PARENT";
    public const string LookupPostUpperProofParentBoundEventFileObjectOtherRelationInvalidFailureCode =
        $"{ParentBoundEventFileObjectPrefix}OTHER_RELATION_INVALID";
    private const string ParentBoundEventDirectoryPrefix =
        $"{ParentBoundEventFileObjectPrefix}DIR_";
    public const string LookupPostUpperProofParentBoundEventDirectoryReusedFailureCode =
        $"{ParentBoundEventDirectoryPrefix}REUSED";
    public const string LookupPostUpperProofParentBoundEventDirectoryDeleteSeenFailureCode =
        $"{ParentBoundEventDirectoryPrefix}DELETE_SEEN";
    public const string LookupPostUpperProofParentBoundEventDirectoryCleanupSeenFailureCode =
        $"{ParentBoundEventDirectoryPrefix}CLEANUP_SEEN";
    public const string LookupPostUpperProofParentBoundEventDirectoryLiveFailureCode =
        $"{ParentBoundEventDirectoryPrefix}LIVE";
    public const string LookupPostUpperProofParentBoundEventDirectoryStateInvalidFailureCode =
        $"{ParentBoundEventDirectoryPrefix}STATE_INVALID";
    public const string LookupPostUpperProofMixedFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EPOCH_EMPTY_POST_UPPER_PROOF_MIXED";
    public const string LookupExactMissingFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EXACT_MISSING";
    public const string LookupExactAmbiguousFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_LOOKUP_EXACT_AMBIGUOUS";
    public const string RecheckSealMissingFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_RECHECK_SEAL_MISSING";
    public const string RecheckSealAmbiguousFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_RECHECK_SEAL_AMBIGUOUS";
    public const string RecheckFieldsFailureCode =
        $"{FailurePrefix}EVENT_TUPLE_RECHECK_FIELDS";
    public const string GenericLateEventFailureCode =
        "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_EVENT_AFTER_SEAL";
    public const string LateRetainedParentWriteFailureCode =
        "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_WRITE";
    public const string LateRetainedParentSetInfoFailureCode =
        "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_RETAINED_PARENT_OTHER_ACTIVE_SAME_PARENT_POST_RESERVATION_SETINFO";
    private const string LateDiagnosticPrefix =
        "F005_ETW_WRITE_COMPLETION_DRAIN_LATE_DIAG_";
    public const string LateDiagnosticWriteMixedCausesFailureCode =
        $"{LateDiagnosticPrefix}WRITE_MIXED_CAUSES";
    public const string LateDiagnosticSetInfoMixedCausesFailureCode =
        $"{LateDiagnosticPrefix}SETINFO_MIXED_CAUSES";
    public const string LateDiagnosticSetInfoCurrentPathFailureCode =
        $"{LateDiagnosticPrefix}SETINFO_CURRENT_PATH";
    public const string LateDiagnosticSetInfoSealNotCompletedRetainedFailureCode =
        $"{LateDiagnosticPrefix}SETINFO_SEAL_NOT_COMPLETED_RETAINED";
    public const string LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode =
        $"{LateDiagnosticPrefix}WRITE_AT_OR_BEFORE_ACTIVE_RESERVATION";
    public const string LateDiagnosticWriteActiveLeaseMissingFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_LEASE_MISSING";
    public const string LateDiagnosticWriteActiveProducerRecordMissingFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_RECORD_MISSING";
    public const string LateDiagnosticWriteActiveProducerTupleMismatchFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_TUPLE_MISMATCH";
    public const string LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode =
        $"{LateDiagnosticPrefix}WRITE_AT_OR_BEFORE_ACTIVE_PRODUCER_BIRTH";
    public const string LateDiagnosticWriteAfterActiveProducerBirthFailureCode =
        $"{LateDiagnosticPrefix}WRITE_AFTER_ACTIVE_PRODUCER_BIRTH";
    public const string LateDiagnosticWriteReservationBirthRecordMissingFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_RESERVATION_BIRTH_RECORD_MISSING";
    public const string LateDiagnosticWriteReservationBirthTupleMismatchFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_RESERVATION_BIRTH_TUPLE_MISMATCH";
    public const string LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_AT_OR_BEFORE_RESERVATION_BIRTH";
    public const string LateDiagnosticWriteAfterReservationBirthFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_AFTER_RESERVATION_BIRTH";
    public const string LateDiagnosticWriteAfterReservationBirthAtOrBeforeInitialFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_AFTER_RESERVATION_BIRTH_AT_OR_BEFORE_INITIAL";
    public const string LateDiagnosticWriteAfterReservationBirthAfterInitialToCurrentFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_AFTER_RESERVATION_BIRTH_AFTER_INITIAL_TO_CURRENT";
    public const string LateDiagnosticWriteReservationStateActivePhaseChangedFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_RESERVATION_STATE_ACTIVE_PHASE_CHANGED";
    public const string LateDiagnosticWriteReservationStateCurrentBeforeInitialFailureCode =
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PRODUCER_RESERVATION_STATE_CURRENT_BEFORE_INITIAL";
    public const string CompletedNoLeaseDirectoryHandoffCandidateAmbiguousFailureCode =
        $"{FailurePrefix}COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS";
    public const string CompletedNoLeaseDirectoryHandoffIdentityMatchNoneFailureCode =
        $"{FailurePrefix}COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_IDENTITY_MATCH_NONE";
    public const string CompletedNoLeaseDirectoryHandoffIdentityMatchAmbiguousFailureCode =
        $"{FailurePrefix}COMPLETED_NO_LEASE_DIRECTORY_HANDOFF_IDENTITY_MATCH_AMBIGUOUS";
    public const string ActiveDirectoryHandoffCandidateAmbiguousFailureCode =
        $"{FailurePrefix}ACTIVE_DIRECTORY_HANDOFF_CANDIDATE_AMBIGUOUS";
    public const string ActiveDirectoryHandoffEligibleExactOneFailureCode =
        $"{FailurePrefix}ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_EXACT_ONE";
    public const string ActiveDirectoryHandoffEligibleAmbiguousFailureCode =
        $"{FailurePrefix}ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_AMBIGUOUS";
    public const string ActiveDirectoryHandoffEligibleAllFailureCode =
        $"{FailurePrefix}ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_ALL";
    public const string ActiveDirectoryHandoffEligibleMixedFailureCode =
        $"{FailurePrefix}ACTIVE_DIRECTORY_HANDOFF_ELIGIBLE_MIXED";
    public const string StateChangedFailureCode =
        $"{FailurePrefix}STATE_CHANGED";
    private static readonly string[] externalFailureCodes = [
        $"{FailurePrefix}PREPARE_TUPLE_MISMATCH",
        $"{FailurePrefix}PROCESS_IDENTITY_FAILED",
        $"{FailurePrefix}PROCESS_WAIT_FAILED",
        $"{FailurePrefix}JOB_QUERY_FAILED",
        $"{FailurePrefix}PROCESS_TUPLE_MISMATCH",
        $"{FailurePrefix}PROCESS_SIGNALED",
        $"{FailurePrefix}PROCESS_OUTSIDE_JOB",
        EventTupleMismatchFailureCode,
        LookupEpochEmptyNoLateProofFailureCode,
        LookupEpochEmptyAtOrBeforeReservationAllFailureCode,
        LookupEpochEmptyPostUpperProofMissingAllFailureCode,
        LookupEpochEmptyTimeProofMixedFailureCode,
        LookupPostUpperProofLedgerUnavailableAllFailureCode,
        LookupPostUpperProofCurrentFileObjectMismatchAllFailureCode,
        LookupPostUpperProofCurrentBindingMismatchAllFailureCode,
        LookupPostUpperProofCurrentBindingEntryMissingAllFailureCode,
        LookupPostUpperProofCurrentBindingGenerationMismatchAllFailureCode,
        LookupPostUpperProofCurrentBindingIdentityMismatchAllFailureCode,
        LookupPostUpperProofCurrentBindingPathMismatchAllFailureCode,
        LookupPostUpperProofCurrentBindingStateNotBoundAllFailureCode,
        LookupPostUpperProofCurrentBindingStateNotBoundOrRetiredAllFailureCode,
        LookupPostUpperProofCurrentBindingMixedFailureCode,
        LookupPostUpperProofParentNotUnboundAllFailureCode,
        LookupPostUpperProofParentBoundAllFailureCode,
        LookupPostUpperProofParentRetiredAllFailureCode,
        LookupPostUpperProofParentOtherStateAllFailureCode,
        LookupPostUpperProofParentStateMixedFailureCode,
        LookupPostUpperProofParentBoundActiveLeaseWriteAllFailureCode,
        LookupPostUpperProofParentBoundActiveLeaseSetInfoAllFailureCode,
        LookupPostUpperProofParentBoundActiveLeaseBindingMismatchAllFailureCode,
        LookupPostUpperProofParentBoundContextMissingFailureCode,
        LookupPostUpperProofParentBoundTupleInvalidFailureCode,
        LookupPostUpperProofParentBoundPhaseMismatchFailureCode,
        LookupPostUpperProofParentBoundParentMismatchFailureCode,
        LookupPostUpperProofParentBoundReservationOrderFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectMismatchFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectEntryMissingOrUnboundFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectBoundSamePathFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectBoundOtherPathFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectRetiredSamePathFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectRetiredOtherPathFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherStateFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectLookupInvalidFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherEventDirectoryFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherCandidateCurrentFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherCandidateParentFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherSameParentFileFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherDifferentParentFailureCode,
        LookupPostUpperProofParentBoundEventFileObjectOtherRelationInvalidFailureCode,
        LookupPostUpperProofParentBoundEventDirectoryReusedFailureCode,
        LookupPostUpperProofParentBoundEventDirectoryDeleteSeenFailureCode,
        LookupPostUpperProofParentBoundEventDirectoryCleanupSeenFailureCode,
        LookupPostUpperProofParentBoundEventDirectoryLiveFailureCode,
        LookupPostUpperProofParentBoundEventDirectoryStateInvalidFailureCode,
        LookupPostUpperProofParentBoundLedgerMissingFailureCode,
        LookupPostUpperProofMixedFailureCode,
        LookupExactMissingFailureCode,
        LookupExactAmbiguousFailureCode,
        RecheckSealMissingFailureCode,
        RecheckSealAmbiguousFailureCode,
        RecheckFieldsFailureCode,
        $"{FailurePrefix}EVENT_IDENTITY_FAILED",
        $"{FailurePrefix}BUFFER_LIMIT",
        $"{FailurePrefix}FAILED",
        $"{FailurePrefix}TIMEOUT",
        StateChangedFailureCode,
        $"{FailurePrefix}DIRECTORY_IDENTITY_MISMATCH",
        $"{FailurePrefix}CURRENT_IDENTITY_MISMATCH",
        $"{FailurePrefix}BINDING_MISMATCH",
        $"{FailurePrefix}RECHECK_PROCESS_IDENTITY_FAILED",
        $"{FailurePrefix}RECHECK_PROCESS_WAIT_FAILED",
        $"{FailurePrefix}RECHECK_PROCESS_TUPLE_MISMATCH",
        $"{FailurePrefix}RECHECK_PROCESS_NOT_SIGNALED",
        GenericLateEventFailureCode,
        LateRetainedParentWriteFailureCode,
        LateRetainedParentSetInfoFailureCode,
        $"{LateDiagnosticPrefix}WRITE_SEAL_NOT_COMPLETED_RETAINED",
        $"{LateDiagnosticPrefix}WRITE_CURRENT_PATH",
        LateDiagnosticWriteActiveLeaseMissingFailureCode,
        $"{LateDiagnosticPrefix}WRITE_ACTIVE_PARENT_MISMATCH",
        LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode,
        LateDiagnosticWriteMixedCausesFailureCode,
        LateDiagnosticSetInfoSealNotCompletedRetainedFailureCode,
        LateDiagnosticSetInfoCurrentPathFailureCode,
        $"{LateDiagnosticPrefix}SETINFO_ACTIVE_LEASE_MISSING",
        $"{LateDiagnosticPrefix}SETINFO_ACTIVE_PARENT_MISMATCH",
        $"{LateDiagnosticPrefix}SETINFO_AT_OR_BEFORE_ACTIVE_RESERVATION",
        LateDiagnosticSetInfoMixedCausesFailureCode,
        LateDiagnosticWriteActiveProducerRecordMissingFailureCode,
        LateDiagnosticWriteActiveProducerTupleMismatchFailureCode,
        LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode,
        LateDiagnosticWriteAfterActiveProducerBirthFailureCode,
        LateDiagnosticWriteReservationBirthRecordMissingFailureCode,
        LateDiagnosticWriteReservationBirthTupleMismatchFailureCode,
        LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode,
        LateDiagnosticWriteAfterReservationBirthFailureCode,
        LateDiagnosticWriteAfterReservationBirthAtOrBeforeInitialFailureCode,
        LateDiagnosticWriteAfterReservationBirthAfterInitialToCurrentFailureCode,
        LateDiagnosticWriteReservationStateActivePhaseChangedFailureCode,
        LateDiagnosticWriteReservationStateCurrentBeforeInitialFailureCode,
        CompletedNoLeaseDirectoryHandoffCandidateAmbiguousFailureCode,
        CompletedNoLeaseDirectoryHandoffIdentityMatchNoneFailureCode,
        CompletedNoLeaseDirectoryHandoffIdentityMatchAmbiguousFailureCode,
        ActiveDirectoryHandoffCandidateAmbiguousFailureCode,
        ActiveDirectoryHandoffEligibleExactOneFailureCode,
        ActiveDirectoryHandoffEligibleAmbiguousFailureCode,
        ActiveDirectoryHandoffEligibleAllFailureCode,
        ActiveDirectoryHandoffEligibleMixedFailureCode,
    ];
    private static readonly HashSet<string> externalFailureCodeSet = new(
        externalFailureCodes,
        StringComparer.Ordinal);

    public static IReadOnlyList<string> ExternalFailureCodes { get; } =
        Array.AsReadOnly(externalFailureCodes);

    public static string EpochEmptyNoLateFailureCode(
        int broadCount,
        int atOrBeforeReservationCount,
        int postUpperProofMissingCount,
        int temporalInvalidCount)
    {
        if (broadCount is <= 0 or > 128 || atOrBeforeReservationCount < 0 ||
            postUpperProofMissingCount < 0 || temporalInvalidCount != 0 ||
            (long)atOrBeforeReservationCount + postUpperProofMissingCount !=
                broadCount)
            return StateChangedFailureCode;
        if (atOrBeforeReservationCount == broadCount)
            return LookupEpochEmptyAtOrBeforeReservationAllFailureCode;
        if (postUpperProofMissingCount == broadCount)
            return LookupEpochEmptyPostUpperProofMissingAllFailureCode;
        return LookupEpochEmptyTimeProofMixedFailureCode;
    }

    public static EpochCandidateClassification<T> ClassifyEpochCandidates<T>(
        IReadOnlyList<T> candidates,
        long eventQpc,
        Func<T, long> reservationSelector,
        Func<T, long?> upperSelector,
        Func<T, LateProofEvaluation> evaluateProof)
    {
        var epoch = ImmutableArray.CreateBuilder<T>();
        var late = ImmutableArray.CreateBuilder<T>();
        var pre = 0;
        var missing = 0;
        var invalid = 0;
        var proofInvalid = 0;
        var proofResults = ImmutableArray.CreateBuilder<LateProofResult>();
        var generationResults = ImmutableArray.CreateBuilder<GenerationMatchResult?>();
        var unboundResults = ImmutableArray.CreateBuilder<UnboundMatchResult?>();
        foreach (var candidate in candidates)
        {
            var reservation = reservationSelector(candidate);
            var upper = upperSelector(candidate);
            if (upper is long presentUpper && reservation > presentUpper)
            {
                invalid++;
                continue;
            }
            if (upper is null
                    ? eventQpc > reservation
                    : IsWithinEpoch(reservation, upper.Value, eventQpc))
            {
                epoch.Add(candidate);
            }
            else if (eventQpc <= reservation)
            {
                pre++;
            }
            else if (upper is long completedUpper && eventQpc > completedUpper)
            {
                var proof = evaluateProof(candidate);
                proofResults.Add(proof.Outer);
                generationResults.Add(proof.GenerationMatch);
                unboundResults.Add(proof.UnboundMatch);
                if (proof.Outer == LateProofResult.Success) late.Add(candidate);
                else if (proof.Outer == LateProofResult.Invalid) proofInvalid++;
                else missing++;
            }
            else invalid++;
        }
        return new EpochCandidateClassification<T>(
            epoch.ToImmutable(), late.ToImmutable(), pre, missing, invalid,
            proofInvalid, proofResults.ToImmutable(),
            generationResults.ToImmutable(), unboundResults.ToImmutable());
    }

    public static EpochCandidateClassification<T> ClassifyEpochCandidates<T>(
        IReadOnlyList<T> candidates,
        long eventQpc,
        Func<T, long> reservationSelector,
        Func<T, long?> upperSelector,
        Func<T, LateProofResult> evaluateProof) =>
        ClassifyEpochCandidates(candidates, eventQpc, reservationSelector,
            upperSelector, item => new LateProofEvaluation(
                evaluateProof(item), null));

    public static LateProofResult EvaluateLateProof(
        bool currentPath,
        bool parentPath,
        ulong eventFileObject,
        ulong leaseFileObject,
        long leaseGeneration,
        string? currentIdentity,
        string? sealedCurrentPath,
        bool ledgerAvailable,
        Func<bool>? currentBindingMatches,
        Func<bool>? parentIsUnbound)
        => EvaluateLateProofDetail(
            currentPath, parentPath, eventFileObject, leaseFileObject,
            leaseGeneration, currentIdentity, sealedCurrentPath,
            ledgerAvailable,
            currentBindingMatches is null ? null : () =>
                currentBindingMatches()
                    ? GenerationMatchResult.Success
                    : GenerationMatchResult.GenerationMismatch,
            parentIsUnbound is null ? null : () =>
                parentIsUnbound()
                    ? UnboundMatchResult.Success
                    : UnboundMatchResult.Bound).Outer;

    public static LateProofEvaluation EvaluateLateProofDetail(
        bool currentPath,
        bool parentPath,
        ulong eventFileObject,
        ulong leaseFileObject,
        long leaseGeneration,
        string? currentIdentity,
        string? sealedCurrentPath,
        bool ledgerAvailable,
        Func<GenerationMatchResult>? currentBindingMatch,
        Func<UnboundMatchResult>? parentUnboundMatch)
    {
        if (currentPath == parentPath || eventFileObject == 0 ||
            (currentPath && (leaseFileObject == 0 || leaseGeneration <= 0 ||
                string.IsNullOrEmpty(currentIdentity) ||
                string.IsNullOrEmpty(sealedCurrentPath) ||
                currentBindingMatch is null)) ||
            (parentPath && parentUnboundMatch is null))
            return new(LateProofResult.Invalid, null);
        if (!ledgerAvailable) return new(LateProofResult.LedgerUnavailable, null);
        if (currentPath && eventFileObject != leaseFileObject)
            return new(LateProofResult.CurrentFileObjectMismatch, null);
        if (currentPath)
        {
            var generationMatch = currentBindingMatch!();
            if (!Enum.IsDefined(generationMatch) ||
                generationMatch == GenerationMatchResult.Invalid)
                return new(LateProofResult.Invalid, generationMatch);
            if (generationMatch != GenerationMatchResult.Success)
                return new(LateProofResult.CurrentBindingMismatch, generationMatch);
        }
        if (parentPath)
        {
            var unboundMatch = parentUnboundMatch!();
            if (!Enum.IsDefined(unboundMatch) ||
                unboundMatch == UnboundMatchResult.Invalid)
                return new(LateProofResult.Invalid, null, unboundMatch);
            if (unboundMatch != UnboundMatchResult.Success)
                return new(LateProofResult.ParentNotUnbound, null, unboundMatch);
        }
        return new(LateProofResult.Success,
            currentPath ? GenerationMatchResult.Success : null,
            parentPath ? UnboundMatchResult.Success : null);
    }

    public static string EpochEmptyPostUpperProofFailureCode(
        IReadOnlyCollection<LateProofResult> results,
        IReadOnlyCollection<GenerationMatchResult?>? generationResults = null,
        IReadOnlyCollection<UnboundMatchResult?>? unboundResults = null)
    {
        if (results.Count is < 1 or > 128 ||
            results.Any(result => !Enum.IsDefined(result)) ||
            results.Any(result => result is LateProofResult.Invalid or
                LateProofResult.Success))
            return StateChangedFailureCode;
        if (generationResults is not null && unboundResults is null)
        {
            if (generationResults.Count != results.Count) return StateChangedFailureCode;
            using var outer = results.GetEnumerator();
            using var generation = generationResults.GetEnumerator();
            while (outer.MoveNext() && generation.MoveNext())
            {
                var currentBinding = outer.Current == LateProofResult.CurrentBindingMismatch;
                var validFailure = generation.Current is GenerationMatchResult value &&
                    Enum.IsDefined(value) &&
                    value is not (GenerationMatchResult.Invalid or GenerationMatchResult.Success);
                if (currentBinding != validFailure) return StateChangedFailureCode;
            }
        }
        else if (generationResults is null && unboundResults is not null)
        {
            if (unboundResults.Count != results.Count) return StateChangedFailureCode;
            using var outer = results.GetEnumerator();
            using var unbound = unboundResults.GetEnumerator();
            while (outer.MoveNext() && unbound.MoveNext())
            {
                var parent = outer.Current == LateProofResult.ParentNotUnbound;
                var validFailure = unbound.Current is UnboundMatchResult value &&
                    Enum.IsDefined(value) && value is UnboundMatchResult.Bound or
                        UnboundMatchResult.Retired or UnboundMatchResult.OtherState;
                if (parent != validFailure) return StateChangedFailureCode;
            }
        }
        else if (generationResults is not null && unboundResults is not null)
        {
            if (generationResults.Count != results.Count ||
                unboundResults.Count != results.Count) return StateChangedFailureCode;
            using var outer = results.GetEnumerator();
            using var generation = generationResults.GetEnumerator();
            using var unbound = unboundResults.GetEnumerator();
            while (outer.MoveNext() && generation.MoveNext() && unbound.MoveNext())
            {
                var currentBinding = outer.Current == LateProofResult.CurrentBindingMismatch;
                var validGenerationFailure = generation.Current is GenerationMatchResult value &&
                    Enum.IsDefined(value) &&
                    value is not (GenerationMatchResult.Invalid or GenerationMatchResult.Success);
                var parentNotUnbound = outer.Current == LateProofResult.ParentNotUnbound;
                var validUnboundFailure = unbound.Current is UnboundMatchResult unboundValue &&
                    Enum.IsDefined(unboundValue) &&
                    unboundValue is UnboundMatchResult.Bound or
                        UnboundMatchResult.Retired or UnboundMatchResult.OtherState;
                if (currentBinding != validGenerationFailure ||
                    parentNotUnbound != validUnboundFailure ||
                    validGenerationFailure && unbound.Current is not null ||
                    validUnboundFailure && generation.Current is not null ||
                    !currentBinding && !parentNotUnbound &&
                        (generation.Current is not null || unbound.Current is not null))
                    return StateChangedFailureCode;
            }
        }
        var distinct = results.Distinct().ToArray();
        if (distinct.Length != 1) return LookupPostUpperProofMixedFailureCode;
        if (distinct[0] == LateProofResult.CurrentBindingMismatch)
            return generationResults is null
                ? LookupPostUpperProofCurrentBindingMismatchAllFailureCode
                : CurrentBindingFailureCode(generationResults);
        if (distinct[0] == LateProofResult.ParentNotUnbound)
            return unboundResults is null
                ? LookupPostUpperProofParentNotUnboundAllFailureCode
                : ParentStateFailureCode(unboundResults);
        return distinct[0] switch {
            LateProofResult.LedgerUnavailable =>
                LookupPostUpperProofLedgerUnavailableAllFailureCode,
            LateProofResult.CurrentFileObjectMismatch =>
                LookupPostUpperProofCurrentFileObjectMismatchAllFailureCode,
            LateProofResult.CurrentBindingMismatch =>
                LookupPostUpperProofCurrentBindingMismatchAllFailureCode,
            LateProofResult.ParentNotUnbound =>
                LookupPostUpperProofParentNotUnboundAllFailureCode,
            _ => StateChangedFailureCode,
        };
    }

    public static string ParentStateFailureCode(
        IReadOnlyCollection<UnboundMatchResult?>? results)
    {
        if (results is null || results.Count is < 1 or > 128 ||
            results.Any(result => result is null || !Enum.IsDefined(result.Value) ||
                result.Value is UnboundMatchResult.Invalid or UnboundMatchResult.Success))
            return StateChangedFailureCode;
        var distinct = results.Select(result => result!.Value).Distinct().ToArray();
        if (distinct.Length != 1) return LookupPostUpperProofParentStateMixedFailureCode;
        return distinct[0] switch {
            UnboundMatchResult.Bound => LookupPostUpperProofParentBoundAllFailureCode,
            UnboundMatchResult.Retired => LookupPostUpperProofParentRetiredAllFailureCode,
            UnboundMatchResult.OtherState => LookupPostUpperProofParentOtherStateAllFailureCode,
            _ => StateChangedFailureCode,
        };
    }

    public static string ParentBoundActiveLeaseFailureCode(
        int candidateCount,
        string eventName,
        ulong eventFileObject,
        bool activeLeasePresent,
        bool activePhasePresent,
        bool activeSnapshotPresent,
        ulong activeLeaseFileObject,
        string? activeLeaseIdentity,
        string? activeLeasePath,
        bool activeVoicePhase,
        bool phaseInstanceMatches,
        bool sameParent,
        bool eventAfterActiveReservation,
        bool exactGenerationPresent,
        EventFileObjectMatchResult? eventFileObjectMatch = null,
        EventFileObjectBoundPathRelation? eventFileObjectBoundPathRelation = null,
        EventDirectoryBindingState? eventDirectoryBinding = null)
    {
        if (candidateCount is < 1 or > 128) return StateChangedFailureCode;
        if (eventName is not ("write" or "setinfo")) return StateChangedFailureCode;
        if (eventFileObject == 0) return StateChangedFailureCode;
        if (!activeLeasePresent || !activePhasePresent || !activeSnapshotPresent)
            return LookupPostUpperProofParentBoundContextMissingFailureCode;
        if (activeLeaseFileObject == 0 || string.IsNullOrEmpty(activeLeaseIdentity) ||
            string.IsNullOrEmpty(activeLeasePath))
            return LookupPostUpperProofParentBoundTupleInvalidFailureCode;
        if (!activeVoicePhase || !phaseInstanceMatches)
            return LookupPostUpperProofParentBoundPhaseMismatchFailureCode;
        if (!sameParent)
            return LookupPostUpperProofParentBoundParentMismatchFailureCode;
        if (!eventAfterActiveReservation)
            return LookupPostUpperProofParentBoundReservationOrderFailureCode;
        if (eventFileObject != activeLeaseFileObject)
        {
            if (eventFileObjectMatch is null ||
                !Enum.IsDefined(eventFileObjectMatch.Value))
                return StateChangedFailureCode;
            return eventFileObjectMatch.Value switch {
                EventFileObjectMatchResult.EntryMissingOrUnbound =>
                    LookupPostUpperProofParentBoundEventFileObjectEntryMissingOrUnboundFailureCode,
                EventFileObjectMatchResult.BoundSamePath =>
                    LookupPostUpperProofParentBoundEventFileObjectBoundSamePathFailureCode,
                EventFileObjectMatchResult.BoundOtherPath =>
                    ParentBoundEventFileObjectBoundOtherPathFailureCode(
                        eventFileObjectBoundPathRelation,
                        eventDirectoryBinding),
                EventFileObjectMatchResult.RetiredSamePath =>
                    LookupPostUpperProofParentBoundEventFileObjectRetiredSamePathFailureCode,
                EventFileObjectMatchResult.RetiredOtherPath =>
                    LookupPostUpperProofParentBoundEventFileObjectRetiredOtherPathFailureCode,
                EventFileObjectMatchResult.OtherState =>
                    LookupPostUpperProofParentBoundEventFileObjectOtherStateFailureCode,
                EventFileObjectMatchResult.Invalid =>
                    LookupPostUpperProofParentBoundEventFileObjectLookupInvalidFailureCode,
                _ => StateChangedFailureCode,
            };
        }
        if (!exactGenerationPresent)
            return LookupPostUpperProofParentBoundLedgerMissingFailureCode;
        return eventName == "write"
            ? LookupPostUpperProofParentBoundActiveLeaseWriteAllFailureCode
            : LookupPostUpperProofParentBoundActiveLeaseSetInfoAllFailureCode;
    }

    private static string ParentBoundEventDirectoryFailureCode(
        EventDirectoryBindingState? binding)
    {
        if (binding is null || !Enum.IsDefined(binding.Value))
            return StateChangedFailureCode;
        return binding.Value switch {
            EventDirectoryBindingState.Reused =>
                LookupPostUpperProofParentBoundEventDirectoryReusedFailureCode,
            EventDirectoryBindingState.DeleteSeen =>
                LookupPostUpperProofParentBoundEventDirectoryDeleteSeenFailureCode,
            EventDirectoryBindingState.CleanupSeen =>
                LookupPostUpperProofParentBoundEventDirectoryCleanupSeenFailureCode,
            EventDirectoryBindingState.Live =>
                LookupPostUpperProofParentBoundEventDirectoryLiveFailureCode,
            EventDirectoryBindingState.Invalid =>
                LookupPostUpperProofParentBoundEventDirectoryStateInvalidFailureCode,
            _ => StateChangedFailureCode,
        };
    }

    private static string ParentBoundEventFileObjectBoundOtherPathFailureCode(
        EventFileObjectBoundPathRelation? relation,
        EventDirectoryBindingState? directoryBinding)
    {
        if (relation is null || !Enum.IsDefined(relation.Value))
            return StateChangedFailureCode;
        return relation.Value switch {
            EventFileObjectBoundPathRelation.EventDirectory =>
                ParentBoundEventDirectoryFailureCode(directoryBinding),
            EventFileObjectBoundPathRelation.CandidateCurrentPath =>
                LookupPostUpperProofParentBoundEventFileObjectOtherCandidateCurrentFailureCode,
            EventFileObjectBoundPathRelation.CandidateParentPath =>
                LookupPostUpperProofParentBoundEventFileObjectOtherCandidateParentFailureCode,
            EventFileObjectBoundPathRelation.SameParentFile =>
                LookupPostUpperProofParentBoundEventFileObjectOtherSameParentFileFailureCode,
            EventFileObjectBoundPathRelation.DifferentParent =>
                LookupPostUpperProofParentBoundEventFileObjectOtherDifferentParentFailureCode,
            EventFileObjectBoundPathRelation.Invalid =>
                LookupPostUpperProofParentBoundEventFileObjectOtherRelationInvalidFailureCode,
            _ => StateChangedFailureCode,
        };
    }

    public static string CurrentBindingFailureCode(
        IReadOnlyCollection<GenerationMatchResult?>? results)
    {
        if (results is null || results.Count is < 1 or > 128 ||
            results.Any(result => result is null || !Enum.IsDefined(result.Value) ||
                result.Value is GenerationMatchResult.Invalid or
                    GenerationMatchResult.Success))
            return StateChangedFailureCode;
        var distinct = results.Select(result => result!.Value).Distinct().ToArray();
        if (distinct.Length != 1)
            return LookupPostUpperProofCurrentBindingMixedFailureCode;
        return distinct[0] switch {
            GenerationMatchResult.EntryMissing => LookupPostUpperProofCurrentBindingEntryMissingAllFailureCode,
            GenerationMatchResult.GenerationMismatch => LookupPostUpperProofCurrentBindingGenerationMismatchAllFailureCode,
            GenerationMatchResult.IdentityMismatch => LookupPostUpperProofCurrentBindingIdentityMismatchAllFailureCode,
            GenerationMatchResult.PathMismatch => LookupPostUpperProofCurrentBindingPathMismatchAllFailureCode,
            GenerationMatchResult.StateNotBoundOrRetired => LookupPostUpperProofCurrentBindingStateNotBoundOrRetiredAllFailureCode,
            _ => StateChangedFailureCode,
        };
    }

    // @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    public static bool PrepareTupleMatches(params bool[] predicates) =>
        predicates.Length > 0 && predicates.All(value => value);

    public static bool CanTransition(string from, string to) =>
        (from, to) is
            ("prepared", "completion-requested") or
            ("completion-requested", "completed-retained") or
            ("completed-retained", "released");

    public static bool IsWithinEpoch(long reservation, long completion, long eventQpc) =>
        reservation < eventQpc && eventQpc <= completion;

    public static bool IsWithinPostRequestEpoch(
        long completion, long deadline, long eventQpc) =>
        completion < eventQpc && eventQpc <= deadline;

    /// <summary>
    /// CompletionRequested中のexact current SetInfoだけをsealed replayへ接続する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static bool CanAuthorizePostRequestSystemSetInfo(
        int lateCandidateCount,
        string aggregateFailureCode,
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool voicePhase,
        bool sealPhaseMatches,
        bool currentPathMatches,
        bool exactGenerationMatches,
        bool completionRequested,
        bool completionQpcPresent,
        long completionQpc,
        bool drainDeadlinePresent,
        long drainDeadlineQpc,
        long eventQpc,
        bool completedRecordAbsent) =>
        lateCandidateCount == 1 &&
        aggregateFailureCode ==
            LateDiagnosticSetInfoSealNotCompletedRetainedFailureCode &&
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "setinfo" &&
        fileObject != 0 &&
        voicePhase &&
        sealPhaseMatches &&
        currentPathMatches &&
        exactGenerationMatches &&
        completionRequested &&
        completionQpcPresent &&
        drainDeadlinePresent &&
        IsWithinPostRequestEpoch(completionQpc, drainDeadlineQpc, eventQpc) &&
        completedRecordAbsent;

    public static bool PostRequestReplayFieldsMatch(
        WriteCompletionReplayKind replayKind,
        params bool[] predicates) =>
        replayKind == WriteCompletionReplayKind.PostRequestSystemSetInfo &&
        predicates.Length > 0 && predicates.All(value => value);

    /// <summary>
    /// sealed callback再検査をseal候補数、次にidentity非依存fieldsの順で固定分類する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string? RecheckSealedFailure(
        int matchingSealCount,
        params bool[] fields)
    {
        if (matchingSealCount == 0) return RecheckSealMissingFailureCode;
        if (matchingSealCount >= 2) return RecheckSealAmbiguousFailureCode;
        if (matchingSealCount != 1) return EventTupleMismatchFailureCode;
        return fields.Length > 0 && fields.All(value => value)
            ? null
            : RecheckFieldsFailureCode;
    }

    public static string? RecheckIdentityFailure(
        bool sealIdentityMatches,
        bool proofIdentityMatches) =>
        sealIdentityMatches && proofIdentityMatches
            ? null
            : $"{FailurePrefix}EVENT_IDENTITY_FAILED";

    /// <summary>
    /// exact reservation前writeをactive producerのimmutable birth境界で固定分類する。
    /// 認可・stateを変更せず、返却codeは呼出元の既存throw位置で停止する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string ActiveProducerBirthFailureCode(
        string aggregateFailureCode,
        bool recordPresent,
        bool pidMatches,
        bool startKeyMatches,
        bool processSequenceMatches,
        bool phaseInstanceMatches,
        long phaseStartedAtQpc,
        long producerStartedAtQpc,
        long activeReservationQpc,
        long eventQpc)
    {
        if (aggregateFailureCode !=
            LateDiagnosticWriteAtOrBeforeActiveReservationFailureCode)
            return aggregateFailureCode;
        if (!recordPresent)
            return LateDiagnosticWriteActiveProducerRecordMissingFailureCode;
        if (!pidMatches || !startKeyMatches || !processSequenceMatches ||
            !phaseInstanceMatches ||
            phaseStartedAtQpc >= producerStartedAtQpc ||
            producerStartedAtQpc > activeReservationQpc ||
            eventQpc > activeReservationQpc)
            return LateDiagnosticWriteActiveProducerTupleMismatchFailureCode;
        return eventQpc <= producerStartedAtQpc
            ? LateDiagnosticWriteAtOrBeforeActiveProducerBirthFailureCode
            : LateDiagnosticWriteAfterActiveProducerBirthFailureCode;
    }

    /// <summary>
    /// registered producer record欠落時だけ予約handler時のscalar snapshotで固定分類する。
    /// 認可・stateを変更せず、矛盾入力はSTATE_CHANGEDへ閉じる。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string ReservationProducerBirthFailureCode(
        string legacyFailureCode,
        bool registeredRecordAbsent,
        bool activeLeaseMatches,
        bool activePhaseMatches,
        bool eventAtOrBeforeCurrentReservation,
        bool snapshotPresent,
        bool recordObserved,
        bool producerPidMatches,
        bool producerStartKeyMatches,
        bool leaseSequenceMatches,
        bool recordSequenceMatches,
        bool phaseInstanceMatches,
        bool phaseStartMatches,
        bool reservationMatches,
        long phaseStartedAtQpc,
        long birthStartedAtQpc,
        long initialLeaseReservedAtQpc,
        long currentPathReservedAtQpc,
        long eventQpc)
    {
        if (legacyFailureCode !=
            LateDiagnosticWriteActiveProducerRecordMissingFailureCode)
            return legacyFailureCode;
        if (!registeredRecordAbsent || !activeLeaseMatches ||
            !eventAtOrBeforeCurrentReservation ||
            eventQpc > currentPathReservedAtQpc)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED";
        if (!activePhaseMatches)
            return LateDiagnosticWriteReservationStateActivePhaseChangedFailureCode;
        if (currentPathReservedAtQpc < initialLeaseReservedAtQpc)
            return LateDiagnosticWriteReservationStateCurrentBeforeInitialFailureCode;
        if (!snapshotPresent || !recordObserved)
            return LateDiagnosticWriteReservationBirthRecordMissingFailureCode;
        if (!producerPidMatches || !producerStartKeyMatches ||
            !leaseSequenceMatches || !recordSequenceMatches ||
            !phaseInstanceMatches || !phaseStartMatches ||
            !reservationMatches ||
            phaseStartedAtQpc >= birthStartedAtQpc ||
            birthStartedAtQpc > initialLeaseReservedAtQpc)
            return LateDiagnosticWriteReservationBirthTupleMismatchFailureCode;
        if (eventQpc <= birthStartedAtQpc)
            return LateDiagnosticWriteAtOrBeforeReservationBirthFailureCode;
        return eventQpc <= initialLeaseReservedAtQpc
            ? LateDiagnosticWriteAfterReservationBirthAtOrBeforeInitialFailureCode
            : LateDiagnosticWriteAfterReservationBirthAfterInitialToCurrentFailureCode;
    }

    /// <summary>
    /// productionの同一gate内で取得したlease/phase/recordから分類入力を導出する。
    /// bool化した防御入力をcall-siteへ重複させず、認可・stateは変更しない。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string ProductionReservationProducerBirthFailureCode(
        string legacyFailureCode,
        bool recordPresent,
        bool activeLeaseIsPendingWriteLease,
        string activeLeasePhaseInstanceId,
        string activePhaseInstanceId,
        bool snapshotPresent,
        bool recordObserved,
        bool producerPidMatches,
        bool producerStartKeyMatches,
        bool leaseSequenceMatches,
        bool recordSequenceMatches,
        bool snapshotPhaseInstanceMatches,
        bool phaseStartMatches,
        bool reservationMatches,
        long phaseStartedAtQpc,
        long birthStartedAtQpc,
        long initialLeaseReservedAtQpc,
        long currentPathReservedAtQpc,
        long eventQpc) =>
        ReservationProducerBirthFailureCode(
            legacyFailureCode,
            !recordPresent,
            activeLeaseIsPendingWriteLease,
            activeLeasePhaseInstanceId == activePhaseInstanceId,
            eventQpc <= currentPathReservedAtQpc,
            snapshotPresent,
            recordObserved,
            producerPidMatches,
            producerStartKeyMatches,
            leaseSequenceMatches,
            recordSequenceMatches,
            snapshotPhaseInstanceMatches,
            phaseStartMatches,
            reservationMatches,
            phaseStartedAtQpc,
            birthStartedAtQpc,
            initialLeaseReservedAtQpc,
            currentPathReservedAtQpc,
            eventQpc);

    /// <summary>
    /// 単一exact post-reservation parent writeだけをactive directory認可へ渡す。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static bool CanHandoffActiveDirectory(
        int lateCandidateCount,
        string aggregateFailureCode,
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool fileObjectUnbound,
        bool sealCompletedRetained,
        bool activeVoicePhase,
        bool sealPhaseMatches,
        bool sealParentPath,
        bool activeLeasePresent,
        bool otherActiveLease,
        bool phaseInstanceMatches,
        bool activeParentMatches,
        bool eventAfterActiveReservation) =>
        lateCandidateCount == 1 &&
        ActiveDirectoryHandoffCandidateMatches(
            aggregateFailureCode,
            authorizationFailure,
            systemPid,
            eventName,
            fileObject,
            fileObjectUnbound,
            sealCompletedRetained,
            activeVoicePhase,
            sealPhaseMatches,
            sealParentPath,
            activeLeasePresent,
            otherActiveLease,
            phaseInstanceMatches,
            activeParentMatches,
            eventAfterActiveReservation);

    /// <summary>
    /// active directory handoffの既存predicateを候補単位で評価する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static bool ActiveDirectoryHandoffCandidateMatches(
        string aggregateFailureCode,
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool fileObjectUnbound,
        bool sealCompletedRetained,
        bool activeVoicePhase,
        bool sealPhaseMatches,
        bool sealParentPath,
        bool activeLeasePresent,
        bool otherActiveLease,
        bool phaseInstanceMatches,
        bool activeParentMatches,
        bool eventAfterActiveReservation) =>
        aggregateFailureCode == LateRetainedParentWriteFailureCode &&
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "write" &&
        fileObject != 0 &&
        fileObjectUnbound &&
        sealCompletedRetained &&
        activeVoicePhase &&
        sealPhaseMatches &&
        sealParentPath &&
        activeLeasePresent &&
        otherActiveLease &&
        phaseInstanceMatches &&
        activeParentMatches &&
        eventAfterActiveReservation;

    /// <summary>
    /// 全候補が既存active directory predicate適格な複数集合だけを、
    /// 候補非選択で現在active leaseの既存認可へ接続する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static bool CanHandoffActiveDirectoryCandidateSet(
        int totalCandidateCount,
        int eligibleCandidateCount,
        string aggregateFailureCode) =>
        totalCandidateCount >= 2 &&
        eligibleCandidateCount == totalCandidateCount &&
        aggregateFailureCode == LateRetainedParentWriteFailureCode;

    /// <summary>
    /// active directory多重候補を既存predicate適格1件/複数へ固定分類する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string? ActiveDirectoryHandoffEligibilityFailureCode(
        int totalCandidateCount,
        int eligibleCandidateCount,
        string aggregateFailureCode)
    {
        if (totalCandidateCount < 0 || eligibleCandidateCount < 0 ||
            eligibleCandidateCount > totalCandidateCount)
            return StateChangedFailureCode;
        if (totalCandidateCount < 2 ||
            aggregateFailureCode != LateRetainedParentWriteFailureCode)
            return null;
        if (eligibleCandidateCount == 0) return StateChangedFailureCode;
        if (eligibleCandidateCount == 1)
            return ActiveDirectoryHandoffEligibleExactOneFailureCode;
        return ActiveDirectoryHandoffEligibleMultiplicityFailureCode(
            totalCandidateCount,
            eligibleCandidateCount,
            aggregateFailureCode);
    }

    /// <summary>
    /// active directoryの複数適格候補を全件適格/混在へ固定分類する。
    /// 候補を選択・認可せず、count以外の値を受け取らない。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string? ActiveDirectoryHandoffEligibleMultiplicityFailureCode(
        int totalCandidateCount,
        int eligibleCandidateCount,
        string aggregateFailureCode)
    {
        if (totalCandidateCount < 0 || eligibleCandidateCount < 0 ||
            eligibleCandidateCount > totalCandidateCount)
            return StateChangedFailureCode;
        if (aggregateFailureCode != LateRetainedParentWriteFailureCode ||
            totalCandidateCount < 2 || eligibleCandidateCount < 2)
            return null;
        return eligibleCandidateCount == totalCandidateCount
            ? ActiveDirectoryHandoffEligibleAllFailureCode
            : ActiveDirectoryHandoffEligibleMixedFailureCode;
    }

    /// <summary>
    /// active directory handoff候補が複数なら、候補の内容を漏らさず固定分類する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string? ActiveDirectoryHandoffCardinalityFailureCode(
        int lateCandidateCount,
        string aggregateFailureCode) =>
        lateCandidateCount >= 2 &&
        aggregateFailureCode == LateRetainedParentWriteFailureCode
            ? ActiveDirectoryHandoffCandidateAmbiguousFailureCode
            : null;

    /// <summary>
    /// completed no-lease directory handoff候補が複数なら、候補の内容を漏らさず固定分類する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string? CompletedNoLeaseDirectoryHandoffCardinalityFailureCode(
        int lateCandidateCount,
        string aggregateFailureCode) =>
        lateCandidateCount >= 2 &&
        aggregateFailureCode == LateDiagnosticWriteActiveLeaseMissingFailureCode
            ? CompletedNoLeaseDirectoryHandoffCandidateAmbiguousFailureCode
            : null;

    public static string? CompletedNoLeaseDirectoryHandoffIdentityFailureCode(
        int identityMatchCount) => identityMatchCount switch {
            < 0 => StateChangedFailureCode,
            0 => CompletedNoLeaseDirectoryHandoffIdentityMatchNoneFailureCode,
            1 => null,
            _ => CompletedNoLeaseDirectoryHandoffIdentityMatchAmbiguousFailureCode,
        };

    public static CompletedNoLeaseIdentitySelection<T>
        SelectCompletedNoLeaseDirectoryHandoffIdentity<T>(
            IReadOnlyList<T> candidates,
            string? currentIdentity,
            Func<T, string> identitySelector,
            Func<T, long> sequenceSelector) where T : class
    {
        if (candidates.Count > 128 ||
            candidates.Distinct(ReferenceEqualityComparer.Instance).Count() !=
                candidates.Count ||
            candidates.Select(sequenceSelector).Distinct().Count() !=
                candidates.Count)
            return new CompletedNoLeaseIdentitySelection<T>(
                null, StateChangedFailureCode, []);
        T? selected = null;
        var matchCount = 0;
        var matches = ImmutableArray.CreateBuilder<T>();
        if (currentIdentity is not null)
        {
            foreach (var candidate in candidates)
            {
                if (identitySelector(candidate) != currentIdentity) continue;
                matchCount = checked(matchCount + 1);
                matches.Add(candidate);
                if (matchCount == 1) selected = candidate;
            }
        }
        var failure = matchCount == 0
            ? CompletedNoLeaseDirectoryHandoffIdentityMatchNoneFailureCode
            : null;
        return new CompletedNoLeaseIdentitySelection<T>(
            failure is null && matchCount == 1 ? selected : null,
            failure,
            matches.ToImmutable());
    }

    public static bool CompletedNoLeaseAuthorizedIdentityMatches(
        string expectedIdentity,
        string selectedSealDirectoryIdentity) =>
        expectedIdentity == selectedSealDirectoryIdentity;

    public static bool ValidateCompletedNoLeaseMemberSet<T>(
        IReadOnlyCollection<T> members,
        Func<T, bool> memberMatches,
        Action<T> reinspect)
    {
        if (members.Count is < 1 or > 128) return false;
        foreach (var member in members)
            if (!memberMatches(member)) return false;
        try
        {
            foreach (var member in members) reinspect(member);
        }
        catch (Exception)
        {
            return false;
        }
        return true;
    }

    /// <summary>
    /// CompletedRetained parentの単一exact no-lease writeだけを既存root directory認可へ渡す。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static bool CanHandoffCompletedNoLeaseDirectory(
        int lateCandidateCount,
        string aggregateFailureCode,
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool fileObjectUnbound,
        bool sealCompletedRetained,
        bool activeVoicePhase,
        bool sealPhaseMatches,
        bool sealParentPath,
        bool noActiveLease,
        bool completionUpperPresent,
        bool eventAfterCompletionUpper) =>
        lateCandidateCount == 1 &&
        aggregateFailureCode == LateDiagnosticWriteActiveLeaseMissingFailureCode &&
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "write" &&
        fileObject != 0 &&
        fileObjectUnbound &&
        sealCompletedRetained &&
        activeVoicePhase &&
        sealPhaseMatches &&
        sealParentPath &&
        noActiveLease &&
        completionUpperPresent &&
        eventAfterCompletionUpper;

    public static CompletedNoLeaseKnownAuthorizationDecision
        InvokeCompletedNoLeaseKnownAuthorization(
            Func<bool> authorizeKnownDirectory,
            Func<bool> isPoisoned)
    {
        var authorized = authorizeKnownDirectory();
        if (authorized)
            return CompletedNoLeaseKnownAuthorizationDecision.Pass;
        return isPoisoned()
            ? CompletedNoLeaseKnownAuthorizationDecision.Poisoned
            : CompletedNoLeaseKnownAuthorizationDecision.StateChanged;
    }

    public static bool HasAtMostOneImmutableRejoinContext(
        bool afterLease,
        bool boundLease,
        bool completedNoLease) =>
        (afterLease ? 1 : 0) +
        (boundLease ? 1 : 0) +
        (completedNoLease ? 1 : 0) <= 1;

    public static bool CompletedNoLeaseContextStateMatches(
        params bool[] predicates) =>
        predicates.Length > 0 && predicates.All(value => value);

    public static bool CompletedNoLeaseRootProcessMatches(
        bool pidMatches,
        bool startKeyMatches,
        bool sequenceMatches,
        bool nonSignaled,
        bool jobMember) =>
        pidMatches && startKeyMatches && sequenceMatches &&
        nonSignaled && jobMember;

    public static bool CompletedNoLeaseSnapshotMatches(
        params bool[] predicates) =>
        predicates.Length > 0 && predicates.All(value => value);

    public static bool CompletedNoLeaseProofMatches(
        bool otherBound,
        bool writeEvent,
        bool fileObjectMatches,
        bool pathMatches,
        bool identityMatches,
        bool boundAfter) =>
        otherBound && writeEvent && fileObjectMatches && pathMatches &&
        identityMatches && boundAfter;

    public static bool IsDeadlineValid(long now, long deadline) => now <= deadline;

    public static bool IsBufferWithinLimit(
        int sealCount, int sealEventCount, int phaseEventCount) =>
        sealCount <= 128 && sealEventCount <= 64 && phaseEventCount <= 8_192;

    public static bool FileObjectCompatible(
        bool parentPath,
        ulong eventFileObject,
        ulong leaseFileObject,
        bool eventFileObjectBound) =>
        eventFileObject == leaseFileObject ||
        parentPath && eventFileObject != 0 && !eventFileObjectBound;

    public static bool CountersStable(
        long expectedRelevant,
        long expectedAccounted,
        long currentRelevant,
        long currentAccounted) =>
        expectedRelevant == expectedAccounted &&
        currentRelevant == expectedRelevant &&
        currentAccounted == expectedAccounted;

    public static bool CanMutateFinalState(
        bool exclusiveAdmissionHeld,
        int activeCallbackReaders,
        bool queueEmpty,
        bool countersStable) =>
        exclusiveAdmissionHeld &&
        activeCallbackReaders == 0 &&
        queueEmpty &&
        countersStable;

    public static string QueueDecision(
        bool reorderActive,
        bool sealedCandidate,
        int queuedCount,
        int maximumQueued)
    {
        if (!reorderActive && !sealedCandidate) return "APPLY";
        return queuedCount < maximumQueued ? "QUEUE" : "BUFFER_LIMIT";
    }

    public static int AccountedDelta(string terminal) => terminal switch {
        "NORMAL" or
        "DEFER_OR_REORDER" or
        "FIXED_REFUSAL" or
        "PROCESS_IDENTITY_PROBE" or
        "CLOSED_OR_POISONED" => 1,
        _ => 0,
    };

    public static long CheckedCounterAdd(long current, long delta)
    {
        try { return checked(current + delta); }
        catch (OverflowException) { throw new WriteCompletionBufferLimitException(); }
    }

    public static long InterlockedAddChecked(ref long location, long delta)
    {
        while (true)
        {
            var current = Volatile.Read(ref location);
            var next = CheckedCounterAdd(current, delta);
            if (Interlocked.CompareExchange(ref location, next, current) == current)
                return next;
        }
    }

    public static string? ApplicationFailure(
        bool identityRecheckSucceeded,
        bool capacityApplySucceeded,
        bool retainedHandleAvailable)
    {
        if (!identityRecheckSucceeded)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_EVENT_IDENTITY_FAILED";
        if (!capacityApplySucceeded)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_FAILED";
        if (!retainedHandleAvailable)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_IDENTITY_FAILED";
        return null;
    }

    public static DrainReplayFixtureResult ReplayFixture(
        IEnumerable<(long Sequence, long AllocatedBytes)> snapshots)
    {
        long allocated = 0;
        long peak = 0;
        var order = new List<long>();
        foreach (var snapshot in snapshots.OrderBy(item => item.Sequence))
        {
            allocated = snapshot.AllocatedBytes;
            peak = Math.Max(peak, allocated);
            order.Add(snapshot.Sequence);
        }
        return new DrainReplayFixtureResult(order.ToArray(), allocated, peak);
    }

    public static string? LookupFailure(
        int broadCandidates,
        int epochCandidates,
        int exactCandidates,
        int lateCandidates)
    {
        if (broadCandidates < 0 || epochCandidates < 0 ||
            exactCandidates < 0 || lateCandidates < 0 ||
            epochCandidates > broadCandidates ||
            exactCandidates > epochCandidates ||
            lateCandidates > broadCandidates ||
            epochCandidates > 0 && lateCandidates > 0 ||
            broadCandidates == 0 &&
                (epochCandidates != 0 || exactCandidates != 0 ||
                    lateCandidates != 0))
            return EventTupleMismatchFailureCode;
        if (broadCandidates == 0) return null;
        if (epochCandidates == 0)
            return lateCandidates > 0
                ? GenericLateEventFailureCode
                : LookupEpochEmptyNoLateProofFailureCode;
        return exactCandidates switch
        {
            0 => LookupExactMissingFailureCode,
            1 => null,
            _ => LookupExactAmbiguousFailureCode,
        };
    }

    /// <summary>
    /// exact late current SetInfoを既存completed-write認可へ渡す候補を一意化する。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static bool IsCompletedWriteHandoffCandidate(
        int lateCandidateCount,
        string aggregateFailureCode) =>
        lateCandidateCount == 1 &&
        aggregateFailureCode == LateDiagnosticSetInfoCurrentPathFailureCode;

    /// <summary>
    /// handoff候補とcompleted record/sealの不変tupleを純粋判定する。
    /// </summary>
    public static bool CanHandoffCompletedWrite(
        int lateCandidateCount,
        string aggregateFailureCode,
        bool completedRecordPresent,
        bool workerPidMatches,
        bool processSequenceMatches,
        bool phaseInstanceMatches,
        bool reservedQpcMatches,
        bool identityMatches) =>
        IsCompletedWriteHandoffCandidate(
            lateCandidateCount,
            aggregateFailureCode) &&
        completedRecordPresent &&
        workerPidMatches &&
        processSequenceMatches &&
        phaseInstanceMatches &&
        reservedQpcMatches &&
        identityMatches;

    /// <summary>
    /// exact late拒否位置の不変tupleだけから外部診断を選ぶ。候補・認可・stateは変更しない。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-017 FUN-F005-047
    /// </summary>
    public static string LateEventFailureCode(
        string eventName,
        bool completedRetained,
        bool parentPath,
        bool activeLeasePresent,
        bool otherActiveLease,
        bool sameParent,
        bool postReservation)
    {
        var eventKind = eventName switch {
            "write" => "WRITE",
            "setinfo" => "SETINFO",
            _ => null,
        };
        if (eventKind is null) return GenericLateEventFailureCode;
        if (!completedRetained)
            return $"{LateDiagnosticPrefix}{eventKind}_SEAL_NOT_COMPLETED_RETAINED";
        if (!parentPath)
            return $"{LateDiagnosticPrefix}{eventKind}_CURRENT_PATH";
        if (!activeLeasePresent)
            return eventName == "write"
                ? LateDiagnosticWriteActiveLeaseMissingFailureCode
                : $"{LateDiagnosticPrefix}{eventKind}_ACTIVE_LEASE_MISSING";
        // CompletedRetained遷移はactive leaseをnull化し、次予約はnew objectを作る。
        // 先行3軸成立後のsame lease入力はproduction不変条件違反として閉じる。
        if (!otherActiveLease) return GenericLateEventFailureCode;
        if (!sameParent)
            return $"{LateDiagnosticPrefix}{eventKind}_ACTIVE_PARENT_MISMATCH";
        if (!postReservation)
            return $"{LateDiagnosticPrefix}{eventKind}_AT_OR_BEFORE_ACTIVE_RESERVATION";
        return eventName == "write"
            ? LateRetainedParentWriteFailureCode
            : LateRetainedParentSetInfoFailureCode;
    }

    /// <summary>
    /// exact late候補を完全一致優先、generic混在fail-close、distinct原因で決定的集約する。
    /// </summary>
    public static string AggregateLateEventFailureCode(
        string eventName,
        IEnumerable<LateEventDiagnosticCandidate> candidates)
    {
        var classified = candidates.Select(candidate => LateEventFailureCode(
            eventName,
            candidate.CompletedRetained,
            candidate.ParentPath,
            candidate.ActiveLeasePresent,
            candidate.OtherActiveLease,
            candidate.SameParent,
            candidate.PostReservation)).ToArray();
        var exactCode = eventName switch {
            "write" => LateRetainedParentWriteFailureCode,
            "setinfo" => LateRetainedParentSetInfoFailureCode,
            _ => GenericLateEventFailureCode,
        };
        if (exactCode != GenericLateEventFailureCode &&
            classified.Contains(exactCode, StringComparer.Ordinal))
            return exactCode;
        if (classified.Length == 0 || classified.Contains(
                GenericLateEventFailureCode, StringComparer.Ordinal))
            return GenericLateEventFailureCode;
        var distinct = classified.Distinct(StringComparer.Ordinal).ToArray();
        if (distinct.Length == 1) return distinct[0];
        return eventName switch {
            "write" => LateDiagnosticWriteMixedCausesFailureCode,
            "setinfo" => LateDiagnosticSetInfoMixedCausesFailureCode,
            _ => GenericLateEventFailureCode,
        };
    }

    /// <summary>
    /// write completion drainのnative replyを固定35 codeへ閉じる。
    /// @des DES-F005-006 DES-F005-012 @fun FUN-F005-047
    /// </summary>
    public static string NormalizeExternalFailureCode(string code) =>
        code.StartsWith(FailurePrefix, StringComparison.Ordinal) &&
        (code.Length > 127 || !externalFailureCodeSet.Contains(code))
            ? $"{FailurePrefix}FAILED"
            : code;

    public static string ProcessFailureCode(string code, bool recheck) =>
        (code, recheck) switch {
            ("PROCESS_WAIT_FAILED", false) =>
                "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_WAIT_FAILED",
            ("JOB_QUERY_FAILED", false) =>
                "F005_ETW_WRITE_COMPLETION_DRAIN_JOB_QUERY_FAILED",
            (_, false) =>
                "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_IDENTITY_FAILED",
            ("PROCESS_WAIT_FAILED", true) =>
                "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_WAIT_FAILED",
            (_, true) =>
                "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_IDENTITY_FAILED",
        };

    public static string? ProcessRejection(
        bool tupleMatches, bool signaled, bool jobMember, bool recheck)
    {
        if (!tupleMatches)
            return recheck
                ? "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH"
                : "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_TUPLE_MISMATCH";
        if (recheck && !signaled)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED";
        if (!recheck && signaled)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_SIGNALED";
        if (!recheck && !jobMember)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_PROCESS_OUTSIDE_JOB";
        return null;
    }

    public static string? RecheckFailure(
        bool stateMatches,
        bool directoryMatches,
        bool currentMatches,
        bool bindingMatches,
        bool processIdentityAvailable,
        bool processWaitAvailable,
        bool processTupleMatches,
        bool processSignaled)
    {
        if (!stateMatches) return "F005_ETW_WRITE_COMPLETION_DRAIN_STATE_CHANGED";
        if (!directoryMatches)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_DIRECTORY_IDENTITY_MISMATCH";
        if (!currentMatches)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_CURRENT_IDENTITY_MISMATCH";
        if (!bindingMatches)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_BINDING_MISMATCH";
        if (!processIdentityAvailable)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_IDENTITY_FAILED";
        if (!processWaitAvailable)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_WAIT_FAILED";
        if (!processTupleMatches)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_TUPLE_MISMATCH";
        if (!processSignaled)
            return "F005_ETW_WRITE_COMPLETION_DRAIN_RECHECK_PROCESS_NOT_SIGNALED";
        return null;
    }
}

public sealed record CompletedNoLeaseIdentitySelection<T>(
    T? Selected,
    string? FailureCode,
    ImmutableArray<T> Matches) where T : class;

public sealed record EpochCandidateClassification<T>(
    ImmutableArray<T> Epoch,
    ImmutableArray<T> Late,
    int AtOrBeforeReservationCount,
    int PostUpperProofMissingCount,
    int TemporalInvalidCount,
    int ProofInvalidCount,
    ImmutableArray<LateProofResult> ProofResults,
    ImmutableArray<GenerationMatchResult?> GenerationMatchResults,
    ImmutableArray<UnboundMatchResult?> UnboundMatchResults);

public sealed record LateProofEvaluation(
    LateProofResult Outer,
    GenerationMatchResult? GenerationMatch,
    UnboundMatchResult? UnboundMatch = null);

public enum UnboundMatchResult
{
    Invalid,
    Bound,
    Retired,
    OtherState,
    Success,
}

public enum EventFileObjectMatchResult
{
    Invalid,
    EntryMissingOrUnbound,
    BoundSamePath,
    BoundOtherPath,
    RetiredSamePath,
    RetiredOtherPath,
    OtherState,
}

public enum EventFileObjectBoundPathRelation
{
    Invalid,
    EventDirectory,
    CandidateCurrentPath,
    CandidateParentPath,
    SameParentFile,
    DifferentParent,
}

public enum EventDirectoryBindingState
{
    Invalid,
    Reused,
    DeleteSeen,
    CleanupSeen,
    Live,
}

public enum GenerationMatchResult
{
    Invalid,
    EntryMissing,
    GenerationMismatch,
    IdentityMismatch,
    PathMismatch,
    StateNotBoundOrRetired,
    Success,
}

public enum LateProofResult
{
    Invalid,
    LedgerUnavailable,
    CurrentFileObjectMismatch,
    CurrentBindingMismatch,
    ParentNotUnbound,
    Success,
}

public sealed record DrainReplayFixtureResult(
    IReadOnlyList<long> ObservationOrder,
    long FinalAllocatedBytes,
    long PeakAllocatedBytes);

public static class SystemDirectoryWriteRejoinDiagnosticRules
{
    public static string Classify(
        bool hasSnapshot,
        bool currentExists,
        bool identityMatches,
        bool ownerMatches,
        bool rootActive)
    {
        if (!hasSnapshot) return "SNAPSHOT_MISSING";
        if (!currentExists) return "CURRENT_MISSING";
        if (!identityMatches) return "IDENTITY_MISMATCH";
        if (!ownerMatches) return "OWNER_MISSING";
        if (!rootActive) return "ROOT_INACTIVE";
        return "CANDIDATE";
    }
}

public static class SystemDirectoryWriteRejoinAuthorizationRules
{
    public static bool CanAuthorize(
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool voicePhase,
        bool eventAfterPhaseStart,
        bool fileObjectUnbound,
        bool noActiveLease,
        bool exactBucket,
        bool candidateStage,
        bool rootPidAvailable,
        bool rootSequenceAvailable) =>
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "write" &&
        fileObject != 0 &&
        voicePhase &&
        eventAfterPhaseStart &&
        fileObjectUnbound &&
        noActiveLease &&
        exactBucket &&
        candidateStage &&
        rootPidAvailable &&
        rootSequenceAvailable;
}

public readonly record struct BoundLeaseInitialInspection(
    bool DirectoryCurrentExists,
    bool DirectoryIdentityMatches,
    bool LeaseCurrentExists,
    bool LeaseCurrentIdentityMatches);

public static class SystemDirectoryBoundLeaseRejoinAuthorizationRules
{
    // @des DES-F005-006 @fun FUN-F005-047 bound lease directoryの完全tupleだけを遅延評価で限定認可する。
    public static bool IsQpcOrderValid(
        long phaseStartedAtQpc,
        long leaseReservedAtQpc,
        long eventQpc) =>
        phaseStartedAtQpc < leaseReservedAtQpc &&
        leaseReservedAtQpc < eventQpc;

    public static bool EvaluateCheapPredicates(
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
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "write" &&
        fileObject != 0 &&
        fileObjectUnbound &&
        voicePhase &&
        leasePhaseMatches &&
        IsQpcOrderValid(phaseStartedAtQpc, leaseReservedAtQpc, eventQpc) &&
        exactCandidate() &&
        pendingRenamePathNull() &&
        renameReservationNull();

    public static bool InitialTupleMatches(
        bool directorySnapshotAvailable,
        bool directoryCurrentExists,
        bool directoryIdentityMatches,
        bool leaseParentMatches,
        bool leaseOpen,
        bool leaseSnapshotAvailable,
        bool leaseFileObjectAvailable,
        bool leaseCurrentExists,
        bool leaseCurrentIdentityMatches,
        bool leaseBindingAvailable,
        bool leaseBindingPathMatches,
        bool leaseBindingIdentityMatches) =>
        directorySnapshotAvailable &&
        directoryCurrentExists &&
        directoryIdentityMatches &&
        leaseParentMatches &&
        leaseOpen &&
        leaseSnapshotAvailable &&
        leaseFileObjectAvailable &&
        leaseCurrentExists &&
        leaseCurrentIdentityMatches &&
        leaseBindingAvailable &&
        leaseBindingPathMatches &&
        leaseBindingIdentityMatches;

    // @des DES-F005-006 @fun FUN-F005-047 production callbackとtarget試験で
    // 初回identity検査の回数・順序・固定失敗codeを共有する。
    public static bool EvaluateInitialTupleInspection(
        Func<BoundLeaseInitialInspection> inspect,
        bool directorySnapshotAvailable,
        bool leaseParentMatches,
        bool leaseOpen,
        bool leaseSnapshotAvailable,
        bool leaseFileObjectAvailable,
        bool leaseBindingAvailable,
        bool leaseBindingPathMatches,
        bool leaseBindingIdentityMatches)
    {
        BoundLeaseInitialInspection inspection;
        try
        {
            inspection = inspect();
        }
        catch (GuardException)
        {
            throw new GuardException(
                "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_INITIAL_TUPLE_INSPECTION_FAILED");
        }
        return InitialTupleMatches(
            directorySnapshotAvailable,
            inspection.DirectoryCurrentExists,
            inspection.DirectoryIdentityMatches,
            leaseParentMatches,
            leaseOpen,
            leaseSnapshotAvailable,
            leaseFileObjectAvailable,
            inspection.LeaseCurrentExists,
            inspection.LeaseCurrentIdentityMatches,
            leaseBindingAvailable,
            leaseBindingPathMatches,
            leaseBindingIdentityMatches);
    }

    public static string? TupleRecheckFailure(
        bool activeLeaseMatches,
        bool eventFileObjectUnbound,
        bool renameStateUnchanged,
        bool directoryIdentityMatches,
        bool leaseCurrentIdentityMatches,
        bool bindingMatches)
    {
        if (!activeLeaseMatches)
            return "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_ACTIVE_LEASE_CHANGED";
        if (!eventFileObjectUnbound)
            return "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_EVENT_FILE_OBJECT_BOUND";
        if (!renameStateUnchanged)
            return "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_RENAME_STATE_CHANGED";
        if (!directoryIdentityMatches)
            return "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_DIRECTORY_IDENTITY_MISMATCH";
        if (!leaseCurrentIdentityMatches)
            return "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_LEASE_CURRENT_IDENTITY_MISMATCH";
        if (!bindingMatches)
            return "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_BINDING_MISMATCH";
        return null;
    }

    public static string InitialProcessFailureCode(string code) => code switch {
        "PROCESS_WAIT_FAILED" =>
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_WAIT_FAILED",
        "JOB_QUERY_FAILED" =>
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_JOB_QUERY_FAILED",
        _ => "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_IDENTITY_FAILED",
    };

    public static string RecheckProcessFailureCode(string code) => code switch {
        "PROCESS_WAIT_FAILED" =>
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_WAIT_FAILED",
        "JOB_QUERY_FAILED" =>
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_JOB_QUERY_FAILED",
        _ =>
            "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_IDENTITY_FAILED",
    };

    public static string? ProcessRejection(
        bool processTupleMatches,
        bool processSignaled,
        bool processJobMember,
        bool recheck)
    {
        if (!processTupleMatches)
            return recheck
                ? "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_TUPLE_MISMATCH"
                : "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_TUPLE_MISMATCH";
        if (processSignaled)
            return recheck
                ? "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_SIGNALED"
                : "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_SIGNALED";
        if (!processJobMember)
            return recheck
                ? "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_RECHECK_OUTSIDE_JOB"
                : "ETW_SYSTEM_DIRECTORY_BOUND_LEASE_REJOIN_PROCESS_OUTSIDE_JOB";
        return null;
    }
}

public static class AfterLeaseReservationDirectoryWriteRejoinAuthorizationRules
{
    // @des DES-F005-006 @fun FUN-F005-047 AFTER完全tupleと保持handle同一世代だけを限定認可する。
    public static bool IsCandidateTimestamp(
        long eventQpc,
        long leaseReservationQpc,
        long renameReservationQpc) =>
        renameReservationQpc > leaseReservationQpc &&
        eventQpc > leaseReservationQpc &&
        eventQpc <= renameReservationQpc;

    public static bool CanAuthorize(
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool fileObjectUnbound,
        bool voicePhase,
        bool leasePhaseMatches,
        bool afterLeaseReservationStage,
        bool candidateTimestamp,
        bool targetTupleMatches,
        bool processTupleMatches,
        bool processSignaled,
        bool processJobMember,
        bool delayedEventTupleMatches) =>
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "write" &&
        fileObject != 0 &&
        fileObjectUnbound &&
        voicePhase &&
        leasePhaseMatches &&
        afterLeaseReservationStage &&
        candidateTimestamp &&
        targetTupleMatches &&
        processTupleMatches &&
        (processSignaled
            ? delayedEventTupleMatches
            : processJobMember);
}

public static class SystemDirectoryActiveLeaseWriteRejoinDiagnosticRules
{
    public static string Classify(
        string directoryStage,
        bool hasLease,
        bool leasePhaseMatches,
        bool leaseParentMatches,
        bool leaseBound,
        bool leaseClosed,
        bool leaseOutsideJob)
    {
        if (directoryStage != "CANDIDATE")
            return directoryStage switch {
                "SNAPSHOT_MISSING" => "DIRECTORY_SNAPSHOT_MISSING",
                "CURRENT_MISSING" => "DIRECTORY_CURRENT_MISSING",
                "IDENTITY_MISMATCH" => "DIRECTORY_IDENTITY_MISMATCH",
                "OWNER_MISSING" => "DIRECTORY_OWNER_MISSING",
                "ROOT_INACTIVE" => "DIRECTORY_ROOT_INACTIVE",
                _ => "DIRECTORY_UNKNOWN",
            };
        if (!hasLease) return "LEASE_MISSING";
        if (!leasePhaseMatches) return "LEASE_PHASE";
        if (!leaseParentMatches) return "LEASE_PARENT";
        if (leaseBound) return "LEASE_BOUND";
        if (leaseClosed) return "LEASE_CLOSED";
        if (leaseOutsideJob) return "LEASE_ESCAPE";
        return "CANDIDATE";
    }
}

public static class SystemBoundFileObjectRejoinDiagnosticRules
{
    public static string Classify(
        bool hasSnapshot,
        bool pathMatches,
        bool currentExists,
        bool identityMatches,
        bool hasLease,
        bool leasePhaseMatches,
        bool leaseBindingMatches,
        bool leaseClosed,
        bool leaseOutsideJob)
    {
        if (!hasSnapshot) return "SNAPSHOT_MISSING";
        if (!pathMatches) return "PATH_MISMATCH";
        if (!currentExists) return "CURRENT_MISSING";
        if (!identityMatches) return "IDENTITY_MISMATCH";
        if (!hasLease) return "LEASE_MISSING";
        if (!leasePhaseMatches) return "LEASE_PHASE";
        if (!leaseBindingMatches) return "LEASE_BINDING";
        if (leaseClosed) return "LEASE_CLOSED";
        if (leaseOutsideJob) return "LEASE_ESCAPE";
        return "CANDIDATE";
    }
}

public static class SystemBoundFileObjectNoPendingRenameLeasePathDiagnosticRules
{
    // @des DES-F005-006 @fun FUN-F005-047 pending targetなしのpath種別とdirectory/lease状態を固定分類する。
    public static string Classify(
        bool pathIsFile,
        bool pathIsDirectory,
        string directoryStage,
        bool leaseStateStable,
        bool leaseParentMatches,
        bool leaseClosed,
        bool leaseBound,
        bool leaseSnapshotAvailable,
        bool leaseBindingAvailable,
        bool leaseBindingMatches,
        bool leaseCurrentExists,
        bool leaseIdentityMatches,
        bool leaseOutsideJob)
    {
        if (pathIsFile) return "NO_PENDING_FILE";
        if (!pathIsDirectory) return "NO_PENDING_OTHER";
        if (directoryStage != "CANDIDATE")
            return directoryStage switch {
                "SNAPSHOT_MISSING" => "NO_PENDING_DIR_SNAPSHOT_MISSING",
                "CURRENT_MISSING" => "NO_PENDING_DIR_CURRENT_MISSING",
                "IDENTITY_MISMATCH" => "NO_PENDING_DIR_ID_MISMATCH",
                "OWNER_MISSING" => "NO_PENDING_DIR_OWNER_MISSING",
                "ROOT_INACTIVE" => "NO_PENDING_DIR_ROOT_INACTIVE",
                _ => "NO_PENDING_DIR_UNKNOWN",
            };
        if (!leaseStateStable) return "NO_PENDING_STATE_DRIFT";
        if (!leaseParentMatches) return "NO_PENDING_LEASE_PARENT";
        if (leaseClosed) return "NO_PENDING_LEASE_CLOSED";
        if (!leaseBound) return "NO_PENDING_LEASE_UNBOUND";
        if (!leaseSnapshotAvailable) return "NO_PENDING_LEASE_SNAPSHOT_MISSING";
        if (!leaseBindingAvailable) return "NO_PENDING_LEASE_BINDING_MISSING";
        if (!leaseBindingMatches) return "NO_PENDING_LEASE_BINDING_MISMATCH";
        if (!leaseCurrentExists) return "NO_PENDING_LEASE_CURRENT_MISSING";
        if (!leaseIdentityMatches) return "NO_PENDING_LEASE_ID_MISMATCH";
        if (leaseOutsideJob) return "NO_PENDING_LEASE_ESCAPE";
        return "NO_PENDING_CANDIDATE";
    }
}

internal readonly record struct SystemBoundFileObjectNoPendingUnboundLeaseState(
    string RelativePath,
    bool SnapshotPresent,
    int WorkerPid,
    ulong ProcessStartKey,
    ulong ProcessSequenceNumber,
    string PhaseInstanceId,
    long CurrentPathReservedAtQpc);

internal readonly record struct SystemBoundFileObjectNoPendingUnboundLeasePhase(
    string Phase,
    string? WorkId,
    string PhaseInstanceId);

internal readonly record struct SystemBoundFileObjectNoPendingUnboundLeaseDeferred(
    int WorkerPid,
    ulong ProducerSequenceNumber,
    string Phase,
    string? WorkId,
    string PhaseInstanceId,
    string RelativePath,
    string SnapshotRelativePath,
    string SnapshotIdentity,
    ulong FileObject,
    bool FileObjectUnbound,
    long TimestampQpc);

internal readonly record struct SystemBoundFileObjectNoPendingUnboundLeaseCurrent(
    string Identity);

internal readonly record struct SystemBoundFileObjectNoPendingUnboundLeaseProcess(
    int ProcessId,
    ulong ProcessStartKey,
    ulong ProcessSequenceNumber,
    bool Signaled,
    bool JobMember);

/// <summary>
/// T-109診断が使うcurrent/process検査をproduction実装へ固定する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-047
/// </summary>
internal sealed class SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
{
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint ShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private readonly Func<string,
        SystemBoundFileObjectNoPendingUnboundLeaseCurrent?> inspectCurrent;
    private readonly Func<SystemBoundFileObjectNoPendingUnboundLeaseProcess>
        inspectProcess;

    private SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter(
        Func<string, SystemBoundFileObjectNoPendingUnboundLeaseCurrent?>
            inspectCurrent,
        Func<SystemBoundFileObjectNoPendingUnboundLeaseProcess> inspectProcess)
    {
        this.inspectCurrent = inspectCurrent;
        this.inspectProcess = inspectProcess;
    }

    internal static SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
        CreateProduction(
            Func<string, SystemBoundFileObjectNoPendingUnboundLeaseCurrent?>
                inspectCurrent,
            Func<SystemBoundFileObjectNoPendingUnboundLeaseProcess>
                inspectProcess) => new(inspectCurrent, inspectProcess);

    internal static SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
        CreateWindows(string absoluteCurrentPath, JobObject job, Process process) =>
            new(
                _ => InspectWindowsCurrent(absoluteCurrentPath),
                () => {
                    var current = job.InspectRetainedProcess(process);
                    return new SystemBoundFileObjectNoPendingUnboundLeaseProcess(
                        current.ProcessId,
                        current.ProcessStartKey,
                        current.ProcessSequenceNumber,
                        current.Signaled,
                        current.JobMember);
                });

    internal SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
        WithCurrentInspectionFailure() => new(
            _ => throw new GuardException("FILE_IDENTITY_QUERY_FAILED"),
            inspectProcess);

    internal SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter
        WithProcessInspectionFailure(string failureCode)
    {
        if (failureCode is not (
            "PROCESS_WAIT_FAILED" or
            "JOB_QUERY_FAILED" or
            "PROCESS_START_KEY_QUERY_FAILED"))
            throw new ArgumentOutOfRangeException(nameof(failureCode));
        return new(
            inspectCurrent,
            () => throw new GuardException(failureCode));
    }

    internal SystemBoundFileObjectNoPendingUnboundLeaseCurrent?
        InspectCurrent(string relativePath) => inspectCurrent(relativePath);

    internal SystemBoundFileObjectNoPendingUnboundLeaseProcess
        InspectRetainedProcess() => inspectProcess();

    private static SystemBoundFileObjectNoPendingUnboundLeaseCurrent?
        InspectWindowsCurrent(string absolutePath)
    {
        if (!File.Exists(absolutePath)) return null;
        try
        {
            using var handle = CreateFileW(
                absolutePath,
                0,
                ShareRead | ShareWrite | ShareDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid)
                throw new GuardException("FILE_IDENTITY_QUERY_OPEN_FAILED");
            if (!GetFileInformationByHandle(handle, out var basic))
                throw new GuardException("FILE_IDENTITY_QUERY_BASIC_FAILED");
            if ((basic.FileAttributes & FileAttributeReparsePoint) != 0)
                throw new GuardException("FILE_IDENTITY_QUERY_REPARSE");
            if (basic.NumberOfLinks != 1)
                throw new GuardException("FILE_IDENTITY_QUERY_LINKS");
            var id = new WindowsFileIdInfo { FileId = new byte[16] };
            if (!GetFileInformationByHandleEx(
                handle,
                18,
                ref id,
                (uint)Marshal.SizeOf<WindowsFileIdInfo>()))
                throw new GuardException("FILE_IDENTITY_QUERY_FAILED");
            return new SystemBoundFileObjectNoPendingUnboundLeaseCurrent(
                $"{id.VolumeSerialNumber:x16}:" +
                Convert.ToHexStringLower(id.FileId));
        }
        catch (GuardException) { throw; }
        catch (Exception error) when (error is
            IOException or UnauthorizedAccessException or NotSupportedException)
        {
            throw new GuardException("FILE_IDENTITY_QUERY_FAILED");
        }
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
        out WindowsByHandleFileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        ref WindowsFileIdInfo information,
        uint bufferSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowsFileIdInfo
    {
        internal ulong VolumeSerialNumber;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        internal byte[] FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowsByHandleFileInformation
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
}

/// <summary>
/// pendingなしunbound leaseの実検査と14 stage決定を単一結線で所有する。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-047
/// </summary>
internal static class SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticEvaluator
{
    internal static string Evaluate(
        SystemBoundFileObjectNoPendingUnboundLeaseState lease,
        SystemBoundFileObjectNoPendingUnboundLeasePhase phase,
        IEnumerable<SystemBoundFileObjectNoPendingUnboundLeaseDeferred> deferred,
        long eventQpc,
        SystemBoundFileObjectNoPendingUnboundLeaseInspectionAdapter inspection)
    {
        static string Classify(
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

        if (lease.SnapshotPresent)
            return Classify(leaseSnapshotAbsent: false);
        if (!SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
                .IsEventAfterReservation(
                    eventQpc,
                    lease.CurrentPathReservedAtQpc))
            return Classify(eventAfterReservation: false);

        SystemBoundFileObjectNoPendingUnboundLeaseCurrent? current;
        try { current = inspection.InspectCurrent(lease.RelativePath); }
        catch (GuardException)
        {
            return Classify(currentInspectionSucceeded: false);
        }
        if (current is null) return Classify(currentExists: false);
        var deferredItems = deferred.ToArray();
        if (deferredItems.Length == 0) return Classify(deferredCount: 0);
        if (deferredItems.Length != 1)
            return Classify(deferredCount: deferredItems.Length);

        var item = deferredItems[0];
        var deferredTupleMatches =
            SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
                .DeferredTupleMatches(
                    item.WorkerPid,
                    lease.WorkerPid,
                    item.ProducerSequenceNumber,
                    lease.ProcessSequenceNumber,
                    item.Phase,
                    phase.Phase,
                    item.WorkId,
                    phase.WorkId,
                    item.PhaseInstanceId,
                    phase.PhaseInstanceId,
                    lease.PhaseInstanceId,
                    item.RelativePath,
                    item.SnapshotRelativePath,
                    lease.RelativePath,
                    item.FileObject,
                    item.FileObjectUnbound,
                    item.TimestampQpc,
                    lease.CurrentPathReservedAtQpc,
                    eventQpc);
        if (!deferredTupleMatches)
            return Classify(deferredTupleMatches: false);
        if (current.Value.Identity != item.SnapshotIdentity)
            return Classify(currentIdentityMatches: false);

        SystemBoundFileObjectNoPendingUnboundLeaseProcess process;
        try { process = inspection.InspectRetainedProcess(); }
        catch (GuardException error)
        {
            var failure = error.Code switch {
                "PROCESS_WAIT_FAILED" => "WAIT",
                "JOB_QUERY_FAILED" => "JOB",
                _ => "IDENTITY",
            };
            return Classify(processInspectionFailure: failure);
        }
        var processTupleMatches =
            process.ProcessId == lease.WorkerPid &&
            process.ProcessStartKey == lease.ProcessStartKey &&
            process.ProcessSequenceNumber == lease.ProcessSequenceNumber;
        if (!processTupleMatches)
            return Classify(processTupleMatches: false);
        if (process.Signaled)
            return Classify(processSignaled: true, processJobMember: false);
        if (!process.JobMember)
            return Classify(processJobMember: false);
        return Classify();
    }
}

public static class SystemBoundFileObjectNoPendingUnboundLeaseDiagnosticRules
{
    // @des DES-F005-006 @fun FUN-F005-047 unbound leaseをQPC/deferred/processの固定順で診断する。
    public static bool IsEventAfterReservation(
        long eventQpc,
        long currentPathReservedAtQpc) =>
        eventQpc > currentPathReservedAtQpc;

    public static bool IsDeferredTimestampCandidate(
        long deferredQpc,
        long currentPathReservedAtQpc,
        long eventQpc) =>
        deferredQpc > currentPathReservedAtQpc &&
        deferredQpc <= eventQpc;

    public static bool DeferredTupleMatches(
        int deferredWorkerPid,
        int leaseWorkerPid,
        ulong deferredSequence,
        ulong leaseSequence,
        string deferredPhase,
        string activePhase,
        string? deferredWorkId,
        string? activeWorkId,
        string deferredPhaseInstanceId,
        string activePhaseInstanceId,
        string leasePhaseInstanceId,
        string deferredRelativePath,
        string deferredSnapshotPath,
        string leaseRelativePath,
        ulong deferredFileObject,
        bool deferredFileObjectUnbound,
        long deferredQpc,
        long currentPathReservedAtQpc,
        long eventQpc) =>
        deferredWorkerPid == leaseWorkerPid &&
        deferredSequence == leaseSequence &&
        deferredPhase == activePhase &&
        deferredWorkId == activeWorkId &&
        deferredPhaseInstanceId == activePhaseInstanceId &&
        deferredPhaseInstanceId == leasePhaseInstanceId &&
        deferredRelativePath == leaseRelativePath &&
        deferredSnapshotPath == leaseRelativePath &&
        deferredFileObject != 0 &&
        deferredFileObjectUnbound &&
        IsDeferredTimestampCandidate(
            deferredQpc,
            currentPathReservedAtQpc,
            eventQpc);

    public static string Classify(
        bool leaseSnapshotAbsent,
        bool eventAfterReservation,
        bool currentInspectionSucceeded,
        bool currentExists,
        int deferredCount,
        bool deferredTupleMatches,
        bool currentIdentityMatches,
        string? processInspectionFailure,
        bool processTupleMatches,
        bool processSignaled,
        bool processJobMember)
    {
        if (!leaseSnapshotAbsent) return "UNBOUND_SNAPSHOT_PRESENT";
        if (!eventAfterReservation) return "UNBOUND_BEFORE_RESERVATION";
        if (!currentInspectionSucceeded)
            return "UNBOUND_CURRENT_INSPECTION_FAILED";
        if (!currentExists) return "UNBOUND_CURRENT_MISSING";
        if (deferredCount == 0) return "UNBOUND_DEFERRED_MISSING";
        if (deferredCount != 1 || !deferredTupleMatches)
            return "UNBOUND_DEFERRED_TUPLE";
        if (!currentIdentityMatches) return "UNBOUND_CURRENT_ID_MISMATCH";
        if (processInspectionFailure is not null)
            return processInspectionFailure switch {
                "WAIT" => "UNBOUND_PROCESS_WAIT_FAILED",
                "JOB" => "UNBOUND_JOB_QUERY_FAILED",
                _ => "UNBOUND_PROCESS_IDENTITY_FAILED",
            };
        if (!processTupleMatches) return "UNBOUND_PROCESS_TUPLE";
        if (processSignaled) return "UNBOUND_PROCESS_SIGNALED";
        if (!processJobMember) return "UNBOUND_LEASE_ESCAPE";
        return "UNBOUND_CANDIDATE";
    }
}

public static class SystemBoundFileObjectRenameLeasePathDiagnosticRules
{
    // @des DES-F005-006 @fun FUN-F005-047 rename中のlease path不一致を生値なしで固定分類する。
    public static string? ClassifyTimeRelation(
        long eventQpc,
        long leaseReservationQpc,
        long renameReservationQpc)
    {
        if (eventQpc <= leaseReservationQpc) return "BEFORE_LEASE_RESERVATION";
        if (eventQpc <= renameReservationQpc) return "AFTER_LEASE_RESERVATION";
        return null;
    }

    public static string Classify(
        bool hasPath,
        bool targetMatches,
        bool hasReservation,
        bool reservationOrderValid,
        bool eventAfterLeaseReservation,
        bool eventAfterRenameReservation,
        bool leaseCurrentExists,
        bool hasSnapshot,
        bool snapshotPathMatches,
        bool identityMatches,
        bool bindingMatches,
        bool leaseClosed,
        bool leaseOutsideJob)
    {
        if (!hasPath) return "PATH_MISSING";
        if (!targetMatches) return "TARGET_MISMATCH";
        if (!hasReservation) return "RESERVATION_MISSING";
        if (!reservationOrderValid) return "RESERVATION_ORDER";
        if (!eventAfterLeaseReservation) return "BEFORE_LEASE_RESERVATION";
        if (!eventAfterRenameReservation) return "AFTER_LEASE_RESERVATION";
        if (leaseCurrentExists) return "LEASE_CURRENT_EXISTS";
        if (!hasSnapshot) return "SNAPSHOT_MISSING";
        if (!snapshotPathMatches) return "SNAPSHOT_PATH";
        if (!identityMatches) return "IDENTITY_MISMATCH";
        if (!bindingMatches) return "BINDING_MISMATCH";
        if (leaseClosed) return "LEASE_CLOSED";
        if (leaseOutsideJob) return "LEASE_ESCAPE";
        return "CANDIDATE";
    }
}

public static class SystemDirectoryBoundLeaseWriteRejoinDiagnosticRules
{
    public static string Classify(
        string directoryStage,
        bool hasLease,
        bool leasePhaseMatches,
        bool leaseParentMatches,
        bool leaseBound,
        bool leaseClosed,
        bool hasLeaseSnapshot,
        bool hasBinding,
        bool bindingMatches,
        bool currentExists,
        bool identityMatches,
        bool leaseOutsideJob)
    {
        if (directoryStage != "CANDIDATE")
            return directoryStage switch {
                "SNAPSHOT_MISSING" => "DIRECTORY_SNAPSHOT_MISSING",
                "CURRENT_MISSING" => "DIRECTORY_CURRENT_MISSING",
                "IDENTITY_MISMATCH" => "DIRECTORY_IDENTITY_MISMATCH",
                "OWNER_MISSING" => "DIRECTORY_OWNER_MISSING",
                "ROOT_INACTIVE" => "DIRECTORY_ROOT_INACTIVE",
                _ => "DIRECTORY_UNKNOWN",
            };
        if (!hasLease) return "LEASE_MISSING";
        if (!leasePhaseMatches) return "LEASE_PHASE";
        if (!leaseParentMatches) return "LEASE_PARENT";
        if (leaseClosed) return "LEASE_CLOSED";
        if (!leaseBound) return "LEASE_UNBOUND";
        if (!hasLeaseSnapshot) return "LEASE_SNAPSHOT_MISSING";
        if (!hasBinding) return "LEASE_BINDING_MISSING";
        if (!bindingMatches) return "LEASE_BINDING_MISMATCH";
        if (!currentExists) return "LEASE_CURRENT_MISSING";
        if (!identityMatches) return "LEASE_IDENTITY_MISMATCH";
        if (leaseOutsideJob) return "LEASE_ESCAPE";
        return "CANDIDATE";
    }
}

public static class SystemDirectoryBoundLeaseRenameDiagnosticRules
{
    // @des DES-F005-006 @fun FUN-F005-047 raw QPCを公開せずlease/rename予約との順序だけを固定分類する。
    public static string Classify(
        bool hasTarget,
        bool parentMatches,
        bool hasReservation,
        bool afterLeaseReservation,
        bool afterRenameReservation,
        bool currentExists,
        bool identityMatches,
        bool leaseOutsideJob)
    {
        if (!hasTarget) return "PATH_MISSING";
        if (!parentMatches) return "PARENT";
        if (!hasReservation) return "RESERVATION_MISSING";
        if (!afterLeaseReservation) return "BEFORE_LEASE_RESERVATION";
        if (!afterRenameReservation) return "AFTER_LEASE_RESERVATION";
        if (!currentExists) return "CURRENT_MISSING";
        if (!identityMatches) return "IDENTITY_MISMATCH";
        if (leaseOutsideJob) return "LEASE_ESCAPE";
        return "CANDIDATE";
    }
}

public static class SystemSetInfoCorrelationRules
{
    public static bool CanPrepareRename(
        bool phaseMatches,
        bool rootAuthenticated,
        bool tupleMatches,
        bool alreadyPrepared,
        bool correlationReady,
        bool processSignaled,
        bool processAliveOutsideJob,
        bool targetExists) =>
        phaseMatches &&
        rootAuthenticated &&
        tupleMatches &&
        !alreadyPrepared &&
        correlationReady &&
        !processSignaled &&
        !processAliveOutsideJob &&
        !targetExists;

    public static bool TryConsumeRename(
        string noticeFrom,
        string noticeTo,
        string currentPath,
        string? pendingRenamePath,
        long? renameReservationQpc,
        out long promotedReservationQpc)
    {
        if (renameReservationQpc is not null &&
            string.Equals(noticeFrom, currentPath, StringComparison.Ordinal) &&
            string.Equals(noticeTo, pendingRenamePath, StringComparison.Ordinal))
        {
            promotedReservationQpc = renameReservationQpc.Value;
            return true;
        }
        promotedReservationQpc = 0;
        return false;
    }

    public static bool TryGetReservationQpc(
        string observedPath,
        string currentPath,
        long writeReservationQpc,
        string? pendingRenamePath,
        long? renameReservationQpc,
        out long reservationQpc)
    {
        if (string.Equals(observedPath, currentPath, StringComparison.Ordinal))
        {
            reservationQpc = writeReservationQpc;
            return true;
        }
        if (renameReservationQpc is not null &&
            string.Equals(observedPath, pendingRenamePath, StringComparison.Ordinal))
        {
            reservationQpc = renameReservationQpc.Value;
            return true;
        }
        reservationQpc = 0;
        return false;
    }

    public static bool CanAuthorize(
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool phaseAndLeaseMatch,
        bool eventAfterReservation,
        bool processAliveOutsideJob,
        bool fileObjectClosed) =>
        MatchesReservation(
            authorizationFailure,
            systemPid,
            eventName,
            fileObject,
            phaseAndLeaseMatch,
            eventAfterReservation,
            processAliveOutsideJob) &&
        !fileObjectClosed;

    public static bool MatchesReservation(
        string authorizationFailure,
        int systemPid,
        string eventName,
        ulong fileObject,
        bool phaseAndLeaseMatch,
        bool eventAfterReservation,
        bool processAliveOutsideJob) =>
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "setinfo" &&
        fileObject != 0 &&
        phaseAndLeaseMatch &&
        eventAfterReservation &&
        !processAliveOutsideJob;

    public static bool CanBindDeferred(
        bool fileObjectClosed,
        bool workerIdentityMatches,
        bool pathAndPhaseMatch,
        ulong createFileObject,
        ulong deferredFileObject,
        long reservationQpc,
        long createQpc,
        long systemSetInfoQpc,
        string createIdentity,
        string systemSetInfoIdentity) =>
        !fileObjectClosed &&
        workerIdentityMatches &&
        pathAndPhaseMatch &&
        createFileObject != 0 &&
        createFileObject == deferredFileObject &&
        createQpc > reservationQpc &&
        systemSetInfoQpc >= createQpc &&
        string.Equals(createIdentity, systemSetInfoIdentity, StringComparison.Ordinal);

    public static bool CleanupInvalidates(
        ulong cleanupFileObject,
        ulong? leasedFileObject,
        IEnumerable<ulong> deferredFileObjects) =>
        leasedFileObject == cleanupFileObject ||
        deferredFileObjects.Contains(cleanupFileObject);

    public static bool CanComplete(
        bool processSignaled,
        bool hasBoundOrClosedFileObject,
        bool hasSnapshot,
        bool hasDeferredEvents,
        bool hasPendingRename) =>
        processSignaled &&
        hasBoundOrClosedFileObject &&
        hasSnapshot &&
        !hasDeferredEvents &&
        !hasPendingRename;

    public static IEnumerable<T> ReplayInEtwOrder<T>(
        IEnumerable<T> values,
        Func<T, long> sequence) =>
        values.OrderBy(sequence);
}
