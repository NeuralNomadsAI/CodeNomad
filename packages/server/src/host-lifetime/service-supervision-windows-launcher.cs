using System;
using System.Diagnostics;
using System.Text.RegularExpressions;

// GUI subsystem entry point: Task Scheduler must never create a console for
// this process. CreateNoWindow prevents Terminal delegation for PowerShell too.
internal static class ServiceSupervisionLauncher {
    private static string Quote(string value) {
        return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
    }

    private static int Main(string[] args) {
        if (args.Length < 2) return 1;
        try {
            var arguments = new string[args.Length - 1];
            for (int i = 1; i < args.Length; i++) arguments[i - 1] = Quote(args[i]);
            var info = new ProcessStartInfo(args[0], string.Join(" ", arguments));
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            using (var process = Process.Start(info)) {
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch { return 1; }
    }
}
