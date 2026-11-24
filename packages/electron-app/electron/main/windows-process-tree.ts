// One native snapshot, and one handle-bound termination/confirmation batch, keep
// shutdown independent of WMI inventory cost and per-descendant shell startups.
export const windowsNativeProcesses = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class CodeNomadProcessHandle {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry {
    public uint Size, Usage, Pid; public UIntPtr Heap;
    public uint Module, Threads, ParentPid; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static long StartTicks(IntPtr handle) {
    FileTime creation, exit, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception();
    return DateTime.FromFileTimeUtc(((long)creation.High << 32) | creation.Low).Ticks;
  }
  public static string[] Capture(uint root) {
    var parents = new Dictionary<uint, uint>();
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception();
    try {
      var entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(entry);
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
      do { parents[entry.Pid] = entry.ParentPid; } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
    } finally { CloseHandle(snapshot); }
    var ticks = new Dictionary<uint, long>();
    var queue = new Queue<uint>(); queue.Enqueue(root);
    var rows = new List<string>();
    while (queue.Count > 0) {
      var pid = queue.Dequeue();
      if (ticks.ContainsKey(pid) || !parents.ContainsKey(pid)) continue;
      var handle = OpenProcess(0x1000, false, pid);
      if (handle == IntPtr.Zero) {
        if (Marshal.GetLastWin32Error() == 87) continue;
        throw new Win32Exception();
      }
      long start;
      try { start = StartTicks(handle); } finally { CloseHandle(handle); }
      var parent = parents[pid];
      // A child older than its current parent belongs to a previous PID owner.
      if (pid != root && (!ticks.ContainsKey(parent) || ticks[parent] > start)) continue;
      ticks[pid] = start;
      rows.Add(pid + "|" + parent + "|win32:" + start);
      foreach (var row in parents) if (row.Value == pid && row.Key != pid) queue.Enqueue(row.Key);
    }
    return rows.ToArray();
  }
  public static bool Force(uint[] pids, long[] expected, int waitMs) {
    var handles = new List<IntPtr>();
    var confirmed = true;
    try {
      // Retain every handle until confirmation, including across PID reuse.
      for (int i = pids.Length - 1; i >= 0; --i) {
        var handle = OpenProcess(0x101001, false, pids[i]);
        if (handle == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() != 87) confirmed = false;
          continue;
        }
        handles.Add(handle);
        if (StartTicks(handle) != expected[i]) { handles.Remove(handle); CloseHandle(handle); continue; }
        // A concurrently exiting process can reject TerminateProcess. Only the
        // signaled handle below decides whether its lifetime has actually ended.
        if (WaitForSingleObject(handle, 0) != 0) TerminateProcess(handle, 1);
      }
      var watch = Stopwatch.StartNew();
      foreach (var handle in handles) {
        var remaining = (uint)Math.Max(0, waitMs - watch.ElapsedMilliseconds);
        if (WaitForSingleObject(handle, remaining) != 0) confirmed = false;
      }
    } finally { foreach (var handle in handles) CloseHandle(handle); }
    return confirmed;
  }
}
'@
`

export function windowsProcessTreeScript(rootPid: number): string {
  return `${windowsNativeProcesses}[CodeNomadProcessHandle]::Capture(${rootPid})`
}

export function windowsTerminateProcessTreeScript(members: Array<{ pid: number; startIdentity: string }>): string | undefined {
  if (members.some(({ pid, startIdentity }) => !Number.isInteger(pid) || pid <= 0 || !/^win32:\d+$/.test(startIdentity))) return undefined
  const pids = members.map(({ pid }) => pid).join(",")
  const ticks = members.map(({ startIdentity }) => `'${startIdentity.slice(6)}'`).join(",")
  return `${windowsNativeProcesses}if ([CodeNomadProcessHandle]::Force([uint32[]]@(${pids}), [long[]]@(${ticks}), 1000)) { 'confirmed' } else { throw 'Process tree termination unconfirmed' }`
}
