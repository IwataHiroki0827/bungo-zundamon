using System.Buffers;
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
const int MaxRequestChars = 65_536;
var capabilities = new Dictionary<string, HeldCapability>(StringComparer.Ordinal);
CapacityGuardSession? capacitySession = null;

Console.InputEncoding = new UTF8Encoding(false, true);
Console.OutputEncoding = new UTF8Encoding(false, true);

while (Console.ReadLine() is { } line)
{
    if (line.Length == 0 || line.Length > MaxRequestChars)
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
        switch (operation)
        {
            case "hello":
                Reply(new {
                    ok = true,
                    abi = Abi,
                    capacityAbi = CapacityAbi,
                    rid = RuntimeInformation.RuntimeIdentifier,
                    runtimeVersion = Environment.Version.ToString(),
                    processId = Environment.ProcessId,
                });
                break;
            case "capacity-preflight":
                RequireExactKeys(root, "op");
                if (!OperatingSystem.IsWindows()) throw new GuardException("PLATFORM_UNSUPPORTED");
                if (TraceEventSession.IsElevated() != true) throw new GuardException("ETW_PRIVILEGE_REQUIRED");
                Reply(new {
                    ok = true,
                    capacityAbi = CapacityAbi,
                    etw = "kernel-fileio",
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
    private const uint DeleteAccess = 0x00010000;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const int FileRenameInfo = 3;
    private const int FileDispositionInfo = 4;

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
    private readonly string producerBinarySha256;
    private readonly CancellationTokenSource cancellation = new();
    private readonly JobObject job;
    private readonly TraceEventSession etwSession;
    private readonly ETWTraceEventSource etwSource;
    private readonly Thread etwThread;
    private readonly Task pipeTask;
    private readonly HashSet<int> registeredPids = [];
    private readonly Dictionary<ulong, FileSnapshot> filesByObject = [];
    private readonly Dictionary<string, long> allocatedByIdentity = new(StringComparer.Ordinal);
    private readonly List<PhaseRecord> phaseRecords = [];
    private readonly List<NoticeRecord> notices = [];
    private readonly List<ObservationRecord> observations = [];
    private long etwSequence;
    private long noticeSequence;
    private long peakLiveBytes;
    private long minimumObservedFreeBytes;
    private string? failureCode;
    private ActivePhase? activePhase;
    private bool etwStopped;
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
        etwThread = new Thread(ProcessEtw) {
            IsBackground = true,
            Name = "f005-capacity-etw",
        };
        etwThread.Start();
        pipeTask = Task.Run(PipeLoopAsync);
        PersistJournal(closed: false);
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
            session.EnableKernelProvider(
                KernelTraceEventParser.Keywords.FileIO |
                KernelTraceEventParser.Keywords.FileIOInit);
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
        catch (Exception error) when (error is not GuardException)
        {
            session?.Dispose();
            job?.Dispose();
            throw new GuardException($"ETW_SESSION_START_FAILED_{error.HResult:x8}");
        }
    }

    private void ConfigureEtwCallbacks()
    {
        var kernel = etwSource.Kernel;
        kernel.FileIOCreate += data => {
            if (data.CreateDisposition != CreateDisposition.OPEN_EXISTING)
            {
                ObserveEtw("create", data.ProcessID, data.FileName, data.FileObject, data.TimeStamp);
            }
        };
        kernel.FileIOWrite += data =>
            ObserveEtw("write", data.ProcessID, data.FileName, data.FileObject, data.TimeStamp);
        kernel.FileIOSetInfo += data =>
            ObserveEtw("setinfo", data.ProcessID, data.FileName, data.FileObject, data.TimeStamp);
        kernel.FileIORename += data =>
            ObserveEtw("rename", data.ProcessID, data.FileName, data.FileObject, data.TimeStamp);
        kernel.FileIODelete += data =>
            ObserveEtw("delete", data.ProcessID, data.FileName, data.FileObject, data.TimeStamp);
        kernel.LostEvent += _ => Poison("ETW_BUFFER_LOSS");
        kernel.All += ObserveUnknownEtw;
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
            if (AuthorizeJobMemberLocked(data.ProcessID))
                PoisonLocked("ETW_UNKNOWN_EVENT");
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

    private async Task PipeLoopAsync()
    {
        while (!cancellation.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(
                PipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(cancellation.Token).ConfigureAwait(false);
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var clientPid) ||
                    clientPid is 0 or > int.MaxValue)
                {
                    Poison("IPC_PEER_IDENTITY_UNAVAILABLE");
                    continue;
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
            case "beginPhase":
                RequireExactPipeKeys(rootElement, "authToken", "op", "phase", "phaseInstanceId", "sessionNonce", "workId");
                break;
            case "notice":
            {
                var eventName = PipeString(rootElement, "event");
                RequireExactPipeKeys(rootElement, eventName == "rename"
                    ? ["authToken", "event", "from", "noticeId", "op", "phase", "phaseInstanceId", "sessionNonce", "to", "workId"]
                    : ["authToken", "event", "noticeId", "op", "path", "phase", "phaseInstanceId", "sessionNonce", "workId"]);
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
        lock (gate)
        {
            ThrowIfClosed();
            return operation switch {
                "registerSelf" => RegisterSelf(clientPid),
                "beginPhase" => BeginPhase(
                    PipeString(rootElement, "phase"),
                    PipeNullableWorkId(rootElement, "workId"),
                    PipeSha256(rootElement, "phaseInstanceId")),
                "notice" => ReceiveNotice(rootElement, clientPid),
                "endPhase" => EndPhase(
                    PipeString(rootElement, "phase"),
                    PipeSha256(rootElement, "phaseInstanceId")),
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
        job.Assign(pid);
        if (!job.Contains(pid)) throw new GuardException("JOB_ASSIGNMENT_FAILED");
        registeredPids.Add(pid);
        PersistJournal(closed: false);
        return new { ok = true, pid, jobIdentity = JobIdentity };
    }

    private object BeginPhase(string phase, string? workId, string phaseInstanceId)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        ValidatePhase(phase, workId);
        if (!string.Equals(workId, WorkId, StringComparison.Ordinal))
            throw new GuardException("PHASE_WORK_MISMATCH");
        if (activePhase is not null) throw new GuardException("PHASE_ALREADY_ACTIVE");
        activePhase = new ActivePhase(phase, workId, phaseInstanceId);
        var free = ReadFreeBytes(root);
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
        phaseRecords.Add(new PhaseRecord(phase, workId, phaseInstanceId, "started",
            DateTimeOffset.UtcNow.ToString("O"), CurrentLiveBytes(), free));
        PersistJournal(closed: false);
        return new { ok = true, phase, workId, phaseInstanceId };
    }

    private object ReceiveNotice(JsonElement rootElement, int clientPid)
    {
        if (failureCode is not null) throw new GuardException(failureCode);
        if (activePhase is null) throw new GuardException("PHASE_NOT_ACTIVE");
        if (!registeredPids.Contains(clientPid) || !job.Contains(clientPid))
            throw new GuardException("NOTICE_PID_NOT_REGISTERED");
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
            clientPid,
            phase,
            workId,
            phaseInstanceId,
            noticeId,
            eventName,
            path,
            from,
            to);
        var floor = DateTimeOffset.UtcNow - ObservationMatchWindow;
        var match = observations.LastOrDefault(item =>
            item.NoticeSequence is null &&
            item.WorkerPid == clientPid &&
            item.Phase == phase &&
            item.PhaseInstanceId == phaseInstanceId &&
            item.ObservedAtValue >= floor &&
            item.Matches(eventName, path, from, to));
        if (match is not null)
        {
            record.Match(match.EtwSequence);
            match.NoticeSequence = record.NoticeSequence;
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
        AssertRegisteredProcessesContained();
        var free = ReadFreeBytes(root);
        minimumObservedFreeBytes = Math.Min(minimumObservedFreeBytes, free);
        phaseRecords.Add(new PhaseRecord(phase, activePhase.WorkId, phaseInstanceId, "finished",
            DateTimeOffset.UtcNow.ToString("O"), CurrentLiveBytes(), free));
        activePhase = null;
        PersistJournal(closed: false);
        return new { ok = true, phase, phaseInstanceId };
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
            AssertRegisteredProcessesContained();
        }
        StopEtw();
        lock (gate)
        {
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
        string eventPath,
        ulong fileObject,
        DateTime timestamp)
    {
        try
        {
            var normalized = NormalizeObservedPath(eventPath);
            if (normalized is null || IsJournalPath(normalized)) return;
            lock (gate)
            {
                if (journalClosed || failureCode is not null) return;
                if (!AuthorizeJobMemberLocked(pid))
                {
                    PoisonLocked("ETW_PID_NOT_JOB_MEMBER");
                    return;
                }
                if (activePhase is null)
                {
                    PoisonLocked("ETW_EVENT_OUTSIDE_PHASE");
                    return;
                }
                var prior = filesByObject.GetValueOrDefault(fileObject);
                FileSnapshot? current = null;
                if (eventName != "delete")
                    current = TryInspect(normalized);
                if (eventName == "rename" && prior is not null && current is not null &&
                    prior.Identity != current.Identity)
                {
                    PoisonLocked("ETW_RENAME_IDENTITY_MISMATCH");
                    return;
                }
                var effective = current ?? prior;
                if (effective is null)
                {
                    PoisonLocked("ETW_FILE_IDENTITY_MISSING");
                    return;
                }
                if (current is not null) filesByObject[fileObject] = current;
                if (eventName == "delete") filesByObject.Remove(fileObject);

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
                var from = eventName == "rename" ? prior?.RelativePath : null;
                var to = eventName == "rename" ? normalized : null;
                var path = eventName == "rename" ? null : normalized;
                var observation = new ObservationRecord(
                    eventName,
                    path,
                    from,
                    to,
                    activePhase.Phase,
                    activePhase.WorkId,
                    activePhase.PhaseInstanceId,
                    sequence,
                    new DateTimeOffset(timestamp.ToUniversalTime()).ToString("O"),
                    pid,
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
                    item.PhaseInstanceId == activePhase.PhaseInstanceId &&
                    item.Matches(observation));
                if (pending is not null)
                {
                    pending.Match(sequence);
                    observation.NoticeSequence = pending.NoticeSequence;
                    Monitor.PulseAll(gate);
                }
                observations.Add(observation);
                PersistJournal(closed: false);
            }
        }
        catch (Exception error)
        {
            Poison(error is GuardException guard ? guard.Code : $"ETW_OBSERVATION_FAILED_{error.HResult:x8}");
        }
    }

    private FileSnapshot? TryInspect(string relativePath)
    {
        var absolute = Path.GetFullPath(Path.Combine(root,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        EnsureWithinRoot(root, absolute);
        using var handle = CreateFileW(
            absolute,
            0x80000000,
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

    private bool AuthorizeJobMemberLocked(int pid)
    {
        if (!job.Contains(pid)) return false;
        // Job handleはguardだけが保持し、breakawayを許可しない。root workerの子孫は
        // CreateProcess時点から同じJobへ自動加入するため、最初のETW eventで認可する。
        registeredPids.Add(pid);
        return true;
    }

    private void AssertRegisteredProcessesContained()
    {
        foreach (var pid in job.MemberPids()) registeredPids.Add(pid);
        foreach (var pid in registeredPids)
        {
            if (ProcessExists(pid) && !job.Contains(pid))
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
        cancellation.Cancel();
        try { StopEtw(); } catch { }
        try { pipeTask.Wait(TimeSpan.FromSeconds(5)); } catch { }
        etwSource.Dispose();
        etwSession.Dispose();
        job.Dispose();
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

    private static bool ProcessExists(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

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

    private sealed record ActivePhase(string Phase, string? WorkId, string PhaseInstanceId);

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
/// breakawayを許可せず、最後のhandle closeで全workerを停止するJob Object。
/// @des DES-F005-006 DES-F005-012 @fun FUN-F005-036 FUN-F005-047
/// </summary>
sealed class JobObject : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectBasicProcessIdListClass = 3;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int ErrorMoreData = 234;
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

    public void Assign(int pid)
    {
        using var process = Process.GetProcessById(pid);
        if (process.HasExited) throw new GuardException("PID_NOT_RUNNING");
        if (!AssignProcessToJobObject(handle, process.Handle))
            throw new GuardException($"JOB_ASSIGNMENT_FAILED_{Marshal.GetLastWin32Error()}");
    }

    public bool Contains(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited &&
                IsProcessInJob(process.Handle, handle, out var result) &&
                result;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

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
