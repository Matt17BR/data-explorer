#requires -Version 5.1

<#
.SYNOPSIS
  Runs one editor acceptance process tree inside a private Windows Job Object.

.DESCRIPTION
  This helper is intentionally a small, Windows-only process supervisor. Its
  standard input is a parent lease and a bounded UTF-8 NDJSON control channel.
  The first frame launches the target; keeping stdin open keeps the lease alive.
  An exact EOF or an explicit terminate frame kills the complete job tree.

  The target is created suspended, assigned to a JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  job, and only then resumed. STARTUPINFOEX restricts inherited handles to NUL
  stdin and duplicates of the supervisor's stdout/stderr. In particular, the
  control pipe is never inherited by the target or its descendants.

  Protocol v1 (each object is one UTF-8 line terminated by LF):

    {"protocol":1,"command":"launch","executable":"C:\\...\\Code.exe",
     "args":["--arg"],"cwd":"C:\\...","environment":{"SYSTEMROOT":"C:\\Windows"},
     "attestationToken":"00000000-0000-4000-8000-000000000000"}

    {"protocol":1,"command":"terminate"}

  The supervisor emits no frame contents, paths, arguments, environment values,
  or exception text. The target owns stdout/stderr. After the Job Object is empty,
  the supervisor emits the caller's unforgeable attestation token on stderr and
  returns the target's Win32 exit-code bit pattern; supervisor failures use 125.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$nativeSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace OpenWrangler.Acceptance
{
    internal sealed class ProtocolFailure : Exception
    {
        internal ProtocolFailure() : base("Invalid supervisor protocol.") { }
    }

    internal sealed class NativeFailure : Exception
    {
        internal readonly string Stage;

        internal NativeFailure(string stage) : base("Windows supervisor native operation failed.")
        {
            Stage = stage;
        }
    }

    internal sealed class JsonNumber
    {
        internal readonly string Text;
        internal JsonNumber(string text) { Text = text; }
    }

    internal sealed class StrictJsonParser
    {
        private const int MaximumDepth = 16;
        private const int MaximumNodes = 8192;

        private readonly string text;
        private int offset;
        private int nodes;

        private StrictJsonParser(string textValue)
        {
            text = textValue;
        }

        internal static object Parse(string text)
        {
            if (text == null || text.Length == 0) throw new ProtocolFailure();
            StrictJsonParser parser = new StrictJsonParser(text);
            object value = parser.ParseValue(0);
            parser.SkipWhitespace();
            if (parser.offset != text.Length) throw new ProtocolFailure();
            return value;
        }

        private object ParseValue(int depth)
        {
            if (depth > MaximumDepth || ++nodes > MaximumNodes || offset >= text.Length)
                throw new ProtocolFailure();

            char current = text[offset];
            if (current == '{') return ParseObject(depth + 1);
            if (current == '[') return ParseArray(depth + 1);
            if (current == '"') return ParseString();
            if (current == 't') { ReadKeyword("true"); return true; }
            if (current == 'f') { ReadKeyword("false"); return false; }
            if (current == 'n') { ReadKeyword("null"); return null; }
            if (current == '-' || (current >= '0' && current <= '9')) return ParseNumber();
            throw new ProtocolFailure();
        }

        private Dictionary<string, object> ParseObject(int depth)
        {
            Dictionary<string, object> value = new Dictionary<string, object>(StringComparer.Ordinal);
            offset++;
            SkipWhitespace();
            if (Take('}')) return value;
            while (true)
            {
                if (offset >= text.Length || text[offset] != '"') throw new ProtocolFailure();
                string key = ParseString();
                if (value.ContainsKey(key)) throw new ProtocolFailure();
                SkipWhitespace();
                Require(':');
                SkipWhitespace();
                value.Add(key, ParseValue(depth));
                SkipWhitespace();
                if (Take('}')) return value;
                Require(',');
                SkipWhitespace();
            }
        }

        private List<object> ParseArray(int depth)
        {
            List<object> value = new List<object>();
            offset++;
            SkipWhitespace();
            if (Take(']')) return value;
            while (true)
            {
                value.Add(ParseValue(depth));
                SkipWhitespace();
                if (Take(']')) return value;
                Require(',');
                SkipWhitespace();
            }
        }

        private string ParseString()
        {
            Require('"');
            StringBuilder value = new StringBuilder();
            while (offset < text.Length)
            {
                char current = text[offset++];
                if (current == '"') return value.ToString();
                if (current < 0x20) throw new ProtocolFailure();
                if (current == '\\')
                {
                    if (offset >= text.Length) throw new ProtocolFailure();
                    char escape = text[offset++];
                    switch (escape)
                    {
                        case '"': value.Append('"'); break;
                        case '\\': value.Append('\\'); break;
                        case '/': value.Append('/'); break;
                        case 'b': value.Append('\b'); break;
                        case 'f': value.Append('\f'); break;
                        case 'n': value.Append('\n'); break;
                        case 'r': value.Append('\r'); break;
                        case 't': value.Append('\t'); break;
                        case 'u': AppendEscapedCodePoint(value); break;
                        default: throw new ProtocolFailure();
                    }
                    continue;
                }

                if (char.IsHighSurrogate(current))
                {
                    if (offset >= text.Length || !char.IsLowSurrogate(text[offset]))
                        throw new ProtocolFailure();
                    value.Append(current);
                    value.Append(text[offset++]);
                }
                else
                {
                    if (char.IsLowSurrogate(current)) throw new ProtocolFailure();
                    value.Append(current);
                }
            }
            throw new ProtocolFailure();
        }

        private void AppendEscapedCodePoint(StringBuilder value)
        {
            char first = (char)ReadHexQuad();
            if (char.IsHighSurrogate(first))
            {
                if (offset + 6 > text.Length || text[offset] != '\\' || text[offset + 1] != 'u')
                    throw new ProtocolFailure();
                offset += 2;
                char second = (char)ReadHexQuad();
                if (!char.IsLowSurrogate(second)) throw new ProtocolFailure();
                value.Append(first);
                value.Append(second);
                return;
            }
            if (char.IsLowSurrogate(first)) throw new ProtocolFailure();
            value.Append(first);
        }

        private int ReadHexQuad()
        {
            if (offset + 4 > text.Length) throw new ProtocolFailure();
            int result = 0;
            for (int index = 0; index < 4; index++)
            {
                char current = text[offset++];
                int digit;
                if (current >= '0' && current <= '9') digit = current - '0';
                else if (current >= 'a' && current <= 'f') digit = current - 'a' + 10;
                else if (current >= 'A' && current <= 'F') digit = current - 'A' + 10;
                else throw new ProtocolFailure();
                result = (result << 4) | digit;
            }
            return result;
        }

        private JsonNumber ParseNumber()
        {
            int start = offset;
            if (Take('-') && offset >= text.Length) throw new ProtocolFailure();
            if (Take('0'))
            {
                if (offset < text.Length && text[offset] >= '0' && text[offset] <= '9')
                    throw new ProtocolFailure();
            }
            else
            {
                RequireDigit('1', '9');
                while (TakeDigit()) { }
            }
            if (Take('.'))
            {
                if (!TakeDigit()) throw new ProtocolFailure();
                while (TakeDigit()) { }
            }
            if (offset < text.Length && (text[offset] == 'e' || text[offset] == 'E'))
            {
                offset++;
                if (offset < text.Length && (text[offset] == '+' || text[offset] == '-')) offset++;
                if (!TakeDigit()) throw new ProtocolFailure();
                while (TakeDigit()) { }
            }
            return new JsonNumber(text.Substring(start, offset - start));
        }

        private void ReadKeyword(string keyword)
        {
            if (offset + keyword.Length > text.Length ||
                !string.Equals(text.Substring(offset, keyword.Length), keyword, StringComparison.Ordinal))
                throw new ProtocolFailure();
            offset += keyword.Length;
        }

        private void SkipWhitespace()
        {
            while (offset < text.Length && (text[offset] == ' ' || text[offset] == '\t')) offset++;
        }

        private bool Take(char expected)
        {
            if (offset >= text.Length || text[offset] != expected) return false;
            offset++;
            return true;
        }

        private bool TakeDigit()
        {
            if (offset >= text.Length || text[offset] < '0' || text[offset] > '9') return false;
            offset++;
            return true;
        }

        private void RequireDigit(char minimum, char maximum)
        {
            if (offset >= text.Length || text[offset] < minimum || text[offset] > maximum)
                throw new ProtocolFailure();
            offset++;
        }

        private void Require(char expected)
        {
            if (!Take(expected)) throw new ProtocolFailure();
        }
    }

    internal sealed class LaunchRequest
    {
        internal string Executable;
        internal string WorkingDirectory;
        internal List<string> Arguments;
        internal Dictionary<string, string> Environment;
        internal string AttestationToken;
    }

    internal static class Protocol
    {
        private const int MaximumArguments = 1024;
        private const int MaximumEnvironmentVariables = 512;
        private const int MaximumStringCharacters = 32766;
        private const int MaximumCommandLineCharacters = 32766;
        private const int MaximumEnvironmentBlockCharacters = 32766;

        internal static LaunchRequest ParseLaunch(string frame)
        {
            Dictionary<string, object> root = RequireObject(StrictJsonParser.Parse(frame));
            RequireExactKeys(root, new string[] {
                "protocol", "command", "executable", "args", "cwd", "environment", "attestationToken"
            });
            RequireProtocol(root["protocol"]);
            if (!string.Equals(RequireString(root["command"]), "launch", StringComparison.Ordinal))
                throw new ProtocolFailure();

            string executable = RequireBoundedString(root["executable"]);
            string workingDirectory = RequireBoundedString(root["cwd"]);
            string attestationToken = RequireString(root["attestationToken"]);
            if (!IsSafeAbsolutePath(executable) || !IsSafeAbsolutePath(workingDirectory))
                throw new ProtocolFailure();
            if (!IsAttestationToken(attestationToken)) throw new ProtocolFailure();
            if (!File.Exists(executable) || !Directory.Exists(workingDirectory))
                throw new ProtocolFailure();

            List<object> rawArguments = RequireArray(root["args"]);
            if (rawArguments.Count > MaximumArguments) throw new ProtocolFailure();
            List<string> arguments = new List<string>(rawArguments.Count);
            foreach (object rawArgument in rawArguments)
                arguments.Add(RequireBoundedString(rawArgument));

            Dictionary<string, object> rawEnvironment = RequireObject(root["environment"]);
            if (rawEnvironment.Count > MaximumEnvironmentVariables) throw new ProtocolFailure();
            Dictionary<string, string> environment =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, object> entry in rawEnvironment)
            {
                if (!IsEnvironmentName(entry.Key) || environment.ContainsKey(entry.Key))
                    throw new ProtocolFailure();
                environment.Add(entry.Key, RequireBoundedString(entry.Value));
            }
            int environmentCharacters = 1;
            foreach (KeyValuePair<string, string> entry in environment)
            {
                environmentCharacters += entry.Key.Length + entry.Value.Length + 2;
                if (environmentCharacters > MaximumEnvironmentBlockCharacters)
                    throw new ProtocolFailure();
            }

            LaunchRequest request = new LaunchRequest();
            request.Executable = executable;
            request.WorkingDirectory = workingDirectory;
            request.Arguments = arguments;
            request.Environment = environment;
            request.AttestationToken = attestationToken;
            if (WindowsCommandLine.Build(request).Length > MaximumCommandLineCharacters)
                throw new ProtocolFailure();
            return request;
        }

        internal static void ParseTerminate(string frame)
        {
            Dictionary<string, object> root = RequireObject(StrictJsonParser.Parse(frame));
            RequireExactKeys(root, new string[] { "protocol", "command" });
            RequireProtocol(root["protocol"]);
            if (!string.Equals(RequireString(root["command"]), "terminate", StringComparison.Ordinal))
                throw new ProtocolFailure();
        }

        private static bool IsSafeAbsolutePath(string value)
        {
            if (value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
                return false;
            try
            {
                if (!Path.IsPathRooted(value)) return false;
                string root = Path.GetPathRoot(value);
                return !string.IsNullOrEmpty(root) && root.Length > 2;
            }
            catch { return false; }
        }

        private static bool IsAttestationToken(string value)
        {
            if (value == null || value.Length != 36) return false;
            for (int index = 0; index < value.Length; index++)
            {
                if (index == 8 || index == 13 || index == 18 || index == 23)
                {
                    if (value[index] != '-') return false;
                    continue;
                }
                char current = value[index];
                if (!((current >= '0' && current <= '9') || (current >= 'a' && current <= 'f')))
                    return false;
            }
            return true;
        }

        private static bool IsEnvironmentName(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 255 ||
                value.IndexOf('=') >= 0 || value.IndexOf('\0') >= 0)
                return false;
            char first = value[0];
            if (!(first == '_' || (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z')))
                return false;
            for (int index = 1; index < value.Length; index++)
            {
                char current = value[index];
                if (!(current == '_' || current == '(' || current == ')' ||
                      (current >= 'A' && current <= 'Z') ||
                      (current >= 'a' && current <= 'z') ||
                      (current >= '0' && current <= '9')))
                    return false;
            }
            return true;
        }

        private static string RequireBoundedString(object value)
        {
            string text = RequireString(value);
            if (text.Length > MaximumStringCharacters || text.IndexOf('\0') >= 0)
                throw new ProtocolFailure();
            return text;
        }

        private static void RequireProtocol(object value)
        {
            JsonNumber number = value as JsonNumber;
            if (number == null || !string.Equals(number.Text, "1", StringComparison.Ordinal))
                throw new ProtocolFailure();
        }

        private static void RequireExactKeys(Dictionary<string, object> value, string[] expected)
        {
            if (value.Count != expected.Length) throw new ProtocolFailure();
            foreach (string key in expected)
                if (!value.ContainsKey(key)) throw new ProtocolFailure();
        }

        private static Dictionary<string, object> RequireObject(object value)
        {
            Dictionary<string, object> result = value as Dictionary<string, object>;
            if (result == null) throw new ProtocolFailure();
            return result;
        }

        private static List<object> RequireArray(object value)
        {
            List<object> result = value as List<object>;
            if (result == null) throw new ProtocolFailure();
            return result;
        }

        private static string RequireString(object value)
        {
            string result = value as string;
            if (result == null) throw new ProtocolFailure();
            return result;
        }
    }

    internal static class WindowsCommandLine
    {
        internal static string Build(LaunchRequest request)
        {
            StringBuilder commandLine = new StringBuilder();
            AppendArgument(commandLine, request.Executable);
            foreach (string argument in request.Arguments)
            {
                commandLine.Append(' ');
                AppendArgument(commandLine, argument);
            }
            return commandLine.ToString();
        }

        // Implements the CommandLineToArgvW/MS C runtime backslash-and-quote rules.
        private static void AppendArgument(StringBuilder target, string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                target.Append(argument);
                return;
            }

            target.Append('"');
            int backslashes = 0;
            foreach (char current in argument)
            {
                if (current == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (current == '"')
                {
                    target.Append('\\', backslashes * 2 + 1);
                    target.Append('"');
                    backslashes = 0;
                    continue;
                }
                target.Append('\\', backslashes);
                backslashes = 0;
                target.Append(current);
            }
            target.Append('\\', backslashes * 2);
            target.Append('"');
        }
    }

    internal sealed class BoundedFrameReader : IDisposable
    {
        private readonly Stream stream;
        private readonly byte[] readBuffer = new byte[4096];
        private readonly UTF8Encoding decoder = new UTF8Encoding(false, true);
        private int readOffset;
        private int readLength;

        internal BoundedFrameReader(Stream input)
        {
            stream = input;
        }

        // Null means an exact EOF before any byte of the next frame. A partial
        // frame at EOF is invalid so a parent cannot accidentally surrender its
        // lease while leaving an ambiguous command buffered.
        internal string ReadFrame(int maximumBytes)
        {
            using (MemoryStream frame = new MemoryStream(Math.Min(maximumBytes, 4096)))
            {
                while (true)
                {
                    int next = ReadByte();
                    if (next < 0)
                    {
                        if (frame.Length == 0) return null;
                        throw new ProtocolFailure();
                    }
                    if (next == 0) throw new ProtocolFailure();
                    if (next == '\n')
                    {
                        byte[] bytes = frame.ToArray();
                        int length = bytes.Length;
                        if (length > 0 && bytes[length - 1] == '\r') length--;
                        for (int index = 0; index < length; index++)
                            if (bytes[index] == '\r') throw new ProtocolFailure();
                        try { return decoder.GetString(bytes, 0, length); }
                        catch (DecoderFallbackException) { throw new ProtocolFailure(); }
                    }
                    if (frame.Length >= maximumBytes) throw new ProtocolFailure();
                    frame.WriteByte((byte)next);
                }
            }
        }

        private int ReadByte()
        {
            if (readOffset >= readLength)
            {
                readLength = stream.Read(readBuffer, 0, readBuffer.Length);
                readOffset = 0;
                if (readLength == 0) return -1;
            }
            return readBuffer[readOffset++];
        }

        public void Dispose()
        {
            stream.Dispose();
        }
    }

    internal sealed class ControlEvent
    {
        internal readonly string Frame;
        internal readonly bool EndOfFile;
        internal readonly bool Failed;

        private ControlEvent(string frame, bool endOfFile, bool failed)
        {
            Frame = frame;
            EndOfFile = endOfFile;
            Failed = failed;
        }

        internal static ControlEvent FromFrame(string frame) { return new ControlEvent(frame, false, false); }
        internal static ControlEvent Eof() { return new ControlEvent(null, true, false); }
        internal static ControlEvent Failure() { return new ControlEvent(null, false, true); }
    }

    internal sealed class NativeJob : IDisposable
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 258;

        private IntPtr jobHandle;
        private IntPtr processHandle;
        private bool disposed;
        private bool targetExitCaptured;
        private uint targetExitCode;

        private NativeJob(IntPtr job, IntPtr process)
        {
            jobHandle = job;
            processHandle = process;
        }

        internal static NativeJob Launch(LaunchRequest request)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr process = IntPtr.Zero;
            IntPtr thread = IntPtr.Zero;
            IntPtr nullInput = IntPtr.Zero;
            IntPtr childOutput = IntPtr.Zero;
            IntPtr childError = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            bool processCreated = false;
            bool assigned = false;
            bool attributesInitialized = false;

            try
            {
                IntPtr controlInput = GetStdHandle(STD_INPUT_HANDLE);
                RequireHandle(controlInput, "control-handle");
                if (!SetHandleInformation(controlInput, HANDLE_FLAG_INHERIT, 0))
                    throw new NativeFailure("control-inheritance");

                job = CreateJobObjectW(IntPtr.Zero, null);
                RequireHandle(job, "create-job");
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                if (!SetInformationJobObject(job, 9, ref limits, (uint)limitsSize))
                    throw new NativeFailure("configure-job");

                SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
                inheritable.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                inheritable.bInheritHandle = 1;
                nullInput = CreateFileW(
                    "NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inheritable,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                RequireHandle(nullInput, "open-null");

                IntPtr currentProcess = GetCurrentProcess();
                IntPtr supervisorOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                IntPtr supervisorError = GetStdHandle(STD_ERROR_HANDLE);
                RequireHandle(supervisorOutput, "output-handle");
                RequireHandle(supervisorError, "error-handle");
                if (!DuplicateHandle(currentProcess, supervisorOutput, currentProcess,
                                     out childOutput, 0, true, DUPLICATE_SAME_ACCESS))
                    throw new NativeFailure("duplicate-output");
                if (!DuplicateHandle(currentProcess, supervisorError, currentProcess,
                                     out childError, 0, true, DUPLICATE_SAME_ACCESS))
                    throw new NativeFailure("duplicate-error");

                IntPtr attributeBytes = IntPtr.Zero;
                if (InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes) ||
                    Marshal.GetLastWin32Error() != 122 || attributeBytes == IntPtr.Zero)
                    throw new NativeFailure("attribute-size");
                attributeList = Marshal.AllocHGlobal(attributeBytes);
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes))
                    throw new NativeFailure("attribute-init");
                attributesInitialized = true;

                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, nullInput);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, childOutput);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, childError);
                if (!UpdateProcThreadAttribute(
                        attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                        handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw new NativeFailure("attribute-handles");

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = nullInput;
                startup.StartupInfo.hStdOutput = childOutput;
                startup.StartupInfo.hStdError = childError;
                startup.lpAttributeList = attributeList;

                string environmentBlock = BuildEnvironmentBlock(request.Environment);
                environment = Marshal.StringToHGlobalUni(environmentBlock);
                StringBuilder commandLine = new StringBuilder(WindowsCommandLine.Build(request));
                PROCESS_INFORMATION processInformation;
                if (!CreateProcessW(
                        request.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                        environment, request.WorkingDirectory, ref startup, out processInformation))
                    throw new NativeFailure("create-process");
                processCreated = true;
                process = processInformation.hProcess;
                thread = processInformation.hThread;

                // The suspended target has executed no user code at this point.
                if (!AssignProcessToJobObject(job, process))
                    throw new NativeFailure("assign-job");
                assigned = true;
                if (ResumeThread(thread) == UInt32.MaxValue)
                    throw new NativeFailure("resume-process");

                CloseHandle(thread);
                thread = IntPtr.Zero;
                NativeJob result = new NativeJob(job, process);
                job = IntPtr.Zero;
                process = IntPtr.Zero;
                return result;
            }
            finally
            {
                if (thread != IntPtr.Zero) CloseHandle(thread);
                if (processCreated && process != IntPtr.Zero)
                {
                    // If assignment succeeded, closing the job is authoritative;
                    // otherwise terminate the still-suspended process directly.
                    if (!assigned) TerminateProcess(process, 125);
                    else if (job != IntPtr.Zero) TerminateJobObject(job, 125);
                    WaitForSingleObject(process, 5000);
                    CloseHandle(process);
                }
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                CloseIfValid(childError);
                CloseIfValid(childOutput);
                CloseIfValid(nullInput);
                CloseIfValid(job);
            }
        }

        internal uint ActiveProcessCount()
        {
            EnsureOpen();
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
                new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            if (!QueryInformationJobObject(jobHandle, 1, ref accounting, (uint)size, IntPtr.Zero))
                throw new NativeFailure("query-job");
            CaptureTargetExit(false);
            return accounting.ActiveProcesses;
        }

        internal void Terminate(uint exitCode)
        {
            EnsureOpen();
            CaptureTargetExit(false);
            if (!TerminateJobObject(jobHandle, exitCode))
                throw new NativeFailure("terminate-job");
        }

        internal int TargetExitCode()
        {
            EnsureOpen();
            CaptureTargetExit(true);
            if (!targetExitCaptured) throw new NativeFailure("target-exit");
            return unchecked((int)targetExitCode);
        }

        private void CaptureTargetExit(bool wait)
        {
            if (targetExitCaptured) return;
            uint waitResult = WaitForSingleObject(processHandle, wait ? 5000u : 0u);
            if (waitResult == WAIT_TIMEOUT) return;
            if (waitResult != WAIT_OBJECT_0) throw new NativeFailure("wait-target");
            uint exitCode;
            if (!GetExitCodeProcess(processHandle, out exitCode))
                throw new NativeFailure("target-exit");
            targetExitCode = exitCode;
            targetExitCaptured = true;
        }

        private static string BuildEnvironmentBlock(Dictionary<string, string> environment)
        {
            List<string> names = new List<string>(environment.Keys);
            names.Sort(StringComparer.OrdinalIgnoreCase);
            StringBuilder block = new StringBuilder();
            foreach (string name in names)
            {
                block.Append(name);
                block.Append('=');
                block.Append(environment[name]);
                block.Append('\0');
            }
            block.Append('\0');
            return block.ToString();
        }

        private void EnsureOpen()
        {
            if (disposed || jobHandle == IntPtr.Zero || processHandle == IntPtr.Zero)
                throw new NativeFailure("closed-job");
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            // KILL_ON_JOB_CLOSE makes this fail-closed even during stack unwinding.
            CloseIfValid(jobHandle);
            jobHandle = IntPtr.Zero;
            CloseIfValid(processHandle);
            processHandle = IntPtr.Zero;
        }

        private static void RequireHandle(IntPtr handle, string stage)
        {
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new NativeFailure(stage);
        }

        private static void CloseIfValid(IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            internal int nLength;
            internal IntPtr lpSecurityDescriptor;
            internal int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal int dwX;
            internal int dwY;
            internal int dwXSize;
            internal int dwYSize;
            internal int dwXCountChars;
            internal int dwYCountChars;
            internal int dwFillAttribute;
            internal uint dwFlags;
            internal short wShowWindow;
            internal short cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            internal STARTUPINFO StartupInfo;
            internal IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            internal IntPtr hProcess;
            internal IntPtr hThread;
            internal uint dwProcessId;
            internal uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            internal long TotalUserTime;
            internal long TotalKernelTime;
            internal long ThisPeriodTotalUserTime;
            internal long ThisPeriodTotalKernelTime;
            internal uint TotalPageFaultCount;
            internal uint TotalProcesses;
            internal uint ActiveProcesses;
            internal uint TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job, int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr job, int informationClass,
            ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength, IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(
            string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
            uint creationFlags, IntPtr environment, string currentDirectory,
            ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value,
            IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName, uint desiredAccess, uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes, uint creationDisposition,
            uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
            out IntPtr targetHandle, uint desiredAccess, bool inheritHandle, uint options);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }

    public static class WindowsJobSupervisor
    {
        private const int SupervisorFailureExitCode = 125;
        private const uint LeaseLostExitCode = 125;
        private const uint ExplicitTerminationExitCode = 143;
        private const int MaximumLaunchFrameBytes = 256 * 1024;
        private const int MaximumControlFrameBytes = 1024;
        private const int ControlQueueCapacity = 4;
        private const int PollMilliseconds = 25;
        private const int TerminationDeadlineMilliseconds = 10000;

        public static int Run(Stream standardInput)
        {
            try
            {
                return RunCore(standardInput);
            }
            catch (ProtocolFailure)
            {
                WriteFixedFailure("protocol");
                return SupervisorFailureExitCode;
            }
            catch (NativeFailure failure)
            {
                WriteFixedFailure(IsKnownNativeStage(failure.Stage) ? failure.Stage : "native");
                return SupervisorFailureExitCode;
            }
            catch
            {
                WriteFixedFailure("internal");
                return SupervisorFailureExitCode;
            }
        }

        private static int RunCore(Stream standardInput)
        {
            using (BoundedFrameReader reader = new BoundedFrameReader(standardInput))
            {
                string launchFrame = reader.ReadFrame(MaximumLaunchFrameBytes);
                if (launchFrame == null) throw new ProtocolFailure();
                LaunchRequest request = Protocol.ParseLaunch(launchFrame);

                using (NativeJob job = NativeJob.Launch(request))
                using (BlockingCollection<ControlEvent> controls =
                       new BlockingCollection<ControlEvent>(ControlQueueCapacity))
                {
                    Thread controlThread = new Thread(delegate()
                    {
                        try
                        {
                            while (true)
                            {
                                string frame = reader.ReadFrame(MaximumControlFrameBytes);
                                if (frame == null)
                                {
                                    controls.Add(ControlEvent.Eof());
                                    return;
                                }
                                controls.Add(ControlEvent.FromFrame(frame));
                            }
                        }
                        catch
                        {
                            try { controls.Add(ControlEvent.Failure()); }
                            catch { }
                        }
                    });
                    controlThread.IsBackground = true;
                    controlThread.Name = "OpenWranglerWindowsJobControl";
                    controlThread.Start();

                    bool terminating = false;
                    long terminationStarted = 0;
                    while (true)
                    {
                        ControlEvent control;
                        if (controls.TryTake(out control, PollMilliseconds))
                        {
                            // The protocol permits at most one post-launch frame.
                            // EOF, a malformed frame, or a second command after a
                            // termination request invalidates attestation.
                            if (terminating) throw new ProtocolFailure();
                            if (control.Failed)
                            {
                                job.Terminate(LeaseLostExitCode);
                                throw new ProtocolFailure();
                            }
                            if (control.EndOfFile)
                            {
                                job.Terminate(LeaseLostExitCode);
                            }
                            else
                            {
                                Protocol.ParseTerminate(control.Frame);
                                job.Terminate(ExplicitTerminationExitCode);
                            }
                            terminating = true;
                            terminationStarted = Environment.TickCount64;
                        }

                        uint active = job.ActiveProcessCount();
                        if (active == 0)
                        {
                            // A frame already accepted by the reader invalidates
                            // an otherwise empty Job. The trusted parent sends at
                            // most one post-launch frame, so anything queued here
                            // is either lease loss, termination, or malformed input.
                            ControlEvent trailing;
                            if (controls.TryTake(out trailing, 0))
                                throw new ProtocolFailure();
                            WriteJobEmptyAttestation(request.AttestationToken);
                            return job.TargetExitCode();
                        }

                        if (terminating &&
                            Environment.TickCount64 - terminationStarted > TerminationDeadlineMilliseconds)
                            throw new NativeFailure("termination-timeout");
                    }
                }
            }
        }

        private static bool IsKnownNativeStage(string stage)
        {
            switch (stage)
            {
                case "control-handle":
                case "control-inheritance":
                case "create-job":
                case "configure-job":
                case "open-null":
                case "output-handle":
                case "error-handle":
                case "duplicate-output":
                case "duplicate-error":
                case "attribute-size":
                case "attribute-init":
                case "attribute-handles":
                case "create-process":
                case "assign-job":
                case "resume-process":
                case "query-job":
                case "terminate-job":
                case "target-exit":
                case "wait-target":
                case "closed-job":
                case "termination-timeout":
                case "attestation":
                    return true;
                default:
                    return false;
            }
        }

        private static void WriteJobEmptyAttestation(string token)
        {
            try
            {
                byte[] payload = Encoding.ASCII.GetBytes(
                    "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:" + token + "\n");
                Stream error = Console.OpenStandardError();
                error.Write(payload, 0, payload.Length);
                error.Flush();
            }
            catch
            {
                throw new NativeFailure("attestation");
            }
        }

        private static void WriteFixedFailure(string code)
        {
            // Codes are selected only from literals above; never print exception
            // messages because native errors can contain user-controlled paths.
            Console.Error.WriteLine("OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:" + code);
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
}
catch {
    [Console]::Error.WriteLine("OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:bootstrap")
    [Environment]::Exit(125)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    [Console]::Error.WriteLine("OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:platform")
    [Environment]::Exit(125)
}

try {
    $exitCode = [OpenWrangler.Acceptance.WindowsJobSupervisor]::Run([Console]::OpenStandardInput())
    [Environment]::Exit([int]$exitCode)
}
catch {
    [Console]::Error.WriteLine("OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:wrapper")
    [Environment]::Exit(125)
}
