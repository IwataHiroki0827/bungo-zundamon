using System.Buffers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

const string Abi = "f005-guard-jsonl-v1";
const int MaxRequestChars = 65_536;
var capabilities = new Dictionary<string, HeldCapability>(StringComparer.Ordinal);

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
                    rid = RuntimeInformation.RuntimeIdentifier,
                    runtimeVersion = Environment.Version.ToString(),
                    processId = Environment.ProcessId,
                });
                break;
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
                ShareRead | ShareWrite,
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
            return new HeldCapability(root, relativePath, rootHandle, directoryHandles, fileHandle, identity);
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
        if (length < 0 || length > 8_388_608) throw new GuardException("FILE_TOO_LARGE");
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
