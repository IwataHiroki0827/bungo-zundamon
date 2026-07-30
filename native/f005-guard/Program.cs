using System.Buffers;
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
    private readonly Dictionary<string, string> completedWriteIdentities =
        new(StringComparer.Ordinal);
    private readonly List<PhaseRecord> phaseRecords = [];
    private readonly List<NoticeRecord> notices = [];
    private readonly List<ObservationRecord> observations = [];
    private readonly List<DeferredRenameRecord> deferredRenames = [];
    private readonly List<DeferredSystemSetInfoRecord> deferredSystemSetInfos = [];
    private PendingWriteLease? pendingWriteLease;
    private long etwSequence;
    private long etwRelevantEventCount;
    private long noticeSequence;
    private long peakLiveBytes;
    private long minimumObservedFreeBytes;
    private int? rootWorkerPid;
    private Process? rootWorkerProcess;
    private ulong? rootWorkerStartKey;
    private ulong? rootWorkerSequenceNumber;
    private string? failureCode;
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
        lock (gate)
        {
            filesByObject.Remove(fileObject);
            var lease = pendingWriteLease;
            var deferredMatches = deferredSystemSetInfos.Any(item => item.FileObject == fileObject);
            if (!SystemSetInfoCorrelationRules.CleanupInvalidates(
                fileObject,
                lease?.FileObject,
                deferredSystemSetInfos.Select(item => item.FileObject)))
                return;
            if (deferredMatches)
            {
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
        completedWriteIdentities.Clear();
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
        if (TryInspect(path) is not null) throw new GuardException("WRITE_LEASE_PATH_CONFLICT");
        var process = job.OpenContainedProcess(producerPid)
            ?? throw new GuardException("WRITE_LEASE_PRODUCER_NOT_JOB_MEMBER");
        try
        {
            var identity = job.ProcessIdentity(process);
            pendingWriteLease = new PendingWriteLease(
                producerPid,
                identity.ProcessStartKey,
                identity.ProcessSequenceNumber,
                phaseInstanceId,
                path,
                Stopwatch.GetTimestamp(),
                process);
            process = null!;
            return new { ok = true, state = "reserved", path, producerPid };
        }
        finally
        {
            process?.Dispose();
        }
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
        var correlationReady = lease is not null &&
            !lease.FileObjectClosed &&
            lease.FileObject is not null &&
            lease.Snapshot is not null;
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
            if (!tupleMatches || lease is null)
                throw new GuardException("WRITE_LEASE_TUPLE_MISMATCH");
            if (lease.PendingRenamePath is not null)
            throw new GuardException("WRITE_LEASE_RENAME_ALREADY_PREPARED");
            if (!correlationReady)
            throw new GuardException("WRITE_LEASE_CORRELATION_MISSING");
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
            ValidateWriteLeaseTuple(producerPid, phaseInstanceId, path);
        }
        try
        {
            var drain = Stopwatch.StartNew();
            while (drain.Elapsed < TimeSpan.FromSeconds(2))
            {
                etwSession.Flush();
                var before = Interlocked.Read(ref etwRelevantEventCount);
                Thread.Sleep(100);
                if (Interlocked.Read(ref etwRelevantEventCount) != before) continue;
                etwSession.Flush();
                Thread.Sleep(100);
                if (Interlocked.Read(ref etwRelevantEventCount) == before)
                {
                    lock (gate) return CompleteWrite(producerPid, phaseInstanceId, path);
                }
            }
        }
        catch (GuardException)
        {
            throw;
        }
        catch
        {
            throw new GuardException("ETW_CONSUMER_DRAIN_FAILED");
        }
        throw new GuardException("ETW_CONSUMER_DRAIN_TIMEOUT");
    }

    private object CompleteWrite(int producerPid, string phaseInstanceId, string path)
    {
        var lease = ValidateWriteLeaseTuple(producerPid, phaseInstanceId, path);
        var processSignaled = job.IsSignaled(lease.Process);
        var hasDeferredEvents = deferredSystemSetInfos.Any(
            item => item.PhaseInstanceId == phaseInstanceId);
        if (!SystemSetInfoCorrelationRules.CanComplete(
            processSignaled,
            lease.FileObject is not null || lease.FileObjectClosed,
            lease.Snapshot is not null,
            hasDeferredEvents,
            lease.PendingRenamePath is not null))
        {
            if (!processSignaled)
                throw new GuardException("WRITE_LEASE_PROCESS_STILL_RUNNING");
            throw new GuardException("WRITE_LEASE_CORRELATION_MISSING");
        }
        var current = TryInspect(path)
            ?? throw new GuardException("WRITE_LEASE_IDENTITY_MISSING");
        if (current.Identity != lease.Snapshot!.Identity)
            throw new GuardException("WRITE_LEASE_IDENTITY_MISMATCH");
        if (CompletedWriteDiagnosticRules.ShouldTrack(
            activePhase?.Phase,
            completedWriteIdentities.Count,
            completedWriteIdentities.ContainsKey(path)))
            completedWriteIdentities[path] = current.Identity;
        lease.Process.Dispose();
        pendingWriteLease = null;
        return new { ok = true, state = "completed", path, producerPid };
    }

    private PendingWriteLease ValidateWriteLeaseTuple(
        int producerPid,
        string phaseInstanceId,
        string path)
    {
        var lease = pendingWriteLease;
        if (lease is null ||
            lease.WorkerPid != producerPid ||
            lease.PhaseInstanceId != phaseInstanceId ||
            lease.RelativePath != path)
            throw new GuardException("WRITE_LEASE_TUPLE_MISMATCH");
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
        var deadline = DateTime.UtcNow + ObservationMatchWindow;
        while (record.State != "matched" && failureCode is null)
        {
            var remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero ||
                !Monitor.Wait(gate, remaining))
            {
                throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
            }
        }
        if (failureCode is not null) throw new GuardException(failureCode);
        if (pendingWriteLease is { } writeLease &&
            writeLease.WorkerPid == record.WorkerPid &&
            writeLease.ProcessSequenceNumber == record.ProducerSequenceNumber &&
            writeLease.PhaseInstanceId == record.PhaseInstanceId)
        {
            if (record.EventName == "create" &&
                record.Path == writeLease.RelativePath &&
                (writeLease.FileObject is null || writeLease.Snapshot is null))
                throw new GuardException("WRITE_LEASE_CORRELATION_MISSING");
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

    private object EndPhase(string phase, string phaseInstanceId)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (activePhase is null ||
            activePhase.Phase != phase ||
            activePhase.PhaseInstanceId != phaseInstanceId)
        {
            throw new GuardException("PHASE_MISMATCH");
        }
        if (notices.Any(item =>
            item.PhaseInstanceId == phaseInstanceId && item.State != "matched"))
        {
            throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
        }
        if (deferredRenames.Any(item => item.PhaseInstanceId == phaseInstanceId))
            throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
        if (pendingWriteLease?.PhaseInstanceId == phaseInstanceId ||
            deferredSystemSetInfos.Any(item => item.PhaseInstanceId == phaseInstanceId))
            throw new GuardException("WRITE_LEASE_CORRELATION_MISSING");
        AssertRegisteredProcessesContained();
        var free = ReadFreeBytes(root);
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
        phaseRecords.Add(new PhaseRecord(phase, activePhase.WorkId, phaseInstanceId, "finished",
            DateTimeOffset.UtcNow.ToString("O"), CurrentLiveBytes(), free));
        activePhase = null;
        completedWriteIdentities.Clear();
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
        }
        try
        {
            var drain = Stopwatch.StartNew();
            while (drain.Elapsed < TimeSpan.FromSeconds(2))
            {
                etwSession.Flush();
                var before = Interlocked.Read(ref etwRelevantEventCount);
                Thread.Sleep(100);
                if (Interlocked.Read(ref etwRelevantEventCount) != before) continue;
                etwSession.Flush();
                Thread.Sleep(100);
                if (Interlocked.Read(ref etwRelevantEventCount) == before)
                {
                    lock (gate) return EndPhase(phase, phaseInstanceId);
                }
            }
        }
        catch (GuardException)
        {
            throw;
        }
        catch
        {
            throw new GuardException("ETW_CONSUMER_DRAIN_FAILED");
        }
        throw new GuardException("ETW_CONSUMER_DRAIN_TIMEOUT");
    }

    private object CloseJournal()
    {
        lock (gate)
        {
            ThrowIfClosed();
            if (failureCode is not null) throw new GuardException(failureCode);
            if (activePhase is not null) throw new GuardException("PHASE_STILL_ACTIVE");
            if (notices.Any(item => item.State != "matched"))
                throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
            if (deferredRenames.Count != 0)
                throw new GuardException("F005_CAPACITY_NOTICE_UNMATCHED");
            if (pendingWriteLease is not null || deferredSystemSetInfos.Count != 0)
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
        try
        {
            var normalized = NormalizeObservedPath(eventPath);
            if (normalized is null) return;
            var isProcessIdentityProbe =
                string.Equals(normalized, processIdentityProbePath, StringComparison.Ordinal);
            if (!isProcessIdentityProbe && IsJournalPath(normalized)) return;
            Interlocked.Increment(ref etwRelevantEventCount);
            lock (gate)
            {
                callbackStage = "STATE";
                if (journalClosed || failureCode is not null) return;
                if (isProcessIdentityProbe)
                {
                    ObserveProcessIdentityProbeLocked(pid, processStartKey);
                    return;
                }
                callbackStage = "AUTHORIZATION";
                if (!AuthorizeJobMemberLocked(
                    pid,
                    processStartKey,
                    timestampQpc,
                    out var producerSequenceNumber,
                    out var authorizationFailure))
                {
                    if (TryAuthorizeReservedSystemSetInfoLocked(
                        eventName,
                        pid,
                        normalized,
                        fileObject,
                        timestamp,
                        timestampQpc,
                        authorizationFailure,
                        out var reservedPid,
                        out var reservedSequenceNumber,
                        out var deferred))
                    {
                        if (deferred) return;
                        pid = reservedPid;
                        producerSequenceNumber = reservedSequenceNumber;
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
                                ? "SYSTEM_PROCESS_BOUND_FILE_OBJECT"
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
                callbackStage = "IDENTITY";
                if (eventName != "delete")
                    current = TryInspect(normalized);
                callbackStage = "CORRELATION";
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
                    writeLease.FileObject = fileObject;
                    writeLease.Snapshot = current;
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
                    var pendingRename = notices.FirstOrDefault(item =>
                        item.State == "pending" &&
                        item.WorkerPid == pid &&
                        item.ProducerSequenceNumber == producerSequenceNumber &&
                        item.PhaseInstanceId == activePhase.PhaseInstanceId &&
                        item.EventName == "rename" &&
                        item.From == source.RelativePath &&
                        (observedTarget is null || item.To == observedTarget));
                    if (pendingRename is null)
                    {
                        deferredRenames.Add(deferred);
                    }
                    else
                    {
                        CompleteDeferredRename(deferred, pendingRename);
                    }
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
                if (current is not null)
                {
                    filesByObject[fileObject] = current;
                    filesByPath[current.RelativePath] = current;
                }
                if (eventName == "delete")
                {
                    filesByObject.Remove(fileObject);
                    filesByPath.Remove(effective.RelativePath);
                }

                callbackStage = "CAPACITY";
                var oldAllocated = allocatedByIdentity.GetValueOrDefault(effective.Identity);
                var newAllocated = eventName == "delete" ? 0 : effective.AllocatedLengthBytes;
                allocatedByIdentity[effective.Identity] = newAllocated;
                if (newAllocated == 0) allocatedByIdentity.Remove(effective.Identity);
                var delta = checked(newAllocated - oldAllocated);
                var live = CurrentLiveBytes();
                peakLiveBytes = Math.Max(peakLiveBytes, live);
                var free = ReadFreeBytes(root);
                minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
                var sequence = checked(++etwSequence);
                callbackStage = "RECORD";
                var observation = new ObservationRecord(
                    eventName,
                    normalized,
                    null,
                    null,
                    activePhase.Phase,
                    activePhase.WorkId,
                    activePhase.PhaseInstanceId,
                    sequence,
                    new DateTimeOffset(timestamp.ToUniversalTime()).ToString("O"),
                    pid,
                    producerSequenceNumber,
                    effective.VolumeId,
                    effective.FileId128,
                    eventName == "delete" ? 0 : effective.LogicalLengthBytes,
                    eventName == "delete" ? 0 : effective.AllocatedLengthBytes,
                    delta,
                    live,
                    free,
                    new DriveInfo(Path.GetPathRoot(root)!).TotalFreeSpace,
                    producerBinarySha256);
                var pending = notices.FirstOrDefault(item =>
                    item.State == "pending" &&
                    item.WorkerPid == pid &&
                    item.ProducerSequenceNumber == producerSequenceNumber &&
                    item.PhaseInstanceId == activePhase.PhaseInstanceId &&
                    item.Matches(observation));
                if (pending is not null)
                {
                    pending.Match(sequence);
                    observation.NoticeSequence = pending.NoticeSequence;
                    Monitor.PulseAll(gate);
                }
                observations.Add(observation);
            }
        }
        catch (Exception error)
        {
            Poison(error is GuardException guard
                ? ClassifyEtwGuardFailure(guard.Code, eventName, callbackStage)
                : ClassifyEtwCallbackFailure(error, callbackStage));
        }
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
        out bool deferred)
    {
        producerPid = 0;
        producerSequenceNumber = 0;
        deferred = false;
        var lease = pendingWriteLease;
        if (activePhase is null || lease is null)
            return false;
        producerPid = lease.WorkerPid;
        producerSequenceNumber = lease.ProcessSequenceNumber;
        if (lease.FileObjectClosed)
        {
            PoisonLocked("ETW_SYSTEM_SETINFO_CORRELATION_LEASE_CLOSED");
            deferred = true;
            return true;
        }
        var pathMatches = SystemSetInfoCorrelationRules.TryGetReservationQpc(
            normalized,
            lease.RelativePath,
            lease.CurrentPathReservedAtQpc,
            lease.PendingRenamePath,
            lease.RenameReservedAtQpc,
            out var pathReservationQpc);
        if (!SystemSetInfoCorrelationRules.CanAuthorize(
            authorizationFailure,
            pid,
            eventName,
            fileObject,
            lease.PhaseInstanceId == activePhase.PhaseInstanceId &&
                pathMatches,
            timestampQpc > pathReservationQpc,
            job.IsAliveOutsideJob(lease.Process),
            lease.FileObjectClosed))
            return false;
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

    private void CompleteDeferredRename(DeferredRenameRecord deferred, NoticeRecord notice)
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
        allocatedByIdentity[target.Identity] = target.AllocatedLengthBytes;
        var delta = checked(target.AllocatedLengthBytes - oldAllocated);
        var live = CurrentLiveBytes();
        peakLiveBytes = Math.Max(peakLiveBytes, live);
        var free = ReadFreeBytes(root);
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

    private string CompletedWriteDiagnosticState(string relativePath)
    {
        if (!completedWriteIdentities.TryGetValue(relativePath, out var expectedIdentity))
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
            identityMatches: current?.Identity == expectedIdentity);
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

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (!journalClosed)
            {
                failureCode ??= "CAPACITY_SESSION_ABORTED";
                try { PersistJournal(closed: false); } catch { }
            }
        }
        processIdentityProbeObserved.Set();
        cancellation.Cancel();
        try { StopEtw(); } catch { }
        try { pipeTask.Wait(TimeSpan.FromSeconds(5)); } catch { }
        etwSource.Dispose();
        etwSession.Dispose();
        pendingWriteLease?.Process.Dispose();
        foreach (var worker in registeredWorkerProcesses.Values) worker.Process.Dispose();
        rootWorkerProcess?.Dispose();
        job.Dispose();
        processIdentityProbeObserved.Dispose();
        cancellation.Dispose();
    }

    private static object Error(string code) => new { ok = false, error = code };

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

    private sealed class PendingWriteLease(
        int workerPid,
        ulong processStartKey,
        ulong processSequenceNumber,
        string phaseInstanceId,
        string relativePath,
        long reservedAtQpc,
        Process process)
    {
        public int WorkerPid { get; } = workerPid;
        public ulong ProcessStartKey { get; } = processStartKey;
        public ulong ProcessSequenceNumber { get; } = processSequenceNumber;
        public string PhaseInstanceId { get; } = phaseInstanceId;
        public string RelativePath { get; set; } = relativePath;
        public long ReservedAtQpc { get; } = reservedAtQpc;
        public long CurrentPathReservedAtQpc { get; set; } = reservedAtQpc;
        public Process Process { get; } = process;
        public ulong? FileObject { get; set; }
        public bool FileObjectClosed { get; set; }
        public FileSnapshot? Snapshot { get; set; }
        public string? PendingRenamePath { get; set; }
        public long? RenameReservedAtQpc { get; set; }
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
        ulong ProcessStartKey,
        ulong ProcessSequenceNumber);

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
        authorizationFailure == "BIRTH_MISSING" &&
        systemPid is 0 or 4 &&
        eventName == "setinfo" &&
        fileObject != 0 &&
        phaseAndLeaseMatch &&
        eventAfterReservation &&
        !processAliveOutsideJob &&
        !fileObjectClosed;

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
